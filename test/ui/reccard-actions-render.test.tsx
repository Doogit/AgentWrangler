import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import RecCard from "../../src/ui/recommendations/RecCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function card(basis: "P" | "E" | "O" | "R", detectorId = "D2"): RecommendationCard {
  return {
    rec_id: "rec-action",
    detector_id: detectorId,
    category: "SESSION",
    scope_workspace_id: null,
    lever: "Review repeated work",
    title: "Repeated work",
    modeled_savings_u_per_wk: 1000,
    pct_of_weekly_spend: null,
    run_cost_u: null,
    modeled_formula: { model: "test", inputs: {} },
    estimate: {
      basis,
      rank_value_u_per_wk: 1000,
      summable: basis === "P" || basis === "E",
      label: "Test estimate",
    },
    actions: {
      primary: {
        option_id: "main",
        kind: "CONFIG",
        summary: "Update the setting",
        detail: [],
        copy_text: "primary text",
        file_ref: null,
      },
      alternatives: [
        {
          option_id: "other",
          kind: "HABIT",
          summary: "Change the routine",
          detail: ["Review it weekly"],
          copy_text: "alternative text",
          file_ref: null,
        },
      ],
    },
    action_validation: {
      primary: { ok: true },
      alternatives: { other: { ok: true } },
    },
    trigger: {
      session_ids: ["session-1"],
      window: { from: "2026-09-01", to: "2026-09-08" },
      facts: [{ label: "Retries", value: "4" }],
    },
    last_seen_week_start: "2026-09-08",
    weeks_fired: 2,
    weeks_evaluated: 3,
    evidence: {},
    target_metric: "test",
    state: "PROPOSED",
    created_at: "2026-09-08",
    dismissed_until: null,
    headroom: null,
    sessions_per_week: null,
    steps: [],
    cross_workspace: false,
    workspace_multiplier: null,
    file_ref: null,
  } as RecommendationCard;
}

/** A card whose trigger has no evidence window, so the anchor week is the only date shown. */
function noWindow(rec: RecommendationCard): RecommendationCard {
  return { ...rec, trigger: { ...trigger(rec), window: null } };
}

function trigger(rec: RecommendationCard): NonNullable<RecommendationCard["trigger"]> {
  if (!rec.trigger) throw new Error("fixture has a trigger");
  return rec.trigger;
}

describe("RecCard action rendering", () => {
  it.each([
    ["P", "Modeled", "Measured tokens × list price × an assumed share avoidable"],
    ["E", "Usage-estimated", "Estimated from your usage"],
    ["O", "Overlap", "Overlaps a higher-ranked rec; counted once"],
    ["R", "Risk", "Upper-bound risk, not a saving; excluded from the total"],
  ] as const)("renders %s basis with its label and explanation", (basis, label, explanation) => {
    const { container, getByRole } = render(<RecCard rec={card(basis)} />);
    expect(container.querySelector(".rec-impact-line")?.textContent).toContain(label);
    expect(
      container.querySelector(
        `.rec-impact-line .${basis === "P" || basis === "E" ? "chip-obs-proxy" : "chip-stale"}`,
      ),
    ).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "Estimate basis" }));
    expect(container.textContent).toContain("Update the setting");
    expect(container.textContent).toContain(explanation);
  });

  it("links trigger sessions, shows safety and recency, copies the chosen option, and adopts its id", async () => {
    vi.useFakeTimers();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const onAdopt = vi.fn().mockResolvedValue(undefined);
    const { container, getByRole } = render(<RecCard rec={card("R", "H1")} onAdopt={onAdopt} />);
    expect(container.querySelector('a[href="#/sessions/session-1"]')).not.toBeNull();
    // Facts render as a label/value grid (dt "Retries", dd "4").
    expect(container.querySelector(".rec-facts")?.textContent).toBe("Retries4");
    expect(container.textContent).toContain("RISK (upper bound)");
    expect(container.textContent).toContain("Safety");
    // The trigger line already shows the evidence dates and weeks_ago is unset → no recency line.
    expect(container.querySelector(".rec-recency")).toBeNull();
    fireEvent.click(
      within(container.querySelector(".rec-card-head-actions") as HTMLElement).getByRole("button", {
        name: "Review config",
      }),
    );
    expect(container.querySelector(".rec-details")).not.toBeNull();
    const other = container.querySelector(".rec-alternatives");
    if (!other) throw new Error("missing alternatives");
    // Alternatives show in full, as on the review page; their steps open with the prompt
    // (layout review 2).
    fireEvent.click(within(other as HTMLElement).getByRole("button", { name: "Show steps" }));
    expect(other.textContent).toContain("Review it weekly");
    fireEvent.click(within(other as HTMLElement).getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith("alternative text");
    fireEvent.click(
      within(other as HTMLElement).getByRole("button", { name: "Adopt this option" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onAdopt).toHaveBeenCalledWith("rec-action", "other");
  });

  it("recency — trigger dates shown: no repeated anchor range, only 'last seen'", () => {
    const { container } = render(
      <RecCard
        rec={{
          ...card("P"),
          last_seen_week_start: "2026-09-08",
          weeks_ago: 3,
          weeks_fired: 2,
          weeks_evaluated: 5,
        }}
      />,
    );
    expect(container.querySelector(".rec-recency")?.textContent).toBe(
      "last seen 3 weeks ago · fired in 2 of 5 weeks",
    );
  });

  it("shortens trigger session ids but links and titles the full id", () => {
    const id = "2a79f40d-2974-4a89-aa67-b4e2640c754c";
    const base = card("P");
    const { container } = render(
      <RecCard rec={{ ...base, trigger: { ...trigger(noWindow(base)), session_ids: [id] } }} />,
    );
    const link = container.querySelector(`a[href="#/sessions/${id}"]`);
    expect(link?.textContent).toBe("2a79…754c");
    expect(link?.getAttribute("title")).toBe(id);
  });

  it("puts the trigger in its own titled Evidence container", () => {
    const { getByRole } = render(<RecCard rec={card("P")} />);
    const evidence = getByRole("region", { name: "Evidence" });
    expect(evidence.querySelector("h4")?.textContent).toBe("Evidence");
    // Facts are a label/value grid, as on the review page.
    expect(evidence.querySelector("dl.rec-facts dt")?.textContent).toBe("Retries");
    expect(evidence.querySelector("dl.rec-facts dd")?.textContent).toBe("4");
  });

  it("orders the body: what's wrong, evidence, suggested action, alternatives, related, show details", () => {
    const base = card("P");
    const { container, getByRole } = render(
      <RecCard
        rec={{
          ...base,
          trigger: { ...trigger(base), problem: "MEMORY.md is 29 over target." },
          related: [{ rec_id: "r2", title: "Other card", why: "Counted there." }],
        }}
      />,
    );
    // Operator 2026-09-26: related cards sit at the bottom, just above Show details.
    const order = [
      getByRole("region", { name: "What's wrong" }),
      getByRole("region", { name: "Evidence" }),
      getByRole("region", { name: "Suggested action" }),
      container.querySelector(".rec-alternatives"),
      getByRole("region", { name: "Related cards" }),
      getByRole("button", { name: "Show details ▼" }),
    ];
    for (let i = 1; i < order.length; i++)
      expect(order[i - 1]?.compareDocumentPosition(order[i] as Node)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
  });

  it("puts each body section in its own accented block", () => {
    const base = card("P");
    const { getByRole, getAllByRole } = render(
      <RecCard
        rec={{
          ...base,
          trigger: { ...trigger(base), problem: "MEMORY.md is 29 over target." },
          related: [{ rec_id: "r2", title: "Other card", why: "Counted there." }],
        }}
      />,
    );
    const blocks: Array<[HTMLElement, string]> = [
      [getByRole("region", { name: "What's wrong" }), "rec-block-problem"],
      [getByRole("region", { name: "Evidence" }), "rec-block-evidence"],
      [getByRole("region", { name: "Suggested action" }), "rec-block-action"],
      [getAllByRole("region", { name: "Alternative" })[0] as HTMLElement, "rec-block-alternative"],
      [getByRole("region", { name: "Related cards" }), "rec-block-related"],
    ];
    for (const [block, accent] of blocks) {
      expect(block.classList).toContain("rec-block");
      expect(block.classList).toContain(accent);
      expect(block.firstElementChild?.classList).toContain("rec-section-label");
    }
  });

  it("opens what's wrong with a TL;DR line, then the full explanation", () => {
    const base = card("P");
    const { getByRole } = render(
      <RecCard
        rec={{
          ...base,
          trigger: {
            ...trigger(base),
            summary: "MEMORY.md is over its target.",
            problem: "MEMORY.md is 29 over target. It loads on every turn.",
          },
        }}
      />,
    );
    const wrong = getByRole("region", { name: "What's wrong" });
    const tldr = wrong.querySelector(".rec-tldr");
    expect(tldr?.textContent).toBe("TL;DR MEMORY.md is over its target.");
    expect(tldr?.compareDocumentPosition(wrong.querySelector(".rec-problem") as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows the suggested action's detail and its full copy prompt", () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const base = card("P");
    const primary = base.actions?.primary;
    if (!primary) throw new Error("fixture has a primary action");
    const { getByRole } = render(
      <RecCard
        rec={{
          ...base,
          actions: {
            primary: { ...primary, detail: ["Keep the old value as a comment."] },
            alternatives: [],
          },
        }}
      />,
    );
    const action = getByRole("region", { name: "Suggested action" });
    expect(action.textContent).toContain("Update the setting");
    // Steps open with the prompt's button (layout review 2).
    fireEvent.click(within(action).getByRole("button", { name: "Show steps" }));
    expect(action.querySelector("li")?.textContent).toBe("Keep the old value as a comment.");
    expect(action.querySelector(".rec-copy-preview")?.textContent).toBe("primary text");
    fireEvent.click(within(action).getByRole("button", { name: "Copy" }));
    expect(copy).toHaveBeenCalledWith("primary text");
  });

  it("shows every chip on one top line, before the title", () => {
    const { container } = render(<RecCard rec={card("P")} />);
    const row = container.querySelector(".rec-chip-row") as Element;
    for (const selector of [".rec-cat-chip", ".rec-scope-badge"])
      expect(row.querySelector(selector)).not.toBeNull();
    expect(row.querySelector(".rec-confidence-tier")).toBeNull();
    expect(container.querySelectorAll(".rec-presentation-chips")).toHaveLength(1);
    const title = container.querySelector(".rec-title") as Element;
    expect(row.compareDocumentPosition(title)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("gives D1 a short headline naming the scope, not the file path", () => {
    const base = card("P", "D1");
    const { container } = render(
      <RecCard
        rec={{
          ...base,
          cross_workspace: true,
          evidence: { component: "CLAUDE_MD", source_target: 2000 },
        }}
      />,
    );
    expect(container.querySelector(".rec-headline-text")?.firstChild?.textContent).toBe(
      "Trim global CLAUDE.md to 2,000 tokens or less",
    );
  });

  it("states what's wrong before the recommended action", () => {
    const base = card("P");
    const { container } = render(
      <RecCard
        rec={{ ...base, trigger: { ...trigger(base), problem: "MEMORY.md is 29 over target." } }}
      />,
    );
    const problem = container.querySelector(".rec-problem");
    expect(problem?.textContent).toBe("MEMORY.md is 29 over target.");
    expect(problem?.previousElementSibling?.textContent).toBe("What's wrong");
    const actions = container.querySelector(".rec-decision-actions") as Element;
    expect(problem?.compareDocumentPosition(actions)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("links related cards to their focus route, with what each counts (P3.1-T9)", () => {
    const { container } = render(
      <RecCard
        rec={{
          ...card("P"),
          related: [
            {
              rec_id: "rec-d8 x",
              title: "Keep the cache warm",
              why: "Cache writes after a break are counted there, not here.",
            },
          ],
        }}
      />,
    );
    const link = container.querySelector(".rec-related a");
    expect(link?.getAttribute("href")).toBe("#/recommendations?focus=rec-d8%20x");
    expect(link?.textContent).toBe("Keep the cache warm");
    expect(container.querySelector(".rec-related")?.textContent).toContain(
      "Cache writes after a break are counted there, not here.",
    );
  });

  it("shows no related section when a card has no partner", () => {
    const { container } = render(<RecCard rec={card("P")} />);
    expect(container.querySelector(".rec-related")).toBeNull();
  });

  it("recency — weeks_ago 0: shows anchor range only, no 'last seen' text", () => {
    const { container } = render(
      <RecCard
        rec={{ ...noWindow(card("P")), last_seen_week_start: "2026-09-08", weeks_ago: 0 }}
      />,
    );
    const recency = container.querySelector(".rec-recency");
    expect(recency?.textContent).toBe("2026-09-08 – 2026-09-14");
    expect(recency?.textContent).not.toContain("last seen");
  });

  it("recency — weeks_ago 3, fired 2 of 5: shows range plus exact 'last seen' text", () => {
    const { container } = render(
      <RecCard
        rec={{
          ...noWindow(card("P")),
          last_seen_week_start: "2026-09-08",
          weeks_ago: 3,
          weeks_fired: 2,
          weeks_evaluated: 5,
        }}
      />,
    );
    const recency = container.querySelector(".rec-recency");
    expect(recency?.textContent).toBe(
      "2026-09-08 – 2026-09-14 · last seen 3 weeks ago · fired in 2 of 5 weeks",
    );
  });

  it("recency — weeks_ago 1: uses singular 'week'", () => {
    const { container } = render(
      <RecCard
        rec={{
          ...noWindow(card("P")),
          last_seen_week_start: "2026-09-15",
          weeks_ago: 1,
          weeks_fired: 1,
          weeks_evaluated: 2,
        }}
      />,
    );
    expect(container.querySelector(".rec-recency")?.textContent).toBe(
      "2026-09-15 – 2026-09-21 · last seen 1 week ago · fired in 1 of 2 weeks",
    );
  });

  // Layout review 2 (operator 2026-09-26).
  it("item 1: shows the saving as a percent of total weekly spend next to the $", () => {
    const { container } = render(
      <RecCard rec={{ ...card("P"), pct_of_total_weekly_spend: 3.46 }} />,
    );
    expect(container.querySelector(".rec-savings-share")?.textContent).toContain(
      "3.5% of weekly spend",
    );
    const { container: none } = render(
      <RecCard rec={{ ...card("P"), pct_of_total_weekly_spend: null }} />,
    );
    expect(none.querySelector(".rec-savings-share")).toBeNull();
  });

  it("L6: standalone figure is 'Before overlaps' when the headline is a number", () => {
    const { container, getByRole } = render(
      <RecCard rec={{ ...card("P"), allocated_u_per_wk: 400 }} />,
    );
    fireEvent.click(getByRole("button", { name: "Show details ▼" }));
    const detail = container.querySelector(".rec-modeled");
    expect(detail?.textContent).toContain("Before overlaps");
    expect(detail?.textContent).not.toContain("not on the spend ledger");
  });

  it("L6: a null headline labels the standalone figure 'not on the spend ledger'", () => {
    const { container, getByRole } = render(
      <RecCard rec={{ ...card("P"), allocated_u_per_wk: null }} />,
    );
    fireEvent.click(getByRole("button", { name: "Show details ▼" }));
    const detail = container.querySelector(".rec-modeled");
    expect(detail?.textContent).not.toContain("Before overlaps");
    expect(detail?.textContent).toContain("Standalone estimate (not on the spend ledger)");
  });

  it("L6: a legacy card (allocated undefined) shows neither label", () => {
    const { container, getByRole } = render(<RecCard rec={card("P")} />);
    fireEvent.click(getByRole("button", { name: "Show details ▼" }));
    const detail = container.querySelector(".rec-modeled");
    expect(detail).not.toBeNull();
    expect(detail?.textContent).not.toContain("Before overlaps");
    expect(detail?.textContent).not.toContain("not on the spend ledger");
  });

  it("item 2: clamps long What's wrong text and long prompts, each with an expand button", () => {
    const base = card("P");
    const primary = base.actions?.primary;
    if (!primary) throw new Error("fixture has a primary action");
    const longProblem = "Long sessions re-read their whole history on every call. ".repeat(8);
    const longPrompt = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}.`).join("\n");
    const { getByRole } = render(
      <RecCard
        rec={{
          ...base,
          trigger: { ...trigger(base), problem: longProblem },
          actions: { primary: { ...primary, copy_text: longPrompt }, alternatives: [] },
        }}
      />,
    );
    const wrong = getByRole("region", { name: "What's wrong" });
    const problem = wrong.querySelector(".rec-problem") as HTMLElement;
    expect(problem.classList).toContain("rec-clamped");
    // Nothing is cut: the full text stays in the DOM, only the display is clamped.
    expect(problem.textContent).toBe(longProblem);
    const more = within(wrong).getByRole("button", { name: "Show full text" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(problem.classList).not.toContain("rec-clamped");
    expect(within(wrong).getByRole("button", { name: "Show less" })).toBeDefined();

    const action = getByRole("region", { name: "Suggested action" });
    const prompt = action.querySelector(".rec-copy-preview") as HTMLElement;
    expect(prompt.classList).toContain("rec-clamped");
    expect(prompt.textContent).toBe(longPrompt);
    fireEvent.click(within(action).getByRole("button", { name: "Show full prompt" }));
    expect(prompt.classList).not.toContain("rec-clamped");
  });

  // "Why this matters" disclosure (review 5 U3, operator 2026-09-26): closed native
  // <details>/<summary> inside What's wrong, only when trigger.why is set. jsdom 25 implements
  // native details/summary click-to-toggle, so a plain fireEvent.click on the summary flips
  // `open` without any extra state wiring in the test.
  it("shows a closed 'Why this matters' disclosure when trigger.why is set, and opens on click", () => {
    const base = card("P");
    const { getByRole } = render(
      <RecCard
        rec={{
          ...base,
          trigger: { ...trigger(base), problem: "Problem text.", why: "A. B." },
        }}
      />,
    );
    const wrong = getByRole("region", { name: "What's wrong" });
    const why = wrong.querySelector("details.rec-why") as HTMLDetailsElement;
    expect(why).not.toBeNull();
    expect(why.open).toBe(false);
    expect(why.querySelector(".rec-why-text")?.textContent).toBe("A. B.");
    fireEvent.click(within(wrong).getByText("Why this matters", { selector: "summary" }));
    expect(why.open).toBe(true);
  });

  it("has no 'Why this matters' disclosure when trigger.why is absent", () => {
    const base = card("P");
    const { getByRole } = render(
      <RecCard rec={{ ...base, trigger: { ...trigger(base), problem: "Problem text." } }} />,
    );
    const wrong = getByRole("region", { name: "What's wrong" });
    expect(wrong.querySelector(".rec-why")).toBeNull();
  });

  it("item 2: Evidence opens with its facts; the calls are one click away", () => {
    const base = card("P");
    const calls = Array.from({ length: 5 }, (_, i) => ({
      kind: "command" as const,
      target: `npm run step-${i}`,
      tool: "Bash",
      calls: 1,
      session_ids: ["session-1"],
      session_count: 1,
      total_bytes: 100,
      max_bytes: 100,
      whole_file: false,
    }));
    const { getByRole } = render(
      <RecCard rec={{ ...base, trigger: { ...trigger(base), calls } }} />,
    );
    const evidence = getByRole("region", { name: "Evidence" });
    expect(evidence.querySelector("dl.rec-facts")).not.toBeNull();
    expect(evidence.querySelector(".rec-trigger-calls")).toBeNull();
    const show = within(evidence).getByRole("button", { name: "Show example calls (5)" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);
    expect(evidence.querySelectorAll(".rec-trigger-calls li")).toHaveLength(5);
    fireEvent.click(within(evidence).getByRole("button", { name: "Hide calls" }));
    expect(evidence.querySelector(".rec-trigger-calls")).toBeNull();
  });

  it("item 2: a card without facts shows its calls at once", () => {
    const base = card("P");
    const call = {
      kind: "file" as const,
      target: "~/notes.md",
      tool: "Read",
      calls: 2,
      session_ids: ["session-1"],
      session_count: 1,
      total_bytes: 100,
      max_bytes: 50,
      whole_file: true,
    };
    const { getByRole } = render(
      <RecCard rec={{ ...base, trigger: { ...trigger(base), facts: [], calls: [call] } }} />,
    );
    const evidence = getByRole("region", { name: "Evidence" });
    expect(evidence.querySelectorAll(".rec-trigger-calls li")).toHaveLength(1);
    expect(within(evidence).queryByRole("button", { name: /calls/ })).toBeNull();
  });

  it("item 2: the action's steps open with its prompt", () => {
    const base = card("P");
    const primary = base.actions?.primary;
    if (!primary) throw new Error("fixture has a primary action");
    const { getByRole } = render(
      <RecCard
        rec={{
          ...base,
          actions: { primary: { ...primary, detail: ["Keep a backup."] }, alternatives: [] },
        }}
      />,
    );
    const action = getByRole("region", { name: "Suggested action" });
    expect(action.querySelector(".rec-action-detail")).toBeNull();
    // Short prompt: shown whole, only the steps wait behind the button.
    expect(action.querySelector(".rec-copy-preview")?.classList).not.toContain("rec-clamped");
    fireEvent.click(within(action).getByRole("button", { name: "Show steps" }));
    expect(action.querySelector(".rec-action-detail li")?.textContent).toBe("Keep a backup.");
  });

  it("item 2: short text and prompts get no expand button", () => {
    const base = card("P");
    const { getByRole } = render(
      <RecCard rec={{ ...base, trigger: { ...trigger(base), problem: "Short." } }} />,
    );
    for (const name of ["What's wrong", "Suggested action"]) {
      const region = getByRole("region", { name });
      expect(region.querySelector(".rec-clamped")).toBeNull();
      expect(within(region).queryByRole("button", { name: /Show full/ })).toBeNull();
    }
  });

  it("item 3: shows the More menu's single action as a plain button", () => {
    const { container, getByRole } = render(<RecCard rec={card("P")} />);
    expect(container.querySelector("details.rec-actions-menu")).toBeNull();
    expect(container.textContent).not.toContain("More ▾");
    const actions = container.querySelector(".rec-actions") as HTMLElement;
    expect(within(actions).getByRole("button", { name: "Evaluation" })).toBeDefined();
    expect(getByRole("button", { name: "Show details ▼" })).toBeDefined();
  });

  it("item 7: clicking the header folds the card to a summary and back", () => {
    const base = card("P");
    const { container, getByRole } = render(
      <RecCard rec={{ ...base, trigger: { ...trigger(base), problem: "Short." } }} />,
    );
    const root = container.querySelector(".rec-card") as HTMLElement;
    const toggle = getByRole("button", { name: "Repeated work" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(root.classList).not.toContain("rec-folded");
    // A click on empty header space folds the card.
    fireEvent.click(container.querySelector(".rec-card-head") as HTMLElement);
    expect(root.classList).toContain("rec-folded");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // `.rec-folded` hides the body in CSS (checked in the live render); the title and $ stay.
    expect(container.querySelector(".rec-savings-estimate")).not.toBeNull();
    // A click on a header button does its own job and does not fold or unfold.
    fireEvent.click(toggle);
    expect(root.classList).not.toContain("rec-folded");
    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(root.classList).not.toContain("rec-folded");
  });

  it("adopts the primary option without an option id", async () => {
    vi.useFakeTimers();
    const onAdopt = vi.fn().mockResolvedValue(undefined);
    const { getByRole } = render(<RecCard rec={card("P")} onAdopt={onAdopt} />);
    fireEvent.click(getByRole("button", { name: "Adopt" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onAdopt).toHaveBeenCalledWith("rec-action", undefined);
  });
});
