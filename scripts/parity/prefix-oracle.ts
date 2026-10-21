/** Read-only C1 prefix oracle. No transcript content or file contents are emitted. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

type Source = {
  probe_id: string;
  workspace_id: string;
  component: string;
  file_ref: string;
  file_hash: string;
  tokens: number;
  attribution_version: string;
};
type Version = Source & { observed_at: string; id: number };
type FirstTurn = { session_id: string; workspace_id: string; ts: string; prefix: number };
type DifferentialPair = { source: string; changedAt: string; before: string; after: string };
export type BaselineEvidence = { claudeVersion: string; toolConfig: string; baseline: number };
export type Finding = { check: "b" | "c" | "d"; source?: string; session?: string; detail: string };
/**
 * Independently measured Claude token counts, keyed by SHA-1 of the loaded content.
 * Produced by `source-pairs.mjs` (message-mode prefix deltas); scoped to one Claude Code
 * version and model. bytes/4 is not a token count, so without an entry C1(b) token
 * equality is UNPROVEN, never PASS.
 */
export type MeasuredCounts = { claudeVersion: string; model: string; counts: Map<string, number> };
export type OracleReport = {
  ok: boolean;
  checked: {
    disk: number;
    /** (b) sources whose loaded content had an independent measured count. */
    measured: number;
    /** (b) sources with no independent count: token equality unproven. */
    unproven: number;
    changes: number;
    differentials: number;
    sessions: number;
    dProven: number;
    dUnproven: number;
  };
  /** FAIL results; `ok` is true only when this is empty. */
  findings: Finding[];
  /** SKIP results (missing file, stale hash, too few sessions); never fail the run. */
  skips: Finding[];
};
/** Always-loaded file-backed sources whose tokens (b) and (d) check. */
const FILE_BACKED = new Set(["CLAUDE_MD", "MEMORY"]);

const DAY = 86_400_000;
const key = (row: Pick<Source, "workspace_id" | "component" | "file_ref">) =>
  JSON.stringify([row.workspace_id, row.component, row.file_ref]);
const probeId = (row: Pick<Source, "workspace_id" | "component" | "file_ref">) =>
  `probe-${createHash("sha1").update(`${row.workspace_id}|${row.component}|${row.file_ref}`).digest("hex").slice(0, 16)}`;

/** Reproduce the documented MEMORY.md load rule independently of the probe. */
export function loadedBytes(source: Pick<Source, "component" | "file_ref">): Buffer | null {
  if (source.component !== "MEMORY" && source.component !== "CLAUDE_MD") return null;
  const filename =
    source.component === "MEMORY" ? path.join(source.file_ref, "MEMORY.md") : source.file_ref;
  const raw = fs.readFileSync(filename, "utf8");
  if (source.component !== "MEMORY") return Buffer.from(raw, "utf8");
  const lines = raw.split("\n").slice(0, 200).join("\n");
  const chars: string[] = [];
  let bytes = 0;
  for (const char of lines) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > 25_600) break;
    chars.push(char);
    bytes += size;
  }
  return Buffer.from(chars.join(""), "utf8");
}

function versionsAt(versions: Version[], at: string, workspace: string): Map<string, Version> {
  const result = new Map<string, Version>();
  for (const row of versions) {
    if (
      (row.workspace_id !== workspace && row.workspace_id !== "__global__") ||
      row.observed_at > at
    )
      continue;
    const id = key(row);
    const old = result.get(id);
    if (
      !old ||
      old.observed_at < row.observed_at ||
      (old.observed_at === row.observed_at && old.id < row.id)
    ) {
      result.set(id, row);
    }
  }
  return result;
}

function firstTurns(db: Database.Database): FirstTurn[] {
  const turnColumns = new Set(
    (db.pragma("table_info(turns)") as { name: string }[]).map((r) => r.name),
  );
  const boundary = turnColumns.has("is_compaction_boundary")
    ? "AND t.is_compaction_boundary = 0"
    : "";
  const eventTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ingest_metric_events'")
    .get();
  const eventColumns = eventTable
    ? new Set(
        (db.pragma("table_info(ingest_metric_events)") as { name: string }[]).map((r) => r.name),
      )
    : new Set<string>();
  const eventGuard =
    eventColumns.has("boundary_kind") && eventColumns.has("event_ts")
      ? `AND NOT EXISTS (SELECT 1 FROM ingest_metric_events e WHERE e.session_id = t.session_id
         AND e.event_ts <= t.ts AND e.boundary_kind IN ('compact-summary','compact-boundary','legacy-summary'))`
      : "";
  // The first assistant turn must itself be main-thread. A sidechain or a compacted
  // first turn cannot be substituted by a later main-thread turn.
  return db
    .prepare(`SELECT t.session_id, s.workspace_id, t.ts,
      (t.input_tokens + t.cache_read_tokens + t.cache_write_5m + t.cache_write_1h + t.cache_write_other) AS prefix
    FROM turns t JOIN sessions s ON s.session_id = t.session_id
    WHERE t.is_sidechain = 0 ${boundary} ${eventGuard}
      AND NOT EXISTS (SELECT 1 FROM turns prior WHERE prior.session_id = t.session_id
        AND (prior.ts < t.ts OR (prior.ts = t.ts AND prior.message_id < t.message_id)))
    ORDER BY t.ts, t.session_id`)
    .all() as FirstTurn[];
}

/** All quantities are structural counts; this function never writes to the DB. */
export function checkPrefix(
  db: Database.Database,
  dEvidence: Map<string, BaselineEvidence> = new Map(),
  sourceId?: string,
  since?: string,
  minDifferentials = 0,
  pair?: DifferentialPair,
  measured?: MeasuredCounts,
): OracleReport {
  if (!Number.isSafeInteger(minDifferentials) || minDifferentials < 0)
    throw new Error("--min-c-pairs must be a nonnegative integer");
  if (pair && (!sourceId || pair.source !== sourceId))
    throw new Error("controlled pair requires a matching --source");
  const sinceMs = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
  if (Number.isNaN(sinceMs)) throw new Error("--since must be an ISO timestamp");
  const findings: Finding[] = [];
  const skips: Finding[] = [];
  const current = db
    .prepare(
      "SELECT probe_id, workspace_id, component, file_ref, file_hash, tokens, attribution_version FROM context_inventory",
    )
    .all() as Source[];
  if (sourceId && !current.some((row) => row.probe_id === sourceId))
    throw new Error(`Unknown probe_id: ${sourceId}`);
  const history = (
    db
      .prepare(`SELECT id, workspace_id, component, file_ref, file_hash, tokens,
    attribution_version, observed_at FROM context_inventory_history ORDER BY observed_at, id`)
      .all() as Omit<Version, "probe_id">[]
  ).map((row) => ({ ...row, probe_id: probeId(row) }));
  // Older databases may have current inventory without history. The current row
  // is usable only after its own observation time, never retroactively.
  for (const row of current) {
    if (!history.some((h) => key(h) === key(row) && h.file_hash === row.file_hash)) {
      const observed = db
        .prepare("SELECT probed_at FROM context_inventory WHERE probe_id = ?")
        .get(row.probe_id) as { probed_at: string };
      history.push({ ...row, observed_at: observed.probed_at, id: Number.MAX_SAFE_INTEGER });
    }
  }
  history.sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id - b.id);

  let disk = 0;
  let measuredCount = 0;
  let unproven = 0;
  for (const row of current) {
    if (sourceId && row.probe_id !== sourceId) continue;
    if (!FILE_BACKED.has(row.component)) continue;
    disk++;
    let content: Buffer | null;
    try {
      content = loadedBytes(row);
    } catch {
      skips.push({ check: "b", source: row.probe_id, detail: "SKIP (missing)" });
      continue;
    }
    if (!content) continue;
    const contentHash = createHash("sha1").update(content).digest("hex");
    const tokens = measured?.counts.get(contentHash);
    if (tokens === undefined) {
      // Fallback consistency only: catches a wrong load rule or size, but agreeing with
      // bytes/4 proves nothing about Claude tokens (the probe uses the same heuristic).
      const bytes4 = Math.ceil(content.length / 4);
      if (Math.abs(row.tokens - bytes4) > Math.max(1, bytes4 * 0.1)) {
        findings.push({
          check: "b",
          source: row.probe_id,
          detail: `claimed ${row.tokens}, disk bytes/4 ${bytes4}`,
        });
      }
      unproven++;
      skips.push({
        check: "b",
        source: row.probe_id,
        detail: "UNPROVEN (no independent token count for the loaded content)",
      });
    } else {
      measuredCount++;
      if (Math.abs(row.tokens - tokens) > Math.max(1, tokens * 0.1)) {
        findings.push({
          check: "b",
          source: row.probe_id,
          detail: `claimed ${row.tokens}, measured ${tokens} tokens (${measured?.model}, Claude Code ${measured?.claudeVersion})`,
        });
      }
    }
    // A changed hash means the file was edited after the last probe; tokens are still
    // compared (a wrong load rule must not hide behind a stale hash), but note it.
    if (contentHash !== row.file_hash) {
      skips.push({
        check: "b",
        source: row.probe_id,
        detail: "note: on-disk loaded content changed since the probe",
      });
    }
  }

  // --since selects changes and (d) sessions. A (c) comparison still needs
  // eligible first turns from the seven days before each selected change.
  const turns = firstTurns(db);
  const scopedTurns = turns.filter((turn) => Date.parse(turn.ts) >= sinceMs);
  let dProven = 0;
  let dUnproven = 0;
  if (scopedTurns.length === 0) {
    skips.push({ check: "d", detail: "SKIP (no fresh main-thread first turns)" });
  }
  let changes = 0;
  let differentials = 0;
  let pairMatched = false;
  const grouped = new Map<string, Version[]>();
  for (const row of history) {
    const id = key(row);
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  for (const group of grouped.values()) {
    for (let i = 1; i < group.length; i++) {
      const beforeVersion = group[i - 1];
      const afterVersion = group[i];
      if (!beforeVersion || !afterVersion) continue;
      if (
        beforeVersion.file_hash === afterVersion.file_hash ||
        (sourceId && afterVersion.probe_id !== sourceId)
      )
        continue;
      if (afterVersion.tokens === 0 && beforeVersion.tokens === 0) continue;
      const changeTime = Date.parse(afterVersion.observed_at);
      if (changeTime < sinceMs) continue;
      changes++;
      if (!Number.isFinite(changeTime)) {
        findings.push({
          check: "c",
          source: afterVersion.probe_id,
          detail: "invalid change timestamp",
        });
        continue;
      }
      if (
        !pair ||
        pair.source !== afterVersion.probe_id ||
        pair.changedAt !== afterVersion.observed_at
      ) {
        skips.push({
          check: "c",
          source: afterVersion.probe_id,
          detail: "SKIP (no controlled before/after pair)",
        });
        continue;
      }
      pairMatched = true;
      const eligible = turns.filter(
        (turn) =>
          (afterVersion.workspace_id === "__global__" ||
            turn.workspace_id === afterVersion.workspace_id) &&
          Number.isFinite(Date.parse(turn.ts)) &&
          versionsAt(history, turn.ts, turn.workspace_id).get(key(afterVersion))?.file_hash ===
            (Date.parse(turn.ts) < changeTime ? beforeVersion.file_hash : afterVersion.file_hash),
      );
      const prior = eligible.filter(
        (turn) =>
          turn.session_id === pair.before &&
          Date.parse(turn.ts) >= changeTime - 7 * DAY &&
          Date.parse(turn.ts) < changeTime,
      );
      const next = eligible.filter(
        (turn) =>
          turn.session_id === pair.after &&
          Date.parse(turn.ts) >= changeTime &&
          Date.parse(turn.ts) < changeTime + 7 * DAY,
      );
      if (!prior.length || !next.length) {
        findings.push({
          check: "c",
          source: afterVersion.probe_id,
          detail: `invalid controlled pair: ${prior.length} before, ${next.length} after`,
        });
        continue;
      }
      differentials++;
      const mean = (rows: FirstTurn[]) =>
        rows.reduce((sum, row) => sum + row.prefix, 0) / rows.length;
      const observed = mean(next) - mean(prior);
      const claimed = afterVersion.tokens - beforeVersion.tokens;
      if (Math.abs(observed - claimed) > Math.max(500, Math.abs(claimed) * 0.25)) {
        findings.push({
          check: "c",
          source: afterVersion.probe_id,
          detail: `claimed delta ${claimed}, observed delta ${Math.round(observed)}`,
        });
      }
    }
  }

  if (pair && !pairMatched) {
    findings.push({
      check: "c",
      source: pair.source,
      detail: "requested controlled pair does not match a selected source change",
    });
  }
  if (differentials < minDifferentials) {
    findings.push({
      check: "c",
      detail: `insufficient differential coverage: ${differentials} checked, ${minDifferentials} required`,
    });
  }

  for (const turn of scopedTurns) {
    const evidence = dEvidence.get(turn.session_id);
    if (!evidence) {
      dUnproven++;
      skips.push({
        check: "d",
        session: turn.session_id,
        detail: "UNPROVEN (no version and tool-config baseline evidence)",
      });
      continue;
    }
    if (
      !evidence.claudeVersion ||
      !evidence.toolConfig ||
      !Number.isSafeInteger(evidence.baseline) ||
      evidence.baseline < 0
    )
      throw new Error("invalid C1(d) baseline evidence");
    dProven++;
    const sum = [...versionsAt(history, turn.ts, turn.workspace_id).values()]
      .filter((row) => FILE_BACKED.has(row.component))
      .filter((row) => !sourceId || row.probe_id === sourceId)
      .reduce((total, row) => total + row.tokens, 0);
    if (sum > turn.prefix - evidence.baseline) {
      findings.push({
        check: "d",
        session: turn.session_id,
        detail: `claimed ${sum}, prefix ${turn.prefix}, baseline ${evidence.baseline} (Claude Code ${evidence.claudeVersion}, ${evidence.toolConfig})`,
      });
    }
  }
  return {
    ok: findings.length === 0,
    checked: {
      disk,
      measured: measuredCount,
      unproven,
      changes,
      differentials,
      sessions: scopedTurns.length,
      dProven,
      dUnproven,
    },
    findings,
    skips,
  };
}

const USAGE =
  "Usage: prefix-oracle.ts --db <path> [--d-evidence <cohorts.json>] [--source <probe_id>] [--since <ISO>] [--min-c-pairs <count>] [--c-change-at <ISO> --c-before <session_id> --c-after <session_id>] [--measured <source-pairs.json>]";

class UsageError extends Error {}

/** Operator-attested cohort membership; never derived from the observed prefix. */
export function readBaselineEvidence(file: string): Map<string, BaselineEvidence> {
  const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || !("cohorts" in data) || !Array.isArray(data.cohorts))
    throw new Error("--d-evidence requires cohorts");
  const result = new Map<string, BaselineEvidence>();
  for (const value of data.cohorts) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.claudeVersion !== "string" ||
      !value.claudeVersion.trim() ||
      typeof value.toolConfig !== "string" ||
      !value.toolConfig.trim() ||
      !Number.isSafeInteger(value.baseline) ||
      value.baseline < 0 ||
      !Array.isArray(value.sessions) ||
      !value.sessions.length
    )
      throw new Error("--d-evidence has an invalid cohort");
    for (const session of value.sessions) {
      if (typeof session !== "string" || !session || result.has(session))
        throw new Error("--d-evidence has an invalid or duplicate session");
      result.set(session, {
        claudeVersion: value.claudeVersion,
        toolConfig: value.toolConfig,
        baseline: value.baseline,
      });
    }
  }
  return result;
}

/** Message-mode deltas from a `source-pairs.mjs` result: content-only Claude token counts. */
export function readMeasured(file: string): MeasuredCounts {
  const result = JSON.parse(fs.readFileSync(file, "utf8")) as {
    claudeVersion: string;
    models: string[];
    deltas: { mode: string; contentSha1: string; observed: number[] }[];
  };
  const [model, ...others] = result.models;
  if (!model || others.length) throw new Error("--measured must come from exactly one model");
  const counts = new Map<string, number>();
  for (const delta of result.deltas) {
    if (delta.mode !== "M") continue;
    const values = new Set(delta.observed);
    // Repeated runs of one content must agree; a spread means the pair was not isolated.
    if (values.size !== 1) throw new Error(`--measured: unstable count for ${delta.contentSha1}`);
    counts.set(delta.contentSha1, [...values][0] as number);
  }
  return { claudeVersion: result.claudeVersion, model, counts };
}

export function runCli(argv: string[]): number {
  let dbPath: string | undefined;
  let dEvidenceFile: string | undefined;
  let source: string | undefined;
  let since: string | undefined;
  let minDifferentials = 0;
  let changedAt: string | undefined;
  let before: string | undefined;
  let after: string | undefined;
  let measuredFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (
      !flag ||
      ![
        "--db",
        "--d-evidence",
        "--source",
        "--since",
        "--min-c-pairs",
        "--c-change-at",
        "--c-before",
        "--c-after",
        "--measured",
      ].includes(flag) ||
      !next ||
      next.startsWith("--")
    ) {
      throw new UsageError(USAGE);
    }
    const value = next;
    i++;
    if (flag === "--db") dbPath = value;
    if (flag === "--d-evidence") dEvidenceFile = value;
    if (flag === "--source") source = value;
    if (flag === "--since") since = value;
    if (flag === "--min-c-pairs") minDifferentials = Number(value);
    if (flag === "--c-change-at") changedAt = value;
    if (flag === "--c-before") before = value;
    if (flag === "--c-after") after = value;
    if (flag === "--measured") measuredFile = value;
  }
  if (!dbPath) throw new UsageError(USAGE);
  if ([changedAt, before, after].some(Boolean) && (!changedAt || !before || !after || !source))
    throw new UsageError(USAGE);
  const pair =
    changedAt && before && after && source ? { source, changedAt, before, after } : undefined;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const report = checkPrefix(
      db,
      dEvidenceFile ? readBaselineEvidence(dEvidenceFile) : undefined,
      source,
      since,
      Math.max(minDifferentials, pair ? 1 : 0),
      pair,
      measuredFile ? readMeasured(measuredFile) : undefined,
    );
    console.log(JSON.stringify(report, null, 2));
    // Exit 3: no failures, but (b) or (d) lacks independent evidence.
    const status = !report.ok
      ? "FAIL"
      : report.checked.unproven > 0 || report.checked.dUnproven > 0 || report.checked.dProven === 0
        ? "UNPROVEN"
        : "PASS";
    console.log(
      `summary: ${status} · b ${report.checked.disk} sources (${report.checked.measured} measured, ${report.checked.unproven} unproven) · c ${report.checked.differentials}/${report.checked.changes} pairs/changes · d ${report.checked.dProven}/${report.checked.sessions} proven/sessions · ${report.findings.length} FAIL · ${report.skips.length} SKIP`,
    );
    return status === "FAIL" ? 1 : status === "UNPROVEN" ? 3 : 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
