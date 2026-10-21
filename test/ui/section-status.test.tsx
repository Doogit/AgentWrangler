import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SectionEdge,
  SectionStatus,
  buildingMeta,
  edgeFillPct,
} from "../../src/ui/shell/SectionStatus";

const START = "1970-01-01T00:00:00.000Z";

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("buildingMeta / edgeFillPct", () => {
  it("elapsed with the usual time, or without it before the first build", () => {
    expect(buildingMeta(12_400, 20_000)).toBe("12 s · usually ~20 s");
    expect(buildingMeta(12_400, null)).toBe("12 s");
    expect(buildingMeta(12_400, undefined)).toBe("12 s");
  });

  it("past 2× usual reads 'taking longer than usual' and sweeps", () => {
    expect(buildingMeta(40_000, 20_000)).toBe("40 s · usually ~20 s");
    expect(buildingMeta(74_000, 20_000)).toBe("74 s · taking longer than usual");
    expect(edgeFillPct(74_000, 20_000)).toBeNull();
  });

  it("fills by elapsed ÷ usual, capped at 95%; sweeps with no estimate", () => {
    expect(edgeFillPct(10_000, 20_000)).toBe(50);
    expect(edgeFillPct(30_000, 20_000)).toBe(95);
    expect(edgeFillPct(10_000, null)).toBeNull();
  });
});

describe("SectionStatus", () => {
  it("shows the building line only after 1 s, then ticks", async () => {
    render(
      <SectionStatus
        load={{
          kind: "building",
          label: "Building recommendations",
          startedAt: START,
          expectedMs: 20_000,
        }}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    await advance(1_000);
    expect(screen.getByRole("status").textContent).toBe(
      "Building recommendations1 s · usually ~20 s",
    );
    await advance(11_000);
    expect(screen.getByText("12 s · usually ~20 s")).toBeTruthy();
  });

  it("a build that has not started yet shows no line", async () => {
    render(<SectionStatus load={{ kind: "building", label: "Building recommendations" }} />);
    await advance(5_000);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("slow builds stay a status (not an alert) with data-slow", async () => {
    render(
      <SectionStatus
        load={{
          kind: "building",
          label: "Building recommendations",
          startedAt: START,
          expectedMs: 20_000,
        }}
      />,
    );
    await advance(74_000);
    const line = screen.getByRole("status");
    expect(line.getAttribute("data-slow")).toBe("true");
    expect(line.textContent).toContain("74 s · taking longer than usual");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refreshing shows the 'Updating · as of' chip", () => {
    vi.setSystemTime(3 * 60_000);
    render(<SectionStatus load={{ kind: "refreshing", asOf: START }} />);
    expect(screen.getByText("Updating · as of 3m ago")).toBeTruthy();
  });

  it("null renders nothing", () => {
    const { container } = render(<SectionStatus load={null} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("SectionEdge", () => {
  const edge = (container: HTMLElement) => container.querySelector(".section-edge") as HTMLElement;

  it("off before 1 s, then fills by elapsed ÷ usual", async () => {
    const { container } = render(
      <SectionEdge load={{ kind: "building", label: "x", startedAt: START, expectedMs: 20_000 }} />,
    );
    expect(edge(container).dataset.on).toBe("false");
    await advance(10_000);
    expect(edge(container).dataset.on).toBe("true");
    expect(edge(container).dataset.mode).toBe("fill");
    expect((edge(container).firstElementChild as HTMLElement).style.width).toBe("50%");
  });

  it("sweeps while refreshing and when no estimate is known", async () => {
    const refreshing = render(<SectionEdge load={{ kind: "refreshing", asOf: START }} />);
    expect(edge(refreshing.container).dataset.on).toBe("true");
    expect(edge(refreshing.container).dataset.mode).toBe("sweep");
    cleanup();
    const first = render(<SectionEdge load={{ kind: "building", label: "x", startedAt: START }} />);
    await advance(2_000);
    expect(edge(first.container).dataset.mode).toBe("sweep");
  });

  it("off when there is nothing loading", () => {
    const { container } = render(<SectionEdge load={null} />);
    expect(edge(container).dataset.on).toBe("false");
  });
});
