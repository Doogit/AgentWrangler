/**
 * src/daemon/outcomes-pass.ts — the outcomes poll pass, with a hard per-pass deadline.
 *
 * Extracted from daemon/index.ts (M-batch task 4) so the skip-guard + deadline
 * logic is deterministically unit-testable without booting the daemon.
 *
 * Why: a bare `outcomesRunning` boolean prevents poll overlap but a HUNG pass
 * (e.g. a wedged `gh` subprocess pipe) would block ALL future polls forever.
 * The runner races the pass body against a hard total deadline (default
 * 15 minutes): on breach it logs clearly and — crucially — always resets the
 * running flag in a `finally` so subsequent polls resume. The abandoned body's
 * remaining I/O may still settle in the background; that is safe because every
 * DB write in the pass is transactional/upsert-based (idempotent), so a
 * late-finishing body can only re-apply the same rows.
 *
 * JS cannot preempt a hung await; "abort" here means: stop WAITING for the
 * pass and un-block the poll cadence. This is the honest best-effort bound.
 */

import type { Db } from "../db/open.js";
import type { GithubClient } from "../outcomes/github/client.js";
import type { TokenResult } from "../outcomes/github/credential.js";

/** Hard total wall-clock budget for ONE outcomes pass. */
export const OUTCOMES_PASS_DEADLINE_MS = 15 * 60 * 1000;

/** Injectable steps of one outcomes pass (wired by daemon/index.ts at boot). */
export interface OutcomesPassDeps {
  db: Db;
  /** Context-probe step (runs first; expected to be internally guarded). */
  probe: () => void;
  readToken: () => Promise<TokenResult>;
  createClient: (token: TokenResult) => GithubClient;
  sync: (db: Db, client: GithubClient) => Promise<void>;
  link: (db: Db, client: GithubClient) => Promise<void>;
  derive: (db: Db) => void;
  findings: (db: Db, client: GithubClient) => Promise<void>;
  /** Log/error sinks (default console). Injectable for tests. */
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  /** Total-pass deadline override (tests use small values). */
  deadlineMs?: number;
}

export interface OutcomesPassResult {
  /** True when skipped because a previous pass was still running. */
  skipped: boolean;
  /** True when the pass short-circuited (GitHub token not configured). */
  disabled: boolean;
  /** True when the hard deadline fired and the pass was abandoned. */
  aborted: boolean;
}

export interface OutcomesPassRunner {
  run(): Promise<OutcomesPassResult>;
  /** Whether a pass is currently in flight (for tests/health surfaces). */
  readonly isRunning: boolean;
}

const IDLE_RESULT: OutcomesPassResult = { skipped: false, disabled: false, aborted: false };

class DeadlineError extends Error {}

export function createOutcomesPassRunner(deps: OutcomesPassDeps): OutcomesPassRunner {
  let running = false;
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const error = deps.error ?? ((msg: string) => console.error(msg));
  const deadlineMs = deps.deadlineMs ?? OUTCOMES_PASS_DEADLINE_MS;

  return {
    get isRunning(): boolean {
      return running;
    },

    async run(): Promise<OutcomesPassResult> {
      if (running) {
        log("Outcomes: skipping poll — previous pass still running");
        return { ...IDLE_RESULT, skipped: true };
      }
      running = true;

      let timer: NodeJS.Timeout | null = null;
      try {
        const body = (async (): Promise<OutcomesPassResult> => {
          // Re-probe context inventory on the same cadence as outcomes.
          deps.probe();

          const tokenResult = await deps.readToken();
          const client = deps.createClient(tokenResult);
          if (!client.enabled) {
            const reason = tokenResult.ok
              ? "ok"
              : (tokenResult as { ok: false; reason: string }).reason;
            log(`Outcomes: GitHub token not configured (${reason}) — outcomes pass skipped`);
            return { ...IDLE_RESULT, disabled: true };
          }

          await deps.sync(deps.db, client);
          await deps.link(deps.db, client);
          deps.derive(deps.db);
          await deps.findings(deps.db, client);
          log("Outcomes: sync+link+derive+findings pass complete");
          return IDLE_RESULT;
        })();

        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DeadlineError("outcomes pass deadline")), deadlineMs);
        });

        return await Promise.race([body, deadline]);
      } catch (e: unknown) {
        if (e instanceof DeadlineError) {
          error(
            `Outcomes pass exceeded its ${Math.round(deadlineMs / 60_000)}-min hard deadline — abandoning the pass; the running flag is cleared so the next poll resumes. In-flight reads may still settle in the background; DB writes are transactional/upsert-based and stay consistent.`,
          );
          return { ...IDLE_RESULT, aborted: true };
        }
        error(`Outcomes pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        return IDLE_RESULT;
      } finally {
        if (timer !== null) clearTimeout(timer);
        // ALWAYS reset — this is the whole point of the deadline: a hung pass
        // must never wedge the poll cadence forever.
        running = false;
      }
    },
  };
}
