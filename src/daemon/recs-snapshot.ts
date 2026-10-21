import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { awaitDbWriteGate } from "../db/write-gate.js";
import {
  RECS_BOOKKEEPING_SQL,
  RECS_INGEST_MARK_KEYS,
  buildRecommendations,
  expireRecommendationDismissals,
  recommendationDismissalsDue,
  recommendationsStateKey,
} from "../query/api/recommendations.js";
import type { RecommendationCard, RecommendationsView } from "../query/api/recommendations.js";
import { getQueryDb } from "../query/db-context.js";
import type { ApiResponse, SnapshotFreshness } from "../query/envelope.js";
import type { HeavyJobGate } from "./heavy-job-gate.js";
import { withSpan } from "./perf-monitor.js";
import { type RecsBuildResult, createRecsWorkerRunner } from "./recs-worker-runner.js";
import { createSnapshotService, freshnessOf } from "./snapshot-service.js";

/** P1-U2: what `peek` saw. `stale` is the same check `get` uses; `peek` never starts a build. */
export type RecsPeek =
  | {
      state: "ready";
      result: ApiResponse<RecommendationsView>;
      stale: boolean;
      /** A-17 (P3-U4). */
      freshness: SnapshotFreshness;
    }
  | {
      state: "building";
      sinceMs: number;
      /** The last build's duration (persisted across restarts); null before the first one. */
      expectedMs?: number | null;
    }
  | { state: "failed" }
  | { state: "cold" };

export interface RecsSnapshotService {
  get(scope?: string): Promise<ApiResponse<RecommendationsView>>;
  /** The last snapshot, without building or expiring dismissals. */
  peek(scope?: string): RecsPeek;
  /**
   * P0-U7: the card the user saw, from any scope's snapshot at the current revision. Never builds;
   * null when cold or the rec is not in a snapshot (callers then build the card themselves).
   */
  peekCard(recId: string): RecommendationCard | null;
  /** The earliest build running with no snapshot to serve (any scope), for `/api/status` jobs. */
  coldBuild(): { sinceMs: number; expectedMs: number | null } | null;
  invalidate(): void;
  /** P1-U6a: bumped by every invalidate (rec lifecycle write); the headroom memo keys on it. */
  revision(): number;
  markStale(): void;
  stop(): void;
}

let lastSeen:
  | { db: unknown; writes: string; stateKey: string; ingestMark: string | undefined }
  | undefined;

const INGEST_MIN_AGE_MS = 600_000;
const MAX_AGE_MS = 3_600_000;

/**
 * Only the sub-fields D4 turns into rec output: seven_day_util and each per_model entry's model and
 * utilization. captured_at (rewritten every burn-status poll) and five_hour_util (validated, never
 * output) are left out. Whether the snapshot parses, validates and passes D4's 24 h freshness gate
 * is kept, so a snapshot turning invalid, going stale or becoming fresh again moves the mark.
 * Anything unexpected is hashed verbatim.
 */
function markValue(key: string, value: unknown): unknown {
  if (key !== "per_model_snapshot" || typeof value !== "string") return value;
  try {
    const s = JSON.parse(value) as Record<string, unknown>;
    if (s === null || typeof s !== "object" || Array.isArray(s) || !Array.isArray(s.per_model))
      return value;
    const capturedMs = typeof s.captured_at === "string" ? Date.parse(s.captured_at) : Number.NaN;
    return {
      // D4 ignores a snapshot older than 24 h, so crossing that line either way moves the mark.
      valid:
        Number.isFinite(capturedMs) &&
        Date.now() - capturedMs <= 24 * 60 * 60 * 1000 &&
        Number.isFinite(s.five_hour_util),
      seven_day_util: s.seven_day_util,
      per_model: s.per_model.map((e: unknown) =>
        e !== null && typeof e === "object" && !Array.isArray(e)
          ? [(e as Record<string, unknown>).model, (e as Record<string, unknown>).utilization]
          : e,
      ),
    };
  } catch {
    return value;
  }
}

/**
 * What the state key omits (RB1-A): the ingest-written tables recs reads. Max rowids are O(1);
 * `sessions` is updated in place, so its newest `last_turn_at` (indexed) is added.
 */
export function recsIngestMark(): string {
  const db = getQueryDb();
  const parts = [
    "turns",
    "sessions",
    "subagent_meta",
    "tool_events",
    "tool_event_content",
    "ingest_metric_events",
    "tool_event_metadata",
  ].map(
    (table) => db.prepare(`SELECT IFNULL(MAX(rowid), 0) FROM ${table}`).pluck().get() as number,
  );
  const last = db.prepare("SELECT IFNULL(MAX(last_turn_at), '') FROM sessions").pluck().get();
  // Timer-written user_config keys a recs path reads (key + value, never updated_at) refresh recs
  // only on this floor. Keys no recs path reads are not hashed at all.
  const bookkeeping = createHash("sha1");
  for (const row of db
    .prepare(
      `SELECT key, value FROM user_config WHERE ${RECS_BOOKKEEPING_SQL} AND key IN (${RECS_INGEST_MARK_KEYS.map(() => "?").join(", ")}) ORDER BY key`,
    )
    .raw()
    .iterate(...RECS_INGEST_MARK_KEYS) as Iterable<[string, unknown]>)
    bookkeeping.update(JSON.stringify([row[0], markValue(row[0], row[1])]));
  return `${parts.join(":")}:${last as string}:${bookkeeping.digest("hex")}`;
}

/**
 * P3-U4: the recs inputs token. `total_changes()` (this connection) and `PRAGMA data_version`
 * (other connections and processes) show whether anything was written since the last call; only
 * then is the 18-table `recommendationsStateKey()` hashed (M13 p95 25.8 ms on L, once per GET
 * before). A write alone is not enough: the 60 s live reconcile writes rows recs never read, and
 * each would cost a ~14 s rebuild on L.
 */
function recsInputsToken(): string {
  return syncSeen().stateKey;
}

/** The ingest mark, recomputed (like the state key) only after a write. */
function recsIngestToken(): string {
  const seen = syncSeen();
  seen.ingestMark ??= withSpan("recsIngestMark", recsIngestMark);
  return seen.ingestMark;
}

function syncSeen(): { stateKey: string; ingestMark: string | undefined } {
  const writes = withSpan("recsInputsToken", () => {
    const db = getQueryDb();
    const changes = db.prepare("SELECT total_changes()").pluck().get() as number;
    return `${changes}:${db.pragma("data_version", { simple: true }) as number}`;
  });
  const db = getQueryDb();
  if (lastSeen?.db !== db || lastSeen.writes !== writes) {
    lastSeen = { db, writes, stateKey: recommendationsStateKey(), ingestMark: undefined };
  }
  return lastSeen;
}

function readBuildMs(file: string | undefined): number | null {
  if (!file) return null;
  try {
    const ms = (JSON.parse(readFileSync(file, "utf8")) as { ms?: unknown }).ms;
    return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : null;
  } catch {
    return null;
  }
}

function writeBuildMs(file: string | undefined, ms: number): void {
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify({ ms }));
  } catch {
    // Best effort: without the file the next restart's first build shows no estimate.
  }
}

/** RB1-A: build the all-scope snapshot once the first detector pass has settled (boot = one build). */
export function prewarmRecsSnapshot(
  service: Pick<RecsSnapshotService, "get">,
  firstPassSettled: Promise<void>,
): Promise<void> {
  return firstPassSettled
    .then(() => service.get())
    .then(
      () => {},
      () => {},
    );
}

/** Lifecycle writes (invalidate) revoke snapshots; other DB drift serves the snapshot stale and rebuilds in the background. */
export function createRecsSnapshotService(
  options: {
    dbPath?: string;
    builder?: (scope?: string, onStart?: () => void) => Promise<RecsBuildResult>;
    /** Test seams. */
    now?: () => number;
    inputsToken?: () => string;
    ingestToken?: () => string;
    /** RB1-B: shared one-heavy-job-at-a-time gate. */
    gate?: HeavyJobGate;
    /** Where the last build duration is kept across restarts (`expectedMs`). */
    durationFile?: string;
  } = {},
): RecsSnapshotService {
  let stopped = false;
  let lastBuildMs = readBuildMs(options.durationFile);
  const runner =
    options.dbPath && !options.builder
      ? createRecsWorkerRunner(options.dbPath, options.gate)
      : null;
  const builder =
    options.builder ??
    (runner
      ? (scope?: string, onStart?: () => void) => runner.run(scope, undefined, onStart)
      : async (scope?: string): Promise<RecsBuildResult> => ({
          result: buildRecommendations(scope),
          builtAtMs: Date.now(),
        }));
  const core = createSnapshotService<string, ApiResponse<RecommendationsView>>({
    build: async (scope, _inputsAsOfMs, _onStage, onStart) => {
      // Timed from when the work starts, so a heavy-job gate wait is not counted.
      let t0 = performance.now();
      const built = await builder(scope || undefined, () => {
        t0 = performance.now();
        onStart();
      });
      if (!stopped) {
        lastBuildMs = Math.round(performance.now() - t0);
        writeBuildMs(options.durationFile, lastBuildMs);
      }
      return built.result;
    },
    inputsToken: options.inputsToken ?? recsInputsToken,
    ingestToken: options.ingestToken ?? recsIngestToken,
    ingestMinAgeMs: INGEST_MIN_AGE_MS,
    maxAgeMs: MAX_AGE_MS,
    ...(options.now && { now: options.now }),
  });

  function invalidate(): void {
    core.invalidate();
    runner?.cancel();
  }

  return {
    async get(scope) {
      if (stopped) throw new Error("recommendations snapshot service stopped");
      // A read first: only a request that has a dismissal to expire writes (and waits out a checkpoint).
      if (recommendationDismissalsDue()) {
        await awaitDbWriteGate();
        if (stopped) throw new Error("recommendations snapshot service stopped");
        if (expireRecommendationDismissals() > 0) invalidate();
      }
      const key = scope ?? "";
      for (;;) {
        if (stopped) throw new Error("recommendations snapshot service stopped");
        const peeked = core.peek(key);
        if (peeked.state === "ready") {
          core.refresh(key);
          return peeked.snapshot.value;
        }
        const { task, revision } = core.start(key);
        try {
          await task;
        } catch (error) {
          if (revision === core.revision()) throw error;
        }
      }
    },
    peek(scope) {
      const peeked = core.peek(scope ?? "");
      if (peeked.state === "ready") {
        return {
          state: "ready",
          result: peeked.snapshot.value,
          stale: peeked.stale,
          freshness: freshnessOf(peeked) as SnapshotFreshness,
        };
      }
      if (peeked.state === "building") {
        return { state: "building", sinceMs: peeked.sinceMs, expectedMs: lastBuildMs };
      }
      return { state: peeked.state };
    },
    coldBuild() {
      const builds = core.coldBuilds();
      if (builds.length === 0) return null;
      return { sinceMs: Math.min(...builds.map((b) => b.sinceMs)), expectedMs: lastBuildMs };
    },
    peekCard(recId) {
      for (const result of core.values()) {
        const view = result.data;
        if (!view) continue;
        for (const list of [
          view.active,
          view.limit_warnings,
          view.adopted,
          view.dismissed,
          view.history,
          view.below_floor ?? [],
        ]) {
          const card = list.find((c) => c.rec_id === recId);
          if (card) return card;
        }
      }
      return null;
    },
    invalidate,
    revision: () => core.revision(),
    markStale: () => core.markStale(),
    stop() {
      stopped = true;
      runner?.stop();
      core.stop();
    },
  };
}
