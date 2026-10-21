import { randomUUID } from "node:crypto";
import type { Db } from "../db/open.js";
import type { TokenResult } from "../outcomes/github/credential.js";
import { GhCliClient } from "../outcomes/github/gh-cli-client.js";
import { type OutcomeFailureCode, failureCode } from "../outcomes/stage-summary.js";
import type { OperationSnapshot, OutcomesPassRunner } from "./outcomes-pass.js";

export interface ConnectionSnapshot extends OperationSnapshot {
  repositoryAccess: "untested" | "tested";
  credentialEpoch: number;
}
export interface ActionResponse {
  status: 202 | 409 | 429;
  attemptId: string | null;
  retryAfterMs?: number;
}
export interface OutcomesControlService {
  snapshot(): { sinceDaemonStart: true; sync: OperationSnapshot; connection: ConnectionSnapshot };
  startSync(): ActionResponse;
  startConnection(): ActionResponse;
  invalidateConnection(): void;
}
const emptyConnection = (epoch: number): ConnectionSnapshot => ({
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
  repositoryAccess: "untested",
  credentialEpoch: epoch,
});
const COOLDOWN_MS = 30_000;
const CONNECTION_DEADLINE_MS = 30_000;

export function createOutcomesControlService(
  db: Db,
  runner: OutcomesPassRunner,
  readToken: () => Promise<TokenResult>,
  createClient: (token: TokenResult) => GhCliClient = (token) => new GhCliClient(token),
  now: () => number = Date.now,
): OutcomesControlService {
  let epoch = 0;
  let connection = emptyConnection(epoch);
  let activeConnection: string | null = null;
  let lastSyncStart = Number.NEGATIVE_INFINITY;
  let lastConnectionStart = Number.NEGATIVE_INFINITY;

  return {
    snapshot: () => ({
      sinceDaemonStart: true,
      sync: runner.snapshot(),
      connection: {
        ...connection,
        categories: { ...connection.categories },
        failedStages: [...connection.failedStages],
      },
    }),
    invalidateConnection: () => {
      epoch++;
      connection = emptyConnection(epoch);
    },
    startSync: () => {
      if (runner.isRunning) return { status: 409, attemptId: runner.snapshot().attemptId };
      const retryAfterMs = COOLDOWN_MS - (now() - lastSyncStart);
      if (retryAfterMs > 0)
        return { status: 429, attemptId: runner.snapshot().attemptId, retryAfterMs };
      const started = runner.start();
      if (!started.accepted) return { status: 409, attemptId: started.attemptId };
      lastSyncStart = now();
      return { status: 202, attemptId: started.attemptId };
    },
    startConnection: () => {
      if (activeConnection !== null) return { status: 409, attemptId: activeConnection };
      const retryAfterMs = COOLDOWN_MS - (now() - lastConnectionStart);
      if (retryAfterMs > 0) return { status: 429, attemptId: connection.attemptId, retryAfterMs };
      const attemptId = randomUUID();
      const attemptEpoch = epoch;
      activeConnection = attemptId;
      lastConnectionStart = now();
      connection = {
        ...emptyConnection(epoch),
        lastSuccess: connection.lastSuccess,
        state: "running",
        attemptId,
        startedAt: new Date(now()).toISOString(),
      };
      let timer: NodeJS.Timeout | null = null;
      let timedOut = false;
      const body = Promise.resolve().then(async () => {
        try {
          const token = await readToken();
          if (epoch !== attemptEpoch || timedOut) return;
          const client = createClient(token);
          if (!client.enabled) {
            connection = {
              ...connection,
              state: "disabled",
              completedAt: new Date(now()).toISOString(),
            };
            return;
          }
          const repo = db
            .prepare(
              "SELECT repo_owner, repo_name FROM workspaces WHERE repo_owner IS NOT NULL AND repo_name IS NOT NULL ORDER BY workspace_id LIMIT 1",
            )
            .get() as { repo_owner: string; repo_name: string } | undefined;
          if (repo === undefined) {
            connection = {
              ...connection,
              state: "disabled",
              completedAt: new Date(now()).toISOString(),
              repositoryAccess: "untested",
            };
            return;
          }
          connection = { ...connection, eligibleRepositories: 1, attemptedReads: 1 };
          const result = await client.testRepositoryAccess(repo.repo_owner, repo.repo_name);
          if (epoch !== attemptEpoch || timedOut) return;
          const completedAt = new Date(now()).toISOString();
          if (result.ok)
            connection = {
              ...connection,
              state: "success",
              completedAt,
              lastSuccess: completedAt,
              repositoryAccess: "tested",
            };
          else {
            const code: OutcomeFailureCode = failureCode(result.reason);
            connection = {
              ...connection,
              state: "failed",
              completedAt,
              failedReads: 1,
              failedStages: ["repository-access"],
              categories: { [code]: 1 },
              repositoryAccess: "tested",
            };
          }
        } catch {
          if (epoch === attemptEpoch && !timedOut)
            connection = {
              ...connection,
              state: "failed",
              completedAt: new Date(now()).toISOString(),
              failedStages: ["setup"],
              categories: { transport: 1 },
            };
        } finally {
          if (timer) clearTimeout(timer);
          if (activeConnection === attemptId) activeConnection = null;
          if (epoch === attemptEpoch && connection.state === "timed-out")
            connection = { ...connection, draining: false };
        }
      });
      timer = setTimeout(() => {
        timedOut = true;
        if (epoch === attemptEpoch)
          connection = {
            ...connection,
            state: "timed-out",
            completedAt: new Date(now()).toISOString(),
            draining: true,
          };
      }, CONNECTION_DEADLINE_MS);
      void body;
      return { status: 202, attemptId };
    },
  };
}
