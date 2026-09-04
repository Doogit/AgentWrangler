import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.saveSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.resetDatabase).mockResolvedValue(mockSettings());
});

describe("SettingsPage — experimental actions", () => {
  it("renders the experimental-actions toggle off by default and persists it when enabled", async () => {
    render(<SettingsPage />);

    const toggle = await screen.findByRole("checkbox", { name: "Experimental actions" });
    expect((toggle as HTMLInputElement).checked).toBe(false);

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(window.localStorage.getItem("aw-experimental-actions")).toBe("1");
      expect(
        (screen.getByRole("checkbox", { name: "Experimental actions" }) as HTMLInputElement)
          .checked,
      ).toBe(true);
    });
  });
});
