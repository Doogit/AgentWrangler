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
  type FileVersion,
  fileVersion,
  loadOffset,
  sameFileVersion,
  saveOffset,
  tailFile,
} from "./tail.js";
import type { HealthCounters, TurnProjection } from "./types.js";
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
  now: () => new Date(),
};

const INITIAL_SCAN_BATCH_SIZE = 100;

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
  private readonly lastVersion = new Map<string, FileVersion>(); // filePath → last-seen version
  private readonly discoveryCache = createDiscoveryCache();
  private readonly unresolvedRemotes = new Set<string>();

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

    // Fast tail cadence: advance byte offsets on every known file, then reconcile.
    const tailTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      try {
        for (const f of refreshDiscoveryCache(this.roots, this.discoveryCache)) {
          this.ingestFile(f.filePath, f.projectSlug);
        }
        this.reconcileNow();
      } catch (e) {
        console.warn(`tail tick failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        busy = false;
      }
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
        this.runPostIngest();
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
        this.ingestFile(f.filePath, f.projectSlug);
      }
      if (end < files.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  private reconcileNow(): void {
    const cutoff = new Date(this.opts.now().getTime() - this.opts.activityWindowSecs * 1000);
    reconcileSessions(this.db, cutoff.toISOString(), this.opts.reconcile);
  }

  /**
   * Post-ingest detector pass. Passes the ingestor's INJECTED clock (never
   * new Date()) so recommendation windows/ids are deterministic (NFR-107 /
   * Review F4). No-op unless the daemon wired the post-ingest hook.
   */
  private runPostIngest(): void {
    runPostIngestHook(this.db, this.opts.now());
  }

  /** Tail one file from its stored offset and ingest the complete new lines. */
  ingestFile(filePath: string, projectSlug: string): void {
    // Skip only when size, identity, and timestamps all match. This keeps the
    // 2s tail tick from touching the DB for idle files while still noticing
    // same-size rewrites and path replacement.
    // every tick, which was starving the daemon's event loop (outcomes pass).
    // Keep the per-file stat: directory mtimes only decide when to refresh paths;
    // they cannot safely replace append/rotation change detection for each file.
    let currentVersion: FileVersion;
    try {
      currentVersion = fileVersion(fs.statSync(filePath));
    } catch {
      return; // file vanished between discovery and tail; nothing to ingest
    }
    const previousVersion = this.lastVersion.get(filePath);
    if (previousVersion !== undefined && sameFileVersion(previousVersion, currentVersion)) return;
    this.lastVersion.set(filePath, currentVersion);

    this.health.fileSeen();
    registerWorkspace(this.db, projectSlug);

    const stored = loadOffset(this.db, filePath);
    this.seedLegacyMetricPrefix(filePath, stored?.offset ?? null, currentVersion.size);
    const result = tailFile(filePath, stored, currentVersion);
    if (result.wasReset) this.lineCursor.set(filePath, 0);

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
      return;
    }

    const defaultSessionId = sessionStemFor(filePath);
    const base = this.lineCursor.get(filePath) ?? 0;

    const tx = this.db.transaction(() => {
      for (let i = 0; i < result.lines.length; i++) {
        const raw = result.lines[i];
        if (raw === undefined) continue;
        this.applyLine(raw, { defaultSessionId }, projectSlug, filePath, base + i + 1);
      }
    });
    tx();

    this.lineCursor.set(filePath, base + result.lines.length);
    saveOffset(this.db, filePath, result.newOffset, result.newHeadHash, currentVersion);
    this.stSetMetricBaseline.run(filePath, result.newOffset);
    this.health.fileParsed();
  }

  /**
   * Upgrade bridge for offsets created before the metric-event ledger existed.
   * Already-consumed complete lines are registered without advancing counters.
   */
  private seedLegacyMetricPrefix(
    filePath: string,
    storedOffset: number | null,
    currentSize: number,
  ): void {
    const baseline = this.stGetMetricBaseline.get(filePath) as
      | { seeded_offset: number }
      | undefined;
    if (baseline !== undefined) return;

    if (storedOffset === null || storedOffset <= 0 || storedOffset > currentSize) {
      this.stSetMetricBaseline.run(filePath, 0);
      return;
    }

    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(storedOffset);
      const bytesRead = fs.readSync(fd, buf, 0, storedOffset, 0);
      let lastNl = -1;
      for (let i = bytesRead - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) {
          lastNl = i;
          break;
        }
      }
      const lines = lastNl < 0 ? [] : buf.subarray(0, lastNl).toString("utf8").split("\n");
      const defaultSessionId = sessionStemFor(filePath);
      this.db.transaction(() => {
        for (const raw of lines) {
          if (raw.length === 0) continue;
          const proj = projectLine(raw, { defaultSessionId });
          if (proj.kind === "record") this.recordMetricEvent(raw, proj, false);
        }
        this.stSetMetricBaseline.run(filePath, storedOffset);
      })();
    } finally {
      fs.closeSync(fd);
    }
  }

  private applyLine(
    raw: string,
    ctx: { defaultSessionId: string },
    workspaceId: string,
    filePath: string,
    lineNo: number,
  ): void {
    const proj = projectLine(raw, ctx);

    if (proj.kind === "quarantine") {
      this.quarantine(filePath, lineNo, proj.errorClass);
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
      this.recordCommand(proj.command.sessionId, proj.command.ts, proj.command.command);
    }

    // Tool-use blocks → tool_events; remember owner + git hint for correlation.
    for (const te of proj.toolEvents) {
      this.insertToolEvent(te);
      if (te.toolUseId !== null) {
        if (te.ownerMessageId !== null) this.toolUseOwner.set(te.toolUseId, te.ownerMessageId);
        if (te.gitCommandHint) this.gitUseIds.add(te.toolUseId);
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
    const bytes = this.resultBytesByMsg.get(turn.messageId);
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

    if (this.countedResults.has(toolUseId)) return; // turn aggregate stays idempotent
    this.countedResults.add(toolUseId);

    const owner = this.toolUseOwner.get(toolUseId);
    if (owner !== undefined) {
      const next = (this.resultBytesByMsg.get(owner) ?? 0) + resultBytes;
      this.resultBytesByMsg.set(owner, next);
      this.stSetResultBytes.run(next, owner);
    }
    // Persist a commit SHA only for tool_uses that looked like git commit/push.
    if (commitSha !== null && this.gitUseIds.has(toolUseId)) {
      this.stSetCommitSha.run(commitSha, toolUseId);
    }
  }

  private recordCommand(sessionId: string, ts: string, command: string): void {
    const eventId = `cmd-${crypto
      .createHash("sha1")
      .update(`${sessionId}|${ts}|${command}`)
      .digest("hex")
      .slice(0, 20)}`;
    this.stInsertToolEvent.run(
      eventId,
      sessionId,
      ts,
      "local_command",
      null,
      null,
      command,
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

  private quarantine(filePath: string, lineNo: number, errorClass: string): void {
    const qId = crypto
      .createHash("sha1")
      .update(`${filePath}|${lineNo}|${errorClass}`)
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
