/** OV-7b: Settings -> Statusline fallback panel: preview, confirm, install/uninstall, refusal. */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../src/ui/api/client";
import { mockSettings } from "../../src/ui/api/fixtures";
import SettingsPage from "../../src/ui/settings/SettingsPage";

vi.mock("../../src/ui/api/client");

const CMD = `"/n/node" "/a/agentwrangler.js" statusline`;
const OLD = { type: "command", command: "bash ~/.claude/statusline-command.sh" };
const status = (installed: boolean, state: "found" | "not-set-up" = "not-set-up") => ({
  state,
  ageSec: state === "found" ? 30 : null,
  snippet: "agentwrangler statusline",
  installed,
});
const plan = (
  action: "install" | "uninstall",
  before: unknown,
  after: unknown,
  changed = true,
) => ({
  action,
  settingsPath: "C:/Users/x/.claude/settings.json",
  before: before === null ? null : JSON.stringify(before, null, 2),
  after: after === null ? null : JSON.stringify(after, null, 2),
  changed,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.fetchSettings).mockResolvedValue(mockSettings());
});
afterEach(() => cleanup());

const panel = () => screen.getByRole("region", { name: /usage limits from your statusline/i });

describe("Settings statusline install", () => {
  it("not set up: preview first (before/after), nothing written until Confirm", async () => {
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status(false));
    const p = plan("install", OLD, {
      ...OLD,
      command: `${CMD} --wrap 'bash ~/.claude/statusline-command.sh'`,
    });
    vi.mocked(client.fetchStatuslinePreview).mockResolvedValue({ ok: true, plan: p });
    vi.mocked(client.applyStatusline).mockResolvedValue({ ok: true, plan: p });
    render(<SettingsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Install statusline" }));
    await waitFor(() => expect(client.fetchStatuslinePreview).toHaveBeenCalledWith("install"));
    const before = await screen.findByLabelText("statusline entry before");
    const after = screen.getByLabelText("statusline entry after");
    expect(before.textContent).toContain("bash ~/.claude/statusline-command.sh");
    expect(after.textContent).toContain("--wrap");
    expect(client.applyStatusline).not.toHaveBeenCalled();

    fireEvent.click(within(panel()).getByRole("button", { name: "Confirm install" }));
    await waitFor(() => expect(client.applyStatusline).toHaveBeenCalledWith("install", p.before));
  });

  it("Cancel closes the preview without writing", async () => {
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status(false));
    vi.mocked(client.fetchStatuslinePreview).mockResolvedValue({
      ok: true,
      plan: plan("install", null, { type: "command", command: CMD }),
    });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Install statusline" }));
    await screen.findByLabelText("statusline entry after");
    fireEvent.click(within(panel()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("statusline entry after")).toBeNull();
    expect(client.applyStatusline).not.toHaveBeenCalled();
  });

  it("with no existing entry the preview says so", async () => {
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status(false));
    vi.mocked(client.fetchStatuslinePreview).mockResolvedValue({
      ok: true,
      plan: plan("install", null, { type: "command", command: CMD }),
    });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Install statusline" }));
    expect((await screen.findByLabelText("statusline entry before")).textContent).toMatch(/none/i);
  });

  it("already installed: says so and offers Uninstall (not Install)", async () => {
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status(true, "found"));
    const p = plan("uninstall", { type: "command", command: CMD }, null);
    vi.mocked(client.fetchStatuslinePreview).mockResolvedValue({ ok: true, plan: p });
    vi.mocked(client.applyStatusline).mockResolvedValue({ ok: true, plan: p });
    render(<SettingsPage />);
    await screen.findByRole("button", { name: "Uninstall statusline" });
    expect(screen.queryByRole("button", { name: "Install statusline" })).toBeNull();
    expect(panel().textContent).toMatch(/installed/i);

    fireEvent.click(screen.getByRole("button", { name: "Uninstall statusline" }));
    await waitFor(() => expect(client.fetchStatuslinePreview).toHaveBeenCalledWith("uninstall"));
    fireEvent.click(await within(panel()).findByRole("button", { name: "Confirm uninstall" }));
    await waitFor(() => expect(client.applyStatusline).toHaveBeenCalledWith("uninstall", p.before));
  });

  it("unparseable settings.json: shows the reason and offers no Confirm", async () => {
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status(false));
    vi.mocked(client.fetchStatuslinePreview).mockResolvedValue({
      ok: false,
      error: "settings.json is not valid JSON: Unexpected end of JSON input",
    });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Install statusline" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not valid JSON/);
    expect(within(panel()).queryByRole("button", { name: "Confirm install" })).toBeNull();
  });

  it("keeps the manual alternative: the command, not the jq line", async () => {
    vi.mocked(client.fetchStatuslineStatus).mockResolvedValue(status(false));
    render(<SettingsPage />);
    expect((await screen.findByLabelText("statusline snippet")).textContent).toBe(
      "agentwrangler statusline",
    );
    expect(screen.getByRole("button", { name: "Copy the line" })).toBeTruthy();
  });
});
