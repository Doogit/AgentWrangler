/**
 * src/ingest/tail.ts — offset-persisting byte tailer.
 *
 * Promoted from the proven spike (spikes/s2-live-tail/s2-core.mjs). Pure file
 * logic; offsets persist in the `ingest_offsets` SQLite table.
 *
 * Invariants:
 *  - only complete lines (terminated by \n) are emitted; a partial trailing line
 *    waits for the next pass (offset is not advanced past it);
 *  - truncation (fileSize < storedOffset) ⇒ reset to 0 + re-scan;
 *  - rotation (head-hash mismatch) ⇒ reset to 0 + re-scan;
 *  - re-scans are made safe by message_id dedupe downstream (idempotent).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { Db } from "../db/open.js";

const HEAD_BYTES = 256; // bytes hashed for rotation detection

export interface Offset {
  offset: number;
  headHash: string | null;
}

export interface TailResult {
  lines: string[];
  newOffset: number;
  newHeadHash: string;
  event: null | "TRUNCATION" | "ROTATION";
  wasReset: boolean;
}

/** SHA-256 of the first n bytes of a file (or fewer if the file is shorter). */
function headHashN(filePath: string, n: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(n);
    const bytesRead = fs.readSync(fd, buf, 0, n, 0);
    return crypto.createHash("sha256").update(buf.subarray(0, bytesRead)).digest("hex");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * SHA-256 of the first HEAD_BYTES bytes (or fewer if the file is shorter).
 * Returns "<bytesRead>:<hexHash>" so comparisons can re-use the same byte count
 * and avoid false rotation signals when a small file grows.
 */
export function headHash(filePath: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const hex = crypto.createHash("sha256").update(buf.subarray(0, n)).digest("hex");
    return `${n}:${hex}`;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Tail one file from its stored offset. Returns complete lines only.
 * See module header for the rotation/truncation contract.
 */
export function tailFile(filePath: string, stored: Offset | null): TailResult {
  let storedOffset = stored?.offset ?? 0;
  let storedHead = stored?.headHash ?? null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return {
      lines: [],
      newOffset: storedOffset,
      newHeadHash: storedHead ?? "",
      event: null,
      wasReset: false,
    };
  }

  const fileSize = stat.size;
  let event: TailResult["event"] = null;
  let wasReset = false;

  const curHead = fileSize > 0 ? headHash(filePath) : "";

  // Re-hash using the stored byte count so a growing file doesn't appear to
  // rotate. headHash always width-prefixes ("<n>:<hex>"), so storedHead carries
  // the byte count we hashed originally.
  let headChanged = false;
  if (storedHead !== null && storedHead !== "") {
    const colonIdx = storedHead.indexOf(":");
    const storedN = Number.parseInt(storedHead.slice(0, colonIdx), 10);
    const storedHex = storedHead.slice(colonIdx + 1);
    if (fileSize >= storedN) {
      headChanged = headHashN(filePath, storedN) !== storedHex;
    }
    // fileSize < storedN: size regression — headChanged stays false; handled below.
  }

  if (storedOffset > fileSize) {
    // Size regression always means truncation, regardless of head change.
    event = "TRUNCATION";
    storedOffset = 0;
    wasReset = true;
    storedHead = curHead;
  } else if (headChanged) {
    event = "ROTATION";
    storedOffset = 0;
    wasReset = true;
    storedHead = curHead;
  } else if (storedHead === null) {
    storedHead = curHead;
  }

  if (fileSize === storedOffset) {
    return { lines: [], newOffset: storedOffset, newHeadHash: curHead, event, wasReset };
  }

  const toRead = fileSize - storedOffset;
  const buf = Buffer.alloc(toRead);
  let bytesRead: number;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    bytesRead = fs.readSync(fd, buf, 0, toRead, storedOffset);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  // Find last newline (0x0A is a single byte in UTF-8, so this is safe).
  let lastNl = -1;
  for (let i = bytesRead - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) {
      lastNl = i;
      break;
    }
  }

  if (lastNl === -1) {
    // Entire read is a partial line — hold it, do not advance.
    return { lines: [], newOffset: storedOffset, newHeadHash: curHead, event, wasReset };
  }

  const completeStr = buf.subarray(0, lastNl).toString("utf8");
  const newOffset = storedOffset + lastNl + 1;
  const lines = completeStr.split("\n").filter((l) => l.length > 0);

  return { lines, newOffset, newHeadHash: curHead, event, wasReset };
}

interface OffsetRow {
  byte_offset: number;
  file_hash_head: string | null;
}

/** Read the persisted offset for a file, or null if never tailed. */
export function loadOffset(db: Db, filePath: string): Offset | null {
  const row = db
    .prepare("SELECT byte_offset, file_hash_head FROM ingest_offsets WHERE file_path = ?")
    .get(filePath) as OffsetRow | undefined;
  if (row === undefined) return null;
  return { offset: row.byte_offset, headHash: row.file_hash_head };
}

/** Upsert the persisted offset for a file. */
export function saveOffset(db: Db, filePath: string, offset: number, headHash: string): void {
  db.prepare(
    `INSERT INTO ingest_offsets (file_path, byte_offset, file_hash_head, updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(file_path) DO UPDATE SET
       byte_offset = excluded.byte_offset,
       file_hash_head = excluded.file_hash_head,
       updated_at = excluded.updated_at`,
  ).run(filePath, offset, headHash, new Date().toISOString());
}
