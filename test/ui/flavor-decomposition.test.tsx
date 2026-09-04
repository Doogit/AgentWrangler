/**
 * test/ui/flavor-decomposition.test.tsx — Spend-Viz-v2 component tests.
 *
 * T11 — FlavorDecomposition renders both modes (raw + weighted)
 * T12 — UNVERIFIED badge visible when mode=weighted, absent when mode=raw
 * T13 — CacheEfficiencyKPI renders raw reuse bands
 * T14 — CacheWriteSpikesChart renders spike annotation text for flagged buckets
 * T15 — All three components: loading → skeleton; error/null → N/A state
 *
 * All tests use mock props directly — no OverviewPage render required.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheEfficiency, FlavorDecomposition } from "../../src/query/api/spend-flavor";
import type { CacheWriteTrend } from "../../src/query/api/trends";
import type { ApiResponse } from "../../src/query/envelope";
import CacheEfficiencyKPI from "../../src/ui/overview/CacheEfficiencyKPI";
import CacheWriteSpikesChart, {
  buildCacheWriteChartRows,
} from "../../src/ui/overview/CacheWriteSpikesChart";
import FlavorDecompositionChart from "../../src/ui/overview/FlavorDecomposition";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function baseMeta() {
  return {
    n: 6,
    window: { from: "2026-08-17T00:00:00Z", to: "2026-08-24T00:00:00Z", preset: "7d" as const },
    qualification: {
      provisional_excluded: true,
      unpriced_turns: 0,
      claim_kinds_count: 1,
      note: "",
    },
    metric_definition_version: "observe-1" as const,
    claim_kind: "PROXY" as const,
    drilldown_ids: {} as Record<string, never>,
  };
}

function mockFlavorData(
  overrides: Partial<FlavorDecomposition> = {},
): ApiResponse<FlavorDecomposition> {
  const data: FlavorDecomposition = {
    flavors: [
      {
        flavor: "fresh_input",
        label: "fresh input",
        weight: 1.0,
        raw_tokens: 8_500_000,
        weighted_tokens: 8_500_000,
        weighted_share: 0.55,
        raw_share: 0.32,
      },
      {
        flavor: "output",
        label: "output (incl. thinking)",
        weight: 1.0,
        raw_tokens: 1_200_000,
        weighted_tokens: 1_200_000,
        weighted_share: 0.08,
        raw_share: 0.05,
      },
      {
        flavor: "cache_write_5m",
        label: "cache write (5 min)",
        weight: 1.0,
        raw_tokens: 2_000_000,
        weighted_tokens: 2_000_000,
        weighted_share: 0.16,
        raw_share: 0.08,
      },
      {
        flavor: "cache_write_1h",
        label: "cache write (1 hr)",
        weight: 1.0,
        raw_tokens: 800_000,
        weighted_tokens: 800_000,
        weighted_share: 0.1,
        raw_share: 0.03,
      },
      {
        flavor: "cache_write_other",
        label: "cache write (unspecified)",
        weight: 1.0,
        raw_tokens: 0,
        weighted_tokens: 0,
        weighted_share: 0,
        raw_share: 0,
      },
      {
        flavor: "cache_read",
        label: "cache read",
        weight: 0.1,
        raw_tokens: 14_000_000,
        weighted_tokens: 1_400_000,
        weighted_share: 0.09,
        raw_share: 0.53,
      },
    ],
    total_raw_tokens: 26_500_000,
    total_weighted_tokens: 13_900_000,
    cache_efficiency_ratio: 0.82,
    cache_read_share: 0.82,
    cache_read_tokens: 14_000_000,
    cache_creation_tokens: 2_800_000,
    reuse_band: "REUSE_DOMINANT",
    cap_weighted_tokens: 13_900_000,
    coeff_used: 0.1,
    coeff_unverified: true,
    turns: 287,
    ...overrides,
  };
  return { data, meta: baseMeta() };
}

function mockCacheEffData(reuse_band: CacheEfficiency["reuse_band"]): ApiResponse<CacheEfficiency> {
  const counts: Record<
    CacheEfficiency["reuse_band"],
    { reads: number; creations: number; turns: number }
  > = {
    NO_DATA: { reads: 0, creations: 0, turns: 0 },
    NO_DENOMINATOR: { reads: 14_000_000, creations: 0, turns: 287 },
    WRITE_HEAVY: { reads: 840_000, creations: 2_800_000, turns: 287 },
    MIXED_REUSE: { reads: 5_600_000, creations: 2_800_000, turns: 287 },
    REUSE_DOMINANT: { reads: 14_000_000, creations: 2_800_000, turns: 287 },
  };
  const { reads, creations, turns } = counts[reuse_band];
  const cacheTotal = reads + creations;
  const data: CacheEfficiency = {
    ratio: cacheTotal > 0 ? reads / cacheTotal : null,
    cache_read_tokens: reads,
    cache_creation_tokens: creations,
    reuse_band,
    cap_weighted_tokens: creations + reads * 0.1,
    coeff_used: 0.1,
    coeff_unverified: true,
    turns,
  };
  return { data, meta: { ...baseMeta(), n: 1 } };
}

function mockCacheWriteData(spikeSet: string[] = []): ApiResponse<CacheWriteTrend> {
  const buckets = [
    {
      bucket: "2026-08-17",
      cache_creation_tokens: 200_000,
      cache_read_tokens: 1_400_000,
      efficiency_ratio: 0.875,
      turns: 45,
    },
    {
      bucket: "2026-08-18",
      cache_creation_tokens: 180_000,
      cache_read_tokens: 1_260_000,
      efficiency_ratio: 0.875,
      turns: 38,
    },
    {
      bucket: "2026-08-19",
      cache_creation_tokens: 950_000,
      cache_read_tokens: 800_000,
      efficiency_ratio: 0.457,
      turns: 72,
    },
    {
      bucket: "2026-08-20",
      cache_creation_tokens: 175_000,
      cache_read_tokens: 1_225_000,
      efficiency_ratio: 0.875,
      turns: 28,
    },
  ];
  return {
    data: { buckets, spike_buckets: spikeSet },
    meta: { ...baseMeta(), n: buckets.length },
  };
}

// ---------------------------------------------------------------------------
// T11 — FlavorDecomposition renders in both modes
// ---------------------------------------------------------------------------

describe("T11 — FlavorDecomposition renders both modes", () => {
  it("default mode is weighted — shows 'Cap-proxy weighted' button as active", () => {
    const { container } = render(
      <FlavorDecompositionChart state={{ status: "ok", value: mockFlavorData() }} />,
    );
    const btn = container.querySelector(".date-preset-btn.active");
    expect(btn?.textContent).toMatch(/Cap-proxy weighted/i);
  });

  it("clicking Raw tokens switches active button", () => {
    const { container } = render(
      <FlavorDecompositionChart state={{ status: "ok", value: mockFlavorData() }} />,
    );
    const rawBtn = Array.from(container.querySelectorAll(".date-preset-btn")).find((b) =>
      b.textContent?.match(/Raw tokens/i),
    ) as HTMLButtonElement;
    fireEvent.click(rawBtn);
    const activeBtn = container.querySelector(".date-preset-btn.active");
    expect(activeBtn?.textContent).toMatch(/Raw tokens/i);
  });

  it("section heading contains 'Where your tokens go'", () => {
    const { container } = render(
      <FlavorDecompositionChart state={{ status: "ok", value: mockFlavorData() }} />,
    );
    expect(container.textContent).toMatch(/Where your tokens go/);
  });
});

// ---------------------------------------------------------------------------
// T12 — UNVERIFIED badge: visible in weighted mode, absent in raw mode
// ---------------------------------------------------------------------------

describe("T12 — UNVERIFIED badge visibility by mode", () => {
  it("weighted mode: shows 'cap coefficient unverified' text", () => {
    const { container } = render(
      <FlavorDecompositionChart state={{ status: "ok", value: mockFlavorData() }} />,
    );
    expect(container.textContent).toMatch(/cap coefficient unverified/);
  });

  it("raw mode: 'cap coefficient unverified' text is absent", () => {
    const { container } = render(
      <FlavorDecompositionChart state={{ status: "ok", value: mockFlavorData() }} />,
    );
    const rawBtn = Array.from(container.querySelectorAll(".date-preset-btn")).find((b) =>
      b.textContent?.match(/Raw tokens/i),
    ) as HTMLButtonElement;
    fireEvent.click(rawBtn);
    expect(container.textContent).not.toMatch(/cap coefficient unverified/);
  });

  it("myth note is always visible", () => {
    const { container } = render(
      <FlavorDecompositionChart state={{ status: "ok", value: mockFlavorData() }} />,
    );
    expect(container.textContent).toMatch(/Trimming a cached prompt saves ~10×/);
  });
});

// ---------------------------------------------------------------------------
// T13 — CacheEfficiencyKPI renders reuse bands without health labels
// ---------------------------------------------------------------------------

describe("T13 — CacheEfficiencyKPI renders reuse bands", () => {
  it("WRITE_HEAVY renders its raw-share diagnostic", () => {
    const { container } = render(
      <CacheEfficiencyKPI state={{ status: "ok", value: mockCacheEffData("WRITE_HEAVY") }} />,
    );
    expect(container.textContent).toMatch(/WRITE HEAVY/);
    expect(container.textContent).toMatch(/0\.3×/);
    expect(container.textContent).toMatch(/23\.1%/);
    expect(container.textContent).toMatch(/diagnostic only · not a health signal/);
  });

  it("zero cache creation renders NO DENOMINATOR without inventing a ratio", () => {
    const { container } = render(
      <CacheEfficiencyKPI state={{ status: "ok", value: mockCacheEffData("NO_DENOMINATOR") }} />,
    );
    expect(container.textContent).toMatch(/— NO DENOMINATOR/);
    expect(container.textContent).not.toMatch(/REUSE DOMINANT/);
  });

  it("WRITE_HEAVY uses amber color on kpi-value", () => {
    const { container } = render(
      <CacheEfficiencyKPI state={{ status: "ok", value: mockCacheEffData("WRITE_HEAVY") }} />,
    );
    const val = container.querySelector(".kpi-value");
    expect(val).not.toBeNull();
    expect(val?.getAttribute("style")).toMatch(/amber/);
  });

  it("REUSE_DOMINANT renders green color", () => {
    const { container } = render(
      <CacheEfficiencyKPI state={{ status: "ok", value: mockCacheEffData("REUSE_DOMINANT") }} />,
    );
    const val = container.querySelector(".kpi-value");
    expect(val?.getAttribute("style")).toMatch(/green/);
  });

  it("shows selected-window cap draw with its coefficient caveat", () => {
    const { container } = render(
      <CacheEfficiencyKPI state={{ status: "ok", value: mockCacheEffData("REUSE_DOMINANT") }} />,
    );
    expect(container.textContent).toMatch(/Cap-weighted draw: 4\.2M/);
    expect(container.textContent).toMatch(/coefficient 0\.1× unverified/);
    expect(container.textContent).toMatch(/TTL 5m\/1h volatile/);
  });
});

// ---------------------------------------------------------------------------
// T14 — CacheWriteSpikesChart: spike_buckets present → spike annotation text
// ---------------------------------------------------------------------------

describe("T14 — CacheWriteSpikesChart renders spike data", () => {
  it("keeps spike values on the matching shared category row", () => {
    const trend = mockCacheWriteData(["2026-08-19"]).data;
    expect(trend).not.toBeNull();
    const chartRows = buildCacheWriteChartRows(trend?.buckets ?? [], trend?.spike_buckets ?? []);

    expect(chartRows).toHaveLength(4);
    expect(chartRows.map((row) => row.bucket)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
    ]);
    expect(chartRows.map((row) => row.spike_value)).toEqual([null, null, 950_000, null]);
  });

  it("with spike_buckets: chart renders without crashing", () => {
    const { container } = render(
      <CacheWriteSpikesChart state={{ status: "ok", value: mockCacheWriteData(["2026-08-19"]) }} />,
    );
    expect(container.querySelector(".card")).not.toBeNull();
  });

  it("title contains 'Cache writes over time · spike = likely miss event'", () => {
    const { container } = render(
      <CacheWriteSpikesChart state={{ status: "ok", value: mockCacheWriteData(["2026-08-19"]) }} />,
    );
    expect(container.textContent).toMatch(/Cache writes over time · spike = likely miss event/);
  });

  it("TTL volatile caveat is present", () => {
    const { container } = render(
      <CacheWriteSpikesChart state={{ status: "ok", value: mockCacheWriteData() }} />,
    );
    expect(container.textContent).toMatch(/TTL 5m\/1h volatile/);
  });
});

// ---------------------------------------------------------------------------
// T15 — Loading and null/error states
// ---------------------------------------------------------------------------

describe("T15 — Loading, error, and null data states", () => {
  it("FlavorDecomposition loading → aria-busy skeleton", () => {
    const { container } = render(<FlavorDecompositionChart state={{ status: "loading" }} />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("FlavorDecomposition error → N/A state (no crash)", () => {
    const { container } = render(
      <FlavorDecompositionChart state={{ status: "error", message: "ECONNREFUSED" }} />,
    );
    expect(container.textContent).toMatch(/N\/A/);
  });

  it("FlavorDecomposition null data → N/A state", () => {
    const { container } = render(
      <FlavorDecompositionChart
        state={{ status: "ok", value: { data: null, meta: baseMeta() } }}
      />,
    );
    expect(container.textContent).toMatch(/N\/A/);
  });

  it("CacheEfficiencyKPI loading → aria-busy skeleton", () => {
    const { container } = render(<CacheEfficiencyKPI state={{ status: "loading" }} />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("CacheEfficiencyKPI error → N/A state (no crash)", () => {
    const { container } = render(
      <CacheEfficiencyKPI state={{ status: "error", message: "ECONNREFUSED" }} />,
    );
    expect(container.textContent).toMatch(/N\/A/);
  });

  it("CacheWriteSpikesChart loading → aria-busy skeleton", () => {
    const { container } = render(<CacheWriteSpikesChart state={{ status: "loading" }} />);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("CacheWriteSpikesChart error → N/A state (no crash)", () => {
    const { container } = render(
      <CacheWriteSpikesChart state={{ status: "error", message: "ECONNREFUSED" }} />,
    );
    expect(container.textContent).toMatch(/N\/A/);
  });
});
