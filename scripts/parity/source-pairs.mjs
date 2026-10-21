// Controlled synthetic source pairs: measures what a loaded source adds to the
// first-turn prefix, with an A/A control. Synthetic content only; the output
// holds structural counts and content hashes, never file or transcript text.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const basePrompt = "reply ok";
const sentinel = (n) =>
  Array.from(
    { length: n },
    (_, index) =>
      `Canary memory sentinel line ${String(index + 1).padStart(3, "0")}: ABCDEFGHIJKLMNOPQRSTUVWXYZ\n`,
  ).join("");
const words =
  "the build should run tests before merging and report each failure with the command output so reviewers can check the change quickly".split(
    " ",
  );
const prose = (n) =>
  Array.from({ length: n }, (_, index) => {
    if (index % 10 === 0) return `## Section ${index / 10 + 1}\n`;
    const line = Array.from({ length: 9 }, (_, k) => words[(index * 7 + k * 3) % words.length]);
    return `- ${line[0][0].toUpperCase()}${line[0].slice(1)} ${line.slice(1).join(" ")}.\n`;
  }).join("");
const shapes = {
  SENT100: sentinel(100),
  SENT200: sentinel(200),
  SENT300: sentinel(300),
  PROSE100: prose(100),
  PROSE200: prose(200),
};
// Interleaved: A = no source, M = content as the prompt message (content-only
// tokens), C = project CLAUDE.md, MEM = auto-memory MEMORY.md.
const plan = [
  ["A"],
  ["M", "SENT100"],
  ["C", "SENT100"],
  ["A"],
  ["M", "SENT200"],
  ["C", "SENT200"],
  ["M", "PROSE100"],
  ["C", "PROSE100"],
  ["A"],
  ["M", "PROSE200"],
  ["C", "PROSE200"],
  ["MEM", "SENT200"],
  ["MEM", "SENT300"],
  ["A"],
  ["MEM", "PROSE200"],
  ["C", "SENT200"],
  ["C", "PROSE200"],
  ["A"],
];

function parseArgs(args) {
  let dryRun = false;
  let output;
  let claude = "claude";
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--dry-run") dryRun = true;
    else if (args[index] === "--out" && args[index + 1]) output = args[++index];
    else if (args[index] === "--claude" && args[index + 1]) claude = args[++index];
    else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  return { dryRun, output, claude };
}

const sha1 = (value) => createHash("sha1").update(value).digest("hex");
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function main() {
  const { dryRun, output, claude } = parseArgs(process.argv.slice(2));
  const projectDir = path.join(os.tmpdir(), `agentwrangler-pairs-${randomUUID()}`);
  const slug = path.resolve(projectDir).replace(/[^a-zA-Z0-9]/g, "-");
  const memoryDir = path.join(os.homedir(), ".claude", "projects", slug, "memory");
  const claudeMd = path.join(projectDir, "CLAUDE.md");
  // No session persistence: nothing is written under ~/.claude/projects except
  // the temporary MEMORY.md, and no transcript is ingested by the daemon.
  const flags = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
  if (dryRun) {
    console.log(`Project: ${projectDir}`);
    console.log(`Memory: ${memoryDir}`);
    for (const [mode, shape] of plan)
      console.log(`${mode} ${shape ?? "-"}: ${claude} ${flags.join(" ")}`);
    return;
  }
  const version = execFileSync(claude, ["--version"], { encoding: "utf8", shell: true })
    .trim()
    .match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error("Unable to read Claude Code version");

  function run(mode, shape) {
    fs.rmSync(claudeMd, { force: true });
    fs.rmSync(memoryDir, { recursive: true, force: true });
    const content = shape ? shapes[shape] : "";
    if (mode === "C") fs.writeFileSync(claudeMd, content, "ascii");
    if (mode === "MEM") {
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), content, "ascii");
    }
    const input = mode === "M" ? `${basePrompt}\n\n${content}` : basePrompt;
    const result = JSON.parse(
      execFileSync(claude, flags, {
        cwd: projectDir,
        input,
        encoding: "utf8",
        shell: true,
        stdio: ["pipe", "pipe", "ignore"],
      }),
    );
    const usage = result.usage;
    if (usage.iterations?.length !== 1) throw new Error("Expected exactly one API request per run");
    return {
      mode,
      shape: shape ?? null,
      contentSha1: shape ? sha1(content) : null,
      bytes: Buffer.byteLength(content),
      lines: shape ? content.split("\n").length - 1 : 0,
      models: Object.keys(result.modelUsage ?? {}),
      prefix:
        usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
    };
  }

  fs.mkdirSync(projectDir, { recursive: true });
  const runs = [];
  try {
    for (const [mode, shape] of plan) runs.push(run(mode, shape));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(memoryDir), { recursive: true, force: true });
  }

  const controls = runs.filter((r) => r.mode === "A").map((r) => r.prefix);
  const baseline = median(controls);
  const deltas = {};
  for (const r of runs.filter((r) => r.mode !== "A")) {
    const id = `${r.mode}:${r.shape}`;
    deltas[id] ??= {
      mode: r.mode,
      shape: r.shape,
      bytes: r.bytes,
      lines: r.lines,
      contentSha1: r.contentSha1,
      observed: [],
    };
    deltas[id].observed.push(r.prefix - baseline);
  }
  for (const entry of Object.values(deltas)) {
    entry.bytes4Estimate = Math.ceil(entry.bytes / 4);
    entry.bytesPerToken =
      entry.mode === "M" ? Number((entry.bytes / median(entry.observed)).toFixed(3)) : null;
  }
  const result = {
    claudeVersion: version,
    models: [...new Set(runs.flatMap((r) => r.models))],
    measuredAt: new Date().toISOString(),
    control: { runs: controls.length, min: Math.min(...controls), max: Math.max(...controls) },
    baselinePrefix: baseline,
    deltas: Object.values(deltas),
    runs: runs.map(({ mode, shape, prefix }) => ({ mode, shape, prefix })),
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, text);
  }
  console.log(text);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
