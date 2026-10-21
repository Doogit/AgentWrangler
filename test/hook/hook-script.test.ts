import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stageToStdout } from "../../src/hook/context-budget-hook.mjs";

const HOOK = path.resolve("src/hook/context-budget-hook.mjs");

/** Run the real hook script against a stub endpoint that always answers `stage` and records URLs. */
async function runHook(
  input: Record<string, unknown>,
  markerDir: string,
  urls: string[],
  stage = "hard",
): Promise<string> {
  const server = http.createServer((req, res) => {
    urls.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: { stage, context_tokens: 70_000 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [HOOK], {
        env: { ...process.env, AW_PORT: String(port), AW_HOOK_MARKER_DIR: markerDir },
      });
      let out = "";
      child.stdout.on("data", (c) => {
        out += c;
      });
      child.on("close", () => resolve(out));
      child.stdin.end(JSON.stringify(input));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("context-budget hook agent scoping (U6)", () => {
  it("passes agent_id, and a subagent warning does not silence the main thread", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-hook-"));
    const urls: string[] = [];
    const sub = { session_id: "s1", agent_id: "a1b2", agent_type: "general-purpose" };
    expect(await runHook(sub, dir, urls)).toContain("additionalContext");
    expect(urls[0]).toBe("/api/context-budget?session_id=s1&agent_id=a1b2");
    // Same subagent again inside the debounce window: silent.
    expect(await runHook(sub, dir, urls)).toBe("");
    // Main thread right after: still warns, and sends no agent_id.
    expect(await runHook({ session_id: "s1" }, dir, urls)).toContain("additionalContext");
    expect(urls[2]).toBe("/api/context-budget?session_id=s1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fails open (no request, no warning) when agent_type has no agent_id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-hook-"));
    const urls: string[] = [];
    expect(await runHook({ session_id: "s1", agent_type: "Explore" }, dir, urls)).toBe("");
    expect(urls).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// Claude Code only hands the model additionalContext from inside hookSpecificOutput; a top-level
// copy is dropped. A warn-only hook must not set permissionDecision ("allow" skips the prompt).
describe("context-budget hook stage output", () => {
  it("is silent for ok", () => {
    expect(stageToStdout("ok")).toBe("");
  });

  it("puts the soft warning where the model sees it", () => {
    const out = JSON.parse(stageToStdout("soft"));
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: expect.stringContaining("approaching its limit"),
    });
    expect(out).not.toHaveProperty("additionalContext");
    expect(out.systemMessage).toContain("AgentWrangler:");
  });

  it("asks for a commit and handoff at hard, with the live token count, never deciding permission", () => {
    const output = stageToStdout("hard", { context_tokens: 301_234 });
    const out = JSON.parse(output);
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: expect.stringMatching(/301k tokens.*Commit.*handoff.*\/clear/),
    });
    expect(out).not.toHaveProperty("additionalContext");
    expect(output).not.toContain("permissionDecision");
    expect(output).not.toContain("/compact");
    expect(output).not.toContain("transcript");
  });

  it("omits the token count when the endpoint gives none", () => {
    const out = JSON.parse(stageToStdout("hard"));
    expect(out.hookSpecificOutput.additionalContext).not.toContain("tokens");
  });
});
