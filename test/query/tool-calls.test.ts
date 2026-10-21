import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { findingIds } from "../../src/detector/privacy-contract.js";
import { displayPath } from "../../src/query/api/rec-actions/families/context.js";
import {
  __resetToolCallTargets,
  anchoredToolCalls,
  eventToolCalls,
  mechanicalRunToolCalls,
  midSizeToolCalls,
  notFoundToolCalls,
  orientationToolCalls,
  oversizedToolCalls,
  repoRelative,
  rereadToolCalls,
  seedToolCallTargets,
  shellFailureToolCalls,
  shellFamily,
  toolCallTargetEntries,
} from "../../src/query/api/tool-calls.js";

const BIG = 30 * 1024;
const WINDOW = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" };

function toolUse(id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

describe("oversizedToolCalls", () => {
  let dir: string;
  let db: Database.Database;
  let mainFile: string;
  let otherFile: string;

  beforeEach(() => {
    __resetToolCallTargets();
    dir = mkdtempSync(path.join(os.tmpdir(), "aw-tool-calls-"));
    mainFile = path.join(dir, "repo", "src", "big.ts");
    otherFile = path.join(dir, "repo", "docs", "plan.md");
    const worktreeCopy = path.join(dir, "repo", ".worktrees", "feat-a", "src", "big.ts");
    const s1 = path.join(dir, "s1.jsonl");
    const s2 = path.join(dir, "s2.jsonl");
    mkdirSync(path.join(dir, "s1", "subagents"), { recursive: true });
    writeFileSync(
      s1,
      [
        toolUse("toolu_whole", "Read", { file_path: mainFile }),
        toolUse("toolu_range", "Read", { file_path: otherFile, offset: 10, limit: 400 }),
        toolUse("toolu_bash", "Bash", { command: "cat big.log" }),
        toolUse("toolu_small", "Read", { file_path: otherFile }),
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(dir, "s1", "subagents", "agent-1.jsonl"),
      `${toolUse("toolu_sub", "Read", { file_path: mainFile })}\n`,
    );
    writeFileSync(s2, `${toolUse("toolu_wt", "Read", { file_path: worktreeCopy })}\n`);

    db = new Database(":memory:");
    runMigrations(db, "019_work_records");
    db.exec(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'p', '2026-01-01T00:00:00Z')",
    );
    const session = db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, 'ws-1', ?, 'RECONCILED')",
    );
    session.run("sess-1", s1);
    session.run("sess-2", s2);
    const event = db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes) VALUES (?, ?, ?, ?, ?)",
    );
    event.run("toolu_whole", "sess-1", "2026-01-02T00:00:00.000Z", "Read", BIG);
    event.run("toolu_range", "sess-1", "2026-01-02T00:01:00.000Z", "Read", BIG * 3);
    event.run("toolu_bash", "sess-1", "2026-01-02T00:02:00.000Z", "Bash", BIG);
    event.run("toolu_small", "sess-1", "2026-01-02T00:03:00.000Z", "Read", 1_000);
    event.run("toolu_sub", "sess-1", "2026-01-02T00:04:00.000Z", "Read", BIG + 1);
    event.run("toolu_wt", "sess-2", "2026-01-03T00:00:00.000Z", "Read", BIG + 2);
    event.run("toolu_missing", "sess-2", "2026-01-03T00:01:00.000Z", "Read", BIG * 9);
    event.run("toolu_late", "sess-2", "2026-01-09T00:00:00.000Z", "Read", BIG * 9);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const scope = { workspaceId: "ws-1", ...WINDOW };

  it("groups oversized calls by target across sessions, subagents and worktrees", () => {
    expect(oversizedToolCalls(db, scope).filter((call) => call.tool === "Read")).toEqual([
      {
        target: displayPath(mainFile),
        kind: "file",
        tool: "Read",
        calls: 3,
        // Session of the largest call first.
        session_ids: ["sess-2", "sess-1"],
        session_count: 2,
        total_bytes: BIG * 3 + 3,
        max_bytes: BIG + 2,
        whole_file: true,
      },
      {
        target: displayPath(otherFile),
        kind: "file",
        tool: "Read",
        calls: 1,
        session_ids: ["sess-1"],
        session_count: 1,
        total_bytes: BIG * 3,
        max_bytes: BIG * 3,
        whole_file: false,
      },
    ]);
  });

  it("A1a: puts a file read in the main session ahead of one read in subagents", () => {
    // Every read of the big file ran in a subagent; the other file's read ran in the main session.
    writeFileSync(
      path.join(dir, "s1.jsonl"),
      [
        toolUse("toolu_range", "Read", { file_path: otherFile, offset: 10, limit: 400 }),
        toolUse("toolu_range2", "Read", { file_path: otherFile, offset: 500, limit: 400 }),
        "",
      ].join("\n"),
    );
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes) VALUES ('toolu_range2', 'sess-1', '2026-01-02T00:05:00.000Z', 'Read', ?)",
    ).run(BIG);
    writeFileSync(
      path.join(dir, "s1", "subagents", "agent-2.jsonl"),
      `${toolUse("toolu_whole", "Read", { file_path: mainFile })}\n`,
    );
    mkdirSync(path.join(dir, "s2", "subagents"), { recursive: true });
    writeFileSync(path.join(dir, "s2.jsonl"), "\n");
    writeFileSync(
      path.join(dir, "s2", "subagents", "agent-1.jsonl"),
      `${toolUse("toolu_wt", "Read", { file_path: path.join(dir, "repo", ".worktrees", "feat-a", "src", "big.ts") })}\n`,
    );
    expect(
      oversizedToolCalls(db, scope)
        .filter((call) => call.tool === "Read")
        .map((call) => [call.target, call.calls]),
    ).toEqual([
      [displayPath(otherFile), 2],
      [displayPath(mainFile), 3],
    ]);
    // Review 5 residual M19: a group read only inside subagents says so; a main-session one does not.
    expect(
      oversizedToolCalls(db, scope)
        .filter((call) => call.tool === "Read")
        .map((call) => [call.target, call.is_subagent === true]),
    ).toEqual([
      [displayPath(otherFile), false],
      [displayPath(mainFile), true],
    ]);
  });

  it("review 5 residual M19: a group with any main-session read is not tagged subagent", () => {
    // beforeEach: mainFile is read in the main session (toolu_whole, toolu_wt) and a subagent.
    const main = oversizedToolCalls(db, scope).find(
      (call) => call.target === displayPath(mainFile),
    );
    expect(main?.is_subagent === true).toBe(false);
  });

  it("lists every tool's oversized calls on one card (R2.3)", () => {
    expect(
      oversizedToolCalls(db, scope).map((call) => [call.tool, call.target, call.calls]),
    ).toEqual([
      ["Read", displayPath(mainFile), 3],
      ["Read", displayPath(otherFile), 1],
      ["Bash", "cat big.log", 1],
    ]);
  });

  it("reads each call's input once, and carries the cache to a new build", () => {
    const first = oversizedToolCalls(db, scope);
    const entries = toolCallTargetEntries();
    rmSync(path.join(dir, "s1.jsonl"));
    rmSync(path.join(dir, "s2.jsonl"));
    expect(oversizedToolCalls(db, scope)).toEqual(first);
    // A fresh worker starts empty; seeded with the entries it needs no transcript.
    __resetToolCallTargets();
    seedToolCallTargets(entries);
    expect(oversizedToolCalls(db, scope)).toEqual(first);
  });
});

describe("anchoredToolCalls", () => {
  let dir: string;
  let db: Database.Database;
  const line = (timestamp: string, block: Record<string, unknown>): string =>
    JSON.stringify({ type: "user", timestamp, message: { content: [block] } });
  const anchor = (id: string, session: string, timestamp: string) => ({
    event_id: findingIds.event(id),
    session_id: findingIds.session(session),
    timestamp,
  });
  const T1 = "2026-01-02T00:00:00.000Z";
  const T2 = "2026-01-02T00:01:00.000Z";
  const T3 = "2026-01-02T00:02:00.000Z";

  beforeEach(() => {
    __resetToolCallTargets();
    dir = mkdtempSync(path.join(os.tmpdir(), "aw-anchored-"));
    const s1 = path.join(dir, "s1.jsonl");
    writeFileSync(
      s1,
      [
        toolUse("toolu_read", "Read", { file_path: "/repo/missing.md" }),
        line(T1, {
          type: "tool_result",
          tool_use_id: "toolu_read",
          content: "File does not exist.\nmore",
        }),
        toolUse("toolu_denied", "Bash", { command: "cd repo && npm test" }),
        line(T2, {
          type: "tool_result",
          tool_use_id: "toolu_denied",
          content: [{ type: "text", text: "Blocked command shape" }],
        }),
        toolUse("toolu_again", "Read", { file_path: "/repo/missing.md" }),
        line(T3, {
          type: "tool_result",
          tool_use_id: "toolu_again",
          content: "File does not exist.",
        }),
        "",
      ].join("\n"),
    );
    db = new Database(":memory:");
    runMigrations(db);
    db.exec(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'p', '2026-01-01T00:00:00Z')",
    );
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('sess-1', 'ws-1', ?, 'RECONCILED')",
    ).run(s1);
    const event = db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes) VALUES (?, 'sess-1', ?, 'Read', 100)",
    );
    event.run("toolu_read", T1);
    event.run("toolu_again", T3);
    // A denial is an ingest metric event: its id is a hash, so only its time finds the line.
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
          classifier_label, event_ts, is_sidechain)
       VALUES ('ime-hash', 'sess-1', 0, 0, 0, 0, 'hook-block', ?, 0)`,
    ).run(T2);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads back the call and what it returned for each hashed anchor", () => {
    const calls = anchoredToolCalls(db, [
      anchor("toolu_read", "sess-1", T1),
      anchor("ime-hash", "sess-1", T2),
      anchor("toolu_again", "sess-1", T3),
      anchor("toolu_unknown", "sess-1", T3),
    ]);
    expect(calls).toMatchObject([
      { target: "/repo/missing.md", kind: "file", tool: "Read", calls: 2, session_count: 1 },
      {
        target: "cd repo && npm test",
        kind: "command",
        tool: "Bash",
        calls: 1,
        result: "Blocked command shape",
      },
    ]);
    expect(calls[0]?.result).toBe("File does not exist.");
  });

  it("keeps the raw session ids of the calls it groups (R2.9)", () => {
    const calls = anchoredToolCalls(db, [
      anchor("toolu_read", "sess-1", T1),
      anchor("toolu_again", "sess-1", T3),
    ]);
    expect(calls).toMatchObject([{ calls: 2, session_ids: ["sess-1"], session_count: 1 }]);
  });

  it("reads back raw tool_events ids like anchors (R4.2 loop example)", () => {
    expect(eventToolCalls(db, ["toolu_read", "toolu_again", "toolu_unknown"])).toMatchObject([
      { target: "/repo/missing.md", tool: "Read", calls: 2, result: "File does not exist." },
    ]);
  });

  it("names a re-read file with its read totals in the window, not its content (R4.1)", () => {
    const metadata = db.prepare(
      "INSERT INTO tool_event_metadata (event_id, file_path_hash, block_index, is_test_command) VALUES (?, ?, 0, 0)",
    );
    metadata.run("toolu_read", "hash-missing");
    metadata.run("toolu_again", "hash-missing");
    const calls = rereadToolCalls(db, ["toolu_again"], { workspaceId: "ws-1", ...WINDOW });
    expect(calls).toEqual([
      {
        target: "/repo/missing.md",
        kind: "file",
        whole_file: true,
        tool: "Read",
        calls: 2,
        session_ids: ["sess-1"],
        session_count: 1,
        total_bytes: 200,
        max_bytes: 100,
      },
    ]);
  });

  it("leaves reads over A1's 25 KB threshold out of the re-read totals (R2.7)", () => {
    const metadata = db.prepare(
      "INSERT INTO tool_event_metadata (event_id, file_path_hash, block_index, is_test_command) VALUES (?, ?, 0, 0)",
    );
    metadata.run("toolu_read", "hash-missing");
    metadata.run("toolu_again", "hash-missing");
    db.prepare("UPDATE tool_events SET result_bytes = ? WHERE event_id = 'toolu_read'").run(
      25 * 1024 + 1,
    );
    const calls = rereadToolCalls(db, ["toolu_again"], { workspaceId: "ws-1", ...WINDOW });
    expect(calls).toMatchObject([{ calls: 1, total_bytes: 100, max_bytes: 100 }]);
  });

  it("counts only the detector's re-read identity: same region and size, no edit (U9 r7)", () => {
    const metadata = db.prepare(
      "INSERT INTO tool_event_metadata (event_id, file_path_hash, block_index, is_test_command) VALUES (?, ?, 0, 0)",
    );
    metadata.run("toolu_read", "hash-missing");
    metadata.run("toolu_again", "hash-missing");
    // Before: a read of the same path with another size (the file changed) still counted.
    db.prepare("UPDATE tool_events SET result_bytes = 140 WHERE event_id = 'toolu_read'").run();
    expect(rereadToolCalls(db, ["toolu_again"], { workspaceId: "ws-1", ...WINDOW })).toMatchObject([
      { calls: 1, total_bytes: 100, session_ids: ["sess-1"] },
    ]);
    // A session that edits the file re-reads it on purpose: none of its reads count.
    db.prepare("UPDATE tool_events SET result_bytes = 100 WHERE event_id = 'toolu_read'").run();
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes) VALUES ('toolu_edit', 'sess-1', ?, 'Edit', 10, 10)",
    ).run(WINDOW.from.replace("01T", "02T"));
    metadata.run("toolu_edit", "hash-missing");
    expect(rereadToolCalls(db, ["toolu_again"], { workspaceId: "ws-1", ...WINDOW })).toEqual([]);
  });
});

describe("call lookup fixes (P3.1-T2)", () => {
  let dir: string;
  let db: Database.Database;
  const at = (timestamp: string, type: string, blocks: Array<Record<string, unknown>>): string =>
    JSON.stringify({ type, timestamp, message: { content: blocks } });
  const use = (id: string, name: string, input: Record<string, unknown>) => ({
    type: "tool_use",
    id,
    name,
    input,
  });
  const result = (id: string, content: unknown) => ({
    type: "tool_result",
    tool_use_id: id,
    content,
  });
  const anchor = (id: string, timestamp: string) => ({
    event_id: findingIds.event(id),
    session_id: findingIds.session("sess-1"),
    timestamp,
  });
  const T = (minute: number) => `2026-01-02T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const GUARD =
    "Blocked command shape (CLAUDE.md rules 1-3 + destructive git): cd&&-prefix / in-place edits (sed -i, perl -i, python -c) / tmp writes / git reset --hard / git clean / git stash -u.";
  const CHAINED = `rm -r ${Array.from({ length: 8 }, (_, i) => `.claude/audits/old-run-${i}`).join(" ")}; git commit --only docs/plan.md -m "plan"`;
  let transcript: string;

  function write(lines: string[]): void {
    writeFileSync(transcript, `${lines.join("\n")}\n`);
  }

  function oversized(id: string, minute: number, tool: string, bytes = BIG): void {
    db.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes) VALUES (?, 'sess-1', ?, ?, ?)",
    ).run(id, T(minute), tool, bytes);
  }

  function ingest(id: string, minute: number, label: string | null, destructive: string | null) {
    db.prepare(
      `INSERT INTO ingest_metric_events
         (event_id, session_id, is_user_turn, is_compact_summary, is_api_error, is_interrupt,
          classifier_label, destructive_op, event_ts, is_sidechain)
       VALUES (?, 'sess-1', 0, 0, 0, 0, ?, ?, ?, 0)`,
    ).run(id, label, destructive, T(minute));
  }

  beforeEach(() => {
    __resetToolCallTargets();
    dir = mkdtempSync(path.join(os.tmpdir(), "aw-lookup-"));
    transcript = path.join(dir, "s1.jsonl");
    db = new Database(":memory:");
    runMigrations(db);
    db.exec(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'p', '2026-01-01T00:00:00Z')",
    );
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('sess-1', 'ws-1', ?, 'RECONCILED')",
    ).run(transcript);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const scope = (toolClass: string) => ({ workspaceId: "ws-1", toolClass, ...WINDOW });

  it("ranks by re-sent bytes, a repeat breaking ties, and skips reads next to an edit (R2.4, U7)", () => {
    write([
      at(T(1), "assistant", [use("r-big", "Read", { file_path: "/repo/huge.md" })]),
      at(T(2), "assistant", [use("r-tpl-1", "Read", { file_path: "/repo/template.md" })]),
      at(T(3), "assistant", [use("r-tpl-2", "Read", { file_path: "/repo/template.md" })]),
      at(T(4), "assistant", [use("r-src-1", "Read", { file_path: "/repo/src.ts" })]),
      at(T(5), "assistant", [use("e-src", "Edit", { file_path: "/repo/src.ts" })]),
      at(T(6), "assistant", [use("r-src-2", "Read", { file_path: "/repo/src.ts" })]),
      at(T(7), "assistant", [use("r-src-3", "Read", { file_path: "/repo/src.ts" })]),
      at(T(8), "assistant", [use("r-src-4", "Read", { file_path: "/repo/src.ts" })]),
    ]);
    oversized("r-big", 1, "Read", BIG * 9);
    oversized("r-tpl-1", 2, "Read");
    oversized("r-tpl-2", 3, "Read");
    for (const [id, minute] of [
      ["r-src-1", 4],
      ["r-src-2", 6],
      ["r-src-3", 7],
      ["r-src-4", 8],
    ]) {
      oversized(id as string, minute as number, "Read");
    }
    // src.ts: the read before the edit and the one right after it are needed; two repeats remain.
    // U7: the one 270 KB read re-sends more than either pair of 30 KB repeats, so it leads; the
    // repeats tie on bytes and keep their order.
    expect(
      oversizedToolCalls(db, scope("FILE_READ")).map((call) => [call.target, call.calls]),
    ).toEqual([
      [displayPath("/repo/huge.md"), 1],
      [displayPath("/repo/src.ts"), 2],
      [displayPath("/repo/template.md"), 2],
    ]);
  });

  it("groups URL variants of one page (R2.5)", () => {
    const urls = [
      "https://platform.claude.com/docs/en/docs/about-claude/pricing",
      "https://Platform.Claude.com/docs/en/about-claude/pricing/",
      "https://platform.claude.com/docs/en/about-claude/pricing#tiers",
      "https://platform.claude.com/docs/en/about-claude/pricing.md",
      "https://code.claude.com/docs/en/costs",
    ];
    write(urls.map((url, i) => at(T(i + 1), "assistant", [use(`w-${i}`, "WebFetch", { url })])));
    urls.forEach((_, i) => oversized(`w-${i}`, i + 1, "WebFetch"));
    expect(oversizedToolCalls(db, scope("WEB")).map((call) => [call.target, call.calls])).toEqual([
      ["https://platform.claude.com/docs/en/about-claude/pricing", 4],
      ["https://code.claude.com/docs/en/costs", 1],
    ]);
  });

  it("groups shell calls by command family, a lone command shown as itself (R2.6)", () => {
    const commands = [
      'git -C "/repo/.worktrees/a" --no-pager diff main..HEAD',
      "git diff --cached",
      "git --no-pager diff main -- src/a.ts",
      "git log -p",
      "cat big.log",
      "cd /repo; git diff HEAD~1",
    ];
    write(
      commands.map((command, i) => at(T(i + 1), "assistant", [use(`b-${i}`, "Bash", { command })])),
    );
    commands.forEach((_, i) => oversized(`b-${i}`, i + 1, "Bash"));
    expect(oversizedToolCalls(db, scope("SHELL")).map((call) => [call.target, call.calls])).toEqual(
      [
        ["git diff", 4],
        ["cat big.log", 1],
        ["git log -p", 1],
      ],
    );
  });

  it("A1 (review 4): leaves out reads cut at the tool's cap, so none can lead", () => {
    const page = "https://claude.ai/artifact/abc";
    write([1, 2, 3].map((i) => at(T(i), "assistant", [use(`a-${i}`, "Artifact", { url: page })])));
    oversized("a-1", 1, "Artifact", 50_000);
    oversized("a-2", 2, "Artifact", 50_000);
    oversized("a-3", 3, "Artifact", 40_000);
    expect(
      oversizedToolCalls(db, scope("WEB")).map((call) => [call.target, call.total_bytes]),
    ).toEqual([[page, 40_000]]);
  });

  it("A1 (review 4): skips a page whose content changed between reads", () => {
    const [same, changed] = ["https://x.dev/same", "https://x.dev/changed"];
    write([
      at(T(1), "assistant", [use("w-1", "WebFetch", { url: same })]),
      at(T(1), "user", [result("w-1", "v1")]),
      at(T(2), "assistant", [use("w-2", "WebFetch", { url: same })]),
      at(T(2), "user", [result("w-2", "v1")]),
      at(T(3), "assistant", [use("w-3", "WebFetch", { url: changed })]),
      at(T(3), "user", [result("w-3", "v1")]),
      at(T(4), "assistant", [use("w-4", "WebFetch", { url: changed })]),
      at(T(4), "user", [result("w-4", "v2")]),
    ]);
    for (const i of [1, 2, 3, 4]) oversized(`w-${i}`, i, "WebFetch");
    expect(oversizedToolCalls(db, scope("WEB")).map((call) => [call.target, call.calls])).toEqual([
      [same, 2],
    ]);
  });

  it("A1 (review 4): ranks repeated reads by re-send cost, size × turns left in the session", () => {
    write([
      at(T(1), "assistant", [use("r-early-1", "Read", { file_path: "/repo/early.md" })]),
      at(T(2), "assistant", [use("r-early-2", "Read", { file_path: "/repo/early.md" })]),
      at(T(40), "assistant", [use("r-late-1", "Read", { file_path: "/repo/late.md" })]),
      at(T(41), "assistant", [use("r-late-2", "Read", { file_path: "/repo/late.md" })]),
    ]);
    oversized("r-early-1", 1, "Read", BIG);
    oversized("r-early-2", 2, "Read", BIG);
    oversized("r-late-1", 40, "Read", BIG * 3);
    oversized("r-late-2", 41, "Read", BIG * 3);
    // 40 main-thread turns follow the early reads; the late ones are re-sent once or twice.
    const turn = db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version, is_sidechain) VALUES (?, 'sess-1', 'ws-1', ?, 'm', 'p', 0)",
    );
    for (let minute = 1; minute <= 42; minute += 1) turn.run(`t-${minute}`, T(minute));
    // U7: the carry walks each read's owner turn's chain.
    const owner = db.prepare(
      "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, 0, 0)",
    );
    for (const [id, minute] of [
      ["r-early-1", 1],
      ["r-early-2", 2],
      ["r-late-1", 40],
      ["r-late-2", 41],
    ] as const) {
      owner.run(id, `t-${minute}`);
    }
    expect(
      oversizedToolCalls(db, scope("FILE_READ")).map((call) => [call.target, call.calls]),
    ).toEqual([
      [displayPath("/repo/early.md"), 2],
      [displayPath("/repo/late.md"), 2],
    ]);
  });

  it("U7: a larger read inside a subagent leads, priced along the subagent's own turns", () => {
    write([at(T(1), "assistant", [use("r-main", "Read", { file_path: "/repo/main.md" })])]);
    mkdirSync(path.join(dir, "s1", "subagents"), { recursive: true });
    writeFileSync(
      path.join(dir, "s1", "subagents", "agent-sub.jsonl"),
      `${at(T(2), "assistant", [use("r-sub", "Read", { file_path: "/repo/sub.md" })])}\n`,
    );
    oversized("r-main", 1, "Read", BIG);
    oversized("r-sub", 2, "Read", BIG * 3);
    const turn = db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, parser_version, is_sidechain, agent_id) VALUES (?, 'sess-1', 'ws-1', ?, 'm', 'p', ?, ?)",
    );
    // Each read is carried by three later turns of its own chain.
    turn.run("main-0", T(1), 0, null);
    turn.run("sub-0", T(2), 1, "agent-sub");
    for (const minute of [3, 4, 5]) {
      turn.run(`main-${minute}`, T(minute), 0, null);
      turn.run(`sub-${minute}`, `${T(minute).slice(0, -5)}30.000Z`, 1, "agent-sub");
    }
    const owner = db.prepare(
      "INSERT INTO tool_event_metadata (event_id, owner_message_id, block_index, is_test_command) VALUES (?, ?, 0, 0)",
    );
    owner.run("r-main", "main-0");
    owner.run("r-sub", "sub-0");
    expect(
      oversizedToolCalls(db, scope("FILE_READ")).map((call) => [
        call.target,
        call.is_subagent === true,
      ]),
    ).toEqual([
      [displayPath("/repo/sub.md"), true],
      [displayPath("/repo/main.md"), false],
    ]);
  });

  it("shows a chained command whole and the full guard message (R2.6, R4.3)", () => {
    write([
      at(T(1), "assistant", [use("h-1", "Bash", { command: CHAINED })]),
      at(T(1), "user", [result("h-1", `PreToolUse:Bash hook error: ${GUARD} Use a bare cd.`)]),
    ]);
    oversized("h-1", 1, "Bash", 100);
    const [call] = anchoredToolCalls(db, [anchor("h-1", T(1))]);
    expect(call?.target).toBe(CHAINED);
    expect(call?.result).toBe(`${GUARD} Use a bare cd.`);
  });

  it("U9 r4 C9: a worktree-remove guard block is intended even with a tmp path in the command", () => {
    const command =
      "git commit -q -F ~/jobs/j1/tmp/msg.txt; git worktree remove .worktrees/x; git worktree prune";
    write([
      at(T(1), "assistant", [use("w-1", "Bash", { command })]),
      at(T(1), "user", [
        result(
          "w-1",
          "PreToolUse:Bash hook error: worktree-remove guard: node_modules still exists, git would delete THROUGH the junction.",
        ),
      ]),
    ]);
    oversized("w-1", 1, "Bash", 100);
    const [call] = anchoredToolCalls(db, [anchor("w-1", T(1))]);
    expect(call?.guard_shape).toBe("WORKTREE_REMOVE");
  });

  it("review 4 C1: shows the batch step that failed, not the first step", () => {
    const batch = "mcp__claude-in-chrome__browser_batch";
    write([
      at(T(1), "assistant", [use("b-1", batch, { actions: [] })]),
      at(T(1), "user", [
        result(
          "b-1",
          "[navigate] Navigated to x\n\nactions[2] (computer:zoom) failed: Error capturing",
        ),
      ]),
    ]);
    oversized("b-1", 1, batch, 100);
    const [call] = anchoredToolCalls(db, [anchor("b-1", T(1))]);
    expect(call?.result).toBe("actions[2] (computer:zoom) failed: Error capturing");
  });

  it("two calls at one timestamp are attributed by tool name (R1.5)", () => {
    write([
      at(T(1), "user", [result("earlier", "[main abc123] docs: unrelated commit")]),
      at(T(1), "assistant", [
        use("r-1", "Read", { file_path: "/repo/a.md" }),
        use("rm-1", "Bash", { command: "rm -rf build" }),
      ]),
      at(T(1), "user", [result("rm-1", "done")]),
      toolUse("d-1", "Bash", { command: "git status" }),
      at(T(2), "assistant", [use("g-1", "Grep", { pattern: "later" })]),
      at(T(2), "user", [result("d-1", "Blocked by hook")]),
    ]);
    // A risky command is the Bash call on its line; a denial is the result on its line.
    ingest("ime-rm", 1, null, "rm-rf");
    ingest("ime-deny", 2, "hook-block", null);
    const calls = anchoredToolCalls(db, [anchor("ime-rm", T(1)), anchor("ime-deny", T(2))]);
    expect(calls.map((call) => [call.tool, call.target, call.result])).toEqual([
      ["Bash", "git status", "Blocked by hook"],
      ["Bash", "rm -rf build", "done"],
    ]);
  });
});

describe("notFoundToolCalls (P3.1-T4, R2.1)", () => {
  let dir: string;
  let db: Database.Database;
  const OWN = "11111111-2222-3333-4444-555555555555";
  const OTHER = "99999999-8888-7777-6666-555555555555";
  const T = (n: number) => `2026-01-02T00:0${n}:00.000Z`;
  const cwdNote = (cwd: string) =>
    `File does not exist. Note: your current working directory is ${cwd}.`;
  let seq = 0;
  let lines: string[] = [];

  function notFound(
    session: string,
    tool: string,
    input: Record<string, unknown>,
    text: string,
    sidechain = 0,
  ): void {
    const n = seq++;
    const id = `toolu_nf_${n}`;
    lines.push(
      toolUse(id, tool, input),
      JSON.stringify({
        type: "user",
        timestamp: T(n),
        message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
      }),
    );
    db.prepare(
      `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens,
          output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
          cost_equiv_u, cost_claim, provisional, parser_version)
       VALUES (?, ?, 'ws-1', ?, 'claude-sonnet', ?, 0, 0, 0, 0, 0, 0, 0, 'LIST_EQUIV', 0, 'test-v1')`,
    ).run(`msg-${n}`, session, T(n), sidechain);
    db.prepare(
      `INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class, tool_error_class,
          tool_error_classifier_version)
       VALUES (?, ?, ?, ?, 'ERROR', 'NOT_FOUND', 'tool-error-1')`,
    ).run(id, session, T(n), tool);
    db.prepare(
      "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES (?, NULL, ?, 0, 0)",
    ).run(id, `msg-${n}`);
  }

  function flush(session: string): void {
    writeFileSync(path.join(dir, `${session}.jsonl`), `${lines.join("\n")}\n`);
    lines = [];
  }

  beforeEach(() => {
    __resetToolCallTargets();
    seq = 0;
    lines = [];
    dir = mkdtempSync(path.join(os.tmpdir(), "aw-not-found-"));
    db = new Database(":memory:");
    runMigrations(db);
    db.exec(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'p', '2026-01-01T00:00:00Z')",
    );
    for (const id of [OWN, "sess-b"]) {
      db.prepare(
        "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, 'ws-1', ?, 'RECONCILED')",
      ).run(id, path.join(dir, `${id}.jsonl`));
    }
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("groups a workspace's missing-path lookups by target and classifies each cause", () => {
    notFound(OWN, "Read", { file_path: "/repo/src/guess.ts" }, cwdNote("/repo"));
    notFound(OWN, "Read", { file_path: "/repo/src/guess.ts" }, cwdNote("/repo"));
    // Working in a worktree, reading the main checkout's copy.
    notFound(
      OWN,
      "Read",
      { file_path: "/repo/test/x.test.ts" },
      cwdNote("/repo/.worktrees/feat-a"),
    );
    // Another session's scratchpad; the session's own scratchpad is an ordinary missing file.
    notFound(
      OWN,
      "Read",
      { file_path: `/tmp/claude/ws/${OTHER}/scratchpad/notes.md` },
      cwdNote("/repo"),
    );
    notFound(
      OWN,
      "Read",
      { file_path: `/tmp/claude/ws/${OWN}/scratchpad/own.md` },
      cwdNote("/repo"),
    );
    // A subagent's lookup is not the main session's.
    notFound(OWN, "Read", { file_path: "/repo/sub.ts" }, cwdNote("/repo"), 1);
    flush(OWN);
    notFound(
      "sess-b",
      "Grep",
      { pattern: "x", path: "/repo/.worktrees/feat-b/src/ui" },
      "Path does not exist: /repo/.worktrees/feat-b/src/ui. Note: your current working directory is /repo.",
    );
    flush("sess-b");

    const calls = notFoundToolCalls(db, { workspaceId: "ws-1", ...WINDOW });
    expect(calls.map((call) => [call.target, call.calls, call.cause, call.session_ids])).toEqual([
      ["/repo/src/guess.ts", 2, "GUESSED_PATH", [OWN]],
      ["/repo/test/x.test.ts", 1, "WRONG_WORKTREE", [OWN]],
      [`/tmp/claude/ws/${OWN}/scratchpad/own.md`, 1, "GUESSED_PATH", [OWN]],
      [`/tmp/claude/ws/${OTHER}/scratchpad/notes.md`, 1, "OTHER_SCRATCHPAD", [OWN]],
      ["x in /repo/src/ui", 1, "WRONG_WORKTREE", ["sess-b"]],
    ]);
  });

  it("U9 r9: a lookup in a worktree that is gone shows the worktree path as written", () => {
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    const file = path.join(repo, ".worktrees", "gone", "docs", "h.md");
    notFound(OWN, "Read", { file_path: file }, cwdNote(repo));
    flush(OWN);
    const [call] = notFoundToolCalls(db, { workspaceId: "ws-1", ...WINDOW });
    expect(call?.cause).toBe("WORKTREE_GONE");
    expect(call?.target.replace(/\\/g, "/")).toContain("/repo/.worktrees/gone/docs/h.md");
  });
});

describe("shellFamily (U10 review)", () => {
  it("names the command after location changes and variable assignments", () => {
    expect(shellFamily("cd /repo && grep -n x a.ts")).toBe("grep");
    expect(shellFamily("Set-Location C:/r; npx vitest run")).toBe("npx vitest");
    expect(shellFamily("D=/c/x/u9; ls $D")).toBe("ls");
    expect(shellFamily('$p = "C:/x"; Get-Process node')).toBe("Get-Process");
    expect(shellFamily("node C:/Users/a/tmp/u9-daemon.mjs --keep-db")).toBe("node");
    expect(shellFamily("pwd; git status")).toBe("pwd");
  });
});

describe("shellFailureToolCalls (P3.1-T5, R3.4)", () => {
  it("groups the shell's real failures by command family, past a leading Set-Location", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'p', '2026-01-01T00:00:00Z')",
    );
    db.exec(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('sess-1', 'ws-1', '/x.jsonl', 'RECONCILED')",
    );
    let n = 0;
    const add = (tool: string, exit: string, command: string, error: string | null) => {
      const id = `ev-${n++}`;
      db.prepare(
        "INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class) VALUES (?, 'sess-1', '2026-01-02T00:00:00.000Z', ?, ?)",
      ).run(id, tool, exit);
      db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
        id,
        JSON.stringify({ command, ...(error === null ? {} : { error }) }),
      );
    };
    // Review 3 B3: only failures the shell itself caused are D11's.
    const separator = "Exit code 1\nThe token '&&' is not a valid statement separator.";
    add("PowerShell", "ERROR", "Set-Location C:/r; git diff main && x", separator);
    add("PowerShell", "ERROR", "Set-Location C:/r\ngit diff HEAD && x", separator);
    add(
      "PowerShell",
      "ERROR",
      "$wt = 'C:/r'; npm install",
      "Exit code 1\nnpm : The term 'npm' is not recognized as the name of a cmdlet.",
    );
    // Left out: a program that ran and failed, a benign taskkill exit, a failing test run (D11a),
    // a call blocked before it ran, a success, another shell.
    add("PowerShell", "ERROR", "git commit -F m.txt", "Exit code 1\nleaks found: 1");
    add("PowerShell", "ERROR", "taskkill /PID 1 /T /F", "Exit code 128\nERROR: gone");
    add("PowerShell", "ERROR", "$wt = 'C:/r'; npm test", "Exit code 1\nFAIL x");
    add("PowerShell", "ERROR", "Remove-Item x", "PreToolUse:PowerShell hook error: Blocked");
    add("PowerShell", "OK", "git status", null);
    add("Bash", "ERROR", "git diff", "Exit code 127\n/usr/bin/bash: line 1: x: command not found");

    const calls = shellFailureToolCalls(db, { workspaceId: "ws-1", tool: "PowerShell", ...WINDOW });
    expect(calls.map((call) => [call.target, call.calls, call.tool])).toEqual([
      ["git diff", 2, "PowerShell"],
      // Review 5 residual M12: named by the command the shell did not have.
      ["npm", 1, "PowerShell"],
    ]);
    expect(calls[1]?.result).toBe(
      "Exit code 1 npm : The term 'npm' is not recognized as the name of a cmdlet.",
    );
    db.close();
  });

  it("review 5 residual M12: labels each failure by the command that failed, not the leading one", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'p', '2026-01-01T00:00:00Z')",
    );
    db.exec(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('sess-1', 'ws-1', '/x.jsonl', 'RECONCILED')",
    );
    let n = 0;
    const add = (command: string, error: string) => {
      const id = `ev-${n++}`;
      db.prepare(
        "INSERT INTO tool_events (event_id, session_id, ts, tool_name, exit_class) VALUES (?, 'sess-1', ?, 'PowerShell', 'ERROR')",
      ).run(id, `2026-01-02T00:00:0${n}.000Z`);
      db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
        id,
        JSON.stringify({ command, error }),
      );
    };
    const snippet = '+ ... b.test.ts 2>&1 | Select-String -Pattern "x\\""';
    const marks = `+${" ".repeat(snippet.indexOf("Select-String") - 1)}~~~~~~~~~~~~~~~~~~`;
    const notTail = (at: string) =>
      `Exit code 1\ntail : The term 'tail' is not recognized as the name of a cmdlet.\nAt line:1 char:40\n+ ${at} | tail -30\n+ ~~~~`;
    add("npx vitest run a.test.ts 2>&1 | tail -30", notTail("npx vitest run a.test.ts 2>&1"));
    add("git log --oneline | tail -30", notTail("git log --oneline"));
    // The newest call (listed first) is a parse error in the Select-String pipe.
    add(
      'npx vitest run b.test.ts 2>&1 | Select-String -Pattern "x\\""',
      `Exit code 1\nInvoke-Expression : At line:1 char:40\n${snippet}\n${marks}\nThe string is missing the terminator: ".\n    + CategoryInfo          : ParserError: (:) [Invoke-Expression], ParseException`,
    );

    const calls = shellFailureToolCalls(db, { workspaceId: "ws-1", tool: "PowerShell", ...WINDOW });
    expect(calls.map((call) => [call.target, call.calls])).toEqual([
      ["| tail", 2],
      ["Select-String", 1],
    ]);
    db.close();
  });
});

describe("midSizeToolCalls (U9 r3, D6 targets)", () => {
  it("names the files and shell commands behind mid-size results, leaving out the oversized", () => {
    __resetToolCallTargets();
    const dir = mkdtempSync(path.join(os.tmpdir(), "aw-mid-"));
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'p', '2026-01-01T00:00:00Z')",
    );
    const file = path.join(dir, "s1.jsonl");
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('s1', 'ws-1', ?, 'RECONCILED')",
    ).run(file);
    const lines: string[] = [];
    let n = 0;
    const add = (tool: string, input: Record<string, unknown>, bytes: number) => {
      const id = `toolu_mid_${n++}`;
      lines.push(
        toolUse(id, tool, input),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: id, content: "x" }] },
        }),
      );
      db.prepare(
        "INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes) VALUES (?, 's1', '2026-01-02T00:00:00.000Z', ?, ?)",
      ).run(id, tool, bytes);
    };
    add("Read", { file_path: "/repo/docs/plan.md" }, 20_000);
    add("Read", { file_path: "/repo/docs/plan.md" }, 20_000);
    add("Read", { file_path: "/repo/src/small.ts" }, 2_000);
    add("Bash", { command: "git -C /repo diff main" }, 15_000);
    add("Bash", { command: "git diff HEAD~1" }, 15_000);
    add("Read", { file_path: "/repo/huge.md" }, 40_000);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const calls = midSizeToolCalls(db, { sessionIds: ["s1"], ...WINDOW });
    expect(calls.map((c) => [c.tool, c.target, c.calls, c.total_bytes])).toEqual([
      ["Read", "/repo/docs/plan.md", 2, 40_000],
      ["Read", "/repo/src/small.ts", 1, 2_000],
      ["Bash", "git diff", 2, 30_000],
    ]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("mechanicalRunToolCalls (E2 review)", () => {
  it("folds shell keywords and the long tail into one 'other shell commands' row", () => {
    __resetToolCallTargets();
    const dir = mkdtempSync(path.join(os.tmpdir(), "aw-runs-"));
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'p', '2026-01-01T00:00:00Z')",
    );
    const file = path.join(dir, "s1.jsonl");
    db.prepare(
      "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES ('s1', 'ws-1', ?, 'RECONCILED')",
    ).run(file);
    const commands = [
      ...Array<string>(6).fill("node x.js"),
      ...Array<string>(5).fill("awk '{print}' f"),
      ...Array<string>(5).fill("tail -5 f"),
      ...Array<string>(4).fill("head -5 f"),
      ...Array<string>(4).fill("wc -l f"),
      ...Array<string>(3).fill("netstat -ano"),
      ...Array<string>(3).fill("taskkill /F /PID 1"),
      ...Array<string>(2).fill("jq . f"),
      "curl http://x",
      "uniq f",
      // Shell syntax and wrappers name no tool.
      "for f in a b; do node x.js; done",
      "for f in a b; do wc -l f; done",
      "cd /repo",
      "sleep 2",
      "echo hi",
    ];
    const lines: string[] = [];
    // One mechanical run: three tool-only main turns on the strong model.
    for (let turn = 0; turn < 3; turn++) {
      const messageId = `msg-${turn}`;
      const ts = new Date(Date.parse("2026-01-02T00:00:00.000Z") + turn * 1_000).toISOString();
      db.prepare(
        `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens,
           output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
           cost_equiv_u, cost_claim, provisional, parser_version)
         VALUES (?, 's1', 'ws-1', ?, 'claude-opus-5-5', 0, 0, 50, 0, 0, 0, 0, 0, 'LIST_EQUIV', 0, 'test-v1')`,
      ).run(messageId, ts);
      commands.forEach((command, index) => {
        if (index % 3 !== turn) return;
        const id = `toolu_run_${index}`;
        lines.push(toolUse(id, "Bash", { command }));
        db.prepare(
          "INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes) VALUES (?, 's1', ?, 'Bash', 10)",
        ).run(id, ts);
        db.prepare(
          "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES (?, NULL, ?, ?, 0)",
        ).run(id, messageId, index);
      });
    }
    writeFileSync(file, `${lines.join("\n")}\n`);

    const calls = mechanicalRunToolCalls(db, { sessionIds: ["s1"], ...WINDOW });
    expect(calls.map((c) => [c.target, c.calls, c.session_count])).toEqual([
      ["`node`", 6, 1],
      ["`awk`", 5, 1],
      ["`tail`", 5, 1],
      ["`head`", 4, 1],
      ["`wc`", 4, 1],
      ["`netstat`", 3, 1],
      ["`taskkill`", 3, 1],
      ["`jq`", 2, 1],
      // curl + uniq + five keyword calls.
      ["other shell commands", 7, 1],
    ]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("repoRelative (E1 review)", () => {
  const slug = "D--src-GitHub-Proj";
  it("strips the project folder and any worktree checkout; null outside it", () => {
    expect(repoRelative("D:\\src\\GitHub\\Proj\\docs\\plan.md", slug)).toBe("docs/plan.md");
    expect(repoRelative("D:/src/GitHub/Proj/.worktrees/rr-u8/src/x.ts", slug)).toBe("src/x.ts");
    expect(repoRelative("D:/src/GitHub/Proj2/src/x.ts", slug)).toBeNull();
    expect(repoRelative("D:/src/.claude/memory/m.md", slug)).toBeNull();
    // Resolved targets are `~/…` display paths.
    expect(repoRelative("~/GitHub/Proj/docs/plan.md", slug, "D:\\src")).toBe("docs/plan.md");
    expect(repoRelative("~/.claude/memory/m.md", slug, "D:\\src")).toBeNull();
  });
});

describe("orientationToolCalls (E1 review)", () => {
  it("caps reads per session and leaves out reads in the editing turn", () => {
    __resetToolCallTargets();
    const dir = mkdtempSync(path.join(os.tmpdir(), "aw-orient-"));
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('ws-1', 'p', '2026-01-01T00:00:00Z')",
    );
    let n = 0;
    const session = (sessionId: string, startMs: number) => {
      const file = path.join(dir, `${sessionId}.jsonl`);
      db.prepare(
        "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, 'ws-1', ?, 'RECONCILED')",
      ).run(sessionId, file);
      const lines: string[] = [];
      let ms = startMs;
      /** One main turn issuing `calls`; each event lands 1 ms after the turn, as in real JSONL. */
      const turn = (calls: [tool: string, input: Record<string, unknown>][]) => {
        const messageId = `msg-${n++}`;
        ms += 1_000;
        const turnMs = ms;
        db.prepare(
          `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens,
             output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
             cost_equiv_u, cost_claim, provisional, parser_version)
           VALUES (?, ?, 'ws-1', ?, 'claude-opus', 0, 0, 0, 0, 0, 0, 0, 0, 'LIST_EQUIV', 0, 'test-v1')`,
        ).run(messageId, sessionId, new Date(turnMs).toISOString());
        calls.forEach(([tool, input], index) => {
          const id = `toolu_orient_${n++}`;
          lines.push(toolUse(id, tool, input));
          db.prepare(
            "INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes) VALUES (?, ?, ?, ?, 100)",
          ).run(id, sessionId, new Date(turnMs + 1 + index).toISOString(), tool);
          db.prepare(
            "INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command) VALUES (?, NULL, ?, ?, 0)",
          ).run(id, messageId, index);
        });
      };
      return { turn, done: () => writeFileSync(file, `${lines.join("\n")}\n`) };
    };
    const start = Date.parse("2026-01-02T00:00:00.000Z");
    // s1 reads one file 400 times early on; s2 starts later and reads another file once.
    const s1 = session("s1", start);
    for (let index = 0; index < 400; index++) s1.turn([["Read", { file_path: "/repo/a.md" }]]);
    s1.turn([["Edit", { file_path: "/repo/a.md" }]]);
    s1.done();
    const s2 = session("s2", start + 1_000_000);
    s2.turn([["Read", { file_path: "/repo/b.md" }]]);
    // The editing turn's own Read is part of the edit, not orientation.
    s2.turn([
      ["Read", { file_path: "/repo/c.md" }],
      ["Edit", { file_path: "/repo/b.md" }],
    ]);
    s2.done();

    const calls = orientationToolCalls(db, { sessionIds: ["s1", "s2"], to: WINDOW.to });
    expect(calls.map((c) => [c.target, c.session_count])).toEqual([
      ["/repo/a.md", 1],
      ["/repo/b.md", 1],
    ]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
