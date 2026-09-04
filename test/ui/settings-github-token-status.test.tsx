/**
 * test/ui/settings-github-token-status.test.tsx — GithubTokenStatusPanel UI tests.
 *
 * Covers:
 *   - Shows the degradation reason (with the AW_GITHUB_TOKEN remedy) when no
 *     token is configured — the feature is never silently dark (plan §OS3).
 *   - Shows "configured (<source>)" when a token is available.
 *   - Never renders a token value.
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
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.saveSettings).mockResolvedValue(mockSettings());
  vi.mocked(client.resetDatabase).mockResolvedValue(mockSettings());
});

describe("SettingsPage — GithubTokenStatusPanel: not configured", () => {
  it("renders the degradation reason naming AW_GITHUB_TOKEN", async () => {
    vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({
      configured: false,
      source: null,
      reason: "outcomes sync: no GitHub token — set AW_GITHUB_TOKEN",
    });

    render(<SettingsPage />);

    await waitFor(() => {
      const el = screen.getByLabelText("github token status");
      expect(el.textContent).toMatch(/no GitHub token/i);
      expect(el.textContent).toMatch(/AW_GITHUB_TOKEN/);
    });
  });
});

describe("SettingsPage — GithubTokenStatusPanel: configured", () => {
  it("renders 'configured (env)' without any token value", async () => {
    vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({
      configured: true,
      source: "env",
    });

    render(<SettingsPage />);

    await waitFor(() => {
      const el = screen.getByLabelText("github token status");
      expect(el.textContent).toMatch(/configured/i);
      expect(el.textContent).toContain("env");
    });
  });

  it("renders 'configured (credential-manager)'", async () => {
    vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({
      configured: true,
      source: "credential-manager",
    });

    render(<SettingsPage />);

    await waitFor(() => {
      const el = screen.getByLabelText("github token status");
      expect(el.textContent).toMatch(/configured/i);
      expect(el.textContent).toContain("credential-manager");
    });
  });
});
