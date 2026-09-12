/**
 * RIQ3 feedback + goal-preference store (migration 021).
 * Covers set/get/list/undo/delete, goal set/get/reset, enum + privacy
 * validation, and the ranker cooldown feed round-tripping the frozen riq3
 * fixtures unmodified.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { rankDecisions } from "../../src/query/api/decision-ranker.js";
import {
  DEFAULT_GOAL,
  FeedbackError,
  deleteFeedback,
  getFeedback,
  getGoal,
  listCooldowns,
  listFeedback,
  listFeedbackRoute,
  parsePair,
  parseSetFeedback,
  parseSetGoal,
  resetGoal,
  setFeedback,
  setGoal,
  undoFeedback,
} from "../../src/query/api/feedback-store.js";
import { RIQ3_CASES } from "../fixtures/riq3/cases.js";

const NOW = "2026-09-11T00:00:00.000Z";
const LATER = "2026-09-12T00:00:00.000Z";
const SCOPE = "ws-a";

describe("RIQ3 feedback store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });
  afterEach(() => db.close());

  describe("feedback set/get/list", () => {
    it("creates then returns the active row", () => {
      const row = setFeedback(
        db,
        { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_USEFUL" },
        NOW,
      );
      expect(row).toMatchObject({
        scope_key: SCOPE,
        rec_identity: "F:e1",
        feedback: "NOT_USEFUL",
        cooldown_until: null,
        dismissed_materiality_band: null,
        created_at: NOW,
        updated_at: NOW,
      });
      expect(getFeedback(db, SCOPE, "F:e1")).toEqual(row);
    });

    it("upserts in place — one active row per pair, created_at preserved", () => {
      setFeedback(db, { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_USEFUL" }, NOW);
      const updated = setFeedback(
        db,
        {
          scope_key: SCOPE,
          rec_identity: "F:e1",
          feedback: "ACCEPTED_TRADEOFF",
          cooldown_until: LATER,
          dismissed_materiality_band: "MODERATE",
        },
        LATER,
      );
      expect(updated.feedback).toBe("ACCEPTED_TRADEOFF");
      expect(updated.created_at).toBe(NOW);
      expect(updated.updated_at).toBe(LATER);
      const active = db
        .prepare(
          "SELECT COUNT(*) AS n FROM recommendation_feedback WHERE scope_key = ? AND rec_identity = ? AND deleted_at IS NULL",
        )
        .get(SCOPE, "F:e1") as { n: number };
      expect(active.n).toBe(1);
    });

    it("lists active rows for one scope only, excluding soft-deleted", () => {
      setFeedback(db, { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_USEFUL" }, NOW);
      setFeedback(db, { scope_key: SCOPE, rec_identity: "F:e2", feedback: "ALREADY_DONE" }, NOW);
      setFeedback(db, { scope_key: "ws-b", rec_identity: "F:e3", feedback: "NOT_USEFUL" }, NOW);
      undoFeedback(db, SCOPE, "F:e2", LATER);
      const rows = listFeedback(db, SCOPE);
      expect(rows.map((r) => r.rec_identity)).toEqual(["F:e1"]);
    });
  });

  describe("undo (soft-delete) and delete (erasure)", () => {
    it("undo soft-deletes and is idempotent", () => {
      setFeedback(db, { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_USEFUL" }, NOW);
      expect(undoFeedback(db, SCOPE, "F:e1", LATER)).toBe(true);
      expect(getFeedback(db, SCOPE, "F:e1")).toBeNull();
      expect(undoFeedback(db, SCOPE, "F:e1", LATER)).toBe(false);
    });

    it("re-setting after undo creates a fresh active row (prior tombstone retained)", () => {
      setFeedback(db, { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_USEFUL" }, NOW);
      undoFeedback(db, SCOPE, "F:e1", LATER);
      const again = setFeedback(
        db,
        { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_APPLICABLE" },
        LATER,
      );
      expect(again.feedback).toBe("NOT_APPLICABLE");
      const total = db
        .prepare(
          "SELECT COUNT(*) AS n FROM recommendation_feedback WHERE scope_key = ? AND rec_identity = ?",
        )
        .get(SCOPE, "F:e1") as { n: number };
      expect(total.n).toBe(2); // one active + one soft-deleted tombstone
    });

    it("delete erases all rows (active + soft-deleted) for the pair", () => {
      setFeedback(db, { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_USEFUL" }, NOW);
      undoFeedback(db, SCOPE, "F:e1", LATER);
      setFeedback(
        db,
        { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_APPLICABLE" },
        LATER,
      );
      expect(deleteFeedback(db, SCOPE, "F:e1")).toBe(2);
      const total = db
        .prepare(
          "SELECT COUNT(*) AS n FROM recommendation_feedback WHERE scope_key = ? AND rec_identity = ?",
        )
        .get(SCOPE, "F:e1") as { n: number };
      expect(total.n).toBe(0);
    });
  });

  describe("goal preference", () => {
    it("defaults to PRESERVE_QUALITY, upserts, and resets", () => {
      expect(getGoal(db, SCOPE)).toBe(DEFAULT_GOAL);
      expect(DEFAULT_GOAL).toBe("PRESERVE_QUALITY");
      setGoal(db, SCOPE, "REDUCE_RESOURCE_USE", NOW);
      expect(getGoal(db, SCOPE)).toBe("REDUCE_RESOURCE_USE");
      setGoal(db, SCOPE, "INVESTIGATE_FRICTION", LATER);
      expect(getGoal(db, SCOPE)).toBe("INVESTIGATE_FRICTION");
      resetGoal(db, SCOPE);
      expect(getGoal(db, SCOPE)).toBe("PRESERVE_QUALITY");
    });
  });

  describe("enum + shape validation", () => {
    it("rejects an invalid feedback enum", () => {
      expect(() =>
        parseSetFeedback({ scope_key: SCOPE, rec_identity: "F:e1", feedback: "MEH" }),
      ).toThrow(FeedbackError);
    });
    it("rejects an invalid goal enum", () => {
      expect(() => parseSetGoal({ scope_key: SCOPE, goal: "GO_FAST" })).toThrow(FeedbackError);
    });
    it("rejects an invalid materiality band", () => {
      expect(() =>
        parseSetFeedback({
          scope_key: SCOPE,
          rec_identity: "F:e1",
          feedback: "NOT_USEFUL",
          dismissed_materiality_band: "HUGE",
        }),
      ).toThrow(FeedbackError);
    });
    it("rejects a malformed cooldown_until", () => {
      expect(() =>
        parseSetFeedback({
          scope_key: SCOPE,
          rec_identity: "F:e1",
          feedback: "NOT_USEFUL",
          cooldown_until: "soon",
        }),
      ).toThrow(FeedbackError);
    });
    it("rejects missing required fields", () => {
      expect(() => parsePair({ scope_key: SCOPE })).toThrow(FeedbackError);
    });
  });

  describe("privacy (SEC-101)", () => {
    it("rejects any unknown (potentially free-text) field", () => {
      expect(() =>
        parseSetFeedback({
          scope_key: SCOPE,
          rec_identity: "F:e1",
          feedback: "NOT_USEFUL",
          note: "why I dismissed it",
        }),
      ).toThrow(FeedbackError);
    });

    it("persists no content-bearing columns", () => {
      const blocked = new Set(["text", "content", "body", "prompt", "response", "raw"]);
      for (const table of ["recommendation_feedback", "recommendation_goal_preference"]) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        for (const c of cols) {
          for (const part of c.name.toLowerCase().split("_")) {
            expect(blocked.has(part), `${table}.${c.name}`).toBe(false);
          }
        }
      }
    });
  });

  describe("ranker cooldown feed", () => {
    it("maps active dismissal rows to CooldownInput; excludes ALREADY_DONE and incomplete rows", () => {
      setFeedback(
        db,
        {
          scope_key: SCOPE,
          rec_identity: "F:cool",
          feedback: "NOT_USEFUL",
          cooldown_until: LATER,
          dismissed_materiality_band: "LARGE",
        },
        NOW,
      );
      // ALREADY_DONE never becomes a cooldown (awaits RIQ5 confirmation).
      setFeedback(
        db,
        {
          scope_key: SCOPE,
          rec_identity: "F:done",
          feedback: "ALREADY_DONE",
          cooldown_until: LATER,
          dismissed_materiality_band: "LARGE",
        },
        NOW,
      );
      // Missing cooldown_until / band → not a cooldown.
      setFeedback(
        db,
        { scope_key: SCOPE, rec_identity: "F:bare", feedback: "NOT_APPLICABLE" },
        NOW,
      );
      expect(listCooldowns(db, SCOPE)).toEqual([
        { decision_identity: "F:cool", until_iso: LATER, dismissed_materiality_band: "LARGE" },
      ]);
    });

    it("feeds the frozen 'cooldown-active' fixture through the store unchanged", () => {
      const fixture = RIQ3_CASES.find((c) => c.case_id === "cooldown-active");
      if (!fixture) throw new Error("fixture 'cooldown-active' missing");
      // Persist the fixture's cooldowns, then re-derive them from the store.
      for (const cd of fixture.options.cooldowns) {
        setFeedback(
          db,
          {
            scope_key: SCOPE,
            rec_identity: cd.decision_identity,
            feedback: "NOT_USEFUL",
            cooldown_until: cd.until_iso,
            dismissed_materiality_band: cd.dismissed_materiality_band,
          },
          NOW,
        );
      }
      const fromStore = listCooldowns(db, SCOPE);
      expect(fromStore).toEqual([...fixture.options.cooldowns]);
      // Ranker output must be identical whether cooldowns come from the fixture
      // or the store — proving the store feeds the ranker without drift.
      const viaFixture = rankDecisions(fixture.composition, fixture.options);
      const viaStore = rankDecisions(fixture.composition, {
        ...fixture.options,
        cooldowns: fromStore,
      });
      expect(viaStore).toEqual(viaFixture);
    });
  });

  describe("adversarial-review fixes", () => {
    it("rejects a cooldown_until without a dismissed band (no silent no-op)", () => {
      expect(() =>
        setFeedback(
          db,
          { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_USEFUL", cooldown_until: LATER },
          NOW,
        ),
      ).toThrow(FeedbackError);
      // And the mirror: a band without a cooldown is equally rejected.
      expect(() =>
        setFeedback(
          db,
          {
            scope_key: SCOPE,
            rec_identity: "F:e1",
            feedback: "NOT_USEFUL",
            dismissed_materiality_band: "LARGE",
          },
          NOW,
        ),
      ).toThrow(FeedbackError);
      // Both together is accepted and feeds the ranker.
      setFeedback(
        db,
        {
          scope_key: SCOPE,
          rec_identity: "F:e1",
          feedback: "NOT_USEFUL",
          cooldown_until: LATER,
          dismissed_materiality_band: "LARGE",
        },
        NOW,
      );
      expect(listCooldowns(db, SCOPE)).toHaveLength(1);
    });

    it("canonicalizes a no-millisecond cooldown_until to .000Z", () => {
      const row = parseSetFeedback({
        scope_key: SCOPE,
        rec_identity: "F:e1",
        feedback: "NOT_USEFUL",
        cooldown_until: "2027-01-01T00:00:00Z",
        dismissed_materiality_band: "LARGE",
      });
      expect(row.cooldown_until).toBe("2027-01-01T00:00:00.000Z");
    });

    it("rejects a structurally-valid but impossible cooldown_until with a 400 (not a 500)", () => {
      // Matches the ISO regex yet is not a real date; Date() yields Invalid Date.
      // Must surface as FeedbackError(400), not an unhandled RangeError from toISOString().
      expect(() =>
        parseSetFeedback({
          scope_key: SCOPE,
          rec_identity: "F:e1",
          feedback: "NOT_USEFUL",
          cooldown_until: "2027-13-45T25:61:61Z",
          dismissed_materiality_band: "LARGE",
        }),
      ).toThrow(FeedbackError);
    });

    it("sets meta.n to the row count on list and 1 on single-row responses", () => {
      setFeedback(db, { scope_key: SCOPE, rec_identity: "F:e1", feedback: "NOT_USEFUL" }, NOW);
      setFeedback(db, { scope_key: SCOPE, rec_identity: "F:e2", feedback: "ALREADY_DONE" }, NOW);
      expect(listFeedbackRoute(db, SCOPE).meta.n).toBe(2);
      expect(listFeedbackRoute(db, "ws-empty").meta.n).toBe(0);
    });

    it("accepts a long rec_identity and reports length overflow distinctly", () => {
      const longId = `EXPLAIN_USAGE_CHANGE:${Array.from({ length: 80 }, (_, i) => `ev-usage-${i}`).join(",")}`;
      expect(longId.length).toBeGreaterThan(512); // exceeds the old cap that would have rejected it
      expect(() => parsePair({ scope_key: SCOPE, rec_identity: longId })).not.toThrow();
      expect(() => parsePair({ scope_key: SCOPE, rec_identity: "x".repeat(1025) })).toThrow(
        /exceeds/,
      );
    });
  });
});
