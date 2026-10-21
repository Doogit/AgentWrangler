/** OV-7b: the usage card points at the statusline fallback only when the API failed and it isn't working. */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import { mockLimits } from "../../../src/ui/api/fixtures";
import UsageLimitsCard from "../../../src/ui/overview/UsageLimitsCard";

vi.mock("../../../src/ui/api/client");

const failed = (state: "error" | "rate-limited" | "signed-out") => {
  const base = mockLimits();
  return { ...base, state, rows: [], stale: false, source: "api" as const };
};
const status = (state: "found" | "stale" | "not-set-up") => ({
  state,
  ageSec: state === "not-set-up" ? null : 60,
  snippet: "agentwrangler statusline",
});
const LINK = /Set up the statusline to see usage limits/;

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("UsageLimitsCard statusline-fallback link (OV-7b)", () => {
  it("API error + not set up -> one link to the settings panel", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(failed("error"));
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status("not-set-up"));
    render(<UsageLimitsCard />);
    const link = await screen.findByRole("link", { name: LINK });
    expect(link.getAttribute("href")).toBe("#/settings?section=statusline");
    expect(screen.getAllByRole("link", { name: LINK })).toHaveLength(1);
  });

  it("API error + stale -> link names the last update, not 'not set up'", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(failed("error"));
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue({ ...status("stale"), ageSec: 7200 });
    render(<UsageLimitsCard />);
    const link = await screen.findByRole("link", {
      name: "Statusline last updated 2 h ago",
    });
    expect(link.getAttribute("href")).toBe("#/settings?section=statusline");
    expect(screen.queryByRole("link", { name: LINK })).toBeNull();
  });

  it("rate-limited with no rows + not set up -> link shown", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(failed("rate-limited"));
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status("not-set-up"));
    render(<UsageLimitsCard />);
    expect(await screen.findByRole("link", { name: LINK })).toBeTruthy();
  });

  it("API error but the statusline is working -> no link", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue(failed("error"));
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status("found"));
    render(<UsageLimitsCard />);
    await waitFor(() => expect(client.fetchStatuslineStatus).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/No recent usage reading/)).toBeTruthy());
    expect(screen.queryByRole("link", { name: LINK })).toBeNull();
  });

  it("API works -> no link, and the status isn't even requested", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue({ ...mockLimits(), source: "api" });
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status("not-set-up"));
    render(<UsageLimitsCard />);
    await waitFor(() => expect(screen.getByTestId("limit-row-session")).toBeTruthy());
    expect(screen.queryByRole("link", { name: LINK })).toBeNull();
    expect(client.fetchStatuslineStatus).not.toHaveBeenCalled();
  });

  it("statusline is the active source -> no link", async () => {
    const base = mockLimits();
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...base,
      state: "rate-limited",
      source: "statusline",
    });
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status("not-set-up"));
    render(<UsageLimitsCard />);
    await screen.findByTestId("limits-source");
    expect(screen.queryByRole("link", { name: LINK })).toBeNull();
  });
});
