/**
 * test/ingest/parser.test.ts — SEC-101 projection unit tests.
 */

import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { isTestCommand, projectLine } from "../../src/ingest/parser.js";
import { assistant, synthetic, systemCommand, userCommand, userToolResult } from "./synth.js";

const ctx = { defaultSessionId: "file-stem" };

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function legacyCommandId(sessionId: string, ts: string, originalCommand: string): string {
  return `cmd-${crypto
    .createHash("sha1")
    .update(`${sessionId}|${ts}|${originalCommand}`)
    .digest("hex")
    .slice(0, 20)}`;
}

describe("projectLine — turns", () => {
  it("projects a usage record into a turn with tokens and cache split", () => {
    const r = projectLine(
      line(
        assistant({
          id: "m1",
          session: "s1",
          ts: "2026-01-02T10:00:00.000Z",
          model: "claude-sonnet-4-6",
          input: 2000,
          output: 400,
          cacheRead: 1000,
          cw5m: 500,
          cw1h: 200,
          cwTotal: 700,
          effort: "high",
        }),
      ),
      ctx,
    );
    expect(r.kind).toBe("record");
    if (r.kind !== "record" || r.turn === null) throw new Error("expected turn");
    expect(r.turn.messageId).toBe("m1");
    expect(r.turn.sessionId).toBe("s1");
    expect(r.turn.inputTokens).toBe(2000);
    expect(r.turn.outputTokens).toBe(400);
    expect(r.turn.thinkingTokens).toBeNull();
    expect(r.turn.cacheReadTokens).toBe(1000);
    expect(r.turn.cacheWrite5m).toBe(500);
    expect(r.turn.cacheWrite1h).toBe(200);
    expect(r.turn.cacheWriteOther).toBe(0);
    expect(r.turn.effort).toBe("high");
    expect(r.turn.isSidechain).toBe(false);
  });

  it("extracts thinking tokens from output_tokens_details", () => {
    const record = assistant({ id: "thinking", session: "s", ts: "t" });
    const message = record.message as Record<string, unknown>;
    const usage = message.usage as Record<string, unknown>;
    usage.output_tokens_details = { thinking_tokens: 37 };

    const r = projectLine(line(record), ctx);
    if (r.kind !== "record" || r.turn === null) throw new Error("expected turn");
    expect(r.turn.thinkingTokens).toBe(37);
  });

  it("returns null thinking tokens when output_tokens_details is absent", () => {
    const r = projectLine(line(assistant({ id: "no-thinking", session: "s", ts: "t" })), ctx);
    if (r.kind !== "record" || r.turn === null) throw new Error("expected turn");
    expect(r.turn.thinkingTokens).toBeNull();
  });

  it("classifies a typed user record without tool results as genuine", () => {
    const r = projectLine(
      line({
        type: "user",
        promptSource: "typed",
        timestamp: "t",
        sessionId: "s",
        message: { content: [] },
      }),
      ctx,
    );
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.isUserTurn).toBe(true);
    expect(r.unknownFields).not.toContain("promptSource");
  });

  it("does not classify a user record carrying tool results as genuine", () => {
    const record = userToolResult({
      session: "s",
      ts: "t",
      results: [{ toolUseId: "tool-1", text: "result" }],
    });
    record.promptSource = "typed";

    const r = projectLine(line(record), ctx);
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.isUserTurn).toBe(false);
  });

  it("does not classify a meta user record as genuine", () => {
    const r = projectLine(
      line({
        type: "user",
        promptSource: "queued",
        isMeta: true,
        timestamp: "t",
        sessionId: "s",
        message: { content: [] },
      }),
      ctx,
    );
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.isUserTurn).toBe(false);
  });

  it("does not classify an assistant record as a genuine user turn", () => {
    const r = projectLine(line(assistant({ id: "assistant", session: "s", ts: "t" })), ctx);
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.isUserTurn).toBe(false);
  });

  it("computes cache_write_other as total minus 5m and 1h", () => {
    const r = projectLine(
      line(assistant({ id: "m", session: "s", ts: "t", cw5m: 100, cw1h: 50, cwTotal: 400 })),
      ctx,
    );
    if (r.kind !== "record" || r.turn === null) throw new Error("expected turn");
    expect(r.turn.cacheWriteOther).toBe(250);
  });

  it("marks sidechain records", () => {
    const r = projectLine(
      line(assistant({ id: "m", session: "s", ts: "t", sidechain: true })),
      ctx,
    );
    if (r.kind !== "record" || r.turn === null) throw new Error("expected turn");
    expect(r.turn.isSidechain).toBe(true);
  });

  // P3.2-F6: after /clear, session_id is the launcher session; sessionId is this transcript's.
  it("prefers sessionId over session_id, falls back to the file stem", () => {
    const withBoth = projectLine(
      line({
        type: "assistant",
        timestamp: "t",
        session_id: "launcher",
        sessionId: "transcript",
        message: { id: "m", model: "claude-sonnet-4-6", usage: { input_tokens: 1 } },
      }),
      ctx,
    );
    if (withBoth.kind !== "record" || withBoth.turn === null) throw new Error("turn");
    expect(withBoth.turn.sessionId).toBe("transcript");

    const snakeOnly = projectLine(
      line({
        type: "assistant",
        timestamp: "t",
        session_id: "snake",
        message: { id: "m1", model: "claude-sonnet-4-6", usage: { input_tokens: 1 } },
      }),
      ctx,
    );
    if (snakeOnly.kind !== "record" || snakeOnly.turn === null) throw new Error("turn");
    expect(snakeOnly.turn.sessionId).toBe("snake");

    const withNone = projectLine(
      line({
        type: "assistant",
        timestamp: "t",
        message: { id: "m2", model: "claude-sonnet-4-6", usage: { input_tokens: 1 } },
      }),
      ctx,
    );
    if (withNone.kind !== "record" || withNone.turn === null) throw new Error("turn");
    expect(withNone.turn.sessionId).toBe("file-stem");
  });
});

describe("projectLine — exclusions and quarantine", () => {
  it("flags synthetic-model records as synthetic (not a turn, not quarantine)", () => {
    const r = projectLine(line(synthetic({ session: "s", ts: "t" })), ctx);
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.synthetic).toBe(true);
    expect(r.turn).toBeNull();
  });

  it("treats empty-model usage records as synthetic", () => {
    const r = projectLine(
      line({ type: "assistant", timestamp: "t", message: { id: "m", model: "", usage: {} } }),
      ctx,
    );
    if (r.kind !== "record") throw new Error("expected record");
    expect(r.synthetic).toBe(true);
  });

  it("quarantines a usage record missing its timestamp (required field)", () => {
    const r = projectLine(
      line({ message: { id: "m", model: "claude-sonnet-4-6", usage: { input_tokens: 1 } } }),
      ctx,
    );
    expect(r.kind).toBe("quarantine");
    if (r.kind !== "quarantine") throw new Error("q");
    expect(r.errorClass).toBe("MISSING_REQUIRED");
  });

  it("quarantines a usage record with no dedupe key", () => {
    const r = projectLine(
      line({
        type: "assistant",
        timestamp: "t",
        message: { model: "claude-sonnet-4-6", usage: {} },
      }),
      ctx,
    );
    expect(r.kind).toBe("quarantine");
  });

  it("quarantines invalid JSON with an error class and no content", () => {
    const r = projectLine("{not valid json", ctx);
    expect(r.kind).toBe("quarantine");
    if (r.kind !== "quarantine") throw new Error("q");
    expect(r.errorClass.startsWith("JSON_")).toBe(true);
  });

  it("quarantines a non-object JSON line", () => {
    const r = projectLine("42", ctx);
    expect(r.kind).toBe("quarantine");
    if (r.kind !== "quarantine") throw new Error("q");
    expect(r.errorClass).toBe("NOT_OBJECT");
  });
});

describe("projectLine — tolerance and structural extraction", () => {
  it("tolerates unknown top-level fields and reports them", () => {
    const r = projectLine(
      line(assistant({ id: "m", session: "s", ts: "t", extra: { experimentalX: 1, wobble: 2 } })),
      ctx,
    );
    if (r.kind !== "record" || r.turn === null) throw new Error("turn survives");
    expect(r.unknownFields.sort()).toEqual(["experimentalX", "wobble"]);
  });

  it("extracts tool_use blocks with size and a git-command hint", () => {
    const r = projectLine(
      line(
        assistant({
          id: "m",
          session: "s",
          ts: "t",
          toolUses: [
            { id: "tu-1", name: "Bash", command: "git commit -m 'x'" },
            { id: "tu-2", name: "Read", input: { file: "a.ts" } },
          ],
        }),
      ),
      ctx,
    );
    if (r.kind !== "record") throw new Error("record");
    expect(r.toolEvents).toHaveLength(2);
    const git = r.toolEvents.find((t) => t.toolUseId === "tu-1");
    expect(git?.gitCommandHint).toBe(true);
    expect(git?.inputBytes).toBeGreaterThan(0);
    const read = r.toolEvents.find((t) => t.toolUseId === "tu-2");
    expect(read?.gitCommandHint).toBe(false);
  });

  it("canonicalizes input hashes and projects only a hash of file_path", () => {
    const first = projectLine(
      line(
        assistant({
          id: "owner-1",
          session: "s",
          ts: "t",
          toolUses: [
            {
              id: "tu-canonical-1",
              name: "Read",
              input: { file_path: "C:/private/project/secret.ts", options: { z: 1, a: 2 } },
            },
          ],
        }),
      ),
      ctx,
    );
    const second = projectLine(
      line(
        assistant({
          id: "owner-2",
          session: "s",
          ts: "t2",
          toolUses: [
            {
              id: "tu-canonical-2",
              name: "Read",
              input: { options: { a: 2, z: 1 }, file_path: "C:/private/project/secret.ts" },
            },
          ],
        }),
      ),
      ctx,
    );
    const equivalentPath = projectLine(
      line(
        assistant({
          id: "owner-3",
          session: "s",
          ts: "t3",
          toolUses: [
            {
              id: "tu-canonical-3",
              name: "Read",
              input: {
                options: { z: 1, a: 2 },
                file_path: "C:\\private\\project\\nested\\..\\secret.ts",
              },
            },
          ],
        }),
      ),
      ctx,
    );
    if (first.kind !== "record" || second.kind !== "record" || equivalentPath.kind !== "record")
      throw new Error("record");
    expect(first.toolEvents[0]?.inputHash).toBe(second.toolEvents[0]?.inputHash);
    expect(equivalentPath.toolEvents[0]?.inputHash).toBe(first.toolEvents[0]?.inputHash);
    expect(first.toolEvents[0]?.filePathHash).toMatch(/^[0-9a-f]{64}$/);
    expect(equivalentPath.toolEvents[0]?.filePathHash).toBe(first.toolEvents[0]?.filePathHash);
    expect(first.toolEvents[0]?.ownerMessageId).toBe("owner-1");
    expect(first.toolEvents[0]?.blockIndex).toBe(0);
    expect(JSON.stringify(first.toolEvents[0])).not.toContain("C:/private/project/secret.ts");
  });

  it("projects Edit old_string/new_string as hashes only (C6), and nothing for other tools", () => {
    const projected = projectLine(
      line(
        assistant({
          id: "owner-edit",
          session: "s",
          ts: "t",
          toolUses: [
            {
              id: "tu-edit",
              name: "Edit",
              input: {
                file_path: "/fixture/a.ts",
                old_string: "alpha one",
                new_string: "beta two",
              },
            },
            {
              id: "tu-write",
              name: "Write",
              input: { file_path: "/fixture/a.ts", old_string: "alpha one", new_string: "x" },
            },
          ],
        }),
      ),
      ctx,
    );
    if (projected.kind !== "record") throw new Error("record");
    const [edit, write] = projected.toolEvents;
    const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
    expect(edit?.editOldStringHash).toBe(sha("alpha one"));
    expect(edit?.editNewStringHash).toBe(sha("beta two"));
    expect(write?.editOldStringHash).toBeNull();
    expect(write?.editNewStringHash).toBeNull();
    expect(JSON.stringify(edit)).not.toContain("alpha one");
    expect(JSON.stringify(edit)).not.toContain("beta two");
  });

  it("classifies only anchored, known test commands", () => {
    expect(isTestCommand("npm test -- --runInBand")).toBe(true);
    expect(isTestCommand("npx vitest run test/ingest")).toBe(true);
    expect(isTestCommand("python -m pytest -q")).toBe(true);
    expect(isTestCommand("echo npm test")).toBe(false);
    expect(isTestCommand("npm run build")).toBe(false);
  });

  // Operator 2026-10-14: a test run chained after setup, or a verify script, is still a test run.
  it("classifies a test run in any segment of a chained command", () => {
    expect(isTestCommand("cd app && npm test")).toBe(true);
    expect(isTestCommand("npm run build; npx vitest run")).toBe(true);
    expect(isTestCommand("CI=1 npm test")).toBe(true);
    expect(isTestCommand("& npm run verify:app")).toBe(true);
    expect(isTestCommand("npm --prefix web test")).toBe(true);
    expect(isTestCommand("npx playwright test e2e")).toBe(true);
    expect(isTestCommand("git log | grep 'npm test'")).toBe(false);
    expect(isTestCommand("npx tsc --noEmit && npm run lint")).toBe(false);
  });

  it("flags a test run from the PowerShell tool", () => {
    const projected = projectLine(
      line(
        assistant({
          id: "owner-ps",
          session: "s",
          ts: "t",
          toolUses: [
            { id: "tu-ps", name: "PowerShell", input: { command: "npm run verify:app" } },
            { id: "tu-ps2", name: "PowerShell", input: { command: "Get-ChildItem" } },
          ],
        }),
      ),
      ctx,
    );
    if (projected.kind !== "record") throw new Error("record");
    expect(projected.toolEvents.map((e) => e.testCommandHint)).toEqual([true, false]);
  });

  it("extracts tool_result size and a commit SHA (structural, not content)", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const r = projectLine(
      line(
        userToolResult({
          session: "s",
          ts: "t",
          results: [{ toolUseId: "tu-1", text: `[main ${sha}] done` }],
        }),
      ),
      ctx,
    );
    if (r.kind !== "record") throw new Error("record");
    expect(r.toolResults).toHaveLength(1);
    expect(r.toolResults[0]?.resultBytes).toBeGreaterThan(0);
    expect(r.toolResults[0]?.commitSha).toBe(sha);
    expect(r.toolResults[0]?.isError).toBe(false);
  });

  it("extracts git's short commit form [<branch> <7-12 hex>] (O-3)", () => {
    const shaOf = (text: string): string | null => {
      const r = projectLine(
        line(userToolResult({ session: "s", ts: "t", results: [{ toolUseId: "tu-1", text }] })),
        ctx,
      );
      if (r.kind !== "record") throw new Error("record");
      return r.toolResults[0]?.commitSha ?? null;
    };
    expect(shaOf("[main 1a2b3c4] fix: thing\n 1 file changed")).toBe("1a2b3c4");
    expect(shaOf("[feat/x-y 1a2b3c4d5e6f] msg")).toBe("1a2b3c4d5e6f");
    expect(shaOf("[main (root-commit) abcdef0] init")).toBe("abcdef0");
    expect(shaOf("[detached HEAD abcdef0] wip")).toBe("abcdef0");
    expect(shaOf("hook output\n[main abcdef0] msg")).toBe("abcdef0");
    // Not the commit summary line: no link.
    expect(shaOf("   abcdef0..1234567  main -> main")).toBeNull();
    expect(shaOf("see [main abc] too short")).toBeNull();
  });

  it("flags git commit/push with -C/-c options as a git write (O-3)", () => {
    const hints = (command: string): boolean => {
      const r = projectLine(
        line(
          assistant({
            id: "o",
            session: "s",
            ts: "t",
            toolUses: [{ id: "tu", name: "Bash", input: { command } }],
          }),
        ),
        ctx,
      );
      if (r.kind !== "record") throw new Error("record");
      return r.toolEvents[0]?.gitCommandHint ?? false;
    };
    expect(hints('git -C "C:/a b/wt" commit -q -m x')).toBe(true);
    expect(hints("git -C .worktrees/x -c core.hooksPath=h commit -m x")).toBe(true);
    expect(hints("git commit -m x")).toBe(true);
    expect(hints("git -C wt log --oneline")).toBe(false);
  });

  it("projects tool_result is_error structurally and retains a W-A error slice", () => {
    // SEC-101 rescope (ADR-112): an error result now deliberately retains a
    // bounded, secrets-filtered error excerpt (errorSlice) for C5/D7. is_error
    // stays a structural boolean; no other field carries content.
    const r = projectLine(
      line(
        userToolResult({
          session: "s",
          ts: "t",
          results: [{ toolUseId: "tu-error", text: "fabricated failure", isError: true }],
        }),
      ),
      ctx,
    );
    if (r.kind !== "record") throw new Error("record");
    expect(r.toolResults[0]?.isError).toBe(true);
    expect(r.toolResults[0]?.errorSlice).toBe("fabricated failure");
  });

  it("does not retain an error slice for a successful tool_result", () => {
    const r = projectLine(
      line(
        userToolResult({
          session: "s",
          ts: "t",
          results: [{ toolUseId: "tu-ok", text: "all good", isError: false }],
        }),
      ),
      ctx,
    );
    if (r.kind !== "record") throw new Error("record");
    expect(r.toolResults[0]?.errorSlice).toBeNull();
    expect(JSON.stringify(r.toolResults[0])).not.toContain("all good");
  });

  it("projects a local_command system record", () => {
    const r = projectLine(line(systemCommand({ session: "s", ts: "t", command: "/compact" })), ctx);
    if (r.kind !== "record") throw new Error("record");
    expect(r.command?.command).toBe("/compact");
    expect(r.command?.eventId).toBe(legacyCommandId("s", "t", "/compact"));
  });

  it("classifies exact system markers for both accepted subtypes with legacy IDs", () => {
    for (const subtype of ["local_command", "away_summary"] as const) {
      for (const marker of ["/compact", "/clear"] as const) {
        const r = projectLine(
          line(systemCommand({ session: "sys", ts: "time", subtype, command: marker })),
          ctx,
        );
        if (r.kind !== "record" || r.command === null) throw new Error("command record");
        expect(r.command).toEqual({
          sessionId: "sys",
          ts: "time",
          eventId: legacyCommandId("sys", "time", marker),
          command: marker,
        });
      }
    }
  });

  it("shares exact-marker identity with the bare-user producer without broadening it", () => {
    for (const marker of ["/compact", "/clear"] as const) {
      const r = projectLine(
        line(userCommand({ session: "user", ts: "time", content: marker })),
        ctx,
      );
      if (r.kind !== "record" || r.command === null) throw new Error("user command record");
      expect(r.command).toEqual({
        sessionId: "user",
        ts: "time",
        eventId: legacyCommandId("user", "time", marker),
        command: marker,
      });
    }
    for (const content of ["/compact note", " /compact", "/Compact", ["/compact"]]) {
      const r = projectLine(line(userCommand({ session: "user", ts: "time", content })), ctx);
      if (r.kind !== "record") throw new Error("record");
      expect(r.command).toBeNull();
    }
  });

  it("captures /clear and /compact from <command-name> tags in user string content", () => {
    for (const marker of ["/clear", "/compact"] as const) {
      const content = `<command-name>${marker}</command-name>\n<command-message>${marker.slice(1)}</command-message>\n<command-args></command-args>`;
      const r = projectLine(line(userCommand({ session: "tag", ts: "time", content })), ctx);
      if (r.kind !== "record" || r.command === null) throw new Error("command record");
      expect(r.command).toEqual({
        sessionId: "tag",
        ts: "time",
        eventId: legacyCommandId("tag", "time", marker),
        command: marker,
      });
    }
  });

  it("emits nothing for other slash commands in <command-name> tags", () => {
    const content = "<command-name>/model</command-name>\n<command-args>opus</command-args>";
    const r = projectLine(line(userCommand({ session: "tag", ts: "time", content })), ctx);
    if (r.kind !== "record") throw new Error("record");
    expect(r.command).toBeNull();
  });

  it("does not double-count a tool_result record containing the tag text", () => {
    const r = projectLine(
      line(
        userToolResult({
          session: "tag",
          ts: "time",
          results: [{ toolUseId: "t1", text: "<command-name>/clear</command-name>" }],
        }),
      ),
      ctx,
    );
    if (r.kind !== "record") throw new Error("record");
    expect(r.command).toBeNull();
    expect(r.toolResults).toHaveLength(1);
  });

  it("retains no unclassified command text while preserving its legacy identity", () => {
    const variants = [
      "/help",
      "/deploy --token=SYNTHETIC_SECRET",
      "/compact synthetic-note",
      " /compact",
      "/Compact",
      "/compact\0suffix",
      `/${"z".repeat(4096)}`,
    ];
    for (const source of variants) {
      const r = projectLine(
        line(systemCommand({ session: "privacy", ts: "same-time", command: source })),
        ctx,
      );
      if (r.kind !== "record" || r.command === null) throw new Error("command record");
      expect(r.command.command).toBeNull();
      expect(r.command.eventId).toBe(legacyCommandId("privacy", "same-time", source));
      expect(JSON.stringify(r.command)).not.toContain(source);
    }
  });

  it("uses subtype identity for missing or non-string system commands", () => {
    for (const command of [undefined, null, ["/compact"]]) {
      const r = projectLine(
        line(systemCommand({ session: "fallback", ts: "time", subtype: "away_summary", command })),
        ctx,
      );
      if (r.kind !== "record" || r.command === null) throw new Error("command record");
      expect(r.command.command).toBeNull();
      expect(r.command.eventId).toBe(legacyCommandId("fallback", "time", "away_summary"));
    }
  });
});
