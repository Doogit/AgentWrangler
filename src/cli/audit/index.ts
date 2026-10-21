/**
 * src/cli/audit/index.ts — `agentwrangler audit [--db <src>] [--out <dir>] [--jsonl-root <dir>] [--days N]`.
 *
 * Runs in-process (like `statusline`), never through the daemon. It copies the DB with SQLite's online
 * backup, opens ONLY the copy, injects it as the query DB, and writes an audit folder: db.sqlite,
 * schema.md, pack.md, query.mjs, scan.mjs, render.mjs, prompt.md. The user then runs the printed `claude "..."`
 * line in their own session, which ends by rendering its findings.json to report.html with render.mjs. The source DB is opened read-only and never migrated.
 *
 * Budget (ADR-113): that registry covers daemon routes and jobs only; a CLI command has none, so none is
 * registered. The run is a few dozen aggregate queries over the copy.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig } from "../../daemon/config.js";
import { resetQueryDb, setQueryDb } from "../../query/db-context.js";

export interface AuditOptions {
  /** Source DB. Default: the daemon's DB path. */
  db: string;
  /** Output folder. Default: ~/.agentwrangler/audits/<YYYY-MM-DD>/ */
  out: string;
  /** Transcript root written into scan.mjs. Default: ~/.claude/projects */
  jsonlRoot: string;
  /** Window length in days, ending at max(turns.ts). */
  days: number;
  /** Override for prompt.md source (tests). Default: prompt.md next to this module. */
  promptPath?: string;
  /** Override for the settings files scan.mjs checks for hooks (fixtures). Default: ~/.claude + session cwds. */
  settingsFiles?: string[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseAuditArgs(argv: string[], today = new Date()): AuditOptions {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (i >= 0 && (v === undefined || v.startsWith("--")))
      throw new Error(`--${name} needs a value`);
    return v;
  };
  const days = Number.parseInt(val("days") ?? "28", 10);
  if (!Number.isFinite(days) || days < 1) throw new Error("--days must be a positive integer");
  return {
    db: path.resolve(val("db") ?? loadConfig().dbPath),
    out: path.resolve(
      val("out") ??
        path.join(os.homedir(), ".agentwrangler", "audits", today.toISOString().slice(0, 10)),
    ),
    jsonlRoot: path.resolve(val("jsonl-root") ?? path.join(os.homedir(), ".claude", "projects")),
    days,
  };
}

type Row = Record<string, unknown>;

const usd = (u: unknown): string => `$${((Number(u) || 0) / 1e6).toFixed(4)}`;
const num = (n: unknown): string => Math.round(Number(n) || 0).toLocaleString("en-US");

function md(rows: Row[], fmt: Record<string, (v: unknown) => string> = {}): string {
  if (rows.length === 0) return "_none in window_\n";
  const cols = Object.keys(rows[0] as Row);
  const cell = (c: string, v: unknown): string => {
    const f = fmt[c];
    const s = f ? f(v) : v === null || v === undefined ? "" : String(v);
    return s.replace(/\|/g, "/").replace(/\s+/g, " ");
  };
  const head = `| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|\n`;
  const body = rows.map((r) => `| ${cols.map((c) => cell(c, r[c])).join(" | ")} |`).join("\n");
  return `${head}${body}\n`;
}

/** Columns ending in `_u` are cost_equiv_u (micro-USD) and print as $. */
function autoFmt(rows: Row[]): Record<string, (v: unknown) => string> {
  const fmt: Record<string, (v: unknown) => string> = {};
  for (const c of Object.keys(rows[0] ?? {})) {
    if (c.endsWith("_u")) fmt[c] = usd;
    else if (/(tokens|^turns$|^count$|^agents$|^n$|^rebuilds$|^errors$|^calls$)/.test(c))
      fmt[c] = num;
  }
  return fmt;
}

function schemaMd(db: Database.Database): string {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  let out =
    "# Schema (db.sqlite)\n\nAll tables and columns. `cost_equiv_u` columns are micro-USD (divide by 1e6).\n\n";
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_xinfo("${t.name.replace(/"/g, '""')}")`).all() as {
      name: string;
      type: string;
      pk: number;
    }[];
    out += `## ${t.name}\n${cols.map((c) => `- ${c.name} ${c.type}${c.pk ? " (pk)" : ""}`).join("\n")}\n\n`;
  }
  return out;
}

function packMd(db: Database.Database, days: number, srcLabel: string): string {
  const maxTs = (db.prepare("SELECT MAX(ts) AS m FROM turns").get() as { m: string | null }).m;
  let out = "# Audit pack\n\n";
  if (maxTs === null) return `${out}The database has no turns. Nothing to audit.\n`;
  const end = maxTs;
  const start = new Date(Date.parse(end) - days * 86_400_000).toISOString();
  const win = { s: start, e: end };
  const basis =
    "- Pricing basis: every $ is `cost_equiv_u` (micro-USD, divided by 1e6) = tokens x the list price in `pricing_snapshots` at ingest. " +
    "It is list-equivalent API cost, not what a subscription is billed. Cache writes are priced separately (5m and 1h rates). " +
    "Turns with no priceable model count as $0.";
  const verify =
    '- `pack.md` is a starting point. Re-verify every number with `node query.mjs "SELECT ..."` before you report it.';
  out += `- Source: ${srcLabel}
- Window: ${start} to ${end} (${days} days ending at the latest turn, not the wall clock)
${basis}
${verify}

`;

  const q = (sql: string, extra: Row = {}): Row[] =>
    db.prepare(sql).all({ ...win, ...extra }) as Row[];
  const section = (title: string, note: string, sql: string, extra: Row = {}): void => {
    out += `## ${title}\n`;
    if (note) out += `${note}\n\n`;
    try {
      const rows = q(sql, extra);
      out += md(rows, autoFmt(rows));
    } catch (e) {
      out += `_section unavailable: ${(e as Error).message}_\n`;
    }
    out += "\n";
  };
  const W = "t.ts >= @s AND t.ts <= @e";

  section(
    "Total spend",
    "",
    `SELECT COUNT(*) AS turns, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_5m + cache_write_1h + cache_write_other) AS cache_write_tokens,
            SUM(cost_equiv_u) AS cost_u, SUM(cost_equiv_u IS NULL) AS unpriced_turns
       FROM turns t WHERE ${W}`,
  );
  section(
    "Spend by model",
    "",
    `SELECT model, COUNT(*) AS turns, SUM(output_tokens) AS output_tokens, SUM(cost_equiv_u) AS cost_u,
            ROUND(100.0 * SUM(cost_equiv_u) / NULLIF((SELECT SUM(cost_equiv_u) FROM turns t WHERE ${W}), 0), 1) AS pct
       FROM turns t WHERE ${W} GROUP BY model ORDER BY cost_u DESC`,
  );
  section(
    "Main thread vs subagent",
    "`is_sidechain = 1` is a subagent turn.",
    `SELECT CASE is_sidechain WHEN 1 THEN 'subagent' ELSE 'main' END AS thread, COUNT(*) AS turns,
            SUM(cost_equiv_u) AS cost_u
       FROM turns t WHERE ${W} GROUP BY is_sidechain`,
  );
  section(
    "Spend by project",
    "",
    `SELECT w.project_slug AS project, COUNT(*) AS turns, SUM(t.cost_equiv_u) AS cost_u
       FROM turns t JOIN workspaces w ON w.workspace_id = t.workspace_id
      WHERE ${W} GROUP BY w.project_slug ORDER BY cost_u DESC LIMIT 15`,
  );

  out += "# Signals\n\n";
  section(
    "S1 main-session model routing: model mix of main-thread turns",
    "Look for expensive models on routine work.",
    `SELECT model, COUNT(*) AS turns, ROUND(AVG(output_tokens)) AS avg_output_per_turn, SUM(cost_equiv_u) AS cost_u
       FROM turns t WHERE ${W} AND is_sidechain = 0 GROUP BY model ORDER BY cost_u DESC`,
  );
  section(
    "S1 instances: sessions by main-thread $",
    "`opus_u` is the part of the session's main-thread $ on an Opus model.",
    `SELECT t.session_id, s.title, COUNT(*) AS turns, SUM(t.cost_equiv_u) AS cost_u,
            SUM(CASE WHEN t.model LIKE '%opus%' THEN t.cost_equiv_u ELSE 0 END) AS opus_u,
            group_concat(DISTINCT t.model) AS models
       FROM turns t LEFT JOIN sessions s ON s.session_id = t.session_id
      WHERE ${W} AND t.is_sidechain = 0 GROUP BY t.session_id ORDER BY cost_u DESC LIMIT 10`,
  );

  const gapCte = `WITH g AS (
      SELECT t.session_id, t.ts, t.cache_write_5m + t.cache_write_1h AS wtok,
             t.cache_write_5m * COALESCE(json_extract(p.unit_prices_json, '$[3]'), 0)
               + t.cache_write_1h * COALESCE(json_extract(p.unit_prices_json, '$[4]'), 0) AS write_u,
             (julianday(t.ts) - julianday(LAG(t.ts) OVER (PARTITION BY t.session_id ORDER BY t.ts))) * 86400 AS gap_s
        FROM turns t LEFT JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id
       WHERE ${W} AND t.is_sidechain = 0)`;
  section(
    "S4 idle cache rebuild: cache writes on main-thread turns after an idle gap",
    "A turn that follows a gap of 5 minutes or more and writes cache rebuilt a prompt cache that expired. " +
      "`write_u` prices only the cache-write tokens (turns without a pricing snapshot count $0).",
    `${gapCte}
     SELECT CASE WHEN gap_s >= 3600 THEN 'gap >= 1 h' ELSE 'gap 5 min to 1 h' END AS gap_class,
            COUNT(*) AS rebuilds, SUM(wtok) AS cache_write_tokens, SUM(write_u) AS write_u
       FROM g WHERE gap_s >= 300 AND wtok > 0 GROUP BY gap_class ORDER BY write_u DESC`,
  );
  section(
    "S4 instances: sessions by rebuild $",
    "",
    `${gapCte}
     SELECT g.session_id, s.title, COUNT(*) AS rebuilds, ROUND(MAX(gap_s) / 3600.0, 1) AS longest_gap_h,
            SUM(wtok) AS cache_write_tokens, SUM(write_u) AS write_u
       FROM g LEFT JOIN sessions s ON s.session_id = g.session_id
      WHERE gap_s >= 300 AND wtok > 0 GROUP BY g.session_id ORDER BY write_u DESC LIMIT 10`,
  );

  section(
    "S6 oversized subagents: agents by $",
    "One row per subagent (`turns.agent_id`; sidechain turns without an id are grouped per session).",
    `SELECT COALESCE(t.agent_id, t.session_id || '#sidechain') AS agent, MAX(sm.agent_type) AS agent_type,
            t.session_id, s.title, COUNT(*) AS turns, MAX(t.context_tokens) AS max_context_tokens,
            group_concat(DISTINCT t.model) AS models, SUM(t.cost_equiv_u) AS cost_u
       FROM turns t LEFT JOIN subagent_meta sm ON sm.agent_id = t.agent_id
       LEFT JOIN sessions s ON s.session_id = t.session_id
      WHERE ${W} AND t.is_sidechain = 1 GROUP BY agent ORDER BY cost_u DESC LIMIT 10`,
  );
  section(
    "S6 subagents by type and model",
    "",
    `SELECT COALESCE(sm.agent_type, '(unknown)') AS agent_type, t.model, COUNT(DISTINCT COALESCE(t.agent_id, t.session_id)) AS agents,
            COUNT(*) AS turns, ROUND(AVG(t.output_tokens)) AS avg_output_per_turn, SUM(t.cost_equiv_u) AS cost_u
       FROM turns t LEFT JOIN subagent_meta sm ON sm.agent_id = t.agent_id
      WHERE ${W} AND t.is_sidechain = 1 GROUP BY agent_type, t.model ORDER BY cost_u DESC LIMIT 15`,
  );

  const MW = "COALESCE(event_ts, user_turn_ts) >= @s AND COALESCE(event_ts, user_turn_ts) <= @e";
  section(
    "S8 hook denies: counts by label",
    "`hook-block` = a PreToolUse hook refused a tool call.",
    `SELECT classifier_label AS label, COUNT(*) AS count FROM ingest_metric_events
      WHERE classifier_label IS NOT NULL AND ${MW} GROUP BY classifier_label ORDER BY count DESC`,
  );
  section(
    "S8 instances: sessions with the most hook blocks",
    "",
    `SELECT e.session_id, s.title, COUNT(*) AS count FROM ingest_metric_events e
       LEFT JOIN sessions s ON s.session_id = e.session_id
      WHERE e.classifier_label = 'hook-block' AND ${MW.replace(/event_ts|user_turn_ts/g, "e.$&")}
      GROUP BY e.session_id ORDER BY count DESC LIMIT 10`,
  );
  section(
    "S8 sample block messages",
    "From `tool_event_content` (secrets already filtered at ingest). Grouped by the message start.",
    `SELECT COUNT(*) AS count, substr(json_extract(c.content_json, '$.error'), 1, 240) AS message,
            MIN(substr(json_extract(c.content_json, '$.command'), 1, 100)) AS example_command
       FROM tool_event_content c JOIN tool_events te ON te.event_id = c.event_id
      WHERE te.ts >= @s AND te.ts <= @e
        AND json_extract(c.content_json, '$.error') LIKE 'PreToolUse:%'
        AND json_extract(c.content_json, '$.error') LIKE '%hook error%'
      GROUP BY substr(json_extract(c.content_json, '$.error'), 1, 160) ORDER BY count DESC LIMIT 8`,
  );

  section(
    "S13 long wall-clock sessions",
    "Wall-clock span from first to last turn in the window, with the $ in the window.",
    `SELECT t.session_id, s.title, COUNT(*) AS turns,
            ROUND((julianday(MAX(t.ts)) - julianday(MIN(t.ts))) * 24, 1) AS span_hours,
            s.long_gap_count, SUM(t.cost_equiv_u) AS cost_u
       FROM turns t LEFT JOIN sessions s ON s.session_id = t.session_id
      WHERE ${W} AND t.is_sidechain = 0 GROUP BY t.session_id ORDER BY span_hours DESC LIMIT 10`,
  );

  const TW = "te.ts >= @s AND te.ts <= @e";
  section(
    "S14 shell errors: Bash and PowerShell calls with exit_class ERROR",
    "",
    `SELECT te.tool_name, COALESCE(te.bash_command_family, '(none)') AS family, COUNT(*) AS errors
       FROM tool_events te WHERE ${TW} AND te.tool_name IN ('Bash','PowerShell') AND te.exit_class = 'ERROR'
      GROUP BY te.tool_name, family ORDER BY errors DESC`,
  );
  section(
    "S14 instances: sessions with the most shell errors",
    "",
    `SELECT te.session_id, s.title, COUNT(*) AS errors FROM tool_events te
       LEFT JOIN sessions s ON s.session_id = te.session_id
      WHERE ${TW} AND te.tool_name IN ('Bash','PowerShell') AND te.exit_class = 'ERROR'
      GROUP BY te.session_id ORDER BY errors DESC LIMIT 10`,
  );

  const one = `WITH one AS (
      SELECT m.owner_message_id AS mid, MIN(te.tool_name) AS tool, MIN(te.bash_command_family) AS fam
        FROM tool_event_metadata m JOIN tool_events te ON te.event_id = m.event_id
       WHERE te.ts >= @s AND te.ts <= @e GROUP BY m.owner_message_id HAVING COUNT(*) = 1)`;
  section(
    "S15 output-heavy mechanical turns: single git/npm shell call per turn, by model",
    "A turn whose only tool call is a git or npm command is mechanical. High output or thinking there is waste.",
    `${one}
     SELECT t.model, COUNT(*) AS turns, ROUND(AVG(t.output_tokens)) AS avg_output_per_turn,
            SUM(COALESCE(t.thinking_tokens, 0)) AS thinking_tokens, SUM(t.cost_equiv_u) AS cost_u
       FROM turns t JOIN one ON one.mid = t.message_id
      WHERE ${W} AND one.tool IN ('Bash','PowerShell') AND one.fam IN ('BASH_GIT','BASH_NPM')
      GROUP BY t.model ORDER BY cost_u DESC`,
  );
  section(
    "S15 instances: sessions by mechanical-turn $",
    "",
    `${one}
     SELECT t.session_id, s.title, t.model, t.is_sidechain, COUNT(*) AS turns,
            ROUND(AVG(t.output_tokens)) AS avg_output_per_turn, SUM(t.cost_equiv_u) AS cost_u
       FROM turns t JOIN one ON one.mid = t.message_id LEFT JOIN sessions s ON s.session_id = t.session_id
      WHERE ${W} AND one.tool IN ('Bash','PowerShell') AND one.fam IN ('BASH_GIT','BASH_NPM')
      GROUP BY t.session_id, t.model, t.is_sidechain ORDER BY cost_u DESC LIMIT 10`,
  );

  out +=
    "## Diagnostics causes\n_skipped: the Diagnostics view is built per session by a worker snapshot " +
    "(`diagnostics-worker`), not an in-process query. Use the S-sections above._\n\n";
  section(
    "Context inventory (latest probe per file)",
    "Always-loaded context the daemon's probe measured: tokens per component.",
    `SELECT ci.component, w.project_slug AS project, ci.file_ref, ci.tokens
       FROM context_inventory ci JOIN workspaces w ON w.workspace_id = ci.workspace_id
      WHERE ci.probed_at = (SELECT MAX(probed_at) FROM context_inventory x
                             WHERE x.workspace_id = ci.workspace_id AND x.file_ref = ci.file_ref)
      ORDER BY ci.tokens DESC LIMIT 25`,
  );
  section(
    "Tool error classes",
    "",
    `SELECT te.tool_error_class AS error_class, te.tool_name, COUNT(*) AS count FROM tool_events te
      WHERE ${TW} AND te.tool_error_class IS NOT NULL GROUP BY error_class, te.tool_name ORDER BY count DESC LIMIT 15`,
  );
  return out;
}

export interface AuditResult {
  out: string;
  command: string;
}

export async function generateAudit(opts: AuditOptions): Promise<AuditResult> {
  const promptSrc = opts.promptPath ?? path.join(HERE, "prompt.md");
  if (!fs.existsSync(promptSrc)) {
    throw new Error(`audit prompt not found at ${promptSrc} (prompt.md ships with the install)`);
  }
  if (!fs.existsSync(opts.db)) throw new Error(`source database not found: ${opts.db}`);
  fs.mkdirSync(opts.out, { recursive: true });
  const copyPath = path.join(opts.out, "db.sqlite");
  // The copy step deletes <out>/db.sqlite first: never let that be the source DB.
  if (path.resolve(copyPath).toLowerCase() === path.resolve(opts.db).toLowerCase()) {
    throw new Error(
      `--out would overwrite the source database (${opts.db}); choose another folder`,
    );
  }
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(copyPath + suffix, { force: true });

  // 1. Online backup from a read-only source handle. The source is never migrated or written.
  const src = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    await src.backup(copyPath);
  } finally {
    src.close();
  }
  // Make the copy a single self-contained file (no -wal/-shm), then open it read-only for everything below.
  const fix = new Database(copyPath);
  fix.pragma("journal_mode = DELETE");
  fix.close();
  const copy = new Database(copyPath, { readonly: true, fileMustExist: true });
  try {
    setQueryDb(copy); // any query module that runs now reads the copy, never the live DB
    fs.writeFileSync(path.join(opts.out, "schema.md"), schemaMd(copy));
    fs.writeFileSync(path.join(opts.out, "pack.md"), packMd(copy, opts.days, opts.db));
  } finally {
    resetQueryDb();
    copy.close();
  }

  const pkg = createRequire(import.meta.url).resolve("better-sqlite3");
  const tpl = (name: string): string => fs.readFileSync(path.join(HERE, name), "utf8");
  const lit = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  fs.writeFileSync(
    path.join(opts.out, "query.mjs"),
    tpl("query.mjs").replace("__AW_BETTER_SQLITE3__", () => lit(pkg)),
  );
  fs.writeFileSync(
    path.join(opts.out, "scan.mjs"),
    tpl("scan.mjs")
      .replace("__AW_JSONL_ROOT__", () => lit(opts.jsonlRoot))
      .replace("__AW_SETTINGS__", () => lit((opts.settingsFiles ?? []).join(","))),
  );
  fs.writeFileSync(path.join(opts.out, "render.mjs"), tpl("render.mjs"));
  fs.writeFileSync(
    path.join(opts.out, "prompt.md"),
    fs.readFileSync(promptSrc, "utf8").split("{{AUDIT_DIR}}").join(opts.out),
  );
  return {
    out: opts.out,
    command: `claude "Read ${path.join(opts.out, "prompt.md")} and follow it"`,
  };
}

/** CLI entry: returns the process exit code. */
export async function runAuditCli(argv: string[]): Promise<number> {
  try {
    const r = await generateAudit(parseAuditArgs(argv));
    console.log(`Audit folder: ${r.out}`);
    console.log(r.command);
    return 0;
  } catch (e) {
    console.error(`agentwrangler audit: ${(e as Error).message}`);
    return 1;
  }
}
