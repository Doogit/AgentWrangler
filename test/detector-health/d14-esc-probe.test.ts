/**
 * RC-D14: a real Esc is a user text block, not a tool_result. Ingest synthetic transcripts through
 * the real parser and check the D14 probe and detector agree: the plain Esc counts; the "for tool
 * use" variant (a human rejection) and a tool_result that quotes the marker do not.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCase, withCaseDb } from "./harness.js";
import { probeD14 } from "./probes/D14.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const MARK = "[Request interrupted by user]";
let dirs: string[] = [];

function transcript(userContent: unknown): string {
  const sid = "esc-session";
  const base = { sessionId: sid, version: "2.1.5" };
  const usage = {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const turn = (id: string, ts: string) => ({
    type: "assistant",
    timestamp: ts,
    ...base,
    message: {
      id,
      model: "claude-sonnet-4-6",
      usage,
      content: [{ type: "text", text: "SYNTH_ASSISTANT_TEXT" }],
    },
  });
  const lines = [
    turn("esc-t1", "2026-01-16T09:00:00.000Z"),
    {
      type: "user",
      timestamp: "2026-01-16T09:00:01.000Z",
      ...base,
      message: { role: "user", content: userContent },
    },
    turn("esc-t2", "2026-01-16T09:00:03.000Z"),
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-d14-esc-"));
  dirs.push(dir);
  const ws = path.join(dir, "esc-ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(
    path.join(ws, `${sid}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  return ws;
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("D14 Esc source: probe and detector on parsed transcripts (RC-D14)", () => {
  it("a plain Esc text block qualifies and fires", () => {
    const ws = transcript([{ type: "text", text: MARK }]);
    expect(withCaseDb(ws, NOW, (db) => probeD14(db, NOW)).qualifying).toBe(1);
    expect(runCase("D14", ws, "fires", NOW).pass).toBe(true);
  });

  it("a plain Esc as string content qualifies and fires", () => {
    const ws = transcript(MARK);
    expect(withCaseDb(ws, NOW, (db) => probeD14(db, NOW)).qualifying).toBe(1);
    expect(runCase("D14", ws, "fires", NOW).pass).toBe(true);
  });

  it("the 'for tool use' variant is a human rejection: neither counts", () => {
    const ws = transcript([{ type: "text", text: "[Request interrupted by user for tool use]" }]);
    const r = withCaseDb(ws, NOW, (db) => probeD14(db, NOW));
    expect(r.candidates).toBe(1);
    expect(r.qualifying).toBe(0);
    expect(runCase("D14", ws, "silent", NOW).pass).toBe(true);
  });

  it("text that only quotes the marker is not an Esc", () => {
    const ws = transcript([{ type: "text", text: `grep found ${MARK} in a log` }]);
    expect(withCaseDb(ws, NOW, (db) => probeD14(db, NOW)).candidates).toBe(0);
    expect(runCase("D14", ws, "silent", NOW).pass).toBe(true);
  });
});
