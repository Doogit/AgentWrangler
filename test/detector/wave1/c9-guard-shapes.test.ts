/**
 * U7 C9: guard blocks from several guards and tools. Two live PowerShell guards must both be
 * current; PowerShell and TaskCreate blocks get shapes; the open false positives are priced.
 * Fixture shapes follow the audit's real evidence (generic commands, no user paths).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { c9Detector } from "../../../src/detector/detectors/c9_denial_friction.js";
import { buildContext } from "../../../src/detector/engine.js";
import {
  GUARD_FIX,
  c9BlockSplit,
  guardVersions,
  openFalsePositives,
} from "../../../src/query/api/rec-actions/trigger.js";
import {
  __resetToolCallTargets,
  guardBlockToolCalls,
  guardShape,
} from "../../../src/query/api/tool-calls.js";
import { createInMemoryFixtureDb } from "../../fixtures/seed.js";

const CTX = buildContext(new Date("2027-01-08T00:00:00.000Z"));
const NODE_GUARD = "Inline node guard: do not run node -e inline scripts.";
const TREE_GUARD = "Worktree guard: do not remove the worktree you are in.";
const TASK_GUARD = "Task guard: a task needs a subject.";
let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-c9', 'ws-c9', ?)",
  ).run(CTX.fromIso);
  db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('session-c9', 'ws-c9', '/fixture/c9.jsonl', ?, ?, 'RECONCILED', 0, 0, '[]')`,
  ).run(CTX.fromIso, CTX.toIso);
});

afterEach(() => db.close());

interface Block {
  tool: string;
  input: Record<string, unknown>;
  message: string;
  commandShape?: string | null;
}

function seed(blocks: Block[], transcript: string): void {
  const T = (minute: number) => `2027-01-02T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const lines: string[] = [];
  blocks.forEach((block, i) => {
    const id = `tu-${i}`;
    const ts = T(2 * i + 1);
    lines.push(
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        message: {
          content: [{ type: "tool_use", id, name: block.tool, input: block.input }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: ts,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              content: `PreToolUse:${block.tool} hook error: ${block.message}`,
            },
          ],
        },
      }),
    );
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, user_turn_ts, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
          classifier_label, command_shape, event_ts, is_sidechain)
       VALUES (?, 'session-c9', NULL, 0, 0, 0, 0, 'hook-block', ?, ?, 0)`,
    ).run(`c9-block-${i}`, block.commandShape ?? null, ts);
  });
  writeFileSync(transcript, `${lines.join("\n")}\n`);
  db.prepare("UPDATE sessions SET file_path = ? WHERE session_id = 'session-c9'").run(transcript);
  // A turn between every block: each is an owner or re-plan turn of one of them.
  for (let minute = 0; minute <= 2 * blocks.length; minute += 2) {
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain, cost_equiv_u, provisional, parser_version)
       VALUES (?, 'session-c9', 'ws-c9', ?, 'claude-sonnet', 0, 1000, 0, 'test')`,
    ).run(`c9-t-${minute}`, T(minute));
  }
}

describe("U7 C9 guard blocks across guards and tools", () => {
  it("shapes PowerShell and TaskCreate blocks, keeps two PowerShell guards current, prices open FPs", () => {
    __resetToolCallTargets();
    const dir = mkdtempSync(path.join(os.tmpdir(), "aw-c9-u7-"));
    const node = (action: string): Block => ({
      tool: "PowerShell",
      input: { command: `Get-Command node -ErrorAction ${action}` },
      message: NODE_GUARD,
    });
    try {
      seed(
        [
          node("SilentlyContinue"),
          // Its ingest row carries a bash-style command shape: still read back as a PowerShell call.
          { ...node("Stop"), commandShape: "bash:args-2-3" },
          node("Ignore"),
          { tool: "TaskCreate", input: { description: "no subject" }, message: TASK_GUARD },
          {
            tool: "PowerShell",
            input: { command: "git worktree remove .worktrees/finished-branch" },
            message: TREE_GUARD,
          },
        ],
        path.join(dir, "c9.jsonl"),
      );

      const calls = guardBlockToolCalls(db, {
        workspaceId: "ws-c9",
        from: CTX.fromIso,
        to: CTX.toIso,
      });
      const shapes = new Map(calls.map((call) => [call.target, call.guard_shape]));
      for (const action of ["SilentlyContinue", "Stop", "Ignore"])
        expect(shapes.get(`Get-Command node -ErrorAction ${action}`)).toBe("PS_NODE_FLAG");
      expect(shapes.get("git worktree remove .worktrees/finished-branch")).toBe("WORKTREE_REMOVE");
      // A TaskCreate block has no command, but still gets a shape (unclassified) and a guard version.
      expect(calls.find((call) => call.tool === "TaskCreate")?.guard_shape).toBe("OTHER");

      const versions = guardVersions(calls);
      // The worktree guard is the newest PowerShell block; the node guard must still be current.
      expect(versions.filter((version) => version.tool === "PowerShell")).toHaveLength(2);
      expect(versions.every((version) => version.current)).toBe(true);

      const split = c9BlockSplit(versions, 5);
      expect(split).toMatchObject({ fp: 3, a: 1, b: 0, c: 1, total: 5 });
      expect(openFalsePositives(versions)).toEqual([["PS_NODE_FLAG", 3]]);
      expect(GUARD_FIX.PS_NODE_FLAG).toContain("node");

      const payload = c9Detector.evaluate(db, CTX).fired[0]?.payload;
      expect(payload?.metrics?.DENIAL_COUNT).toEqual({ kind: "COUNT", value: 5 });
      // 3 open FPs in a one-week window, and their turns cost 1000 each: priced, not 0.
      expect(payload?.estimate?.rank_value_u_per_wk ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies the guard-regex false positives from the audit", () => {
    // `node -e` itself is what the PowerShell guard stops; a `-E…` parameter after `node` is not.
    expect(guardShape('node -e "1"', "PowerShell")).toBe("OTHER");
    expect(guardShape("Get-Command node -ErrorAction Stop", "PowerShell")).toBe("PS_NODE_FLAG");
    // A bare /tmp is intended; a job scratch folder named tmp is a false positive.
    expect(guardShape("Set-Content /tmp/x 1", "PowerShell")).toBe("TMP_WRITE");
    expect(guardShape("Set-Content C:/jobs/abc/tmp/x.txt 1", "PowerShell")).toBe("PS_SCRATCH_TMP");
    expect(guardShape("cat /tmp/x")).toBe("TMP_WRITE");
    expect(guardShape("cat $CLAUDE_JOB_DIR/tmp/x.txt")).toBe("SCRATCH_TMP");
    expect(guardShape("ls /home/u/jobs/abc/tmp/")).toBe("SCRATCH_TMP");
    // `<<` only inside a quoted pattern is not a heredoc; a real heredoc to a file still is.
    expect(guardShape('grep -n "a<<b" src/x.ts')).toBe("QUOTED_HEREDOC");
    expect(guardShape("cat <<'EOF' > f.txt\nhi\nEOF")).toBe("HEREDOC_FILE");
    expect(guardShape("git commit -F - <<'EOF'\nmsg\nEOF")).toBe("HEREDOC_STDIN");
  });
});
