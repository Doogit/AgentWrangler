import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecommendationCard } from "../../src/query/api/recommendations";
import { mockRecommendations } from "../../src/ui/api/fixtures";
import RecCard from "../../src/ui/recommendations/RecCard";

const client = vi.hoisted(() => ({
  fetchRecommendations: vi.fn(),
}));
vi.mock("../../src/ui/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/api/client")>()),
  ...client,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// API order deliberately differs from alphabetical order and legacy session_ids.
const sessions = [
  { session_id: "z-high-claim", claimed_u: 900000, turn_count: 2 },
  { session_id: "b-low-claim", claimed_u: 100000, turn_count: 90 },
  { session_id: "a-zero-claim", claimed_u: 0, turn_count: 1 },
  { session_id: "y-many-turns", claimed_u: null, turn_count: 50 },
  { session_id: "c-few-turns", claimed_u: null, turn_count: 3 },
];
function fixture(
  evidence: NonNullable<RecommendationCard["trigger"]>["evidence"] = {
    session_count: 12,
    sessions,
  },
  window: NonNullable<RecommendationCard["trigger"]>["window"] = {
    from: "2026-09-17T00:00:00.000Z",
    to: "2026-09-24T00:00:00.000Z",
  },
) {
  const response = mockRecommendations();
  if (!response.data?.active[0]) throw new Error("fixture required");
  const rec: RecommendationCard = {
    ...response.data.active[0],
    rec_id: "evidence-card",
    detector_id: "D1",
    certification: "CERTIFIED",
    weeks_ago: 0,
    estimate: { basis: "P", rank_value_u_per_wk: 500000, summable: true, label: "synthetic" },
    trigger: {
      session_ids: ["legacy-session"],
      window,
      facts: [],
      ...(evidence ? { evidence } : {}),
    },
    actions: {
      primary: {
        option_id: "primary",
        kind: "HABIT",
        summary: "Review synthetic evidence",
        detail: [],
        copy_text: "Review",
        file_ref: null,
      },
      alternatives: [],
    },
    action_validation: { primary: { ok: true }, alternatives: {} },
  };
  response.data.active = [rec];
  client.fetchRecommendations.mockResolvedValue(response);
  return rec;
}

async function assertBoth(rec: RecommendationCard, text: string, ids: string[]) {
  const card = render(<RecCard rec={rec} />);
  expect(within(card.container).getByText(text)).toBeTruthy();
  const trigger = within(card.container).getByLabelText("Evidence");
  expect(
    within(trigger)
      .queryAllByRole("link")
      .map((el) => el.textContent),
  ).toEqual(ids);
  expect(trigger.textContent).not.toContain("W0");
}

describe("evidence window parity", () => {
  it("shows the complete cohort and preserves claimed-dollar ranking then unclaimed turn ranking", async () => {
    await assertBoth(
      fixture(),
      "12 sessions, Sep 17 – Sep 23",
      sessions.map((session) => session.session_id),
    );
  });
  it("preserves turn-count order when all sessions have no claim", async () => {
    const unclaimed = sessions.slice(3);
    await assertBoth(
      fixture({ session_count: 2, sessions: unclaimed }),
      "2 sessions, Sep 17 – Sep 23",
      unclaimed.map((session) => session.session_id),
    );
  });
  it("shows a known empty cohort without falling back to legacy links", async () => {
    await assertBoth(
      fixture({ session_count: 0, sessions: [] }),
      "0 sessions, Sep 17 – Sep 23",
      [],
    );
  });
  it("does not invent a count or dates when evidence is unavailable", async () => {
    // R6-14: an unknown count is a gap, not a data failure — omit it rather than saying
    // "unavailable". Clear the rec's own evidence bag too (the same object the mocked fetch
    // serves), so the RecCard count fallback (which also checks rec.evidence) finds nothing.
    const rec = fixture({ session_count: null, sessions: [] }, null);
    rec.evidence = {};
    await assertBoth(rec, "dates unavailable", []);
  });
  it("uses a singular session label across a month boundary", async () => {
    await assertBoth(
      fixture(
        { session_count: 1, sessions: sessions.slice(0, 1) },
        { from: "2026-08-31T00:00:00Z", to: "2026-09-02T00:00:00Z" },
      ),
      "1 session, Aug 31 – Sep 1",
      ["z-high-claim"],
    );
  });
});
