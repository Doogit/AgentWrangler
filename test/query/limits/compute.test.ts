import { describe, expect, it } from "vitest";
import { computeRow } from "../../../src/query/limits/compute.js";

const T0 = new Date("2026-09-14T00:00:00.000Z");
const H = 36e5; // ms per hour
const resetAfter = (hours: number) => new Date(T0.getTime() + hours * H).toISOString();

describe("computeRow (overview-v2 §1)", () => {
  it("session: 33% used, 1h13m elapsed of 5h → burn 27.1%/hr, ahead, hits-limit-in ≈ 2.47h", () => {
    // 1h13m elapsed ⇒ 3h47m remaining until reset.
    const row = computeRow(
      {
        id: "session",
        label: "Current session",
        windowHours: 5,
        usedPct: 33,
        resetsAt: resetAfter(5 - (1 + 13 / 60)),
      },
      T0,
    );
    expect(row.elapsedHours).toBeCloseTo(1.2167, 3);
    expect(row.burnRate).toBeCloseTo(27.1, 1);
    expect(row.budgetRate).toBeCloseTo(20, 5);
    expect(row.paceState).toBe("ahead");
    expect(row.projection.kind).toBe("hits-limit-in");
    if (row.projection.kind === "hits-limit-in") {
      expect(row.projection.hours).toBeCloseTo(2.47, 2);
    }
  });

  it("weekly all-models: 52% used, 4d2h elapsed of 7d → 12.7%/day, on, ends-at ≈ 89%", () => {
    // 4d2h = 98h elapsed ⇒ 70h remaining.
    const row = computeRow(
      {
        id: "weekly",
        label: "Weekly · all models",
        windowHours: 168,
        usedPct: 52,
        resetsAt: resetAfter(70),
      },
      T0,
    );
    expect(row.burnRate).toBeCloseTo(12.7, 1); // %/day
    expect(row.budgetRate).toBeCloseTo(14.29, 2);
    expect(row.paceState).toBe("on");
    expect(row.projection.kind).toBe("ends-at");
    if (row.projection.kind === "ends-at") {
      expect(row.projection.pct).toBeCloseTo(89, 0);
    }
    expect(row.headroomMultiple).toBeUndefined(); // all-models row: never a headroom note
  });

  it("weekly per-model: 20% used, 70h elapsed of 7d → headroomMultiple ≈ 2.9", () => {
    // The verbatim §1 headroom formula K = (100−used)/used · (elapsed/remaining)
    // reaches ≈2.9 at 70h elapsed (early week); at 98h it would be 5.6. The
    // prompt's "same window" is read as the same 7-day window, earlier in it.
    const row = computeRow(
      {
        id: "weekly:fable-5",
        label: "Weekly · Fable",
        windowHours: 168,
        usedPct: 20,
        resetsAt: resetAfter(98), // 70h elapsed, 98h remaining
      },
      T0,
    );
    expect(row.headroomMultiple).toBeCloseTo(2.9, 5);
  });

  it("OV-8 live repro: weekly 96% used at 92% pace, reset in 13h → ahead (exhausts before reset)", () => {
    // 92% of 168h elapsed ≈ 154.56h ⇒ 13.44h until reset.
    const row = computeRow(
      {
        id: "weekly",
        label: "Weekly · all models",
        windowHours: 168,
        usedPct: 96,
        resetsAt: resetAfter(168 * 0.08),
      },
      T0,
    );
    expect(row.pacePct).toBeCloseTo(92, 5);
    expect(row.projection.kind).toBe("hits-limit-in");
    if (row.projection.kind === "hits-limit-in") {
      expect(row.projection.hours).toBeLessThan(row.hoursUntilReset);
    }
    expect(row.paceState).not.toBe("on");
    expect(row.paceState).toBe("ahead");
  });

  it("paceState agrees with the projection: 'on' never coexists with hits-limit-in", () => {
    for (const usedPct of [5, 20, 50, 80, 96, 99]) {
      for (const hoursLeft of [1, 13, 40, 84, 150]) {
        const row = computeRow(
          {
            id: "weekly",
            label: "Weekly",
            windowHours: 168,
            usedPct,
            resetsAt: resetAfter(hoursLeft),
          },
          T0,
        );
        if (row.paceState === "on") expect(row.projection.kind).toBe("ends-at");
      }
    }
  });

  it("clamps elapsed and pace when the window has fully elapsed (reset in the past)", () => {
    const row = computeRow(
      {
        id: "weekly",
        label: "Weekly · all models",
        windowHours: 168,
        usedPct: 100,
        resetsAt: resetAfter(-1),
      },
      T0,
    );
    expect(row.hoursUntilReset).toBe(0);
    expect(row.pacePct).toBe(100);
    expect(row.headroomMultiple).toBeUndefined(); // remaining 0 ⇒ no headroom note
  });
});
