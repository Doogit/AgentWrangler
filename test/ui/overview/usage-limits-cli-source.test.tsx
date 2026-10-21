/** USAGE-CLI: Usage limits card states for the Claude Code /usage reader, and the Settings toggle. */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LimitsModel } from "../../../src/query/limits/types";
import * as client from "../../../src/ui/api/client";
import { mockLimits, mockSettings } from "../../../src/ui/api/fixtures";
import UsageLimitsCard from "../../../src/ui/overview/UsageLimitsCard";
import SettingsPage from "../../../src/ui/settings/SettingsPage";

vi.mock("../../../src/ui/api/client");

const minAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const cliModel = (extra: Partial<LimitsModel> = {}): LimitsModel => ({
  ...mockLimits(),
  source: "cli",
  asOf: minAgo(3),
  ...extra,
});
const NOTICE = "cli-source-notice";
const DISMISS_KEY = "aw.usageCliNoticeDismissed";

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UsageLimitsCard /usage states (USAGE-CLI)", () => {
  it("cli source: source line with age and the disclosure InfoTip, no claude.ai chip", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(cliModel());
    render(<UsageLimitsCard />);
    const line = await screen.findByTestId("limits-source");
    expect(line.textContent).toMatch(/Source: Claude Code \/usage · 3 min ago/);
    expect(screen.getByRole("button", { name: "About the /usage source" })).toBeTruthy();
    expect(screen.queryByText("Exact · claude.ai")).toBeNull();
    expect(screen.getByTestId("limit-row-weekly:fable")).toBeTruthy();
  });

  it("mixed sources: statusline age plus model-row age from per-row source/asOf", async () => {
    const base = mockLimits();
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...base,
      source: "statusline",
      asOf: minAgo(2),
      rows: base.rows.map((r) =>
        r.id.startsWith("weekly:")
          ? { ...r, source: "cli" as const, asOf: minAgo(9) }
          : { ...r, source: "statusline" as const, asOf: minAgo(2) },
      ),
    });
    render(<UsageLimitsCard />);
    const line = await screen.findByTestId("limits-source");
    expect(line.textContent).toMatch(
      /Source: statusline · 2 min ago; model rows: Claude Code \/usage · 9 min ago/,
    );
  });

  it("pending with no rows: 'Reading usage from Claude Code…', no error notice", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...mockLimits(),
      state: "error",
      rows: [],
      stale: false,
      pending: true,
    });
    render(<UsageLimitsCard />);
    const el = await screen.findByTestId("limits-pending");
    expect(el.textContent).toMatch(/Reading usage from Claude Code…/);
    expect(screen.queryByText(/No recent usage reading/)).toBeNull();
  });

  it("stale reading: meters are greyed and show an as-of time", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(cliModel({ stale: true, asOf: minAgo(90) }));
    render(<UsageLimitsCard />);
    const row = await screen.findByTestId("limit-row-session");
    expect(row.getAttribute("style")).toMatch(/opacity: 0\.6/);
    expect(row.textContent).toMatch(/as of/);
    expect((await screen.findByTestId("limits-source")).textContent).toMatch(/90 min ago/);
  });

  it.each([
    ["not_found", /`claude` command was not found/],
    ["outdated", /too old/],
    ["timeout", /took too long/],
    ["parse", /format AgentWrangler understands/],
    ["guard", /did not behave as a free command/],
    ["error", /could not report usage/],
  ] as const)("cliReason %s: plain words under Show details (old reading)", async (reason, re) => {
    vi.mocked(client.fetchLimits).mockResolvedValue(cliModel({ stale: true, cliReason: reason }));
    render(<UsageLimitsCard />);
    const detail = await screen.findByTestId("cli-reason");
    expect(detail.textContent).toMatch(re);
    expect(screen.getByText("Show details")).toBeTruthy();
  });

  it("cliReason in the error notice shares one Show details", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...mockLimits(),
      state: "error",
      rows: [],
      stale: false,
      cliReason: "not_found",
    });
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue({
      state: "not-set-up",
      ageSec: null,
      snippet: "x",
    });
    render(<UsageLimitsCard />);
    expect((await screen.findByTestId("cli-reason")).textContent).toMatch(/was not found/);
    expect(screen.getAllByText("Show details")).toHaveLength(1);
  });

  it("cliReason off with no rows says it is turned off in Settings", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...mockLimits(),
      state: "error",
      rows: [],
      stale: false,
      cliReason: "off",
    });
    render(<UsageLimitsCard />);
    expect((await screen.findByTestId("cli-reason")).textContent).toMatch(/turned off in Settings/);
  });

  it("statusline setup link is worded in the Settings panel as optional", async () => {
    vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue({
      state: "not-set-up",
      ageSec: null,
      snippet: "x",
    });
    render(<SettingsPage />);
    expect(
      await screen.findByText(/Optional: updates on every turn, no background calls/),
    ).toBeTruthy();
  });
});

describe("UsageLimitsCard default-on notice (USAGE-CLI)", () => {
  it("shown while source is cli, with both ways out", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(cliModel());
    render(<UsageLimitsCard />);
    const notice = await screen.findByTestId(NOTICE);
    const hrefs = Array.from(notice.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("#/settings?section=statusline");
    expect(hrefs).toContain("#/settings?section=usage");
  });

  it("hidden when the source is the statusline", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue({ ...mockLimits(), source: "statusline" });
    render(<UsageLimitsCard />);
    await screen.findByTestId("limits-source");
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it("hidden when the reader is turned off", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(cliModel({ cliReason: "off" }));
    render(<UsageLimitsCard />);
    await screen.findByTestId("limit-row-session");
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it("dismiss hides it and remembers in localStorage", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(cliModel());
    render(<UsageLimitsCard />);
    await screen.findByTestId(NOTICE);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId(NOTICE)).toBeNull();
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  it("stays hidden when previously dismissed", async () => {
    window.localStorage.setItem(DISMISS_KEY, "1");
    vi.mocked(client.fetchLimits).mockResolvedValue(cliModel());
    render(<UsageLimitsCard />);
    await screen.findByTestId("limits-source");
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });

  it("renders and dismisses even when localStorage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(client.fetchLimits).mockResolvedValue(cliModel());
    render(<UsageLimitsCard />);
    await screen.findByTestId(NOTICE);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId(NOTICE)).toBeNull();
  });
});

describe("UsageLimitsCard re-poll cadence (USAGE-CLI)", () => {
  it("polls every 10 s while pending, then back to 180 s", async () => {
    vi.useFakeTimers();
    const pendingModel = { ...mockLimits(), state: "error" as const, rows: [], pending: true };
    const doneModel = cliModel();
    const fetchLimits = vi.mocked(client.fetchLimits);
    fetchLimits.mockResolvedValue(pendingModel);
    render(<UsageLimitsCard />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterMount = fetchLimits.mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const afterOne = fetchLimits.mock.calls.length;
    expect(afterOne).toBeGreaterThan(afterMount);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchLimits.mock.calls.length).toBeGreaterThan(afterOne);

    // Reading lands: no longer pending, so 10 s is no longer enough for another poll.
    fetchLimits.mockResolvedValue(doneModel);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("limits-pending")).toBeNull();
    const settled = fetchLimits.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchLimits.mock.calls.length).toBe(settled);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });
    expect(fetchLimits.mock.calls.length).toBeGreaterThan(settled);
  });
});

describe("Settings toggle: Read usage via Claude Code /usage (USAGE-CLI)", () => {
  it("shows on by default with the disclosure, and saves the new value", async () => {
    vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue({
      state: "not-set-up",
      ageSec: null,
      snippet: "x",
    });
    const base = mockSettings();
    vi.mocked(client.saveSettings).mockResolvedValue({
      ...base,
      data: base.data === null ? null : { ...base.data, usage_cli_enabled: false },
    });
    render(<SettingsPage />);
    const box = (await screen.findByLabelText(
      "Read usage via Claude Code /usage",
    )) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getAllByText(/never reads your Claude login/).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(box);
    await waitFor(() =>
      expect(client.saveSettings).toHaveBeenCalledWith({ usage_cli_enabled: false }),
    );
    await waitFor(() => expect(box.checked).toBe(false));
  });
});
