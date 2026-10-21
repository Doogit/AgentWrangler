/**
 * src/ingest/worktree-workspace-merge.ts — fold worktree workspaces into their repo.
 *
 * Before discovery mapped worktree slugs to their repo (workspaceSlugFor), a session
 * started inside `<repo>/.worktrees/<x>` registered its own workspace, which showed up
 * as a second "Owner/Repo" entry. This moves those rows to the repo's workspace. Cheap
 * and idempotent, so it runs on every boot.
 */

import type { Db } from "../db/open.js";
import { registerWorkspace, workspaceSlugFor } from "./discovery.js";
import { bumpEnrichmentEpoch } from "./enrichment-epoch.js";

const WORKSPACE_TABLES = [
  "sessions",
  "turns",
  "context_inventory",
  "context_inventory_history",
  "work_items",
  "work_records",
  "work_allocation_revisions",
] as const;

/** Returns the number of worktree workspaces merged. */
export function mergeWorktreeWorkspaces(db: Db): number {
  const ids = (
    db.prepare("SELECT workspace_id FROM workspaces").all() as { workspace_id: string }[]
  )
    .map((r) => r.workspace_id)
    .filter((id) => workspaceSlugFor(id) !== id);
  if (ids.length === 0) return 0;
  db.transaction(() => {
    for (const id of ids) {
      const parent = registerWorkspace(db, workspaceSlugFor(id));
      for (const table of WORKSPACE_TABLES) {
        db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ?`).run(parent, id);
      }
      db.prepare("DELETE FROM workspaces WHERE workspace_id = ?").run(id);
    }
    bumpEnrichmentEpoch(db); // turns moved to another workspace
  })();
  return ids.length;
}
