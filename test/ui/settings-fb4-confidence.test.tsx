/** Settings limit calibration renders its low-confidence status accessibly. */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockCalibrateLimit, mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.saveSettings).mockResolvedValue(mockSettings());
});

describe("SettingsPage - limit calibration confidence", () => {
  it("renders a labeled LOW CONFIDENCE chip for a low-confidence calibration", async () => {
    const calibration = mockCalibrateLimit();
    if (calibration.data === null || !calibration.data.ok) {
      throw new Error("limit calibration fixture must succeed");
    }
    vi.mocked(client.calibrateLimitApi).mockResolvedValue({
      ...calibration,
      data: {
        ...calibration.data,
        confidence: "low",
        provenance: `${calibration.data.provenance} - LOW CONFIDENCE (<10% utilization)`,
      },
    });

    render(<SettingsPage />);
    const calibrate = await screen.findByRole("button", { name: "Calibrate from usage" });
    fireEvent.click(calibrate);

    await waitFor(() => {
      expect(screen.getByRole("status", { name: "LOW CONFIDENCE" })).toBeTruthy();
    });
    expect(document.querySelector(".bfc-chip-low-confidence")?.textContent).toBe("LOW CONFIDENCE");
  });
});
