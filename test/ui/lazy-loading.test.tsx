import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DeferredChart from "../../src/ui/shell/DeferredChart";
import LoadBoundary from "../../src/ui/shell/LoadBoundary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deferred chart loading", () => {
  it("waits for the surrounding layout before observing a chart", () => {
    const observe = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = observe;
        disconnect() {}
      },
    );
    const view = render(
      <DeferredChart label="trends" ready={false}>
        <p>Chart</p>
      </DeferredChart>,
    );
    expect(observe).not.toHaveBeenCalled();
    view.rerender(
      <DeferredChart label="trends" ready>
        <p>Chart</p>
      </DeferredChart>,
    );
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("does not import offscreen charts, then loads once when approaching the viewport", async () => {
    let notify: IntersectionObserverCallback = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const load = vi.fn(async () => ({ default: () => <p>Chart ready</p> }));
    const Chart = lazy(load);
    render(
      <DeferredChart label="trends">
        <Chart />
      </DeferredChart>,
    );
    expect(load).not.toHaveBeenCalled();
    await act(async () =>
      notify([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver),
    );
    expect(await screen.findByText("Chart ready")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
  });

  it("supports explicit keyboard-accessible loading without intersection", async () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const Chart = lazy(async () => ({ default: () => <p>Chart ready</p> }));
    render(
      <DeferredChart label="trends">
        <Chart />
      </DeferredChart>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Load trends" }));
    expect(await screen.findByText("Chart ready")).toBeTruthy();
  });
});

describe("chunk loading boundary", () => {
  it("shows loading feedback until the module resolves", async () => {
    let resolve!: (value: { default: () => JSX.Element }) => void;
    const Page = lazy(
      () =>
        new Promise<{ default: () => JSX.Element }>((done) => {
          resolve = done;
        }),
    );
    render(
      <LoadBoundary label="page">
        <Page />
      </LoadBoundary>,
    );
    expect(screen.getByRole("status").textContent).toContain("Loading page");
    await act(async () => resolve({ default: () => <h1>Ready</h1> }));
    expect(screen.getByRole("heading", { name: "Ready" })).toBeTruthy();
  });

  it("exposes rejected imports and lets navigation to a different route recover", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Failed = lazy(async () => {
      throw new Error("Chunk unavailable");
    });
    const view = render(
      <LoadBoundary key="one" label="page">
        <Failed />
      </LoadBoundary>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload dashboard" })).toBeTruthy();
    view.rerender(
      <LoadBoundary key="two" label="page">
        <h1>Other route</h1>
      </LoadBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Other route" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
