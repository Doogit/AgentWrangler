/**
 * src/detector/calibration.ts — Bytes→token calibration for D6 (R12).
 *
 * Calibrates the bytes-per-token ratio used by D6 TOOL_RESULT_BLOAT by sampling
 * real tool-result content blocks from the user's own transcripts and counting
 * their tokens via Anthropic's free count_tokens API (no generation, no charge).
 *
 * Privacy gate (opt-in, OFF by default):
 *   Calibration sends sampled tool-result TEXT to Anthropic count_tokens.
 *   AgentWrangler's invariant is "no data leaves your machine," so calibration
 *   requires explicit opt-in via user_config.bytes_per_token_calibration_enabled.
 *   When disabled: no text leaves, D6 uses the default ratio, modeled_savings=null.
 *
 * SEC-101:
 *   Sampled text lives in memory ONLY for the count_tokens call and is immediately
 *   discarded. Only byte length, token count, the final ratio, and the provenance
 *   string are stored (in user_config). No raw content ever reaches the DB, a file,
 *   or any log.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Db } from "../db/open.js";
import type { TokenCounter } from "../oauth/count-tokens.js";
import { countTokens } from "../oauth/count-tokens.js";

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

/** Default bytes-per-token when no calibration has been run. */
export const DEFAULT_BYTES_PER_TOKEN = 4;

/** Fallback model when the DB has no turns or the auto-picked model 404s. */
const FALLBACK_MODEL = "claude-sonnet-4-6";

/** Minimum successful samples before we trust the median. */
const MIN_SAMPLES = 30;

/** Default maximum samples to collect. */
const DEFAULT_MAX_SAMPLES = 150;

/** Skip blocks larger than this (bytes). */
const DEFAULT_MAX_BLOCK_BYTES = 100_000;

// ---------------------------------------------------------------------------
// user_config helpers (local; mirrors settings-store pattern)
// ---------------------------------------------------------------------------

export function configGet(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM user_config WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function configSet(db: Db, key: string, value: string | null): void {
  db.prepare(
    `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Resolve the current ratio from user_config
// ---------------------------------------------------------------------------

export interface BytesPerTokenResolution {
  /** The ratio to use for bytes→token conversion. */
  ratio: number;
  /** True when a calibration run has stored a measured ratio. */
  calibrated: boolean;
  /** ISO timestamp of the last calibration run, or null. */
  measuredAt: string | null;
  /** Model used in the last calibration run, or null. */
  model: string | null;
  /** Full provenance string from user_config, or null. */
  provenance: string | null;
}

/**
 * Resolve the bytes-per-token ratio from user_config.
 * Falls back to DEFAULT_BYTES_PER_TOKEN (4) when no calibration has been run.
 */
export function resolveBytesPerToken(db: Db): BytesPerTokenResolution {
  const raw = configGet(db, "bytes_per_token");
  const measuredAt = configGet(db, "bytes_per_token_measured_at");
  const provenance = configGet(db, "bytes_per_token_provenance");

  // Extract model from provenance ("calibrated {date} via count_tokens · model {model} · ...")
  let model: string | null = null;
  if (provenance !== null) {
    const m = /· model ([^ ·]+)/.exec(provenance);
    if (m) model = m[1] ?? null;
  }

  if (raw === null) {
    return {
      ratio: DEFAULT_BYTES_PER_TOKEN,
      calibrated: false,
      measuredAt: null,
      model: null,
      provenance: null,
    };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      ratio: DEFAULT_BYTES_PER_TOKEN,
      calibrated: false,
      measuredAt: null,
      model: null,
      provenance: null,
    };
  }
  return { ratio: parsed, calibrated: true, measuredAt, model, provenance };
}

// ---------------------------------------------------------------------------
// Sampler — scan JSONL files for tool_result text blocks
// ---------------------------------------------------------------------------

interface ToolResultSample {
  /** SEC-101: text is in-memory only for the count_tokens call. */
  text: string;
  bytes: number;
}

/** Resolve text content from a tool_result block (string or content[].type=text). */
function extractToolResultText(b: Record<string, unknown>): string | null {
  const content = b.content;
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (
        typeof c === "object" &&
        c !== null &&
        (c as Record<string, unknown>).type === "text" &&
        typeof (c as Record<string, unknown>).text === "string"
      ) {
        parts.push((c as Record<string, unknown>).text as string);
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

/** Recursively collect JSONL file paths under a directory. */
function collectJsonlPaths(dir: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= limit) break;
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(path.join(dir, e.name));
    }
  }
  for (const e of entries) {
    if (out.length >= limit) break;
    if (e.isDirectory()) {
      collectJsonlPaths(path.join(dir, e.name), out, limit);
    }
  }
}

/**
 * Sample tool_result text blocks from JSONL files under scanRoots.
 *
 * SEC-101: returned text is in-memory only; never written to disk or DB.
 * Callers must discard text immediately after counting tokens.
 */
export function sampleToolResultBlocks(
  scanRoots: string[],
  opts: { maxSamples?: number; maxBlockBytes?: number; maxFiles?: number } = {},
): ToolResultSample[] {
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const maxBlockBytes = opts.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES;
  const maxFiles = opts.maxFiles ?? 500;

  // Collect JSONL file paths across all scan roots.
  const filePaths: string[] = [];
  for (const root of scanRoots) {
    collectJsonlPaths(root, filePaths, maxFiles);
    if (filePaths.length >= maxFiles) break;
  }

  const samples: ToolResultSample[] = [];

  for (const filePath of filePaths) {
    if (samples.length >= maxSamples) break;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (const line of lines) {
      if (samples.length >= maxSamples) break;
      const trimmed = line.trim();
      if (trimmed === "") continue;

      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof rec !== "object" || rec === null) continue;
      const r = rec as Record<string, unknown>;
      const message =
        typeof r.message === "object" && r.message !== null
          ? (r.message as Record<string, unknown>)
          : null;
      if (!message || !Array.isArray(message.content)) continue;

      for (const block of message.content) {
        if (samples.length >= maxSamples) break;
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;

        const text = extractToolResultText(b);
        if (text === null || text.length === 0) continue;

        // Measure UTF-8 byte length.
        const bytes = Buffer.byteLength(text, "utf8");
        if (bytes > maxBlockBytes) continue;

        // SEC-101: text is in-memory only; will be discarded after counter() call.
        samples.push({ text, bytes });
      }
    }
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Calibration result type
// ---------------------------------------------------------------------------

export type CalibrateBytesPerTokenResult =
  | { ok: true; ratio: number; n: number; model: string; provenance: string }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Sampler type (injectable for tests)
// ---------------------------------------------------------------------------

export type ToolResultSampler = (
  scanRoots: string[],
  opts?: { maxSamples?: number; maxBlockBytes?: number; maxFiles?: number },
) => ToolResultSample[];

// ---------------------------------------------------------------------------
// Main calibration function
// ---------------------------------------------------------------------------

/**
 * Calibrate the bytes-per-token ratio by sampling real tool-result content
 * blocks and counting tokens via Anthropic's count_tokens API.
 *
 * Steps:
 *   1. Guard: opt-in flag must be enabled.
 *   2. Determine model (most-frequent turns.model; fall back to FALLBACK_MODEL).
 *   3. Sample blocks; count tokens; require ≥ MIN_SAMPLES successful counts.
 *   4. Compute median bytes/input_tokens ratio.
 *   5. Persist to user_config (counts/ratio only; no text).
 *   6. Return {ok, ratio, n, model, provenance}.
 *
 * @param db       The SQLite database (for opt-in flag + model query + persistence).
 * @param opts.model   Override the auto-picked model (tests / manual trigger).
 * @param opts.counter Injectable token counter (defaults to countTokens).
 * @param opts.sampler Injectable block sampler (defaults to sampleToolResultBlocks).
 * @param opts.scanRoots Override scan roots (defaults to user_config.scan_roots + daemon config).
 */
export async function calibrateBytesPerToken(
  db: Db,
  opts: {
    model?: string;
    counter?: TokenCounter;
    sampler?: ToolResultSampler;
    scanRoots?: string[];
  } = {},
): Promise<CalibrateBytesPerTokenResult> {
  // 1. Guard: opt-in required.
  const enabled = configGet(db, "bytes_per_token_calibration_enabled");
  if (enabled !== "true") {
    return { ok: false, reason: "calibration disabled — enable in Settings first" };
  }

  // 2. Determine model.
  let model = opts.model ?? null;
  if (model === null) {
    const row = db
      .prepare(
        `SELECT model, COUNT(*) AS cnt
           FROM turns
          WHERE model IS NOT NULL AND model != ''
          GROUP BY model
          ORDER BY cnt DESC
          LIMIT 1`,
      )
      .get() as { model: string; cnt: number } | undefined;
    model = row?.model ?? FALLBACK_MODEL;
  }

  // 3. Sample blocks and count tokens.
  const counter: TokenCounter = opts.counter ?? countTokens;
  const sampler: ToolResultSampler = opts.sampler ?? sampleToolResultBlocks;

  // Resolve scan roots: from user_config or caller override.
  let scanRoots: string[] = opts.scanRoots ?? [];
  if (scanRoots.length === 0) {
    const raw = configGet(db, "scan_roots");
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) scanRoots = parsed as string[];
      } catch {
        // ignore
      }
    }
  }

  // Collect samples (text in memory only — SEC-101).
  const blocks = sampler(scanRoots, { maxSamples: DEFAULT_MAX_SAMPLES });

  // Try the auto-picked model first; fall back to FALLBACK_MODEL on 404.
  const usedModel = model;
  const ratios: number[] = [];
  let fallbackUsed = false;

  for (const block of blocks) {
    // SEC-101: block.text lives here only for this count call.
    let result = await counter(block.text, usedModel);

    // Fall back to stable model on 404 (old model id).
    if (!result.ok && result.status === 404 && usedModel !== FALLBACK_MODEL) {
      result = await counter(block.text, FALLBACK_MODEL);
      fallbackUsed = true;
    }
    if (!result.ok) continue;
    if (result.input_tokens <= 0) continue;

    ratios.push(block.bytes / result.input_tokens);
  }

  // 4. Require minimum sample count.
  if (ratios.length < MIN_SAMPLES) {
    return {
      ok: false,
      reason: `Only ${ratios.length} successful sample(s) — need ≥${MIN_SAMPLES} (check OAuth login or increase scan roots).`,
    };
  }

  // 5. Compute median.
  const sorted = [...ratios].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;

  const effectiveModel = fallbackUsed ? FALLBACK_MODEL : usedModel;
  const date = new Date().toISOString().slice(0, 10);
  const ratioStr = median.toFixed(4);
  const provenance = `calibrated ${date} via count_tokens · model ${effectiveModel} · N=${ratios.length} · median ${ratioStr}`;

  // 6. Persist (counts/ratio/provenance only — no text).
  db.transaction(() => {
    configSet(db, "bytes_per_token", String(median));
    configSet(db, "bytes_per_token_measured_at", new Date().toISOString());
    configSet(db, "bytes_per_token_provenance", provenance);
  })();

  return { ok: true, ratio: median, n: ratios.length, model: effectiveModel, provenance };
}
