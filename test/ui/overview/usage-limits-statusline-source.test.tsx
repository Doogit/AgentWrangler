/** OV-7: the card names its source when the rows came from the Claude Code statusline. */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import { mockLimits, mockSettings } from "../../../src/ui/api/fixtures";
import UsageLimitsCard from "../../../src/ui/overview/UsageLimitsCard";
import SettingsPage from "../../../src/ui/settings/SettingsPage";

vi.mock("../../../src/ui/api/client");

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("UsageLimitsCard source line (OV-7)", () => {
  it("statusline source: shows 'Source: your Claude Code statusline · N min ago', no per-model rows", async () => {
    const base = mockLimits();
    vi.mocked(client.fetchLimits).mockResolvedValue({
      ...base,
      source: "statusline",
      asOf: new Date(Date.now() - 7 * 60_000).toISOString(),
      rows: base.rows.filter((r) => r.id === "session" || r.id === "weekly"),
    });
    render(<UsageLimitsCard />);
    const line = await screen.findByTestId("limits-source");
    expect(line.textContent).toMatch(/Source: your Claude Code statusline · 7 min ago/);
    expect(screen.queryByText("Exact · claude.ai")).toBeNull();
  });

  it("api source (or absent): no source line", async () => {
    vi.mocked(client.fetchLimits).mockResolvedValue({ ...mockLimits(), source: "api" });
    render(<UsageLimitsCard />);
    await waitFor(() => expect(screen.getByTestId("limit-row-session")).toBeTruthy());
    expect(screen.queryByTestId("limits-source")).toBeNull();
  });
});

describe("Settings statusline fallback panel (OV-7)", () => {
  it("shows found status with age and the copy snippet", async () => {
    vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue({
      state: "found",
      ageSec: 240,
      snippet: "echo SNIPPET",
    });
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("statusline fallback status").textContent).toMatch(
        /Found — last written 4 min ago/,
      ),
    );
    expect(screen.getByLabelText("statusline snippet").textContent).toBe("echo SNIPPET");
    expect(screen.getByRole("button", { name: "Copy the line" })).toBeTruthy();
  });

  it("shows not set up", async () => {
    vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue({
      state: "not-set-up",
      ageSec: null,
      snippet: "x",
    });
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("statusline fallback status").textContent).toMatch(/Not set up/),
    );
  });
});
