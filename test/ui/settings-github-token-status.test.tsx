/**
 * test/ui/settings-github-token-status.test.tsx — GithubTokenStatusPanel UI tests.
 *
 * Covers:
 *   - Shows the degradation reason (with the AW_GITHUB_TOKEN remedy) when no
 *     token is configured — the feature is never silently dark (plan §OS3).
 *   - Shows "configured (<source>)" when a token is available.
 *   - Never renders a token value.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "#/settings?section=integrations";
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

describe("SettingsPage — credential recovery", () => {
  it("clears a status-read error after a successful explicit refresh", async () => {
    const empty = {
      state: "never-run" as const,
      attemptId: null,
      startedAt: null,
      completedAt: null,
      lastSuccess: null,
      eligibleRepositories: 0,
      attemptedReads: 0,
      failedReads: 0,
      categories: {},
      failedStages: [],
      draining: false,
    };
    vi.mocked(client.fetchOutcomesStatus)
      .mockRejectedValueOnce(new Error("private"))
      .mockResolvedValueOnce({
        sinceDaemonStart: true,
        sync: empty,
        connection: {
          ...empty,
          repositoryAccess: "untested",
          credentialEpoch: 0,
        },
      });
    vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({ configured: true, source: "env" });
    render(<SettingsPage />);
    await screen.findByText("Could not read outcomes status.");
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByText(/Repository access has not been tested/i);
    expect(screen.queryByText("Could not read outcomes status.")).toBeNull();
  });

  it("clears prior connection success even when the post-refresh status GET fails", async () => {
    const empty = {
      state: "never-run" as const,
      attemptId: null,
      startedAt: null,
      completedAt: null,
      lastSuccess: null,
      eligibleRepositories: 0,
      attemptedReads: 0,
      failedReads: 0,
      categories: {},
      failedStages: [],
      draining: false,
    };
    vi.mocked(client.fetchOutcomesStatus)
      .mockResolvedValueOnce({
        sinceDaemonStart: true,
        sync: empty,
        connection: {
          ...empty,
          state: "success",
          repositoryAccess: "tested",
          credentialEpoch: 0,
        },
      })
      .mockRejectedValueOnce(new Error("private error"));
    vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({ configured: true, source: "env" });
    vi.mocked(client.refreshGithubTokenStatus).mockResolvedValue({
      configured: true,
      source: "env",
      epoch: 1,
    });
    render(<SettingsPage />);
    await screen.findByText(/Connection test: success/);
    fireEvent.click(screen.getByRole("button", { name: /changed the credential/i }));
    await waitFor(() => expect(screen.queryByText(/Connection test: success/)).toBeNull());
    expect(screen.getByText(/Repository access has not been tested/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain("private error");
  });

  it("ignores a status read that settles while an explicit action POST is pending", async () => {
    const empty = {
      state: "never-run" as const,
      attemptId: null,
      startedAt: null,
      completedAt: null,
      lastSuccess: null,
      eligibleRepositories: 0,
      attemptedReads: 0,
      failedReads: 0,
      categories: {},
      failedStages: [],
      draining: false,
    };
    let releaseGet!: (value: Awaited<ReturnType<typeof client.fetchOutcomesStatus>>) => void;
    let releasePost!: (
      value: Awaited<ReturnType<typeof client.startOutcomesConnectionTest>>,
    ) => void;
    vi.mocked(client.fetchOutcomesStatus)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseGet = resolve;
        }),
      )
      .mockResolvedValueOnce({
        sinceDaemonStart: true,
        sync: empty,
        connection: {
          ...empty,
          state: "running",
          attemptId: "attempt",
          repositoryAccess: "untested",
          credentialEpoch: 0,
        },
      });
    vi.mocked(client.startOutcomesConnectionTest).mockReturnValue(
      new Promise((resolve) => {
        releasePost = resolve;
      }),
    );
    vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({ configured: true, source: "env" });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(client.fetchOutcomesStatus).toHaveBeenCalledTimes(1);
    releaseGet({
      sinceDaemonStart: true,
      sync: empty,
      connection: {
        ...empty,
        state: "success",
        repositoryAccess: "tested",
        credentialEpoch: 0,
      },
    });
    await waitFor(() => expect(screen.queryByText(/Connection test: success/)).toBeNull());
    expect(screen.getByText(/Starting operation/i)).toBeTruthy();
    releasePost({ status: 202, attemptId: "attempt" });
    await screen.findByText(/Connection test: running/);
  });

  it("refreshes sibling connection evidence and ignores an older status GET", async () => {
    const empty = {
      state: "never-run" as const,
      attemptId: null,
      startedAt: null,
      completedAt: null,
      lastSuccess: null,
      eligibleRepositories: 0,
      attemptedReads: 0,
      failedReads: 0,
      categories: {},
      failedStages: [],
      draining: false,
    };
    const stale = {
      sinceDaemonStart: true as const,
      sync: empty,
      connection: {
        ...empty,
        state: "success" as const,
        repositoryAccess: "tested" as const,
        credentialEpoch: 0,
      },
    };
    const current = {
      sinceDaemonStart: true as const,
      sync: empty,
      connection: { ...empty, repositoryAccess: "untested" as const, credentialEpoch: 1 },
    };
    let release!: (value: typeof stale) => void;
    vi.mocked(client.fetchOutcomesStatus)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      )
      .mockResolvedValueOnce(current);
    vi.mocked(client.fetchGithubTokenStatus).mockResolvedValue({ configured: true, source: "env" });
    vi.mocked(client.refreshGithubTokenStatus).mockResolvedValue({
      configured: true,
      source: "env",
      epoch: 1,
    });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /changed the credential/i }));
    await screen.findByText(/repository access has not been tested/i);
    release(stale);
    await waitFor(() => expect(screen.queryByText(/Connection test: success/)).toBeNull());
  });

  it("shows request failure and recovers through retry without exposing a secret", async () => {
    vi.mocked(client.fetchGithubTokenStatus)
      .mockRejectedValueOnce(new Error("fake-secret provider detail"))
      .mockResolvedValueOnce({
        configured: false,
        source: null,
        state: "absent",
        code: "github-token-not-found",
      });
    render(<SettingsPage />);
    await screen.findByText(/could not read token status/i);
    expect(document.body.textContent).not.toContain("fake-secret");
    fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
    await screen.findByLabelText("github token status");
  });

  it("rechecks locally and ignores an older status response", async () => {
    let release!: (value: { configured: boolean; source: "env" | null }) => void;
    vi.mocked(client.fetchGithubTokenStatus).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.mocked(client.refreshGithubTokenStatus).mockResolvedValue({
      configured: false,
      source: null,
      state: "absent",
    });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /changed the credential/i }));
    await screen.findByLabelText("github token status");
    release({ configured: true, source: "env" });
    await waitFor(() =>
      expect(screen.getByLabelText("github token status").textContent).not.toContain(
        "configured (env)",
      ),
    );
  });
});
