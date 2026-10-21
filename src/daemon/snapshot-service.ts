import type { SnapshotFreshness } from "../query/envelope.js";

/**
 * P3-U4: the one snapshot core behind recs-snapshot.ts and diagnostics-snapshot.ts.
 *
 * - One build per key at a time; callers that arrive while it runs share it.
 * - `invalidate()` (a lifecycle write) bumps the revision and drops every snapshot. A build that
 *   started before it is discarded, so the next read builds fresh (ADOPT-1).
 * - A snapshot is stale on `markStale()` (ingest and detector passes), a new 10-minute bucket, or a
 *   changed `inputsToken`. A stale snapshot is still served while one rebuild runs (ADOPT-1b).
 * - A failed rebuild behind a snapshot is not retried for 60 s unless its `inputsToken` changes; a
 *   failed cold build is reported.
 */
export interface Snapshot<V> {
  value: V;
  /** When the build started reading its inputs. */
  inputsAsOfMs: number;
  /** When the build finished. */
  computedAtMs: number;
}

export type SnapshotPeek<V> =
  | { state: "ready"; snapshot: Snapshot<V>; stale: boolean; recomputing: boolean }
  | { state: "building"; sinceMs: number; step: number }
  | { state: "failed"; error: Error }
  | { state: "cold" };

export interface SnapshotService<K, V> {
  /** Without side effects: the current-revision snapshot, or what is happening instead. */
  peek(key: K): SnapshotPeek<V>;
  /** Every key's snapshot at the current revision, stale or not. */
  values(): V[];
  /** Keys whose build is running with no snapshot to serve meanwhile (a cold build). */
  coldBuilds(): { key: K; sinceMs: number }[];
  /**
   * Start a build for `key`, or join the one running. `revision` is the revision that build
   * started at; its result is kept only if no `invalidate()` came after.
   */
  start(key: K): { task: Promise<void>; revision: number };
  /** Start one rebuild if the snapshot is stale and not backing off a failure. */
  refresh(key: K): void;
  /** Forget a reported cold failure, so the next read builds again. */
  clearFailure(key: K): void;
  invalidate(): void;
  revision(): number;
  markStale(): void;
  stop(): void;
}

const BUCKET_MS = 600_000;
const RETRY_MS = 60_000;

export function createSnapshotService<K, V>(options: {
  /**
   * `onStage` advances the `building` step; builders without stages ignore it. `onStart` re-stamps
   * the inputs token and `inputsAsOfMs` when a gated build actually starts; builders that never call
   * it keep the stamp taken when `start()` queued them.
   */
  build: (key: K, inputsAsOfMs: number, onStage: () => void, onStart: () => void) => Promise<V>;
  /** A cheap token of the build's inputs, read when a build starts and on every peek. */
  inputsToken?: () => string;
  /**
   * Age-gated rules (recs). When `maxAgeMs` is set they replace the 10-minute bucket: a snapshot is
   * stale on `markStale()`, a changed `inputsToken` (at once), a changed `ingestToken` once it is
   * `ingestMinAgeMs` old, or at `maxAgeMs`. Age is `now - inputsAsOfMs`. Trade-off: ingest-derived
   * fields lag by up to `ingestMinAgeMs` (as the bucket did) and clock-derived fields by up to
   * `maxAgeMs`.
   */
  maxAgeMs?: number;
  ingestToken?: () => string;
  ingestMinAgeMs?: number;
  now?: () => number;
}): SnapshotService<K, V> {
  const now = options.now ?? Date.now;
  const snapshots = new Map<
    K,
    Snapshot<V> & {
      revision: number;
      pass: number;
      token: string | undefined;
      ingest: string | undefined;
    }
  >();
  const pending = new Map<
    K,
    { task: Promise<void>; revision: number; sinceMs: number; step: number }
  >();
  const failures = new Map<K, Error>();
  const retryAt = new Map<K, { at: number; token: string | undefined }>();
  let revision = 0;
  let pass = 0;
  let stopped = false;

  function current(key: K) {
    const snapshot = snapshots.get(key);
    return snapshot && snapshot.revision === revision ? snapshot : undefined;
  }

  function isStale(snapshot: {
    inputsAsOfMs: number;
    pass: number;
    token: string | undefined;
    ingest: string | undefined;
  }): boolean {
    if (options.maxAgeMs !== undefined) {
      const age = now() - snapshot.inputsAsOfMs;
      return (
        snapshot.pass !== pass ||
        age >= options.maxAgeMs ||
        (options.inputsToken !== undefined && snapshot.token !== options.inputsToken()) ||
        (options.ingestToken !== undefined &&
          age >= (options.ingestMinAgeMs ?? 0) &&
          snapshot.ingest !== options.ingestToken())
      );
    }
    return (
      snapshot.pass !== pass ||
      Math.floor(snapshot.inputsAsOfMs / BUCKET_MS) !== Math.floor(now() / BUCKET_MS) ||
      (options.inputsToken !== undefined && snapshot.token !== options.inputsToken())
    );
  }

  function start(key: K): { task: Promise<void>; revision: number } {
    const existing = pending.get(key);
    if (existing) return existing;
    const startRevision = revision;
    const startPass = pass;
    let token = options.inputsToken?.();
    let ingest = options.ingestToken?.();
    let inputsAsOfMs = now();
    failures.delete(key);
    const entry = {
      task: Promise.resolve(),
      revision: startRevision,
      sinceMs: inputsAsOfMs,
      step: 0,
    };
    entry.task = options
      .build(
        key,
        inputsAsOfMs,
        () => {
          entry.step += 1;
        },
        () => {
          // A gated build may wait behind other jobs: stamp the inputs it will actually read.
          token = options.inputsToken?.();
          ingest = options.ingestToken?.();
          inputsAsOfMs = now();
        },
      )
      .then(
        (value) => {
          if (stopped || revision !== startRevision) return;
          snapshots.set(key, {
            value,
            inputsAsOfMs,
            computedAtMs: now(),
            revision: startRevision,
            pass: startPass,
            token,
            ingest,
          });
          retryAt.delete(key);
        },
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (!stopped && revision === startRevision) {
            if (current(key)) retryAt.set(key, { at: now() + RETRY_MS, token });
            else failures.set(key, failure);
          }
          throw failure;
        },
      );
    pending.set(key, entry);
    void entry.task
      .finally(() => {
        if (pending.get(key) === entry) pending.delete(key);
      })
      .catch(() => {});
    return entry;
  }

  return {
    peek(key) {
      const snapshot = current(key);
      if (snapshot) {
        return {
          state: "ready",
          snapshot,
          stale: isStale(snapshot),
          recomputing: pending.has(key),
        };
      }
      const building = pending.get(key);
      if (building) return { state: "building", sinceMs: building.sinceMs, step: building.step };
      const error = failures.get(key);
      return error ? { state: "failed", error } : { state: "cold" };
    },
    values() {
      return [...snapshots.values()].filter((s) => s.revision === revision).map((s) => s.value);
    },
    coldBuilds() {
      return [...pending.entries()]
        .filter(([key]) => !current(key))
        .map(([key, entry]) => ({ key, sinceMs: entry.sinceMs }));
    },
    start,
    refresh(key) {
      const snapshot = current(key);
      if (!snapshot || !isStale(snapshot)) return;
      // The back-off holds only while the inputs are the ones the failed build read.
      const backoff = retryAt.get(key);
      if (backoff && now() < backoff.at && backoff.token === options.inputsToken?.()) return;
      void start(key).task.catch(() => {});
    },
    clearFailure(key) {
      failures.delete(key);
    },
    invalidate() {
      revision += 1;
      snapshots.clear();
    },
    revision: () => revision,
    markStale() {
      pass += 1;
    },
    stop() {
      stopped = true;
      snapshots.clear();
      pending.clear();
      failures.clear();
      retryAt.clear();
    },
  };
}

/** A-17: the freshness block for a served snapshot; null when nothing is ready. */
export function freshnessOf(peeked: SnapshotPeek<unknown>): SnapshotFreshness | null {
  if (peeked.state !== "ready") return null;
  return {
    status: peeked.recomputing ? "recomputing" : "ready",
    computed_at: new Date(peeked.snapshot.computedAtMs).toISOString(),
    inputs_as_of: new Date(peeked.snapshot.inputsAsOfMs).toISOString(),
  };
}
