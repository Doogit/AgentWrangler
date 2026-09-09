import { useEffect, useRef, useState } from "react";
import type { WorkResponse } from "../../api/work-records-client";
import { type PreparedOperation, WorkRecordsClientError } from "../../api/work-records-client";
export function errorMessage(error: unknown): string {
  return error instanceof WorkRecordsClientError
    ? error.message
    : "Request failed. Check the daemon and retry.";
}

/** One unresolved write at a time; retry never reads the current form or issues new IDs. */
export function useWorkOperation(onComplete: () => void, onRejected: () => void = () => {}) {
  const [busy, setBusy] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pending = useRef<(() => Promise<void>) | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function retry() {
    if (running.current || !pending.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await pending.current();
      pending.current = null;
      if (mounted.current) {
        try {
          onComplete();
        } catch {
          setRefreshFailed(true);
        }
      }
    } catch (err) {
      if (mounted.current) setError(err);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function start<T>(operation: PreparedOperation<T>, accept: (result: WorkResponse<T>) => void) {
    if (pending.current || running.current) return;
    pending.current = async () => {
      const result = await operation.run();
      if (mounted.current) accept(result);
    };
    void retry();
  }
  const rejected =
    error instanceof WorkRecordsClientError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401;
  return {
    busy,
    error,
    start,
    locked: busy || error !== null,
    notice:
      error === null ? (
        refreshFailed ? (
          <p role="alert">
            Change saved, but page evidence could not be refreshed. Reload the page to read current
            evidence.
          </p>
        ) : null
      ) : (
        <div role="alert">
          <p>{errorMessage(error)}</p>
          {rejected ? (
            <button
              className="btn-secondary"
              type="button"
              onClick={() => {
                pending.current = null;
                setError(null);
                onRejected();
              }}
            >
              Reload and review
            </button>
          ) : (
            <button className="btn-secondary" type="button" onClick={() => void retry()}>
              Retry same request
            </button>
          )}
        </div>
      ),
  };
}
