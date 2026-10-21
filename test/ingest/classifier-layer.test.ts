import { describe, expect, it } from "vitest";
import { projectLine } from "../../src/ingest/parser.js";

const ctx = { defaultSessionId: "classifier-file" };
const project = (record: Record<string, unknown>) => {
  const result = projectLine(JSON.stringify(record), ctx);
  if (result.kind !== "record") throw new Error("expected record");
  return result;
};
const denial = (kind: string, text: string, version = "2.1.22") => ({
  type: "user",
  timestamp: "2026-01-01T00:00:00.000Z",
  sessionId: "s",
  version,
  toolDenialKind: kind,
  message: { content: [{ type: "tool_result", is_error: true, content: text }] },
});

describe("U6 classifier layer", () => {
  it("classifies corroborated denial families and structural API errors", () => {
    expect(
      project(denial("user-rejected", "The user doesn't want to proceed with this tool use now."))
        .classifierLabel,
    ).toBe("user-rejected");
    expect(project(denial("other", "PreToolUse: fixture hook error")).classifierLabel).toBe(
      "hook-block",
    );
    expect(
      project(denial("other", "Permission to use Bash has been denied.")).classifierLabel,
    ).toBe("deny-rule");
    expect(project(denial("cancelled", "irrelevant", "2.1.22")).classifierLabel).toBe(
      "interrupt-cancel",
    );
    expect(
      project({
        type: "assistant",
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "s",
        isApiErrorMessage: true,
        message: { content: [] },
      }).classifierLabel,
    ).toBe("api-error");
  });

  it("rejects over-stamped user-rejected labels without stable corroboration", () => {
    expect(
      project(denial("user-rejected", "Permission to use Bash has been denied.")).classifierLabel,
    ).toBe("deny-rule");
    expect(
      project(denial("user-rejected", "SYNTH_UNCORROBORATED_DENIAL")).classifierLabel,
    ).toBeNull();
  });

  it("version-gates lexical matching but stamps the source version", () => {
    const result = project(
      denial("user-rejected", "The user doesn't want to proceed with this tool use now.", "3.0.0"),
    );
    expect(result.classifierLabel).toBeNull();
    expect(result.ccVersion).toBe("3.0.0");
  });

  it("keeps SEC-4: command text is converted to closed shape/op only", () => {
    const sentinel = "SYNTH_SECRET_COMMAND_DO_NOT_STORE";
    const result = project({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "s",
      message: {
        content: [
          { type: "tool_use", id: "u", name: "Bash", input: { command: `rm -rf ${sentinel}` } },
        ],
      },
    });
    expect(result.commandShape).toBe("bash:args-2-3");
    expect(result.destructiveOp).toBe("rm-rf");
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("leaves benign lines unlabelled", () => {
    const result = project({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "s",
      message: { content: [] },
    });
    expect(result.classifierLabel).toBeNull();
    expect(result.commandShape).toBeNull();
    expect(result.destructiveOp).toBeNull();
  });
});

describe("RC-D14: user text-block interrupts", () => {
  const userText = (content: unknown, version = "2.1.22") => ({
    type: "user",
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "s",
    version,
    message: { role: "user", content },
  });

  it("flags a plain Esc record (one text block or a string) as an interrupt with its own label", () => {
    for (const content of [
      [{ type: "text", text: "[Request interrupted by user]" }],
      "[Request interrupted by user]",
    ]) {
      const result = project(userText(content));
      expect(result.isInterrupt).toBe(true);
      expect(result.classifierLabel).toBe("interrupt-cancel");
    }
  });

  it("flags the 'for tool use' variant as an interrupt but leaves the denial label to its tool_result", () => {
    const result = project(
      userText([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
    );
    expect(result.isInterrupt).toBe(true);
    expect(result.classifierLabel).toBeNull();
  });

  it("does not flag a tool_result that merely quotes the marker", () => {
    const quoted = {
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      sessionId: "s",
      version: "2.1.22",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            content: 'const MARK = "[Request interrupted by user]";',
          },
        ],
      },
    };
    const result = project(quoted);
    expect(result.isInterrupt).toBe(false);
    expect(result.classifierLabel).toBeNull();
  });

  it("does not flag a text block that only contains the marker among other text", () => {
    const result = project(
      userText([{ type: "text", text: "see [Request interrupted by user] in the log" }]),
    );
    expect(result.isInterrupt).toBe(false);
    expect(result.classifierLabel).toBeNull();
  });

  it("keeps structural cancellations labelled but not counted as a user interrupt", () => {
    const result = project(denial("interrupted", "irrelevant"));
    expect(result.classifierLabel).toBe("interrupt-cancel");
    expect(result.isInterrupt).toBe(false);
  });
});
