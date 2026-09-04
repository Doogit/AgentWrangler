/**
 * test/query/api.test.ts — LocalQueryAPI overview method wrappers.
 *
 * Drives the frozen methods against the injected fixture DB (via db-context),
 * asserting the payloads, the response envelope (meta / qualification / claim
 * guard), pagination, and drilldown ids.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGlobalOverview,
  getSession,
  getTurnTimeline,
  getWorkspace,
  listLiveSessions,
  listSessions,
  listWorkspaces,
} from "../../src/query/api/overview.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import * as spend from "../../src/query/spend.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Window that contains all fixture turns.
const WINDOW = { from: "2025-12-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" } as const;

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetQueryDb();
  db.close();
  // Remove (not set to "undefined") so loadConfig falls back to the default.
  Reflect.deleteProperty(process.env, "AW_ACTIVITY_WINDOW_SECS");
});

describe("getGlobalOverview", () => {
  it("returns documented aggregates + forecast + model mix with a correct envelope", () => {
    const res = getGlobalOverview(WINDOW);
    const d = res.data;
    if (d === null) throw new Error("null data");

    expect(d.cost_equiv_u).toBe(99_125);
    expect(d.turns).toBe(9); // reconciled: alpha 7 + beta 2
    expect(d.turns_total).toBe(10); // + 1 provisional LIVE turn
    expect(d.unpriced_turns).toBe(0);
    expect(d.forecast.state).toBe("OFF"); // fixture limit_tokens is null

    const models = d.model_mix.map((m) => m.model).sort();
    expect(models).toEqual(["claude-haiku", "claude-sonnet"]);
    expect(d.context_per_turn.length).toBe(2);

    // Envelope.
    expect(res.meta.metric_definition_version).toBe("observe-1");
    expect(res.meta.n).toBe(9);
    expect(res.meta.claim_kind).toBe("LIST_EQUIV");
    expect(res.meta.qualification.claim_kinds_count).toBe(1);
    expect(res.meta.qualification.provisional_excluded).toBe(true);
  });

  it("surfaces a claim-kind guard when kinds are mixed (never a silent sum)", () => {
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model,
         is_sidechain, input_tokens, output_tokens, cache_read_tokens,
         cache_write_5m, cache_write_1h, cache_write_other, tool_result_bytes,
         pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
       VALUES ('msg-stale','sess-a1','ws-alpha','2026-01-01T00:30:00.000Z','claude-sonnet',
         0, 100, 10, 0, 0, 0, 0, NULL, 'snap-sonnet', 450, 'LIST_EQUIV_STALE', 0, 'test-v1')`,
    ).run();

    const res = getGlobalOverview(WINDOW);
    expect(res.meta.qualification.claim_kinds_count).toBe(2);
    expect(res.meta.qualification.note).toContain("mixed cost_claim kinds");
    expect(res.meta.claim_kind).toBe("LIST_EQUIV_STALE");
  });

  it("caches identical aggregate reads within the TTL and re-runs them after expiry", () => {
    vi.useFakeTimers();
    try {
      const globalSpend = vi.spyOn(spend, "globalSpend");
      const hasStaleClaim = vi.spyOn(spend, "hasStaleClaim");

      const first = getGlobalOverview(WINDOW);
      const second = getGlobalOverview(WINDOW);

      expect(second).toEqual(first);
      expect(globalSpend).toHaveBeenCalledTimes(1);
      expect(hasStaleClaim).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(45_000);
      getGlobalOverview(WINDOW);

      expect(globalSpend).toHaveBeenCalledTimes(2);
      expect(hasStaleClaim).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("listWorkspaces", () => {
  it("orders by cost desc with correct shares and $/turn", () => {
    const res = listWorkspaces(WINDOW);
    const items = res.data?.items ?? [];
    expect(items.map((w) => w.workspace_id)).toEqual(["ws-alpha", "ws-beta"]);

    const alpha = items[0];
    const beta = items[1];
    if (alpha === undefined || beta === undefined) throw new Error("missing rows");
    expect(alpha.cost_equiv_u).toBe(49_775);
    expect(alpha.cost_share).toBeCloseTo(49_775 / 99_125, 9);
    expect(beta.cost_share).toBeCloseTo(49_350 / 99_125, 9);
    expect(alpha.cost_share + beta.cost_share).toBeCloseTo(1, 9);
    expect(alpha.usd_per_turn).toBeCloseTo(49_775 / 7 / 1e6, 12);
    expect(alpha.has_live).toBe(false); // activity cutoff is "now"-based
    expect(res.data?.next_cursor).toBeNull();
  });
});

describe("getWorkspace", () => {
  it("returns workspace detail with repo metadata for a known id", () => {
    const res = getWorkspace("ws-alpha");
    const d = res.data;
    if (d === null) throw new Error("null data");
    expect(d.workspace_id).toBe("ws-alpha");
    expect(d.project_slug).toBe("project-alpha");
    expect(d.registered_at).toBe("2026-01-01T00:00:00.000Z");
    expect(res.meta.drilldown_ids.workspace_id).toBe("ws-alpha");
  });

  it("returns null data + N_A for an unknown id", () => {
    const res = getWorkspace("nope");
    expect(res.data).toBeNull();
    expect(res.meta.claim_kind).toBe("N_A");
  });

  it("flags provisional_excluded when a provisional turn is stripped from the figure", () => {
    // getWorkspace uses the default 7d window, so seed recent (in-window) data:
    // one reconciled + one provisional turn. The reconciled figure excludes the
    // provisional turn, so the honesty flag MUST say so.
    const now = Date.now();
    const recent = (offsetMs: number) => new Date(now - offsetMs).toISOString();
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-now','project-now',?)",
    ).run(recent(0));
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-now','ws-now','/fake/now.jsonl',?,?,'LIVE',2,0,'[]')`,
    ).run(recent(60_000), recent(0));
    const insTurn = db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain,
         input_tokens, output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h,
         cache_write_other, tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
         provisional, parser_version)
       VALUES (?,?, 'ws-now', ?, 'claude-haiku', 0, 1000, 200, 0, 0, 0, 0, NULL, 'snap-haiku', 1600, 'LIST_EQUIV', ?, 'test-v1')`,
    );
    insTurn.run("msg-now-1", "sess-now", recent(60_000), 0); // reconciled
    // Strictly in the past so it sorts before getWorkspace's exclusive `to` bound.
    insTurn.run("msg-now-2", "sess-now", recent(1_000), 1); // provisional

    const res = getWorkspace("ws-now");
    const d = res.data;
    if (d === null) throw new Error("null data");
    expect(d.turns).toBe(1); // reconciled only
    expect(d.cost_equiv_u).toBe(1600); // provisional turn's cost excluded
    expect(res.meta.qualification.provisional_excluded).toBe(true);
  });
});

describe("listSessions", () => {
  it("lists a workspace's sessions most-recent-first", () => {
    const res = listSessions("ws-alpha", WINDOW);
    const ids = (res.data?.items ?? []).map((s) => s.session_id);
    expect(ids).toEqual(["sess-a3", "sess-a2", "sess-a1"]);
    expect(res.meta.drilldown_ids.workspace_id).toBe("ws-alpha");
  });

  it("paginates via the opaque cursor", () => {
    const page1 = listSessions("ws-alpha", WINDOW, { limit: 2 });
    expect((page1.data?.items ?? []).map((s) => s.session_id)).toEqual(["sess-a3", "sess-a2"]);
    const next = page1.data?.next_cursor;
    expect(typeof next).toBe("string");

    const page2 = listSessions("ws-alpha", WINDOW, {
      limit: 2,
      after: next as string,
    });
    expect((page2.data?.items ?? []).map((s) => s.session_id)).toEqual(["sess-a1"]);
    expect(page2.data?.next_cursor).toBeNull();
  });
});

describe("getSession", () => {
  it("returns one session summary with parsed hygiene flags", () => {
    const res = getSession("sess-a1");
    const d = res.data;
    if (d === null) throw new Error("null data");
    expect(d.turn_count).toBe(3);
    expect(d.cost_equiv_u).toBe(29_175);
    expect(d.state).toBe("RECONCILED");
    expect(d.hygiene_flags).toEqual([]);
  });

  it("returns null + N_A for an unknown session", () => {
    const res = getSession("nope");
    expect(res.data).toBeNull();
    expect(res.meta.claim_kind).toBe("N_A");
  });
});

describe("getTurnTimeline", () => {
  it("returns turns oldest-first with typed fields", () => {
    const res = getTurnTimeline("sess-a1");
    const items = res.data?.items ?? [];
    expect(items.map((t) => t.message_id)).toEqual(["msg-a1-1", "msg-a1-2", "msg-a1-3"]);

    const t2 = items[1];
    if (t2 === undefined) throw new Error("missing turn");
    expect(t2.context_tokens).toBe(3500); // 2000 + 1000 + 500
    expect(t2.cost_equiv_u).toBe(14_175);
    expect(t2.cost_claim).toBe("LIST_EQUIV");
    expect(t2.is_sidechain).toBe(false);
    expect(t2.provisional).toBe(false);
    expect(t2.effort).toBeNull();
  });

  it("paginates oldest-first", () => {
    const page1 = getTurnTimeline("sess-a1", { limit: 2 });
    expect((page1.data?.items ?? []).map((t) => t.message_id)).toEqual(["msg-a1-1", "msg-a1-2"]);
    expect(typeof page1.data?.next_cursor).toBe("string");
    const page2 = getTurnTimeline("sess-a1", {
      limit: 2,
      after: page1.data?.next_cursor as string,
    });
    expect((page2.data?.items ?? []).map((t) => t.message_id)).toEqual(["msg-a1-3"]);
    expect(page2.data?.next_cursor).toBeNull();
  });
});

describe("listLiveSessions", () => {
  it("is empty when the activity cutoff excludes the stale fixture session", () => {
    const res = listLiveSessions();
    expect(res.data?.items ?? []).toEqual([]);
  });

  it("returns the LIVE row when the activity window is wide enough", () => {
    // Widen the activity window so the 2026-01-01 LIVE session is within cutoff.
    process.env.AW_ACTIVITY_WINDOW_SECS = String(60 * 60 * 24 * 365 * 40); // 40 years
    const res = listLiveSessions();
    const items = res.data?.items ?? [];
    expect(items.length).toBe(1);
    const r = items[0];
    if (r === undefined) throw new Error("missing live row");
    expect(r.session_id).toBe("sess-b2");
    expect(r.running_usd_u).toBe(1_600);
    expect(r.current_context_tokens).toBe(1_000);
    expect(r.model).toBe("claude-haiku");
    expect(r.started_at).toBe("2026-01-01T05:00:00.000Z");
  });
});
