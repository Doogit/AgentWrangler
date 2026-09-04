import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { Transform } from "node:stream";
import { fingerprintBranchRef } from "../../outcomes/branch-key.js";
import type { FileIdentity } from "../common/boundary.js";

const MAX_PR_LINKS = 64;
const MAX_REPOSITORY_BYTES = 255;

export interface FrozenTranscriptEntry {
  sessionId: string;
  path: string;
  identity: FileIdentity;
  sha256: string;
}

export interface TranscriptPrLinkProjection {
  prNumber: number;
  prRepository: string;
}

export interface TranscriptStructuralProjection {
  links: TranscriptPrLinkProjection[];
  branchKeys: Set<string>;
  malformedLines: number;
}

export type TranscriptReadFailureReason =
  | "MISSING"
  | "UNREADABLE"
  | "REPLACED"
  | "CHANGED"
  | "LIMIT_EXCEEDED"
  | "CORPUS_MISMATCH";

export type StrictTranscriptHarvestResult =
  | { ok: true; projection: TranscriptStructuralProjection }
  | { ok: false; reason: TranscriptReadFailureReason };

export type StrictTranscriptHarvester = (
  entry: FrozenTranscriptEntry,
) => Promise<StrictTranscriptHarvestResult>;

function identityOf(stat: fs.BigIntStats): FileIdentity {
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.inode !== "0";
}

function classifyReadError(error: unknown): TranscriptReadFailureReason {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "MISSING" : "UNREADABLE";
}

/**
 * Stream one descriptor-attested transcript and retain only bounded structural signals.
 * The pathname and raw refs never cross the result boundary.
 */
export async function harvestFrozenTranscript(
  entry: FrozenTranscriptEntry,
): Promise<StrictTranscriptHarvestResult> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(entry.path, "r");
  } catch (error) {
    return { ok: false, reason: classifyReadError(error) };
  }

  try {
    let before: fs.BigIntStats;
    try {
      before = await handle.stat({ bigint: true });
    } catch {
      return { ok: false, reason: "UNREADABLE" };
    }
    if (!before.isFile()) {
      return { ok: false, reason: "UNREADABLE" };
    }
    if (!sameIdentity(identityOf(before), entry.identity)) {
      return { ok: false, reason: "REPLACED" };
    }
    if (before.size.toString() !== entry.identity.size) {
      return { ok: false, reason: "CHANGED" };
    }

    const links: TranscriptPrLinkProjection[] = [];
    const branchKeys = new Set<string>();
    let malformedLines = 0;
    let projectionLimitExceeded = false;
    const digest = createHash("sha256");
    const hashingStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    const input = handle.createReadStream({ autoClose: false, encoding: "utf8" });
    input.pipe(hashingStream);
    const lines = readline.createInterface({
      input: hashingStream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    try {
      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let record: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            malformedLines += 1;
            continue;
          }
          record = parsed as Record<string, unknown>;
        } catch {
          malformedLines += 1;
          continue;
        }

        if (branchKeys.size < 2) {
          const branchKey = fingerprintBranchRef(record.gitBranch);
          if (branchKey !== null) branchKeys.add(branchKey);
        }
        if (record.type === "pr-link") {
          const repository = record.prRepository;
          if (
            typeof record.prNumber === "number" &&
            Number.isSafeInteger(record.prNumber) &&
            record.prNumber > 0 &&
            typeof repository === "string" &&
            Buffer.byteLength(repository, "utf8") <= MAX_REPOSITORY_BYTES &&
            /^[^/\s]+\/[^/\s]+$/u.test(repository) &&
            links.length < MAX_PR_LINKS
          ) {
            links.push({ prNumber: record.prNumber, prRepository: repository });
          } else if (
            typeof record.prNumber === "number" &&
            Number.isSafeInteger(record.prNumber) &&
            record.prNumber > 0 &&
            typeof repository === "string" &&
            Buffer.byteLength(repository, "utf8") <= MAX_REPOSITORY_BYTES &&
            /^[^/\s]+\/[^/\s]+$/u.test(repository)
          ) {
            projectionLimitExceeded = true;
          } else {
            malformedLines += 1;
          }
        }
      }
    } catch {
      return { ok: false, reason: "UNREADABLE" };
    }

    let after: fs.BigIntStats;
    try {
      after = await handle.stat({ bigint: true });
    } catch {
      return { ok: false, reason: "UNREADABLE" };
    }
    if (!sameIdentity(identityOf(after), entry.identity)) {
      return { ok: false, reason: "REPLACED" };
    }
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      digest.digest("hex") !== entry.sha256
    ) {
      return { ok: false, reason: "CHANGED" };
    }

    let pathnameAfter: fs.BigIntStats;
    try {
      pathnameAfter = await fs.promises.stat(entry.path, { bigint: true });
    } catch (error) {
      return { ok: false, reason: classifyReadError(error) };
    }
    if (!sameIdentity(identityOf(pathnameAfter), entry.identity)) {
      return { ok: false, reason: "REPLACED" };
    }
    if (pathnameAfter.size.toString() !== entry.identity.size) {
      return { ok: false, reason: "CHANGED" };
    }
    if (projectionLimitExceeded) {
      return { ok: false, reason: "LIMIT_EXCEEDED" };
    }

    return { ok: true, projection: { links, branchKeys, malformedLines } };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
