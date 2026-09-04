/**
 * test/query/delivery.test.ts — delivery-metrics query (L2a, RV9a).
 *
 * Covers commit-session classification, abandoned-session classification,
 * workspace and window filtering, provisional exclusion, the "neither" bucket
 * (sessions with no tool_events), and the SEC-101 privacy constraint.
 *
 * Time window: 2027-06-01 → 2027-07-01, deliberately distinct from the
 * fixture's 2026-01-01 timestamps so fixture rows never contaminate results.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDeliveryMetrics } from "../../src/query/api/delivery.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const FROM = "2027-06-01T00:00:00.000Z";
const TO = "2027-07-01T00:00:00.000Z";
const TS_IN = "2027-06-15T12:00:00.000Z"; // sits inside [FROM, TO)

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

function insWs(wsId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?,?,?)`,
  ).run(wsId, wsId, FROM);
}

function insSess(sessId: string, wsId: string, ts = TS_IN): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,'RECONCILED',1,0,'[]')`,
  ).run(sessId, wsId, `/fake/${sessId}.jsonl`, ts, ts);
}

/** Insert a turn; provisional=0 by default so it counts in spend aggregates. */
function insTurn(
  msgId: string,
  sessId: string,
  wsId: string,
  ts: string,
  costU: number,
  provisional = 0,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO turns
       (message_id, session_id, workspace_id, ts, model, is_sidechain,
        input_tokens, output_tokens, cache_read_tokens, cache_write_5m,
        cache_write_1h, cache_write_other, tool_result_bytes,
        pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?,?,?,?,'claude-sonnet',0,100,10,0,0,0,0,NULL,NULL,?,'LIST_EQUIV',?,'test-v1')`,
  ).run(msgId, sessId, wsId, ts, costU, provisional);
}

/** Insert a tool_event; commit_sha=null → not a commit event. */
function insToolEvent(
  eventId: string,
  sessId: string,
  ts: string,
  toolName: string,
  commitSha: string | null = null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
     VALUES (?,?,?,?,?)`,
  ).run(eventId, sessId, ts, toolName, commitSha);
}

// ── No data ───────────────────────────────────────────────────────────────────

describe("getDeliveryMetrics — no data", () => {
  it("returns zeros and nulls when no turns fall in the window", () => {
    const resp = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO });
    const m = resp.data;
    if (m === null) throw new Error("expected data, got null");

    expect(m.commit_session_count).toBe(0);
    expect(m.total_session_count).toBe(0);
    expect(m.commit_session_rate).toBeNull();
    expect(m.spend_per_commit_session_u).toBeNull();
    expect(m.abandoned_spend_u).toBe(0);
    expect(m.abandoned_spend_share).toBeNull();
    // Scope is echoed back verbatim.
    expect(m.from).toBe(FROM);
    expect(m.to).toBe(TO);
    expect(m.workspace_id).toBeNull();
  });
});

// ── All commit ────────────────────────────────────────────────────────────────

describe("getDeliveryMetrics — all commit sessions", () => {
  it("rate=1.0 and abandoned_spend_u=0 when every session has a commit SHA", () => {
    insWs("ws-ac");
    // sess-ac1: Bash tool_event WITH commit_sha → commit session
    insSess("sess-ac1", "ws-ac");
    insTurn("msg-ac1", "sess-ac1", "ws-ac", TS_IN, 1000);
    insToolEvent("evt-ac1", "sess-ac1", TS_IN, "Bash", "aaaa1111aaaa1111");

    // sess-ac2: Edit tool_event WITH commit_sha → commit session
    insSess("sess-ac2", "ws-ac");
    insTurn("msg-ac2", "sess-ac2", "ws-ac", TS_IN, 1000);
    insToolEvent("evt-ac2", "sess-ac2", TS_IN, "Edit", "bbbb2222bbbb2222");

    const m = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");

    expect(m.commit_session_count).toBe(2);
    expect(m.total_session_count).toBe(2);
    expect(m.commit_session_rate).toBe(1.0);
    expect(m.abandoned_spend_u).toBe(0);
    // 0 abandoned / 2000 total = 0.0 (not null — denominator > 0)
    expect(m.abandoned_spend_share).toBe(0);
    // mean spend of commit sessions: (1000 + 1000) / 2 = 1000
    expect(m.spend_per_commit_session_u).toBe(1000);
  });
});

// ── Mixed ─────────────────────────────────────────────────────────────────────

describe("getDeliveryMetrics — mixed sessions", () => {
  beforeEach(() => {
    insWs("ws-mix");

    // sess-m1: commit (Bash + commit_sha), spend = 1000
    insSess("sess-m1", "ws-mix");
    insTurn("msg-m1", "sess-m1", "ws-mix", TS_IN, 1000);
    insToolEvent("evt-m1", "sess-m1", TS_IN, "Bash", "commit-sha-m1");

    // sess-m2: commit (Edit + commit_sha), spend = 2000
    insSess("sess-m2", "ws-mix");
    insTurn("msg-m2", "sess-m2", "ws-mix", TS_IN, 2000);
    insToolEvent("evt-m2", "sess-m2", TS_IN, "Edit", "commit-sha-m2");

    // sess-m3: abandoned (Write tool_event, NO commit_sha), spend = 3000
    insSess("sess-m3", "ws-mix");
    insTurn("msg-m3", "sess-m3", "ws-mix", TS_IN, 3000);
    insToolEvent("evt-m3", "sess-m3", TS_IN, "Write", null);
  });

  it("commit_session_rate = 2/3", () => {
    const m = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");
    expect(m.commit_session_count).toBe(2);
    expect(m.total_session_count).toBe(3);
    expect(m.commit_session_rate).toBeCloseTo(2 / 3, 9);
  });

  it("abandoned_spend_u equals the abandoned session's reconciled spend", () => {
    const m = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");
    expect(m.abandoned_spend_u).toBe(3000);
  });

  it("abandoned_spend_share === abandoned_spend_u / total_spend", () => {
    const m = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");
    // total_spend = 1000 + 2000 + 3000 = 6000
    expect(m.abandoned_spend_share).toBeCloseTo(3000 / 6000, 9);
  });

  it("spend_per_commit_session_u = mean spend of commit sessions", () => {
    const m = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");
    expect(m.spend_per_commit_session_u).toBeCloseTo((1000 + 2000) / 2, 6);
  });
});

// ── Workspace filter ──────────────────────────────────────────────────────────

describe("getDeliveryMetrics — workspace filter", () => {
  beforeEach(() => {
    // ws-f1: 2 commit sessions
    insWs("ws-f1");
    insSess("sess-f1a", "ws-f1");
    insTurn("msg-f1a", "sess-f1a", "ws-f1", TS_IN, 1000);
    insToolEvent("evt-f1a", "sess-f1a", TS_IN, "Bash", "sha-f1a");

    insSess("sess-f1b", "ws-f1");
    insTurn("msg-f1b", "sess-f1b", "ws-f1", TS_IN, 500);
    insToolEvent("evt-f1b", "sess-f1b", TS_IN, "Write", "sha-f1b");

    // ws-f2: 1 abandoned session (Edit, no commit_sha)
    insWs("ws-f2");
    insSess("sess-f2a", "ws-f2");
    insTurn("msg-f2a", "sess-f2a", "ws-f2", TS_IN, 2000);
    insToolEvent("evt-f2a", "sess-f2a", TS_IN, "Edit", null);
  });

  it("workspace filter isolates ws-f1 (all commit, 2 sessions)", () => {
    const m = getDeliveryMetrics(db, { workspaceId: "ws-f1", from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");
    expect(m.total_session_count).toBe(2);
    expect(m.commit_session_count).toBe(2);
    expect(m.commit_session_rate).toBe(1.0);
    expect(m.abandoned_spend_u).toBe(0);
    expect(m.workspace_id).toBe("ws-f1");
  });

  it("workspace filter isolates ws-f2 (abandoned only)", () => {
    const m = getDeliveryMetrics(db, { workspaceId: "ws-f2", from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");
    expect(m.total_session_count).toBe(1);
    expect(m.commit_session_count).toBe(0);
    expect(m.commit_session_rate).toBe(0);
    expect(m.abandoned_spend_u).toBe(2000);
    expect(m.workspace_id).toBe("ws-f2");
  });

  it("global query (null workspace_id) aggregates both workspaces", () => {
    const m = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");
    expect(m.total_session_count).toBe(3);
    expect(m.commit_session_count).toBe(2);
    expect(m.workspace_id).toBeNull();
  });
});

// ── Window filter ─────────────────────────────────────────────────────────────

describe("getDeliveryMetrics — window filter", () => {
  beforeEach(() => {
    insWs("ws-win");

    // Turn BEFORE the lower bound (excluded)
    insSess("sess-w-early", "ws-win", "2027-05-31T23:59:59.999Z");
    insTurn("msg-w-early", "sess-w-early", "ws-win", "2027-05-31T23:59:59.999Z", 1000);
    insToolEvent("evt-w-early", "sess-w-early", "2027-05-31T23:59:59.999Z", "Bash", "sha-early");

    // Turn INSIDE the window (included)
    insSess("sess-w-in", "ws-win", TS_IN);
    insTurn("msg-w-in", "sess-w-in", "ws-win", TS_IN, 2000);
    insToolEvent("evt-w-in", "sess-w-in", TS_IN, "Bash", "sha-in");

    // Turn AT the upper bound TO (exclusive — ts < TO → this is excluded)
    insSess("sess-w-late", "ws-win", TO);
    insTurn("msg-w-late", "sess-w-late", "ws-win", TO, 3000);
    insToolEvent("evt-w-late", "sess-w-late", TO, "Bash", "sha-late");
  });

  it("[from, to) window includes ts >= from and excludes ts >= to", () => {
    const m = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");
    // Only sess-w-in falls within the half-open window.
    expect(m.total_session_count).toBe(1);
    expect(m.commit_session_count).toBe(1);
    expect(m.commit_session_rate).toBe(1.0);
  });
});

// ── Neither bucket: sessions with turns but no tool_events ───────────────────

describe("getDeliveryMetrics — sessions with no tool_events", () => {
  it("session with turns but zero tool_events counts in total_session_count " +
    "and the spend denominator, but is neither commit nor abandoned", () => {
    insWs("ws-nt");

    // sess-nt-notool: turn in window, zero tool_events → neither
    insSess("sess-nt-notool", "ws-nt");
    insTurn("msg-nt-notool", "sess-nt-notool", "ws-nt", TS_IN, 500);

    // sess-nt-commit: turn + commit tool_event → commit
    insSess("sess-nt-commit", "ws-nt");
    insTurn("msg-nt-commit", "sess-nt-commit", "ws-nt", TS_IN, 1000);
    insToolEvent("evt-nt-commit", "sess-nt-commit", TS_IN, "Bash", "sha-nt");

    const m = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");

    // Both sessions present in total.
    expect(m.total_session_count).toBe(2);
    // Only the commit session is counted as a commit.
    expect(m.commit_session_count).toBe(1);
    expect(m.commit_session_rate).toBe(0.5); // 1/2; exactly representable
    // No abandoned sessions.
    expect(m.abandoned_spend_u).toBe(0);
    // total_spend = 500 + 1000 = 1500; abandoned = 0 → share = 0.0 (not null)
    expect(m.abandoned_spend_share).toBe(0);
    // spend_per_commit_session only counts the commit session.
    expect(m.spend_per_commit_session_u).toBe(1000);
  });
});

// ── Provisional exclusion ─────────────────────────────────────────────────────

describe("getDeliveryMetrics — provisional exclusion", () => {
  it("provisional=1 turns are excluded from spend aggregates (reconciled turns only)", () => {
    insWs("ws-pv");
    insSess("sess-pv", "ws-pv");
    // Reconciled turn → counted in spend
    insTurn("msg-pv-rec", "sess-pv", "ws-pv", TS_IN, 1000, 0);
    // Provisional turn → must NOT count in spend (same session, in-window ts)
    insTurn("msg-pv-live", "sess-pv", "ws-pv", TS_IN, 5000, 1);
    // Commit tool_event → session is classified as commit
    insToolEvent("evt-pv-commit", "sess-pv", TS_IN, "Bash", "sha-pv");

    const m = getDeliveryMetrics(db, { workspaceId: null, from: FROM, to: TO }).data;
    if (m === null) throw new Error("expected data");

    expect(m.commit_session_count).toBe(1);
    // Only the reconciled 1000 μUSD turn contributes.
    expect(m.spend_per_commit_session_u).toBe(1000);
    // Total spend denominator also only counts reconciled turn.
    expect(m.abandoned_spend_u).toBe(0);
    // abandoned_share: 0 / 1000 = 0 (not null — denominator > 0)
    expect(m.abandoned_spend_share).toBe(0);
  });
});

// ── SEC-101 privacy constraint ─────────────────────────────────────────────────

describe("getDeliveryMetrics — SEC-101 privacy constraint", () => {
  it("payload contains only counts, ratios, integer spend, and echoed scope — " +
    "no raw commit SHA, session ID, or tool-name free text", () => {
    const COMMIT_SHA = "deadbeef1234567890abcdef12345678";
    const SESSION_ID = "sess-sec101-private";

    insWs("ws-sec");
    insSess(SESSION_ID, "ws-sec");
    insTurn(`msg-${SESSION_ID}`, SESSION_ID, "ws-sec", TS_IN, 1000);
    insToolEvent(`evt-${SESSION_ID}`, SESSION_ID, TS_IN, "Bash", COMMIT_SHA);

    const resp = getDeliveryMetrics(db, { workspaceId: "ws-sec", from: FROM, to: TO });
    const m = resp.data;
    if (m === null) throw new Error("expected data");

    const serialized = JSON.stringify(m);

    // No commit SHA in the payload.
    expect(serialized).not.toContain(COMMIT_SHA);
    // No raw session_id in the payload.
    expect(serialized).not.toContain(SESSION_ID);
    // No tool_name free text in the payload.
    expect(serialized).not.toContain("Bash");

    // Metric fields are numeric (or null); string fields are the echoed scope only.
    expect(typeof m.commit_session_count).toBe("number");
    expect(typeof m.total_session_count).toBe("number");
    expect(typeof m.abandoned_spend_u).toBe("number");
    expect(typeof m.from).toBe("string");
    expect(typeof m.to).toBe("string");
    // workspace_id echoes back the filter value — not a raw DB id leak.
    expect(m.workspace_id).toBe("ws-sec");
    // Ratios are number or null — never a raw string.
    const rateIsNumericOrNull =
      m.commit_session_rate === null || typeof m.commit_session_rate === "number";
    expect(rateIsNumericOrNull).toBe(true);
  });
});
