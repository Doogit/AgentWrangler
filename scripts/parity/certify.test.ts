import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import type { RecommendationCard } from "../../src/query/api/recommendations.js";
import {
  type Steps,
  actionStep,
  c1Step,
  c5aStep,
  certify,
  exitFor,
  reportFile,
  sharedHooks,
  tierFor,
  writeSafeReport,
} from "./certify.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function dbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-certify-test-"));
  dirs.push(dir);
  const file = path.join(dir, "test.sqlite");
  const db = new Database(file);
  runMigrations(db);
  db.close();
  return file;
}

const pass = { verdict: "PASS" } as const;
const steps = (): Steps => ({ tier: pass, C3: pass, C4: pass, C2: pass, C1: pass, C5a: pass });
const card = {
  detector_id: "D1",
  state: "PROPOSED",
  weeks_ago: 0,
  weeks_fired: 1,
  modeled_savings_u_per_wk: 1_000_000,
  evidence: {},
} as RecommendationCard;

describe("certify wrapper", () => {
  it("maps required verdicts to exit 0, 1, or 3", () => {
    expect(exitFor(steps(), "Full")).toBe(0);
    const failed = steps();
    failed.C4 = { verdict: "FAIL" };
    expect(exitFor(failed, "Full")).toBe(1);
    const missing = steps();
    missing.C5a = { verdict: "MISSING" };
    expect(exitFor(missing, "Full")).toBe(3);
    expect(exitFor(missing, "Light")).toBe(0);
    const unproven = steps();
    unproven.C1 = { verdict: "UNPROVEN" };
    expect(exitFor(unproven, "Light")).toBe(3);
    const estimated = steps();
    estimated.C1 = { verdict: "ESTIMATED" };
    expect(exitFor(estimated, "Light")).toBe(0);
    expect(exitFor(estimated, "Full")).toBe(3);
  });

  it("checks actions only on current firing cards", async () => {
    const retired = { ...card, state: "RETIRED" } as RecommendationCard;
    const seen: RecommendationCard[][] = [];
    await certify(
      { detectorId: "D1", db: dbFile() },
      {
        cards: async () => [card, retired],
        action: (cards) => {
          seen.push(cards);
          return pass;
        },
        c2: () => pass,
        c1: () => ({ step: pass }),
        c5a: () => pass,
      },
    );
    expect(seen).toEqual([[card]]);
  });

  it("selects tier at the five dollar weekly boundary and for advisory cards", () => {
    expect(tierFor(4_990_000, 10_000_000)).toBe("Light");
    expect(tierFor(5_000_000, 10_000_000)).toBe("Full");
    expect(tierFor(5_000_000, null)).toBe("Light");
    expect(tierFor(5_000_000, 10_000_000, true)).toBe("Light");
  });

  it("stops after NOT_FIRING and skips later checks", async () => {
    const result = await certify({ detectorId: "D1", db: dbFile() }, { cards: async () => [] });
    expect(result.steps.C3.verdict).toBe("NOT_FIRING");
    expect(
      [result.steps.C4, result.steps.C2, result.steps.C1, result.steps.C5a].map((s) => s.verdict),
    ).toEqual(["SKIP", "SKIP", "SKIP", "SKIP"]);
  });

  it("handles an empty migrated database through the disposable query snapshot", async () => {
    const result = await certify({ detectorId: "D1", db: dbFile() });
    expect(result.steps.C3.verdict).toBe("NOT_FIRING");
    expect(result.steps.C4.verdict).toBe("SKIP");
  });

  it("rejects private identifiers and paths before creating a report", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-certify-guard-"));
    dirs.push(dir);
    const file = path.join(dir, "report.json");
    expect(() =>
      writeSafeReport(file, { value: "123e4567-e89b-42d3-a456-426614174000" }),
    ).toThrow();
    expect(fs.existsSync(file)).toBe(false);
    expect(() => writeSafeReport(file, { value: "C:\\Users\\x" })).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("writes into the repo only with --save; a check run goes to the temp folder", () => {
    const date = new Date("2026-09-26T12:00:00Z");
    expect(reportFile("C9", true, date)).toBe(
      path.join(".claude", "audits", "certification", "C9", "2026-09-26-certify.json"),
    );
    expect(reportFile("C9", false, date).startsWith(os.tmpdir())).toBe(true);
  });

  it("C5a resolves the card's target metric through the effect registry aliases", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE recommendations (rec_id TEXT, scope_workspace_id TEXT, target_metric TEXT,
        adopted_at TEXT);
      CREATE TABLE effect_cycles (rec_id TEXT, detector_id TEXT, cycle_no INTEGER, action_revision TEXT,
        application_source TEXT, method_version TEXT, metric_id TEXT, scope_json TEXT, applied_at TEXT);
      INSERT INTO recommendations VALUES ('rec-1', NULL, 'avg_context_per_turn', '2026-09-25T00:00:00Z');`);
    const insertCycle = db.prepare(
      `INSERT INTO effect_cycles VALUES ('rec-1', 'D1', ?, 'd1-trim-prefix', 'USER_ATTESTED',
        'd1-source-tokens-v2', ?, '{}', ?)`,
    );
    const cards = [
      {
        ...card,
        rec_id: "rec-1",
        actions: { primary: { option_id: "d1-trim-prefix" }, alternatives: [] },
      } as unknown as RecommendationCard,
    ];
    insertCycle.run(1, "d1-source-tokens", "2026-09-25T01:00:00Z");
    expect(c5aStep(db, "D1", cards).verdict).toBe("PASS");
    insertCycle.run(2, "d2-floor-context", "2026-09-25T02:00:00Z");
    expect(c5aStep(db, "D1", cards).verdict).toBe("FAIL");
    db.close();
  });

  it("C4 counts unmeasured actions without loosening C4, C5a or the Full tier", () => {
    const actionCard = (primary: unknown) =>
      ({
        ...card,
        detector_id: "C9",
        rec_id: "rec-c9",
        actions: {
          primary: { option_id: "c9-review", target_metric: "denial_friction_count" },
          alternatives: [],
        },
        action_validation: { primary, alternatives: {} },
      }) as unknown as RecommendationCard;
    expect(actionStep([actionCard({ ok: true, measured: false })])).toEqual({
      verdict: "PASS",
      counts: { actions: 1, failed: 0, missingMetric: 0, unmeasured: 1 },
    });
    expect(
      actionStep([actionCard({ ok: false, reason: "invalid settings or hook JSON" })]),
    ).toEqual({
      verdict: "FAIL",
      counts: { actions: 1, failed: 1, missingMetric: 0, unmeasured: 0 },
    });

    // An adopted unmeasured action has no handler, so C5a fails and blocks the Full tier.
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE recommendations (rec_id TEXT, scope_workspace_id TEXT, target_metric TEXT,
        adopted_at TEXT);
      CREATE TABLE effect_cycles (rec_id TEXT, detector_id TEXT, cycle_no INTEGER, action_revision TEXT,
        application_source TEXT, method_version TEXT, metric_id TEXT, scope_json TEXT, applied_at TEXT);
      INSERT INTO recommendations VALUES ('rec-c9', NULL, 'denial_friction_count', '2026-09-25T00:00:00Z');
      INSERT INTO effect_cycles VALUES ('rec-c9', 'C9', 1, 'c9-review', 'USER_ATTESTED',
        'UNSUPPORTED', 'denial_friction_count', '{}', '2026-09-25T01:00:00Z');`);
    const c5a = c5aStep(db, "C9", [actionCard({ ok: true, measured: false })]);
    db.close();
    expect(c5a.verdict).toBe("FAIL");
    const unmeasured = steps();
    unmeasured.C5a = c5a;
    expect(exitFor(unmeasured, "Full")).toBe(1);
    unmeasured.C5a = { verdict: "MISSING" };
    expect(exitFor(unmeasured, "Full")).toBe(3);
  });

  it("C1 with no family oracle is ESTIMATED, so a Light detector can pass before it is certified", () => {
    const db = new Database(":memory:");
    const window = { from: "2026-09-27T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z" };
    const unverified = { ...card, confidence_tier: "UNVERIFIED" } as RecommendationCard;
    for (const detectorId of ["C9", "D7", "A1", "H1"]) {
      expect(c1Step(db, { detectorId, db: ":memory:" }, [unverified], window).step.verdict).toBe(
        "ESTIMATED",
      );
    }
    // D2 has its own oracle: an empty DB has nothing to check, so UNPROVEN, not ESTIMATED.
    runMigrations(db);
    for (const detectorId of ["D2", "D8"]) {
      expect(c1Step(db, { detectorId, db: ":memory:" }, [unverified], window).step.verdict).toBe(
        "UNPROVEN",
      );
    }
    db.close();
    const estimated = steps();
    estimated.C1 = { verdict: "ESTIMATED" };
    estimated.C5a = { verdict: "MISSING" };
    expect(exitFor(estimated, "Light")).toBe(0);
    expect(exitFor(estimated, "Full")).toBe(3);
  });

  it("--all reuses one card snapshot and one ledger per window across detectors", async () => {
    const file = dbFile();
    let cardCalls = 0;
    const ledgers = new Map();
    const hooks = {
      cards: async () => {
        cardCalls++;
        return [];
      },
      ledgers,
    };
    const shared = sharedHooks(hooks);
    await certify({ detectorId: "D1", db: file }, shared);
    await certify({ detectorId: "C9", db: file }, shared);
    expect(cardCalls).toBe(1);
    expect(ledgers.size).toBe(1);
  });

  it("records an internal step error as FAIL and continues later steps", async () => {
    let reachedC5a = false;
    const result = await certify(
      { detectorId: "D1", db: dbFile() },
      {
        cards: async () => [card],
        action: () => {
          throw new Error("synthetic validation failure");
        },
        c2: () => pass,
        c1: () => ({ step: pass }),
        c5a: () => {
          reachedC5a = true;
          return { verdict: "MISSING" };
        },
      },
    );
    expect(result.steps.C4.verdict).toBe("FAIL");
    expect(result.steps.C2.verdict).toBe("PASS");
    expect(reachedC5a).toBe(true);
    expect(exitFor(result.steps, result.tier)).toBe(1);
  });
});
