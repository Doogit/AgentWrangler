/**
 * src/ingest/discovery.ts — transcript-file discovery + workspace registration.
 *
 * Each subdirectory of a scan root is a candidate workspace (project_slug);
 * every *.jsonl beneath it (recursively, including nested subagent transcripts)
 * is a session file. New slugs auto-register as unmapped
 * workspaces so spend is visible immediately (repo mapping is a later WP4 step).
 *
 * Discovery is poll-based (default 30s cadence), distinct from the faster tail
 * cadence. Filesystem watch is an optional optimisation not required for
 * correctness — offsets + dedupe make a full re-scan cheap and idempotent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Db } from "../db/open.js";

export interface DiscoveredFile {
  filePath: string;
  projectSlug: string;
}

/** Recursively collect every *.jsonl under `dir`, tagging each with `slug`. */
function collectJsonl(dir: string, slug: string, out: DiscoveredFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Emit files at this level BEFORE descending, so a session's own transcript
  // (<slug>/<uuid>.jsonl) is discovered before its nested subagent files
  // (<slug>/<uuid>/subagents/agent-*.jsonl). Both carry the same parent sessionId
  // and ensureSession records file_path first-seen — files-before-dirs keeps the
  // session's file_path pointing at the top-level transcript, not a subagent file.
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push({ filePath: path.join(dir, e.name), projectSlug: slug });
    }
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      collectJsonl(path.join(dir, e.name), slug, out);
    }
  }
}

interface CachedSlugDirectory {
  projectSlug: string;
  mtimeMs: number;
  files: DiscoveredFile[];
}

interface CachedRootDirectory {
  mtimeMs: number;
  slugDirs: Map<string, CachedSlugDirectory>;
}

/** In-process discovery state owned by an Ingestor instance. */
export interface DiscoveryCache {
  files: DiscoveredFile[];
  roots: Map<string, CachedRootDirectory>;
  initialized: boolean;
}

/** Create an empty cache; the first refresh performs one full walk. */
export function createDiscoveryCache(): DiscoveryCache {
  return { files: [], roots: new Map(), initialized: false };
}

function directoryMtimeMs(dir: string): number | null {
  try {
    const stat = fs.statSync(dir);
    return stat.isDirectory() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function readSlugDirectories(
  root: string,
): Map<string, { projectSlug: string; mtimeMs: number }> | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const slugDirs = new Map<string, { projectSlug: string; mtimeMs: number }>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const mtimeMs = directoryMtimeMs(dir);
    if (mtimeMs === null) continue;
    slugDirs.set(dir, { projectSlug: entry.name, mtimeMs });
  }
  return slugDirs;
}

function isInside(dir: string, filePath: string): boolean {
  const relative = path.relative(dir, filePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function filesForSlug(
  discovered: DiscoveredFile[],
  dir: string,
  projectSlug: string,
): DiscoveredFile[] {
  return discovered.filter(
    (file) => file.projectSlug === projectSlug && isInside(dir, file.filePath),
  );
}

function walkSlugFiles(dir: string, projectSlug: string): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];
  collectJsonl(dir, projectSlug, files);
  return files;
}

function replaceFullCache(
  roots: string[],
  cache: DiscoveryCache,
  discovered: DiscoveredFile[],
): void {
  const nextRoots = new Map<string, CachedRootDirectory>();
  for (const root of roots) {
    const rootMtimeMs = directoryMtimeMs(root);
    if (rootMtimeMs === null) continue;
    const slugDirs = readSlugDirectories(root);
    if (slugDirs === null) continue;

    const cachedSlugDirs = new Map<string, CachedSlugDirectory>();
    for (const [dir, slug] of slugDirs) {
      cachedSlugDirs.set(dir, {
        projectSlug: slug.projectSlug,
        mtimeMs: slug.mtimeMs,
        files: filesForSlug(discovered, dir, slug.projectSlug),
      });
    }
    nextRoots.set(root, { mtimeMs: rootMtimeMs, slugDirs: cachedSlugDirs });
  }

  cache.files = discovered;
  cache.roots = nextRoots;
  cache.initialized = true;
}

/** Refresh only changed slug directories, or force a periodic full walk. */
export function refreshDiscoveryCache(
  roots: string[],
  cache: DiscoveryCache,
  forceRefresh = false,
): DiscoveredFile[] {
  if (forceRefresh || !cache.initialized) {
    replaceFullCache(roots, cache, discoverFiles(roots));
    return cache.files;
  }

  const activeRoots = new Set(roots);
  for (const root of cache.roots.keys()) {
    if (!activeRoots.has(root)) cache.roots.delete(root);
  }

  for (const root of roots) {
    const rootMtimeMs = directoryMtimeMs(root);
    if (rootMtimeMs === null) {
      cache.roots.delete(root);
      continue;
    }

    let cachedRoot = cache.roots.get(root);
    const isNewRoot = cachedRoot === undefined;
    if (cachedRoot === undefined) {
      cachedRoot = { mtimeMs: rootMtimeMs, slugDirs: new Map() };
      cache.roots.set(root, cachedRoot);
    }

    const rootChanged = isNewRoot || cachedRoot.mtimeMs !== rootMtimeMs;
    if (rootChanged) {
      const currentSlugDirs = readSlugDirectories(root);
      if (currentSlugDirs !== null) {
        const nextSlugDirs = new Map<string, CachedSlugDirectory>();
        for (const [dir, slug] of currentSlugDirs) {
          const previous = cachedRoot.slugDirs.get(dir);
          nextSlugDirs.set(
            dir,
            previous !== undefined && previous.mtimeMs === slug.mtimeMs
              ? previous
              : {
                  projectSlug: slug.projectSlug,
                  mtimeMs: slug.mtimeMs,
                  files: walkSlugFiles(dir, slug.projectSlug),
                },
          );
        }
        cachedRoot.slugDirs = nextSlugDirs;
      }
      cachedRoot.mtimeMs = rootMtimeMs;
      continue;
    }

    for (const [dir, cachedSlug] of cachedRoot.slugDirs) {
      const mtimeMs = directoryMtimeMs(dir);
      if (mtimeMs === null) {
        cachedRoot.slugDirs.delete(dir);
        continue;
      }
      if (mtimeMs === cachedSlug.mtimeMs) continue;

      const files = walkSlugFiles(dir, cachedSlug.projectSlug);
      cachedSlug.mtimeMs = mtimeMs;
      cachedSlug.files = files;
    }
  }

  cache.files = [...cache.roots.values()].flatMap((root) =>
    [...root.slugDirs.values()].flatMap((slug) => slug.files),
  );
  return cache.files;
}

/** Walk each root; return every *.jsonl file with its owning project slug. */
export function discoverFiles(roots: string[]): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      // projectSlug is always the top-level slug dir; recurse so nested subagent
      // transcripts (<slug>/<session>/subagents/agent-*.jsonl) are discovered and
      // attributed to the same workspace as their parent session.
      collectJsonl(path.join(root, d.name), d.name, out);
    }
  }
  return out;
}

/**
 * Register a workspace for `slug` if not already present, returning its
 * workspace_id. The slug is used as the workspace_id (deterministic, keeps
 * rebuild-equality stable). Idempotent via INSERT OR IGNORE.
 */
export function registerWorkspace(db: Db, slug: string): string {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES (?,?,?)`,
  ).run(slug, slug, new Date().toISOString());
  return slug;
}

/** The session id used when a record carries none: the file's basename stem. */
export function sessionStemFor(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}
