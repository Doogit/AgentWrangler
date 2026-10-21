import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoadProgress from "../../src/ui/shell/LoadProgress";

function setupMatchMedia(prefersReducedMotion: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: prefersReducedMotion && query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  setupMatchMedia(false);
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("LoadProgress", () => {
  it("renders the kicker, step count, stage, and a labeled progressbar", () => {
    render(
      <LoadProgress
        label="Building diagnostics"
        stage="Counting failed and blocked commands"
        step={0}
        steps={4}
        startedAt="1970-01-01T00:00:00.000Z"
        expectedMs={6000}
      />,
    );
    expect(screen.getByText("Building diagnostics")).toBeTruthy();
    expect(screen.getByText("Step 1 of 4")).toBeTruthy();
    expect(
      screen.getByText("Counting failed and blocked commands", {
        selector: ".load-progress-stage",
      }),
    ).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.getAttribute("aria-label")).toBe("Building diagnostics progress");
  });

  it("fills the bar by elapsed ÷ expected, capped at 95%, and shows the elapsed/expected meta", async () => {
    render(
      <LoadProgress
        label="Building diagnostics"
        stage="Counting failed and blocked commands"
        step={1}
        steps={4}
        startedAt="1970-01-01T00:00:00.000Z"
        expectedMs={6000}
      />,
    );
    // The elapsed clock ticks once a second, so advance in whole seconds (a fill between
    // ticks is smoothed by the CSS width transition, not by a sub-second JS value).
    await advance(3000);
    const bar = screen.getByRole("progressbar");
    // aria-valuenow always reports the step count, regardless of the fill basis.
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    const fill = bar.querySelector("span") as HTMLSpanElement;
    expect(fill.style.width).toBe(`${(3000 / 6000) * 100}%`);
    expect(screen.getByText("3 s · usually ~6 s")).toBeTruthy();

    await advance(20_000);
    // Capped at 95% even once elapsed time exceeds the expected duration.
    expect(fill.style.width).toBe("95%");
  });

  it("falls back to step ÷ steps and omits 'usually' when expectedMs is null", () => {
    render(
      <LoadProgress
        label="Building diagnostics"
        stage="Ranking avoidable spend"
        step={2}
        steps={4}
        startedAt="1970-01-01T00:00:00.000Z"
        expectedMs={null}
      />,
    );
    const bar = screen.getByRole("progressbar");
    const fill = bar.querySelector("span") as HTMLSpanElement;
    expect(fill.style.width).toBe("50%");
    expect(screen.queryByText(/usually/)).toBeNull();
    expect(screen.getByText("0 s")).toBeTruthy();
  });

  it("fades the stage label on change, and announces it via aria-live", async () => {
    const { rerender } = render(
      <LoadProgress
        label="Building diagnostics"
        stage="Counting failed and blocked commands"
        step={0}
        steps={4}
        startedAt="1970-01-01T00:00:00.000Z"
        expectedMs={6000}
      />,
    );
    const stageEl = () =>
      screen.getByText(/Counting|Reading detector findings/, { selector: ".load-progress-stage" });
    expect(stageEl().className).not.toContain("load-progress-stage-swap");
    rerender(
      <LoadProgress
        label="Building diagnostics"
        stage="Reading detector findings"
        step={1}
        steps={4}
        startedAt="1970-01-01T00:00:00.000Z"
        expectedMs={6000}
      />,
    );
    expect(stageEl().className).toContain("load-progress-stage-swap");
    await advance(300);
    expect(stageEl().className).not.toContain("load-progress-stage-swap");
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Reading detector findings");
  });

  it("never fades the stage under prefers-reduced-motion", () => {
    setupMatchMedia(true);
    const { rerender } = render(
      <LoadProgress
        label="Building diagnostics"
        stage="Counting failed and blocked commands"
        step={0}
        steps={4}
        startedAt="1970-01-01T00:00:00.000Z"
        expectedMs={6000}
      />,
    );
    rerender(
      <LoadProgress
        label="Building diagnostics"
        stage="Reading detector findings"
        step={1}
        steps={4}
        startedAt="1970-01-01T00:00:00.000Z"
        expectedMs={6000}
      />,
    );
    expect(
      screen.getByText("Reading detector findings", { selector: ".load-progress-stage" }).className,
    ).not.toContain("load-progress-stage-swap");
  });
});
