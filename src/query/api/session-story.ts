/**
 * src/query/api/session-story.ts — GET /api/sessions/:id/story.
 *
 * What a session did and where its money went, in one payload for the session page:
 * title, first prompt, files touched and commits; spend by chain and model with a
 * plain-English headline; one lane per chain (main + each subagent) and every turn for
 * the timeline and context charts; tool errors grouped by their stored error text.
 *
 * The first prompt and files touched are read from the transcript on demand (they are
 * not stored); both are null/empty once Claude Code has deleted the file. Local-only
 * content (ADR-112); the prompt passes the ingest secrets filter.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Db } from "../../db/open.js";
import { tierPriceVector } from "../../detector/tier-price.js";
import { PREMIUM_MODEL_SQL } from "../../ingest/pricing.js";
import { redactSecrets } from "../../ingest/secrets-filter.js";

export interface StoryLane {
  lane_id: string;
  /** "Main" or the subagent type (e.g. "Explore"). */
  label: string;
  is_main: boolean;
  first_ts: string;
  last_ts: string;
  turns: number;
  cost_u: number;
  models: string[];
}

export interface StoryTurn {
  ts: string;
  lane_id: string;
  model: string;
  context: number;
  cost_u: number;
  compaction: boolean;
  /** A tool call in this turn failed. */
  error: boolean;
}

export interface StorySpend {
  chain: "main" | "subagent";
  model: string;
  turns: number;
  cost_u: number;
}

export interface StoryHeadline {
  text: string;
  detail: string | null;
  /** Estimated µUSD saved by the suggested change; null when there is no estimate. */
  savings_u: number | null;
}

export interface StoryErrorGroup {
  tool: string;
  /** Most common command head for shell tools (e.g. "npm run test"); null otherwise. */
  command: string | null;
  /** How many other command heads hit the same error. */
  other_commands: number;
  /** First meaningful error line, digits and long paths normalized. */
  signature: string;
  count: number;
  sample_command: string | null;
  sample_error: string;
  first_ts: string;
  last_ts: string;
}

export interface SessionStory {
  session_id: string;
  title: string | null;
  first_prompt: string | null;
  transcript_available: boolean;
  files_touched: Array<{ path: string; edits: number }>;
  commits: Array<{ sha: string; ts: string }>;
  total_cost_u: number;
  spend: StorySpend[];
  headline: StoryHeadline | null;
  lanes: StoryLane[];
  turns: StoryTurn[];
  error_groups: StoryErrorGroup[];
  /** Errors recorded before error text was captured; they appear in no group. */
  errors_without_text: number;
}

const MAX_FILES = 15;
const MAX_ERROR_GROUPS = 10;
const MAX_PROMPT_CHARS = 600;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Shell"]);

/** "claude-opus-4-8" → "Opus 4.8"; date suffixes dropped. */
export function prettyModel(model: string): string {
  const parts = model
    .replace(/^claude-/, "")
    .split("-")
    .filter((p) => !/^\d{8}$/.test(p));
  const [family, ...version] = parts;
  if (family === undefined) return model;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version.length > 0 ? `${name} ${version.join(".")}` : name;
}

/** The first user-typed prompt: skips tool results, slash-command wrappers and meta lines. */
function promptText(rec: Record<string, unknown>): string | null {
  if (rec.type !== "user" || rec.isMeta === true || rec.isSidechain === true) return null;
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const block = content.find(
      (b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string",
    );
    if (content.some((b) => typeof b === "object" && b?.type === "tool_result")) return null;
    text = block?.text ?? null;
  }
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("<") || trimmed.startsWith("Caveat:")) return null;
  return trimmed;
}

/** A file path relative to the repo, with any `.worktrees/<branch>/` prefix dropped. */
export function repoRelative(target: string, repoPath: string | null): string {
  let p = target.replaceAll("\\", "/");
  const root = repoPath?.replaceAll("\\", "/").replace(/\/+$/, "");
  if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) p = p.slice(root.length + 1);
  return p.replace(/^\.(?:claude\/)?worktrees\/[^/]+\//, "");
}

async function readTranscript(
  filePath: string,
  repoPath: string | null,
): Promise<{ firstPrompt: string | null; files: Map<string, number> } | null> {
  const files = new Map<string, number>();
  let firstPrompt: string | null = null;
  const subDir = path.join(path.dirname(filePath), path.basename(filePath, ".jsonl"), "subagents");
  const paths = [filePath];
  try {
    for (const f of fs.readdirSync(subDir))
      if (f.endsWith(".jsonl")) paths.push(path.join(subDir, f));
  } catch {
    // No subagents.
  }
  if (!fs.existsSync(filePath)) return null;
  for (const p of paths) {
    const rl = readline.createInterface({
      input: fs.createReadStream(p),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      const wantPrompt = firstPrompt === null && p === filePath && line.includes('"type":"user"');
      if (!wantPrompt && !line.includes('"tool_use"')) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (wantPrompt) firstPrompt = promptText(rec);
      const content = (rec.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== "tool_use" || !EDIT_TOOLS.has(block.name)) continue;
        const target = block.input?.file_path ?? block.input?.notebook_path;
        if (typeof target !== "string") continue;
        const key = repoRelative(target, repoPath);
        files.set(key, (files.get(key) ?? 0) + 1);
      }
    }
  }
  return {
    firstPrompt:
      firstPrompt === null ? null : redactSecrets(firstPrompt).slice(0, MAX_PROMPT_CHARS),
    files,
  };
}

/** Executable head of a shell command's first non-`cd` step, e.g. "npm run test" or "git commit". */
export function commandHead(command: string): string {
  const steps = command.split(/&&|;|\|\||\n/).map((s) => s.trim());
  const step = steps.find((s) => s !== "" && !/^(cd|Set-Location)\b/.test(s)) ?? steps[0] ?? "";
  const words = step.split(/\s+/);
  const two = new Set(["npm", "npx", "git", "node", "pnpm", "yarn", "gh", "docker", "cargo", "go"]);
  const n = two.has(words[0] ?? "") ? (words[1] === "run" ? 3 : 2) : 1;
  return words.slice(0, n).join(" ");
}

/** First meaningful error line with numbers, quoted strings and long paths normalized. */
export function errorSignature(error: string): string {
  const line =
    error
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !/^Exit code \d+$/i.test(l) && !/^<\/?tool_use_error>$/.test(l)) ??
    error.trim();
  return line
    .replace(/<\/?tool_use_error>/g, "")
    .replace(/"[^"]{20,}"/g, '"…"')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:'"]+[\\/][^\s:'"]+/g, "…/")
    .replace(/\d+/g, "#")
    .slice(0, 140);
}

function groupErrors(
  db: Db,
  sessionId: string,
): { groups: StoryErrorGroup[]; withoutText: number } {
  const rows = db
    .prepare(
      `SELECT e.ts, e.tool_name, c.content_json
         FROM tool_events e LEFT JOIN tool_event_content c ON c.event_id = e.event_id
        WHERE e.session_id = ? AND e.exit_class = 'ERROR'
        ORDER BY e.ts, e.event_id`,
    )
    .all(sessionId) as Array<{ ts: string; tool_name: string; content_json: string | null }>;
  const groups = new Map<string, StoryErrorGroup>();
  const heads = new Map<string, Map<string, number>>();
  let withoutText = 0;
  for (const row of rows) {
    let content: { command?: unknown; error?: unknown } = {};
    try {
      content = row.content_json === null ? {} : JSON.parse(row.content_json);
    } catch {
      // Treated as missing text.
    }
    if (typeof content.error !== "string" || content.error.trim() === "") {
      withoutText++;
      continue;
    }
    const sampleCommand = typeof content.command === "string" ? content.command : null;
    const command =
      SHELL_TOOLS.has(row.tool_name) && sampleCommand !== null ? commandHead(sampleCommand) : null;
    const signature = errorSignature(content.error);
    // One cause (e.g. a blocking hook) hits many commands, so group on the error alone.
    const key = `${row.tool_name}\u0000${signature}`;
    if (command !== null) {
      const counts = heads.get(key) ?? new Map<string, number>();
      counts.set(command, (counts.get(command) ?? 0) + 1);
      heads.set(key, counts);
    }
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        tool: row.tool_name,
        command,
        other_commands: 0,
        signature,
        count: 1,
        sample_command: sampleCommand?.slice(0, 300) ?? null,
        sample_error: content.error.slice(0, 600),
        first_ts: row.ts,
        last_ts: row.ts,
      });
    } else {
      group.count++;
      group.last_ts = row.ts;
    }
  }
  for (const [key, group] of groups) {
    const counts = [...(heads.get(key) ?? new Map<string, number>()).entries()];
    counts.sort((a, b) => b[1] - a[1]);
    group.command = counts[0]?.[0] ?? null;
    group.other_commands = Math.max(0, counts.length - 1);
  }
  return {
    groups: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, MAX_ERROR_GROUPS),
    withoutText,
  };
}

/** Cost of `turns` if they had run at `tier`'s list prices with the same tokens. */
function repricedAt(
  db: Db,
  sessionId: string,
  where: string,
  tier: string,
): { actual_u: number; repriced_u: number } {
  const [inP, outP, readP, w5P, w1P] = tierPriceVector(db, tier);
  return db
    .prepare(
      `SELECT COALESCE(SUM(cost_equiv_u), 0) AS actual_u,
              COALESCE(SUM(input_tokens * ? + output_tokens * ? + cache_read_tokens * ?
                + (cache_write_5m + cache_write_other) * ? + cache_write_1h * ?), 0) AS repriced_u
         FROM turns WHERE session_id = ? AND ${where}`,
    )
    .get(inP, outP, readP, w5P, w1P, sessionId) as { actual_u: number; repriced_u: number };
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function buildHeadline(db: Db, sessionId: string, spend: StorySpend[], total: number) {
  if (total <= 0 || spend.length === 0) return null;
  const subagent = spend.filter((s) => s.chain === "subagent");
  const subagentCost = subagent.reduce((sum, s) => sum + s.cost_u, 0);
  const premiumSub = subagent.filter((s) => /opus|fable|mythos/.test(s.model));
  const premiumSubCost = premiumSub.reduce((sum, s) => sum + s.cost_u, 0);
  if (premiumSubCost / total >= 0.3) {
    const models = [...new Set(premiumSub.map((s) => prettyModel(s.model)))].join(" and ");
    const { actual_u, repriced_u } = repricedAt(
      db,
      sessionId,
      `is_sidechain = 1 AND ${PREMIUM_MODEL_SQL}`,
      "sonnet-5",
    );
    const savings = Math.max(0, actual_u - repriced_u);
    return {
      text: `${pct(premiumSubCost / total)} of this session's cost was subagents running on ${models}.`,
      detail:
        "Estimate: the same subagent tokens priced at Sonnet 5. Set a cheaper model for subagents that search, read or follow a clear spec.",
      savings_u: savings > 0 ? savings : null,
    };
  }
  if (subagentCost / total >= 0.5) {
    return {
      text: `${pct(subagentCost / total)} of this session's cost was subagent work.`,
      detail: null,
      savings_u: null,
    };
  }
  const top = spend[0] as StorySpend;
  const chain = top.chain === "main" ? "the main conversation" : "subagents";
  return {
    text: `${pct(top.cost_u / total)} of this session's cost was ${chain} on ${prettyModel(top.model)}.`,
    detail: null,
    savings_u: null,
  };
}

export async function getSessionStory(db: Db, sessionId: string): Promise<SessionStory | null> {
  const session = db
    .prepare(
      `SELECT s.session_id, s.title, s.file_path, w.repo_path
         FROM sessions s LEFT JOIN workspaces w ON w.workspace_id = s.workspace_id
        WHERE s.session_id = ?`,
    )
    .get(sessionId) as
    | { session_id: string; title: string | null; file_path: string; repo_path: string | null }
    | undefined;
  if (session === undefined) return null;

  const turnRows = db
    .prepare(
      `SELECT t.message_id, t.ts, t.model, t.is_sidechain, t.agent_id, t.context_tokens,
              COALESCE(t.cost_equiv_u, 0) AS cost_u, t.is_compaction_boundary,
              EXISTS (SELECT 1 FROM tool_event_metadata m JOIN tool_events e ON e.event_id = m.event_id
                       WHERE m.owner_message_id = t.message_id AND e.exit_class = 'ERROR') AS error
         FROM turns t WHERE t.session_id = ? ORDER BY t.ts, t.message_id`,
    )
    .all(sessionId) as Array<{
    message_id: string;
    ts: string;
    model: string;
    is_sidechain: number;
    agent_id: string | null;
    context_tokens: number;
    cost_u: number;
    is_compaction_boundary: number | null;
    error: number;
  }>;
  const agentTypes = new Map(
    (
      db
        .prepare("SELECT agent_id, agent_type FROM subagent_meta WHERE session_id = ?")
        .all(sessionId) as Array<{
        agent_id: string;
        agent_type: string | null;
      }>
    ).map((r) => [r.agent_id, r.agent_type]),
  );

  const lanes = new Map<string, StoryLane>();
  const spendMap = new Map<string, StorySpend>();
  const turns: StoryTurn[] = [];
  let total = 0;
  for (const row of turnRows) {
    const isMain = row.is_sidechain === 0;
    const laneId = isMain ? "main" : (row.agent_id ?? "subagent");
    let lane = lanes.get(laneId);
    if (lane === undefined) {
      lane = {
        lane_id: laneId,
        label: isMain ? "Main" : (agentTypes.get(laneId) ?? "Subagent"),
        is_main: isMain,
        first_ts: row.ts,
        last_ts: row.ts,
        turns: 0,
        cost_u: 0,
        models: [],
      };
      lanes.set(laneId, lane);
    }
    lane.last_ts = row.ts;
    lane.turns++;
    lane.cost_u += row.cost_u;
    if (!lane.models.includes(row.model)) lane.models.push(row.model);

    const chain = isMain ? "main" : "subagent";
    const key = `${chain}\u0000${row.model}`;
    const s = spendMap.get(key) ?? { chain, model: row.model, turns: 0, cost_u: 0 };
    s.turns++;
    s.cost_u += row.cost_u;
    spendMap.set(key, s);
    total += row.cost_u;

    turns.push({
      ts: row.ts,
      lane_id: laneId,
      model: row.model,
      context: row.context_tokens,
      cost_u: row.cost_u,
      compaction: row.is_compaction_boundary === 1,
      error: row.error === 1,
    });
  }
  const spend = [...spendMap.values()].sort((a, b) => b.cost_u - a.cost_u);
  const orderedLanes = [...lanes.values()].sort((a, b) =>
    a.is_main !== b.is_main ? (a.is_main ? -1 : 1) : a.first_ts.localeCompare(b.first_ts),
  );

  const commits = db
    .prepare(
      `SELECT commit_sha AS sha, MIN(ts) AS ts FROM tool_events
        WHERE session_id = ? AND commit_sha IS NOT NULL GROUP BY commit_sha ORDER BY ts`,
    )
    .all(sessionId) as Array<{ sha: string; ts: string }>;

  const transcript = await readTranscript(session.file_path, session.repo_path);
  const files = [...(transcript?.files ?? new Map<string, number>()).entries()]
    .map(([p, edits]) => ({ path: p, edits }))
    .sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
  const errors = groupErrors(db, sessionId);

  return {
    session_id: sessionId,
    title: session.title,
    first_prompt: transcript?.firstPrompt ?? null,
    transcript_available: transcript !== null,
    files_touched: files,
    commits,
    total_cost_u: total,
    spend,
    headline: buildHeadline(db, sessionId, spend, total),
    lanes: orderedLanes,
    turns,
    error_groups: errors.groups,
    errors_without_text: errors.withoutText,
  };
}
