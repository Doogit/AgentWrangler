import * as fs from "node:fs";
import * as path from "node:path";
import type { Db } from "../../src/db/open.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const GLOBAL_WORKSPACE_ID = "__global__";

export const SYNTHETIC_WINDOW_FROM = "2026-01-01T00:00:00.000Z";
export const SYNTHETIC_WINDOW_TO = "2026-01-15T00:00:00.000Z";

type SessionSeed = { index: number; turns: number; workspace: number; idle: boolean };

/** A single large session, long-context cohort, skewed active tail, and idle files. */
function sessionSeeds(turns: number): SessionSeed[] {
  if (turns <= 0) return [];
  if (turns < 1_000) return [{ index: 0, turns, workspace: 0, idle: false }];
  const activeCount = Math.max(7, Math.min(240, Math.ceil(Math.sqrt(turns))));
  const counts = [Math.floor(turns * 0.35), 160, 160, 12];
  let remaining = turns - counts.reduce((sum, count) => sum + count, 0);
  const tailBudget = remaining;
  const weights = Array.from(
    { length: activeCount - counts.length },
    (_, index) => 1 / Math.pow(index + 1, 0.7),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  for (const weight of weights) {
    const count = Math.floor((tailBudget * weight) / totalWeight);
    counts.push(count);
    remaining -= count;
  }
  for (let index = counts.length - 1; remaining > 0; index = (index + 1) % counts.length) {
    counts[index] = (counts[index] ?? 0) + 1;
    remaining -= 1;
  }
  const workspaceCount = Math.min(10, Math.max(4, Math.ceil(Math.sqrt(activeCount))));
  const active = counts.map((count, index) => ({
    index,
    turns: count,
    workspace: index % workspaceCount,
    idle: false,
  }));
  return [
    ...active,
    ...Array.from({ length: Math.max(12, Math.ceil(activeCount / 2)) }, (_, offset) => ({
      index: activeCount + offset,
      turns: 0,
      workspace: offset % workspaceCount,
      idle: true,
    })),
  ];
}

function timestampFor(turn: number, turns: number, addedMinutes: number): string {
  const baseMs = Date.parse(SYNTHETIC_WINDOW_FROM);
  // The spare day leaves room for deterministic long-idle gaps without leaving the window.
  return new Date(baseMs + Math.floor((turn * 13 * DAY_MS) / Math.max(turns, 1)) + addedMinutes * 60_000).toISOString();
}

/** Seed aggregate-only history. No transcript text, local paths, or repositories are created. */
export function seedSyntheticHistory(db: Db, turns: number): void {
  const seeds = sessionSeeds(turns);
  if (seeds.length === 0) return;
  const workspaceCount = new Set(seeds.map((seed) => seed.workspace)).size;
  const insertWorkspace = db.prepare("INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)");
  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state,
      turn_count, cost_equiv_u, hygiene_flags, user_turn_count, compaction_count, api_error_count,
      interrupt_count, gap_median_s, gap_p90_s, long_gap_count, gap_n)
     VALUES (?,?,?,?,?,?,?,?,'[]',?,?,?,?,?,?,?,?)`,
  );
  const insertTurn = db.prepare(
    `INSERT INTO turns (message_id, session_id, workspace_id, ts, model, is_sidechain, input_tokens,
      output_tokens, cache_read_tokens, cache_write_5m, cache_write_1h, cache_write_other,
      tool_result_bytes, pricing_snapshot_id, cost_equiv_u, cost_claim, provisional, parser_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'synthetic-v2')`,
  );
  const insertTool = db.prepare(
    `INSERT INTO tool_events (event_id, session_id, ts, tool_name, input_bytes, result_bytes, input_hash,
      exit_class, commit_sha) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const insertToolMetadata = db.prepare(
    `INSERT INTO tool_event_metadata (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
     VALUES (?,?,?,?,?)`,
  );
  const insertMetricEvent = db.prepare(
    `INSERT INTO ingest_metric_events (event_id, session_id, user_turn_ts, is_user_turn,
      is_compact_summary, is_api_error, is_interrupt) VALUES (?,?,?,?,?,?,?)`,
  );
  const insertPricingSnapshot = db.prepare(
    `INSERT INTO pricing_snapshots (snapshot_id, model_tier, unit_prices_json, captured_at, stale_after)
     VALUES (?,?,?,?,?)`,
  );

  db.transaction(() => {
    insertPricingSnapshot.run(
      "synthetic-price-opus",
      "opus",
      "[5,25,0.5,6.25,10]",
      SYNTHETIC_WINDOW_FROM,
      SYNTHETIC_WINDOW_TO,
    );
    insertPricingSnapshot.run(
      "synthetic-price-sonnet",
      "sonnet-5",
      "[2,10,0.2,2.5,4]",
      SYNTHETIC_WINDOW_FROM,
      SYNTHETIC_WINDOW_TO,
    );
    insertWorkspace.run(GLOBAL_WORKSPACE_ID, "synthetic-global-context", SYNTHETIC_WINDOW_FROM);
    for (let workspace = 0; workspace < workspaceCount; workspace += 1) {
      insertWorkspace.run(`synthetic-ws-${workspace}`, `synthetic-project-${workspace}`, SYNTHETIC_WINDOW_FROM);
    }
    let globalTurn = 0;
    for (const seed of seeds) {
      const sessionId = `synthetic-session-${seed.index}`;
      const workspaceId = `synthetic-ws-${seed.workspace}`;
      if (seed.idle) {
        insertSession.run(sessionId, workspaceId, `synthetic://idle-session-${seed.index}`, null, null, "LIVE", 0, 0, 0, 0, 0, 0, null, null, 0, 0);
        continue;
      }
      const firstGlobalTurn = globalTurn;
      const firstTs = timestampFor(firstGlobalTurn, turns, 0);
      const lastTs = timestampFor(
        firstGlobalTurn + seed.turns - 1,
        turns,
        seed.index === 3 ? 30 : 0,
      );
      const userTurns = seed.index === 0 ? 0 : Math.max(1, Math.floor(seed.turns / 2));
      insertSession.run(
        sessionId, workspaceId, `synthetic://session-${seed.index}`, firstTs, lastTs, "RECONCILED",
        seed.turns, seed.turns * 10_000, userTurns, seed.index === 3 ? 2 : 0, seed.index === 3 ? 1 : 0,
        seed.index === 3 ? 1 : 0, seed.index === 3 ? 600 : null, seed.index === 3 ? 900 : null,
        seed.index === 3 ? 3 : 0, seed.index === 3 ? 3 : 0,
      );
      let addedMinutes = 0;
      for (let offset = 0; offset < seed.turns; offset += 1) {
        if (seed.index === 3 && (offset === 2 || offset === 4 || offset === 6)) addedMinutes += 10;
        const ts = timestampFor(globalTurn, turns, addedMinutes);
        const longContext = seed.index < 3;
        const churn = seed.index === 3 && (offset === 2 || offset === 4 || offset === 6);
        const model = longContext && offset < 8 ? "synthetic-opus" : "synthetic-sonnet-5";
        const input = longContext ? 10_000 : 1_000;
        const cacheRead = churn ? 1_000 : longContext ? 190_000 : 4_000;
        const cacheWrite = churn ? 60_000 : 300;
        const toolBytes = longContext && offset === 8 ? 48_000_000 : null;
        const sidechain = seed.index === 0 && offset < Math.ceil(seed.turns / 2) ? 1 : 0;
        const inputPrice = model.includes("opus") ? 5 : 2;
        const outputPrice = model.includes("opus") ? 25 : 10;
        const readPrice = model.includes("opus") ? 0.5 : 0.2;
        const writePrice = model.includes("opus") ? 6.25 : 2.5;
        insertTurn.run(
          `synthetic-message-${globalTurn}`, sessionId, workspaceId, ts, model, sidechain, input, 100,
          cacheRead, cacheWrite, 0, 0, toolBytes,
          model.includes("opus") ? "synthetic-price-opus" : "synthetic-price-sonnet",
          Math.round(input * inputPrice + 100 * outputPrice + cacheRead * readPrice + cacheWrite * writePrice),
          "LIST_EQUIV",
        );
        globalTurn += 1;
      }
      if (seed.index === 3) {
        for (let offset = 0; offset < Math.min(9, seed.turns); offset += 1) {
          const turn = firstGlobalTurn + offset;
          const eventId = `synthetic-tool-event-${turn}`;
          const ts = timestampFor(turn, turns, offset >= 2 ? 10 : 0);
          insertTool.run(eventId, sessionId, ts, "Read", 64, 256, "synthetic-repeat-input-hash", "TEST_FAIL", null);
          insertToolMetadata.run(eventId, "synthetic-file-hash-loop-target", `synthetic-message-${turn}`, offset, 1);
          insertMetricEvent.run(eventId, sessionId, ts, 1, 0, 0, 0);
        }
      }
      if (seed.index === 4 && seed.turns > 0) {
        insertTool.run(`synthetic-tool-event-commit-${seed.index}`, sessionId, timestampFor(firstGlobalTurn, turns, 0), "Write", 32, 64, "synthetic-write-input-hash", "OK", `synthetic-commit-${seed.index}`);
      }
    }

    // Keep cached session totals consistent with window-query accounting.
    db.prepare(`UPDATE sessions SET cost_equiv_u = COALESCE(
      (SELECT SUM(cost_equiv_u) FROM turns WHERE turns.session_id = sessions.session_id), 0
    )`).run();

    const linkedSession = seeds.find((seed) => seed.index === 4 && seed.turns > 0);
    if (linkedSession) {
      const insertWorkItem = db.prepare(
        `INSERT INTO work_items (work_item_id, workspace_id, number, state, final_commit,
          checks_conclusion, opened_at, merged_at, closed_at, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      insertWorkItem.run(
        "synthetic-work-item-0", `synthetic-ws-${linkedSession.workspace}`, 1, "MERGED", "synthetic-commit-4", "SUCCESS",
        "2026-01-02T00:00:00.000Z", "2026-01-10T00:00:00.000Z", null, SYNTHETIC_WINDOW_TO,
      );
      db.prepare(
        "INSERT INTO session_work_links (session_id, work_item_id, confidence, method) VALUES (?,?,?,?)",
      ).run("synthetic-session-4", "synthetic-work-item-0", 0.9, "MANUAL");
      db.prepare(
        "INSERT INTO observed_outcomes (work_item_id, outcome, derived_at, methodology_version) VALUES (?,?,?,?)",
      ).run("synthetic-work-item-0", "OBSERVED_SUCCESS", SYNTHETIC_WINDOW_TO, "synthetic-outcomes-v1");
      db.prepare(
        `INSERT INTO review_findings (finding_id, work_item_id, source, severity, status, evidence_ref,
          confidence, human_state, raised_at, cleared_at, cleared_by, extractor_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        "synthetic-finding-0", "synthetic-work-item-0", "DIFF_MARKER", "LOW", "ADDRESSED",
        "synthetic-evidence-ref", 1, null, "2026-01-03T00:00:00.000Z", "2026-01-09T00:00:00.000Z",
        "synthetic-commit-4", "synthetic-findings-v1",
      );
    }

    const insertInventory = db.prepare(
      `INSERT INTO context_inventory (probe_id, workspace_id, probed_at, component, file_ref, file_hash, tokens, attribution_version)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const insertHistory = db.prepare(
      `INSERT INTO context_inventory_history (workspace_id, component, file_ref, file_hash, tokens, attribution_version, observed_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (let workspace = 0; workspace < workspaceCount; workspace += 1) {
      const workspaceId = `synthetic-ws-${workspace}`;
      const fileRef = `synthetic://context/workspace-${workspace}/claude-md`;
      insertInventory.run(`synthetic-context-${workspace}`, workspaceId, SYNTHETIC_WINDOW_TO, "CLAUDE_MD", fileRef, `synthetic-context-hash-${workspace}-after`, 6_000, "synthetic-context-v1");
      insertHistory.run(workspaceId, "CLAUDE_MD", fileRef, `synthetic-context-hash-${workspace}-before`, 8_000, "synthetic-context-v1", "2025-12-20T00:00:00.000Z");
      insertHistory.run(workspaceId, "CLAUDE_MD", fileRef, `synthetic-context-hash-${workspace}-after`, 6_000, "synthetic-context-v1", SYNTHETIC_WINDOW_TO);
    }
    insertInventory.run("synthetic-context-global-memory", GLOBAL_WORKSPACE_ID, SYNTHETIC_WINDOW_TO, "MEMORY", "synthetic://context/global-memory", "synthetic-global-memory-hash", 3_000, "synthetic-context-v1");
    insertInventory.run("synthetic-context-catalog", GLOBAL_WORKSPACE_ID, SYNTHETIC_WINDOW_TO, "MCP_SCHEMAS", "synthetic://context/catalog", "synthetic-catalog-hash", 50_000, "synthetic-catalog-v1;tool_search=disabled;catalog_item_count=12");
    insertInventory.run(
      "synthetic-context-settings", GLOBAL_WORKSPACE_ID, SYNTHETIC_WINDOW_TO, "SETTINGS_SYSTEM",
      "synthetic://context/tool-search-state", "synthetic-tool-search-state-hash", 0,
      'tool-search-state-v1:{"tool_search_mode":"disabled","effective_catalog_state":"upfront","configured_value":"disabled","always_load_flags":[],"always_load_count":0,"always_load_flags_truncated":false,"catalog_item_count":12,"catalog_item_count_truncated":false,"catalog_hash":"synthetic-catalog-hash"}',
    );

    const insertOffset = db.prepare(
      `INSERT INTO ingest_offsets (file_path, byte_offset, file_hash_head, updated_at, file_size, file_dev, file_ino, file_mtime_ms, file_ctime_ms)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const insertBaseline = db.prepare("INSERT INTO ingest_metric_baselines (file_path, seeded_offset) VALUES (?,?)");
    for (let boundary = 0; boundary < 3; boundary += 1) {
      const fileRef = `synthetic://collector-boundary-${boundary}`;
      insertOffset.run(fileRef, 10_000 + boundary, `synthetic-offset-hash-${boundary}`, SYNTHETIC_WINDOW_TO, 20_000 + boundary, "synthetic-device", `synthetic-inode-${boundary}`, 1_700_000_000_000 + boundary, 1_700_000_000_000 + boundary);
      insertBaseline.run(fileRef, 5_000 + boundary);
    }

    const insertRec = db.prepare(
      `INSERT INTO recommendations (rec_id, provenance, detector_id, analysis_run_id, category, scope_workspace_id, lever,
        modeled_savings_u_per_wk, modeled_formula_json, evidence_json, target_metric, state, created_at, adopted_at, dismissed_until)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertEffect = db.prepare(
      `INSERT INTO recommendation_effects (rec_id, measured_at, before_from, before_to, after_from, after_to, before_value,
        after_value, before_n, after_n, delta_pct, verdict) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const recs = [
      ["synthetic-rec-d1-effective", "D1", "CONTEXT", null, "context_tokens", "MEASURED_EFFECTIVE", "EFFECTIVE"],
      ["synthetic-rec-d2-no-effect", "D2", "CONTEXT", "synthetic-ws-0", "CACHE_READ_TOKENS_PER_WK", "MEASURED_NO_EFFECT", "NO_EFFECT"],
      ["synthetic-rec-d4-inconclusive", "D4", "ROUTING", "synthetic-ws-1", "ROUTING_ADHERENCE_SCORE", "MEASURING", "INCONCLUSIVE"],
      ["synthetic-rec-d8-pending", "D8", "CACHE", "synthetic-ws-2", "cache_read_to_creation_ratio", "MEASURING", null],
    ] as const;
    for (const [recId, detectorId, category, workspaceId, targetMetric, state, verdict] of recs) {
      // Workspace-scoped recs reference synthetic-ws-1/2, which only exist once
      // workspaceCount >= 3 (always true at the documented 1k+ turn scales).
      if (workspaceId !== null && Number(workspaceId.slice("synthetic-ws-".length)) >= workspaceCount) continue;
      insertRec.run(recId, "RULE", detectorId, null, category, workspaceId, "Synthetic aggregate-only recommendation", 100_000, "{\"model\":\"synthetic-v1\",\"inputs\":{}}", "{\"synthetic\":true}", targetMetric, state, "2025-12-01T00:00:00.000Z", "2025-12-15T00:00:00.000Z", null);
      insertEffect.run(recId, "2026-01-15T12:00:00.000Z", "2025-12-01T00:00:00.000Z", "2025-12-15T00:00:00.000Z", SYNTHETIC_WINDOW_FROM, SYNTHETIC_WINDOW_TO, 100, verdict === "EFFECTIVE" ? 60 : 100, 4, 4, verdict === "EFFECTIVE" ? -40 : 0, verdict);
    }
  })();
}

const CORPUS_TURNS_PER_FILE = 500;
const CORPUS_SLUGS = 3;

/**
 * Write a synthetic transcript corpus (`<dir>/<slug>/<session>.jsonl`) for the
 * real ingest catch-up measurement. Every field is fabricated (SEC-101): fake
 * ids, zero-content messages, no cwd/repository fields, no operator paths.
 * Session/message ids are disjoint from seedSyntheticHistory's so a backscan
 * into a seeded database ingests every corpus turn (no duplicate drops).
 */
export function writeSyntheticIngestCorpus(
  corpusDir: string,
  turns: number,
): { files: number; lines: number } {
  const baseMs = Date.parse(SYNTHETIC_WINDOW_FROM);
  let files = 0;
  let lines = 0;
  let written = 0;
  while (written < turns) {
    const fileTurns = Math.min(CORPUS_TURNS_PER_FILE, turns - written);
    const fileIndex = files;
    const sessionId = `synthetic-ingest-session-${fileIndex}`;
    const slug = `synthetic-ingest-project-${fileIndex % CORPUS_SLUGS}`;
    const records: string[] = [];
    for (let offset = 0; offset < fileTurns; offset += 1) {
      const globalTurn = written + offset;
      const ts = new Date(baseMs + (globalTurn % (13 * 24 * 60)) * 60_000).toISOString();
      if (offset % 10 === 0) {
        records.push(
          JSON.stringify({
            type: "user",
            timestamp: ts,
            sessionId,
            promptSource: "typed",
            message: { role: "user", content: "SYNTHETIC_INGEST_CONTENT_DO_NOT_STORE" },
          }),
        );
      }
      const content =
        offset % 25 === 0
          ? [
              {
                type: "tool_use",
                id: `synthetic-ingest-tool-${globalTurn}`,
                name: "Read",
                input: { file_path: `synthetic://ingest-corpus/file-${globalTurn % 7}` },
              },
            ]
          : undefined;
      records.push(
        JSON.stringify({
          type: "assistant",
          timestamp: ts,
          sessionId,
          message: {
            id: `synthetic-ingest-msg-${globalTurn}`,
            model: "claude-sonnet-4-6",
            ...(content === undefined ? {} : { content }),
            usage: {
              input_tokens: 1_000,
              output_tokens: 100,
              cache_read_input_tokens: 4_000,
              cache_creation_input_tokens: 300,
            },
          },
        }),
      );
      if (offset % 25 === 0) {
        records.push(
          JSON.stringify({
            type: "user",
            timestamp: ts,
            sessionId,
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: `synthetic-ingest-tool-${globalTurn}`,
                  content: "SYNTHETIC_INGEST_RESULT",
                },
              ],
            },
          }),
        );
      }
    }
    // One malformed line per file keeps the quarantine path in the measurement.
    records.push("{synthetic-ingest-not-json");
    const dir = path.join(corpusDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${records.join("\n")}\n`, "utf8");
    files += 1;
    lines += records.length;
    written += fileTurns;
  }
  return { files, lines };
}
