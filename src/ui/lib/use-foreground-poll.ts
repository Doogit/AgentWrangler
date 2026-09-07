import { useEffect, useRef } from "react";

type Subscriber = { success: (value: unknown) => void; error: (error: unknown) => void };
type PollGroup = {
  subscribers: Set<Subscriber>;
  stop: () => void;
  lastValue?: { value: unknown };
  lastError?: { error: unknown } | undefined;
};
const groups = new Map<(signal: AbortSignal) => Promise<unknown>, Map<number, PollGroup>>();

/** Share foreground polling by request and cadence; never overlap or poll in background. */
export function useForegroundPoll<T>(
  request: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  onSuccess: (value: T) => void,
  onError: (error: unknown) => void,
): void {
  const callbacks = useRef({ request, onSuccess, onError });
  useEffect(() => {
    callbacks.current = { request, onSuccess, onError };
  });

  useEffect(() => {
    const subscriber: Subscriber = {
      success: (value) => callbacks.current.onSuccess(value as T),
      error: (error) => callbacks.current.onError(error),
    };
    let cadences = groups.get(request);
    if (!cadences) {
      cadences = new Map();
      groups.set(request, cadences);
    }
    const existing = cadences.get(intervalMs);
    if (existing) {
      existing.subscribers.add(subscriber);
      if (existing.lastValue) subscriber.success(existing.lastValue.value);
      if (existing.lastError) subscriber.error(existing.lastError.error);
      return () => {
        existing.subscribers.delete(subscriber);
        if (existing.subscribers.size === 0) existing.stop();
      };
    }
    const subscribers = new Set([subscriber]);
    const group: PollGroup = { subscribers, stop: () => {} };
    let disposed = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resumePending = false;
    const available = () => document.visibilityState !== "hidden" && navigator.onLine !== false;

    const poll = async () => {
      if (disposed || controller || !available()) return;
      const current = new AbortController();
      controller = current;
      try {
        const value = await request(current.signal);
        if (!disposed && !current.signal.aborted) {
          group.lastValue = { value };
          group.lastError = undefined;
          for (const reader of subscribers) reader.success(value);
        }
      } catch (error) {
        if (!disposed && !current.signal.aborted) {
          group.lastError = { error };
          for (const reader of subscribers) reader.error(error);
        }
      } finally {
        controller = undefined;
        if (!disposed && available()) {
          timer = setTimeout(() => void poll(), resumePending ? 0 : intervalMs);
        }
        resumePending = false;
      }
    };

    const activityChanged = () => {
      clearTimeout(timer);
      if (!available()) {
        controller?.abort();
      } else if (controller) {
        resumePending = true;
      } else {
        void poll();
      }
    };
    document.addEventListener("visibilitychange", activityChanged);
    window.addEventListener("online", activityChanged);
    window.addEventListener("offline", activityChanged);
    const stop = () => {
      disposed = true;
      cadences.delete(intervalMs);
      if (cadences.size === 0) groups.delete(request);
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", activityChanged);
      window.removeEventListener("online", activityChanged);
      window.removeEventListener("offline", activityChanged);
    };
    group.stop = stop;
    cadences.set(intervalMs, group);
    void poll();
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) stop();
    };
  }, [intervalMs, request]);
}
