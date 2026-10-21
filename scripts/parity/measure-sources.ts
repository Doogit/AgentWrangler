/**
 * Operator-consented C1 measurement (decision A, 2026-09-24): counts the Claude tokens of each
 * always-loaded file-backed source in the inventory by a controlled pair — a fresh `claude -p`
 * first turn with the loaded content as the prompt vs one without, with A/A controls. The
 * content is what Claude Code already sends in that workspace's sessions. Orchestrator-only; the
 * daemon never calls this. Output holds content hashes and counts only — no paths or text.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadedBytes } from "./prefix-oracle.js";

const BASE_PROMPT = "reply ok";
const FLAGS = [
  "-p",
  "--output-format",
  "json",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--tools",
  '""',
];
const REPEATS = 2;

type Run = { prefix: number; models: string[] };

function runClaude(claude: string, cwd: string, input: string): Run {
  const result = JSON.parse(
    execFileSync(claude, FLAGS, {
      cwd,
      input,
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "ignore"],
    }),
  ) as {
    usage: {
      iterations?: {
        input_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      }[];
    };
    modelUsage?: Record<string, unknown>;
  };
  const iterations = result.usage.iterations ?? [];
  const first = iterations[0];
  if (iterations.length !== 1 || !first)
    throw new Error("Expected exactly one API request per run");
  return {
    prefix: first.input_tokens + first.cache_read_input_tokens + first.cache_creation_input_tokens,
    models: Object.keys(result.modelUsage ?? {}),
  };
}

export function main(argv: string[]): void {
  let dbPath = path.join(os.homedir(), ".agentwrangler", "db.sqlite");
  let output = path.join(os.homedir(), ".agentwrangler", "measured-token-counts.json");
  let claude = "claude";
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--db" && value) dbPath = value;
    else if (argv[i] === "--out" && value) output = value;
    else if (argv[i] === "--claude" && value) claude = value;
    else throw new Error("Usage: measure-sources.ts [--db <path>] [--out <json>] [--claude <bin>]");
    i++;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      "SELECT component, file_ref FROM context_inventory WHERE component IN ('CLAUDE_MD', 'MEMORY')",
    )
    .all() as { component: string; file_ref: string }[];
  db.close();
  const sources = new Map<string, { component: string; content: string }>();
  for (const row of rows) {
    let content: Buffer | null;
    try {
      content = loadedBytes(row);
    } catch {
      continue; // missing on disk: the oracle reports it as SKIP
    }
    if (!content || content.length === 0) continue;
    const sha1 = createHash("sha1").update(content).digest("hex");
    sources.set(sha1, { component: row.component, content: content.toString("utf8") });
  }

  const version = execFileSync(claude, ["--version"], { encoding: "utf8", shell: true })
    .trim()
    .match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error("Unable to read Claude Code version");
  const cwd = path.join(os.tmpdir(), `agentwrangler-measure-${randomUUID()}`);
  fs.mkdirSync(cwd, { recursive: true });
  const controls: number[] = [];
  const models = new Set<string>();
  const deltas: {
    mode: "M";
    component: string;
    contentSha1: string;
    bytes: number;
    bytes4Estimate: number;
    observed: number[];
  }[] = [];
  const control = () => {
    const run = runClaude(claude, cwd, BASE_PROMPT);
    for (const model of run.models) models.add(model);
    controls.push(run.prefix);
    return run.prefix;
  };
  try {
    let baseline = control();
    for (const [sha1, source] of sources) {
      const observed: number[] = [];
      for (let r = 0; r < REPEATS; r++) {
        const run = runClaude(claude, cwd, `${BASE_PROMPT}\n\n${source.content}`);
        for (const model of run.models) models.add(model);
        observed.push(run.prefix - baseline);
      }
      // Re-check the control after each source so drift shows up as A/A spread.
      baseline = control();
      const bytes = Buffer.byteLength(source.content);
      deltas.push({
        mode: "M",
        component: source.component,
        contentSha1: sha1,
        bytes,
        bytes4Estimate: Math.ceil(bytes / 4),
        observed,
      });
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  const result = {
    claudeVersion: version,
    models: [...models],
    measuredAt: new Date().toISOString(),
    control: { runs: controls.length, min: Math.min(...controls), max: Math.max(...controls) },
    deltas,
  };
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `measured ${deltas.length} sources · ${version} ${[...models].join(",")} · control spread ${result.control.max - result.control.min} · ${output}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
