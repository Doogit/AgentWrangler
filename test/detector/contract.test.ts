/**
 * P2-U8 detector contract v2 (A-5): every registered detector declares version, scope and
 * input tables. The input check is independent of the declarations: it runs each detector on
 * the shared seed and collects every table its SQL (and its helpers' SQL) reads.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../../src/db/open.js";
import { buildContext, historyWeeks } from "../../src/detector/engine.js";
import { DETECTORS } from "../../src/detector/registry.js";

let scratchRoot: string;
let seedPath: string;

beforeAll(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-contract-v2-"));
  seedPath = path.join(scratchRoot, "shared-seed.sqlite");
  childProcess.execFileSync(
    process.execPath,
    ["--import", "tsx/esm", "scripts/build-shared-seed.ts", seedPath],
    { cwd: path.resolve(import.meta.dirname, "../.."), stdio: "pipe" },
  );
}, 120_000);

afterAll(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe("detector contract v2 metadata", () => {
  it("every registered detector declares a version, a scope and its input tables", () => {
    for (const detector of DETECTORS) {
      expect(detector.version, `${detector.id} version`).toMatch(new RegExp(`^${detector.id}@`));
      expect(["turn", "session", "cross-session"], `${detector.id} scope`).toContain(
        detector.scope,
      );
      expect(detector.inputs?.tables.length, `${detector.id} inputs`).toBeGreaterThan(0);
    }
  });

  it("declared input tables cover every table a detector reads on the shared seed", () => {
    const probe = openDb(seedPath);
    const tables = new Set(
      (
        probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    probe.close();

    const missing: string[] = [];
    for (const detector of DETECTORS) {
      // A fresh connection per detector: helpers cache statements per connection, and a
      // statement prepared for an earlier detector would hide this detector's read.
      const db = openDb(seedPath);
      const now = new Date();
      const contexts = [
        ...historyWeeks(db, now)
          .slice(1, 3)
          .map((w) => w.ctx),
        buildContext(now),
      ];
      const read = new Set<string>();
      const prepare = db.prepare.bind(db);
      (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
          const name = m[1] ?? "";
          if (tables.has(name)) read.add(name);
        }
        return prepare(sql);
      };
      try {
        for (const ctx of contexts) detector.evaluate(db, ctx);
      } finally {
        db.close();
      }
      const declared = new Set<string>(detector.inputs?.tables ?? []);
      for (const table of read) {
        if (!declared.has(table)) missing.push(`${detector.id} reads ${table}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("a detector calling a shared SQL helper declares every table that helper reads", () => {
    // The seed check above sees only statements prepared on paths the seed reaches; these
    // helpers prepare lazily (createResultCarry on the first owned result) or sit behind a
    // gate (the wasted-turn census), so on the seed they can hide a read.
    const HELPER_TABLES: Record<string, readonly string[]> = {
      // result-claims.ts: createOwnerLookup, createLaterTurnsResolver (compaction boundary), write mix.
      createResultCarry: ["turns", "pricing_snapshots", "ingest_metric_events"],
      resultClaimsForEvent: ["turns", "pricing_snapshots", "ingest_metric_events"],
      // turn-claim.ts wastedTurnCensus: event/turn joins, C9 denials and D14 user turns.
      wastedTurnClaims: [
        "turns",
        "sessions",
        "tool_events",
        "tool_event_metadata",
        "tool_event_content",
        "ingest_metric_events",
      ],
      wastedTurnCensus: [
        "turns",
        "sessions",
        "tool_events",
        "tool_event_metadata",
        "tool_event_content",
        "ingest_metric_events",
      ],
    };
    const missing: string[] = [];
    for (const detector of DETECTORS) {
      const src = fs.readFileSync(detectorModule(detector.id), "utf8");
      const declared = new Set<string>(detector.inputs?.tables ?? []);
      for (const [helper, tables] of Object.entries(HELPER_TABLES)) {
        if (!new RegExp(`\\b${helper}\\(`).test(src)) continue;
        for (const table of tables) {
          if (!declared.has(table)) missing.push(`${detector.id} -> ${helper} reads ${table}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

function detectorModule(id: string): string {
  const dir = path.resolve(import.meta.dirname, "../../src/detector/detectors");
  const match = fs
    .readdirSync(dir)
    .find((f) => f.startsWith(`${id.toLowerCase()}_`) && f.endsWith(".ts"));
  if (match === undefined) throw new Error(`no module for detector ${id}`);
  return path.join(dir, match);
}
