/**
 * test/ui/settings-oauth-status.test.tsx — OAuthStatusPanel UI tests.
 *
 * Covers:
 *   - Shows "not signed in" when not authenticated (with reason)
 *   - Shows "authenticated as <tier>" when authenticated
 *   - Panel is present within the SettingsPage
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  // Provide defaults for all non-oauth mocks so SettingsPage renders.
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.saveSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.resetDatabase).mockResolvedValue(mockSettings());
});

describe("SettingsPage — OAuthStatusPanel: not authenticated", () => {
  it("renders a 'not signed in' message with the reason from the daemon", async () => {
    vi.mocked(client.fetchOAuthStatus).mockResolvedValue({
      authenticated: false,
      tier: null,
      reason: "Credentials file not found — re-login to Claude Code.",
    });

    render(<SettingsPage />);

    await waitFor(() => {
      const el = screen.getByLabelText("oauth reader status");
      expect(el.textContent).toMatch(/not signed in/i);
      expect(el.textContent).toMatch(/re-login to claude code/i);
    });
  });
});

describe("SettingsPage — OAuthStatusPanel: authenticated", () => {
  it("renders 'authenticated as <tier>' when the reader has a valid credential", async () => {
    vi.mocked(client.fetchOAuthStatus).mockResolvedValue({
      authenticated: true,
      tier: "max_5x",
    });

    render(<SettingsPage />);

    await waitFor(() => {
      const el = screen.getByLabelText("oauth reader status");
      expect(el.textContent).toMatch(/authenticated as/i);
      expect(el.textContent).toContain("max_5x");
    });
  });

  it("shows 'unknown tier' when authenticated but tier is null", async () => {
    vi.mocked(client.fetchOAuthStatus).mockResolvedValue({
      authenticated: true,
      tier: null,
    });

    render(<SettingsPage />);

    await waitFor(() => {
      const el = screen.getByLabelText("oauth reader status");
      expect(el.textContent).toMatch(/authenticated as/i);
      expect(el.textContent).toMatch(/unknown tier/i);
    });
  });
});
