import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const baselinePrompt = "reply ok";
const subagentPrompt =
  'Spawn exactly one general-purpose, non-fork subagent with the Task/Agent tool. Tell it to reply "ok". Then reply "ok".';
const sentinelLines = Array.from(
  { length: 300 },
  (_, index) =>
    `Canary memory sentinel line ${String(index + 1).padStart(3, "0")}: ABCDEFGHIJKLMNOPQRSTUVWXYZ\n`,
);

function parseArgs(args) {
  let dryRun = false;
  let output;
  // Explicit binary: on Windows a non-shell spawn of "claude" can resolve a different
  // (stale) claude.exe than the one on the interactive PATH.
  let claude = "claude";
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--dry-run") {
      dryRun = true;
    } else if (args[index] === "--out" && args[index + 1]) {
      output = args[++index];
    } else if (args[index] === "--claude" && args[index + 1]) {
      claude = args[++index];
    } else {
      throw new Error(`Unknown or incomplete argument: ${args[index]}`);
    }
  }
  return { dryRun, output, claude };
}

function projectFiles(projectsDir) {
  if (!fs.existsSync(projectsDir)) return [];
  return fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(projectsDir, entry.name));
}

function newSession(projectsDir, before, startedAt) {
  const candidates = projectFiles(projectsDir)
    .filter((file) => !before.has(file) && fs.statSync(file).mtimeMs >= startedAt)
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  if (candidates.length === 0) throw new Error("Claude did not create a new session JSONL file");
  return candidates[0];
}

function records(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function usageFrom(record) {
  const message = record.message;
  if (record.type !== "assistant" || !message || !message.usage) return null;
  const usage = message.usage;
  const inputTokens = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  if (![inputTokens, cacheRead, cacheCreation].every(Number.isFinite)) return null;
  return {
    prefix: inputTokens + cacheRead + cacheCreation,
    usage,
  };
}

function firstMainTurn(sessionFile) {
  for (const record of records(sessionFile)) {
    if (record.isSidechain || record.agentId) continue;
    const result = usageFrom(record);
    if (result) return result;
  }
  throw new Error("No first assistant turn with usage in session JSONL");
}

function firstSubagentTurn(sessionFile) {
  const sessionRecords = records(sessionFile);
  for (const record of sessionRecords) {
    if (!record.isSidechain && !record.agentId) continue;
    const result = usageFrom(record);
    if (result) return { ...result, sourceFile: sessionFile };
  }

  const subagentsDir = path.join(
    path.dirname(sessionFile),
    path.parse(sessionFile).name,
    "subagents",
  );
  if (!fs.existsSync(subagentsDir)) return null;
  const files = fs
    .readdirSync(subagentsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(subagentsDir, name))
    .sort((left, right) => fs.statSync(left).birthtimeMs - fs.statSync(right).birthtimeMs);
  for (const file of files) {
    for (const record of records(file)) {
      const result = usageFrom(record);
      if (result) return { ...result, sourceFile: file };
    }
  }
  return null;
}

function runClaude(claude, prompt, projectDir, projectsDir) {
  const before = new Set(projectFiles(projectsDir));
  const startedAt = Date.now();
  try {
    execFileSync(claude, ["-p", prompt], { cwd: projectDir, stdio: "pipe" });
  } catch {
    throw new Error("Claude command failed; no transcript output was retained");
  }
  const sessionFile = newSession(projectsDir, before, startedAt);
  return { sessionFile, ...firstMainTurn(sessionFile) };
}

function main() {
  const { dryRun, output, claude } = parseArgs(process.argv.slice(2));
  const version = dryRun
    ? "dry-run-version"
    : execFileSync(claude, ["--version"], { encoding: "utf8" })
        .trim()
        .match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error("Unable to read Claude Code version");

  const projectDir = path.join(os.tmpdir(), `agentwrangler-canary-${randomUUID()}`);
  const slug = path.resolve(projectDir).replace(/[^a-zA-Z0-9]/g, "-");
  const projectsDir = path.join(os.homedir(), ".claude", "projects", slug);
  const memoryDir = path.join(projectsDir, "memory");
  const memoryFile = path.join(memoryDir, "MEMORY.md");
  const outputFile = path.resolve(
    output ?? path.join(".claude", "audits", "certification", `canary-${version}.json`),
  );

  if (dryRun) {
    console.log(`Project: ${projectDir}`);
    console.log(`Sessions: ${projectsDir}`);
    console.log(`Memory: ${memoryFile}`);
    console.log(`Output: ${outputFile}`);
    console.log("Version: claude --version (skipped in dry-run)");
    console.log(`Binary: ${claude}`);
    console.log(`Run 1: ${claude} -p ${JSON.stringify(baselinePrompt)}`);
    console.log(`Run 2: ${claude} -p ${JSON.stringify(subagentPrompt)} (no MEMORY.md)`);
    console.log(`Run 3: write 300 sentinel lines; ${claude} -p ${JSON.stringify(baselinePrompt)}`);
    console.log(`Run 4: ${claude} -p ${JSON.stringify(subagentPrompt)} (with MEMORY.md)`);
    return;
  }

  // Bytes / 4 is useful for comparing file sizes, but it is not a Claude token
  // count. In particular, it cannot establish the expected prefix delta.
  const bytes4EstimateWithCap = Math.ceil(
    Buffer.byteLength(sentinelLines.slice(0, 200).join("")) / 4,
  );
  const bytes4EstimateWithoutCap = Math.ceil(Buffer.byteLength(sentinelLines.join("")) / 4);
  fs.mkdirSync(projectDir, { recursive: true });
  try {
    const baseline = runClaude(claude, baselinePrompt, projectDir, projectsDir);
    // A subagent has its own system prompt and tools, so its memory delta is measured
    // against a subagent run without the sentinel, never against the main baseline.
    const subagentBaseRun = runClaude(claude, subagentPrompt, projectDir, projectsDir);
    const subagentBase = firstSubagentTurn(subagentBaseRun.sessionFile);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFile, sentinelLines.join(""), "ascii");
    const memory = runClaude(claude, baselinePrompt, projectDir, projectsDir);
    const subagentRun = runClaude(claude, subagentPrompt, projectDir, projectsDir);
    const subagentTurn = firstSubagentTurn(subagentRun.sessionFile);
    const subagentDelta =
      subagentTurn && subagentBase ? subagentTurn.prefix - subagentBase.prefix : null;
    // Session paths are recorded relative to the canary's projects dir and the binary by
    // basename: the committed JSON must carry no username (the slug embeds it).
    const home = (value) => {
      if (!value || !path.isAbsolute(value)) return value;
      return value.startsWith(projectsDir)
        ? path.relative(projectsDir, value).replaceAll("\\", "/")
        : path.basename(value);
    };
    const result = {
      claudeVersion: version,
      claudeBinary: home(claude),
      measuredAt: new Date().toISOString(),
      baselinePrefix: baseline.prefix,
      memoryDelta: memory.prefix - baseline.prefix,
      expectedDelta: null,
      expectedDeltaBasis: "UNMEASURED_MODEL_SPECIFIC_COUNT",
      bytes4EstimateWithCap,
      bytes4EstimateWithoutCap,
      subagent: {
        // A single differential does not establish source-only token count or
        // rule out another prefix change. Keep the raw observation for review.
        subagentCarriesMemory: null,
        prefixWithoutMemory: subagentBase?.prefix ?? null,
        prefixWithMemory: subagentTurn?.prefix ?? null,
        memoryDelta: subagentDelta,
        sourceFiles: [home(subagentBase?.sourceFile) ?? null, home(subagentTurn?.sourceFile) ?? null],
      },
      runs: [baseline, subagentBaseRun, memory, subagentRun].map(
        ({ sessionFile, prefix, usage }) => ({
          sessionFile: home(sessionFile),
          prefix,
          usage,
        }),
      ),
    };
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
