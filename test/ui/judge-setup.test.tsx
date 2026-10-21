import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JudgeSetupResponse } from "../../src/query/api/judge-setup";
import { mockJudgeSetup } from "../../src/ui/api/fixtures";
import JudgeSetupPage from "../../src/ui/judge-setup/JudgeSetupPage";
import { buildShareCard } from "../../src/ui/judge-setup/share-card";

const client = vi.hoisted(() => ({ fetchJudgeSetup: vi.fn() }));
vi.mock("../../src/ui/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/api/client")>()),
  ...client,
}));
vi.mock("../../src/ui/judge-setup/judge-api", () => ({
  fetchStoredVerdict: () => Promise.resolve({ verdict: null, remembered: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function load(data: JudgeSetupResponse) {
  client.fetchJudgeSetup.mockResolvedValue(data);
  return render(<JudgeSetupPage />);
}

const SECRETS = {
  path: "D:\\work\\secret-workspace\\.claude\\settings.json",
  workspace: "acme-payments-monorepo",
  config: "Bash(rm -rf *)",
};

describe("JudgeSetupPage", () => {
  it("renders tier, score, next-tier items, dollar gap with its label and no delta on first run", async () => {
    const { container } = load(mockJudgeSetup());
    expect((await screen.findByTestId("judge-tier")).textContent).toBe("Operator");
    expect(document.querySelector(".judge-overall")?.textContent).toContain("66/100");
    expect(screen.getByTestId("judge-gap").textContent).toContain("$18.40/wk");
    expect(screen.getByTestId("judge-gap").textContent).toContain("measured items only");
    expect(screen.queryByTestId("judge-delta")).toBeNull();
    // InfoTip on tier, overall, category, dollar gap.
    for (const name of [
      "What the tier means",
      "What the overall score means",
      "What the Context hygiene score means",
      "What the dollar gap means",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(container.querySelectorAll(".judge-category")).toHaveLength(1);
  });

  it("shows a skeleton while the grade loads", () => {
    client.fetchJudgeSetup.mockReturnValue(new Promise(() => {}));
    const { container } = render(<JudgeSetupPage />);
    expect(container.querySelector('[data-section-status="pending"]')).toBeTruthy();
    expect(container.querySelector(".skeleton")).toBeTruthy();
  });

  it("shows loading status text, then a still-working line after 5 s", () => {
    vi.useFakeTimers();
    try {
      client.fetchJudgeSetup.mockReturnValue(new Promise(() => {}));
      render(<JudgeSetupPage />);
      const status = screen.getByRole("status");
      expect(status.textContent).toContain("Rating your setup…");
      expect(status.textContent).not.toContain("Still working");
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByRole("status").textContent).toContain("Still working");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the page Rate my setup and words the next-tier items as problem, action and evidence", async () => {
    const data = mockJudgeSetup();
    const base = data.rubric.checks[0];
    if (!base) throw new Error("fixture");
    data.rubric.checks = [
      ...data.rubric.checks,
      {
        ...base,
        check_id: "verify_test_loop",
        statement: "Run your tests after every edit.",
      },
    ];
    load(data);
    expect(await screen.findByRole("heading", { level: 1, name: "Rate my setup" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /To reach 'Conductor' level/ })).toBeTruthy();
    const items = Array.from(document.querySelectorAll(".judge-next-item"));
    expect(items).toHaveLength(2);
    const second = items[1] as HTMLElement;
    expect(second.textContent).toContain("The problem");
    expect(second.textContent).toContain("What to do");
    expect(second.textContent).toContain(
      "Start a fresh session (or run /clear) between unrelated tasks.",
    );
    expect(second.textContent).toContain("What we saw");
    expect(within(items[0] as HTMLElement).getByText("Blocks this level")).toBeTruthy();
    expect(
      within(items[0] as HTMLElement).getByRole("button", { name: "What Blocks this level means" }),
    ).toBeTruthy();
    expect(
      within(items[0] as HTMLElement).getByText(/How to fix it \(Claude Code docs\)/),
    ).toBeTruthy();
    expect(within(second).getByText("See the fix →")).toBeTruthy();
  });

  it("omits the dollar-gap sentence when there is no figure", async () => {
    const data = mockJudgeSetup();
    if (data.dollars.next_tier_gap) data.dollars.next_tier_gap.dollars_per_week = null;
    load(data);
    await screen.findByTestId("judge-tier");
    expect(screen.queryByTestId("judge-gap")).toBeNull();
    expect(document.body.textContent).not.toContain("No dollar figure");
    expect(screen.queryByRole("button", { name: "What the dollar gap means" })).toBeNull();
  });

  it("names the settings files that hold an allow-all Bash rule in its What we saw line", async () => {
    const data = mockJudgeSetup();
    const base = data.grade.checks[0];
    if (!base) throw new Error("fixture");
    data.grade.checks = [
      ...data.grade.checks,
      { ...base, check_id: "no_allow_all_bash", result: "FAIL", value: 2, needs: null },
    ];
    const next = data.grade.next_tier;
    const item = next?.items[0];
    if (!next || !item) throw new Error("fixture");
    next.items = [{ ...item, kind: "cap", check_id: "no_allow_all_bash" }];
    data.allow_all_bash_files = [
      "~/.claude/settings.json",
      "C:\\src\\demo-app\\.claude\\settings.json",
    ];
    load(data);
    await screen.findByTestId("judge-tier");
    const row = document.querySelector(".judge-next-item") as HTMLElement;
    expect(
      within(row).getByText(
        "2 allow-all Bash rules found in ~/.claude/settings.json, C:\\src\\demo-app\\.claude\\settings.json",
      ),
    ).toBeTruthy();
  });

  it("spells out the fix steps under What to do when the check has them", async () => {
    const data = mockJudgeSetup();
    const next = data.grade.next_tier;
    const item = next?.items[0];
    const base = data.rubric.checks[0];
    if (!next || !item || !base) throw new Error("fixture");
    next.items = [{ ...item, kind: "cap", check_id: "no_allow_all_bash" }];
    data.rubric.checks = [
      ...data.rubric.checks,
      {
        ...base,
        check_id: "no_allow_all_bash",
        statement: "Scope allow rules.",
        how_to: ["Use auto mode.", "Add narrow rules."],
      },
    ];
    load(data);
    await screen.findByTestId("judge-tier");
    const row = document.querySelector(".judge-next-item") as HTMLElement;
    const steps = within(row).getByTestId("judge-howto");
    expect(steps.tagName).toBe("OL");
    expect(Array.from(steps.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "Use auto mode.",
      "Add narrow rules.",
    ]);
  });

  it("says the dollar figures are still loading only while the server marks them pending", async () => {
    load(mockJudgeSetup());
    await screen.findByTestId("judge-tier");
    expect(screen.queryByTestId("judge-dollars-pending")).toBeNull();
    cleanup();
    load({ ...mockJudgeSetup(), dollars_pending: true });
    expect((await screen.findByTestId("judge-dollars-pending")).textContent).toContain(
      "Reload in a few minutes",
    );
  });

  it("lays out the rubric as a tier ladder, weight bars and gate cards", async () => {
    const data = mockJudgeSetup();
    load(data);
    await screen.findByTestId("judge-tier");
    expect(document.querySelectorAll(".judge-ladder-step")).toHaveLength(
      data.rubric.tier_names.length,
    );
    expect(document.querySelectorAll(".judge-weights .meter")).toHaveLength(
      data.rubric.categories.length,
    );
    expect(document.querySelectorAll(".judge-gate")).toHaveLength(data.rubric.gates.length);
    expect(screen.getByRole("button", { name: "What the category weights mean" })).toBeTruthy();
  });

  it("shows AsyncErrorState with a working retry when the API fails", async () => {
    client.fetchJudgeSetup.mockRejectedValueOnce(new Error("boom"));
    client.fetchJudgeSetup.mockResolvedValueOnce(mockJudgeSetup());
    render(<JudgeSetupPage />);
    const retry = await screen.findByRole("button", { name: "Retry setup grade" });
    expect(screen.queryByText("boom")).toBeNull();
    fireEvent.click(retry);
    expect((await screen.findByTestId("judge-tier")).textContent).toBe("Operator");
    expect(client.fetchJudgeSetup).toHaveBeenCalledTimes(2);
  });

  it("floors the headline score so it never reads as the next tier's floor", async () => {
    const data = mockJudgeSetup();
    data.grade.overall = 59.6;
    data.grade.overall_before_hold = 59.6;
    data.grade.tier_by_score = "Practitioner";
    data.grade.tier = "Practitioner";
    load(data);
    await screen.findByTestId("judge-tier");
    expect(document.querySelector(".judge-overall")?.textContent).toContain("59/100");
  });

  it("renders the capped state with the reason and the uncapped score, not as insufficient data", async () => {
    const data = mockJudgeSetup();
    data.grade.overall = 59;
    data.grade.overall_before_hold = 92;
    data.grade.tier_by_score = "God-tier";
    data.grade.tier = "Practitioner";
    data.grade.caps = [
      {
        check_id: "bash_allow_all",
        tier: "Practitioner",
        reason: "Bash is allowed everywhere",
        binding: true,
      },
    ];
    load(data);
    await screen.findByTestId("judge-tier");
    const banner = document.querySelector(".judge-banner-capped");
    expect(banner?.textContent).toContain("Capped at Practitioner");
    expect(banner?.textContent).toContain("Bash is allowed everywhere");
    // Headline shows the held score; the banner explains the before-hold score.
    expect(document.querySelector(".judge-overall")?.textContent).toContain("59/100");
    expect(banner?.textContent).toContain(
      "Your score of 92 would earn God-tier, but 1 security issue holds you at Practitioner, so your score is shown as 59.",
    );
    expect(screen.queryByText("Insufficient data")).toBeNull();
    // The overall meter wears the awarded (capped) tier's color, same as the tier chip.
    expect(screen.getByTestId("judge-tier-chip").getAttribute("data-tone")).toBe("amber");
    expect(document.querySelector(".judge-headline")?.getAttribute("data-tone")).toBe("amber");
  });

  it("renders the no-tier state with category scores and data-needed items but no tier or overall score", async () => {
    const data = mockJudgeSetup();
    data.grade.tier = null;
    data.grade.tier_by_score = null;
    data.grade.overall = null;
    data.grade.next_tier = null;
    data.grade.coverage = 0.3;
    data.grade.data_needed = {
      message: "Not enough of the rubric has data yet",
      items: ["Run 20 more sessions", "Use a subagent once"],
    };
    data.grade.categories = [
      ...data.grade.categories,
      {
        category: "delegation",
        label: "Delegation",
        weight: 2,
        status: "insufficient-data",
        score: null,
        scored_checks: 0,
        total_checks: 3,
      },
    ];
    load(data);
    expect(await screen.findByTestId("judge-no-tier")).toBeTruthy();
    expect(screen.queryByTestId("judge-tier")).toBeNull();
    expect(screen.queryByText(/overall/)).toBeNull();
    expect(screen.getByText("Run 20 more sessions")).toBeTruthy();
    expect(screen.getByText("Context hygiene: 62/100")).toBeTruthy();
    const excluded = document.querySelector('.judge-category[data-status="insufficient-data"]');
    expect(excluded?.textContent).toContain("Insufficient data");
    expect(
      within(excluded as HTMLElement).getByRole("button", { name: "What insufficient data means" }),
    ).toBeTruthy();
  });

  it("falls back to the citation when a check has no dollar figure, and links the rec when it has one", async () => {
    const data = mockJudgeSetup();
    data.grade.categories = [
      ...data.grade.categories,
      {
        category: "verification_practice",
        label: "Verification practice",
        weight: 3,
        status: "scored",
        score: 45,
        scored_checks: 2,
        total_checks: 2,
      },
    ];
    const rubricFirst = data.rubric.checks[0];
    if (!rubricFirst) throw new Error("fixture");
    data.rubric.checks = [
      ...data.rubric.checks,
      { ...rubricFirst, check_id: "verify_test_loop", category: "verification_practice" },
    ];
    const { container } = load(data);
    await screen.findByTestId("judge-tier");
    const rowsOf = () => Array.from(container.querySelectorAll(".judge-check"));
    expect(rowsOf()).toHaveLength(0);
    for (const toggle of screen.getAllByRole("button", { name: "Show checks →" })) {
      fireEvent.click(toggle);
    }
    // Only one category is open at a time: the last one opened replaces the others.
    const rows = rowsOf();
    expect(rows).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Hide checks ↑" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide checks ↑" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Show checks →" })[0] as HTMLElement);
    const first = rowsOf();
    expect(first).toHaveLength(1);
    expect(first[0]?.textContent).toContain("$18.40/wk");
    expect(
      first[0]?.querySelector('a[href="#/recommendations?focus=rec-d2-fixture"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Show checks →" })[0] as HTMLElement);
    const second = rowsOf();
    expect(second).toHaveLength(1);
    expect(second[0]?.textContent).not.toContain("No dollar figure");
    expect(second[0]?.textContent).not.toContain("$");
    expect(second[0]?.querySelector('a[href^="http"]')?.textContent).toContain("Cited doc");
  });

  it("opens one full-width checks panel after the grid and leaves the tile in place", async () => {
    const { container } = load(mockJudgeSetup());
    await screen.findByTestId("judge-tier");
    const grid = container.querySelector(".grid.g4") as HTMLElement;
    const tileBefore = Array.from(grid.children).indexOf(
      container.querySelector(".judge-category") as Element,
    );
    const toggle = screen.getByRole("button", { name: "Show checks →" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const open = screen.getByRole("button", { name: "Hide checks ↑" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(
      open.getAttribute("aria-controls") as string,
    ) as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.classList.contains("inset-panel")).toBe(true);
    expect(grid.contains(panel)).toBe(false);
    expect(grid.nextElementSibling).toBe(panel);
    expect(within(panel).getByRole("heading", { name: "Context hygiene checks" })).toBeTruthy();
    expect(document.activeElement).toBe(panel);
    expect(
      Array.from(grid.children).indexOf(container.querySelector(".judge-category") as Element),
    ).toBe(tileBefore);
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(document.querySelector(".judge-checks-panel")).toBeNull();
  });

  it("states check evidence in plain English and omits raw sample counts", async () => {
    load(mockJudgeSetup());
    await screen.findByTestId("judge-tier");
    fireEvent.click(screen.getByRole("button", { name: "Show checks →" }));
    const row = document.querySelector(".judge-check") as HTMLElement;
    expect(row.textContent).toContain("22% of 40 sessions");
    expect(row.textContent).not.toMatch(/Observed|samples/);
  });

  it("shows the rubric version once, in the How this is graded chip", async () => {
    const data = mockJudgeSetup();
    load(data);
    await screen.findByTestId("judge-tier");
    expect(document.body.textContent?.split(data.rubric.version).length).toBe(2);
    expect(screen.getByText(`Rubric ${data.rubric.version}`)).toBeTruthy();
    expect(screen.getByText("Show the rubric")).toBeTruthy();
  });

  it("explains NO_DATA with an InfoTip", async () => {
    const data = mockJudgeSetup();
    const first = data.grade.checks[0];
    if (!first) throw new Error("fixture");
    data.grade.checks[0] = {
      ...first,
      result: "NO_DATA",
      value: null,
      reason: "insufficient_sample",
      needs: "30 sessions",
    };
    load(data);
    await screen.findByTestId("judge-tier");
    // Checks sit behind the "Show checks" toggle; open it so the InfoTip is reachable.
    fireEvent.click(screen.getByRole("button", { name: "Show checks →" }));
    expect(screen.getByRole("button", { name: "What No data means" })).toBeTruthy();
  });

  it("lists unreadable surfaces from the API, and a no_signal check alone does not fake one", async () => {
    const data = mockJudgeSetup();
    const first = data.grade.checks[0];
    if (!first) throw new Error("fixture");
    data.grade.checks[0] = {
      ...first,
      result: "NO_DATA",
      value: null,
      reason: "no_signal",
      needs: null,
    };
    const { unmount } = load(data);
    await screen.findByTestId("judge-tier");
    expect(screen.queryByTestId("judge-unreadable")).toBeNull();
    unmount();

    data.unreadable_surfaces = ["settings.json permissions", "project CLAUDE.md (2 workspaces)"];
    load(data);
    const note = await screen.findByTestId("judge-unreadable");
    expect(note.textContent).toContain("settings.json permissions");
    expect(note.textContent).toContain("project CLAUDE.md (2 workspaces)");
    expect(buildShareCard(data)).not.toContain("settings.json");
  });

  it("shows the delta only when a previous snapshot exists and flags a rubric change", async () => {
    const data = mockJudgeSetup();
    data.delta = {
      previous_computed_at: "2026-10-01T00:00:00.000Z",
      previous_overall: 60,
      current_overall: 66,
      overall_change: 6,
      previous_tier: "Practitioner",
      current_tier: "Operator",
      tier_changed: true,
      categories: [{ category: "context_hygiene", previous: 55, current: 62, change: 7 }],
      previous_rubric_version: "cc-docs-2026-08",
      current_rubric_version: "cc-docs-2026-09",
      rubric_changed: true,
    };
    load(data);
    const delta = await screen.findByTestId("judge-delta");
    expect(delta.textContent).toContain("60 → 66");
    expect(delta.textContent).toContain("Practitioner → Operator");
    expect(delta.textContent).toContain("Rubric changed");
  });

  // U10 replaced the "Coming later" placeholder with the Judge me flow (flow tests: judge-consent.test.tsx).
  it("shows the written review with a Judge me button, no Settings link, and the scorecard intact", async () => {
    load(mockJudgeSetup());
    await screen.findByTestId("judge-tier");
    const review = screen.getByRole("heading", { name: "Written review" }).closest("section");
    const scope = within(review as HTMLElement);
    expect(await scope.findByRole("button", { name: "Judge me" })).toBeTruthy();
    expect(scope.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("judge-gap")).toBeTruthy();
  });

  it("colors by rubric band: tier chip, category value and meter, check chips", async () => {
    const data = mockJudgeSetup();
    const first = load(data);
    await screen.findByTestId("judge-tier");
    // Overall 66 -> Operator band (cyan); category 62 -> Operator band; tier chip follows the tier.
    expect(screen.getByTestId("judge-tier-chip").getAttribute("data-tone")).toBe("blue");
    expect(first.container.querySelector(".judge-category")?.getAttribute("data-tone")).toBe(
      "blue",
    );
    first.unmount();
    // 80 sits above the API's Conductor floor (75) -> green.
    data.grade.overall = 80;
    data.grade.categories = data.grade.categories.map((c) => ({ ...c, score: 80 }));
    data.grade.tier = "Conductor";
    const second = load(data);
    expect((await screen.findByTestId("judge-tier-chip")).getAttribute("data-tone")).toBe("green");
    expect(second.container.querySelector(".judge-category")?.getAttribute("data-tone")).toBe(
      "green",
    );
    // Tile chip row lists only non-zero counts (fixture: the context category has 1 fail).
    const tile = second.container.querySelector(".judge-category") as HTMLElement;
    expect(tile.textContent).toContain("1 fail");
    expect(tile.textContent).not.toContain("pass");
  });

  it("summarises the rubric from the API metadata above the disclosure", async () => {
    const data = mockJudgeSetup();
    load(data);
    const summary = (await screen.findByTestId("judge-rubric-summary")).textContent ?? "";
    expect(summary).toContain(`${data.rubric.checks.length} checks across 1 categories`);
    expect(summary).toContain("last 30 days");
    expect(summary).toContain("Practitioner 40 · Operator 60 · Conductor 75 · God-tier 90");
    expect(summary).toContain("caps your tier");
  });

  it("has no share card section; one Copy summary button in the header", async () => {
    load(mockJudgeSetup());
    await screen.findByTestId("judge-tier");
    expect(screen.queryByTestId("judge-share-text")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Share card" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Copy summary" })).toHaveLength(1);
  });

  it("copies share text that carries no paths, workspace names or config text", async () => {
    const data = mockJudgeSetup();
    data.grade.caps = [
      { check_id: "x", tier: "Practitioner", reason: SECRETS.config, binding: true },
    ];
    data.grade.data_needed = { message: SECRETS.path, items: [SECRETS.workspace] };
    data.grade.checks = data.grade.checks.map((c) => ({
      ...c,
      needs: `${SECRETS.path} ${SECRETS.workspace} ${SECRETS.config}`,
    }));
    data.rubric.checks = data.rubric.checks.map((c) => ({ ...c, statement: SECRETS.config }));
    data.dollars.per_check = data.dollars.per_check.map((d) => ({
      ...d,
      rec_ids: [SECRETS.workspace],
    }));
    data.allow_all_bash_files = [SECRETS.path];

    const text = buildShareCard(data);
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    expect(text).toContain("Operator");
    expect(text).toContain("Context hygiene: 62/100");

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    load(data);
    await screen.findByTestId("judge-tier");
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
    const copied = writeText.mock.calls[0]?.[0] as string;
    for (const secret of Object.values(SECRETS)) expect(copied).not.toContain(secret);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe("judge-setup styles", () => {
  it("uses tokens only (no hex or rgb colors) in the .judge- rules", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const css = fs.readFileSync(path.resolve(dir, "../../src/ui/styles.css"), "utf8");
    const start = css.indexOf("/* ── Judge my setup");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
