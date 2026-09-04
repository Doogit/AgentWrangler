/**
 * test/detector/practice-registry.test.ts — BM1 practice scorecard.
 *
 * Behavioral status-transition tests over fixture DBs (never source greps):
 * each practice is exercised at its PASS / ATTENTION / NO_DATA boundaries via
 * the public getPractices(), plus a citation-completeness guard and the
 * detector→practice status mapping.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type PracticeStatus,
  detectorPracticeStatus,
  getPractices,
} from "../../src/detector/practice-registry.js";
import { migratedMemDb } from "../ingest/dbutil.js";

const WS = "ws-bm1";
const TO = "2027-02-01T00:00:00.000Z";
const TO_MS = new Date(TO).getTime();
const FROM = new Date(TO_MS - 7 * 24 * 60 * 60 * 1000).toISOString();
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = migratedMemDb();
  db.prepare(
    `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?, 'bm1', '2027-01-01T00:00:00.000Z')`,
  ).run(WS);
  seq = 0;
});
afterEach(() => db.close());

function mkSession(id: string, turnCount = 10): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?, ?, ?, '2027-01-15T00:00:00.000Z', '2027-01-20T00:00:00.000Z',
             'RECONCILED', ?, 0, '[]')`,
  ).run(id, WS, `/fake/${id}.jsonl`, turnCount);
}

function insTurn(f: {
  session: string;
  tsIso: string;
  model?: string;
  input?: number;
  output?: number;
  cr?: number;
  sidechain?: boolean;
}): void {
  const {
    session,
    tsIso,
    model = "claude-sonnet-5",
    input = 0,
    output = 0,
    cr = 0,
    sidechain = false,
  } = f;
  db.prepare(
    `INSERT INTO turns
       (message_id, session_id, workspace_id, ts, model,
        is_sidechain, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
        tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
        provisional, parser_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, 0, 'LIST_EQUIV', 0, 'test-v1')`,
  ).run(`msg-${seq++}`, session, WS, tsIso, model, sidechain ? 1 : 0, input, output, cr);
}

function statusOf(id: string): PracticeStatus {
  const { practices } = getPractices(db, { from: FROM, to: TO });
  const p = practices.find((e) => e.practice_id === id);
  if (!p) throw new Error(`practice ${id} missing`);
  return p.status;
}

// ── Citation completeness + shape ─────────────────────────────────────────────
describe("registry integrity", () => {
  it("returns 8 practices P1..P8, each with a non-empty citation", () => {
    const { practices, window } = getPractices(db, { from: FROM, to: TO });
    expect(practices.map((p) => p.practice_id)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
      "P8",
    ]);
    for (const p of practices) {
      expect(p.source_url).toMatch(/^https?:\/\//);
      expect(p.source_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.statement.length).toBeGreaterThan(0);
      expect(["PASS", "ATTENTION", "NO_DATA"]).toContain(p.status);
    }
    expect(window).toEqual({ from: FROM, to: TO });
  });
});

// ── Detector→practice mapping ─────────────────────────────────────────────────
describe("detectorPracticeStatus", () => {
  it("maps ACTIVE→ATTENTION, INACTIVE→PASS, and everything else→NO_DATA", () => {
    expect(detectorPracticeStatus("ACTIVE")).toBe("ATTENTION");
    expect(detectorPracticeStatus("INACTIVE")).toBe("PASS");
    expect(detectorPracticeStatus("NOT_EVALUATED")).toBe("NO_DATA");
    expect(detectorPracticeStatus("BLOCKED")).toBe("NO_DATA");
    expect(detectorPracticeStatus(undefined)).toBe("NO_DATA");
  });
});

// ── P1 cache-read health (trend vs trailing-8-week median) ────────────────────
describe("P1 cache-read health", () => {
  // Seed 8 prior weeks at a given cache-read ratio; current week separately.
  function seedWeek(weeksAgo: number, input: number, cr: number): void {
    const ts = new Date(TO_MS - weeksAgo * WEEK_MS - 60_000).toISOString();
    const s = `s-w${weeksAgo}`;
    mkSession(s);
    insTurn({ session: s, tsIso: ts, input, cr });
  }

  it("NO_DATA when the current week is under the minimum volume", () => {
    for (let w = 1; w <= 8; w++) seedWeek(w, 90_000, 90_000); // priors healthy
    seedWeek(0, 1_000, 900); // current week tiny → under 50k volume
    expect(statusOf("P1")).toBe("NO_DATA");
  });

  it("PASS when the current ratio holds near the trailing median", () => {
    for (let w = 1; w <= 8; w++) seedWeek(w, 20_000, 80_000); // ratio 0.8
    seedWeek(0, 20_000, 80_000); // current ratio 0.8, volume 100k
    expect(statusOf("P1")).toBe("PASS");
  });

  it("ATTENTION when the current ratio is >10 pts below the trailing median", () => {
    for (let w = 1; w <= 8; w++) seedWeek(w, 20_000, 80_000); // ratio 0.8
    seedWeek(0, 60_000, 40_000); // current ratio 0.4 → 40 pts below
    expect(statusOf("P1")).toBe("ATTENTION");
  });
});

// ── P2 model switching ────────────────────────────────────────────────────────
describe("P2 model switching", () => {
  function seedSession(id: string, models: string[]): void {
    mkSession(id);
    models.forEach((m, i) =>
      insTurn({
        session: id,
        tsIso: new Date(TO_MS - WEEK_MS + (i + 1) * 60_000).toISOString(),
        model: m,
      }),
    );
  }

  it("NO_DATA when no session reaches the non-trivial turn floor", () => {
    seedSession("s-tiny", ["claude-sonnet-5", "claude-opus-5"]); // only 2 turns (<5)
    expect(statusOf("P2")).toBe("NO_DATA");
  });

  it("PASS when non-trivial sessions stay on one model", () => {
    seedSession("s-single", Array(6).fill("claude-sonnet-5"));
    expect(statusOf("P2")).toBe("PASS");
  });

  it("ATTENTION when >20% of non-trivial sessions switched models", () => {
    seedSession("s-a", [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
    seedSession("s-b", Array(6).fill("claude-sonnet-5")); // clean
    // 1 of 2 non-trivial sessions switched = 50% > 20%.
    expect(statusOf("P2")).toBe("ATTENTION");
  });
});

// ── P5 CLAUDE.md line count ───────────────────────────────────────────────────
describe("P5 CLAUDE.md lean", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm1-p5-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function probeClaudeMd(fileRef: string): void {
    db.prepare(
      `INSERT INTO context_inventory
         (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
       VALUES (?, ?, '2027-01-20T00:00:00.000Z', 'CLAUDE_MD', ?, 'h', 100, 'v1')`,
    ).run(`probe-${seq++}`, WS, fileRef);
  }

  it("NO_DATA when there is no CLAUDE.md probe", () => {
    expect(statusOf("P5")).toBe("NO_DATA");
  });

  it("PASS at or below the 200-line ceiling", () => {
    const f = join(dir, "CLAUDE.md");
    writeFileSync(f, Array(150).fill("line").join("\n"));
    probeClaudeMd(f);
    expect(statusOf("P5")).toBe("PASS");
  });

  it("ATTENTION above the 200-line ceiling", () => {
    const f = join(dir, "CLAUDE.md");
    writeFileSync(f, Array(250).fill("line").join("\n"));
    probeClaudeMd(f);
    expect(statusOf("P5")).toBe("ATTENTION");
  });

  it("NO_DATA when the probed file no longer exists", () => {
    probeClaudeMd(join(dir, "gone.md"));
    expect(statusOf("P5")).toBe("NO_DATA");
  });
});

// ── P7 offload share (trend-only) ─────────────────────────────────────────────
describe("P7 offload share", () => {
  it("NO_DATA on an empty window (no turns)", () => {
    expect(statusOf("P7")).toBe("NO_DATA");
  });

  it("PASS when turns exist (share observable, no ATTENTION line)", () => {
    mkSession("s-main");
    insTurn({
      session: "s-main",
      tsIso: new Date(TO_MS - WEEK_MS + 60_000).toISOString(),
      input: 100,
    });
    insTurn({
      session: "s-main",
      tsIso: new Date(TO_MS - WEEK_MS + 120_000).toISOString(),
      input: 100,
      sidechain: true,
    });
    expect(statusOf("P7")).toBe("PASS");
  });
});

// ── P6 detector-backed end-to-end (D4 fires → ATTENTION) ──────────────────────
describe("P6 detector wiring", () => {
  it("PASS when D4 is not firing (empty DB)", () => {
    expect(statusOf("P6")).toBe("PASS");
  });

  it("ATTENTION when the D4 model-mismatch detector fires in-window", () => {
    mkSession("s-opus");
    // 5 high-context (≥50k) low-output (≤500) Opus turns in the trailing-7d window.
    for (let i = 0; i < 5; i++) {
      insTurn({
        session: "s-opus",
        tsIso: new Date(TO_MS - 2 * 24 * 60 * 60 * 1000 + i * 60_000).toISOString(),
        model: "claude-opus-5",
        input: 60_000,
        output: 100,
      });
    }
    expect(statusOf("P6")).toBe("ATTENTION");
  });
});
