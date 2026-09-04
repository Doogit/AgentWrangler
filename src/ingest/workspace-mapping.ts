import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Db } from "../db/open.js";

/** Parse a GitHub SSH or HTTPS remote into its canonical owner/repo pair. */
export function parseRemoteUrl(url: string): { owner: string; repo: string } | null {
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(
      url.trim(),
    );
  if (match === null) return null;

  const owner = match[1];
  const repo = match[2]?.replace(/\.git$/i, "");
  if (owner === undefined || repo === undefined || repo === "") return null;
  return { owner, repo };
}

/** Read the origin URL from a local checkout without exposing git output. */
export function defaultReadRemote(repoPath: string): string | null {
  try {
    const result = spawnSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Read the recorded `cwd` (a top-level field, not transcript content) from the first line that
 * carries one, scanning only the head of the file so a large transcript is never fully read.
 */
export function defaultReadCwd(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(65536);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8", 0, bytes).split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const rec = JSON.parse(trimmed) as { cwd?: unknown };
        if (typeof rec.cwd === "string" && rec.cwd !== "") return rec.cwd;
      } catch {
        // A truncated trailing line (or a malformed one) is skipped; cwd is in the head anyway.
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Backfill `discovered_cwd` for workspaces that have none yet — needed on existing installs where
 * the boot back-scan skips already-ingested files (so ingestor.ts never re-captures their cwd).
 * Reads at most one cwd-bearing transcript per unmapped workspace; self-limiting once all are filled.
 */
export function backfillDiscoveredCwd(
  db: Db,
  files: Array<{ filePath: string; projectSlug: string }>,
  readCwd: (filePath: string) => string | null,
): void {
  const needed = new Set(
    (
      db
        .prepare("SELECT project_slug FROM workspaces WHERE discovered_cwd IS NULL")
        .all() as Array<{
        project_slug: string;
      }>
    ).map((r) => r.project_slug),
  );
  if (needed.size === 0) return;

  const setCwd = db.prepare(
    "UPDATE workspaces SET discovered_cwd=? WHERE project_slug=? AND discovered_cwd IS NULL",
  );
  const done = new Set<string>();
  for (const f of files) {
    if (!needed.has(f.projectSlug) || done.has(f.projectSlug)) continue;
    const cwd = readCwd(f.filePath);
    if (cwd === null) continue;
    setCwd.run(cwd, f.projectSlug);
    done.add(f.projectSlug);
  }
}

export function resolveWorkspaceMappings(
  db: Db,
  opts: { readRemote: (path: string) => string | null; unresolved?: Set<string> },
): number {
  db.prepare(
    "UPDATE workspaces SET repo_path=discovered_cwd WHERE repo_path IS NULL AND discovered_cwd IS NOT NULL",
  ).run();

  const workspaces = db
    .prepare(
      "SELECT workspace_id, repo_path FROM workspaces WHERE repo_path IS NOT NULL AND repo_owner IS NULL",
    )
    .all() as Array<{ workspace_id: string; repo_path: string }>;
  const setCanonical = db.prepare(
    "UPDATE workspaces SET repo_owner=?, repo_name=? WHERE workspace_id=? AND repo_owner IS NULL AND repo_name IS NULL",
  );
  let newlyMapped = 0;

  for (const workspace of workspaces) {
    // Skip known failures for the daemon lifetime. A GitHub remote added to a previously
    // remote-less repo while it runs is not picked up until the next daemon restart; this is an
    // acceptable tradeoff for this non-blocking perf fix.
    if (opts.unresolved?.has(workspace.workspace_id)) continue;
    const remote = opts.readRemote(workspace.repo_path);
    if (remote === null) {
      opts.unresolved?.add(workspace.workspace_id);
      continue;
    }
    const mapping = parseRemoteUrl(remote);
    if (mapping === null) {
      opts.unresolved?.add(workspace.workspace_id);
      continue;
    }
    const result = setCanonical.run(mapping.owner, mapping.repo, workspace.workspace_id);
    if (result.changes === 1) newlyMapped += 1;
  }

  return newlyMapped;
}
