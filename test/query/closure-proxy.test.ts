/**
 * test/query/closure-proxy.test.ts — EF2 non-artifact closure proxy.
 *
 * Covers: per-session status (RESOLVED, UNRESOLVED, PENDING, EXCLUDED),
 * aggregate getClosureProxy counts and resolved_share, and the SEC-101
 * privacy constraint (no session id in the payload).
 *
 * Uses createInMemoryFixtureDb (same pattern as delivery.test.ts). The seed
 * data lives in ws-alpha / ws-beta (2026 timestamps). Aggregate tests always
 * supply a specific workspaceId to avoid contamination from seeded sessions.
 *
 * Base timestamp: 2027-07-01T00:00:00.000Z
 *
 * Mix-workspace timeline (now = BASE+120h):
 *   addH(0)  : sess-mix-r last_turn_at  → matured (120h), no followup in (0h, 48h] → RESOLVED
 *   addH(50) : sess-mix-u last_turn_at  → matured (70h), followup at addH(60) in window → UNRESOLVED
 *   addH(60) : sess-mix-u-fp (COMMIT)   → EXCLUDED from candidates; within sess-mix-u's window
 *   addH(80) : sess-mix-p last_turn_at  → NOT matured (40h < 48h) → PENDING
 *   sess-mix-c (COMMIT)                 → EXCLUDED from no-commit count
 *
 * Cross-contamination check:
 *   sess-mix-r window: (addH(0), addH(48)]. Candidates addH(50), addH(60), addH(80)
 *   are all > addH(48) → do NOT trigger UNRESOLVED for sess-mix-r. ✓
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getClosureProxy, getSessionClosureStatus } from "../../src/query/api/effectiveness.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const BASE = "2027-07-01T00:00:00.000Z";
const BASE_MS = Date.parse(BASE);

/** Return an ISO string at BASE + h hours. */
function addH(h: number): string {
  return new Date(BASE_MS + h * 3_600_000).toISOString();
}

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
});

afterEach(() => {
  db.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function insWs(wsId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?,?,?)`,
  ).run(wsId, wsId, BASE);
}

function insSess(
  sessId: string,
  wsId: string,
  firstTurnAt: string,
  lastTurnAt: string,
  state = "RECONCILED",
): void {
  db.prepare(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES (?,?,?,?,?,?,1,0,'[]')`,
  ).run(sessId, wsId, `/fake/${sessId}.jsonl`, firstTurnAt, lastTurnAt, state);
}

function insCommitEvent(sessId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
     VALUES (?,?,?,'Bash','aaaa1111aaaa1111')`,
  ).run(`evt-commit-${sessId}`, sessId, BASE);
}

// ── Per-session: UNRESOLVED ───────────────────────────────────────────────────

describe("getSessionClosureStatus — UNRESOLVED", () => {
  const WS = "ws-cps-unresolved";
  const SESS = "sess-cps-unresolved";
  const FP = "sess-cps-fp-unresolved";

  beforeEach(() => {
    insWs(WS);
    // No-commit RECONCILED session, last_turn_at = BASE
    insSess(SESS, WS, BASE, BASE);
    // Follow-up session in same workspace: first_turn_at = BASE+12h (inside 48h window)
    insSess(FP, WS, addH(12), addH(12));
  });

  it("returns UNRESOLVED: matured (now=L+50h >= L+48h), follow-up exists at L+12h", () => {
    expect(getSessionClosureStatus(db, SESS, { now: addH(50) })).toBe("UNRESOLVED");
  });
});

// ── Per-session: RESOLVED ─────────────────────────────────────────────────────

describe("getSessionClosureStatus — RESOLVED", () => {
  const WS = "ws-cps-resolved";
  const SESS = "sess-cps-resolved";
  const FP = "sess-cps-fp-resolved";

  beforeEach(() => {
    insWs(WS);
    // No-commit RECONCILED session, last_turn_at = BASE
    insSess(SESS, WS, BASE, BASE);
    // Only follow-up at BASE+60h — outside the 48h window
    insSess(FP, WS, addH(60), addH(60));
  });

  it("returns RESOLVED: matured (now=L+70h), only follow-up at L+60h is outside window", () => {
    expect(getSessionClosureStatus(db, SESS, { now: addH(70) })).toBe("RESOLVED");
  });
});

// ── Per-session: PENDING ──────────────────────────────────────────────────────

describe("getSessionClosureStatus — PENDING", () => {
  const WS = "ws-cps-pending";
  const SESS = "sess-cps-pending";

  beforeEach(() => {
    insWs(WS);
    insSess(SESS, WS, BASE, BASE);
  });

  it("returns PENDING: now=L+12h is within the 48h maturity window", () => {
    expect(getSessionClosureStatus(db, SESS, { now: addH(12) })).toBe("PENDING");
  });
});

// ── Per-session: EXCLUDED ─────────────────────────────────────────────────────

describe("getSessionClosureStatus — EXCLUDED", () => {
  const WS = "ws-cps-excluded";
  const SESS = "sess-cps-excluded";

  beforeEach(() => {
    insWs(WS);
    insSess(SESS, WS, BASE, BASE);
    insCommitEvent(SESS);
  });

  it("returns EXCLUDED for a session that reached a commit", () => {
    expect(getSessionClosureStatus(db, SESS, { now: addH(50) })).toBe("EXCLUDED");
  });
});

// ── Aggregate: getClosureProxy — mix ─────────────────────────────────────────
//
// All aggregate tests use a workspace filter to avoid contamination from the
// seeded ws-alpha / ws-beta sessions (which are no-commit RECONCILED).
//
// Workspace layout (WS = "ws-cp-mix"):
//   sess-mix-r   no-commit RECONCILED, last_turn_at=addH(0)
//                window (addH(0), addH(48)]. All other sessions start >= addH(50)
//                so none fall in this range → RESOLVED when now=addH(120).
//   sess-mix-u   no-commit RECONCILED, last_turn_at=addH(50)
//                window (addH(50), addH(98)]. sess-mix-u-fp at addH(60) is inside
//                → UNRESOLVED when now=addH(120).
//   sess-mix-u-fp COMMIT, first_turn_at=addH(60) → EXCLUDED from candidates;
//                serves as follow-up for sess-mix-u.
//   sess-mix-p   no-commit RECONCILED, last_turn_at=addH(80)
//                Elapsed at now=addH(120): 40h < 48h → PENDING.
//   sess-mix-c   COMMIT → EXCLUDED from no-commit count.

describe("getClosureProxy — mix of RESOLVED / UNRESOLVED / PENDING / EXCLUDED", () => {
  const WS = "ws-cp-mix";

  beforeEach(() => {
    insWs(WS);
    insSess("sess-mix-r", WS, addH(-24), addH(0));
    insSess("sess-mix-u", WS, addH(50), addH(50));
    insSess("sess-mix-u-fp", WS, addH(60), addH(60));
    insCommitEvent("sess-mix-u-fp");
    insSess("sess-mix-p", WS, addH(80), addH(80));
    insSess("sess-mix-c", WS, BASE, BASE);
    insCommitEvent("sess-mix-c");
  });

  it("no_commit_session_count=3, resolved=1, unresolved=1, pending=1", () => {
    const d = getClosureProxy(db, { workspaceId: WS, now: addH(120) }).data;
    if (d === null) throw new Error("expected data, got null");

    expect(d.no_commit_session_count).toBe(3);
    expect(d.resolved_count).toBe(1);
    expect(d.unresolved_count).toBe(1);
    expect(d.pending_count).toBe(1);
  });

  it("resolved_share = resolved / (resolved + unresolved) = 0.5", () => {
    const d = getClosureProxy(db, { workspaceId: WS, now: addH(120) }).data;
    if (d === null) throw new Error("expected data");
    expect(d.resolved_share).toBeCloseTo(0.5, 9);
  });

  it("resolved_share is null when no sessions have matured (all PENDING)", () => {
    // now = addH(12): elapsed since addH(0) is 12h < 48h → ALL PENDING
    const d = getClosureProxy(db, { workspaceId: WS, now: addH(12) }).data;
    if (d === null) throw new Error("expected data");
    expect(d.pending_count).toBeGreaterThanOrEqual(1);
    expect(d.resolved_count).toBe(0);
    expect(d.unresolved_count).toBe(0);
    expect(d.resolved_share).toBeNull();
  });

  it("echoes window_hours=48 and workspace_id", () => {
    const d = getClosureProxy(db, { workspaceId: WS, now: addH(120) }).data;
    if (d === null) throw new Error("expected data");
    expect(d.window_hours).toBe(48);
    expect(d.workspace_id).toBe(WS);
  });

  it("claim_kind is EXPERIMENTAL", () => {
    const resp = getClosureProxy(db, { workspaceId: WS, now: addH(120) });
    expect(resp.meta.claim_kind).toBe("EXPERIMENTAL");
  });

  it("qualification note mentions windowHours and PENDING", () => {
    const resp = getClosureProxy(db, { workspaceId: WS, now: addH(120) });
    expect(resp.meta.qualification.note).toContain("48h");
    expect(resp.meta.qualification.note).toContain("PENDING until the window elapses");
  });

  it("windowHours=72 changes note and threshold", () => {
    // Only sess-mix-r is matured at now=addH(120) with 72h window:
    //   sess-mix-r: 120h elapsed >= 72h → matured; no followup in (addH(0), addH(72)].
    //     sess-mix-u first_turn_at=addH(50): 50 <= 72 → IS in window → sess-mix-r becomes UNRESOLVED.
    //   Wait: addH(50) <= addH(0)+72h=addH(72)? Yes. addH(50) > addH(0)? Yes → UNRESOLVED for r.
    //   sess-mix-u: 120-50=70h < 72h → PENDING.
    //   sess-mix-p: 120-80=40h < 72h → PENDING.
    //
    // So with windowHours=72, now=addH(120):
    //   sess-mix-r: UNRESOLVED (follow-up sess-mix-u at addH(50) inside 72h window)
    //   sess-mix-u: PENDING
    //   sess-mix-p: PENDING
    //   → resolved=0, unresolved=1, pending=2, resolved_share=null (0/1=0 ≠ null)
    // Actually resolved_share = 0/(0+1) = 0.0 not null.
    const resp = getClosureProxy(db, { workspaceId: WS, now: addH(120), windowHours: 72 });
    expect(resp.meta.qualification.note).toContain("72h");
    expect(resp.data?.window_hours).toBe(72);
  });
});

// ── getSessionClosureStatus — matches aggregate classification ─────────────────

describe("getSessionClosureStatus — matches aggregate classification for mix", () => {
  const WS = "ws-cps-mix";

  beforeEach(() => {
    insWs(WS);
    insSess("sess-cps-mix-r", WS, addH(-24), addH(0));
    insSess("sess-cps-mix-u", WS, addH(50), addH(50));
    insSess("sess-cps-mix-u-fp", WS, addH(60), addH(60));
    insCommitEvent("sess-cps-mix-u-fp");
    insSess("sess-cps-mix-p", WS, addH(80), addH(80));
    insSess("sess-cps-mix-c", WS, BASE, BASE);
    insCommitEvent("sess-cps-mix-c");
  });

  it("sess-cps-mix-r → RESOLVED", () => {
    expect(getSessionClosureStatus(db, "sess-cps-mix-r", { now: addH(120) })).toBe("RESOLVED");
  });

  it("sess-cps-mix-u → UNRESOLVED", () => {
    expect(getSessionClosureStatus(db, "sess-cps-mix-u", { now: addH(120) })).toBe("UNRESOLVED");
  });

  it("sess-cps-mix-p → PENDING (last_turn at addH(80), 40h < 48h)", () => {
    expect(getSessionClosureStatus(db, "sess-cps-mix-p", { now: addH(120) })).toBe("PENDING");
  });

  it("sess-cps-mix-c → EXCLUDED (commit session)", () => {
    expect(getSessionClosureStatus(db, "sess-cps-mix-c", { now: addH(120) })).toBe("EXCLUDED");
  });
});

// ── SEC-101 privacy constraint ────────────────────────────────────────────────

describe("getClosureProxy — SEC-101 privacy constraint", () => {
  it("JSON.stringify(resp.data) contains no session id", () => {
    const WS = "ws-cp-sec101";
    const SESS_ID = "sess-sec101-private-closure";

    insWs(WS);
    insSess(SESS_ID, WS, BASE, BASE);

    const resp = getClosureProxy(db, { workspaceId: WS, now: addH(70) });
    const d = resp.data;
    if (d === null) throw new Error("expected data");

    const serialized = JSON.stringify(d);
    // No session id in the serialized payload.
    expect(serialized).not.toContain(SESS_ID);

    // workspace_id echoes the caller-supplied filter value — not a session id.
    expect(d.workspace_id).toBe(WS);
    // All numeric fields are numbers (or null).
    expect(typeof d.no_commit_session_count).toBe("number");
    expect(typeof d.resolved_count).toBe("number");
    expect(typeof d.unresolved_count).toBe("number");
    expect(typeof d.pending_count).toBe("number");
    expect(typeof d.window_hours).toBe("number");
    const shareIsNumericOrNull = d.resolved_share === null || typeof d.resolved_share === "number";
    expect(shareIsNumericOrNull).toBe(true);
  });
});
