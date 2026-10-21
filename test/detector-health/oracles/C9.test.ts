import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { oracleC9 } from "./C9.js";

const NOW = new Date("2026-10-14T00:00:00.000Z"); // window [2026-10-07T00:00Z, 2026-10-14T00:00Z)

function seed(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, file_path TEXT NOT NULL);
    CREATE TABLE ingest_metric_events (event_id TEXT PRIMARY KEY, session_id TEXT, event_ts TEXT,
      is_sidechain INTEGER, is_interrupt INTEGER, classifier_label TEXT);
    CREATE TABLE tool_events (event_id TEXT PRIMARY KEY, session_id TEXT, ts TEXT, tool_name TEXT, interrupt_kind TEXT);
  `);
  for (const w of ["A", "B", "C", "D", "E"])
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(
      `s${w}`,
      `ws${w}`,
      `/nonexistent/${w}.jsonl`,
    );
  return db;
}
let n = 0;
/** i-th in-window day: 2026-10-08 .. 2026-10-12. */
const day = (i: number): string => `2026-10-${String(8 + i).padStart(2, "0")}T00:00:00.000Z`;
function ev(db: Database.Database, s: string, ts: string, label: string, side = 0, intr = 0): void {
  db.prepare("INSERT INTO ingest_metric_events VALUES (?,?,?,?,?,?)").run(
    `e${n++}`,
    s,
    ts,
    side,
    intr,
    label,
  );
}

describe("oracleC9", () => {
  it("counts visible (>=5) workspace x label groups and ignores near-misses", () => {
    const db = seed();
    // ws A: hook-block, 5 events (one exactly at the inclusive lower bound) -> count 5 (expected).
    // The transcript is unreadable, so the guard read-back card rule does not apply: stays visible.
    for (const ts of [
      "2026-10-07T00:00:00.000Z",
      "2026-10-08T00:00:00.000Z",
      "2026-10-09T00:00:00.000Z",
      "2026-10-10T00:00:00.000Z",
      "2026-10-13T23:59:59.000Z",
    ])
      ev(db, "sA", ts, "hook-block");
    // ws B: 4 events -> below the API floor, not emitted.
    for (let i = 0; i < 4; i++) ev(db, "sB", `2026-10-1${i}T00:00:00.000Z`, "deny-rule");
    // ws C: 5 events but all sidechain -> 0.
    for (let i = 0; i < 5; i++) ev(db, "sC", `2026-10-1${i}T00:00:00.000Z`, "hook-block", 1);
    // ws D: 5 user-rejected after an AskUserQuestion human-deny -> all excluded -> 0.
    db.prepare(
      `INSERT INTO tool_events VALUES ('t1','sD','2026-10-08T00:00:00.000Z','AskUserQuestion','HUMAN_DENY')`,
    ).run();
    for (let i = 0; i < 5; i++) ev(db, "sD", `2026-10-1${i}T00:00:00.000Z`, "user-rejected");
    // ws E: 5 events, one at the exclusive upper bound and one interrupt -> 3 in scope.
    ev(db, "sE", "2026-10-14T00:00:00.000Z", "hook-block");
    ev(db, "sE", "2026-10-09T00:00:00.000Z", "interrupt-cancel", 0, 1);
    for (let i = 0; i < 3; i++) ev(db, "sE", `2026-10-1${i}T00:00:00.000Z`, "hook-block");

    const r = oracleC9(db, NOW);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.scope.workspace_id).toBe("wsA");
    expect(r.findings[0]?.count).toBe(5);
    expect(r.note).toContain("0/0");
  });

  it("does not emit a HOOK_BLOCK group whose blocks are all read back and are intended blocks (card below_floor)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c9-"));
    try {
      // null = a blocked call with no command (an Agent call): read back, shape OTHER.
      const mk = (name: string, commands: Array<string | null>): string => {
        const lines: string[] = [];
        commands.forEach((cmd, i) => {
          lines.push(
            JSON.stringify({
              type: "assistant",
              message: {
                content: [
                  cmd === null
                    ? { type: "tool_use", id: `u${i}`, name: "Agent", input: { prompt: "p" } }
                    : { type: "tool_use", id: `u${i}`, name: "Bash", input: { command: cmd } },
                ],
              },
            }),
            JSON.stringify({
              type: "user",
              isSidechain: false,
              timestamp: day(i),
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: `u${i}`,
                    is_error: true,
                    content: "hook error",
                  },
                ],
              },
            }),
          );
        });
        const p = path.join(dir, name);
        fs.writeFileSync(p, lines.join("\n"));
        return p;
      };
      const db = seed();
      // Five blocks: four "cd <dir> && ..." (CD_PREFIX) and one Agent call (OTHER); all intended,
      // 0 open false positives -> below_floor, not emitted.
      db.prepare("UPDATE sessions SET file_path = ? WHERE session_id = 'sA'").run(
        mk("a.jsonl", ["cd /x && ls", "cd /x && ls", "cd /x && ls", "cd /x && ls", null]),
      );
      for (let i = 0; i < 5; i++) ev(db, "sA", day(i), "hook-block");
      // Five blocks of quoted "python -c" searches (QUOTED_PATTERN = open FP): 5 >= 3 per week -> stays visible.
      db.prepare("UPDATE sessions SET file_path = ? WHERE session_id = 'sB'").run(
        mk(
          "b.jsonl",
          Array.from({ length: 5 }, () => 'grep -rn "python -c" src'),
        ),
      );
      for (let i = 0; i < 5; i++) ev(db, "sB", day(i), "hook-block");

      const r = oracleC9(db, NOW);
      expect(r.findings.map((f) => f.scope.workspace_id)).toEqual(["wsB"]);
      expect(r.findings[0]?.count).toBe(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
