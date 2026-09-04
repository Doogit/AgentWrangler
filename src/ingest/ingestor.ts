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
import { loadOffset, saveOffset, tailFile } from "./tail.js";
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
  private readonly lastSize = new Map<string, number>(); // filePath → last-seen size (skip unchanged files)
  private readonly discoveryCache = createDiscoveryCache();
  private readonly unresolvedRemotes = new Set<string>();
  private readonly userTurnTsBySession = new Map<string, number[]>(); // sessionId → epoch-ms of user turns

  // Prepared statements.
  private readonly stInsertTurn;
  private readonly stInsertSession;
  private readonly stBumpSession;
  private readonly stBumpUserTurnCount;
  private readonly stBumpFrictionCounts;
  private readonly stSetGapAggregates;
  private readonly stGetGapN;
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
    this.stGetGapN = db.prepare("SELECT gap_n FROM sessions WHERE session_id=?");
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
    this.lastSize.clear();
    this.unresolvedRemotes.clear();
    this.userTurnTsBySession.clear();
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
    // Cheap size guard: transcripts are append-only, so an unchanged file size
    // means zero new complete lines. Skip it before touching the DB — this keeps
    // the 2s tail tick from doing ~4,700 sqlite writes across ~2,352 idle files
    // every tick, which was starving the daemon's event loop (outcomes pass).
    // Keep the per-file stat: directory mtimes only decide when to refresh paths;
    // they cannot safely replace append/rotation change detection for each file.
    let curSize: number;
    try {
      curSize = fs.statSync(filePath).size;
    } catch {
      return; // file vanished between discovery and tail; nothing to ingest
    }
    if (this.lastSize.get(filePath) === curSize) return; // unchanged since last tick — no new bytes
    this.lastSize.set(filePath, curSize);

    this.health.fileSeen();
    registerWorkspace(this.db, projectSlug);

    const stored = loadOffset(this.db, filePath);
    const result = tailFile(filePath, stored);
    if (result.wasReset) this.lineCursor.set(filePath, 0);

    if (result.lines.length === 0) {
      // Still persist head-hash/offset so first-touch rotation detection is armed.
      saveOffset(this.db, filePath, result.newOffset, result.newHeadHash);
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
    saveOffset(this.db, filePath, result.newOffset, result.newHeadHash);
    this.health.fileParsed();
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

    if (proj.isUserTurn === true) {
      this.stBumpUserTurnCount.run(proj.sessionId);
      if (typeof proj.ts === "string" && proj.ts.length > 0) {
        const epochMs = Date.parse(proj.ts);
        if (Number.isFinite(epochMs)) {
          const list = this.userTurnTsBySession.get(proj.sessionId);
          if (list !== undefined) {
            list.push(epochMs);
          } else {
            this.userTurnTsBySession.set(proj.sessionId, [epochMs]);
          }
          this.applyGapAggregates(proj.sessionId);
        }
      }
    }

    // Friction counters (RV2a): compact summary, API error, interrupt.
    if (proj.isCompactSummary || proj.isApiErrorMessage || proj.isInterrupt) {
      // Ensure session row exists for lines that carry only top-level flags
      // (no turn, command, or tool events — so lineSessionId would be null).
      if (lineSessionId === null) {
        this.ensureSession(proj.sessionId, workspaceId, filePath, null);
      }
      this.stBumpFrictionCounts.run(
        proj.isCompactSummary ? 1 : 0,
        proj.isApiErrorMessage ? 1 : 0,
        proj.isInterrupt ? 1 : 0,
        proj.sessionId,
      );
    }

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

  private applyGapAggregates(sessionId: string): void {
    const tsList = this.userTurnTsBySession.get(sessionId);
    if (tsList === undefined || tsList.length === 0) {
      this.clearGapAggregatesUnlessRicher(sessionId);
      return;
    }
    const sorted = [...tsList].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(((sorted[i] as number) - (sorted[i - 1] as number)) / 1000);
    }
    const gapN = gaps.length;
    if (gapN === 0) {
      this.clearGapAggregatesUnlessRicher(sessionId);
      return;
    }
    // gapN >= 1: a real gap was observed in-process. Always write it — even a partial,
    // post-restart sample reflects genuine current friction (e.g. a new long gap) and
    // must not be suppressed just because it's smaller than a pre-restart gap_n.
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

  // Write-guard for the "no computable gap" collapse (0 or 1 in-process user turns):
  // the in-memory turn-timestamp map resets on every daemon restart, so this state is
  // reached on the first post-restart user turn even when a prior cold runBackscan()
  // already persisted a richer gap_n. Skip the null/zero write in that case so it
  // doesn't clobber the richer aggregate.
  private clearGapAggregatesUnlessRicher(sessionId: string): void {
    const storedRow = this.stGetGapN.get(sessionId) as { gap_n: number | null } | undefined;
    if ((storedRow?.gap_n ?? 0) > 0) return;
    this.stSetGapAggregates.run(null, null, 0, 0, sessionId);
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
