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
import type { Db } from "../db/open.js";
import { runPostIngestHook } from "./detector-hook.js";
import {
  createDiscoveryCache,
  refreshDiscoveryCache,
  registerWorkspace,
  sessionStemFor,
} from "./discovery.js";
import { Health } from "./health.js";
import { PARSER_VERSION, projectLine } from "./parser.js";
import { PricingSnapshotStore, seedListPrices } from "./pricing.js";
import {
  DEFAULT_RECONCILE_OPTIONS,
  type ReconcileOptions,
  reconcileSessions,
} from "./reconcile.js";
import {
  DEFAULT_TAIL_CHUNK_BYTES,
  type FileVersion,
  MAX_TAIL_LINE_BYTES,
  fileVersion,
  loadOffset,
  sameFileVersion,
  saveOffset,
  tailFileChunk,
} from "./tail.js";
import type { CommandProjection, HealthCounters, TurnProjection } from "./types.js";
import { LONG_GAP_THRESHOLD_S } from "./types.js";
import {
  backfillDiscoveredCwd,
  defaultReadCwd,
  defaultReadRemote,
  resolveWorkspaceMappings,
} from "./workspace-mapping.js";

export interface IngestorOptions {
  activityWindowSecs: number;
  reconcile: ReconcileOptions;
  tailIntervalMs: number;
  discoveryIntervalMs: number;
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
  /** Injectable clock (ISO string) for deterministic tests. */
  now: () => Date;
  onNewMappings?: (count: number) => void;
  readRemote?: (path: string) => string | null;
}

export const DEFAULT_INGESTOR_OPTIONS: IngestorOptions = {
  activityWindowSecs: 5 * 60,
  reconcile: DEFAULT_RECONCILE_OPTIONS,
  tailIntervalMs: 2_000,
  discoveryIntervalMs: 30_000,
  reconcileIdleFloorMs: 60_000,
  detectorIdleFloorMs: 5 * 60_000,
  now: () => new Date(),
};

const INITIAL_SCAN_BATCH_SIZE = 100;
const MAX_LINE_WARN_LABEL = `${MAX_TAIL_LINE_BYTES / (1024 * 1024)} MiB`;

interface CorrelationStage {
  toolUseOwner: Map<string, string>;
  gitUseIds: Set<string>;
  countedResults: Set<string>;
  resultBytesByMsg: Map<string, number>;
}

export interface TailHandle {
  stop(): void;
}

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
  private readonly discoveryCache = createDiscoveryCache();
  private readonly unresolvedRemotes = new Set<string>();

  // Idle-gating state (PERF5): timestamps of the last reconcile / detector
  // pass, and whether any lines were parsed since the last detector pass.
  private lastReconcileAtMs = 0;
  private lastDetectorPassAtMs = 0;
  private ingestedSinceDetectorPass = false;

  // Prepared statements.
  private readonly stInsertTurn;
  private readonly stInsertSession;
  private readonly stBumpSession;
  private readonly stBumpUserTurnCount;
  private readonly stBumpFrictionCounts;
  private readonly stSetGapAggregates;
  private readonly stInsertMetricEvent;
  private readonly stGetMetricTimestamps;
  private readonly stGetGapN;
  private readonly stGetMetricBaseline;
  private readonly stSetMetricBaseline;
  private readonly stInsertToolEvent;
  private readonly stUpsertToolEventMetadata;
  private readonly stSetToolResult;
  private readonly stRefreshOwnerResultBytes;
  private readonly stSetResultBytes;
  private readonly stSetCommitSha;
  private readonly stInsertQuarantine;
  private readonly stSetDiscoveredCwd;

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
          provisional, effort, parser_version)
       VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?,?,?)`,
    );
    this.stInsertSession = db.prepare(
      `INSERT OR IGNORE INTO sessions
         (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
          state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?,?,?,?,?,'LIVE',0,0,'[]')`,
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
          is_compact_summary, is_api_error, is_interrupt)
       VALUES (?,?,?,?,?,?,?)`,
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
    this.stInsertToolEvent = db.prepare(
      `INSERT INTO tool_events
         (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash, exit_class, commit_sha)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET
         input_bytes = COALESCE(tool_events.input_bytes, excluded.input_bytes),
         input_hash = COALESCE(tool_events.input_hash, excluded.input_hash)`,
    );
    this.stUpsertToolEventMetadata = db.prepare(
      `INSERT INTO tool_event_metadata
         (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
       VALUES (?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET
         file_path_hash = COALESCE(tool_event_metadata.file_path_hash, excluded.file_path_hash),
         owner_message_id = COALESCE(tool_event_metadata.owner_message_id, excluded.owner_message_id),
         block_index = excluded.block_index,
         is_test_command = excluded.is_test_command`,
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
       WHERE event_id = ?`,
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
    await this.ingestAllKnownBatched(batchSize);
    this.reconcileNow();
    this.runPostIngest();

    return this.startTailTimers();
  }

  private startTailTimers(): TailHandle {
    let busy = false;
    let stopped = false;

    // Fast tail cadence: advance byte offsets on every known file, then
    // reconcile. Ingestion is chunk-bounded and yields between chunks; the
    // busy guard is released only when the whole async pass settles, so ticks
    // never overlap a still-running pass. A tick that parsed nothing skips
    // reconcile until the idle floor elapses (PERF5): with a zero ingest
    // delta, reconcile output only moves on activity-window decay, which the
    // floor observes well within activityWindowSecs.
    const tailTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        try {
          let parsedAny = false;
          for (const f of refreshDiscoveryCache(this.roots, this.discoveryCache)) {
            if (stopped) return; // stop() during a suspended pass: quit at a file boundary
            parsedAny = (await this.ingestFileYielding(f.filePath, f.projectSlug)) || parsedAny;
          }
          if (parsedAny) this.ingestedSinceDetectorPass = true;
          const reconcileDue =
            parsedAny ||
            this.opts.now().getTime() - this.lastReconcileAtMs >= this.opts.reconcileIdleFloorMs;
          if (!stopped && reconcileDue) this.reconcileNow();
        } catch (e) {
          console.warn(`tail tick failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          busy = false;
        }
      })();
    }, this.opts.tailIntervalMs);

    // Slower discovery cadence: register any newly-appeared workspace slugs, then
    // run a full detector pass (30s freshness matches the recommendations surface;
    // a pass on every 2s tail tick would be wasteful).
    const discoveryTimer = setInterval(() => {
      try {
        const discovered = refreshDiscoveryCache(this.roots, this.discoveryCache, true);
        for (const f of discovered) registerWorkspace(this.db, f.projectSlug);
        backfillDiscoveredCwd(this.db, discovered, defaultReadCwd);
        const newlyMapped = resolveWorkspaceMappings(this.db, {
          readRemote: this.opts.readRemote ?? defaultReadRemote,
          unresolved: this.unresolvedRemotes,
        });
        // Change-gated detector pass (PERF5): detector inputs are ingest-derived,
        // so a pass with no new parsed lines and no new mappings recomputes the
        // same data; the idle floor bounds staleness of pure time-window edges.
        const detectorsDue =
          newlyMapped > 0 ||
          this.ingestedSinceDetectorPass ||
          this.opts.now().getTime() - this.lastDetectorPassAtMs >= this.opts.detectorIdleFloorMs;
        if (detectorsDue) this.runPostIngest();
        if (newlyMapped > 0 && this.opts.onNewMappings !== undefined) {
          try {
            this.opts.onNewMappings(newlyMapped);
          } catch (e) {
            console.warn(
              `new mappings callback failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      } catch (e) {
        console.warn(`discovery tick failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, this.opts.discoveryIntervalMs);

    return {
      stop: () => {
        stopped = true;
        clearInterval(tailTimer);
        clearInterval(discoveryTimer);
      },
    };
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

  private async ingestAllKnownBatched(batchSize: number): Promise<void> {
    const files = refreshDiscoveryCache(this.roots, this.discoveryCache, true);
    const normalizedBatchSize =
      Number.isFinite(batchSize) && batchSize >= 1
        ? Math.max(1, Math.floor(batchSize))
        : INITIAL_SCAN_BATCH_SIZE;

    for (let start = 0; start < files.length; start += normalizedBatchSize) {
      const end = Math.min(start + normalizedBatchSize, files.length);
      for (let i = start; i < end; i++) {
        const f = files[i];
        if (f === undefined) continue;
        // Yields between chunks WITHIN a large file, on top of the batch yield.
        await this.ingestFileYielding(f.filePath, f.projectSlug);
      }
      if (end < files.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  private reconcileNow(): void {
    const cutoff = new Date(this.opts.now().getTime() - this.opts.activityWindowSecs * 1000);
    reconcileSessions(this.db, cutoff.toISOString(), this.opts.reconcile);
    this.lastReconcileAtMs = this.opts.now().getTime();
  }

  /**
   * Post-ingest detector pass. Passes the ingestor's INJECTED clock (never
   * new Date()) so recommendation windows/ids are deterministic (NFR-107 /
   * Review F4). No-op unless the daemon wired the post-ingest hook.
   */
  private runPostIngest(): void {
    runPostIngestHook(this.db, this.opts.now());
    this.lastDetectorPassAtMs = this.opts.now().getTime();
    this.ingestedSinceDetectorPass = false;
  }

  /** Tail one file from its stored offset and ingest the complete new lines. */
  ingestFile(filePath: string, projectSlug: string): void {
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
    if (parsedAny) this.health.fileParsed();
  }

  /**
   * Chunk-bounded, event-loop-yielding variant of ingestFile. Each chunk runs
   * its own synchronous transaction (never held across a yield); the file's
   * version is re-checked between yields via the fresh stat in each chunk step.
   */
  async ingestFileYielding(
    filePath: string,
    projectSlug: string,
    budgetBytes = DEFAULT_TAIL_CHUNK_BYTES,
  ): Promise<boolean> {
    let firstChunk = true;
    let parsedAny = false;
    for (;;) {
      const step = this.ingestFileChunk(filePath, projectSlug, budgetBytes, firstChunk);
      firstChunk = false;
      parsedAny ||= step.parsed > 0;
      if (!step.hasMore) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (parsedAny) this.health.fileParsed();
    return parsedAny;
  }

  /**
   * One bounded step of a file's catch-up: at most ~budgetBytes of complete
   * lines applied in ONE synchronous transaction, with offset/lineCursor/
   * metric-baseline advanced only after that transaction commits. Returns
   * hasMore=true when the caller should take another step (progress was made
   * and unread bytes remain).
   */
  private ingestFileChunk(
    filePath: string,
    projectSlug: string,
    budgetBytes: number,
    firstChunk: boolean,
  ): { hasMore: boolean; parsed: number } {
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
      return { hasMore: false, parsed: 0 }; // file vanished between discovery and tail
    }
    const previousVersion = this.lastVersion.get(filePath);
    if (previousVersion !== undefined && sameFileVersion(previousVersion, currentVersion)) {
      return { hasMore: false, parsed: 0 };
    }

    if (firstChunk) this.health.fileSeen();
    registerWorkspace(this.db, projectSlug);

    const stored = loadOffset(this.db, filePath);
    const seeding = this.seedLegacyMetricPrefix(
      filePath,
      stored?.offset ?? null,
      currentVersion.size,
    );
    if (seeding.hasMore) return { hasMore: true, parsed: 0 }; // finish seeding (with yields) first

    const result = tailFileChunk(filePath, stored, budgetBytes, currentVersion);
    if (result.wasReset) this.lineCursor.set(filePath, 0);

    if (result.event === "OVERSIZED_LINE") {
      // Recoverable: the offset stays unadvanced. Record the version so the
      // tail tick does not re-attempt the capped framing until the file
      // changes; a change re-triggers the read and the line is retried.
      console.warn(
        `ingest: line exceeds the ${MAX_LINE_WARN_LABEL} cap in ${filePath}; offset held at ${result.newOffset}`,
      );
      this.lastVersion.set(filePath, currentVersion);
      return { hasMore: false, parsed: 0 };
    }

    const startOffset = stored?.offset ?? 0;
    const progressed = result.wasReset || result.newOffset !== startOffset;

    if (result.lines.length === 0) {
      if (
        stored === null ||
        stored.offset !== result.newOffset ||
        stored.headHash !== result.newHeadHash ||
        stored.fileVersion === null ||
        !sameFileVersion(stored.fileVersion, currentVersion)
      ) {
        saveOffset(this.db, filePath, result.newOffset, result.newHeadHash, currentVersion);
      }
      this.stSetMetricBaseline.run(filePath, result.newOffset);
      const hasMore = result.hasMore && progressed;
      if (!hasMore) this.lastVersion.set(filePath, currentVersion);
      return { hasMore, parsed: 0 };
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
        }
      });
      tx();
    } finally {
      this.stage = null;
    }
    // The chunk transaction committed: only now fold staged correlation state
    // in and advance the durable progress markers. A throw above leaves both
    // the DB and the process-local maps at the previous chunk boundary.
    this.commitStage(stage);
    this.lineCursor.set(filePath, base + result.lines.length);
    saveOffset(this.db, filePath, result.newOffset, result.newHeadHash, currentVersion);
    this.stSetMetricBaseline.run(filePath, result.newOffset);
    if (!result.hasMore) this.lastVersion.set(filePath, currentVersion);
    return { hasMore: result.hasMore, parsed: result.lines.length };
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
        if (proj.kind === "record") this.recordMetricEvent(raw, proj, false);
      }
      this.stSetMetricBaseline.run(filePath, seededTo);
    })();
    return { hasMore: seededTo < storedOffset };
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
    const lineSessionId = proj.isUserTurn
      ? proj.sessionId
      : (proj.turn?.sessionId ?? proj.command?.sessionId ?? proj.toolEvents[0]?.sessionId ?? null);
    const lineTs = proj.turn?.ts ?? proj.command?.ts ?? proj.toolEvents[0]?.ts ?? "";
    if (lineSessionId !== null) {
      this.ensureSession(lineSessionId, workspaceId, filePath, lineTs === "" ? null : lineTs);
    }

    if (
      lineSessionId === null &&
      (proj.isCompactSummary || proj.isApiErrorMessage || proj.isInterrupt)
    ) {
      this.ensureSession(proj.sessionId, workspaceId, filePath, null);
    }

    // User/friction aggregates advance only for a structurally new source record.
    // The persisted digest makes replay idempotent across restarts and files.
    this.recordMetricEvent(raw, proj, true);

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
      this.applyToolResult(tr.toolUseId, tr.resultBytes, tr.commitSha, tr.isError);
    }

    if (proj.synthetic) {
      this.health.synthetic();
      return;
    }
    if (proj.turn === null) return;

    this.writeTurn(proj.turn, workspaceId);
  }

  /** INSERT OR IGNORE a session row so FK-bearing child rows can be written. */
  private ensureSession(
    sessionId: string,
    workspaceId: string,
    filePath: string,
    ts: string | null,
  ): void {
    this.stInsertSession.run(sessionId, workspaceId, filePath, ts, ts);
  }

  private writeTurn(turn: TurnProjection, workspaceId: string): void {
    const priced = this.pricing.price(turn.model, {
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheWrite5m: turn.cacheWrite5m,
      cacheWrite1h: turn.cacheWrite1h,
      cacheWriteOther: turn.cacheWriteOther,
    });

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
    );

    if (res.changes === 0) {
      // Duplicate message_id — a true no-op for aggregates.
      this.health.duplicateDrop();
      return;
    }

    // New turn: the session is already ensured; advance its aggregates.
    this.stBumpSession.run(priced.costU ?? 0, turn.ts, turn.ts, turn.ts, turn.ts, turn.sessionId);
    this.health.turnIngested(PARSER_VERSION);

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
    ownerMessageId: string | null;
    blockIndex: number;
    testCommandHint: boolean;
  }): void {
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
    );
    this.stUpsertToolEventMetadata.run(
      te.eventId,
      te.filePathHash,
      te.ownerMessageId,
      te.blockIndex,
      te.testCommandHint ? 1 : 0,
    );
  }

  private applyToolResult(
    toolUseId: string | null,
    resultBytes: number,
    commitSha: string | null,
    isError: boolean,
  ): void {
    if (toolUseId === null) return;
    // Always enrich the event row, including after a restart or deliberate operator
    // re-scan. Persisted structural metadata is authoritative for TEST_FAIL.
    this.stSetToolResult.run(resultBytes, isError ? 1 : 0, toolUseId);
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
    );
  }

  private recordMetricEvent(
    raw: string,
    proj: Extract<ReturnType<typeof projectLine>, { kind: "record" }>,
    applyAggregates: boolean,
  ): void {
    if (
      !proj.isUserTurn &&
      !proj.isCompactSummary &&
      !proj.isApiErrorMessage &&
      !proj.isInterrupt
    ) {
      return;
    }
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
    const eventId = crypto
      .createHash("sha256")
      .update(`${proj.sessionId}\0${sourceIdentity}`)
      .digest("hex");
    const validUserTs =
      proj.isUserTurn && typeof proj.ts === "string" && Number.isFinite(Date.parse(proj.ts))
        ? proj.ts
        : null;
    const inserted = this.stInsertMetricEvent.run(
      eventId,
      proj.sessionId,
      validUserTs,
      proj.isUserTurn ? 1 : 0,
      proj.isCompactSummary ? 1 : 0,
      proj.isApiErrorMessage ? 1 : 0,
      proj.isInterrupt ? 1 : 0,
    );
    if (!applyAggregates || inserted.changes === 0) return;

    if (proj.isUserTurn) this.stBumpUserTurnCount.run(proj.sessionId);
    if (proj.isCompactSummary || proj.isApiErrorMessage || proj.isInterrupt) {
      this.stBumpFrictionCounts.run(
        proj.isCompactSummary ? 1 : 0,
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
