import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import {
  classifyBashCommandFamily,
  classifyInterruptKind,
  classifyToolResultError,
} from "../../src/ingest/tool-error-classifier.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, userToolResult, writeCorpus } from "./synth.js";

let db: Db;
beforeEach(() => {
  db = migratedMemDb();
});
afterEach(() => db.close());

describe("tool-result error classifier", () => {
  it("returns only closed labels and fails closed for unknown Claude Code versions", () => {
    expect(classifyToolResultError("File not found: SYNTH_PRIVATE_PATH", "2.1.300")).toBe(
      "NOT_FOUND",
    );
    expect(classifyToolResultError("File SYNTH_PRIVATE_PATH has not been read", "2.1.300")).toBe(
      "NOT_READ",
    );
    expect(
      classifyToolResultError("String to replace not found: SYNTH_PRIVATE_TEXT", "2.1.300"),
    ).toBe("STALE_STRING");
    expect(classifyToolResultError("Patch failed to apply: SYNTH_PRIVATE_TEXT", "2.1.300")).toBe(
      "PATCH_FAILED",
    );
    expect(classifyToolResultError("MCPContentTooLargeError: SYNTH_PRIVATE_TEXT", "2.1.300")).toBe(
      "MCP_CONTENT_TOO_LARGE",
    );
    expect(classifyToolResultError("File not found: SYNTH_PRIVATE_PATH", null)).toBeNull();
    expect(classifyToolResultError("File not found: SYNTH_PRIVATE_PATH", "3.0.0")).toBeNull();
    expect(classifyBashCommandFamily("npm test SYNTH_PRIVATE_PATH")).toBe("BASH_NPM");
    expect(classifyBashCommandFamily("git status SYNTH_PRIVATE_PATH")).toBe("BASH_GIT");
    expect(classifyInterruptKind("other", "[Request interrupted by user]", "2.1.300")).toBe(
      "PURE_INTERRUPT",
    );
    expect(classifyInterruptKind("cancelled", "SYNTH_PRIVATE_TEXT", "2.1.300")).toBe(
      "KILLED_NO_PROMPT",
    );
    expect(
      classifyInterruptKind(
        "user-rejected",
        "The user doesn't want to proceed with this tool use now.",
        "2.1.300",
      ),
    ).toBe("HUMAN_DENY");
    expect(
      classifyInterruptKind("other", "[Request interrupted by user] plus prose", "2.1.300"),
    ).toBeNull();
    expect(classifyInterruptKind("cancelled", "SYNTH_PRIVATE_TEXT", "3.0.0")).toBeNull();
  });

  it("accepts an optional leading <tool_use_error> wrapper on every anchored pattern", () => {
    const W = "<tool_use_error>";
    const cases: Array<[string, string]> = [
      ["File not found: X", "NOT_FOUND"],
      ["Path does not exist: X", "NOT_FOUND"],
      ["File has not been read yet. Read it first", "NOT_READ"],
      ["String to replace not found in file.", "STALE_STRING"],
      ["Patch failed to apply", "PATCH_FAILED"],
      ["MCPContentTooLargeError: X", "MCP_CONTENT_TOO_LARGE"],
    ];
    for (const [text, label] of cases) {
      expect(classifyToolResultError(text, "2.1.300")).toBe(label);
      expect(classifyToolResultError(W + text, "2.1.300")).toBe(label);
    }
    // The wrapper does not loosen the anchor: unrelated wrapped text stays unclassified.
    expect(classifyToolResultError(`${W}InputValidationError: Grep failed`, "2.1.300")).toBeNull();
    expect(classifyToolResultError(`x ${W}File not found`, "2.1.300")).toBeNull();
  });

  it("U7: labels modified-since-read, multi-match and Read over-cap, wrapped or not", () => {
    const W = "<tool_use_error>";
    const cases: Array<[string, string]> = [
      [
        "File has been modified since read, either by the user or by a linter. Read it again.",
        "MODIFIED_SINCE_READ",
      ],
      [
        "Found 3 matches of the string to replace, but replace_all is false. To replace all, set it.",
        "MULTI_MATCH",
      ],
      ["Found 1 match of the string to replace, but replace_all is false.", "MULTI_MATCH"],
      [
        "File content (1.1MB) exceeds maximum allowed size (256KB). Use offset and limit.",
        "READ_OUTPUT_TOO_LARGE",
      ],
      [
        "File content (34813 tokens) exceeds maximum allowed tokens (25000). Use offset.",
        "READ_OUTPUT_TOO_LARGE",
      ],
    ];
    for (const [text, label] of cases) {
      expect(classifyToolResultError(text, "2.1.284")).toBe(label);
      expect(classifyToolResultError(W + text, "2.1.284")).toBe(label);
    }
    // Anchored: the same words mid-text, and a different Found-message, stay unclassified.
    expect(
      classifyToolResultError("Note: File has been modified since read", "2.1.284"),
    ).toBeNull();
    expect(classifyToolResultError("Found 2 matches in 3 files", "2.1.284")).toBeNull();
  });

  it("U7: the 'for tool use' interrupt variant is a PURE_INTERRUPT too", () => {
    const v = "2.1.284";
    expect(classifyInterruptKind("other", "[Request interrupted by user for tool use]", v)).toBe(
      "PURE_INTERRUPT",
    );
    expect(
      classifyInterruptKind(
        "other",
        [{ type: "text", text: "[Request interrupted by user for tool use]" }],
        v,
      ),
    ).toBe("PURE_INTERRUPT");
    expect(
      classifyInterruptKind("other", "[Request interrupted by user for tool use] plus prose", v),
    ).toBeNull();
  });

  it("pins the 2.1.x version gate (future risk: 2.2.x/3.x classify nothing until widened)", () => {
    expect(classifyToolResultError("File not found: X", "2.1.0")).toBe("NOT_FOUND");
    expect(classifyToolResultError("File not found: X", "2.1.12345")).toBe("NOT_FOUND");
    expect(classifyToolResultError("File not found: X", "2.2.0")).toBeNull();
    expect(classifyToolResultError("File not found: X", "2.1.0-beta")).toBeNull();
    expect(classifyToolResultError("File not found: X", "3.0.0")).toBeNull();
  });

  it("persists source-chain provenance, defaulting legacy rows to sidechain", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-sidechain-provenance-"));
    try {
      const session = "sidechain-provenance";
      const main = assistant({ id: "main", session, ts: "2026-09-15T12:00:00.000Z" });
      writeCorpus(root, {
        project: {
          "session.jsonl": [
            main,
            assistant({ id: "side", session, ts: "2026-09-15T12:00:01.000Z", sidechain: true }),
          ],
        },
      });
      const ingestor = new Ingestor(db, [root], {
        now: () => new Date("2026-10-01T00:00:00.000Z"),
      });
      ingestor.runBackscan();
      expect(
        db
          .prepare(
            "SELECT is_sidechain FROM ingest_metric_events WHERE session_id=? ORDER BY event_position",
          )
          .all(session),
      ).toEqual([{ is_sidechain: 0 }, { is_sidechain: 1 }]);

      // A migrated row fails closed as sidechain until an authoritative source re-scan.
      db.prepare(
        "UPDATE ingest_metric_events SET is_sidechain=1 WHERE session_id=? AND is_sidechain=0",
      ).run(session);
      fs.appendFileSync(path.join(root, "project", "session.jsonl"), `${JSON.stringify(main)}\n`);
      ingestor.runBackscan();
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM ingest_metric_events WHERE session_id=? AND is_sidechain=0",
          )
          .get(session),
      ).toEqual({ n: 1 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("correlates closed result labels and Bash family to tool events without retaining source text", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-tool-error-classifier-"));
    try {
      const session = "tool-error-session";
      const ts = "2026-09-15T12:00:00.000Z";
      writeCorpus(root, {
        project: {
          "session.jsonl": [
            assistant({
              id: "owner",
              session,
              ts,
              toolUses: [
                { id: "not-found", name: "Read", input: { file_path: "SYNTH_PRIVATE_PATH" } },
                { id: "not-read", name: "Edit", input: { file_path: "SYNTH_PRIVATE_PATH" } },
                { id: "stale", name: "Edit", input: { file_path: "SYNTH_PRIVATE_PATH" } },
                { id: "patch", name: "Edit", input: { file_path: "SYNTH_PRIVATE_PATH" } },
                { id: "mcp", name: "mcp__private__tool", input: {} },
                { id: "bash", name: "Bash", command: "npm test SYNTH_PRIVATE_PATH" },
              ],
              extra: { version: "2.1.300" },
            }),
            {
              ...userToolResult({
                session,
                ts: "2026-09-15T12:00:01.000Z",
                results: [
                  {
                    toolUseId: "not-found",
                    text: "File not found: SYNTH_PRIVATE_PATH",
                    isError: true,
                  },
                  {
                    toolUseId: "not-read",
                    text: "File SYNTH_PRIVATE_PATH has not been read",
                    isError: true,
                  },
                  {
                    toolUseId: "stale",
                    text: "String to replace not found: SYNTH_PRIVATE_TEXT",
                    isError: true,
                  },
                  {
                    toolUseId: "patch",
                    text: "Patch failed to apply: SYNTH_PRIVATE_TEXT",
                    isError: true,
                  },
                  {
                    toolUseId: "mcp",
                    text: "MCPContentTooLargeError: SYNTH_PRIVATE_TEXT",
                    isError: true,
                  },
                  { toolUseId: "bash", text: "SYNTH_UNMATCHED_ERROR_TEXT", isError: true },
                ],
              }),
              version: "2.1.300",
            },
          ],
        },
      });
      new Ingestor(db, [root], { now: () => new Date("2026-10-01T00:00:00.000Z") }).runBackscan();
      const rows = db
        .prepare(
          `SELECT event_id, tool_error_class, tool_error_classifier_version, bash_command_family
             FROM tool_events WHERE session_id=? ORDER BY event_id`,
        )
        .all(session);
      expect(rows).toEqual([
        {
          event_id: "bash",
          tool_error_class: null,
          tool_error_classifier_version: null,
          bash_command_family: "BASH_NPM",
        },
        {
          event_id: "mcp",
          tool_error_class: "MCP_CONTENT_TOO_LARGE",
          tool_error_classifier_version: "tool-error-1",
          bash_command_family: null,
        },
        {
          event_id: "not-found",
          tool_error_class: "NOT_FOUND",
          tool_error_classifier_version: "tool-error-1",
          bash_command_family: null,
        },
        {
          event_id: "not-read",
          tool_error_class: "NOT_READ",
          tool_error_classifier_version: "tool-error-1",
          bash_command_family: null,
        },
        {
          event_id: "patch",
          tool_error_class: "PATCH_FAILED",
          tool_error_classifier_version: "tool-error-1",
          bash_command_family: null,
        },
        {
          event_id: "stale",
          tool_error_class: "STALE_STRING",
          tool_error_classifier_version: "tool-error-1",
          bash_command_family: null,
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain("SYNTH_PRIVATE");
      expect(JSON.stringify(rows)).not.toContain("SYNTH_UNMATCHED");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces the closed schema and classifier version at the database boundary", () => {
    db.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES ('schema-ws', 'schema-ws', ?)",
    ).run("2026-09-15T00:00:00.000Z");
    db.prepare(
      `INSERT INTO sessions
        (session_id, workspace_id, file_path, state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES ('s', 'schema-ws', '/fixture/schema.jsonl', 'LIVE', 0, 0, '[]')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO tool_events
        (event_id, session_id, ts, tool_name, tool_error_class, tool_error_classifier_version)
       VALUES (?, 's', '2026-09-15T00:00:00.000Z', 'Read', ?, ?)`,
    );
    expect(() => insert.run("closed-ok", "NOT_FOUND", "tool-error-1")).not.toThrow();
    expect(() => insert.run("closed-label", "PRIVATE_TEXT", "tool-error-1")).toThrow(/CHECK/);
    expect(() => insert.run("closed-version", "NOT_FOUND", "tool-error-2")).toThrow(/unknown/);
    expect(() => insert.run("closed-missing-version", "NOT_FOUND", null)).toThrow(/unknown/);
    const interruptInsert = db.prepare(
      `INSERT INTO tool_events
        (event_id, session_id, ts, tool_name, interrupt_kind, interrupt_classifier_version)
       VALUES (?, 's', '2026-09-15T00:00:00.000Z', 'Read', ?, ?)`,
    );
    expect(() =>
      interruptInsert.run("interrupt-ok", "PURE_INTERRUPT", "interrupt-1"),
    ).not.toThrow();
    expect(() => interruptInsert.run("interrupt-label", "PRIVATE_TEXT", "interrupt-1")).toThrow(
      /CHECK/,
    );
    expect(() => interruptInsert.run("interrupt-version", "HUMAN_DENY", "interrupt-2")).toThrow(
      /unknown/,
    );
  });
});
