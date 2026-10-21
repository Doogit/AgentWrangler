import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as client from "../../../src/ui/api/client";
import { mockJudgeSetup } from "../../../src/ui/api/fixtures";
import SetupGradeCard from "../../../src/ui/overview/SetupGradeCard";

vi.mock("../../../src/ui/api/client");
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function card(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-metric='setup.grade']");
  if (!el) throw new Error("setup.grade card not rendered");
  return el;
}

async function renderWith(data: ReturnType<typeof mockJudgeSetup>) {
  vi.mocked(client.fetchJudgeSetup).mockResolvedValue(data);
  render(<SetupGradeCard />);
  await waitFor(() => expect(card().textContent).toContain("/100"));
}

it("shows a loading state while the grade is fetched", () => {
  vi.mocked(client.fetchJudgeSetup).mockReturnValue(new Promise(() => {}));
  render(<SetupGradeCard />);
  expect(card().textContent).toContain("Rate my setup");
  expect(card().textContent).toContain("Loading…");
  expect(card().querySelector("a.more")?.getAttribute("href")).toBe("#/judge-setup");
});

it("shows a dash and the tab link when the fetch fails", async () => {
  vi.mocked(client.fetchJudgeSetup).mockRejectedValue(new Error("boom"));
  render(<SetupGradeCard />);
  // The query retries once (query-client default) before it reports an error.
  await waitFor(() => expect(card().textContent).toContain("Grade unavailable"), {
    timeout: 4000,
  });
  expect(card().querySelector(".v")?.textContent).toBe("—");
  expect(card().querySelector("a.more")?.getAttribute("href")).toBe("#/judge-setup");
});

it("shows the score, tier, next tier and its top item, with no cap or delta", async () => {
  await renderWith(mockJudgeSetup());
  const text = card().textContent ?? "";
  expect(card().querySelector(".v")?.textContent).toBe("66/100");
  expect(text).toContain("Operator");
  expect(text).not.toContain("Capped");
  expect(text).toContain("Next: Conductor — 2 items");
  expect(text).toContain("Edited sessions are not reliably followed by a test run");
  expect(text).not.toContain("vs last grade");
  expect(screen.getByRole("link", { name: "Rate my setup →" }).getAttribute("href")).toBe(
    "#/judge-setup",
  );
  // Tier ladder: fill = overall, one tick per tier floor above 0.
  const ladder = card().querySelector<HTMLElement>("[data-testid='setup-ladder']");
  expect(ladder?.querySelector<HTMLElement>(".setup-ladder-fill")?.style.width).toBe("66%");
  expect(ladder?.querySelectorAll(".setup-ladder-tick")).toHaveLength(4);
});

it("shows the score as the grade API gives it (floored like the tab, never recomputed)", async () => {
  const data = mockJudgeSetup();
  data.grade.overall = 59.6;
  data.grade.tier = "Practitioner";
  await renderWith(data);
  expect(card().querySelector(".v")?.textContent).toBe("59/100");
});

it("shows Capped and the binding cap's reason when a cap binds", async () => {
  const data = mockJudgeSetup();
  data.grade.caps = [
    {
      check_id: "allow_all_bash",
      tier: "Practitioner",
      reason: "Allow-all Bash rule is set",
      binding: true,
    },
  ];
  await renderWith(data);
  const text = card().textContent ?? "";
  expect(text).toContain("Capped");
  expect(text).toContain("Allow-all Bash rule is set");
  expect(text).not.toContain("Edited sessions are not reliably followed");
});

it("ignores a cap that does not bind", async () => {
  const data = mockJudgeSetup();
  data.grade.caps = [{ check_id: "x", tier: "God-tier", reason: "Unbound cap", binding: false }];
  await renderWith(data);
  expect(card().textContent).not.toContain("Capped");
  expect(card().textContent).not.toContain("Unbound cap");
});

it("hides the next-tier lines at the top tier", async () => {
  const data = mockJudgeSetup();
  data.grade.next_tier = null;
  await renderWith(data);
  expect(card().textContent).not.toContain("Next:");
});

it("shows the change since the last grade", async () => {
  const data = mockJudgeSetup();
  data.grade.overall = 59;
  data.delta = {
    previous_computed_at: "2026-10-01T00:00:00.000Z",
    // The live seed's shape: the raw change is -14.9, but the line must add up as shown.
    previous_overall: 73.9,
    current_overall: 59,
    overall_change: -14.9,
    previous_tier: "Operator",
    current_tier: "Practitioner",
    tier_changed: true,
    categories: [],
    previous_rubric_version: "cc-docs-2026-09",
    current_rubric_version: "cc-docs-2026-09",
    rubric_changed: false,
  };
  await renderWith(data);
  expect(card().textContent).toContain("↓14 vs last grade (73→59)");
  expect(screen.getByRole("button", { name: "About the change since last grade" })).toBeTruthy();
});

it("shows a no-grade state when no category scored", async () => {
  const data = mockJudgeSetup();
  data.grade.overall = null;
  data.grade.tier = null;
  data.grade.next_tier = null;
  data.grade.data_needed = { message: "Not enough activity to grade yet", items: [] };
  vi.mocked(client.fetchJudgeSetup).mockResolvedValue(data);
  render(<SetupGradeCard />);
  await waitFor(() => expect(card().textContent).toContain("Not enough activity to grade yet"));
  expect(card().querySelector(".v")?.textContent).toBe("—");
  expect(card().querySelector("[data-testid='setup-ladder']")).toBeNull();
});
