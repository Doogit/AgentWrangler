/**
 * O-3 commit linking: fill `tool_events.commit_sha` for `git commit` calls the parser could not
 * link with a full sha. Two cases, both resolved in the session's repo with one `git log` per repo:
 *   - short sha (`[branch abc1234]`, stored by the parser) → the full sha it prefixes;
 *   - no sha (`git commit -q`) → the only commit made between the call and the session's next
 *     tool call, provided no other candidate call could have made it and no row already links it.
 * Anything ambiguous stays unlinked. A rewrite of a closed-window row bumps the enrichment epoch so
 * the history walk re-runs that window.
 */
import type { Db } from "../db/open.js";
import { awaitDbWriteGate } from "../db/write-gate.js";
import { resetGridPhaseMs } from "../detector/engine.js";
import { type GitRunner, createGitRunner } from "./churn-collector.js";
import { bumpEnrichmentEpoch, isClosedTs } from "./enrichment-epoch.js";

const GIT_COMMIT_RE =
  /\bgit(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+commit\b(?![^;&|\n]*--dry-run)/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
/** Committer dates have second precision; tool_events.ts has ms. */
const SKEW_MS = 1_000;
/** A commit call's window never runs past this, even when the session's next call is later. */
const MAX_WINDOW_MS = 10 * 60_000;
const SCAN_SLICE_ROWS = 2_000;
const WRITE_CHUNK = 200;
/** `user_config` key: the tool_events rowid through which every row is settled. */
export const WATERMARK_KEY = "commit_link_rowid";

interface Candidate {
  rid: number;
  event_id: string;
  ts: string;
  commit_sha: string | null;
  command: string;
  next_ts: string | null;
  repo_path: string;
}

export interface CommitLinkResult {
  expanded: number;
  resolved: number;
}

export async function resolveCommitLinks(
  db: Db,
  opts: { now?: Date; git?: GitRunner } = {},
): Promise<CommitLinkResult> {
  const now = opts.now ?? new Date();
  // Rows at or below the watermark are settled: their window closed before an earlier run.
  const from = Number(
    db.prepare("SELECT value FROM user_config WHERE key = ?").pluck().get(WATERMARK_KEY) ?? 0,
  );
  const maxRowid =
    (db.prepare("SELECT MAX(rowid) FROM tool_events").pluck().get() as number | null) ?? 0;
  // A row whose window may still be open (or whose result has not landed yet) is retried next run.
  const openRowid = db
    .prepare("SELECT MIN(rowid) FROM tool_events WHERE ts > ? AND rowid > ?")
    .pluck()
    .get(new Date(now.getTime() - MAX_WINDOW_MS).toISOString(), from) as number | null;
  let next = openRowid === null ? maxRowid : openRowid - 1;
  const candidates = db.prepare(
    `SELECT te.rowid AS rid, te.event_id, te.ts, te.commit_sha,
              json_extract(c.content_json, '$.command') AS command,
              (SELECT MIN(n.ts) FROM tool_events n
                WHERE n.session_id = te.session_id AND n.ts > te.ts) AS next_ts,
              w.repo_path
         FROM tool_events te -- CROSS JOIN pins te as the outer loop, walked by the rowid range
         CROSS JOIN tool_event_content c ON c.event_id = te.event_id
         CROSS JOIN sessions s ON s.session_id = te.session_id
         CROSS JOIN workspaces w ON w.workspace_id = s.workspace_id
        WHERE te.rowid > ? AND te.rowid <= ?
          AND +te.tool_name IN ('Bash', 'PowerShell')
          AND (te.commit_sha IS NULL AND te.exit_class = 'OK' OR length(te.commit_sha) < 40)
          AND c.content_json LIKE '%commit%'
          AND w.repo_path IS NOT NULL AND w.repo_path != ''`,
  );
  const byRepo = new Map<string, Candidate[]>();
  // Rowid slices with a yield between them: the first run scans the whole table.
  for (let lo = from; lo < maxRowid; lo += SCAN_SLICE_ROWS) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rows = candidates.all(lo, Math.min(lo + SCAN_SLICE_ROWS, maxRowid)) as Candidate[];
    for (const row of rows) {
      if (typeof row.command !== "string" || !GIT_COMMIT_RE.test(row.command)) continue;
      const list = byRepo.get(row.repo_path) ?? [];
      list.push(row);
      byRepo.set(row.repo_path, list);
    }
  }

  const linked = new Set(
    (
      db
        .prepare("SELECT DISTINCT commit_sha FROM tool_events WHERE commit_sha IS NOT NULL")
        .pluck()
        .all() as string[]
    )
      .filter((sha) => sha.length === 40)
      .map((sha) => sha.toLowerCase()),
  );
  const setSha = db.prepare(
    `UPDATE tool_events SET commit_sha = ?
      WHERE event_id = ? AND (commit_sha IS NULL OR length(commit_sha) < 40)`,
  );
  const result: CommitLinkResult = { expanded: 0, resolved: 0 };
  const phase = resetGridPhaseMs(db);

  for (const [repoPath, events] of byRepo) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const git = createGitRunner(repoPath, opts.git);
    const windows = events.map((e) => windowOf(e));
    const since = Math.min(...windows.map((w) => w.from));
    const until = Math.max(...windows.map((w) => w.to));
    const log = await git([
      "log",
      "--all",
      "--format=%H %cI",
      `--since=${new Date(since).toISOString()}`,
      `--until=${new Date(until).toISOString()}`,
    ]);
    if (log === null) {
      // git unavailable for this repo now: keep its rows for the next run.
      next = Math.min(next, ...events.map((e) => e.rid - 1));
      continue;
    }
    const commits: Array<{ sha: string; at: number }> = [];
    for (const line of log.stdout.split(/\r?\n/)) {
      const [sha, date] = line.trim().split(" ");
      const at = Date.parse(date ?? "");
      if (sha !== undefined && FULL_SHA_RE.test(sha) && !Number.isNaN(at))
        commits.push({ sha, at });
    }
    commits.sort((a, b) => a.at - b.at);

    const links: Array<{ event: Candidate; sha: string }> = [];
    // Short shas first: they are certain, and their commits leave the -q pool.
    for (const event of events) {
      if (event.commit_sha === null) continue;
      const prefix = event.commit_sha.toLowerCase();
      const matches = commits.filter((c) => c.sha.startsWith(prefix));
      let sha = matches.length === 1 ? (matches[0]?.sha ?? null) : null;
      if (matches.length === 0) {
        const parsed = await git(["rev-parse", "--verify", "--quiet", `${prefix}^{commit}`]);
        const out = parsed?.stdout.trim() ?? "";
        if (FULL_SHA_RE.test(out)) sha = out;
      }
      if (sha === null) continue;
      links.push({ event, sha });
      linked.add(sha);
    }

    const claims = new Map<string, number>();
    const options = events.flatMap((event, i) => {
      const w = windows[i];
      if (event.commit_sha !== null || w === undefined) return [];
      const inWindow = commits
        .slice(firstAtOrAfter(commits, w.from), firstAtOrAfter(commits, w.to + 1))
        .filter((c) => !linked.has(c.sha));
      for (const c of inWindow) claims.set(c.sha, (claims.get(c.sha) ?? 0) + 1);
      return [{ event, inWindow }];
    });
    for (const { event, inWindow } of options) {
      const only = inWindow.length === 1 ? inWindow[0] : undefined;
      if (only !== undefined && claims.get(only.sha) === 1) links.push({ event, sha: only.sha });
    }

    // Bounded transactions with a yield between them: scattered row updates make a costly commit.
    for (let i = 0; i < links.length; i += WRITE_CHUNK) {
      if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      await awaitDbWriteGate();
      db.transaction(() => {
        let closed = false;
        for (const { event, sha } of links.slice(i, i + WRITE_CHUNK)) {
          if (setSha.run(sha, event.event_id).changes === 0) continue;
          closed ||= isClosedTs(db, event.ts, now, phase);
          if (event.commit_sha === null) result.resolved += 1;
          else result.expanded += 1;
        }
        // One bump re-runs every closed window; per-row bumps would only add writes.
        if (closed) bumpEnrichmentEpoch(db);
      })();
    }
  }
  if (next > from) {
    await awaitDbWriteGate();
    db.prepare(
      `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(WATERMARK_KEY, String(next), now.toISOString());
  }
  return result;
}

/** Index of the first commit (sorted by time) at or after `at`. */
function firstAtOrAfter(commits: ReadonlyArray<{ at: number }>, at: number): number {
  let lo = 0;
  let hi = commits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((commits[mid]?.at ?? at) < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function windowOf(e: Candidate): { from: number; to: number } {
  const at = Date.parse(e.ts);
  const next = e.next_ts === null ? Number.POSITIVE_INFINITY : Date.parse(e.next_ts);
  return { from: at - SKEW_MS, to: Math.min(next, at + MAX_WINDOW_MS) };
}
