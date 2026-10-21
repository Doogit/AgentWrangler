/**
 * test/ingest/content-retention.test.ts — SEC-101 W-A + W-C behavioral coverage.
 *
 * W-A: a failing shell tool event retains a bounded content slice
 * (command + error) in tool_event_content, keyed to the tool event and readable
 * by its consuming detector (C5/D7).
 * W-C: a secret planted in the command or error is redacted before insert — the
 * DB never holds it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/open.js";
import { Ingestor } from "../../src/ingest/index.js";
import { migratedMemDb } from "./dbutil.js";
import { assistant, userToolResult, writeCorpus } from "./synth.js";

const NOW = () => new Date("2026-08-01T00:00:00.000Z");
const OPTS = { now: NOW, activityWindowSecs: 300 };

let db: Db;
beforeEach(() => {
  db = migratedMemDb();
});
afterEach(() => db.close());

function contentFor(eventId: string): { command?: string; error?: string } | undefined {
  const row = db
    .prepare("SELECT content_json FROM tool_event_content WHERE event_id = ?")
    .get(eventId) as { content_json: string } | undefined;
  return row === undefined ? undefined : JSON.parse(row.content_json);
}

describe("SEC-101 W-A targeted-slice retention", () => {
  it("retains a secrets-filtered command + error slice keyed to the tool event", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-content-"));
    try {
      writeCorpus(tmp, {
        "proj-c5": {
          "s.jsonl": [
            assistant({
              id: "m1",
              session: "session-c5",
              ts: "2026-01-02T10:00:00.000Z",
              toolUses: [
                {
                  id: "tu-fail",
                  name: "Bash",
                  command: "deploy --token=sk-proj-abcdef0123456789ABCDEF0123 --env=prod",
                },
              ],
            }),
            userToolResult({
              session: "session-c5",
              ts: "2026-01-02T10:00:01.000Z",
              results: [
                {
                  toolUseId: "tu-fail",
                  text: "Error: auth failed for AKIAIOSFODNN7EXAMPLE — retry",
                  isError: true,
                },
              ],
            }),
          ],
        },
      });
      new Ingestor(db, [tmp], OPTS).runBackscan();

      const content = contentFor("tu-fail");
      expect(content).toBeDefined();
      // W-A: both halves retained and readable.
      expect(content?.command).toContain("deploy");
      expect(content?.command).toContain("--env=prod");
      expect(content?.error).toContain("auth failed");
      // W-C: planted secrets are gone, replaced by placeholders.
      expect(content?.command).not.toContain("sk-proj-abcdef0123456789");
      expect(content?.command).toContain("[REDACTED:key]");
      expect(content?.error).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(content?.error).toContain("[REDACTED:key]");

      // content_included flag set.
      const flag = db
        .prepare("SELECT content_included FROM tool_event_content WHERE event_id = 'tu-fail'")
        .get() as { content_included: number };
      expect(flag.content_included).toBe(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not retain content for a non-shell tool with no error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-content-none-"));
    try {
      writeCorpus(tmp, {
        "proj-read": {
          "s.jsonl": [
            assistant({
              id: "m2",
              session: "session-read",
              ts: "2026-01-02T10:00:00.000Z",
              toolUses: [{ id: "tu-read", name: "Read", input: { file_path: "/x/y.ts" } }],
            }),
            userToolResult({
              session: "session-read",
              ts: "2026-01-02T10:00:01.000Z",
              results: [{ toolUseId: "tu-read", text: "file body", isError: false }],
            }),
          ],
        },
      });
      new Ingestor(db, [tmp], OPTS).runBackscan();
      expect(contentFor("tu-read")).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cascades content deletion when the tool event is removed", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-content-cascade-"));
    try {
      writeCorpus(tmp, {
        "proj-cascade": {
          "s.jsonl": [
            assistant({
              id: "m3",
              session: "session-cascade",
              ts: "2026-01-02T10:00:00.000Z",
              toolUses: [{ id: "tu-c", name: "Bash", command: "ls -la" }],
            }),
          ],
        },
      });
      new Ingestor(db, [tmp], OPTS).runBackscan();
      expect(contentFor("tu-c")).toBeDefined();
      db.prepare("DELETE FROM tool_events WHERE event_id = 'tu-c'").run();
      expect(contentFor("tu-c")).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
