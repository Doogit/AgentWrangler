/**
 * Raw-JSONL spot check for DH3 oracles: a deterministic stride sample of turns is compared with the transcript
 * line they came from (is_sidechain, timestamp, context size). Aggregates only; never reads or returns content.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export interface RawCheckResult {
  sampled: number;
  matched: number;
  missing_file: number;
  /** Sampled turns whose message id was not found in the file. */
  missing_line: number;
  mismatches: { field: string; count: number }[];
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface RawLine {
  isSidechain: boolean;
  timestamp: string;
  context: number;
}

/**
 * Adds message id → RawLine for one file: usage from the last line with usage (streamed blocks repeat the
 * message), timestamp from the first line (what the turn row stores).
 */
function parseFile(file: string, out = new Map<string, RawLine>()): Map<string, RawLine> {
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let o: {
      type?: string;
      uuid?: string;
      isSidechain?: boolean;
      timestamp?: string;
      message?: { id?: string; usage?: Usage };
    };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "assistant" || !o.message?.usage) continue;
    const id = o.message.id ?? o.uuid;
    if (!id) continue;
    const u = o.message.usage;
    out.set(id, {
      isSidechain: o.isSidechain === true,
      timestamp: out.get(id)?.timestamp ?? o.timestamp ?? "",
      context:
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
    });
  }
  return out;
}

export function rawCheck(db: Database.Database, messageIds: string[], sample = 50): RawCheckResult {
  const uniq = [...new Set(messageIds)].sort();
  const stride = Math.max(1, Math.floor(uniq.length / sample));
  const picked: string[] = [];
  for (let i = 0; i < uniq.length && picked.length < sample; i += stride)
    picked.push(uniq[i] as string);

  const stmt = db.prepare(
    `SELECT t.is_sidechain, t.ts, t.context_tokens, s.file_path
     FROM turns t JOIN sessions s ON s.session_id = t.session_id WHERE t.message_id = ?`,
  );
  const files = new Map<string, Map<string, RawLine> | null>();
  const subLoaded = new Set<string>();
  const counts = new Map<string, number>();
  const bump = (f: string): void => void counts.set(f, (counts.get(f) ?? 0) + 1);
  let sampled = 0;
  let matched = 0;
  let missing_file = 0;
  let missing_line = 0;

  for (const id of picked) {
    const row = stmt.get(id) as
      | { is_sidechain: number; ts: string; context_tokens: number; file_path: string }
      | undefined;
    if (!row) {
      missing_line++;
      continue;
    }
    if (!files.has(row.file_path)) {
      let parsed: Map<string, RawLine> | null = null;
      try {
        parsed = parseFile(row.file_path);
      } catch {
        parsed = null;
      }
      files.set(row.file_path, parsed);
    }
    const parsed = files.get(row.file_path);
    if (!parsed) {
      missing_file++;
      continue;
    }
    // Subagent (sidechain) turns live in <session>/subagents/*.jsonl, not in the session file.
    if (!parsed.has(id) && !subLoaded.has(row.file_path)) {
      subLoaded.add(row.file_path);
      const subDir = path.join(row.file_path.replace(/\.jsonl$/, ""), "subagents");
      const walk = (d: string): void => {
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return; // no subagent dir
        }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".jsonl")) parseFile(p, parsed);
        }
      };
      walk(subDir);
    }
    const raw = parsed.get(id);
    if (!raw) {
      missing_line++;
      continue;
    }
    sampled++;
    let ok = true;
    if (raw.isSidechain !== (row.is_sidechain === 1)) {
      bump("is_sidechain");
      ok = false;
    }
    if (Date.parse(raw.timestamp) !== Date.parse(row.ts)) {
      bump("timestamp");
      ok = false;
    }
    if (raw.context !== row.context_tokens) {
      bump("context_tokens");
      ok = false;
    }
    if (ok) matched++;
  }
  return {
    sampled,
    matched,
    missing_file,
    missing_line,
    mismatches: [...counts].map(([field, count]) => ({ field, count })),
  };
}
