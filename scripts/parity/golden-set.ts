/**
 * scripts/parity/golden-set.ts — the frozen Phase-2 golden set (H2 gate output).
 *
 * The golden set is the operator-frozen list of seed sessions the parity gauge
 * scores, each with a FROZEN must-catch: the single thing a good recommendation
 * on that session must surface. It is authored/reviewed by the operator (H2) and
 * consumed by the CLI via `--golden-set <file>`.
 *
 * This file defines the on-disk schema and a fail-closed loader. It scores
 * nothing and derives nothing from engine output — like rubric.ts, it is FIXED
 * INPUT to Gauge-1.
 */

import * as fs from "node:fs";

/** One golden session + its frozen must-catch. */
export interface GoldenSetEntry {
  /** Seed session id (== workspace slug for the gs-* corpus). */
  session_id: string;
  /**
   * The frozen must-catch: what a good rec on this session must surface. For a
   * negative/adversarial control, state that nothing should be recommended.
   */
  must_catch: string;
  /**
   * Optional expected detector ids (documentation only — the harness does not
   * assert on these). An empty array documents a negative control.
   */
  expect_fires?: string[];
}

export interface GoldenSet {
  /** Schema version. */
  version: number;
  /** ISO date the operator froze the set (H2). Optional until frozen. */
  frozen_at?: string;
  sessions: GoldenSetEntry[];
}

/**
 * Load + validate a golden-set.json. Fails CLOSED: any structural violation
 * throws rather than silently producing a partial set (a partial golden set
 * would quietly shrink the parity gate).
 */
export function loadGoldenSet(filePath: string): GoldenSet {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Golden set not found at ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(
      `Golden set at ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Golden set at ${filePath} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj["version"] !== "number") {
    throw new Error(`Golden set at ${filePath} must carry a numeric "version"`);
  }

  if (!Array.isArray(obj["sessions"]) || obj["sessions"].length === 0) {
    throw new Error(`Golden set at ${filePath} must carry a non-empty "sessions" array`);
  }

  const seen = new Set<string>();
  const sessions: GoldenSetEntry[] = obj["sessions"].map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`Golden set entry #${i} must be an object`);
    }
    const e = raw as Record<string, unknown>;
    if (typeof e["session_id"] !== "string" || e["session_id"].length === 0) {
      throw new Error(`Golden set entry #${i} must carry a non-empty "session_id"`);
    }
    if (typeof e["must_catch"] !== "string" || e["must_catch"].length === 0) {
      throw new Error(
        `Golden set entry "${e["session_id"]}" must carry a non-empty "must_catch"`,
      );
    }
    if (seen.has(e["session_id"])) {
      throw new Error(`Golden set has a duplicate session_id "${e["session_id"]}"`);
    }
    seen.add(e["session_id"]);

    const entry: GoldenSetEntry = {
      session_id: e["session_id"],
      must_catch: e["must_catch"],
    };
    if (e["expect_fires"] !== undefined) {
      if (
        !Array.isArray(e["expect_fires"]) ||
        !e["expect_fires"].every((x) => typeof x === "string")
      ) {
        throw new Error(
          `Golden set entry "${e["session_id"]}" has a non-string "expect_fires" entry`,
        );
      }
      entry.expect_fires = e["expect_fires"] as string[];
    }
    return entry;
  });

  const result: GoldenSet = { version: obj["version"], sessions };
  if (typeof obj["frozen_at"] === "string") {
    result.frozen_at = obj["frozen_at"];
  }
  return result;
}
