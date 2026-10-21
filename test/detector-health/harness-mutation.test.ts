/**
 * Harness mutation: stub detectors substituted for the real one must make runCase report FAIL
 * when the stub contradicts the expectation, and PASS when it agrees.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Detector, Fired } from "../../src/detector/types.js";
import { assistant, userToolResult, writeCorpus } from "../ingest/synth.js";
import { runCase } from "./harness.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");

const neverFires: Detector = {
  contractVersion: 1,
  id: "STUB_NEVER",
  name: "STUB_NEVER",
  evaluate: () => ({ fired: [], status: "INACTIVE", note: "stub never fires" }),
};

const alwaysFires: Detector = {
  contractVersion: 1,
  id: "STUB_ALWAYS",
  name: "STUB_ALWAYS",
  evaluate: () => ({
    fired: [
      {
        scopeKey: "stub",
        scope_workspace_id: null,
        modeled_savings_u_per_wk: null,
      } as unknown as Fired,
    ],
    status: "ACTIVE",
    note: "stub always fires",
  }),
};

let tmp: string;
let fixtureDir: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-dh-mut-"));
  writeCorpus(tmp, {
    "mut-slug": {
      "session.jsonl": [
        assistant({
          id: "mut-1",
          session: "mut-session",
          ts: "2027-01-02T00:00:00.000Z",
          input: 100,
        }),
        assistant({
          id: "mut-2",
          session: "mut-session",
          ts: "2027-01-02T00:00:30.000Z",
          input: 100,
        }),
      ],
    },
  });
  fixtureDir = path.join(tmp, "mut-slug");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("harness mutation", () => {
  it("never-fires stub + expect fires => FAIL", () => {
    expect(runCase(neverFires, fixtureDir, "fires", NOW).pass).toBe(false);
  });
  it("always-fires stub + expect silent => FAIL", () => {
    expect(runCase(alwaysFires, fixtureDir, "silent", NOW).pass).toBe(false);
  });
  it("never-fires stub + expect silent => PASS", () => {
    expect(runCase(neverFires, fixtureDir, "silent", NOW).pass).toBe(true);
  });
  it("always-fires stub + expect fires => PASS", () => {
    const r = runCase(alwaysFires, fixtureDir, "fires", NOW);
    expect(r.pass).toBe(true);
    expect(r.firedCount).toBe(1);
  });
});

describe("harness rows (table-class)", () => {
  // Stub reports the inserted limit_snapshots rows through its note.
  const readsSnapshots: Detector = {
    ...neverFires,
    evaluate: (db) => ({
      fired: [],
      status: "INACTIVE",
      note: JSON.stringify(
        db.prepare("SELECT ts, resets_at, used_pct FROM limit_snapshots ORDER BY ts").all(),
      ),
    }),
  };

  function rowsFile(name: string): string {
    const file = path.join(tmp, name);
    fs.writeFileSync(
      file,
      JSON.stringify({
        limit_snapshots: [
          { ts: "2026-03-01T00:00:00.000Z", resets_at: "2026-03-05T00:00:00.000Z", used_pct: 40 },
          { ts: "2026-03-02T00:00:00.000Z", resets_at: "2026-03-05T00:00:00.000Z", used_pct: 60 },
        ],
      }),
    );
    return file;
  }

  it("rows-only case: newest observation lands at NOW − 1 day; resets_at keeps its offset", () => {
    const r = runCase(readsSnapshots, { rowsFile: rowsFile("only.rows.json") }, "silent", NOW);
    expect(JSON.parse(r.note)).toEqual([
      { ts: "2027-01-06T00:00:00.000Z", resets_at: "2027-01-10T00:00:00.000Z", used_pct: 40 },
      { ts: "2027-01-07T00:00:00.000Z", resets_at: "2027-01-10T00:00:00.000Z", used_pct: 60 },
    ]);
  });

  it("transcript + rows case: rows shift by the transcript's offset", () => {
    // Transcript newest = 2027-01-02T00:00:30Z → shift = NOW − 1d − that = +4d23h59m30s.
    const r = runCase(
      readsSnapshots,
      { fixtureDir, rowsFile: rowsFile("both.rows.json") },
      "silent",
      NOW,
    );
    const [first] = JSON.parse(r.note) as { ts: string }[];
    const shift = NOW.getTime() - 86_400_000 - Date.parse("2027-01-02T00:00:30.000Z");
    expect(first?.ts).toBe(new Date(Date.parse("2026-03-01T00:00:00.000Z") + shift).toISOString());
  });
});

describe("harness sidecars", () => {
  it("copies subagents/*.meta.json so ingest fills subagent_meta", () => {
    const countsMeta: Detector = {
      ...neverFires,
      evaluate: (db) => ({
        fired: [],
        status: "INACTIVE",
        note: String(
          (db.prepare("SELECT COUNT(*) AS n FROM subagent_meta").get() as { n: number }).n,
        ),
      }),
    };
    const dir = path.resolve(import.meta.dirname, "../fixtures/detector-health/D9/positive");
    expect(Number(runCase(countsMeta, dir, "silent", NOW).note)).toBeGreaterThan(0);
  });
});

describe("harness fill token", () => {
  it('"<<fill:N>>" ingests as a tool result of exactly N bytes', () => {
    writeCorpus(tmp, {
      "fill-slug": {
        "session.jsonl": [
          assistant({
            id: "fill-1",
            session: "fill-session",
            ts: "2027-01-02T00:00:00.000Z",
            toolUses: [{ id: "toolu_fill", name: "Read", input: {} }],
          }),
          userToolResult({
            session: "fill-session",
            ts: "2027-01-02T00:00:10.000Z",
            results: [{ toolUseId: "toolu_fill", text: "<<fill:30000>>" }],
          }),
        ],
      },
    });
    const readsBytes: Detector = {
      ...neverFires,
      evaluate: (db) => ({
        fired: [],
        status: "INACTIVE",
        note: JSON.stringify(db.prepare("SELECT result_bytes FROM tool_events").all()),
      }),
    };
    const r = runCase(readsBytes, path.join(tmp, "fill-slug"), "silent", NOW);
    expect(JSON.parse(r.note)).toEqual([{ result_bytes: 30000 }]);
  });
});
