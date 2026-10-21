/** Parser-health count-based status chip coverage. */

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

function setupParserHealth(filesSeen: number, linesQuarantined: number) {
  const settings = mockSettings();
  if (settings.data === null) throw new Error("settings fixture must have data");
  settings.data = {
    ...settings.data,
    parser_health: {
      ...settings.data.parser_health,
      files_seen: filesSeen,
      lines_quarantined: linesQuarantined,
    },
  };
  vi.mocked(client.fetchSettings).mockResolvedValue(settings);
  vi.mocked(client.saveSettings).mockResolvedValue(settings);
  vi.mocked(client.resetDatabase).mockResolvedValue(settings);
}

describe("SettingsPage — parser-health status chip", () => {
  it.each([
    [0, 0, "No parser data"],
    [100, 3, "Quarantined lines detected"],
    [1, 80, "Quarantined lines detected"],
    [0, 8, "Quarantined lines detected"],
    [100, 0, "No quarantined lines"],
  ])("renders %s/%s as %s without NaN", async (filesSeen, linesQuarantined, status) => {
    setupParserHealth(filesSeen, linesQuarantined);
    render(<SettingsPage />);

    await waitFor(() => {
      const heading = screen.getByRole("heading", { name: /Parser Health/ });
      expect(within(heading).getByText(status)).toBeTruthy();
    });
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("Infinity");
    expect(screen.getByText(/Quarantine rate is unavailable/)).toBeTruthy();
  });
});
