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
  fileVersion: FileVersion | null;
}

export interface FileVersion {
  size: number;
  dev: string;
  ino: string;
  mtimeMs: number;
  ctimeMs: number;
}

export interface TailResult {
  lines: string[];
  newOffset: number;
  newHeadHash: string;
  event: null | "TRUNCATION" | "ROTATION";
  wasReset: boolean;
}

export function fileVersion(stat: fs.Stats): FileVersion {
  return {
    size: stat.size,
    dev: String(stat.dev),
    ino: String(stat.ino),
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

export function sameFileVersion(a: FileVersion, b: FileVersion): boolean {
  return (
    a.size === b.size &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
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
export function tailFile(
  filePath: string,
  stored: Offset | null,
  currentVersion?: FileVersion,
): TailResult {
  let storedOffset = stored?.offset ?? 0;
  let storedHead = stored?.headHash ?? null;

  let version = currentVersion;
  try {
    version ??= fileVersion(fs.statSync(filePath));
  } catch {
    return {
      lines: [],
      newOffset: storedOffset,
      newHeadHash: storedHead ?? "",
      event: null,
      wasReset: false,
    };
  }

  const fileSize = version.size;
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

  const storedVersion = stored?.fileVersion ?? null;
  const identityChanged =
    storedVersion !== null &&
    (storedVersion.dev !== version.dev || storedVersion.ino !== version.ino);
  const equalSizeTimestampChanged =
    storedVersion !== null &&
    storedVersion.size === version.size &&
    (storedVersion.mtimeMs !== version.mtimeMs || storedVersion.ctimeMs !== version.ctimeMs);

  if (storedOffset > fileSize) {
    // Size regression always means truncation, regardless of head change.
    event = "TRUNCATION";
    storedOffset = 0;
    wasReset = true;
    storedHead = curHead;
  } else if (identityChanged || equalSizeTimestampChanged || headChanged) {
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
  file_size: number | null;
  file_dev: string | null;
  file_ino: string | null;
  file_mtime_ms: number | null;
  file_ctime_ms: number | null;
}

/** Read the persisted offset for a file, or null if never tailed. */
export function loadOffset(db: Db, filePath: string): Offset | null {
  const row = db
    .prepare(
      "SELECT byte_offset, file_hash_head, file_size, file_dev, file_ino, file_mtime_ms, file_ctime_ms FROM ingest_offsets WHERE file_path = ?",
    )
    .get(filePath) as OffsetRow | undefined;
  if (row === undefined) return null;
  const hasVersion =
    row.file_size !== null &&
    row.file_dev !== null &&
    row.file_ino !== null &&
    row.file_mtime_ms !== null &&
    row.file_ctime_ms !== null;
  return {
    offset: row.byte_offset,
    headHash: row.file_hash_head,
    fileVersion: hasVersion
      ? {
          size: row.file_size as number,
          dev: row.file_dev as string,
          ino: row.file_ino as string,
          mtimeMs: row.file_mtime_ms as number,
          ctimeMs: row.file_ctime_ms as number,
        }
      : null,
  };
}

/** Upsert the persisted offset for a file. */
export function saveOffset(
  db: Db,
  filePath: string,
  offset: number,
  headHash: string,
  version: FileVersion,
): void {
  db.prepare(
    `INSERT INTO ingest_offsets (file_path, byte_offset, file_hash_head, file_size, file_dev, file_ino, file_mtime_ms, file_ctime_ms, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(file_path) DO UPDATE SET
       byte_offset = excluded.byte_offset,
       file_hash_head = excluded.file_hash_head,
       file_size = excluded.file_size,
       file_dev = excluded.file_dev,
       file_ino = excluded.file_ino,
       file_mtime_ms = excluded.file_mtime_ms,
       file_ctime_ms = excluded.file_ctime_ms,
       updated_at = excluded.updated_at`,
  ).run(
    filePath,
    offset,
    headHash,
    version.size,
    version.dev,
    version.ino,
    version.mtimeMs,
    version.ctimeMs,
    new Date().toISOString(),
  );
}
