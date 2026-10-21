/**
 * test/ui/overview/uipf-f7-remount.test.tsx — UIP-10 animate-once / no-remount coverage (plan F7).
 *
 * Memoization alone is not remount evidence. These tests prove the two behaviours the
 * UIP-10 chart-perf work actually promises:
 *   1. The animated marks animate ONCE on first data, then freeze — an identical data poll
 *      does not reanimate them, and the chart subtree is not remounted (same DOM node).
 *   2. `prefers-reduced-motion` disables the animate-once entirely — marks never animate.
 *
 * Mechanism: recharts is mocked so the animated marks (Bar / Line / Scatter) echo their
 * received `isAnimationActive` both as a DOM attribute and into a per-mark render log.
 * Reduced-motion is driven through `window.matchMedia`, which is what `useReducedMotion` reads.
 * We deliberately assert on the animation flag + node identity, not recharts internals.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import {
  mockFlavorDecomposition,
  mockHeadroomTrendNoLimit,
  mockTrends,
} from "../../../src/ui/api/fixtures";
import FlavorDecomposition from "../../../src/ui/overview/FlavorDecomposition";
import TrendChart from "../../../src/ui/overview/TrendChart";

const h = vi.hoisted(() => ({ animationLog: {} as Record<string, boolean[]> }));

vi.mock("../../../src/ui/api/client");
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  const React = await import("react");
  const passthrough =
    (name: string) =>
    ({ children }: { children?: ReactNode }) =>
      React.createElement("div", { "data-recharts": name }, children);
  const mark =
    (name: string) =>
    ({ isAnimationActive, children }: { isAnimationActive?: boolean; children?: ReactNode }) => {
      const active = Boolean(isAnimationActive);
      const log = h.animationLog[name] ?? [];
      log.push(active);
      h.animationLog[name] = log;
      return React.createElement(
        "div",
        { "data-testid": `mark-${name}`, "data-animation-active": String(active) },
        children,
      );
    };
  return {
    ...actual,
    ResponsiveContainer: passthrough("ResponsiveContainer"),
    BarChart: passthrough("BarChart"),
    LineChart: passthrough("LineChart"),
    ScatterChart: passthrough("ScatterChart"),
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
    ReferenceLine: () => null,
    LabelList: () => null,
    Bar: mark("Bar"),
    Line: mark("Line"),
    Scatter: mark("Scatter"),
  };
});

function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? matches : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function resetAnimationLog() {
  for (const key of Object.keys(h.animationLog)) h.animationLog[key] = [];
}

function allLoggedFlags(): boolean[] {
  return Object.values(h.animationLog).flat();
}

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  resetAnimationLog();
  setReducedMotion(false);
  // NO_LIMIT keeps the headroom sub-panel out of the way (no async Line marks to reason about).
  vi.mocked(client.fetchHeadroomTrend).mockResolvedValue(mockHeadroomTrendNoLimit());
});

describe("UIP-10 — animate-once then freeze (TrendChart)", () => {
  it("animates marks on first data, then freezes them", async () => {
    render(<TrendChart state={{ status: "ok", value: mockTrends({ preset: "7d" }) }} />);

    // Headroom resolves to NO_LIMIT — lets the state effects settle deterministically.
    await waitFor(() =>
      expect(document.querySelector("[data-testid='headroom-no-limit']")).not.toBeNull(),
    );

    // Animated at least once on the first paint...
    expect(allLoggedFlags().some((flag) => flag === true)).toBe(true);
    // ...but every mark currently on screen is frozen (animate-once complete).
    for (const node of document.querySelectorAll("[data-animation-active]")) {
      expect(node.getAttribute("data-animation-active")).toBe("false");
    }
  });

  it("does not reanimate or remount on an identical data poll", async () => {
    const trend = mockTrends({ preset: "7d" });
    const { rerender } = render(<TrendChart state={{ status: "ok", value: trend }} />);

    await waitFor(() =>
      expect(document.querySelector("[data-testid='headroom-no-limit']")).not.toBeNull(),
    );

    const firstBarBefore = document.querySelector("[data-testid='mark-Bar']");
    expect(firstBarBefore).not.toBeNull();

    resetAnimationLog();

    // A fresh, deep-equal poll result (new object identity, identical content).
    const identicalPoll = JSON.parse(JSON.stringify(trend));
    rerender(<TrendChart state={{ status: "ok", value: identicalPoll }} />);
    await waitFor(() =>
      expect(document.querySelector("[data-testid='headroom-no-limit']")).not.toBeNull(),
    );

    // Marks did re-render (guards a vacuous pass) but never re-animated.
    expect(allLoggedFlags().length).toBeGreaterThan(0);
    expect(allLoggedFlags().some((flag) => flag === true)).toBe(false);

    // No remount: the chart's first Bar is the same DOM node it was before the poll.
    expect(document.querySelector("[data-testid='mark-Bar']")).toBe(firstBarBefore);
  });
});

describe("UIP-10 — prefers-reduced-motion disables the animate-once", () => {
  it("TrendChart marks never animate under reduced motion", async () => {
    setReducedMotion(true);
    render(<TrendChart state={{ status: "ok", value: mockTrends({ preset: "7d" }) }} />);

    await waitFor(() =>
      expect(document.querySelector("[data-testid='headroom-no-limit']")).not.toBeNull(),
    );

    expect(allLoggedFlags().length).toBeGreaterThan(0);
    expect(allLoggedFlags().every((flag) => flag === false)).toBe(true);
  });

  it("model-mix (FlavorDecomposition) bar never animates under reduced motion", () => {
    setReducedMotion(true);
    render(
      <FlavorDecomposition
        state={{ status: "ok", value: mockFlavorDecomposition({ preset: "7d" }) }}
      />,
    );

    expect(screen.getByTestId("mark-Bar").getAttribute("data-animation-active")).toBe("false");
    expect((h.animationLog.Bar ?? []).every((flag) => flag === false)).toBe(true);
  });

  it("model-mix bar animates when reduced motion is off (control)", () => {
    setReducedMotion(false);
    render(
      <FlavorDecomposition
        state={{ status: "ok", value: mockFlavorDecomposition({ preset: "7d" }) }}
      />,
    );

    expect(screen.getByTestId("mark-Bar").getAttribute("data-animation-active")).toBe("true");
  });
});
