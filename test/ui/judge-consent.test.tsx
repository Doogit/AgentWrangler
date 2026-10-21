import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredVerdict } from "../../src/judge/judge-service";
import { mockJudgeSetup } from "../../src/ui/api/fixtures";
import JudgeReview from "../../src/ui/judge-setup/JudgeReview";
import JudgeSetupPage from "../../src/ui/judge-setup/JudgeSetupPage";
import type { ReadyConsent } from "../../src/ui/judge-setup/judge-api";
import { FAILURE_COPY } from "../../src/ui/judge-setup/narrative";

const api = vi.hoisted(() => ({
  fetchConsent: vi.fn(),
  fetchStoredVerdict: vi.fn(),
  approveConsent: vi.fn(),
  revokeConsent: vi.fn(),
  saveSources: vi.fn(),
  runJudge: vi.fn(),
  cancelJudge: vi.fn(),
}));
vi.mock("../../src/ui/judge-setup/judge-api", () => api);
const client = vi.hoisted(() => ({ fetchJudgeSetup: vi.fn() }));
vi.mock("../../src/ui/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/api/client")>()),
  ...client,
}));

const HASH = "a".repeat(64);
const PAYLOAD = '{"identity":"[USER] at [EMAIL]","home":"~/repo","url":"[URL]"}';

function consent(over: Partial<ReadyConsent> = {}): ReadyConsent {
  return {
    state: "ready",
    payload: PAYLOAD,
    shapeHash: HASH,
    model: "claude-opus-5-5",
    standing: false,
    disclosures: ["Your Claude account email address", "Your OS name and version"],
    network_env: ["HTTPS_PROXY"],
    extra_names: ["Kev"],
    repos: [
      { path: "~/src/app", included: true },
      { path: "~/src/canary", included: false },
    ],
    ...over,
  };
}

function stored(over: Partial<StoredVerdict> = {}): StoredVerdict {
  return {
    verdict_id: 1,
    created_at: "2026-10-13T10:00:00.000Z",
    snapshot_id: 3,
    payload_hash: HASH,
    model: "claude-opus-5-5",
    cost_usd: 0.31,
    outdated: false,
    verdict: {
      verdict: "Strong setup; one stale rule.",
      findings: [],
      disagreements: [],
      cannot_judge: [],
    },
    ...over,
  };
}

beforeEach(() => {
  api.fetchStoredVerdict.mockResolvedValue({ verdict: null, remembered: false });
  api.fetchConsent.mockResolvedValue(consent());
  api.approveConsent.mockResolvedValue({ status: 200, body: { consentNonce: "n1" } });
  api.runJudge.mockResolvedValue({ status: 200, body: stored() });
  api.revokeConsent.mockResolvedValue({ status: 200, body: { ok: true } });
  api.saveSources.mockResolvedValue({ status: 200, body: { ok: true } });
  api.cancelJudge.mockResolvedValue({ status: 200, body: { cancelled: true } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderReview() {
  return render(<JudgeReview checks={new Map()} activeCaps={new Map()} onVerdict={() => {}} />);
}

async function openConsent() {
  renderReview();
  const button = await screen.findByRole("button", { name: "Judge me" });
  button.focus();
  fireEvent.click(button);
  return { button, dialog: await screen.findByRole("dialog") };
}

describe("consent dialog", () => {
  it("shows the exact payload with redactions marked, disclosures, proxy names, names and repos", async () => {
    const { dialog } = await openConsent();
    const d = within(dialog);
    const pre = dialog.querySelector("pre");
    expect(pre?.textContent).toBe(PAYLOAD);
    expect([...dialog.querySelectorAll("pre mark")].map((m) => m.textContent)).toEqual([
      "[USER]",
      "[EMAIL]",
      "[URL]",
    ]);
    expect(d.getByText("Your Claude account email address")).toBeTruthy();
    expect(d.getByText("HTTPS_PROXY")).toBeTruthy();
    expect(d.getByText("Kev")).toBeTruthy();
    expect((d.getByRole("checkbox", { name: "~/src/app" }) as HTMLInputElement).checked).toBe(true);
    expect((d.getByRole("checkbox", { name: "~/src/canary" }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(d.getByText(/claude-opus-5-5/)).toBeTruthy();
  });

  it("decline sends nothing, leaves the section unchanged and returns focus to Judge me", async () => {
    const { button, dialog } = await openConsent();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.approveConsent).not.toHaveBeenCalled();
    expect(api.runJudge).not.toHaveBeenCalled();
    expect(api.saveSources).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole("button", { name: "Judge me" })).toBeTruthy();
  });

  it("Esc declines", async () => {
    const { dialog } = await openConsent();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.runJudge).not.toHaveBeenCalled();
  });

  it("approve issues a nonce, runs once, and renders the verdict", async () => {
    const { dialog } = await openConsent();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Claude" }));
    expect(await screen.findByText("Strong setup; one stale rule.")).toBeTruthy();
    expect(api.approveConsent).toHaveBeenCalledWith(HASH, false);
    expect(api.runJudge).toHaveBeenCalledTimes(1);
    expect(api.runJudge.mock.calls[0]?.slice(0, 2)).toEqual([HASH, "n1"]);
    expect(screen.getByRole("status").textContent).toMatch(/review is ready/i);
  });

  it("don't ask again is sent with the approval", async () => {
    const { dialog } = await openConsent();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /don't ask again/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Claude" }));
    await screen.findByText("Strong setup; one stale rule.");
    expect(api.approveConsent).toHaveBeenCalledWith(HASH, true);
  });

  it("standing consent for this shape skips the dialog", async () => {
    api.fetchConsent.mockResolvedValue(consent({ standing: true }));
    renderReview();
    fireEvent.click(await screen.findByRole("button", { name: "Judge me" }));
    await screen.findByText("Strong setup; one stale rule.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.runJudge.mock.calls[0]?.slice(0, 2)).toEqual([HASH, null]);
  });

  it("AE6: a changed shape forces the dialog despite don't-ask-again", async () => {
    api.fetchStoredVerdict.mockResolvedValue({ verdict: null, remembered: true });
    api.fetchConsent.mockResolvedValue(consent({ standing: false }));
    renderReview();
    fireEvent.click(await screen.findByRole("button", { name: "Judge me" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(api.runJudge).not.toHaveBeenCalled();
  });

  it("editing names saves them and reloads the payload preview", async () => {
    const { dialog } = await openConsent();
    const d = within(dialog);
    fireEvent.change(d.getByRole("textbox", { name: /add a name/i }), {
      target: { value: "Kevin" },
    });
    fireEvent.click(d.getByRole("button", { name: "Add" }));
    fireEvent.click(d.getByRole("checkbox", { name: "~/src/canary" }));
    api.fetchConsent.mockResolvedValue(
      consent({
        payload: '{"n":"[USER]"}',
        shapeHash: "b".repeat(64),
        extra_names: ["Kev", "Kevin"],
      }),
    );
    fireEvent.click(d.getByRole("button", { name: "Update preview" }));
    await waitFor(() => expect(dialog.querySelector("pre")?.textContent).toBe('{"n":"[USER]"}'));
    expect(api.saveSources).toHaveBeenCalledWith(["Kev", "Kevin"], ["~/src/app", "~/src/canary"]);
    expect(api.approveConsent).not.toHaveBeenCalled();
  });

  it("removing a name is a pending edit until Update preview", async () => {
    const { dialog } = await openConsent();
    const d = within(dialog);
    fireEvent.click(d.getByRole("button", { name: "Remove Kev" }));
    expect((d.getByRole("button", { name: "Send to Claude" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("blocked payload shows the match class and a next step", async () => {
    api.fetchConsent.mockResolvedValue({
      state: "blocked",
      blocked: [{ source: "settings.json", match_class: "provider-key" }],
    });
    renderReview();
    fireEvent.click(await screen.findByRole("button", { name: "Judge me" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("settings.json");
    expect(alert.textContent).toMatch(/API key/i);
    expect(alert.textContent).toMatch(/remove|move/i);
    expect(api.runJudge).not.toHaveBeenCalled();
  });
});

describe("judge states", () => {
  it("409 from run returns to the consent screen with a config-changed message", async () => {
    api.runJudge.mockResolvedValueOnce({ status: 409, body: { error: "needs_consent" } });
    const { dialog } = await openConsent();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Claude" }));
    await waitFor(() => expect(api.fetchConsent).toHaveBeenCalledTimes(2));
    const again = await screen.findByRole("dialog");
    expect(within(again).getByText(/config changed/i)).toBeTruthy();
  });

  it("an expired hold (409 on approve) also re-fetches consent", async () => {
    api.approveConsent.mockResolvedValueOnce({ status: 409, body: { error: "needs_consent" } });
    const { dialog } = await openConsent();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Claude" }));
    await waitFor(() => expect(api.fetchConsent).toHaveBeenCalledTimes(2));
    expect(within(await screen.findByRole("dialog")).getByText(/config changed/i)).toBeTruthy();
    expect(api.runJudge).not.toHaveBeenCalled();
  });

  it("loading shows a working Cancel that aborts the request; a second click sends nothing", async () => {
    let signal: AbortSignal | undefined;
    api.runJudge.mockImplementation((_h: string, _n: string, s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    const { dialog } = await openConsent();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Claude" }));
    const judge = await screen.findByRole("button", { name: "Judging…" });
    expect((judge as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(judge);
    expect(api.runJudge).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toMatch(/sending/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel review" }));
    await waitFor(() => expect(api.cancelJudge).toHaveBeenCalled());
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText(FAILURE_COPY.cancelled as string)).toBeTruthy();
  });

  it.each([
    "payload_too_large",
    "cli_missing",
    "cli_outdated",
    "cli_failed",
    "cli_error",
    "bad_output",
    "invalid_verdict",
  ])("502 %s maps to its copy with Retry", async (code) => {
    api.runJudge.mockResolvedValueOnce({ status: 502, body: { error: code } });
    const { dialog } = await openConsent();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send to Claude" }));
    expect(await screen.findByText(FAILURE_COPY[code] as string)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("no credential: cli_error copy tells the user how to sign in", () => {
    expect(FAILURE_COPY.cli_error).toMatch(/sign in/i);
  });

  it("outdated verdict shows the badge and Judge me again", async () => {
    api.fetchStoredVerdict.mockResolvedValue({
      verdict: stored({ outdated: true }),
      remembered: false,
    });
    renderReview();
    expect(await screen.findByText("Outdated")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Judge me again" })).toBeTruthy();
    expect(screen.getByText("Strong setup; one stale rule.")).toBeTruthy();
  });

  it("revoke turns off don't-ask-again; the next click prompts", async () => {
    api.fetchStoredVerdict.mockResolvedValue({ verdict: stored(), remembered: true });
    renderReview();
    fireEvent.click(await screen.findByRole("button", { name: "Always ask before sending" }));
    await waitFor(() => expect(api.revokeConsent).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Always ask before sending" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Judge me again" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("page integration", () => {
  it("AE4: a verdict claiming a higher tier leaves tier and scores unchanged; disagreements chip the row", async () => {
    const data = mockJudgeSetup();
    client.fetchJudgeSetup.mockResolvedValue(data);
    const check = data.grade.checks[0];
    if (!check) throw new Error("fixture has no checks");
    api.fetchStoredVerdict.mockResolvedValue({
      verdict: stored({
        verdict: {
          verdict: "This is a God-tier setup. Your real score is 100/100.",
          findings: [],
          disagreements: [{ check_id: check.check_id, stance: "too_harsh", reason: "Fine as is." }],
          cannot_judge: [],
        },
      }),
      remembered: false,
    });
    render(<JudgeSetupPage />);
    expect((await screen.findByTestId("judge-tier")).textContent).toBe("Operator");
    await screen.findByText(/God-tier setup/);
    expect(screen.getByTestId("judge-tier").textContent).toBe("Operator");
    expect(document.querySelector(".judge-overall")?.textContent).toContain("66/100");
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /Show checks/ })[0] as HTMLElement);
    });
    const row = document.getElementById(`judge-check-${check.check_id}`) as HTMLElement;
    const chip = within(row).getByText("AI disagrees");
    fireEvent.click(chip);
    expect(within(row).getByText(/Fine as is\./).textContent).toMatch(/result above is unchanged/);
    expect(row.getAttribute("data-result")).toBe(check.result);
  });

  it("a disagreement link scrolls to its row every time it is clicked", async () => {
    const data = mockJudgeSetup();
    client.fetchJudgeSetup.mockResolvedValue(data);
    const check = data.grade.checks[0];
    if (!check) throw new Error("fixture has no checks");
    api.fetchStoredVerdict.mockResolvedValue({
      verdict: stored({
        verdict: {
          verdict: "One quibble.",
          findings: [],
          disagreements: [{ check_id: check.check_id, stance: "too_harsh", reason: "Fine as is." }],
          cannot_judge: [],
        },
      }),
      remembered: false,
    });
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      window.history.replaceState(null, "", "#/judge-setup");
      render(<JudgeSetupPage />);
      await screen.findByText(/One quibble/);
      const link = document.querySelector(
        `a[href="#/judge-setup?check=${check.check_id}"]`,
      ) as HTMLAnchorElement;
      const follow = async () => {
        await act(async () => {
          // jsdom does not navigate on anchor clicks; mirror the browser (no hashchange if unchanged).
          const changed = window.location.hash !== link.getAttribute("href");
          fireEvent.click(link);
          if (changed) {
            window.history.replaceState(null, "", link.getAttribute("href"));
            window.dispatchEvent(new HashChangeEvent("hashchange"));
          }
        });
      };
      await follow();
      await follow();
      const rowId = `judge-check-${check.check_id}`;
      expect(scrolled.filter((id) => id === rowId)).toHaveLength(2);
    } finally {
      Element.prototype.scrollIntoView = orig;
      window.history.replaceState(null, "", "#/");
    }
  });
});
