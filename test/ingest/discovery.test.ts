/**
 * test/ingest/discovery.test.ts — discoverFiles recursion (WP7).
 *
 * Verifies that nested subagent transcripts
 * (<slug>/<session>/subagents/agent-*.jsonl) are discovered and attributed
 * to the top-level slug, and that a missing subagents dir does not crash.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDiscoveryCache,
  discoverFiles,
  refreshDiscoveryCache,
} from "../../src/ingest/discovery.js";

const SLUG = "proj-disc";
const SESSION_UUID = "c3d4e5f6-0012-4567-abcd-ef9012345678";

let tmp: string;

try {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-disc-"));
} catch {
  tmp = "";
}

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("discoverFiles — recursive subagent discovery", () => {
  it("finds top-level and nested subagent JSONL files under the same slug", () => {
    // Build tree: <tmp>/<slug>/top.jsonl
    //             <tmp>/<slug>/<uuid>/subagents/agent-1.jsonl
    const slugDir = path.join(tmp, SLUG);
    const subDir = path.join(slugDir, SESSION_UUID, "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "top.jsonl"), '{"type":"system"}\n', "utf8");
    fs.writeFileSync(path.join(subDir, "agent-1.jsonl"), '{"type":"system"}\n', "utf8");

    const found = discoverFiles([tmp]);

    expect(found).toHaveLength(2);
    expect(found.every((f) => f.projectSlug === SLUG)).toBe(true);

    // Top-level transcript is emitted before nested subagent files
    // (files-before-dirs), so a session's file_path resolves to its own
    // transcript rather than a subagent file that shares its sessionId.
    expect(found.map((f) => path.basename(f.filePath))).toEqual(["top.jsonl", "agent-1.jsonl"]);
  });

  it("returns 1 entry and does not crash when no subagents dir exists", () => {
    // A second slug with only a top-level JSONL and no subdirs.
    const slugDir2 = path.join(tmp, "proj-flat");
    fs.mkdirSync(slugDir2, { recursive: true });
    fs.writeFileSync(path.join(slugDir2, "session.jsonl"), '{"type":"system"}\n', "utf8");

    const found = discoverFiles([tmp]).filter((f) => f.projectSlug === "proj-flat");
    expect(found).toHaveLength(1);
    expect(found.map((f) => path.basename(f.filePath))).toEqual(["session.jsonl"]);
  });

  it("skips agentwrangler-canary workspaces (P3.1-T3)", () => {
    const canary =
      "C--Users-dev-AppData-Local-Temp-agentwrangler-canary-00000000-0000-4000-8000-000000000000";
    fs.mkdirSync(path.join(tmp, canary), { recursive: true });
    fs.writeFileSync(path.join(tmp, canary, "s.jsonl"), '{"type":"system"}\n', "utf8");

    expect(discoverFiles([tmp]).some((f) => f.projectSlug === canary)).toBe(false);
    const cache = createDiscoveryCache();
    expect(refreshDiscoveryCache([tmp], cache).some((f) => f.projectSlug === canary)).toBe(false);
    fs.writeFileSync(path.join(tmp, canary, "t.jsonl"), '{"type":"system"}\n', "utf8");
    expect(refreshDiscoveryCache([tmp], cache).some((f) => f.projectSlug === canary)).toBe(false);
  });
});
