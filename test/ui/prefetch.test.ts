/**
 * test/ui/prefetch.test.ts — P1-U6a test 5: `usePrefetchOnIntent` / `useInViewPrefetch`.
 *
 * Oracle: calls and AbortSignals seen by a query-function mock, under fake timers. The rules
 * come from the plan, not from the hook: pointer-enter after 80 ms or keyboard focus; at most
 * 2 prefetch requests in flight per page; a key still inside its staleTime is not refetched;
 * leaving the trigger aborts the client fetch; paused while /api/status reports backfill (or
 * loop lag over M1); IntersectionObserver only on the "Load more" row.
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PrefetchQuery,
  notePrefetchStatus,
  useInViewPrefetch,
  usePrefetchOnIntent,
} from "../../src/ui/api/prefetch";
import { queryClient } from "../../src/ui/api/query-client";

type Pending = { key: string; signal: AbortSignal; resolve: (v: unknown) => void };
let pending: Pending[] = [];
const queryFn = vi.fn((key: string, signal: AbortSignal) => {
  return new Promise((resolve) => {
    pending.push({ key, signal, resolve });
  });
});

const q = (key: string): PrefetchQuery => ({
  queryKey: ["session", key],
  queryFn: (signal) => queryFn(key, signal),
});

function Row({ id }: { id: string }) {
  const handlers = usePrefetchOnIntent(() => [q(id)]);
  return createElement("button", { type: "button", "data-testid": `row-${id}`, ...handlers }, id);
}

function LoadMore({ cursor }: { cursor: string }) {
  const ref = useInViewPrefetch(() => [q(`next-${cursor}`)]);
  return createElement("div", { ref, "data-testid": "load-more" }, "Load more");
}

// jsdom has no IntersectionObserver: record what is observed and let the test fire entries.
let observed: Element[] = [];
let ioCallback: IntersectionObserverCallback | null = null;
class FakeIO {
  constructor(cb: IntersectionObserverCallback) {
    ioCallback = cb;
  }
  observe(el: Element) {
    observed.push(el);
  }
  unobserve(el: Element) {
    observed = observed.filter((e) => e !== el);
  }
  disconnect() {
    observed = [];
  }
}

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  observed = [];
  ioCallback = null;
  queryFn.mockClear();
  notePrefetchStatus({ sessions: 1 }); // steady state: not paused
  vi.stubGlobal("IntersectionObserver", FakeIO);
});

afterEach(async () => {
  for (const p of pending) p.resolve({});
  cleanup();
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePrefetchOnIntent (P1-U6a test 5)", () => {
  it("hover < 80 ms → 0 requests; hover ≥ 80 ms → 1", async () => {
    const { getByTestId } = render(createElement(Row, { id: "a" }));
    fireEvent.pointerEnter(getByTestId("row-a"));
    act(() => vi.advanceTimersByTime(79));
    fireEvent.pointerLeave(getByTestId("row-a"));
    act(() => vi.advanceTimersByTime(200));
    expect(queryFn).toHaveBeenCalledTimes(0);

    fireEvent.pointerEnter(getByTestId("row-a"));
    act(() => vi.advanceTimersByTime(80));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("keyboard focus prefetches at once", async () => {
    const { getByTestId } = render(createElement(Row, { id: "a" }));
    fireEvent.focus(getByTestId("row-a"));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("5 triggers → at most 2 requests in flight", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const { getByTestId } = render(
      createElement(
        "div",
        null,
        ids.map((id) => createElement(Row, { key: id, id })),
      ),
    );
    for (const id of ids) fireEvent.focus(getByTestId(`row-${id}`));
    await settle();
    expect(pending.filter((p) => !p.signal.aborted)).toHaveLength(2);
    expect(queryFn.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("leaving the trigger aborts the in-flight request's AbortSignal", async () => {
    const { getByTestId } = render(createElement(Row, { id: "a" }));
    fireEvent.pointerEnter(getByTestId("row-a"));
    act(() => vi.advanceTimersByTime(80));
    await settle();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.signal.aborted).toBe(false);
    fireEvent.pointerLeave(getByTestId("row-a"));
    expect(pending[0]?.signal.aborted).toBe(true);
  });

  it("a fresh key (inside its staleTime) → 0 requests", async () => {
    queryClient.setQueryData(["session", "a"], { cached: true });
    const { getByTestId } = render(createElement(Row, { id: "a" }));
    fireEvent.focus(getByTestId("row-a"));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(0);
  });

  it("status reports backfill running (or loop lag over M1) → 0 requests", async () => {
    const { getByTestId } = render(createElement(Row, { id: "a" }));
    notePrefetchStatus({ pipeline: { phase: "reading", files_total: 9, files_completed: 1 } });
    fireEvent.focus(getByTestId("row-a"));
    notePrefetchStatus({ boot_files_total: 40, files_seen: 3 }); // pre-ready boot scan
    fireEvent.blur(getByTestId("row-a"));
    fireEvent.focus(getByTestId("row-a"));
    notePrefetchStatus({ loop_lag: { p50: 2, p99: 120, max: 300 } });
    fireEvent.blur(getByTestId("row-a"));
    fireEvent.focus(getByTestId("row-a"));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(0);

    notePrefetchStatus({ pipeline: { phase: "done" }, loop_lag: { p50: 1, p99: 12, max: 20 } });
    fireEvent.blur(getByTestId("row-a"));
    fireEvent.focus(getByTestId("row-a"));
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("odd status bodies never pause or throw", () => {
    for (const body of [undefined, null, "x", 3, [], {}]) {
      expect(() => notePrefetchStatus(body)).not.toThrow();
    }
  });
});

describe("useInViewPrefetch (P1-U6a test 5)", () => {
  it("scrolling 100 Sessions rows → only the Load more next-cursor request", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `s${i}`);
    render(
      createElement(
        "div",
        null,
        ids.map((id) => createElement(Row, { key: id, id })),
        createElement(LoadMore, { cursor: "50" }),
      ),
    );
    expect(observed).toHaveLength(1); // only the "Load more" row is observed
    // Every observed element scrolls into view.
    act(() => {
      ioCallback?.(
        observed.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
        {} as IntersectionObserver,
      );
    });
    await settle();
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0]?.[0]).toBe("next-50");
  });
});
