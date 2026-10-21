import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import {
  checkPrefix as oracleCheckPrefix,
  readBaselineEvidence,
  readMeasured,
  runCli,
} from "./prefix-oracle.js";

const hash = (value: string) => createHash("sha1").update(value).digest("hex");
let source: string;
const controlledPair = (before = "before", after = "after") => ({
  source,
  changedAt: "2026-09-15T00:00:00.000Z",
  before,
  after,
});
const workspace = "workspace-B";
let dir: string;
let db: Database.Database;
let dbPath: string;
let file: string;

// Existing synthetic fixtures explicitly belong to one synthetic version/tool cohort.
function checkPrefix(
  database: Database.Database,
  baseline: number,
  sourceId?: string,
  since?: string,
  minPairs?: number,
  pair?: Parameters<typeof oracleCheckPrefix>[5],
  measured?: Parameters<typeof oracleCheckPrefix>[6],
) {
  const synthetic = new Map<
    string,
    { claudeVersion: string; toolConfig: string; baseline: number }
  >();
  for (const row of database.prepare("SELECT session_id FROM sessions").all() as {
    session_id: string;
  }[])
    synthetic.set(row.session_id, {
      claudeVersion: "synthetic",
      toolConfig: "synthetic-default",
      baseline,
    });
  return oracleCheckPrefix(database, synthetic, sourceId, since, minPairs, pair, measured);
}

function writeSyntheticEvidence(baseline: number): string {
  const evidenceFile = path.join(dir, "cohorts.json");
  const sessions = (
    db.prepare("SELECT session_id FROM sessions").all() as { session_id: string }[]
  ).map((row) => row.session_id);
  fs.writeFileSync(
    evidenceFile,
    JSON.stringify({
      cohorts: [
        { claudeVersion: "synthetic", toolConfig: "synthetic-default", baseline, sessions },
      ],
    }),
  );
  return evidenceFile;
}

function addVersion(
  content: string,
  tokens: number,
  at: string,
  component = "CLAUDE_MD",
  ref = file,
) {
  db.prepare(`INSERT INTO context_inventory_history
    (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
    VALUES (?, ?, ?, ?, ?, 'chars4-v1', ?)`).run(
    workspace,
    component,
    ref,
    hash(content),
    tokens,
    at,
  );
  db.prepare(`INSERT INTO context_inventory
    (probe_id, workspace_id, component, file_ref, file_hash, tokens, attribution_version, probed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'chars4-v1', ?)
    ON CONFLICT(probe_id) DO UPDATE SET file_hash=excluded.file_hash, tokens=excluded.tokens, probed_at=excluded.probed_at`).run(
    source,
    workspace,
    component,
    ref,
    hash(content),
    tokens,
    at,
  );
}

function turn(
  id: string,
  ts: string,
  prefix: number,
  boundary = 0,
  sidechain = 0,
  session = id,
  input = 0,
) {
  if (session === id) {
    db.prepare(`INSERT INTO sessions (session_id, workspace_id, file_path, state)
      VALUES (?, ?, ?, 'RECONCILED')`).run(session, workspace, path.join(dir, `${session}.jsonl`));
  }
  db.prepare(`INSERT INTO turns (message_id, session_id, ts, is_sidechain, is_compaction_boundary,
    workspace_id, model, parser_version, input_tokens, cache_read_tokens, cache_write_5m,
    cache_write_1h, cache_write_other)
    VALUES (?, ?, ?, ?, ?, ?, 'synthetic-model', 'test-v1', ?, ?, 0, 0, 0)`).run(
    id,
    session,
    ts,
    sidechain,
    boundary,
    workspace,
    input,
    prefix - input,
  );
}

function boundaryEvent(session: string, ts: string) {
  db.prepare(`INSERT INTO ingest_metric_events (event_id, session_id, is_user_turn,
    is_compact_summary, is_api_error, is_interrupt, event_ts, boundary_kind)
    VALUES (?, ?, 0, 1, 0, 0, ?, 'legacy-summary')`).run(`${session}-boundary`, session, ts);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prefix-oracle-"));
  file = path.join(dir, "CLAUDE.md");
  source = `probe-${createHash("sha1").update(`${workspace}|CLAUDE_MD|${file}`).digest("hex").slice(0, 16)}`;
  dbPath = path.join(dir, "probe.sqlite");
  db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  runMigrations(db, "033_compaction_positions");
  db.prepare(`INSERT INTO workspaces (workspace_id, project_slug, registered_at)
    VALUES (?, ?, ?)`).run(workspace, workspace, "2026-09-01T00:00:00.000Z");
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("independent prefix oracle", () => {
  it("uses the strict-MCP cohort baseline only for evidenced sessions", () => {
    const content = "a".repeat(400);
    fs.writeFileSync(file, content);
    addVersion(content, 100, "2026-09-10T00:00:00.000Z");
    turn("strict", "2026-09-11T00:00:00.000Z", 35_682);
    turn("unknown", "2026-09-11T01:00:00.000Z", 35_682);
    const evidence = new Map([
      ["strict", { claudeVersion: "2.1.280", toolConfig: "strict-mcp", baseline: 35_582 }],
    ]);
    const report = oracleCheckPrefix(db, evidence);
    expect(report.findings.filter((finding) => finding.check === "d")).toEqual([]);
    expect(report.checked).toMatchObject({ sessions: 2, dProven: 1, dUnproven: 1 });
    expect(report.skips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "d",
          session: "unknown",
          detail: expect.stringContaining("UNPROVEN"),
        }),
      ]),
    );
  });

  it("returns UNPROVEN when a first-turn session has no cohort evidence", () => {
    const content = "a".repeat(400);
    fs.writeFileSync(file, content);
    addVersion(content, 100, "2026-09-10T00:00:00.000Z");
    turn("unknown", "2026-09-11T00:00:00.000Z", 35_682);
    const measuredFile = path.join(dir, "measured.json");
    fs.writeFileSync(
      measuredFile,
      JSON.stringify({
        claudeVersion: "synthetic",
        models: ["synthetic-model"],
        deltas: [{ mode: "M", contentSha1: hash(content), observed: [100, 100] }],
      }),
    );
    expect(runCli(["--db", dbPath, "--measured", measuredFile])).toBe(3);
  });

  it("rejects duplicate session assignments across tool configurations", () => {
    const evidenceFile = path.join(dir, "duplicate.json");
    fs.writeFileSync(
      evidenceFile,
      JSON.stringify({
        cohorts: [
          { claudeVersion: "2.1.280", toolConfig: "default", baseline: 37_766, sessions: ["same"] },
          {
            claudeVersion: "2.1.280",
            toolConfig: "strict-mcp",
            baseline: 35_582,
            sessions: ["same"],
          },
        ],
      }),
    );
    expect(() => readBaselineEvidence(evidenceFile)).toThrow("duplicate session");
  });
  it("skips (does not fail or pass) the baseline bound without fresh sessions", () => {
    const content = "a".repeat(400);
    fs.writeFileSync(file, content);
    addVersion(content, 100, "2026-09-10T00:00:00.000Z");
    const report = checkPrefix(db, 0);
    expect(report.findings).toEqual([]);
    expect(report.skips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "d", detail: expect.stringContaining("no fresh") }),
      ]),
    );
  });

  it("skips a source whose file is missing on disk", () => {
    addVersion("gone", 100, "2026-09-10T00:00:00.000Z");
    const report = checkPrefix(db, 0);
    expect(report.findings.filter((f) => f.check === "b")).toEqual([]);
    expect(report.skips).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "b", detail: "SKIP (missing)" })]),
    );
  });

  it("still compares tokens when the file changed since the probe", () => {
    fs.writeFileSync(file, "a".repeat(400));
    addVersion("older content", 3000, "2026-09-10T00:00:00.000Z");
    expect(checkPrefix(db, 0).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "b" })]),
    );
  });

  it("counts input_tokens in the first-turn prefix", () => {
    const content = "a".repeat(400);
    fs.writeFileSync(file, content);
    addVersion(content, 100, "2026-09-10T00:00:00.000Z");
    // 1,100 prefix = 600 input + 500 cache read: passes (d) only if input counts.
    turn("input-heavy", "2026-09-11T00:00:00.000Z", 1100, 0, 0, "input-heavy", 600);
    expect(checkPrefix(db, 1000).findings).toEqual([]);
  });

  it("--since drops changes and sessions before the cutoff", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("before", "2026-09-14T00:00:00.000Z", 3100);
    turn("after", "2026-09-16T00:00:00.000Z", 3100);
    expect(checkPrefix(db, 1000, source, undefined, 1, controlledPair()).ok).toBe(false);
    const report = checkPrefix(db, 1000, undefined, "2026-09-15T12:00:00.000Z");
    expect(report).toMatchObject({ ok: true, checked: { changes: 0, sessions: 1 } });
  });

  it("uses pre-cutoff first turns for a selected change's differential check", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("before", "2026-09-14T00:00:00.000Z", 1100);
    turn("after", "2026-09-16T00:00:00.000Z", 1100);
    const report = checkPrefix(db, 0, source, "2026-09-15T00:00:00.000Z", 1, controlledPair());
    expect(report.checked).toMatchObject({ changes: 1, differentials: 1, sessions: 1 });
    expect(report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "c" })]),
    );
    expect(report.skips.filter((finding) => finding.check === "c")).toEqual([]);
  });

  it("fails a required differential gate when every selected change is skipped", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("after", "2026-09-16T00:00:00.000Z", 3100);
    const report = checkPrefix(db, 1000, undefined, undefined, 1);
    expect(report.checked).toMatchObject({ changes: 1, differentials: 0 });
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "c", detail: expect.stringContaining("0 checked") }),
      ]),
    );
    expect(
      runCli(["--db", dbPath, "--d-evidence", writeSyntheticEvidence(1000), "--min-c-pairs", "1"]),
    ).toBe(1);
  });

  it("does not infer a source failure from unrelated before and after sessions", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("before", "2026-09-14T00:00:00.000Z", 1100);
    turn("after", "2026-09-16T00:00:00.000Z", 90_000);
    const report = checkPrefix(db, 0, source, undefined, 1);
    expect(report.checked.differentials).toBe(0);
    expect(report.findings).toEqual([
      expect.objectContaining({ check: "c", detail: expect.stringContaining("coverage") }),
    ]);
    expect(report.skips).toEqual(expect.arrayContaining([expect.objectContaining({ check: "c" })]));
  });

  it("fails closed when a requested pair names no selected change", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("before", "2026-09-14T00:00:00.000Z", 1100);
    turn("after", "2026-09-16T00:00:00.000Z", 3100);
    const pair = { ...controlledPair(), changedAt: "2026-09-15T01:00:00.000Z" };
    const report = checkPrefix(db, 0, source, undefined, 1, pair);
    expect(report.checked.differentials).toBe(0);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "c", detail: expect.stringContaining("does not match") }),
      ]),
    );
  });

  it("rejects a source claimed at 30 times its on-disk size", () => {
    const content = "a".repeat(400);
    fs.writeFileSync(file, content);
    addVersion(content, 3000, "2026-09-10T00:00:00.000Z");
    const report = checkPrefix(db, 0);
    expect(report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "b" })]),
    );
    expect(report.ok).toBe(false);
  });

  it("counts only the first 200 lines of a MEMORY.md source", () => {
    const lines = Array.from({ length: 251 }, (_, index) => String(index).padStart(8, "0"));
    const content = lines.join("\n");
    const loaded = lines.slice(0, 200).join("\n");
    fs.writeFileSync(path.join(dir, "MEMORY.md"), content);
    addVersion(
      loaded,
      Math.ceil(Buffer.byteLength(content) / 4),
      "2026-09-10T00:00:00.000Z",
      "MEMORY",
      dir,
    );
    turn("memory-session", "2026-09-11T00:00:00.000Z", 2000);
    expect(checkPrefix(db, 0).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "b", source })]),
    );

    db.prepare("UPDATE context_inventory SET tokens = ? WHERE probe_id = ?").run(
      Math.ceil(Buffer.byteLength(loaded) / 4),
      source,
    );
    db.prepare("UPDATE context_inventory_history SET tokens = ? WHERE component = 'MEMORY'").run(
      Math.ceil(Buffer.byteLength(loaded) / 4),
    );
    expect(checkPrefix(db, 0)).toMatchObject({ ok: true, findings: [] });
  });

  it("accepts a 2,000-token file and first-turn shift", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("before", "2026-09-14T00:00:00.000Z", 1100);
    turn("after", "2026-09-16T00:00:00.000Z", 3100);
    expect(checkPrefix(db, 1000, source, undefined, 1, controlledPair()).findings).toEqual([]);
  });

  it("rejects a hash change with no first-turn shift", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("before", "2026-09-14T00:00:00.000Z", 3100);
    turn("after", "2026-09-16T00:00:00.000Z", 3100);
    expect(checkPrefix(db, 1000, source, undefined, 1, controlledPair()).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "c" })]),
    );
  });

  it("rejects a controlled pair when only a resumed session sits on one side", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("before", "2026-09-14T00:00:00.000Z", 1100);
    turn("resumed", "2026-09-16T00:00:00.000Z", 3100, 1);
    const report = checkPrefix(db, 1000, source, undefined, 1, controlledPair("before", "resumed"));
    expect(report.checked.sessions).toBe(1);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "c",
          detail: expect.stringContaining("invalid controlled pair"),
        }),
      ]),
    );
  });

  it("a huge-prefix resumed session in the after window does not change (c) or (d)", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("before", "2026-09-14T00:00:00.000Z", 1100);
    turn("after", "2026-09-16T00:00:00.000Z", 3100);
    const clean = checkPrefix(db, 1000, source, undefined, 1, controlledPair());
    expect(clean.findings).toEqual([]);
    // Compacted first turn, and a first turn preceded by a boundary event: both excluded.
    turn("compacted", "2026-09-16T01:00:00.000Z", 90_000, 1);
    turn("continued", "2026-09-16T02:00:00.000Z", 90_000);
    boundaryEvent("continued", "2026-09-16T01:59:00.000Z");
    // Also a tiny-prefix continuation that would otherwise violate (d).
    turn("tiny-continued", "2026-09-16T03:00:00.000Z", 10);
    boundaryEvent("tiny-continued", "2026-09-16T02:59:00.000Z");
    const withResumed = checkPrefix(db, 1000, source, undefined, 1, controlledPair());
    expect(withResumed.findings).toEqual([]);
    expect(withResumed.checked.sessions).toBe(2);
  });

  it("excludes a session whose first turn is a sidechain turn", () => {
    turn("sidechain-first", "2026-09-14T00:00:00.000Z", 1100, 0, 1);
    turn("main-second", "2026-09-14T00:01:00.000Z", 1100, 0, 0, "sidechain-first");
    const report = checkPrefix(db, 1000);
    expect(report.checked.sessions).toBe(0);
    expect(report.skips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "d", detail: expect.stringContaining("no fresh") }),
      ]),
    );
  });

  it("checks the baseline bound using the version at session start", () => {
    const old = "a".repeat(400);
    const next = "b".repeat(8400);
    fs.writeFileSync(file, next);
    addVersion(old, 100, "2026-09-10T00:00:00.000Z");
    addVersion(next, 2100, "2026-09-15T00:00:00.000Z");
    turn("before", "2026-09-14T00:00:00.000Z", 1099);
    turn("after", "2026-09-16T00:00:00.000Z", 3099);
    const report = checkPrefix(db, 1000);
    expect(report.findings.filter((f) => f.check === "d")).toHaveLength(2);
  });

  it("returns exit 1 from the read-only CLI on failure", () => {
    const content = "a".repeat(400);
    fs.writeFileSync(file, content);
    addVersion(content, 3000, "2026-09-10T00:00:00.000Z");
    expect(runCli(["--db", dbPath, "--source", source])).toBe(1);
  });

  it("returns exit 3, not 0, when bytes/4 agrees but no token count was measured", () => {
    const content = "a".repeat(400);
    fs.writeFileSync(file, content);
    addVersion(content, 100, "2026-09-10T00:00:00.000Z");
    turn("valid", "2026-09-11T00:00:00.000Z", 1100);
    const report = checkPrefix(db, 1000);
    expect(report).toMatchObject({ ok: true, checked: { measured: 0, unproven: 1 } });
    expect(report.skips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "b", detail: expect.stringContaining("UNPROVEN") }),
      ]),
    );
    expect(
      runCli(["--db", dbPath, "--d-evidence", writeSyntheticEvidence(1000), "--source", source]),
    ).toBe(3);
  });

  it("returns exit 0 from the read-only CLI when the claim matches a measured count", () => {
    const content = "a".repeat(400);
    fs.writeFileSync(file, content);
    addVersion(content, 100, "2026-09-10T00:00:00.000Z");
    turn("valid", "2026-09-11T00:00:00.000Z", 1100);
    const measuredFile = path.join(dir, "measured.json");
    fs.writeFileSync(
      measuredFile,
      JSON.stringify({
        claudeVersion: "synthetic",
        models: ["synthetic-model"],
        deltas: [{ mode: "M", contentSha1: hash(content), observed: [100, 100] }],
      }),
    );
    expect(
      runCli([
        "--db",
        dbPath,
        "--d-evidence",
        writeSyntheticEvidence(1000),
        "--source",
        source,
        "--measured",
        measuredFile,
      ]),
    ).toBe(0);
  });
});

// Independent oracle: counts measured by Claude Code 2.1.280 / claude-opus-5-5 on
// synthetic content (scripts/parity/source-pairs.mjs), not written by this test.
const evidenceFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.claude/audits/certification/p1f/source-pairs-2.1.280.json",
);
const sentinel = (n: number) =>
  Array.from(
    { length: n },
    (_, index) =>
      `Canary memory sentinel line ${String(index + 1).padStart(3, "0")}: ABCDEFGHIJKLMNOPQRSTUVWXYZ\n`,
  ).join("");
const words =
  "the build should run tests before merging and report each failure with the command output so reviewers can check the change quickly".split(
    " ",
  );
const prose = (n: number) =>
  Array.from({ length: n }, (_, index) => {
    if (index % 10 === 0) return `## Section ${index / 10 + 1}\n`;
    const line = Array.from(
      { length: 9 },
      (_, k) => words[(index * 7 + k * 3) % words.length] as string,
    );
    const first = line[0] as string;
    return `- ${first[0]?.toUpperCase()}${first.slice(1)} ${line.slice(1).join(" ")}.\n`;
  }).join("");

describe("C1(b) against measured Claude token counts", () => {
  it.each([
    ["sentinel", sentinel(200)],
    ["prose", prose(200)],
  ])("fails a chars4-v1 claim for measured %s content", (_, content) => {
    const measured = readMeasured(evidenceFile);
    const tokens = measured.counts.get(hash(content));
    expect(tokens).toBeDefined();
    fs.writeFileSync(file, content);
    addVersion(content, Math.ceil(Buffer.byteLength(content) / 4), "2026-09-10T00:00:00.000Z");
    const report = checkPrefix(db, 0, source, undefined, 0, undefined, measured);
    expect(report.checked).toMatchObject({ measured: 1, unproven: 0 });
    expect(report.findings).toEqual([
      expect.objectContaining({
        check: "b",
        detail: expect.stringContaining(`measured ${tokens}`),
      }),
    ]);
  });

  it("passes (b) when the claim equals the measured count", () => {
    const content = prose(200);
    const measured = readMeasured(evidenceFile);
    fs.writeFileSync(file, content);
    addVersion(content, measured.counts.get(hash(content)) as number, "2026-09-10T00:00:00.000Z");
    const report = checkPrefix(db, 0, source, undefined, 0, undefined, measured);
    // A measured count supersedes the bytes/4 fallback, so a claim that is not bytes/4 passes.
    expect(report.findings).toEqual([]);
    expect(report.checked).toMatchObject({ measured: 1, unproven: 0 });
  });

  it("rejects measured evidence whose repeated runs disagree", () => {
    const measuredFile = path.join(dir, "unstable.json");
    fs.writeFileSync(
      measuredFile,
      JSON.stringify({
        claudeVersion: "synthetic",
        models: ["synthetic-model"],
        deltas: [{ mode: "M", contentSha1: "x", observed: [100, 101] }],
      }),
    );
    expect(() => readMeasured(measuredFile)).toThrow("unstable");
  });
});
