import { readFileSync, writeFileSync } from "node:fs";
import type { Db } from "../db/open.js";
import { CAUSES, causeForKey } from "../query/api/diagnostics-causes.js";
import type { WindowDays } from "../query/api/diagnostics-census.js";
import {
  type DiagnosticsBuildProgress,
  type DiagnosticsTriageView,
  buildDiagnosticsTriage,
} from "../query/api/diagnostics-triage.js";
import { headlineSavings } from "../query/api/recommendations.js";
import { getQueryDb } from "../query/db-context.js";
import type { SnapshotFreshness } from "../query/envelope.js";
import { createDiagnosticsWorkerRunner } from "./diagnostics-worker-runner.js";
import type { HeavyJobGate } from "./heavy-job-gate.js";
import type { RecsSnapshotService } from "./recs-snapshot.js";
import { createSnapshotService, freshnessOf } from "./snapshot-service.js";

/**
 * Build a window's view, calling `onStage` as each build stage finishes. `onStart` fires when the
 * work actually starts (after any heavy-job gate wait), so the build duration excludes queue wait.
 */
export type DiagnosticsBuilder = (
  windowDays: WindowDays,
  asOf: string,
  onStage: (stage: string, ms: number) => void,
  onStart?: () => void,
) => Promise<DiagnosticsTriageView>;

export type DiagnosticsSnapshotState =
  | {
      status: "ready";
      view: DiagnosticsTriageView;
      snapshotAtMs: number;
      refreshing: boolean;
      /** A-17 (P3-U4). */
      freshness: SnapshotFreshness;
    }
  | { status: "building"; progress: DiagnosticsBuildProgress }
  | { status: "failed"; error: Error };

export interface DiagnosticsSnapshotService {
  /** Never waits: a snapshot (maybe stale, rebuilding behind it) or the cold build's progress. */
  get(windowDays: WindowDays): DiagnosticsSnapshotState;
  /** Start a build for the window if none is running; resolves when it ends (never rejects). */
  prewarm(windowDays: WindowDays): Promise<void>;
  /** Windows building with no snapshot to serve meanwhile, for `/api/status` jobs. */
  coldBuilds(): { windowDays: WindowDays; sinceMs: number; expectedMs: number | null }[];
  markStale(): void;
  stop(): void;
}

/** Plain-English labels for `buildDiagnosticsTriage`'s stages, in order (R27). */
const STAGE_LABELS = [
  "Counting failed and blocked commands",
  "Reading detector findings",
  "Ranking avoidable spend",
  "Summarizing reliability and top commands",
];

/**
 * One snapshot per window (KTD-6). Ingest and detector passes (markStale) or a new 10-minute
 * bucket serve the snapshot stale while one rebuild runs; a cold window returns progress at once.
 * P3-U4: a thin adapter over snapshot-service.ts (no invalidate, no inputs token).
 */
export function createDiagnosticsSnapshotService(
  options: {
    dbPath?: string;
    builder?: DiagnosticsBuilder;
    /** Where each window's last build duration is kept across restarts (`expected_ms`). */
    durationsFile?: string;
    log?: (line: string) => void;
    now?: () => number;
    /** RB1-B: shared one-heavy-job-at-a-time gate. */
    gate?: HeavyJobGate;
  } = {},
): DiagnosticsSnapshotService {
  const runner =
    options.dbPath && !options.builder
      ? createDiagnosticsWorkerRunner(options.dbPath, options.gate)
      : null;
  const builder: DiagnosticsBuilder =
    options.builder ??
    (runner
      ? (windowDays, asOf, onStage, onStart) => runner.run(windowDays, asOf, onStage, onStart)
      : async (windowDays, asOf, onStage) => {
          // In-process (tests, scripts): yield so the GET that started the build answers first.
          await new Promise((resolve) => setImmediate(resolve));
          return buildDiagnosticsTriage(getQueryDb(), windowDays, new Date(asOf), { onStage });
        });
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  const durations = readDurations(options.durationsFile);
  let stopped = false;
  const core = createSnapshotService<WindowDays, DiagnosticsTriageView>({
    now,
    build: async (windowDays, inputsAsOfMs, onStage) => {
      let t0 = performance.now();
      try {
        const view = await builder(
          windowDays,
          new Date(inputsAsOfMs).toISOString(),
          onStage,
          () => {
            t0 = performance.now();
          },
        );
        if (!stopped) {
          const ms = Math.round(performance.now() - t0);
          log(`Diagnostics ${windowDays}d build: ${ms} ms`);
          durations[windowDays] = ms;
          writeDurations(options.durationsFile, durations);
        }
        return view;
      } catch (error) {
        if (!stopped) {
          const message = error instanceof Error ? error.message : String(error);
          log(`Diagnostics ${windowDays}d build failed: ${message}`);
        }
        throw error;
      }
    },
  });

  function start(windowDays: WindowDays): Promise<void> {
    return core.start(windowDays).task.catch(() => {});
  }

  return {
    get(windowDays) {
      if (stopped) throw new Error("diagnostics snapshot service stopped");
      core.refresh(windowDays);
      const peeked = core.peek(windowDays);
      if (peeked.state === "ready") {
        return {
          status: "ready",
          view: peeked.snapshot.value,
          snapshotAtMs: peeked.snapshot.inputsAsOfMs,
          refreshing: peeked.recomputing,
          freshness: freshnessOf(peeked) as SnapshotFreshness,
        };
      }
      if (peeked.state === "failed") {
        // Reported once; the next GET retries.
        core.clearFailure(windowDays);
        return { status: "failed", error: peeked.error };
      }
      void start(windowDays);
      const running = core.peek(windowDays);
      const step = running.state === "building" ? running.step : 0;
      return {
        status: "building",
        progress: {
          stage: STAGE_LABELS[step] ?? "Finishing up",
          step: Math.min(step, STAGE_LABELS.length),
          steps: STAGE_LABELS.length,
          started_at: new Date(
            running.state === "building" ? running.sinceMs : now(),
          ).toISOString(),
          expected_ms: durations[windowDays] ?? null,
        },
      };
    },
    prewarm(windowDays) {
      if (stopped) return Promise.resolve();
      return start(windowDays);
    },
    coldBuilds: () =>
      core.coldBuilds().map(({ key, sinceMs }) => ({
        windowDays: key,
        sinceMs,
        expectedMs: durations[key] ?? null,
      })),
    markStale: () => core.markStale(),
    stop() {
      stopped = true;
      runner?.stop();
      core.stop();
    },
  };
}

function readDurations(file: string | undefined): Partial<Record<WindowDays, number>> {
  if (!file) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Partial<Record<WindowDays, number>> = {};
    for (const windowDays of [7, 14, 30] as const) {
      const ms = parsed[windowDays];
      if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) out[windowDays] = ms;
    }
    return out;
  } catch {
    return {};
  }
}

function writeDurations(
  file: string | undefined,
  durations: Partial<Record<WindowDays, number>>,
): void {
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify(durations));
  } catch {
    // Best effort: without the file the next restart's first build shows no estimate.
  }
}

/** An active recs card, keyed like a finding (KTD-1): `key` is its rule_id or template_id. */
export interface HandoffCandidate {
  rec_id: string;
  detector_id: string;
  key: string | null;
  /** The card headline (L6 rule): `allocated_u_per_wk` when the card has the field, even null; else `modeled_savings_u_per_wk`. */
  headline_u: number | null;
  /** RC-B: a PROPOSED card in the recs `history` bucket (no fire this week); never a hand-off. */
  quiet?: boolean;
  /** RC-B: a card in the recs `below_floor` bucket; a hand-off only when the cause has no active card. */
  small?: boolean;
}

/** Cards to join; "pending" while the first recs build runs; null when recs failed. */
export interface HandoffSource {
  get(): Promise<HandoffCandidate[] | "pending" | null>;
}

/**
 * The recs snapshot's active cards as hand-off candidates, in list order. V1 cards don't carry
 * their template_id in `evidence`, so the key is read from the recommendations row. A GET never
 * waits more than `timeoutMs` on a recs rebuild (an adopt or dismiss clears that snapshot): past it,
 * the last candidates seen are used, and later GETs use them at once until that fetch settles (a
 * cold recs build at boot takes seconds). Null when there are none to use (the view is then partial).
 */
export function createHandoffSource(
  recs: RecsSnapshotService,
  db: Db,
  timeoutMs = 250,
): HandoffSource {
  let last: HandoffCandidate[] | null = null;
  let lastFailed = false;
  let inflight: Promise<HandoffCandidate[] | null> | null = null;
  let slow = false;
  // F9: no cards yet and no failure seen means the recs build is still running.
  const fallback = () => last ?? (lastFailed ? null : "pending");
  return {
    async get() {
      if (inflight && slow) return fallback();
      inflight ??= recs.get().then(
        (response) => {
          const active = response.data?.active;
          lastFailed = !active;
          if (!active) return null;
          const rows = db
            .prepare(
              "SELECT rec_id, COALESCE(rule_id, template_id) AS key FROM recommendations WHERE state = 'PROPOSED'",
            )
            .all() as Array<{ rec_id: string; key: string | null }>;
          const keys = new Map(rows.map((row) => [row.rec_id, row.key]));
          const candidate = (
            card: (typeof active)[number],
            bucket: "active" | "small" | "quiet",
          ) => ({
            rec_id: card.rec_id,
            detector_id: card.detector_id,
            key: keys.get(card.rec_id) ?? null,
            headline_u: headlineSavings(card),
            ...(bucket === "quiet" ? { quiet: true } : {}),
            ...(bucket === "small" ? { small: true } : {}),
          });
          // History cards keep a key only when still PROPOSED (the `keys` query), so retired,
          // dismissed and adopted ones never mark a cause quiet.
          last = [
            ...active.map((card) => candidate(card, "active")),
            ...(response.data?.below_floor ?? []).map((card) => candidate(card, "small")),
            ...(response.data?.history ?? []).map((card) => candidate(card, "quiet")),
          ];
          return last;
        },
        () => {
          lastFailed = true;
          return null;
        },
      );
      const fresh = inflight;
      void fresh.finally(() => {
        if (inflight === fresh) {
          inflight = null;
          slow = false;
        }
      });
      const timeout = new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), timeoutMs).unref();
      });
      const result = await Promise.race([fresh, timeout]);
      if (result !== "timeout") return result;
      slow = true;
      return fallback();
    },
  };
}

/**
 * KTD-7: join each row's hand-off from the recs cards. Per cause: the largest active card
 * headline wins (nulls rank last, ties keep list order); with no active card, the largest
 * `below_floor` card is a "Small fix" hand-off (RC-B); with neither, the largest history card marks the
 * row quiet and is its `quiet_rec_id`. `candidates` null (recs failed) or "pending" (recs still building) leaves every hand-off
 * null and marks the view partial; "pending" also sets `handoffs_pending` so the UI says
 * "Checking for a fix…" and polls (F9). `fix_ready` counts active hand-offs only.
 */
export function joinHandoffs(
  view: DiagnosticsTriageView,
  candidates: HandoffCandidate[] | "pending" | null,
): DiagnosticsTriageView {
  const best = new Map<string, HandoffCandidate>();
  const bestSmall = new Map<string, HandoffCandidate>();
  const quiet = new Map<string, HandoffCandidate>();
  for (const card of Array.isArray(candidates) ? candidates : []) {
    if (card.key === null) continue;
    let causeId: string;
    try {
      causeId = causeForKey(card.detector_id, card.key).cause_id;
    } catch {
      continue;
    }
    const pool = card.quiet ? quiet : card.small ? bestSmall : best;
    const current = pool.get(causeId);
    if (current === undefined || (card.headline_u ?? -1) > (current.headline_u ?? -1)) {
      pool.set(causeId, card);
    }
  }
  const fixLabel = new Map(CAUSES.map((cause) => [cause.cause_id, cause.fix_label]));
  // RC-B: no active card but a PROPOSED one in history → "No fix this week", not "No fix yet".
  const handoff = (causeId: string, label: string) => {
    const card = best.get(causeId);
    if (card) return { handoff: { rec_id: card.rec_id, label } };
    const small = bestSmall.get(causeId);
    if (small) return { handoff: { rec_id: small.rec_id, label: "Small fix" }, fix_small: true };
    const old = quiet.get(causeId);
    return { handoff: null, ...(old ? { fix_quiet: true, quiet_rec_id: old.rec_id } : {}) };
  };
  // Labels are plain text; the UI appends the "→" (TriageRow).
  const avoidable = view.avoidable.causes.map((row) => ({
    ...row,
    ...handoff(row.cause_id, `${fixLabel.get(row.cause_id)}`),
  }));
  const reliability = view.reliability.causes.map((row) => ({
    ...row,
    ...handoff(row.cause_id, `${fixLabel.get(row.cause_id)}`),
  }));
  const risk = view.reliability.risk && {
    ...view.reliability.risk,
    ...handoff(
      view.reliability.risk.cause_id,
      `Review ${view.reliability.risk.occurrences} commands`,
    ),
  };
  const n = [...avoidable, ...reliability].filter(
    (row) => row.handoff !== null && row.fix_small !== true,
  ).length;
  return {
    ...view,
    partial: view.partial || !Array.isArray(candidates),
    ...(candidates === "pending" ? { handoffs_pending: true } : {}),
    tiles: { ...view.tiles, fix_ready: { n, m: view.tiles.fix_ready.m } },
    avoidable: { ...view.avoidable, causes: avoidable },
    reliability: { ...view.reliability, causes: reliability, risk },
  };
}
