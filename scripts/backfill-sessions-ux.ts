import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Db } from "../src/db/open.js";
import { recomputeCompactionBoundaries } from "../src/ingest/compaction-boundaries.js";
import { projectLine } from "../src/ingest/parser.js";

export interface BackfillCounts {
  sessionsScanned: number;
  titlesSet: number;
  boundaryTurnsSet: number;
  filesMissing: number;
}

type Session = { session_id: string; file_path: string | null; title_source: string | null };
type Title = { value: string; source: "ai" | "custom" };

async function readTitle(filePath: string, sessionId: string): Promise<Title | null> {
  let title: Title | null = null;
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      const projected = projectLine(line, { defaultSessionId: path.parse(filePath).name });
      if (projected.kind !== "record" || projected.sessionId !== sessionId) continue;
      if (projected.title !== null) {
        if (projected.title.source === "custom" || title?.source !== "custom") {
          title = projected.title;
        }
        if (title?.source === "custom") break;
      }
    }
  } finally {
    lines.close();
  }
  return title;
}

export async function backfillSessionsUx(
  db: Db,
  opts: { dryRun?: boolean } = {},
): Promise<BackfillCounts> {
  const counts: BackfillCounts = {
    sessionsScanned: 0,
    titlesSet: 0,
    boundaryTurnsSet: 0,
    filesMissing: 0,
  };
  const sessions = db
    .prepare("SELECT session_id, file_path, title_source FROM sessions ORDER BY session_id")
    .all() as Session[];
  const setTitle = db.prepare(
    "UPDATE sessions SET title = ?, title_source = ? WHERE session_id = ? AND (? = 'custom' OR title_source IS NULL OR title_source = 'ai')",
  );

  // Pre-compile the rollback sentinel so try/catch recognises it.
  class DryRunRollback extends Error {}

  for (const session of sessions) {
    counts.sessionsScanned++;

    // Title backfill: requires the file.
    const fileMissing = session.file_path === null || !fs.existsSync(session.file_path);
    if (fileMissing) counts.filesMissing++;

    let title: Title | null = null;
    if (!fileMissing && session.title_source === null && session.file_path !== null) {
      title = await readTitle(session.file_path, session.session_id);
    }

    // Boundary recompute: DB-only, no file needed.
    let boundaryAdded: number;
    if (opts.dryRun) {
      let computed = 0;
      try {
        db.transaction(() => {
          computed = recomputeCompactionBoundaries(db, session.session_id);
          throw new DryRunRollback();
        })();
      } catch (e) {
        if (!(e instanceof DryRunRollback)) throw e;
      }
      boundaryAdded = computed;
    } else {
      boundaryAdded = recomputeCompactionBoundaries(db, session.session_id);
    }

    const titleChange = session.title_source === null && title !== null;
    counts.titlesSet += titleChange ? 1 : 0;
    counts.boundaryTurnsSet += boundaryAdded;

    if (!opts.dryRun && titleChange && title !== null) {
      setTitle.run(title.value, title.source, session.session_id, title.source);
    }
  }
  return counts;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dbPath = path.join(os.homedir(), ".agentwrangler", "db.sqlite");
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--db" && args[i + 1] !== undefined) dbPath = args[++i] as string;
    else throw new Error("Usage: backfill:sessions-ux [--db <path>] [--dry-run]");
  }
  // dry-run uses transaction+rollback rather than readonly mode, so the DB
  // must be opened writable even for a dry run.
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const c = await backfillSessionsUx(db, { dryRun });
    process.stdout.write(
      `sessions scanned=${c.sessionsScanned} titles set=${c.titlesSet} boundary turns set=${c.boundaryTurnsSet} files missing=${c.filesMissing}\n`,
    );
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
