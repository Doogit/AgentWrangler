/**
 * src/ingest/ingestor.ts — the WP1 ingestion orchestrator.
 *
 * Wires discovery → tail → parse → price → persist → reconcile. Holds the small
 * in-process correlation state (tool_use → owning turn) that lets tool_result
 * sizes and commit SHAs attach to the right rows. SEC-101: only tokens, ids,
 * sizes, model names, and structural markers are ever written.
 *
 * Idempotency (NFR-107): turns upsert-ignore on message_id; session aggregates
 * advance only when a turn is genuinely new (changes === 1). A dropped DB
 * re-scanned from scratch reproduces identical RECONCILED aggregates.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { bumpDataVersion } from "../daemon/data-version.js";
import { recordIngestBytes, setErroredFiles } from "../daemon/perf-monitor.js";
import { scheduleJob } from "../daemon/schedule-job.js";
import type { Db } from "../db/open.js";
import { resetGridPhaseMs } from "../detector/engine.js";
import { agentIdForTranscript, backfillTurnAgentIds } from "./agent-id-backfill.js";
import {
  bootFileParsed,
  bootFileSkipped,
  bootFilesTotal,
  bootSessionFound,
  bootTokensCounted,
  pushBootEvent,
} from "./boot-progress.js";
import { recomputeCompactionBoundaries } from "./compaction-boundaries.js";
import { runPostIngestHook } from "./detector-hook.js";
import {
  type DiscoveredFile,
  createDiscoveryCache,
  refreshDiscoveryCache,
  registerWorkspace,
  sessionStemFor,
} from "./discovery.js";
import {
  bumpEnrichmentEpoch,
  bumpEnrichmentEpochIfClosed,
  isClosedTs,
} from "./enrichment-epoch.js";
import { Health } from "./health.js";
import { PARSER_VERSION, projectLine } from "./parser.js";
import { PricingSnapshotStore, noteUnconfirmedModels, seedListPrices } from "./pricing.js";
import {
  DEFAULT_RECONCILE_OPTIONS,
  type ReconcileOptions,
  reconcileSessions,
  reconcileSessionsById,
} from "./reconcile.js";
import {
  DEFAULT_TAIL_CHUNK_BYTES,
  type FileVersion,
  MAX_TAIL_LINE_BYTES,
  type TailChunkResult,
  appendOnlyGrowth,
  backfillTailHash,
  countReset,
  fileVersion,
  findSameContent,
  headHash,
  loadOffset,
  sameFileVersion,
  saveOffset,
  tailFileChunk,
} from "./tail.js";
import {
  seamAfterLine,
  seamAfterTx,
  seamBeforeChunk,
  seamMidReconcile,
  testSeams,
} from "./test-seams.js";
import {
  INTERRUPT_CLASSIFIER_VERSION,
  TOOL_ERROR_CLASSIFIER_VERSION,
} from "./tool-error-classifier.js";
import type { CommandProjection, HealthCounters, TurnProjection } from "./types.js";
import { CLASSIFIER_VERSION, LONG_GAP_THRESHOLD_S } from "./types.js";
import {
  backfillDiscoveredCwd,
  defaultReadCwd,
  defaultReadRemote,
  resolveWorkspaceMappings,
} from "./workspace-mapping.js";

/** P0-U14: max time since the last detector pass before the idle gate is bypassed (mirrors IDLE_PASS_MAX_STALE_MS). */
const IDLE_GATE_MAX_STALE_MS = 60 * 60_000;

export interface IngestorOptions {
  activityWindowSecs: number;
  reconcile: ReconcileOptions;
  tailIntervalMs: number;
  discoveryIntervalMs: number;
  discoveryFullWalkIntervalMs: number;
  /**
   * Freshness floor for the per-tick reconcile when a tail tick ingests
   * nothing: idle ticks skip reconcile until this much time has passed since
   * the last one (PERF5). Must stay well under activityWindowSecs so
   * active→idle session transitions are still observed promptly.
   */
  reconcileIdleFloorMs: number;
  /**
   * Freshness floor for the discovery-tick detector pass when nothing changed
   * (no lines parsed since the last pass, no new mappings): idle ticks skip
   * the pass until this much time has passed since the last one (PERF5).
   * Detector inputs are ingest-derived, so with a zero ingest delta only
   * pure time-window edges can move between passes.
   */
  detectorIdleFloorMs: number;
  /**
   * P0-U14: consulted at each idle-floor tick (nothing ingested, nothing newly
   * mapped). Returning false skips the pass; the daemon wires S4's marker gate
   * (with its 60 min / local-day cap). Unset = the idle floor always runs.
   */
  detectorIdleGate?: (now: Date) => boolean;
  detectorMinIntervalMs: number;
  /** Injectable clock (ISO string) for deterministic tests. */
  now: () => Date;
  onNewMappings?: (count: number) => void;
  readRemote?: (path: string) => string | null | Promise<string | null>;
  /**
   * P0-U13: injectable `fs.statSync` for the tail tick's hot/cold classification
   * and stat-error backoff (tests force a failure for one path). Deliberately
   * NOT the `now` clock above — hotness/backoff compare against real file
   * mtimes, so they use the real wall clock (`Date.now()`, mockable via
   * `vi.useFakeTimers()`) rather than the injected/fixed `now` many tests set.
   */
  statFile: (filePath: string) => fs.Stats;
  /**
   * P2-U4b: consulted before each yielding write step; a returned promise is awaited first. The
   * daemon wires the WAL checkpointer's gate: a PASSIVE checkpoint racing a steady writer never
   * copies every frame, so the WAL would never restart (src/daemon/wal-checkpointer.ts). It also
   * waits on the history worker's pending writes (src/db/write-intent.ts).
   */
  writeGate?: () => Promise<void> | null;
}

export const DEFAULT_INGESTOR_OPTIONS: IngestorOptions = {
  activityWindowSecs: 5 * 60,
  reconcile: DEFAULT_RECONCILE_OPTIONS,
  tailIntervalMs: 2_000,
  discoveryIntervalMs: 30_000,
  discoveryFullWalkIntervalMs: Number(process.env.AW_DISCOVERY_FULL_WALK_MS) || 5 * 60_000,
  reconcileIdleFloorMs: 60_000,
  detectorIdleFloorMs: 5 * 60_000,
  detectorMinIntervalMs: Number(process.env.AW_DETECTOR_MIN_INTERVAL_MS) || 5 * 60_000,
  // AW_TEST_NOW seam: fixed clock, honored only under AW_TEST_HOOKS=1 (else null).
  now: () => (testSeams.nowMs === null ? new Date() : new Date(testSeams.nowMs)),
  statFile: (filePath: string) => fs.statSync(filePath),
};

const INITIAL_SCAN_BATCH_SIZE = 100;
/**
 * U-3: time-budgeted yield for the initial back-scan. Yield to the event loop
 * once the current synchronous run has held it for this long, instead of only
 * once per batch — a batch of new files (cold first-install, where U-2's skip
 * saves nothing) would otherwise block the loop for multi-second stretches and
 * stall /api/ready. Cost is scheduler-hop overhead only; per-file parse work is
 * unchanged, so total scan duration is not meaningfully affected.
 */
const SCAN_YIELD_BUDGET_MS = 12;
/**
 * P2-U4a: time budget for one yielding-path ingest step, measured from the step's
 * start (reads and checks included). 25 ms leaves headroom for the post-loop
 * offset/baseline/derived-flag writes and the commit: on the X corpus a whole step
 * measured p99 43–49 ms at 25, vs 56–58 ms at 40 (in-process, autocheckpoint off).
 * The line loop stops early by the step's measured tail (stepTailMs), so the whole step fits it.
 */
export const INGEST_TX_BUDGET_MS = 25;
const MAX_LINE_WARN_LABEL = `${MAX_TAIL_LINE_BYTES / (1024 * 1024)} MiB`;

/**
 * P0-U13 (audit §9.3 N1, §11.10): the 2 s tail tick used to `fs.stat` every
 * known file unconditionally — 6.66 s of a 180 s idle CPU profile's 16.3 s
 * non-idle self-time (41%, rank 1) at 2,881 files. Requirement A-4: a hot
 * file stays on the fast cadence (checked every tick, i.e. within
 * tailIntervalMs, always <= 5 s); every other file still gets stat'ed at
 * least once within this fixed cycle. Fixed (not tied to activityWindowSecs,
 * which tests may set much shorter) so it matches the requirement's literal
 * "<= 5 min" bound regardless of how "recent" is configured.
 */
const COLD_LANE_CYCLE_MS = 5 * 60_000;

/**
 * Stat failures before a file is reported `errored` on /api/perf. Three
 * consecutive misses (spaced by the growing backoff below) separates a
 * genuinely broken path from a single race with a concurrent writer (e.g. a
 * rotate-in-progress), which the very next tick usually resolves on its own.
 */
const STAT_ERROR_THRESHOLD = 3;
/** Exponential backoff for a failing file's retry schedule, capped at the
 * cold-lane cycle so a permanently-gone path costs at most one stat per
 * COLD_LANE_CYCLE_MS instead of one every tick, while still self-healing if
 * the path reappears (mirrors the tail tick's existing self-heal philosophy). */
const STAT_BACKOFF_BASE_MS = 4_000;
const STAT_BACKOFF_MAX_MS = COLD_LANE_CYCLE_MS;
/** Bounded id-list length for the /api/perf errored-files gauge (SEC-101:
 * hashed ids only, never raw paths — see classifierBaselinePathHash below). */
const MAX_ERRORED_IDS = 20;

/** Stable, non-reversible cursor identity; raw local paths never enter SQLite. */
export function classifierBaselinePathHash(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/").toLowerCase();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** The ingest_metric_events key for one transcript line (also used by interrupt-relabel.ts). */
export function metricEventId(
  raw: string,
  proj: Extract<ReturnType<typeof projectLine>, { kind: "record" }>,
): string {
  const flags = [
    proj.isUserTurn ? "u" : "",
    proj.isCompactSummary ? "c" : "",
    proj.isApiErrorMessage ? "a" : "",
    proj.isInterrupt ? "i" : "",
  ].join("");
  let sourceIdentity: string;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.uuid === "string" && parsed.uuid.trim() !== "") {
      sourceIdentity = `uuid:${parsed.uuid}`;
    } else {
      const message = parsed.message;
      const messageId =
        typeof message === "object" && message !== null
          ? (message as Record<string, unknown>).id
          : null;
      if (typeof messageId === "string" && messageId.trim() !== "") {
        sourceIdentity = `message:${String(parsed.type ?? "")}:${messageId}:${flags}`;
      } else {
        sourceIdentity = `raw:${crypto.createHash("sha256").update(raw).digest("hex")}`;
      }
    }
  } catch {
    // projectLine already parsed record lines; retain a safe fallback if that contract changes.
    sourceIdentity = `raw:${crypto.createHash("sha256").update(raw).digest("hex")}`;
  }
  return crypto.createHash("sha256").update(`${proj.sessionId}\0${sourceIdentity}`).digest("hex");
}

const STRICT_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BOUNDED_VERSION = /^[0-9A-Za-z._-]{1,32}$/;

interface SubagentMetadata {
  agentId: string;
  sessionId: string;
  agentType: string | null;
  toolUseId: string | null;
  spawnDepth: number | null;
  descriptionLen: number | null;
}

function readSubagentMetadata(filePath: string): SubagentMetadata | null {
  const agentDir = path.dirname(filePath);
  const match = /^agent-(.+)\.jsonl$/.exec(path.basename(filePath));
  if (match?.[1] === undefined) return null;
  // Direct: <session>/subagents/agent-<id>.jsonl.
  // Workflow (S1d-F1): <session>/subagents/workflows/<wf>/agent-<id>.jsonl.
  let subagentsDir = agentDir;
  if (path.basename(agentDir) !== "subagents") {
    subagentsDir = path.dirname(path.dirname(agentDir));
    if (
      path.basename(path.dirname(agentDir)) !== "workflows" ||
      path.basename(subagentsDir) !== "subagents"
    ) {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(agentDir, `agent-${match[1]}.meta.json`), "utf8"),
    ) as Record<string, unknown>;
    const spawnDepth = parsed.spawnDepth;
    return {
      agentId: match[1],
      sessionId: path.basename(path.dirname(subagentsDir)),
      agentType: typeof parsed.agentType === "string" ? parsed.agentType : null,
      toolUseId: typeof parsed.toolUseId === "string" ? parsed.toolUseId : null,
      spawnDepth:
        typeof spawnDepth === "number" && Number.isInteger(spawnDepth) ? spawnDepth : null,
      descriptionLen: typeof parsed.description === "string" ? parsed.description.length : null,
    };
  } catch {
    return null;
  }
}

function strictUtcTimestamp(value: string | null): string | null {
  if (value === null || !STRICT_UTC_TIMESTAMP.test(value)) return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}

function boundedVersion(value: string | null): string | null {
  return value !== null && BOUNDED_VERSION.test(value) ? value : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * P2-U4 (decision D4): W0 is every file modified in the last 7 days, with no session
 * or byte cap. This elapsed-time guard stops it at the first file boundary after
 * 15 s (M6's target is 20 s); the rest then runs as a W0b slice.
 */
export const FIRST_SLICE_DEFAULT_MAX_MS = 15_000;

export interface SliceLimits {
  maxMs?: number;
  maxBytes?: number;
}

/** W0's guard: AW_FIRST_SLICE_MAX_MS (default 15 s), optional AW_FIRST_SLICE_MAX_BYTES. */
export function firstSliceLimits(env: NodeJS.ProcessEnv): SliceLimits {
  const read = (raw: string | undefined) =>
    raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw) : undefined;
  const maxBytes = read(env.AW_FIRST_SLICE_MAX_BYTES);
  return {
    maxMs: read(env.AW_FIRST_SLICE_MAX_MS) ?? FIRST_SLICE_DEFAULT_MAX_MS,
    ...(maxBytes !== undefined && { maxBytes }),
  };
}

/**
 * P2-U4: the files whose mtime falls in week `index` before now (0 = the last 7 days),
 * newest first. An append-only file's mtime is never older than its newest turn, so
 * once slices 0…k are done every turn since `startMs` is ingested.
 */
export interface IngestSlice {
  index: number;
  startMs: number;
  endMs: number;
  files: DiscoveredFile[];
}

export interface HistoryCoverage {
  weeks_done: number;
  weeks_total: number;
  /** Every turn from here on is ingested (ms); null until W0 is done. */
  complete_through_ms: number | null;
  /** UTC day (YYYY-MM-DD) of the first whole day at or after complete_through_ms. */
  oldest_complete_day: string | null;
  /** W0 was cut by its guard and W0b has not finished. */
  partial_week: boolean;
}

export interface SliceResult {
  /** Files the guard left for the next (W0b) slice; empty when the slice is done. */
  rest: DiscoveredFile[];
  sessions: number;
  reconcile_batches: number;
  reconcile_ms: number;
  coverage: HistoryCoverage;
}

export interface SliceOptions extends SliceLimits {
  /** Yield to the loop at least every N files (time-budgeted yields also apply). */
  batchSize?: number;
  onFile?: (pass: { parsedAny: boolean; skipped: boolean }) => void;
}

function statBootScanFiles(files: DiscoveredFile[]): { file: DiscoveredFile; mtimeMs: number }[] {
  return files
    .map((file) => {
      let mtimeMs = Number.NEGATIVE_INFINITY;
      try {
        const candidate = fs.statSync(file.filePath).mtimeMs;
        if (Number.isFinite(candidate)) mtimeMs = candidate;
      } catch {
        // A file may disappear after discovery; retain it so the existing
        // per-file vanish handling can safely skip it.
      }
      return { file, mtimeMs };
    })
    .sort((a, b) => {
      const byMtime = b.mtimeMs - a.mtimeMs;
      if (byMtime !== 0) return byMtime;
      if (a.file.filePath < b.file.filePath) return -1;
      if (a.file.filePath > b.file.filePath) return 1;
      return 0;
    });
}

/**
 * Prioritize recent sessions during the yielding cold-start scan. Discovery and
 * tailing retain their own traversal order; this only orders the boot work
 * queue. A path tiebreak makes equal filesystem timestamps reproducible.
 */
function orderBootScanFiles(files: DiscoveredFile[]): DiscoveredFile[] {
  return statBootScanFiles(files).map(({ file }) => file);
}

interface CorrelationStage {
  toolUseOwner: Map<string, string>;
  gitUseIds: Set<string>;
  countedResults: Set<string>;
  resultBytesByMsg: Map<string, number>;
}

export interface TailHandle {
  stop(): void;
}

/** Closed-enum, aggregate-only progress for the post-ready pipeline (U3). */
export type BackgroundPipelinePhase = "reading" | "detecting" | "history" | "done";

export interface BackgroundPipelineProgress {
  phase: BackgroundPipelinePhase;
  files_total: number;
  files_completed: number;
  files_skipped: number;
  files_with_new_data: number;
  detector_runs: number;
}

export type BackgroundProgressListener = (progress: BackgroundPipelineProgress) => void;

export class Ingestor {
  private readonly db: Db;
  private readonly roots: string[];
  private readonly opts: IngestorOptions;
  public readonly health = new Health();
  private pricing: PricingSnapshotStore;

  // Correlation state (process lifetime; rebuilt fresh on a cold re-scan).
  private readonly toolUseOwner = new Map<string, string>(); // toolUseId → messageId
  private readonly gitUseIds = new Set<string>(); // toolUseIds that looked like git commit/push
  private readonly countedResults = new Set<string>(); // toolUseIds already summed
  private readonly resultBytesByMsg = new Map<string, number>(); // messageId → running byte sum
  private readonly lineCursor = new Map<string, number>(); // filePath → complete lines consumed
  // Per-chunk staging overlay for the four correlation structures above. SQLite
  // rolls a failed transaction back but plain Maps/Sets do not, so applyLine
  // writes land here while a chunk transaction runs and are folded into the
  // base structures only after it commits (discarded on failure).
  private stage: CorrelationStage | null = null;
  private readonly lastVersion = new Map<string, FileVersion>(); // filePath → last-seen version
  // P2-U4a: the unapplied rest of a time-sliced chunk, so the next step reuses
  // the lines already read instead of re-reading and re-splitting up to 1 MiB.
  private readonly splitTail = new Map<
    string,
    { offset: number; version: FileVersion; result: TailChunkResult }
  >();
  // A time-sliced step's cost after its last line (offset/baseline/derived-flag writes, commit), as
  // a decaying max of recent steps. The line loop stops this much before the budget, so the WHOLE
  // step fits it, not just the lines (the tail alone measured 4-15 ms on the 280 MB corpus).
  private stepTailMs = 0;
  private readonly discoveryCache = createDiscoveryCache();
  private readonly tailFileVersions = new Map<string, FileVersion>();
  private readonly unresolvedRemotes = new Set<string>();
  private readonly noCwdFiles = new Set<string>();

  // P0-U13: tail hot/cold lanes. tailFileVersions above doubles as the
  // hotness signal (a file's real mtime, last observed by the tail loop);
  // statFailures tracks per-file stat backoff/errored state; coldLastStatAtMs
  // tracks, per cold-lane file, when it was last selected — the cold lane
  // picks the staleness-oldest N candidates each tick (review fix: a
  // positional round-robin index is not robust when the candidate list's
  // membership/order shifts tick-to-tick; staleness-oldest is, by
  // construction, since it tracks specific files rather than positions).
  private readonly statFailures = new Map<string, { count: number; nextRetryAtMs: number }>();
  private readonly coldLastStatAtMs = new Map<string, number>();

  // Idle-gating state (PERF5): timestamps of the last reconcile / detector
  // pass, and whether any lines were parsed since the last detector pass.
  private lastReconcileAtMs = 0;
  private lastDetectorPassAtMs = 0;
  // P0-U14: when the idle gate last said "skip", so it is re-asked once per floor, not every tick.
  private lastIdleGateSkipAtMs = 0;
  private ingestedSinceDetectorPass = false;
  private mappingsSinceDetectorPass = false;

  // Sessions touched by the current chunk; cleared before each chunk tx and used
  // to drive the boundary recompute inside that tx (P0-U12).
  private readonly chunkTouchedSessions = new Set<string>();
  // P2-U4: one ingest pass (slice or tail) at a time; passSessions collects the
  // sessions the running pass committed, for the slice's own reconcile.
  private passLock: Promise<unknown> = Promise.resolve();
  private passesQueued = 0;
  private passSessions: Set<string> | null = null;
  // P2-U4: files of slices the loop has not reached; the tail leaves them alone.
  private readonly pendingSliceFiles = new Set<string>();
  private sliceLoopActive = false;
  private readonly coverage = {
    weeksTotal: 0,
    weeksDone: 0,
    throughMs: null as number | null,
    partial: false,
  };
  /** Distinct models priced in the current chunk; noted once per chunk (unconfirmed-model signal). */
  private readonly chunkModels = new Set<string>();

  // Prepared statements.
  private readonly stInsertTurn;
  private readonly stPreviousBoundaryKind;
  private readonly stInsertSession;
  private readonly stSetSessionTitle;
  private readonly stBumpSession;
  private readonly stBumpUserTurnCount;
  private readonly stBumpFrictionCounts;
  private readonly stSetGapAggregates;
  private readonly stInsertMetricEvent;
  private readonly stEnrichMetricEvent;
  private readonly stGetMetricTimestamps;
  private readonly stGetGapN;
  private readonly stGetMetricBaseline;
  private readonly stSetMetricBaseline;
  private readonly stGetClassifierBaseline;
  private readonly stSetClassifierBaseline;
  private readonly stGetPreviousCacheRead;
  private readonly stInsertToolEvent;
  private readonly stUpsertContentCommand;
  private readonly stUpsertContentError;
  private readonly stUpsertToolEventMetadata;
  private readonly stUpsertToolEventSkill;
  private readonly stSetToolErrorClassification;
  private readonly stSetToolResult;
  private readonly stRefreshOwnerResultBytes;
  private readonly stSetResultBytes;
  private readonly stSetCommitSha;
  private readonly stInsertQuarantine;
  private readonly stSetDiscoveredCwd;
  private readonly stUpsertSubagentMeta;
  private readonly stGetSubagentMeta;
  private readonly stSessionStart;
  private readonly stAgentFirstTurn;
  private readonly stToolEventExists;
  /** True while a chunk transaction runs; `gridPhase` is then read once for all its writes. */
  private inChunkTx = false;
  private gridPhase: number | undefined;

  constructor(db: Db, roots: string[], options: Partial<IngestorOptions> = {}) {
    this.db = db;
    this.roots = roots;
    this.opts = { ...DEFAULT_INGESTOR_OPTIONS, ...options };

    // Seed the canonical list prices, then load the pricing store.
    seedListPrices(db, this.opts.now().toISOString());
    this.pricing = new PricingSnapshotStore(db, this.opts.now().toISOString());

    this.stInsertTurn = db.prepare(
      `INSERT OR IGNORE INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain,
          input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
          cache_write_5m, cache_write_1h, cache_write_other,
          tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim,
          provisional, effort, parser_version, is_compaction_boundary, agent_id)
       VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?,?,?,?,?)`,
    );
    this.stPreviousBoundaryKind = db.prepare(
      `SELECT boundary_kind FROM ingest_metric_events
        WHERE session_id = ? AND event_position < ?
        ORDER BY event_position DESC LIMIT 1`,
    );
    this.stInsertSession = db.prepare(
      `INSERT OR IGNORE INTO sessions
         (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
          state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?,?,?,?,?,'LIVE',0,0,'[]')`,
    );
    this.stSetSessionTitle = db.prepare(
      `UPDATE sessions SET title = ?, title_source = ?
       WHERE session_id = ? AND (? = 'custom' OR title_source IS NULL OR title_source = 'ai')`,
    );
    this.stBumpSession = db.prepare(
      `UPDATE sessions
         SET turn_count   = turn_count + 1,
             cost_equiv_u = cost_equiv_u + ?,
             first_turn_at = MIN(COALESCE(first_turn_at, ?), ?),
             last_turn_at  = MAX(COALESCE(last_turn_at, ?), ?),
             state         = CASE WHEN state = 'RECONCILED' THEN 'LIVE' ELSE state END
       WHERE session_id = ?`,
    );
    this.stBumpUserTurnCount = db.prepare(
      "UPDATE sessions SET user_turn_count = user_turn_count + 1 WHERE session_id = ?",
    );
    this.stBumpFrictionCounts = db.prepare(
      `UPDATE sessions SET
         compaction_count = compaction_count + ?,
         api_error_count  = api_error_count  + ?,
         interrupt_count  = interrupt_count  + ?
       WHERE session_id = ?`,
    );
    this.stSetGapAggregates = db.prepare(
      "UPDATE sessions SET gap_median_s=?, gap_p90_s=?, long_gap_count=?, gap_n=? WHERE session_id=?",
    );
    this.stInsertMetricEvent = db.prepare(
      `INSERT OR IGNORE INTO ingest_metric_events
         (event_id, session_id, user_turn_ts, is_user_turn,
          is_compact_summary, is_api_error, is_interrupt,
          classifier_label, command_shape, destructive_op, cc_version, classifier_version,
          event_ts, event_position, boundary_kind, boundary_verification, is_sidechain)
       VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?)`,
    );
    this.stEnrichMetricEvent = db.prepare(
      `UPDATE ingest_metric_events SET
          classifier_label = COALESCE(classifier_label, ?),
          command_shape = COALESCE(command_shape, ?),
          destructive_op = COALESCE(destructive_op, ?),
          cc_version = COALESCE(cc_version, ?),
          classifier_version = COALESCE(classifier_version, ?),
          event_ts = COALESCE(event_ts, ?),
          event_position = COALESCE(event_position, ?),
          boundary_kind = COALESCE(boundary_kind, ?),
          boundary_verification = COALESCE(boundary_verification, ?),
          is_sidechain = ?
       WHERE event_id = ?`,
    );
    this.stGetMetricTimestamps = db.prepare(
      `SELECT user_turn_ts FROM ingest_metric_events
       WHERE session_id = ? AND is_user_turn = 1 AND user_turn_ts IS NOT NULL`,
    );
    this.stGetGapN = db.prepare("SELECT gap_n FROM sessions WHERE session_id = ?");
    this.stGetMetricBaseline = db.prepare(
      "SELECT seeded_offset FROM ingest_metric_baselines WHERE file_path = ?",
    );
    this.stSetMetricBaseline = db.prepare(
      `INSERT INTO ingest_metric_baselines (file_path, seeded_offset) VALUES (?, ?)
       ON CONFLICT(file_path) DO UPDATE SET seeded_offset = excluded.seeded_offset`,
    );
    this.stGetClassifierBaseline = db.prepare(
      "SELECT seeded_offset FROM ingest_classifier_baselines WHERE file_path_hash = ?",
    );
    this.stSetClassifierBaseline = db.prepare(
      `INSERT INTO ingest_classifier_baselines (file_path_hash, seeded_offset) VALUES (?, ?)
       ON CONFLICT(file_path_hash) DO UPDATE SET seeded_offset = excluded.seeded_offset`,
    );
    this.stGetPreviousCacheRead = db.prepare(
      "SELECT cache_read_tokens FROM turns WHERE session_id = ? AND ts < ? ORDER BY ts DESC, message_id DESC LIMIT 1",
    );
    this.stInsertToolEvent = db.prepare(
      `INSERT INTO tool_events
         (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha,
          bash_command_family)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET
         input_bytes = COALESCE(tool_events.input_bytes, excluded.input_bytes),
         input_hash = COALESCE(tool_events.input_hash, excluded.input_hash),
         bash_command_family = COALESCE(tool_events.bash_command_family, excluded.bash_command_family)`,
    );
    // SEC-101 W-A: retained content slices, keyed to the tool event. Each slice
    // is merged into content_json via json_patch so the command (tool_use) and
    // error (tool_result) halves can arrive on separate lines. Guarded by
    // EXISTS so a result without its tool_use never violates the FK.
    this.stUpsertContentCommand = db.prepare(
      `INSERT INTO tool_event_content (event_id, content_json, content_included)
         SELECT ?, json_object('command', ?), 1
         WHERE EXISTS (SELECT 1 FROM tool_events WHERE event_id = ?)
       ON CONFLICT(event_id) DO UPDATE SET
         content_json = json_patch(tool_event_content.content_json, json_object('command', ?)),
         content_included = 1`,
    );
    this.stUpsertContentError = db.prepare(
      `INSERT INTO tool_event_content (event_id, content_json, content_included)
         SELECT ?, json_object('error', ?), 1
         WHERE EXISTS (SELECT 1 FROM tool_events WHERE event_id = ?)
       ON CONFLICT(event_id) DO UPDATE SET
         content_json = json_patch(tool_event_content.content_json, json_object('error', ?)),
         content_included = 1`,
    );
    this.stUpsertToolEventMetadata = db.prepare(
      `INSERT INTO tool_event_metadata
         (event_id, file_path_hash, owner_message_id, block_index, is_test_command,
          edit_old_string_hash, edit_new_string_hash)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET
         file_path_hash = COALESCE(tool_event_metadata.file_path_hash, excluded.file_path_hash),
         edit_old_string_hash =
           COALESCE(tool_event_metadata.edit_old_string_hash, excluded.edit_old_string_hash),
         edit_new_string_hash =
           COALESCE(tool_event_metadata.edit_new_string_hash, excluded.edit_new_string_hash),
         owner_message_id = COALESCE(tool_event_metadata.owner_message_id, excluded.owner_message_id),
         block_index = excluded.block_index,
         is_test_command = excluded.is_test_command`,
    );
    this.stUpsertToolEventSkill = db.prepare(
      `INSERT INTO tool_event_skills (event_id, skill_name) VALUES (?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    );
    this.stSetToolErrorClassification = db.prepare(
      `UPDATE tool_events
       SET tool_error_class = ?, tool_error_classifier_version = ?,
           interrupt_kind = ?, interrupt_classifier_version = ?
       WHERE event_id = ?`,
    );
    this.stSetToolResult = db.prepare(
      `UPDATE tool_events
       SET result_bytes = ?,
           exit_class = CASE
             WHEN ? = 0 THEN 'OK'
             WHEN EXISTS (
               SELECT 1 FROM tool_event_metadata AS metadata
               WHERE metadata.event_id = tool_events.event_id
                 AND metadata.is_test_command = 1
             ) THEN 'TEST_FAIL'
             ELSE 'ERROR'
           END
       WHERE event_id = ?
       RETURNING ts`,
    );
    this.stRefreshOwnerResultBytes = db.prepare(
      `UPDATE turns
       SET tool_result_bytes = (
         SELECT SUM(events.result_bytes)
         FROM tool_event_metadata AS owned
         JOIN tool_events AS events ON events.event_id = owned.event_id
         WHERE owned.owner_message_id = turns.message_id
           AND events.result_bytes IS NOT NULL
       )
       WHERE message_id = (
         SELECT owner_message_id FROM tool_event_metadata WHERE event_id = ?
       )`,
    );
    this.stSetResultBytes = db.prepare(
      "UPDATE turns SET tool_result_bytes = ? WHERE message_id = ?",
    );
    this.stSetCommitSha = db.prepare("UPDATE tool_events SET commit_sha = ? WHERE event_id = ?");
    this.stInsertQuarantine = db.prepare(
      `INSERT OR IGNORE INTO ingest_quarantine
         (q_id, file_path, line_no, error_class, parser_version, seen_at)
       VALUES (?,?,?,?,?,?)`,
    );
    this.stSetDiscoveredCwd = db.prepare(
      "UPDATE workspaces SET discovered_cwd=? WHERE workspace_id=? AND discovered_cwd IS NULL",
    );
    this.stUpsertSubagentMeta = db.prepare(
      `INSERT INTO subagent_meta
         (agent_id, session_id, agent_type, tool_use_id, spawn_depth, description_len)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         session_id = excluded.session_id,
         agent_type = excluded.agent_type,
         tool_use_id = excluded.tool_use_id,
         spawn_depth = excluded.spawn_depth,
         description_len = excluded.description_len`,
    );
    this.stGetSubagentMeta = db.prepare(
      `SELECT session_id, agent_type, tool_use_id, spawn_depth, description_len
         FROM subagent_meta WHERE agent_id = ?`,
    );
    this.stSessionStart = db.prepare("SELECT first_turn_at FROM sessions WHERE session_id = ?");
    this.stAgentFirstTurn = db
      .prepare("SELECT MIN(ts) FROM turns WHERE session_id = ? AND agent_id = ?")
      .pluck();
    this.stToolEventExists = db.prepare("SELECT 1 FROM tool_events WHERE event_id = ?");
  }

  /** Enrichment epoch: a write to a row stamped `ts` may land in a closed ledger window. */
  private touchRow(ts: string | null | undefined): void {
    // Inside a chunk transaction the reset-grid phase is read once, not per written row.
    if (this.inChunkTx) this.gridPhase ??= resetGridPhaseMs(this.db);
    bumpEnrichmentEpochIfClosed(this.db, ts, this.opts.now(), this.gridPhase);
  }

  /**
   * Enrichment epoch for an upsert of a tool_events row: bump only when the row already exists
   * (an in-place rewrite). A new row is a COUNT / MAX(rowid) change the fingerprint already sees,
   * so a back-scan of old transcripts does not bump per row. Call BEFORE the insert.
   */
  private touchExistingToolEvent(eventId: string, ts: string): void {
    if (this.inChunkTx) this.gridPhase ??= resetGridPhaseMs(this.db);
    if (!isClosedTs(this.db, ts, this.opts.now(), this.gridPhase)) return;
    if (this.stToolEventExists.get(eventId) !== undefined) bumpEnrichmentEpoch(this.db);
  }

  /** Full back-scan: ingest every discovered file once, then reconcile. */
  runBackscan(): HealthCounters {
    this.ingestAllKnown();
    this.reconcileNow();
    this.runPostIngest();
    return this.health.snapshot();
  }

  /** Async full back-scan that yields between bounded batches, then reconciles. */
  async runBackscanBatched(batchSize = INITIAL_SCAN_BATCH_SIZE): Promise<HealthCounters> {
    await this.ingestAllKnownBatched(batchSize);
    await this.awaitWriteGate();
    this.reconcileNow();
    this.runPostIngest();
    return this.health.snapshot();
  }

  /** Start incremental tailing: initial pass, then discovery + tail intervals. */
  startTail(): TailHandle {
    this.ingestAllKnown();
    this.reconcileNow();
    this.runPostIngest();

    return this.startTailTimers();
  }

  /** Start tailing after an async, yielding initial scan. */
  async startTailBatched(batchSize = INITIAL_SCAN_BATCH_SIZE): Promise<TailHandle> {
    // Best-effort initial back-scan. If it throws mid-backlog (e.g. a pathological
    // line deep in the corpus that escapes per-line quarantine, or a transient DB
    // write error), we must STILL arm the tail/discovery timers below — otherwise,
    // because U2 fires setReady() on the bounded slice before this pass runs, the
    // daemon would serve a healthy-looking dashboard with NO live ingestion for its
    // whole lifetime. The 2s tail tick re-scans every file and self-heals the
    // backlog; discovery keeps registering new workspaces. (Matches the daemon's
    // "ingestion failed to start → still serve, degraded" contract.)
    try {
      await this.runBackgroundBackfill(batchSize);
    } catch (e) {
      console.error(
        `Initial back-scan failed — arming tail anyway (degraded): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    await this.awaitWriteGate();
    this.reconcileNow();
    this.runPostIngest();

    return this.startTailTimers();
  }

  /**
   * Post-ready historical catch-up (U3), as P2-U4 slices: `slices` (default: a fresh
   * plan) run newest first, each reconciling only the sessions it touched. The
   * one-time agent-id fill and a final reconcile (by now only LIVE sessions are
   * left open) run once after the last slice. Callers own the detector phase.
   */
  async runBackgroundBackfill(
    batchSize = INITIAL_SCAN_BATCH_SIZE,
    onProgress?: BackgroundProgressListener,
    opts: {
      slices?: IngestSlice[];
      onSlice?: (slice: IngestSlice, result: SliceResult) => void;
    } = {},
  ): Promise<BackgroundPipelineProgress> {
    const slices = opts.slices ?? this.planSlices();
    const progress: BackgroundPipelineProgress = {
      phase: "reading",
      files_total: slices.reduce((n, s) => n + s.files.length, 0),
      files_completed: 0,
      files_skipped: 0,
      files_with_new_data: 0,
      detector_runs: 0,
    };
    const report = () => onProgress?.({ ...progress });
    report();
    this.sliceLoopActive = true;
    try {
      for (const slice of slices) {
        const result = await this.ingestSlice(slice, {
          batchSize,
          onFile: ({ parsedAny, skipped }) => {
            progress.files_completed += 1;
            if (skipped) progress.files_skipped += 1;
            if (parsedAny) progress.files_with_new_data += 1;
            report();
          },
        });
        opts.onSlice?.(slice, result);
      }
    } finally {
      // A failed loop hands every file back to the tail, which self-heals the backlog.
      this.pendingSliceFiles.clear();
      this.sliceLoopActive = false;
    }
    await backfillTurnAgentIds(
      this.db,
      refreshDiscoveryCache(this.roots, this.discoveryCache).map((f) => f.filePath),
    );
    await this.awaitWriteGate();
    this.reconcileNow();
    return { ...progress };
  }

  /**
   * P2-U4: group the discovered files by mtime week, newest first (see IngestSlice).
   * Resets history coverage, and marks every planned file pending for the tail.
   */
  planSlices(): IngestSlice[] {
    const nowMs = this.opts.now().getTime();
    const byIndex = new Map<number, DiscoveredFile[]>();
    for (const { file, mtimeMs } of statBootScanFiles(
      refreshDiscoveryCache(this.roots, this.discoveryCache, true),
    )) {
      // A file that vanished since discovery is left to the tail.
      if (!Number.isFinite(mtimeMs)) continue;
      const index = Math.max(0, Math.floor((nowMs - mtimeMs) / WEEK_MS));
      const files = byIndex.get(index) ?? [];
      files.push(file);
      byIndex.set(index, files);
    }
    const slices = [...byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, files]) => ({
        index,
        startMs: nowMs - (index + 1) * WEEK_MS,
        endMs: nowMs - index * WEEK_MS,
        files,
      }));
    this.pendingSliceFiles.clear();
    for (const slice of slices) for (const f of slice.files) this.pendingSliceFiles.add(f.filePath);
    Object.assign(this.coverage, {
      weeksTotal: slices.length,
      weeksDone: 0,
      throughMs: null,
      partial: false,
    });
    return slices;
  }

  /**
   * Ingest one slice (yielding), then reconcile the sessions it touched. Slices must
   * run newest first: completing slice k means history is complete from its start.
   * `maxMs` / `maxBytes` stop the slice at a file boundary (never before its first
   * file); the files left over come back in `rest`.
   */
  async ingestSlice(slice: IngestSlice, opts: SliceOptions = {}): Promise<SliceResult> {
    const started = performance.now();
    const batchSize = opts.batchSize ?? INITIAL_SCAN_BATCH_SIZE;
    const sessions = new Set<string>();
    let bytes = 0;
    let done = 0;
    let lastYieldAt = Date.now();
    for (const f of slice.files) {
      if (
        done > 0 &&
        ((opts.maxMs !== undefined && performance.now() - started >= opts.maxMs) ||
          (opts.maxBytes !== undefined && bytes >= opts.maxBytes))
      ) {
        break;
      }
      if (opts.maxBytes !== undefined) {
        try {
          bytes += fs.statSync(f.filePath).size;
        } catch {
          // vanished: the pass below skips it
        }
      }
      const pass = await this.ingestFileYielding(f.filePath, f.projectSlug);
      for (const id of pass.sessions) sessions.add(id);
      this.pendingSliceFiles.delete(f.filePath);
      done++;
      opts.onFile?.(pass);
      // A skipped file returns without a loop turn; yield on a time budget or every
      // batchSize files so a run of them cannot hold the loop.
      if (Date.now() - lastYieldAt >= SCAN_YIELD_BUDGET_MS || done % batchSize === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        lastYieldAt = Date.now();
      }
    }
    const rest = slice.files.slice(done);
    const reconcile = await this.reconcileSessionsBatched([...sessions]);
    if (rest.length === 0) {
      this.coverage.weeksDone += 1;
      this.coverage.throughMs = slice.startMs;
      this.coverage.partial = false;
    } else {
      this.coverage.partial = true;
    }
    bumpDataVersion("ingest");
    return {
      rest,
      sessions: sessions.size,
      reconcile_batches: reconcile.batches,
      reconcile_ms: reconcile.ms,
      coverage: this.historyCoverage(),
    };
  }

  /** P2-U4: how much history the slice loop has fully ingested so far. */
  historyCoverage(): HistoryCoverage {
    const through = this.coverage.throughMs;
    return {
      weeks_done: this.coverage.weeksDone,
      weeks_total: this.coverage.weeksTotal,
      complete_through_ms: through,
      oldest_complete_day:
        through === null
          ? null
          : new Date(Math.ceil(through / DAY_MS) * DAY_MS).toISOString().slice(0, 10),
      partial_week: this.coverage.partial,
    };
  }

  /**
   * Reconcile `sessionIds` one session per transaction, yielding a full loop turn
   * whenever the P2-U4a step budget is spent. A session's cost grows with its turns
   * (the provisional-flag UPDATE), so a fixed batch size could still block: on the X
   * corpus one reconcile of all 60 sessions took 447 ms.
   */
  private async reconcileSessionsBatched(
    sessionIds: string[],
  ): Promise<{ batches: number; ms: number }> {
    const budgetMs = testSeams.txBudgetMs ?? INGEST_TX_BUDGET_MS;
    const cutoff = new Date(
      this.opts.now().getTime() - this.opts.activityWindowSecs * 1000,
    ).toISOString();
    let batches = 0;
    let ms = 0;
    let i = 0;
    while (i < sessionIds.length) {
      const gate = this.opts.writeGate?.();
      if (gate) await gate;
      const batchStart = performance.now();
      do {
        reconcileSessionsById(this.db, [sessionIds[i] as string], cutoff, this.opts.reconcile);
        i++;
      } while (i < sessionIds.length && performance.now() - batchStart < budgetMs);
      batches++;
      ms += performance.now() - batchStart;
      if (i < sessionIds.length) {
        await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
      }
    }
    return { batches, ms };
  }

  /**
   * Arm incremental timers after a completed or failed background pass. P2-U4 arms
   * the tail alone after W0 (`discovery: false`) and discovery once the pipeline is
   * done (`tail: false`), as before: on a corpus whose heads carry no cwd, a
   * discovery tick re-reads every file head (818 ms on X).
   */
  startTailAfterBackground(timers: { tail?: boolean; discovery?: boolean } = {}): TailHandle {
    // Detectors have just run at boot (post-readiness pass) and again in the
    // background detector phase, but neither goes through runPostIngest(), so
    // lastDetectorPassAtMs is still 0 here. Seed it so the discovery tick's
    // idle-floor guard is honored: without this, the first tick (30s) would
    // always see a ~56-year gap and fire a redundant detector pass, defeating
    // PERF5. New-data ticks still fire via ingestedSinceDetectorPass.
    this.lastDetectorPassAtMs = this.opts.now().getTime();
    return this.startTailTimers(timers);
  }

  private startTailTimers({
    tail = true,
    discovery = true,
  }: { tail?: boolean; discovery?: boolean } = {}): TailHandle {
    let busy = false;
    let mappingBusy = false;
    let stopped = false;
    let lastFullDiscoveryAtMs = this.opts.now().getTime();

    // P0-U13: seed the tail loop's own per-file version cache from whatever
    // the pre-tail backscan already observed, so the very first tick can
    // already tell a freshly-touched file from a stale one by real mtime,
    // instead of treating every file as hot for one extra full-corpus sweep.
    for (const [filePath, version] of this.lastVersion) {
      if (!this.tailFileVersions.has(filePath)) this.tailFileVersions.set(filePath, version);
    }

    // Fast tail cadence: advance byte offsets on known files, then reconcile.
    // Ingestion is chunk-bounded and yields between chunks; the busy guard is
    // released only when the whole async pass settles, so ticks never overlap
    // a still-running pass. A tick that parsed nothing skips reconcile until
    // the idle floor elapses (PERF5): with a zero ingest delta, reconcile
    // output only moves on activity-window decay, which the floor observes
    // well within activityWindowSecs.
    //
    // P0-U13 (audit §9.3 N1): every known file used to be `fs.stat`'d on
    // every tick regardless of activity (41% of idle non-idle CPU self-time
    // at 2,881 files). Hot/cold split: a file whose last-observed mtime
    // (tailFileVersions, above) is within the session's own "still LIVE"
    // activity window (opts.activityWindowSecs — reusing that existing
    // concept rather than inventing a second, unrelated freshness clock)
    // stays on the every-tick cadence (A-4: hot <= 5 s, trivially satisfied
    // by the tick cadence itself). Everything else takes a bounded per-tick
    // batch — the coldLastStatAtMs-STALEST candidates first (review fix: a
    // positional round-robin index into coldCandidates, a list rebuilt fresh
    // every tick, is not robust to that list's membership/order changing
    // tick-to-tick — a file entering/leaving stat-error backoff, a hot<->cold
    // transition, or a newly-discovered file all reshuffle it, and an index
    // can then land on the wrong file or skip one). Picking by per-file
    // staleness instead tracks each file's own wait time directly, so the
    // full cold list is still covered at least once every COLD_LANE_CYCLE_MS
    // (A-4: every file <= 5 min) regardless of list churn or corpus size. A
    // file with no recorded version yet (never classified) is treated as hot
    // so a brand-new file is picked up immediately.
    const tailTimer = !tail
      ? null
      : scheduleJob("ingest.tail-tick", this.opts.tailIntervalMs, () => {
          if (busy) return;
          busy = true;
          return (async () => {
            try {
              let parsedAny = false;
              const tickSessions = new Set<string>();
              let lastYieldAt = Date.now();
              const nowMs = Date.now();
              const hotWindowMs = this.opts.activityWindowSecs * 1000;

              const dueFiles: DiscoveredFile[] = [];
              const coldCandidates: DiscoveredFile[] = [];
              const discoveredPaths = new Set<string>();
              for (const f of refreshDiscoveryCache(this.roots, this.discoveryCache)) {
                discoveredPaths.add(f.filePath);
                // P2-U4: armed after W0, the tail leaves files of pending slices to the loop.
                if (this.pendingSliceFiles.has(f.filePath)) continue;
                const failure = this.statFailures.get(f.filePath);
                if (failure !== undefined && failure.nextRetryAtMs > nowMs) continue; // backing off
                const known = this.tailFileVersions.get(f.filePath);
                const isHot = known === undefined || nowMs - known.mtimeMs <= hotWindowMs;
                if (isHot) dueFiles.push(f);
                else coldCandidates.push(f);
              }
              // Bound coldLastStatAtMs to currently-discovered files (a rotated or
              // deleted file stops appearing in discovery and would otherwise
              // linger here forever).
              for (const filePath of this.coldLastStatAtMs.keys()) {
                if (!discoveredPaths.has(filePath)) this.coldLastStatAtMs.delete(filePath);
              }
              if (coldCandidates.length > 0) {
                const ticksPerColdCycle = Math.max(
                  1,
                  Math.floor(COLD_LANE_CYCLE_MS / this.opts.tailIntervalMs),
                );
                const batchSize = Math.max(1, Math.ceil(coldCandidates.length / ticksPerColdCycle));
                const coldRank = (filePath: string) =>
                  this.coldLastStatAtMs.get(filePath) ?? Number.NEGATIVE_INFINITY;
                coldCandidates.sort((a, b) => {
                  const ra = coldRank(a.filePath);
                  const rb = coldRank(b.filePath);
                  return ra === rb ? 0 : ra < rb ? -1 : 1;
                });
                for (let i = 0; i < Math.min(batchSize, coldCandidates.length); i++) {
                  const f = coldCandidates[i];
                  if (f !== undefined) {
                    dueFiles.push(f);
                    this.coldLastStatAtMs.set(f.filePath, nowMs);
                  }
                }
              }

              for (const f of dueFiles) {
                if (stopped) return; // stop() during a suspended pass: quit at a file boundary
                let currentVersion: FileVersion;
                try {
                  currentVersion = fileVersion(this.opts.statFile(f.filePath));
                } catch {
                  this.tailFileVersions.delete(f.filePath);
                  this.recordStatFailure(f.filePath, nowMs);
                  continue;
                }
                this.statFailures.delete(f.filePath); // recovered
                const previous = this.tailFileVersions.get(f.filePath);
                if (previous === undefined || !sameFileVersion(previous, currentVersion)) {
                  const pass = await this.ingestFileYielding(f.filePath, f.projectSlug);
                  parsedAny = pass.parsedAny || parsedAny;
                  for (const id of pass.sessions) tickSessions.add(id);
                  try {
                    const after = fileVersion(this.opts.statFile(f.filePath));
                    if (sameFileVersion(currentVersion, after))
                      this.tailFileVersions.set(f.filePath, after);
                    else this.tailFileVersions.delete(f.filePath);
                  } catch {
                    this.tailFileVersions.delete(f.filePath);
                    this.recordStatFailure(f.filePath, nowMs);
                  }
                }
                if (Date.now() - lastYieldAt >= SCAN_YIELD_BUDGET_MS) {
                  await new Promise<void>((resolve) => setImmediate(resolve));
                  lastYieldAt = Date.now();
                }
              }
              this.reportErroredFiles();
              if (parsedAny) this.ingestedSinceDetectorPass = true;
              const reconcileDue =
                parsedAny ||
                this.opts.now().getTime() - this.lastReconcileAtMs >=
                  this.opts.reconcileIdleFloorMs;
              if (!stopped && reconcileDue) {
                // P2-U4: mid-loop, every session of the running slice is still open, and a full
                // reconcile would block like the old end-of-reading one. Reconcile only what
                // this tick ingested; the loop's final reconcile covers the rest.
                if (this.sliceLoopActive) await this.reconcileSessionsBatched([...tickSessions]);
                else {
                  await this.awaitWriteGate();
                  if (!stopped) this.reconcileNow(); // stop() may land during the wait
                }
              }
            } catch (e) {
              console.warn(`tail tick failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              busy = false;
            }
          })();
        });

    // Slower discovery cadence: register any newly-appeared workspace slugs, then
    // run a full detector pass (30s freshness matches the recommendations surface;
    // a pass on every 2s tail tick would be wasteful).
    const discoveryTimer = !discovery
      ? null
      : scheduleJob("ingest.discovery-tick", this.opts.discoveryIntervalMs, () => {
          // The tick writes (workspaces, cwd backfill): wait out an in-flight checkpoint first.
          const gate = this.opts.writeGate?.();
          if (gate) {
            if (discoveryWaiting) return;
            discoveryWaiting = true;
            return gate.then(() => {
              discoveryWaiting = false;
              if (!stopped) discoveryTick();
            });
          }
          discoveryTick();
          return undefined;
        });

    function noop(): void {}
    let discoveryWaiting = false;
    const discoveryTick = !discovery
      ? noop
      : () => {
          try {
            const nowMs = this.opts.now().getTime();
            const fullWalkDue =
              nowMs - lastFullDiscoveryAtMs >= this.opts.discoveryFullWalkIntervalMs;
            const discovered = refreshDiscoveryCache(this.roots, this.discoveryCache, fullWalkDue);
            if (fullWalkDue) lastFullDiscoveryAtMs = nowMs;
            for (const slug of new Set(discovered.map((f) => f.projectSlug))) {
              registerWorkspace(this.db, slug);
            }
            backfillDiscoveredCwd(this.db, discovered, defaultReadCwd, this.noCwdFiles);
            // RB7: remote lookups spawn git, so they run off the tick (async, one at a
            // time); a mapping found here counts toward the next tick's detector gate.
            if (!mappingBusy) {
              mappingBusy = true;
              resolveWorkspaceMappings(this.db, {
                readRemote: this.opts.readRemote ?? defaultReadRemote,
                unresolved: this.unresolvedRemotes,
              })
                .then((newlyMapped) => {
                  if (stopped || newlyMapped === 0) return;
                  this.mappingsSinceDetectorPass = true;
                  if (this.opts.onNewMappings === undefined) return;
                  try {
                    this.opts.onNewMappings(newlyMapped);
                  } catch (e) {
                    console.warn(
                      `new mappings callback failed: ${e instanceof Error ? e.message : String(e)}`,
                    );
                  }
                })
                .catch((e) => {
                  console.warn(
                    `workspace mapping failed: ${e instanceof Error ? e.message : String(e)}`,
                  );
                })
                .finally(() => {
                  mappingBusy = false;
                });
            }
            // Change-gated detector pass (PERF5): detector inputs are ingest-derived,
            // so a pass with no new parsed lines and no new mappings recomputes the
            // same data; the idle floor bounds staleness of pure time-window edges.
            let detectorsDue =
              nowMs - this.lastDetectorPassAtMs >= this.opts.detectorMinIntervalMs &&
              (this.mappingsSinceDetectorPass ||
                this.ingestedSinceDetectorPass ||
                nowMs - Math.max(this.lastDetectorPassAtMs, this.lastIdleGateSkipAtMs) >=
                  this.opts.detectorIdleFloorMs ||
                nowMs - this.lastDetectorPassAtMs >= IDLE_GATE_MAX_STALE_MS);
            // P0-U14: a pass due only by the idle floor also needs the marker gate to agree.
            // The 60 min cap is enforced here too (not only in the gate), so a skip never
            // pushes the next ask past it, and a throwing gate fails open.
            if (
              detectorsDue &&
              !this.mappingsSinceDetectorPass &&
              !this.ingestedSinceDetectorPass &&
              nowMs - this.lastDetectorPassAtMs < IDLE_GATE_MAX_STALE_MS &&
              this.opts.detectorIdleGate !== undefined &&
              !this.idleGateAllows(this.opts.detectorIdleGate)
            ) {
              this.lastIdleGateSkipAtMs = nowMs;
              detectorsDue = false;
            }
            if (detectorsDue) this.runPostIngest();
          } catch (e) {
            console.warn(`discovery tick failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        };

    return {
      stop: () => {
        stopped = true;
        tailTimer?.cancel();
        discoveryTimer?.cancel();
      },
    };
  }

  /** Wait out an in-flight checkpoint (or worker write); the caller writes right after, with no await. */
  private async awaitWriteGate(): Promise<void> {
    // One wait, as the step loop does: a checkpoint cannot start between the gate and the write.
    const gate = this.opts.writeGate?.();
    if (gate) await gate;
  }

  /** P0-U14: ask the idle gate; a throw (e.g. locked DB) counts as due so passes keep running. */
  private idleGateAllows(gate: (now: Date) => boolean): boolean {
    try {
      return gate(this.opts.now());
    } catch (e) {
      console.warn(
        `detector idle gate failed, running pass: ${e instanceof Error ? e.message : String(e)}`,
      );
      return true;
    }
  }

  /** P0-U13: record one stat failure for `filePath` and schedule its next retry. */
  private recordStatFailure(filePath: string, nowMs: number): void {
    const prev = this.statFailures.get(filePath);
    const count = (prev?.count ?? 0) + 1;
    const backoffMs = Math.min(STAT_BACKOFF_MAX_MS, STAT_BACKOFF_BASE_MS * 2 ** (count - 1));
    this.statFailures.set(filePath, { count, nextRetryAtMs: nowMs + backoffMs });
  }

  /**
   * P0-U13: publish the current errored-file summary to /api/perf. Ids are
   * SHA-256 path hashes (classifierBaselinePathHash), never raw paths
   * (SEC-101), and the list is bounded regardless of how many files fail.
   */
  private reportErroredFiles(): void {
    let count = 0;
    const ids: string[] = [];
    for (const [filePath, failure] of this.statFailures) {
      if (failure.count < STAT_ERROR_THRESHOLD) continue;
      count++;
      if (ids.length < MAX_ERRORED_IDS) ids.push(classifierBaselinePathHash(filePath).slice(0, 16));
    }
    setErroredFiles(count, ids);
  }

  /** Current parser-health counters (surfaced in Settings by WP4). */
  healthSnapshot(): HealthCounters {
    return this.health.snapshot();
  }

  /**
   * Clear in-memory correlation/offset caches. Called after a DB reset so the
   * running tailer re-ingests the still-present transcript files faithfully
   * (identical to a cold rescan) instead of re-inserting rows against stale
   * correlation state (which would leave tool_events bytes/SHAs NULL).
   */
  clearRuntimeState(): void {
    this.toolUseOwner.clear();
    this.gitUseIds.clear();
    this.countedResults.clear();
    this.resultBytesByMsg.clear();
    this.lineCursor.clear();
    this.lastVersion.clear();
    this.unresolvedRemotes.clear();
    this.noCwdFiles.clear();
  }

  // ── correlation staging (chunk-transaction safety) ─────────────────────────
  // Reads see the staged overlay first, then the committed base; writes go to
  // the stage while a chunk transaction is open, else straight to the base.

  private stagedOwnerGet(toolUseId: string): string | undefined {
    return this.stage?.toolUseOwner.get(toolUseId) ?? this.toolUseOwner.get(toolUseId);
  }

  private stagedOwnerSet(toolUseId: string, messageId: string): void {
    (this.stage?.toolUseOwner ?? this.toolUseOwner).set(toolUseId, messageId);
  }

  private stagedGitHas(toolUseId: string): boolean {
    return (this.stage?.gitUseIds.has(toolUseId) ?? false) || this.gitUseIds.has(toolUseId);
  }

  private stagedGitAdd(toolUseId: string): void {
    (this.stage?.gitUseIds ?? this.gitUseIds).add(toolUseId);
  }

  private stagedCountedHas(toolUseId: string): boolean {
    return (
      (this.stage?.countedResults.has(toolUseId) ?? false) || this.countedResults.has(toolUseId)
    );
  }

  private stagedCountedAdd(toolUseId: string): void {
    (this.stage?.countedResults ?? this.countedResults).add(toolUseId);
  }

  private stagedResultBytesGet(messageId: string): number | undefined {
    return this.stage?.resultBytesByMsg.get(messageId) ?? this.resultBytesByMsg.get(messageId);
  }

  private stagedResultBytesSet(messageId: string, bytes: number): void {
    (this.stage?.resultBytesByMsg ?? this.resultBytesByMsg).set(messageId, bytes);
  }

  /** Fold a committed chunk's staged mutations into the base structures. */
  private commitStage(stage: CorrelationStage): void {
    for (const [k, v] of stage.toolUseOwner) this.toolUseOwner.set(k, v);
    for (const id of stage.gitUseIds) this.gitUseIds.add(id);
    for (const id of stage.countedResults) this.countedResults.add(id);
    for (const [k, v] of stage.resultBytesByMsg) this.resultBytesByMsg.set(k, v);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private ingestAllKnown(): void {
    for (const f of refreshDiscoveryCache(this.roots, this.discoveryCache, true)) {
      this.ingestFile(f.filePath, f.projectSlug);
    }
  }

  private async ingestAllKnownBatched(
    batchSize: number,
    onFileComplete?: (parsedAny: boolean, total: number, skipped: boolean) => void,
  ): Promise<void> {
    const files = orderBootScanFiles(refreshDiscoveryCache(this.roots, this.discoveryCache, true));
    const normalizedBatchSize =
      Number.isFinite(batchSize) && batchSize >= 1
        ? Math.max(1, Math.floor(batchSize))
        : INITIAL_SCAN_BATCH_SIZE;

    // Boot-progress events (BOOT-1): workspace slugs and counts ONLY — never
    // file paths (SEC-101). This method only runs for the initial back-scan.
    const filesBySlug = new Map<string, number>();
    for (const f of files)
      filesBySlug.set(f.projectSlug, (filesBySlug.get(f.projectSlug) ?? 0) + 1);
    bootFilesTotal(files.length);
    pushBootEvent(
      "root",
      `discovered ${files.length} files across ${filesBySlug.size} workspaces`,
      this.opts.now().toISOString(),
    );
    const announcedSlugs = new Set<string>();

    // U-3: yield on a time budget, not once per fixed-size batch. normalizedBatchSize
    // is retained only as an upper bound on how long we go between yields when files
    // are trivially fast; the primary trigger is elapsed wall-clock per run.
    let lastYieldAt = Date.now();
    let sinceYield = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f === undefined) continue;
      if (!announcedSlugs.has(f.projectSlug)) {
        announcedSlugs.add(f.projectSlug);
        pushBootEvent(
          "workspace",
          `scan ${f.projectSlug} → ${filesBySlug.get(f.projectSlug) ?? 0} files`,
          this.opts.now().toISOString(),
        );
      }
      // Yields between chunks WITHIN a large file, on top of the loop yield below.
      const { parsedAny, skipped } = await this.ingestFileYielding(f.filePath, f.projectSlug);
      onFileComplete?.(parsedAny, files.length, skipped);
      sinceYield++;
      if (
        i < files.length - 1 &&
        (Date.now() - lastYieldAt >= SCAN_YIELD_BUDGET_MS || sinceYield >= normalizedBatchSize)
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        lastYieldAt = Date.now();
        sinceYield = 0;
      }
    }
  }

  private reconcileNow(): void {
    const cutoff = new Date(this.opts.now().getTime() - this.opts.activityWindowSecs * 1000);
    if (testSeams.crash === null) {
      reconcileSessions(this.db, cutoff.toISOString(), this.opts.reconcile);
    } else {
      // Test seam only: run the reconcile inside one tx so a hard kill after its
      // writes leaves them uncommitted (mid-reconcile).
      this.db.transaction(() => {
        reconcileSessions(this.db, cutoff.toISOString(), this.opts.reconcile);
        seamMidReconcile();
      })();
    }
    this.lastReconcileAtMs = this.opts.now().getTime();
    bumpDataVersion("live");
  }

  /**
   * Post-ingest detector pass. Passes the ingestor's INJECTED clock (never
   * new Date()) so recommendation windows/ids are deterministic (NFR-107 /
   * Review F4). No-op unless the daemon wired the post-ingest hook.
   */
  private runPostIngest(): void {
    runPostIngestHook(this.db, this.opts.now());
    bumpDataVersion();
    this.lastDetectorPassAtMs = this.opts.now().getTime();
    this.ingestedSinceDetectorPass = false;
    this.mappingsSinceDetectorPass = false;
  }

  /** Tail one file from its stored offset and ingest the complete new lines. */
  ingestFile(filePath: string, projectSlug: string): void {
    this.upsertSubagentMetadata(filePath);
    let firstChunk = true;
    let parsedAny = false;
    for (;;) {
      const step = this.ingestFileChunk(
        filePath,
        projectSlug,
        DEFAULT_TAIL_CHUNK_BYTES,
        firstChunk,
      );
      firstChunk = false;
      parsedAny ||= step.parsed > 0;
      if (!step.hasMore) break;
    }
    if (parsedAny) {
      this.health.fileParsed();
      bootFileParsed(this.opts.now().getTime());
    }
  }

  /**
   * Chunk-bounded, event-loop-yielding variant of ingestFile. Each chunk runs
   * its own synchronous transaction (never held across a yield); the file's
   * version is re-checked between yields via the fresh stat in each chunk step.
   * P2-U4: passes run one at a time per Ingestor (slice and tail share the lock),
   * so one file is never in two passes at once. `sessions` = the sessions it touched.
   */
  ingestFileYielding(
    filePath: string,
    projectSlug: string,
    budgetBytes = DEFAULT_TAIL_CHUNK_BYTES,
  ): Promise<{ parsedAny: boolean; skipped: boolean; sessions: Set<string> }> {
    const run = () => this.ingestFilePass(filePath, projectSlug, budgetBytes);
    // An uncontended pass starts synchronously, as it did before the lock.
    const idle = this.passesQueued === 0;
    this.passesQueued++;
    const pass = (idle ? run() : this.passLock.then(run)).finally(() => {
      this.passesQueued--;
    });
    this.passLock = pass.catch(() => undefined);
    return pass;
  }

  private async ingestFilePass(
    filePath: string,
    projectSlug: string,
    budgetBytes: number,
  ): Promise<{ parsedAny: boolean; skipped: boolean; sessions: Set<string> }> {
    const sessions = new Set<string>();
    this.passSessions = sessions;
    try {
      return { ...(await this.ingestFileSteps(filePath, projectSlug, budgetBytes)), sessions };
    } finally {
      this.passSessions = null;
    }
  }

  private async ingestFileSteps(
    filePath: string,
    projectSlug: string,
    budgetBytes: number,
  ): Promise<{ parsedAny: boolean; skipped: boolean }> {
    let firstChunk = true;
    let parsedAny = false;
    let skipped = false;
    for (;;) {
      const gate = this.opts.writeGate?.();
      if (gate) await gate;
      if (firstChunk) this.upsertSubagentMetadata(filePath); // a write too: after the gate
      const step = this.ingestFileChunk(
        filePath,
        projectSlug,
        budgetBytes,
        firstChunk,
        testSeams.txBudgetMs ?? INGEST_TX_BUDGET_MS,
      );
      firstChunk = false;
      parsedAny ||= step.parsed > 0;
      skipped ||= step.skipped;
      if (!step.hasMore) break;
      // P2-U4a: a FULL loop turn between write transactions. One setImmediate
      // hop is not enough: when a step ran in the poll phase, the immediate
      // fires in the same iteration's check phase and timers never get a turn;
      // the second hop always lands after the next timers + poll phases.
      await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
    }
    if (parsedAny) this.health.fileParsed();
    // Boot files/s reflects scan THROUGHPUT (files visited), not just files with
    // new content — otherwise a warm restart, where almost nothing re-parses,
    // shows "— files/s" and starves the loading page's ETA. Harmless post-ready
    // (getBootProgress is only read pre-ready).
    bootFileParsed(this.opts.now().getTime());
    return { parsedAny, skipped };
  }

  private upsertSubagentMetadata(filePath: string): void {
    const meta = readSubagentMetadata(filePath);
    if (meta === null) return;
    const stored = this.stGetSubagentMeta.get(meta.agentId) as
      | {
          session_id: string | null;
          agent_type: string | null;
          tool_use_id: string | null;
          spawn_depth: number | null;
          description_len: number | null;
        }
      | undefined;
    // Re-read on every tail of a subagent file: an identical row is not a write.
    if (
      stored !== undefined &&
      stored.session_id === meta.sessionId &&
      stored.agent_type === meta.agentType &&
      stored.tool_use_id === meta.toolUseId &&
      stored.spawn_depth === meta.spawnDepth &&
      stored.description_len === meta.descriptionLen
    ) {
      return;
    }
    // The row has no timestamp: an in-place change can reach closed windows through the session's
    // turns. A new row normally lands before its subagent's turns (inserts the fingerprint counts),
    // so it does not bump; but a late meta.json re-labels turns already stored, so bump for those.
    if (stored !== undefined) {
      const session = this.stSessionStart.get(meta.sessionId) as
        | { first_turn_at: string | null }
        | undefined;
      if (session?.first_turn_at != null) this.touchRow(session.first_turn_at);
    } else {
      const firstTs = this.stAgentFirstTurn.get(meta.sessionId, meta.agentId) as string | null;
      if (firstTs != null) this.touchRow(firstTs);
    }
    this.stUpsertSubagentMeta.run(
      meta.agentId,
      meta.sessionId,
      meta.agentType,
      meta.toolUseId,
      meta.spawnDepth,
      meta.descriptionLen,
    );
  }

  /**
   * U-2: true only when both one-time backfills (legacy metric prefix and
   * classifier/boundary prefix) have already been seeded up to `offset`. Mirrors
   * the cheap early-out inside seedLegacyMetricPrefix / backfillClassifierAnd
   * BoundaryPrefix: a baseline row must exist AND cover the consumed prefix. Used
   * only to gate the persisted-version skip, so a file awaiting a post-upgrade
   * backfill is never skipped before that backfill runs. Two DB point-reads.
   */
  /**
   * P3-U7: an untracked file that repeats a tracked file's consumed prefix (a
   * copy or a rename) takes over that file's offset and both baselines in one
   * transaction, so the prefix is not re-read. Derived rows need no move: they
   * are keyed by message, and sessions keep their first path as a re-read would.
   */
  private carryOverSameContent(filePath: string, version: FileVersion): boolean {
    const match = findSameContent(this.db, filePath, version.size);
    if (match === null) return false;
    const metric = this.stGetMetricBaseline.get(match.filePath) as
      | { seeded_offset: number }
      | undefined;
    const classifier = this.stGetClassifierBaseline.get(
      classifierBaselinePathHash(match.filePath),
    ) as { seeded_offset: number } | undefined;
    this.db.transaction(() => {
      saveOffset(this.db, filePath, match.offset, headHash(filePath), version);
      if (metric !== undefined) {
        this.stSetMetricBaseline.run(filePath, Math.min(metric.seeded_offset, match.offset));
      }
      if (classifier !== undefined) {
        this.stSetClassifierBaseline.run(
          classifierBaselinePathHash(filePath),
          Math.min(classifier.seeded_offset, match.offset),
        );
      }
    })();
    return true;
  }

  private persistedPrefixFullyBackfilled(filePath: string, offset: number): boolean {
    const metric = this.stGetMetricBaseline.get(filePath) as { seeded_offset: number } | undefined;
    if (metric === undefined || metric.seeded_offset < offset) return false;
    const classifier = this.stGetClassifierBaseline.get(classifierBaselinePathHash(filePath)) as
      | { seeded_offset: number }
      | undefined;
    if (classifier === undefined || classifier.seeded_offset < offset) return false;
    return true;
  }

  /**
   * One bounded step of a file's catch-up: at most ~budgetBytes of complete
   * lines, cut short at the P2-U4a time budget, applied in ONE synchronous
   * transaction that also writes the offset
   * and both baselines (P0-U12); lineCursor advances only after it commits. Returns
   * hasMore=true when the caller should take another step (progress was made
   * and unread bytes remain).
   */
  private ingestFileChunk(
    filePath: string,
    projectSlug: string,
    budgetBytes: number,
    firstChunk: boolean,
    txBudgetMs = Number.POSITIVE_INFINITY,
  ): { hasMore: boolean; parsed: number; skipped: boolean } {
    // P2-U4a: the time budget runs from here, so the reads and checks before
    // the transaction count against it too (the whole step blocks the loop).
    const stepStart = performance.now();
    // Skip only when size, identity, and timestamps all match the version the
    // file was last FULLY caught up at (recorded below only when no unread
    // bytes remain, so a failed or partial pass is always retried). This keeps
    // the 2s tail tick from touching the DB for idle files while still noticing
    // same-size rewrites and path replacement.
    // Keep the per-file stat: directory mtimes only decide when to refresh paths;
    // they cannot safely replace append/rotation change detection for each file.
    let currentVersion: FileVersion;
    try {
      currentVersion = fileVersion(fs.statSync(filePath));
    } catch {
      // File vanished between discovery and tail.
      return { hasMore: false, parsed: 0, skipped: false };
    }
    const previousVersion = this.lastVersion.get(filePath);
    if (previousVersion !== undefined && sameFileVersion(previousVersion, currentVersion)) {
      bootFileSkipped();
      return { hasMore: false, parsed: 0, skipped: true };
    }

    const stored =
      loadOffset(this.db, filePath) ??
      (this.carryOverSameContent(filePath, currentVersion) ? loadOffset(this.db, filePath) : null);
    // U-2: skip idle files across a fresh process (empty in-memory lastVersion)
    // by consulting the PERSISTED state — but only when the file is genuinely
    // fully processed, matching what an in-memory lastVersion entry guarantees:
    // unchanged version, consumed to EOF, AND both one-time upgrade backfills
    // (legacy metric prefix, classifier/boundary prefix) already complete. A
    // version match alone is not enough — a file interrupted mid-catch-up, or
    // one still awaiting a post-upgrade backfill, must fall through and be
    // finished, not skipped.
    if (
      stored?.fileVersion &&
      sameFileVersion(stored.fileVersion, currentVersion) &&
      stored.offset >= currentVersion.size &&
      this.persistedPrefixFullyBackfilled(filePath, stored.offset)
    ) {
      if (stored.tailHash === null) backfillTailHash(this.db, filePath, stored.offset);
      this.lastVersion.set(filePath, currentVersion);
      bootFileSkipped();
      return { hasMore: false, parsed: 0, skipped: true };
    }

    if (firstChunk) this.health.fileSeen();
    registerWorkspace(this.db, projectSlug);

    const seeding = this.seedLegacyMetricPrefix(
      filePath,
      stored?.offset ?? null,
      currentVersion.size,
    );
    if (seeding.hasMore) {
      // Finish seeding with yields first.
      return { hasMore: true, parsed: 0, skipped: false };
    }
    // A same-size rewrite must be replayed by normal ingestion, not enriched
    // as if its new bytes were the previously-consumed prefix. Old 016 rows
    // lack a file version and are deliberately eligible for the one upgrade.
    // A file still growing across the 022 upgrade (stored offset < current size)
    // is append-only: its consumed prefix is byte-identical, so backfill it too
    // rather than leaving the pre-upgrade prefix NULL forever (M2).
    const classifierNeedsBackfill =
      stored !== null &&
      (stored.fileVersion === null ||
        sameFileVersion(stored.fileVersion, currentVersion) ||
        appendOnlyGrowth(stored.fileVersion, currentVersion));
    if (classifierNeedsBackfill) {
      const classifierSeeding = this.backfillClassifierAndBoundaryPrefix(
        filePath,
        stored.offset,
        currentVersion.size,
      );
      if (classifierSeeding.hasMore) {
        return { hasMore: true, parsed: 0, skipped: false };
      }
    }

    // Reuse a split chunk's rest only while the file is unchanged since it was
    // read and the committed offset is exactly where that rest begins.
    const cached = this.splitTail.get(filePath);
    this.splitTail.delete(filePath);
    const result =
      cached !== undefined &&
      stored !== null &&
      stored.offset === cached.offset &&
      stored.headHash === cached.result.newHeadHash &&
      sameFileVersion(cached.version, currentVersion)
        ? cached.result
        : tailFileChunk(filePath, stored, budgetBytes, currentVersion);
    // A time-sliced step (P2-U4a) records only the bytes it committed, below.
    if (result.lines.length === 0) {
      recordIngestBytes(Math.max(0, result.newOffset - (stored?.offset ?? 0)));
    }
    if (result.wasReset) this.lineCursor.set(filePath, 0);

    if (result.event === "OVERSIZED_LINE") {
      // Recoverable: the offset stays unadvanced. Record the version so the
      // tail tick does not re-attempt the capped framing until the file
      // changes; a change re-triggers the read and the line is retried.
      console.warn(
        `ingest: line exceeds the ${MAX_LINE_WARN_LABEL} cap in ${filePath}; offset held at ${result.newOffset}`,
      );
      this.lastVersion.set(filePath, currentVersion);
      return { hasMore: false, parsed: 0, skipped: false };
    }

    const startOffset = stored?.offset ?? 0;
    const progressed = result.wasReset || result.newOffset !== startOffset;

    if (result.lines.length === 0) {
      // P0-U12: offset and both baselines advance together or not at all.
      this.db.transaction(() => {
        if (
          stored === null ||
          stored.offset !== result.newOffset ||
          stored.headHash !== result.newHeadHash ||
          stored.fileVersion === null ||
          !sameFileVersion(stored.fileVersion, currentVersion)
        ) {
          saveOffset(this.db, filePath, result.newOffset, result.newHeadHash, currentVersion);
        }
        if (result.wasReset && stored !== null) countReset(this.db, filePath);
        this.stSetMetricBaseline.run(filePath, result.newOffset);
        this.stSetClassifierBaseline.run(classifierBaselinePathHash(filePath), result.newOffset);
      })();
      const hasMore = result.hasMore && progressed;
      if (!hasMore) this.lastVersion.set(filePath, currentVersion);
      return { hasMore, parsed: 0, skipped: false };
    }

    const defaultSessionId = sessionStemFor(filePath);
    const base = this.recoverLineCursor(filePath, result.wasReset ? 0 : startOffset);
    const versionSalt = result.newHeadHash;

    const stage: CorrelationStage = {
      toolUseOwner: new Map(),
      gitUseIds: new Set(),
      countedResults: new Set(),
      resultBytesByMsg: new Map(),
    };
    this.stage = stage;
    if (testSeams.crash !== null) seamBeforeChunk(filePath, result.lines.length);
    this.chunkTouchedSessions.clear();
    this.chunkModels.clear();
    // P2-U4a: on the yielding path the write transaction is time-sliced. Once
    // txBudgetMs is spent since stepStart (checked between lines, after at least one), the
    // lines applied so far commit with their own offset and the step returns
    // hasMore; the caller yields and the next step re-reads from that committed
    // offset. The sync path passes Infinity: splitting without a yield cannot
    // lower loop lag and would only add per-step cost.
    let applied = result.lines.length;
    let commitOffset = result.newOffset;
    // Half the budget at most goes to the tail estimate: one slow commit must not starve the lines.
    const lineBudgetMs = txBudgetMs - Math.min(this.stepTailMs, txBudgetMs / 2);
    let linesEnd = 0;
    try {
      const tx = this.db.transaction(() => {
        for (let i = 0; i < result.lines.length; i++) {
          const raw = result.lines[i];
          if (raw === undefined) continue;
          this.applyLine(
            raw,
            { defaultSessionId },
            projectSlug,
            filePath,
            base + i + 1,
            versionSalt,
          );
          if (testSeams.crash !== null) seamAfterLine(i, result.lines.length, raw.length);
          const lineEnd = result.lineEnds?.[i];
          if (
            lineEnd !== undefined &&
            i + 1 < result.lines.length &&
            performance.now() - stepStart >= lineBudgetMs
          ) {
            applied = i + 1;
            commitOffset = lineEnd;
            break;
          }
        }
        linesEnd = performance.now();
        // P0-U12: the durable progress markers commit atomically with the
        // chunk's rows, so a crash can never leave rows applied behind a stale
        // offset (which would replay the chunk on restart).
        saveOffset(this.db, filePath, commitOffset, result.newHeadHash, currentVersion);
        if (result.wasReset && stored !== null) countReset(this.db, filePath);
        this.stSetMetricBaseline.run(filePath, commitOffset);
        this.stSetClassifierBaseline.run(classifierBaselinePathHash(filePath), commitOffset);
        // Derived flags too: a session whose turns or boundary events this chunk
        // changed is recomputed here, so no commit leaves them stale (a restart
        // may skip the file and never recompute).
        for (const sessionId of this.chunkTouchedSessions) {
          recomputeCompactionBoundaries(this.db, sessionId, this.opts.now());
        }
        noteUnconfirmedModels(this.db, this.chunkModels, this.opts.now().toISOString());
      });
      this.inChunkTx = true;
      tx();
      this.stepTailMs = Math.max(performance.now() - linesEnd, this.stepTailMs * 0.9);
    } finally {
      this.stage = null;
      this.inChunkTx = false;
      this.gridPhase = undefined;
    }
    if (testSeams.crash !== null) seamAfterTx();
    recordIngestBytes(Math.max(0, commitOffset - (stored?.offset ?? 0)));
    bumpDataVersion("live");
    for (const sessionId of this.chunkTouchedSessions) this.passSessions?.add(sessionId);
    // The chunk transaction committed: only now fold staged correlation state
    // into the process-local maps. A throw above leaves both the DB and the
    // process-local maps at the previous chunk boundary.
    this.commitStage(stage);
    this.lineCursor.set(filePath, base + applied);
    if (applied < result.lines.length) {
      this.splitTail.set(filePath, {
        offset: commitOffset,
        version: currentVersion,
        result: {
          ...result,
          lines: result.lines.slice(applied),
          // A split needs lineEnds, so it is always present here.
          ...(result.lineEnds && { lineEnds: result.lineEnds.slice(applied) }),
          event: null,
          wasReset: false,
        },
      });
    }
    const hasMore = result.hasMore || applied < result.lines.length;
    if (!hasMore) this.lastVersion.set(filePath, currentVersion);
    return { hasMore, parsed: applied, skipped: false };
  }

  /**
   * The in-memory line cursor is lost on restart while the byte offset
   * persists; quarantine identity and display both use line numbers, so on a
   * cold resume recount the complete lines up to the resume offset (bounded
   * windows, one-time per file per process).
   */
  private recoverLineCursor(filePath: string, resumeOffset: number): number {
    const cached = this.lineCursor.get(filePath);
    if (cached !== undefined) return cached;
    if (resumeOffset <= 0) return 0;
    let count = 0;
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, "r");
      const window = Buffer.alloc(Math.min(DEFAULT_TAIL_CHUNK_BYTES, resumeOffset));
      let pos = 0;
      // Count only non-blank complete lines, mirroring tailFileChunk's
      // split+filter, so the recovered cursor matches in-process numbering
      // even when the file contains blank lines.
      let lineHasContent = false;
      while (pos < resumeOffset) {
        const want = Math.min(window.length, resumeOffset - pos);
        const got = fs.readSync(fd, window, 0, want, pos);
        if (got <= 0) break;
        for (let i = 0; i < got; i++) {
          if (window[i] === 0x0a) {
            if (lineHasContent) count++;
            lineHasContent = false;
          } else {
            lineHasContent = true;
          }
        }
        pos += got;
      }
    } catch {
      count = 0; // unreadable: fall back to a fresh cursor
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    this.lineCursor.set(filePath, count);
    return count;
  }

  /**
   * Upgrade bridge for offsets created before the metric-event ledger existed.
   * Already-consumed complete lines are registered without advancing counters.
   * Seeding is chunk-bounded and resumable: one bounded window per call, with
   * seeded_offset persisted at a line boundary in the same transaction, so a
   * restart resumes where it stopped. Ledger inserts are INSERT OR IGNORE, so
   * re-covering already-seeded bytes cannot double-register an event.
   */
  private seedLegacyMetricPrefix(
    filePath: string,
    storedOffset: number | null,
    currentSize: number,
  ): { hasMore: boolean } {
    const baseline = this.stGetMetricBaseline.get(filePath) as
      | { seeded_offset: number }
      | undefined;

    if (storedOffset === null || storedOffset <= 0 || storedOffset > currentSize) {
      if (baseline === undefined) this.stSetMetricBaseline.run(filePath, 0);
      return { hasMore: false };
    }
    const seededFrom = baseline?.seeded_offset ?? 0;
    if (baseline !== undefined && seededFrom >= storedOffset) return { hasMore: false };

    // One bounded window per call; grow it only to frame a single line with no
    // boundary inside the window, capped at MAX_TAIL_LINE_BYTES.
    let windowBytes = Math.min(DEFAULT_TAIL_CHUNK_BYTES, storedOffset - seededFrom);
    let buf: Buffer | undefined;
    let bytesRead = 0;
    let lastNl = -1;
    for (;;) {
      buf = Buffer.alloc(windowBytes);
      let fd: number | undefined;
      try {
        fd = fs.openSync(filePath, "r");
        bytesRead = fs.readSync(fd, buf, 0, windowBytes, seededFrom);
      } catch {
        return { hasMore: false }; // unreadable: leave seeding to a later pass
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      for (let i = bytesRead - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) {
          lastNl = i;
          break;
        }
      }
      const canGrow =
        lastNl === -1 &&
        windowBytes < storedOffset - seededFrom &&
        windowBytes < MAX_TAIL_LINE_BYTES;
      if (!canGrow) break;
      windowBytes = Math.min(windowBytes * 2, MAX_TAIL_LINE_BYTES, storedOffset - seededFrom);
    }

    if (lastNl === -1) {
      // No line boundary before the cap (or a prefix that does not end on one).
      // The prefix was already consumed historically; skip past this window so
      // seeding terminates. At most that single unframeable line is unregistered.
      const seededTo = seededFrom + bytesRead;
      console.warn(
        `ingest: legacy prefix of ${filePath} has no line boundary in a ${MAX_LINE_WARN_LABEL} window; skipping ahead`,
      );
      this.stSetMetricBaseline.run(filePath, seededTo);
      return { hasMore: seededTo < storedOffset };
    }

    const lines = buf.subarray(0, lastNl).toString("utf8").split("\n");
    const defaultSessionId = sessionStemFor(filePath);
    const seededTo = seededFrom + lastNl + 1;
    this.db.transaction(() => {
      for (const raw of lines) {
        if (raw.length === 0) continue;
        const proj = projectLine(raw, { defaultSessionId });
        if (proj.kind === "record") this.recordMetricEvent(raw, proj, false, 0);
      }
      this.stSetMetricBaseline.run(filePath, seededTo);
    })();
    bumpDataVersion("ingest");
    return { hasMore: seededTo < storedOffset };
  }

  /**
   * Migration 022's single guarded, resumable enrichment pass.  It consumes
   * exactly the historical prefix that offset tailing has already accepted and
   * fills both the U6 classifier columns and U7 boundary columns in one pass.
   * It never calls the ordinary aggregate path, so replay cannot change counts.
   */
  private backfillClassifierAndBoundaryPrefix(
    filePath: string,
    storedOffset: number | null,
    currentSize: number,
  ): { hasMore: boolean } {
    const baselineKey = classifierBaselinePathHash(filePath);
    const baseline = this.stGetClassifierBaseline.get(baselineKey) as
      | { seeded_offset: number }
      | undefined;
    if (storedOffset === null || storedOffset <= 0 || storedOffset > currentSize) {
      if (baseline === undefined) this.stSetClassifierBaseline.run(baselineKey, 0);
      return { hasMore: false };
    }
    const seededFrom = baseline?.seeded_offset ?? 0;
    if (baseline !== undefined && seededFrom >= storedOffset) return { hasMore: false };

    let windowBytes = Math.min(DEFAULT_TAIL_CHUNK_BYTES, storedOffset - seededFrom);
    let buf: Buffer | undefined;
    let bytesRead = 0;
    let lastNl = -1;
    for (;;) {
      buf = Buffer.alloc(windowBytes);
      let fd: number | undefined;
      try {
        fd = fs.openSync(filePath, "r");
        bytesRead = fs.readSync(fd, buf, 0, windowBytes, seededFrom);
      } catch {
        return { hasMore: false };
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      for (let i = bytesRead - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) {
          lastNl = i;
          break;
        }
      }
      if (
        lastNl !== -1 ||
        windowBytes >= storedOffset - seededFrom ||
        windowBytes >= MAX_TAIL_LINE_BYTES
      )
        break;
      windowBytes = Math.min(windowBytes * 2, MAX_TAIL_LINE_BYTES, storedOffset - seededFrom);
    }
    if (lastNl === -1) {
      const seededTo = seededFrom + bytesRead;
      this.stSetClassifierBaseline.run(baselineKey, seededTo);
      return { hasMore: seededTo < storedOffset };
    }

    const lines = (buf as Buffer).subarray(0, lastNl).toString("utf8").split("\n");
    const lineBase = this.countCompleteLinesBefore(filePath, seededFrom);
    const defaultSessionId = sessionStemFor(filePath);
    const seededTo = seededFrom + lastNl + 1;
    this.db.transaction(() => {
      let position = lineBase;
      for (const raw of lines) {
        if (raw.length === 0) continue;
        position++;
        const proj = projectLine(raw, { defaultSessionId });
        if (proj.kind === "record") this.recordMetricEvent(raw, proj, false, position);
      }
      this.stSetClassifierBaseline.run(baselineKey, seededTo);
    })();
    bumpDataVersion("ingest");
    return { hasMore: seededTo < storedOffset };
  }

  /** Count non-empty complete JSONL lines without mutating the live tail cursor. */
  private countCompleteLinesBefore(filePath: string, endOffset: number): number {
    if (endOffset <= 0) return 0;
    let count = 0;
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, "r");
      const window = Buffer.alloc(Math.min(DEFAULT_TAIL_CHUNK_BYTES, endOffset));
      let pos = 0;
      let lineHasContent = false;
      while (pos < endOffset) {
        const got = fs.readSync(fd, window, 0, Math.min(window.length, endOffset - pos), pos);
        if (got <= 0) break;
        for (let i = 0; i < got; i++) {
          if (window[i] === 0x0a) {
            if (lineHasContent) count++;
            lineHasContent = false;
          } else lineHasContent = true;
        }
        pos += got;
      }
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return count;
  }

  private applyLine(
    raw: string,
    ctx: { defaultSessionId: string },
    workspaceId: string,
    filePath: string,
    lineNo: number,
    versionSalt: string,
  ): void {
    const proj = projectLine(raw, ctx);

    if (proj.kind === "quarantine") {
      this.quarantine(filePath, lineNo, proj.errorClass, versionSalt);
      return;
    }

    this.health.unknownFields(proj.unknownFields);

    if (proj.cwd !== null) {
      this.stSetDiscoveredCwd.run(proj.cwd, workspaceId);
    }

    // A session row must exist before any session-scoped FK insert (tool_events,
    // commands, turns). Resolve the line's session + a timestamp and ensure it.
    const hasMetricRecord =
      proj.isUserTurn ||
      proj.isCompactSummary ||
      proj.isApiErrorMessage ||
      proj.isInterrupt ||
      proj.classifierLabel !== null ||
      proj.commandShape !== null ||
      proj.destructiveOp !== null ||
      proj.ccVersion !== null ||
      proj.boundaryKind !== null;
    const lineSessionId = proj.isUserTurn
      ? proj.sessionId
      : (proj.turn?.sessionId ??
        proj.command?.sessionId ??
        proj.toolEvents[0]?.sessionId ??
        (hasMetricRecord || proj.title !== null ? proj.sessionId : null));
    const lineTs = proj.turn?.ts ?? proj.command?.ts ?? proj.toolEvents[0]?.ts ?? proj.ts ?? "";
    if (lineSessionId !== null) {
      this.ensureSession(lineSessionId, workspaceId, filePath, lineTs === "" ? null : lineTs);
      this.chunkTouchedSessions.add(lineSessionId);
    }
    if (proj.title !== null) {
      this.stSetSessionTitle.run(
        proj.title.value,
        proj.title.source,
        proj.sessionId,
        proj.title.source,
      );
    }

    // User/friction aggregates advance only for a structurally new source record.
    // The persisted digest makes replay idempotent across restarts and files.
    this.recordMetricEvent(raw, proj, true, lineNo);

    // Command markers → tool_events(local_command) for hygiene evaluation.
    if (proj.command !== null) {
      this.recordCommand(proj.command);
    }

    // Tool-use blocks → tool_events; remember owner + git hint for correlation.
    for (const te of proj.toolEvents) {
      this.insertToolEvent(te);
      if (te.toolUseId !== null) {
        if (te.ownerMessageId !== null) this.stagedOwnerSet(te.toolUseId, te.ownerMessageId);
        if (te.gitCommandHint) this.stagedGitAdd(te.toolUseId);
      }
    }

    // Tool-result blocks → attach bytes to owning turn; harvest git commit SHAs.
    for (const tr of proj.toolResults) {
      this.applyToolResult(
        tr.toolUseId,
        tr.resultBytes,
        tr.commitSha,
        tr.isError,
        tr.errorClass,
        tr.interruptKind,
        tr.errorSlice,
      );
    }

    if (proj.synthetic) {
      this.health.synthetic();
      return;
    }
    if (proj.turn === null) return;

    this.writeTurn(
      proj.turn,
      workspaceId,
      proj.turn.isSidechain ? agentIdForTranscript(filePath) : null,
    );
  }

  /** INSERT OR IGNORE a session row so FK-bearing child rows can be written. */
  private ensureSession(
    sessionId: string,
    workspaceId: string,
    filePath: string,
    ts: string | null,
  ): void {
    const res = this.stInsertSession.run(sessionId, workspaceId, filePath, ts, ts);
    if (res.changes === 1) bootSessionFound();
  }

  private writeTurn(turn: TurnProjection, workspaceId: string, agentId: string | null): void {
    this.chunkModels.add(turn.model);
    const priced = this.pricing.price(turn.model, {
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheWrite5m: turn.cacheWrite5m,
      cacheWrite1h: turn.cacheWrite1h,
      cacheWriteOther: turn.cacheWriteOther,
    });

    // is_compaction_boundary is set to 0 on insert; recomputeCompactionBoundaries
    // (called inside each chunk tx) uses timestamp order across all files
    // to set the correct flags, replacing the old position-based approach.
    const res = this.stInsertTurn.run(
      turn.messageId,
      turn.sessionId,
      workspaceId,
      turn.ts,
      turn.model,
      turn.isSidechain ? 1 : 0,
      turn.inputTokens,
      turn.outputTokens,
      turn.thinkingTokens,
      turn.cacheReadTokens,
      turn.cacheWrite5m,
      turn.cacheWrite1h,
      turn.cacheWriteOther,
      null, // tool_result_bytes filled by correlation
      priced.snapshotId,
      priced.costU,
      priced.claim,
      1, // provisional until reconciled
      turn.effort,
      PARSER_VERSION,
      0, // is_compaction_boundary — set by recomputeCompactionBoundaries in the chunk tx
      agentId,
    );

    if (res.changes === 0) {
      // Duplicate message_id — a true no-op for aggregates.
      this.health.duplicateDrop();
      return;
    }

    // New turn: the session is already ensured; advance its aggregates.
    this.stBumpSession.run(priced.costU ?? 0, turn.ts, turn.ts, turn.ts, turn.ts, turn.sessionId);
    this.health.turnIngested(PARSER_VERSION);
    bootTokensCounted(
      turn.inputTokens +
        turn.outputTokens +
        (turn.thinkingTokens ?? 0) +
        turn.cacheReadTokens +
        turn.cacheWrite5m +
        turn.cacheWrite1h +
        turn.cacheWriteOther,
    );

    // If tool_result bytes already accumulated for this turn (results seen first
    // is impossible within a file, but the owner map may hold late updates).
    const bytes = this.stagedResultBytesGet(turn.messageId);
    if (bytes !== undefined) this.stSetResultBytes.run(bytes, turn.messageId);
  }

  private insertToolEvent(te: {
    eventId: string;
    sessionId: string;
    ts: string;
    toolName: string;
    inputBytes: number | null;
    inputHash: string | null;
    filePathHash: string | null;
    editOldStringHash: string | null;
    editNewStringHash: string | null;
    ownerMessageId: string | null;
    blockIndex: number;
    testCommandHint: boolean;
    bashCommandFamily: string | null;
    commandSlice: string | null;
    skillName: string | null;
  }): void {
    // The upsert (and the metadata, skill and content upserts below) rewrites an existing row on a replay.
    this.touchExistingToolEvent(te.eventId, te.ts);
    this.stInsertToolEvent.run(
      te.eventId,
      te.sessionId,
      te.ts,
      te.toolName,
      te.inputBytes,
      null, // result_bytes filled on correlation
      te.inputHash,
      null, // exit_class
      null, // commit_sha filled on correlation
      te.bashCommandFamily,
    );
    this.stUpsertToolEventMetadata.run(
      te.eventId,
      te.filePathHash,
      te.ownerMessageId,
      te.blockIndex,
      te.testCommandHint ? 1 : 0,
      te.editOldStringHash,
      te.editNewStringHash,
    );
    if (te.skillName !== null) this.stUpsertToolEventSkill.run(te.eventId, te.skillName);
    // SEC-101 W-A: retain the secrets-filtered command slice for C5/D7.
    if (te.commandSlice !== null) {
      this.stUpsertContentCommand.run(te.eventId, te.commandSlice, te.eventId, te.commandSlice);
    }
  }

  private applyToolResult(
    toolUseId: string | null,
    resultBytes: number,
    commitSha: string | null,
    isError: boolean,
    errorClass: import("./tool-error-classifier.js").ToolErrorClass | null,
    interruptKind: import("./tool-error-classifier.js").InterruptKind | null,
    errorSlice: string | null,
  ): void {
    if (toolUseId === null) return;
    // SEC-101 W-A: retain the secrets-filtered error excerpt for C5/D7. Guarded
    // by EXISTS in the statement, so a result before its tool_use is a no-op.
    if (errorSlice !== null) {
      this.stUpsertContentError.run(toolUseId, errorSlice, toolUseId, errorSlice);
    }
    // Always enrich the event row, including after a restart or deliberate operator
    // re-scan. Persisted structural metadata is authoritative for TEST_FAIL.
    const updated = this.stSetToolResult.get(resultBytes, isError ? 1 : 0, toolUseId) as
      | { ts: string }
      | undefined;
    // A result can arrive after its tool_use's window closed. The rows it rewrites (the event, its
    // content, its owner turn) carry the tool_use's timestamp, not this line's.
    if (updated !== undefined) this.touchRow(updated.ts);
    this.stSetToolErrorClassification.run(
      errorClass,
      errorClass === null ? null : TOOL_ERROR_CLASSIFIER_VERSION,
      interruptKind,
      interruptKind === null ? null : INTERRUPT_CLASSIFIER_VERSION,
      toolUseId,
    );
    // Persisted ownership is also authoritative: a result can arrive after a
    // daemon restart, when the process-local toolUseOwner map is empty.
    this.stRefreshOwnerResultBytes.run(toolUseId);

    if (this.stagedCountedHas(toolUseId)) return; // turn aggregate stays idempotent
    this.stagedCountedAdd(toolUseId);

    const owner = this.stagedOwnerGet(toolUseId);
    if (owner !== undefined) {
      const next = (this.stagedResultBytesGet(owner) ?? 0) + resultBytes;
      this.stagedResultBytesSet(owner, next);
      this.stSetResultBytes.run(next, owner);
    }
    // Persist a commit SHA only for tool_uses that looked like git commit/push.
    if (commitSha !== null && this.stagedGitHas(toolUseId)) {
      this.stSetCommitSha.run(commitSha, toolUseId);
    }
  }

  private recordCommand(command: CommandProjection): void {
    this.touchExistingToolEvent(command.eventId, command.ts);
    this.stInsertToolEvent.run(
      command.eventId,
      command.sessionId,
      command.ts,
      "local_command",
      null,
      null,
      command.command,
      null,
      null,
      null,
    );
  }

  private recordMetricEvent(
    raw: string,
    proj: Extract<ReturnType<typeof projectLine>, { kind: "record" }>,
    applyAggregates: boolean,
    position: number,
  ): void {
    if (
      !proj.isUserTurn &&
      !proj.isCompactSummary &&
      !proj.isApiErrorMessage &&
      !proj.isInterrupt &&
      proj.classifierLabel === null &&
      proj.commandShape === null &&
      proj.destructiveOp === null &&
      proj.ccVersion === null &&
      proj.boundaryKind === null &&
      proj.turn === null
    ) {
      return;
    }
    const eventId = metricEventId(raw, proj);
    const validUserTs =
      proj.isUserTurn && typeof proj.ts === "string" && Number.isFinite(Date.parse(proj.ts))
        ? proj.ts
        : null;
    let boundaryKind = proj.boundaryKind;
    let boundaryVerification = proj.boundaryVerification;
    // A collapse can locate a possible automatic boundary, but ADV-2 forbids
    // treating it as corroborated. Later M(N) consumers must use the floor.
    if (boundaryKind === null && proj.turn !== null) {
      const previous = this.stGetPreviousCacheRead.get(proj.sessionId, proj.turn.ts) as
        | { cache_read_tokens: number }
        | undefined;
      if (
        previous !== undefined &&
        previous.cache_read_tokens >= 1_000 &&
        proj.turn.cacheReadTokens * 4 <= previous.cache_read_tokens
      ) {
        boundaryKind = "cache-read-collapse";
        boundaryVerification = "UNVERIFIED";
      }
    }
    const metricValues = [
      eventId,
      proj.sessionId,
      validUserTs,
      proj.isUserTurn ? 1 : 0,
      proj.isCompactSummary ? 1 : 0,
      proj.isApiErrorMessage ? 1 : 0,
      proj.isInterrupt ? 1 : 0,
      proj.classifierLabel,
      proj.commandShape,
      proj.destructiveOp,
      boundedVersion(proj.ccVersion),
      // classifier_version column only (M3) — do NOT use PARSER_VERSION here;
      // keeping them separate stops the classifier layer from shifting the turns
      // parser mix and confounding effect cycles. See types.ts.
      CLASSIFIER_VERSION,
      strictUtcTimestamp(proj.ts),
      position,
      boundaryKind,
      boundaryVerification,
      proj.isSidechain ? 1 : 0,
    ];
    const inserted = this.stInsertMetricEvent.run(...metricValues);
    // Existing 017 ledger rows are enriched without changing its original
    // insert-result contract, which keeps aggregate replay idempotent.
    if (inserted.changes === 0) {
      this.touchRow(strictUtcTimestamp(proj.ts));
      this.stEnrichMetricEvent.run(
        proj.classifierLabel,
        proj.commandShape,
        proj.destructiveOp,
        boundedVersion(proj.ccVersion),
        CLASSIFIER_VERSION, // classifier_version column only (M3) — see types.ts / insert site above
        strictUtcTimestamp(proj.ts),
        position,
        boundaryKind,
        boundaryVerification,
        proj.isSidechain ? 1 : 0,
        eventId,
      );
    }
    if (!applyAggregates || inserted.changes === 0) return;

    if (proj.isUserTurn) this.stBumpUserTurnCount.run(proj.sessionId);
    const previous = this.stPreviousBoundaryKind.get(proj.sessionId, position) as
      | { boundary_kind: string | null }
      | undefined;
    const isNewCompaction =
      proj.boundaryKind === "compact-boundary" ||
      (proj.isCompactSummary && previous?.boundary_kind !== "compact-boundary");
    if (isNewCompaction || proj.isApiErrorMessage || proj.isInterrupt) {
      this.stBumpFrictionCounts.run(
        isNewCompaction ? 1 : 0,
        proj.isApiErrorMessage ? 1 : 0,
        proj.isInterrupt ? 1 : 0,
        proj.sessionId,
      );
    }
    if (validUserTs !== null) this.applyGapAggregates(proj.sessionId);
  }

  private applyGapAggregates(sessionId: string): void {
    const rows = this.stGetMetricTimestamps.all(sessionId) as Array<{ user_turn_ts: string }>;
    const sorted = rows
      .map((row) => Date.parse(row.user_turn_ts))
      .filter((epochMs) => Number.isFinite(epochMs))
      .sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(((sorted[i] as number) - (sorted[i - 1] as number)) / 1000);
    }
    const gapN = gaps.length;
    const stored = this.stGetGapN.get(sessionId) as { gap_n: number } | undefined;
    // During the 017 upgrade, a session's legacy timestamps can be spread across
    // files that have not all established their metric-ledger baselines yet.
    // Preserve the richer legacy aggregate until the ledger has caught up.
    if (stored !== undefined && gapN < stored.gap_n) return;
    if (gapN === 0) {
      this.stSetGapAggregates.run(null, null, 0, 0, sessionId);
      return;
    }
    // The persisted event ledger supplies the complete known history across
    // restarts and source files, so this aggregate can be recomputed deterministically.
    const g = [...gaps].sort((a, b) => a - b);
    const mid = g.length;
    const gapMedianS =
      mid % 2 === 1
        ? (g[Math.floor(mid / 2)] as number)
        : ((g[mid / 2 - 1] as number) + (g[mid / 2] as number)) / 2;
    const p90Idx = Math.min(Math.ceil(0.9 * g.length) - 1, g.length - 1);
    const gapP90S = g[Math.max(0, p90Idx)] as number;
    const longGapCount = g.filter((x) => x > LONG_GAP_THRESHOLD_S).length;
    this.stSetGapAggregates.run(gapMedianS, gapP90S, longGapCount, gapN, sessionId);
  }

  /**
   * Quarantine identity includes the file version's width-prefixed head hash so
   * a rotated file (new content, same path) cannot silently reuse a prior
   * version's quarantine ID, while a faithful re-scan of the SAME version
   * (truncation reset, restart) still dedupes. Line numbers stay durable across
   * restarts via recoverLineCursor. Pre-existing rows keep their historic IDs
   * and are never rewritten.
   */
  private quarantine(
    filePath: string,
    lineNo: number,
    errorClass: string,
    versionSalt: string,
  ): void {
    const qId = crypto
      .createHash("sha1")
      .update(`${filePath}|${lineNo}|${errorClass}|${versionSalt}`)
      .digest("hex")
      .slice(0, 24);
    this.stInsertQuarantine.run(
      qId,
      filePath,
      lineNo,
      errorClass,
      PARSER_VERSION,
      this.opts.now().toISOString(),
    );
    this.health.quarantined();
  }
}
