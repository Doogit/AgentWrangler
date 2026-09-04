/**
 * test/outcomes/linker.test.ts — OutcomeLinker: linkage precedence + manual.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  FrozenTranscriptEntry,
  StrictTranscriptHarvestResult,
} from "../../src/evidence/r3/transcript.js";
import { harvestFrozenTranscript } from "../../src/evidence/r3/transcript.js";
import { fingerprintBranchRef } from "../../src/outcomes/branch-key.js";
import { GithubSyncClient } from "../../src/outcomes/github/client.js";
import {
  evaluateBranchLinksShadow,
  linkSessions,
  manualLink,
  manualUnlink,
  snapshotSessionWorkLinks,
} from "../../src/outcomes/linker.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Scratchpad for synthetic JSONL files — portable tmp dir (Windows + POSIX CI)
const SCRATCH = path.join(os.tmpdir(), "aw-linker-test");

function ensureScratch() {
  fs.mkdirSync(SCRATCH, { recursive: true });
}

function writePrLink(filename: string, prNumber: number, prRepo: string): string {
  ensureScratch();
  const p = path.join(SCRATCH, filename);
  fs.writeFileSync(
    p,
    `{"type":"summary","sessionId":"test"}\n{"type":"pr-link","prNumber":${prNumber},"prRepository":"${prRepo}"}\n`,
    "utf-8",
  );
  return p;
}

function writeTranscript(filename: string, records: Array<Record<string, unknown>>): string {
  ensureScratch();
  const p = path.join(SCRATCH, filename);
  fs.writeFileSync(p, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
  return p;
}

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  // Ensure tool_event exists for sess-a1 (RECONCILED + Bash)
  db.prepare(
    `INSERT OR IGNORE INTO tool_events (event_id, session_id, ts, tool_name)
     VALUES ('te-a1', 'sess-a1', '2026-01-01T00:00:00Z', 'Bash')`,
  ).run();
  // Add workspace mapping
  db.prepare(
    "UPDATE workspaces SET repo_owner='acme', repo_name='repo-alpha' WHERE workspace_id='ws-alpha'",
  ).run();
});

afterEach(() => {
  db.close();
  // Clean up scratch files
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

const disabledClient = new GithubSyncClient({ ok: false, reason: "no-token" });

describe("evaluateBranchLinksShadow", () => {
  function disableSeedSession(): void {
    db.prepare("UPDATE sessions SET state='LIVE' WHERE session_id='sess-a1'").run();
  }

  function addSession(
    sessionId: string,
    workspaceId: string,
    records: Array<Record<string, unknown>>,
  ) {
    const filePath = writeTranscript(`${sessionId}.jsonl`, records);
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
         'RECONCILED', 1, 0, '[]')`,
    ).run(sessionId, workspaceId, filePath);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name)
       VALUES (?, ?, '2026-01-01T00:00:00Z', 'Bash')`,
    ).run(`te-${sessionId}`, sessionId);
  }

  function addWorkItem(
    workItemId: string,
    workspaceId: string,
    number: number,
    branchRef: string,
  ): void {
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES (?, ?, ?, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run(workItemId, workspaceId, number);
    db.prepare(
      `INSERT INTO work_item_branch_keys
         (work_item_id, head_ref_key, normalization_version, synced_at)
       VALUES (?, ?, 'branch-v1', '2026-01-01T00:00:00Z')`,
    ).run(workItemId, fingerprintBranchRef(branchRef));
  }

  it("off returns before SQL when the branch table is absent", async () => {
    db.exec("DROP TABLE work_item_branch_keys");
    await expect(evaluateBranchLinksShadow(db)).resolves.toMatchObject({
      mode: "off",
      sessionsEvaluated: 0,
      evaluations: [],
    });
  });

  it("keeps the production linker independent of the branch table", async () => {
    db.exec("DROP TABLE work_item_branch_keys");
    await expect(linkSessions(db, disabledClient)).resolves.toBeUndefined();
  });

  it("bounds per-session keys and classifies absent, invalid, repeated, and multiple refs", async () => {
    disableSeedSession();
    addSession("sess-none", "ws-alpha", [{ type: "summary" }]);
    addSession("sess-invalid", "ws-alpha", [{ gitBranch: "HEAD" }]);
    addSession(
      "sess-repeated",
      "ws-alpha",
      Array.from({ length: 40 }, () => ({ gitBranch: "feature/repeated" })),
    );
    addSession("sess-multiple", "ws-alpha", [
      { gitBranch: "feature/one" },
      { gitBranch: "feature/two" },
      { gitBranch: "feature/three" },
    ]);
    // Anchor ws-alpha as evidence-bearing (a non-matching work item) so its sessions
    // stay in the corpus under the §5G work_items filter; matches none of the above.
    addWorkItem("gh:acme/repo-alpha#900", "ws-alpha", 900, "feature/evidence-anchor");

    const report = await evaluateBranchLinksShadow(db, "shadow");
    expect(
      report.evaluations.map(({ sessionId, candidateReason }) => [sessionId, candidateReason]),
    ).toEqual([
      ["sess-invalid", "NO_VALID_SESSION_KEY"],
      ["sess-multiple", "MULTIPLE_SESSION_KEYS"],
      ["sess-none", "NO_VALID_SESSION_KEY"],
      ["sess-repeated", "NO_MATCHING_WORK_ITEM_KEY"],
    ]);
    expect(report.candidateReasonCounts).toEqual({
      NO_VALID_SESSION_KEY: 2,
      MULTIPLE_SESSION_KEYS: 1,
      NO_MATCHING_WORK_ITEM_KEY: 1,
      DUPLICATE_WORKSPACE_MATCH: 0,
      UNIQUE_CANDIDATE: 0,
    });
  });

  it("scopes exact matches to the workspace and abstains on reused fork refs", async () => {
    disableSeedSession();
    db.prepare(
      "UPDATE workspaces SET repo_owner='other', repo_name='repo-beta' WHERE workspace_id='ws-beta'",
    ).run();
    addSession("sess-zero", "ws-alpha", [{ gitBranch: "feature/zero" }]);
    addSession("sess-unique", "ws-alpha", [{ gitBranch: "feature/unique" }]);
    addSession("sess-duplicate", "ws-alpha", [{ gitBranch: "feature/reused" }]);
    addSession("sess-cross", "ws-alpha", [{ gitBranch: "feature/cross-workspace" }]);
    addSession("sess-stale-only", "ws-alpha", [{ gitBranch: "feature/stale-only" }]);
    addSession("sess-stale-current", "ws-alpha", [{ gitBranch: "feature/stale-current" }]);
    addWorkItem("gh:acme/repo-alpha#1", "ws-alpha", 1, "feature/unique");
    addWorkItem("gh:acme/repo-alpha#2", "ws-alpha", 2, "feature/reused");
    addWorkItem("gh:acme/repo-alpha#3", "ws-alpha", 3, "feature/reused");
    addWorkItem("gh:acme/repo-alpha#4", "ws-alpha", 4, "feature/cross-workspace");
    addWorkItem("gh:other/repo-beta#5", "ws-beta", 5, "feature/cross-workspace");
    addWorkItem("gh:old/repo#6", "ws-alpha", 6, "feature/stale-only");
    addWorkItem("gh:old/repo#7", "ws-alpha", 7, "feature/stale-current");
    addWorkItem("gh:acme/repo-alpha#8", "ws-alpha", 8, "feature/stale-current");

    const report = await evaluateBranchLinksShadow(db, "shadow");
    const bySession = Object.fromEntries(report.evaluations.map((row) => [row.sessionId, row]));
    expect(bySession["sess-zero"]).toMatchObject({
      candidateReason: "NO_MATCHING_WORK_ITEM_KEY",
      candidateWorkItemId: null,
    });
    expect(bySession["sess-unique"]).toMatchObject({
      candidateReason: "UNIQUE_CANDIDATE",
      candidateWorkItemId: "gh:acme/repo-alpha#1",
    });
    expect(bySession["sess-duplicate"]).toMatchObject({
      candidateReason: "DUPLICATE_WORKSPACE_MATCH",
      candidateWorkItemId: null,
    });
    expect(bySession["sess-cross"]).toMatchObject({
      candidateReason: "UNIQUE_CANDIDATE",
      candidateWorkItemId: "gh:acme/repo-alpha#4",
    });
    expect(bySession["sess-stale-only"]).toMatchObject({
      candidateReason: "NO_MATCHING_WORK_ITEM_KEY",
      candidateWorkItemId: null,
    });
    expect(bySession["sess-stale-current"]).toMatchObject({
      candidateReason: "UNIQUE_CANDIDATE",
      candidateWorkItemId: "gh:acme/repo-alpha#8",
    });
  });

  it("applies harvested PR_LINK precedence without an accepted-link row", async () => {
    disableSeedSession();
    addSession("sess-harvested-pr", "ws-alpha", [
      {
        type: "pr-link",
        prNumber: 30,
        prRepository: "acme/repo-alpha",
        gitBranch: "feature/shadow-candidate",
      },
    ]);
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#30', 'ws-alpha', 30, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();
    addWorkItem("gh:acme/repo-alpha#31", "ws-alpha", 31, "feature/shadow-candidate");
    const snapshotSql = `SELECT session_id, work_item_id, confidence, method
                         FROM session_work_links ORDER BY session_id, work_item_id`;
    const before = db.prepare(snapshotSql).all();

    const report = await evaluateBranchLinksShadow(db, "shadow");
    const after = db.prepare(snapshotSql).all();

    expect(report.evaluations).toEqual([
      {
        sessionId: "sess-harvested-pr",
        candidateWorkItemId: "gh:acme/repo-alpha#31",
        candidateReason: "UNIQUE_CANDIDATE",
        disposition: "HIGHER_PRECEDENCE",
        excludedBy: "PR_LINK",
      },
    ]);
    expect(after).toEqual(before);
  });

  it("evaluates candidates independently then applies exact precedence", async () => {
    disableSeedSession();
    addWorkItem("gh:acme/repo-alpha#10", "ws-alpha", 10, "feature/precedence");
    for (const method of ["MANUAL", "PR_LINK", "SHA_OVERLAP"] as const) {
      const sessionId = `sess-${method.toLowerCase()}`;
      addSession(sessionId, "ws-alpha", [{ gitBranch: "feature/precedence" }]);
      db.prepare(
        `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
         VALUES (?, 'gh:acme/repo-alpha#10', 1.0, ?)`,
      ).run(sessionId, method);
    }
    addSession("sess-all-precedence", "ws-alpha", [{ gitBranch: "feature/precedence" }]);
    for (const [index, method] of ["SHA_OVERLAP", "PR_LINK", "MANUAL"].entries()) {
      const workItemId = `gh:acme/repo-alpha#${11 + index}`;
      db.prepare(
        `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
         VALUES (?, 'ws-alpha', ?, 'MERGED', '2026-01-01T00:00:00Z')`,
      ).run(workItemId, 11 + index);
      db.prepare(
        `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
         VALUES ('sess-all-precedence', ?, 1.0, ?)`,
      ).run(workItemId, method);
    }

    const report = await evaluateBranchLinksShadow(db, "shadow");
    const bySession = Object.fromEntries(report.evaluations.map((row) => [row.sessionId, row]));
    for (const method of ["MANUAL", "PR_LINK", "SHA_OVERLAP"] as const) {
      expect(bySession[`sess-${method.toLowerCase()}`]).toMatchObject({
        candidateReason: "UNIQUE_CANDIDATE",
        disposition: "HIGHER_PRECEDENCE",
        excludedBy: method,
      });
    }
    expect(bySession["sess-all-precedence"]).toMatchObject({
      candidateReason: "UNIQUE_CANDIDATE",
      disposition: "HIGHER_PRECEDENCE",
      excludedBy: "MANUAL",
    });
  });

  it("is read-only, emits no BRANCH rows, and exposes no raw ref or path", async () => {
    disableSeedSession();
    const rawRef = "private/operator-only-branch";
    addSession("sess-readonly", "ws-alpha", [{ gitBranch: rawRef }]);
    addWorkItem("gh:acme/repo-alpha#20", "ws-alpha", 20, rawRef);
    db.prepare(
      `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
       VALUES ('sess-readonly', 'gh:acme/repo-alpha#20', 0.7, 'PR_LINK')`,
    ).run();
    const snapshotSql = `SELECT session_id, work_item_id, confidence, method
                         FROM session_work_links ORDER BY session_id, work_item_id`;
    const before = db.prepare(snapshotSql).all();

    const report = await evaluateBranchLinksShadow(db, "shadow");
    const after = db.prepare(snapshotSql).all();

    expect(after).toEqual(before);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM session_work_links WHERE method='BRANCH'").get(),
    ).toEqual({ n: 0 });
    const output = JSON.stringify(report);
    expect(output).not.toContain(rawRef);
    expect(output).not.toContain(SCRATCH);
    expect(output).not.toContain(fingerprintBranchRef(rawRef));
  });

  it("uses an injected strict corpus harvester, reports exact failures, and leaves links unchanged", async () => {
    disableSeedSession();
    for (const suffix of ["success", "missing", "unreadable", "replaced", "changed"] as const) {
      addSession(`sess-${suffix}`, "ws-alpha", [{ gitBranch: `ignored/${suffix}` }]);
    }
    addWorkItem("gh:acme/repo-alpha#60", "ws-alpha", 60, "feature/attested");
    db.prepare(
      `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
       VALUES ('sess-success', 'gh:acme/repo-alpha#60', 0.75, 'SHA_OVERLAP')`,
    ).run();

    const entry = (sessionId: string, label: string): FrozenTranscriptEntry => ({
      sessionId,
      path: (
        db.prepare("SELECT file_path FROM sessions WHERE session_id = ?").get(sessionId) as {
          file_path: string;
        }
      ).file_path,
      identity: { device: "1", inode: label, size: "10" },
      sha256: "a".repeat(64),
    });
    const entries = new Map([
      ["sess-success", entry("sess-success", "success")],
      ["sess-unreadable", entry("sess-unreadable", "unreadable")],
      ["sess-replaced", entry("sess-replaced", "replaced")],
      ["sess-changed", entry("sess-changed", "changed")],
    ]);
    const harvest = async (
      frozen: FrozenTranscriptEntry,
    ): Promise<StrictTranscriptHarvestResult> => {
      const label = frozen.identity.inode;
      if (label === "success") {
        return {
          ok: true,
          projection: {
            links: [],
            branchKeys: new Set([fingerprintBranchRef("feature/attested") as string]),
            malformedLines: 2,
          },
        };
      }
      return {
        ok: false,
        reason: label.toUpperCase() as "UNREADABLE" | "REPLACED" | "CHANGED",
      };
    };
    const before = snapshotSessionWorkLinks(db);

    const report = await evaluateBranchLinksShadow(db, "shadow", {
      transcriptEvidence: {
        entryForSession: (sessionId) => entries.get(sessionId),
        harvest,
      },
    });

    expect(report.strictTranscript).toEqual({
      succeeded: 1,
      malformedLines: 2,
      failureReasonCounts: {
        MISSING: 1,
        UNREADABLE: 1,
        REPLACED: 1,
        CHANGED: 1,
        LIMIT_EXCEEDED: 0,
        CORPUS_MISMATCH: 0,
      },
    });
    expect(report.evaluations.find(({ sessionId }) => sessionId === "sess-success")).toMatchObject({
      candidateReason: "UNIQUE_CANDIDATE",
      disposition: "HIGHER_PRECEDENCE",
      excludedBy: "SHA_OVERLAP",
    });
    expect(snapshotSessionWorkLinks(db)).toBe(before);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SCRATCH);
    expect(serialized).not.toContain("feature/attested");
  });

  it("rejects session or recorded-path corpus mismatches before harvesting", async () => {
    disableSeedSession();
    addSession("sess-corpus", "ws-alpha", [{ gitBranch: "ignored" }]);
    // Anchor ws-alpha as evidence-bearing so sess-corpus stays in the corpus (§5G).
    addWorkItem("gh:acme/repo-alpha#901", "ws-alpha", 901, "feature/evidence-anchor");
    const recordedPath = (
      db.prepare("SELECT file_path FROM sessions WHERE session_id = 'sess-corpus'").get() as {
        file_path: string;
      }
    ).file_path;
    let harvestCalls = 0;
    const harvest = async (): Promise<StrictTranscriptHarvestResult> => {
      harvestCalls += 1;
      return {
        ok: true,
        projection: { links: [], branchKeys: new Set(), malformedLines: 0 },
      };
    };

    for (const mismatch of [
      { sessionId: "other-session", path: recordedPath },
      { sessionId: "sess-corpus", path: `${recordedPath}.other` },
    ]) {
      const report = await evaluateBranchLinksShadow(db, "shadow", {
        transcriptEvidence: {
          entryForSession: () => ({
            ...mismatch,
            identity: { device: "1", inode: "2", size: "3" },
            sha256: "a".repeat(64),
          }),
          harvest,
        },
      });
      expect(report.strictTranscript?.failureReasonCounts.CORPUS_MISMATCH).toBe(1);
      expect(JSON.stringify(report)).not.toContain(recordedPath);
      expect(JSON.stringify(report)).not.toContain("other-session");
    }
    expect(harvestCalls).toBe(0);
  });

  it("makes an after-cap valid PR precedence link data-insufficient instead of truncating", async () => {
    disableSeedSession();
    const records = Array.from({ length: 64 }, (_, index) => ({
      type: "pr-link",
      prNumber: index + 1,
      prRepository: "other/repo",
    }));
    records.push({ type: "pr-link", prNumber: 999, prRepository: "acme/repo-alpha" });
    addSession("sess-overflow", "ws-alpha", records);
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#999', 'ws-alpha', 999, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();
    const filePath = (
      db.prepare("SELECT file_path FROM sessions WHERE session_id = 'sess-overflow'").get() as {
        file_path: string;
      }
    ).file_path;
    const stat = fs.statSync(filePath, { bigint: true });
    const frozen: FrozenTranscriptEntry = {
      sessionId: "sess-overflow",
      path: filePath,
      identity: {
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
        size: stat.size.toString(),
      },
      sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
    };

    const report = await evaluateBranchLinksShadow(db, "shadow", {
      transcriptEvidence: {
        entryForSession: () => frozen,
        harvest: harvestFrozenTranscript,
      },
    });

    expect(report.strictTranscript?.failureReasonCounts.LIMIT_EXCEEDED).toBe(1);
    expect(report.evaluations).toEqual([
      {
        sessionId: "sess-overflow",
        candidateWorkItemId: null,
        candidateReason: "NO_VALID_SESSION_KEY",
        disposition: "NO_VALID_SESSION_KEY",
        excludedBy: null,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain(filePath);
  });

  it("canonically snapshots every accepted link in exact row order", () => {
    addWorkItem("gh:acme/repo-alpha#70", "ws-alpha", 70, "feature/70");
    addWorkItem("gh:acme/repo-alpha#71", "ws-alpha", 71, "feature/71");
    db.prepare(
      `INSERT INTO session_work_links (session_id, work_item_id, confidence, method)
       VALUES ('sess-a1', 'gh:acme/repo-alpha#71', 0.6, 'BRANCH'),
              ('sess-a1', 'gh:acme/repo-alpha#70', 1.0, 'MANUAL')`,
    ).run();

    expect(snapshotSessionWorkLinks(db)).toBe(
      JSON.stringify([
        ["sess-a1", "gh:acme/repo-alpha#70", 1, "MANUAL"],
        ["sess-a1", "gh:acme/repo-alpha#71", 0.6, "BRANCH"],
      ]),
    );
  });
});

describe("manualLink / manualUnlink", () => {
  it("inserts MANUAL link", async () => {
    // Insert a work_item first
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#1', 'ws-alpha', 1, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();
    manualLink(db, "sess-a1", "gh:acme/repo-alpha#1");
    const row = db
      .prepare("SELECT method FROM session_work_links WHERE session_id='sess-a1'")
      .get() as { method: string } | undefined;
    expect(row?.method).toBe("MANUAL");
  });

  it("unlink removes MANUAL row only", async () => {
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#1', 'ws-alpha', 1, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();
    manualLink(db, "sess-a1", "gh:acme/repo-alpha#1");
    manualUnlink(db, "sess-a1", "gh:acme/repo-alpha#1");
    const row = db
      .prepare("SELECT method FROM session_work_links WHERE session_id='sess-a1'")
      .get();
    expect(row).toBeUndefined();
  });
});

describe("linkSessions — PR_LINK", () => {
  it("links via PR_LINK when transcript has pr-link record", async () => {
    // Write a synthetic transcript for sess-a1
    const filePath = writePrLink("sess-a1.jsonl", 99, "acme/repo-alpha");
    db.prepare("UPDATE sessions SET file_path=? WHERE session_id='sess-a1'").run(filePath);
    // Insert matching work_item
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#99', 'ws-alpha', 99, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();

    await linkSessions(db, disabledClient);

    const row = db
      .prepare("SELECT method, confidence FROM session_work_links WHERE session_id='sess-a1'")
      .get() as { method: string; confidence: number } | undefined;
    expect(row?.method).toBe("PR_LINK");
    expect(row?.confidence).toBe(1.0);
  });
});

describe("linkSessions — TRAILER", () => {
  function addWorkItem(number: number): string {
    const workItemId = `gh:acme/repo-alpha#${number}`;
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES (?, 'ws-alpha', ?, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run(workItemId, number);
    return workItemId;
  }

  function response(data: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => "",
      headers: { get: () => null },
    } as unknown as Response;
  }

  it("links via a Claude-Session trailer in a commit message", async () => {
    const workItemId = addWorkItem(401);
    const fetchFn: import("../../src/outcomes/github/client.js").FetchFn = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/401/commits")) {
        return response([
          {
            sha: "trailer-message-sha",
            commit: { message: "Claude-Session: https://claude.ai/code/session_sess-a1" },
          },
        ]);
      }
      return response({ body: "" });
    };

    await linkSessions(db, new GithubSyncClient({ ok: true, data: "tok" }, fetchFn));

    expect(
      db
        .prepare(
          "SELECT work_item_id, method, confidence FROM session_work_links WHERE session_id='sess-a1'",
        )
        .get(),
    ).toEqual({ work_item_id: workItemId, method: "TRAILER", confidence: 1 });
  });

  it("links via a Claude-Session trailer in the PR body", async () => {
    const workItemId = addWorkItem(402);
    const fetchFn: import("../../src/outcomes/github/client.js").FetchFn = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/402/commits")) {
        return response([{ sha: "trailer-body-sha", commit: { message: "no trailer" } }]);
      }
      return response({ body: "Claude-Session: https://claude.ai/code/session_sess-a1" });
    };

    await linkSessions(db, new GithubSyncClient({ ok: true, data: "tok" }, fetchFn));

    expect(
      db
        .prepare("SELECT method, confidence FROM session_work_links WHERE session_id='sess-a1'")
        .get(),
    ).toEqual({ method: "TRAILER", confidence: 1 });
    expect(
      db.prepare("SELECT work_item_id FROM session_work_links WHERE session_id='sess-a1'").get(),
    ).toEqual({ work_item_id: workItemId });
  });

  it("links via an Agent-Session-Id UUID trailer", async () => {
    db.prepare("UPDATE sessions SET state='LIVE' WHERE session_id='sess-a1'").run();
    const sessionId = "1a2b3c4d-1111-2222-3333-1234567890ab";
    const filePath = writeTranscript("sess-agent-trailer.jsonl", [{ type: "summary" }]);
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, 'ws-alpha', ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
         'RECONCILED', 1, 0, '[]')`,
    ).run(sessionId, filePath);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name)
       VALUES ('te-agent-trailer', ?, '2026-01-01T00:00:00Z', 'Bash')`,
    ).run(sessionId);
    const workItemId = addWorkItem(403);
    const fetchFn: import("../../src/outcomes/github/client.js").FetchFn = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/403/commits")) return response([]);
      return response({ body: `Agent-Session-Id: ${sessionId}` });
    };

    await linkSessions(db, new GithubSyncClient({ ok: true, data: "tok" }, fetchFn));

    expect(
      db
        .prepare(
          "SELECT work_item_id, method, confidence FROM session_work_links WHERE session_id=?",
        )
        .get(sessionId),
    ).toEqual({ work_item_id: workItemId, method: "TRAILER", confidence: 1 });
  });

  it("ignores trailers for an id with no local session", async () => {
    addWorkItem(404);
    const fetchFn: import("../../src/outcomes/github/client.js").FetchFn = async (input) => {
      if (String(input).includes("/pulls/404/commits")) {
        return response([
          {
            sha: "unknown-trailer-sha",
            commit: { message: "Claude-Session: https://claude.ai/code/session_absent-session" },
          },
        ]);
      }
      return response({ body: "" });
    };

    await expect(
      linkSessions(db, new GithubSyncClient({ ok: true, data: "tok" }, fetchFn)),
    ).resolves.toBeUndefined();

    expect(
      db.prepare("SELECT 1 FROM session_work_links WHERE session_id='sess-a1'").get(),
    ).toBeUndefined();
  });

  it("ignores malformed Claude-Session trailers", async () => {
    addWorkItem(405);
    const fetchFn: import("../../src/outcomes/github/client.js").FetchFn = async (input) => {
      if (String(input).includes("/pulls/405/commits")) {
        return response([
          { sha: "malformed-trailer-sha", commit: { message: "Claude-Session: garbage" } },
        ]);
      }
      return response({ body: "" });
    };

    await expect(
      linkSessions(db, new GithubSyncClient({ ok: true, data: "tok" }, fetchFn)),
    ).resolves.toBeUndefined();

    expect(
      db.prepare("SELECT 1 FROM session_work_links WHERE session_id='sess-a1'").get(),
    ).toBeUndefined();
  });
});

describe("linkSessions — SHA_OVERLAP", () => {
  it("links via SHA_OVERLAP when session SHA matches PR commit SHA", async () => {
    // Write empty transcript (no pr-link)
    ensureScratch();
    const filePath = path.join(SCRATCH, "sess-sha.jsonl");
    fs.writeFileSync(filePath, '{"type":"summary"}\n', "utf-8");

    // Add a new session with a Bash tool_event containing a commit_sha
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-sha', 'ws-alpha', ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
         'RECONCILED', 1, 0, '[]')`,
    ).run(filePath);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
       VALUES ('te-sha', 'sess-sha', '2026-01-01T00:00:00Z', 'Bash', 'sha-overlap-xyz')`,
    ).run();

    // Insert a work_item
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#200', 'ws-alpha', 200, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();

    // Client that returns the matching SHA for PR #200 but no trailer.
    let called = false;
    const fetchFn: import("../../src/outcomes/github/client.js").FetchFn = async (input) => {
      called = true;
      if (!String(input).includes("/commits")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ body: "" }),
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ sha: "sha-overlap-xyz", commit: { message: "no trailer" } }],
        text: async () => "",
        headers: { get: () => null },
      } as unknown as Response;
    };
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn);

    await linkSessions(db, client);

    const row = db
      .prepare("SELECT method, confidence FROM session_work_links WHERE session_id='sess-sha'")
      .get() as { method: string; confidence: number } | undefined;
    expect(row?.method).toBe("SHA_OVERLAP");
    expect(row?.confidence).toBeGreaterThan(0.5);
    expect(called).toBe(true);
  });

  it("uses a reverse commit-to-PR lookup when synced PR commits lack the transcript SHA", async () => {
    ensureScratch();
    const filePath = path.join(SCRATCH, "sess-reverse.jsonl");
    fs.writeFileSync(filePath, '{"type":"summary"}\n', "utf-8");
    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-reverse', 'ws-alpha', ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
         'RECONCILED', 1, 0, '[]')`,
    ).run(filePath);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
       VALUES ('te-reverse', 'sess-reverse', '2026-01-01T00:00:00Z', 'Bash', 'reverse-sha')`,
    ).run();
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#210', 'ws-alpha', 210, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();
    const fetchFn: import("../../src/outcomes/github/client.js").FetchFn = async (input) => {
      const url = String(input);
      if (url.includes("/pulls/210/commits")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ sha: "other-sha", commit: { message: "" } }],
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }
      if (url.includes("/commits/reverse-sha/pulls")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ number: 210 }],
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ body: "" }),
        text: async () => "",
        headers: { get: () => null },
      } as unknown as Response;
    };

    await linkSessions(db, new GithubSyncClient({ ok: true, data: "tok" }, fetchFn));

    expect(
      db
        .prepare(
          "SELECT method, confidence FROM session_work_links WHERE session_id='sess-reverse'",
        )
        .get(),
    ).toEqual({ method: "SHA_OVERLAP", confidence: 0.6 });
  });

  it("caps reverse commit-to-PR lookups at 50 per linker cycle", async () => {
    db.prepare("UPDATE sessions SET state='LIVE' WHERE session_id='sess-a1'").run();
    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#220', 'ws-alpha', 220, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();
    for (let index = 0; index < 51; index += 1) {
      const sessionId = `sess-cap-${index}`;
      const filePath = writeTranscript(`${sessionId}.jsonl`, [{ type: "summary" }]);
      db.prepare(
        `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
           state, turn_count, cost_equiv_u, hygiene_flags)
         VALUES (?, 'ws-alpha', ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
           'RECONCILED', 1, 0, '[]')`,
      ).run(sessionId, filePath);
      db.prepare(
        `INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
         VALUES (?, ?, '2026-01-01T00:00:00Z', 'Bash', ?)`,
      ).run(`te-cap-${index}`, sessionId, `cap-sha-${index}`);
    }
    let reverseFetches = 0;
    const fetchFn: import("../../src/outcomes/github/client.js").FetchFn = async (input) => {
      const url = String(input);
      if (/\/commits\/[^/]+\/pulls$/.test(url)) {
        reverseFetches += 1;
        return {
          ok: true,
          status: 200,
          json: async () => [],
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }
      if (url.includes("/pulls/220/commits")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ sha: "unrelated-sha", commit: { message: "" } }],
          text: async () => "",
          headers: { get: () => null },
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ body: "" }),
        text: async () => "",
        headers: { get: () => null },
      } as unknown as Response;
    };

    await linkSessions(db, new GithubSyncClient({ ok: true, data: "tok" }, fetchFn));

    expect(reverseFetches).toBe(50);
  });
});

describe("linkSessions — UNLINKED for ambiguous SHA", () => {
  it("leaves session UNLINKED when the same SHA appears in two PRs", async () => {
    ensureScratch();
    const filePath = path.join(SCRATCH, "sess-ambig.jsonl");
    fs.writeFileSync(filePath, '{"type":"summary"}\n', "utf-8");

    db.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
         state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('sess-ambig', 'ws-alpha', ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z',
         'RECONCILED', 1, 0, '[]')`,
    ).run(filePath);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, commit_sha)
       VALUES ('te-ambig', 'sess-ambig', '2026-01-01T00:00:00Z', 'Bash', 'ambig-sha')`,
    ).run();

    db.prepare(
      `INSERT INTO work_items (work_item_id, workspace_id, number, state, synced_at)
       VALUES ('gh:acme/repo-alpha#301', 'ws-alpha', 301, 'MERGED', '2026-01-01T00:00:00Z'),
              ('gh:acme/repo-alpha#302', 'ws-alpha', 302, 'MERGED', '2026-01-01T00:00:00Z')`,
    ).run();

    // Both PRs return the same SHA → ambiguity
    const fetchFn = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => [{ sha: "ambig-sha" }],
        text: async () => "",
        headers: { get: () => null },
      }) as unknown as Response;
    const client = new GithubSyncClient({ ok: true, data: "tok" }, fetchFn);

    await linkSessions(db, client);

    const row = db.prepare("SELECT 1 FROM session_work_links WHERE session_id='sess-ambig'").get();
    expect(row).toBeUndefined(); // UNLINKED — no row
  });
});
