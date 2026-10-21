import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_WORKSPACE_ID } from "../../src/detector/context-probe.js";
import { runDetectors } from "../../src/detector/index.js";
import { displayPath } from "../../src/query/api/rec-actions/families/context.js";
import { listRecommendations } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;
beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  db.prepare(`INSERT OR IGNORE INTO workspaces
    (workspace_id, project_slug, registered_at) VALUES (?, '__global__', ?)`).run(
    GLOBAL_WORKSPACE_ID,
    new Date().toISOString(),
  );
  // Strictly before the detector's `now`: windows are `ts < now`, so a same-millisecond ts (fast
  // Linux/macOS runners) drops every turn and no D1 card is produced.
  db.prepare("UPDATE turns SET ts = ?").run(new Date(Date.now() - 60_000).toISOString());
});
afterEach(() => {
  resetQueryDb();
  db.close();
});

describe("D1 source action provenance", () => {
  it("resolves the exact global probe file and fails closed if it disappears or changes scope", () => {
    const file = process.execPath; // existing absolute file outside the workspace
    db.prepare(`INSERT INTO context_inventory
      (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
      VALUES ('probe-d1-global', ?, ?, 'CLAUDE_MD', ?, 'hash', 5000, 'chars4-v1')`).run(
      GLOBAL_WORKSPACE_ID,
      new Date().toISOString(),
      file,
    );
    runDetectors(db, { now: new Date() });
    const card = () => listRecommendations().data?.active.find((rec) => rec.detector_id === "D1");
    expect(card()?.file_ref).toBe(file);
    expect(card()?.actions?.primary.file_ref).toBe(file);
    expect(card()?.actions?.primary.copy_text).toContain(displayPath(file));
    expect(card()?.actions?.primary.copy_text).toContain("estimated tokens");
    expect(card()?.action_validation?.primary).toEqual({ ok: true });
    expect(card()?.evidence.attribution_method).toBe("CHARS4_ESTIMATE");
    db.prepare(
      "UPDATE context_inventory SET component = 'MEMORY' WHERE probe_id = 'probe-d1-global'",
    ).run();
    expect(card()?.file_ref).toBeNull();
    expect(card()?.action_validation?.primary.ok).toBe(false);
  });

  it("resolves a global memory directory to its exact MEMORY.md file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-d1-memory-"));
    const file = path.join(dir, "MEMORY.md");
    try {
      fs.writeFileSync(file, "# Synthetic memory fixture\n");
      db.prepare(`INSERT INTO context_inventory
        (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
        VALUES ('probe-d1-memory', ?, ?, 'MEMORY', ?, 'hash', 5000, 'chars4-v1')`).run(
        GLOBAL_WORKSPACE_ID,
        new Date().toISOString(),
        dir,
      );
      runDetectors(db, { now: new Date() });
      const card = () => listRecommendations().data?.active.find((rec) => rec.detector_id === "D1");
      expect(card()?.file_ref).toBe(file);
      expect(card()?.actions?.primary.copy_text).toContain(displayPath(file));
      expect(card()?.action_validation?.primary).toEqual({ ok: true });
      fs.unlinkSync(file);
      expect(card()?.action_validation?.primary.ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
