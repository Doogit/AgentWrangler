import { randomUUID } from "node:crypto";
import type { Db } from "../db/open.js";
import { awaitDbWriteGate } from "../db/write-gate.js";
import type { GithubClient } from "../outcomes/github/client.js";
import type { TokenResult } from "../outcomes/github/credential.js";
import { PassPrPages } from "../outcomes/github/pr-page.js";
import type { OutcomeFailureCode, OutcomeStageSummary } from "../outcomes/stage-summary.js";
import { bumpDataVersion } from "./data-version.js";

export const OUTCOMES_PASS_DEADLINE_MS = 15 * 60 * 1000;
export const OUTCOMES_POLL_INTERVAL_MS = 10 * 60 * 1000;
export const OUTCOMES_LAST_PASS_KEY = "outcomes_last_pass_at";
export type OperationState =
  | "never-run"
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "disabled"
  | "timed-out";
export interface OperationSnapshot {
  state: OperationState;
  attemptId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastSuccess: string | null;
  eligibleRepositories: number;
  attemptedReads: number;
  failedReads: number;
  categories: Partial<Record<OutcomeFailureCode, number>>;
  failedStages: string[];
  draining: boolean;
}
export interface OutcomesPassDeps {
  db: Db;
  probe: () => void;
  readToken: () => Promise<TokenResult>;
  createClient: (token: TokenResult) => GithubClient;
  /** `pages` is created per pass so sync's GraphQL PR pages serve link and findings. */
  sync: (
    db: Db,
    client: GithubClient,
    pages: PassPrPages,
  ) => Promise<OutcomeStageSummary> | Promise<void>;
  link: (
    db: Db,
    client: GithubClient,
    pages: PassPrPages,
  ) => Promise<OutcomeStageSummary> | Promise<void>;
  derive: (db: Db) => void;
  findings: (
    db: Db,
    client: GithubClient,
    pages: PassPrPages,
  ) => Promise<OutcomeStageSummary> | Promise<void>;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  deadlineMs?: number;
}
export interface OutcomesPassResult {
  skipped: boolean;
  disabled: boolean;
  aborted: boolean;
}
export interface OutcomesPassRunner {
  run(): Promise<OutcomesPassResult>;
  /** S4: run() unless the last completed pass (persisted) is newer than `intervalMs`. */
  runAtBoot(intervalMs?: number): Promise<OutcomesPassResult>;
  start(): { accepted: boolean; attemptId: string | null; snapshot: OperationSnapshot };
  snapshot(): OperationSnapshot;
  readonly isRunning: boolean;
}
const initial = (): OperationSnapshot => ({
  state: "never-run",
  attemptId: null,
  startedAt: null,
  completedAt: null,
  lastSuccess: null,
  eligibleRepositories: 0,
  attemptedReads: 0,
  failedReads: 0,
  categories: {},
  failedStages: [],
  draining: false,
});
const idle = { skipped: false, disabled: false, aborted: false };

export function createOutcomesPassRunner(deps: OutcomesPassDeps): OutcomesPassRunner {
  let snapshot = initial();
  let active: Promise<OutcomesPassResult> | null = null;
  let activeId: string | null = null;
  const log = deps.log ?? (() => {});
  const error = deps.error ?? (() => {});

  function begin(): {
    accepted: boolean;
    attemptId: string | null;
    snapshot: OperationSnapshot;
    promise: Promise<OutcomesPassResult>;
  } {
    if (active !== null)
      return {
        accepted: false,
        attemptId: activeId,
        snapshot: { ...snapshot },
        promise: Promise.resolve({ ...idle, skipped: true }),
      };
    const attemptId = randomUUID();
    activeId = attemptId;
    snapshot = {
      ...initial(),
      state: "running",
      attemptId,
      startedAt: new Date().toISOString(),
      lastSuccess: snapshot.lastSuccess,
    };
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const body = Promise.resolve().then(async (): Promise<OutcomesPassResult> => {
      try {
        await awaitDbWriteGate();
        deps.probe();
        const token = await deps.readToken();
        const client = deps.createClient(token);
        if (!client.enabled) {
          if (!timedOut)
            snapshot = { ...snapshot, state: "disabled", completedAt: new Date().toISOString() };
          return { ...idle, disabled: true };
        }
        const pages = new PassPrPages();
        const stages: Array<[string, () => Promise<OutcomeStageSummary> | Promise<void>]> = [
          ["sync", () => deps.sync(deps.db, client, pages)],
          ["link", () => deps.link(deps.db, client, pages)],
          [
            "derive",
            async () => {
              await awaitDbWriteGate();
              deps.derive(deps.db);
            },
          ],
          ["findings", () => deps.findings(deps.db, client, pages)],
        ];
        for (const [name, stage] of stages) {
          try {
            const summary = await stage();
            bumpDataVersion("ingest");
            if (timedOut) return { ...idle, aborted: true };
            if (summary) {
              snapshot.eligibleRepositories = Math.max(
                snapshot.eligibleRepositories,
                summary.eligibleRepositories,
              );
              snapshot.attemptedReads += summary.attemptedReads;
              snapshot.failedReads += summary.failedReads;
              for (const [code, count] of Object.entries(summary.categories)) {
                const key = code as OutcomeFailureCode;
                snapshot.categories[key] = (snapshot.categories[key] ?? 0) + count;
              }
              if (summary.failedReads > 0) snapshot.failedStages.push(name);
            }
          } catch {
            bumpDataVersion("ingest"); // a failed stage may have written part of its rows
            if (timedOut) return { ...idle, aborted: true };
            snapshot.failedStages.push(name);
            snapshot.categories["provider-error"] =
              (snapshot.categories["provider-error"] ?? 0) + 1;
          }
        }
        if (!timedOut) {
          const completedAt = new Date().toISOString();
          const state =
            snapshot.failedStages.length > 0
              ? snapshot.attemptedReads > snapshot.failedReads
                ? "partial"
                : "failed"
              : snapshot.eligibleRepositories === 0
                ? "disabled"
                : "success";
          snapshot = {
            ...snapshot,
            state,
            completedAt,
            ...(state === "success" ? { lastSuccess: completedAt } : {}),
          };
          // S4: only a completed pass lets the next boot skip its pass.
          if (state === "success" || state === "partial") {
            await awaitDbWriteGate();
            try {
              deps.db
                .prepare(
                  `INSERT INTO user_config (key, value, updated_at) VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
                )
                .run(OUTCOMES_LAST_PASS_KEY, completedAt, completedAt);
            } catch {
              // Not persisting only costs the next boot one pass.
            }
          }
        }
        return idle;
      } catch {
        if (!timedOut)
          snapshot = {
            ...snapshot,
            state: "failed",
            completedAt: new Date().toISOString(),
            failedStages: ["setup"],
          };
        return idle;
      } finally {
        if (timer) clearTimeout(timer);
        if (activeId === attemptId) {
          if (snapshot.state === "timed-out") snapshot = { ...snapshot, draining: false };
          activeId = null;
          active = null;
        }
      }
    });
    const deadline = new Promise<OutcomesPassResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        snapshot = {
          ...snapshot,
          state: "timed-out",
          completedAt: new Date().toISOString(),
          draining: true,
        };
        error("Outcomes pass timed out; restart daemon if the underlying body never settles.");
        resolve({ ...idle, aborted: true });
      }, deps.deadlineMs ?? OUTCOMES_PASS_DEADLINE_MS);
    });
    active = body;
    void body.then(() => log("Outcomes pass body settled"));
    return {
      accepted: true,
      attemptId,
      snapshot: { ...snapshot },
      promise: Promise.race([body, deadline]),
    };
  }
  return {
    get isRunning() {
      return active !== null;
    },
    snapshot: () => ({
      ...snapshot,
      categories: { ...snapshot.categories },
      failedStages: [...snapshot.failedStages],
    }),
    start: () => {
      const { accepted, attemptId, snapshot: state } = begin();
      return { accepted, attemptId, snapshot: state };
    },
    run: () => begin().promise,
    runAtBoot: (intervalMs = OUTCOMES_POLL_INTERVAL_MS) => {
      let lastMs = Number.NaN;
      try {
        const row = deps.db
          .prepare("SELECT value FROM user_config WHERE key = ?")
          .get(OUTCOMES_LAST_PASS_KEY) as { value: string | null } | undefined;
        lastMs = Date.parse(row?.value ?? "");
      } catch {
        // Unreadable marker: run the pass.
      }
      const ageMs = Date.now() - lastMs;
      if (ageMs >= 0 && ageMs < intervalMs) {
        log("Outcomes boot pass skipped: the last completed pass is within the poll interval");
        return Promise.resolve({ ...idle, skipped: true });
      }
      return begin().promise;
    },
  };
}
