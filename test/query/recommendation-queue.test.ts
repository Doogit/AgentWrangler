import { describe, expect, it } from "vitest";
import {
  type QueueItem,
  createRecommendationQueueSnapshot,
  projectQueuePageToLegacy,
  queryRecommendationQueue,
} from "../../src/query/api/recommendation-queue.js";
import { RANKING_POLICY_VERSION } from "../../src/recommendations/ranking-policy.js";

const snapshot = {
  compositionSnapshotId: "snapshot:queue-1",
  compositionVersion: 1,
  rankingPolicyVersion: RANKING_POLICY_VERSION,
} as const;

function item(stableId: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    stableId: stableId as QueueItem["stableId"],
    activeRevisionId: `revision:${stableId}`,
    lifecycle: "ACTIONABLE",
    handlerFamily: "H2_OUTPUT_CONTEXT",
    artifactKind: "config_diff",
    workspaceId: "workspace:one",
    scopeId: "scope:one",
    expectedSavingsUsdPerWeek: 10,
    confidence: 0.8,
    applicability: 0.9,
    evidenceNewestAt: "2026-09-17T00:00:00.000Z",
    safetyPin: null,
    safetyClass: null,
    measurementVerdict: "AUTOMATIC",
    measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" },
    compatibility: "NATIVE",
    ...overrides,
  };
}

function query(
  items: readonly QueueItem[],
  cursor?: Parameters<typeof queryRecommendationQueue>[0]["cursor"],
) {
  const base = {
    current: createRecommendationQueueSnapshot({ snapshot, items }),
    availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
    pageSize: 2,
  };
  return cursor === undefined
    ? queryRecommendationQueue(base)
    : queryRecommendationQueue({ ...base, cursor });
}

describe("recommendation queue", () => {
  it("ranks the full eligible set before taking a page, including bounded safety pins", () => {
    const result = query([
      item("value-20", { expectedSavingsUsdPerWeek: 20 }),
      item("safety", {
        expectedSavingsUsdPerWeek: 1,
        safetyClass: "SECRET",
        safetyPin: {
          reviewed: true,
          safetyClass: "SECRET",
          priority: 0,
          reasonCode: "PIN" as never,
        },
      }),
      item("value-10", { expectedSavingsUsdPerWeek: 10 }),
      item("value-null", { expectedSavingsUsdPerWeek: null }),
    ]);

    expect(result.kind).toBe("PAGE");
    if (result.kind !== "PAGE") return;
    expect(result.items.map((candidate) => candidate.stableId)).toEqual(["safety", "value-20"]);
    expect(result.counts.total).toBe(4);
    expect(result.nextCursor?.after.stableId).toBe("value-20");
  });

  it("uses one immutable snapshot and predicate for results and counts", () => {
    const result = query([
      item("native-actionable"),
      item("legacy-actionable", { compatibility: "LEGACY" }),
      item("native-investigate", { lifecycle: "INVESTIGATE", expectedSavingsUsdPerWeek: null }),
    ]);
    expect(result.kind).toBe("PAGE");
    if (result.kind !== "PAGE") return;

    const filtered = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("native-actionable"),
          item("legacy-actionable", { compatibility: "LEGACY" }),
          item("native-investigate", { lifecycle: "INVESTIGATE", expectedSavingsUsdPerWeek: null }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      filters: { lifecycle: ["ACTIONABLE"], compatibility: ["NATIVE"] },
    });

    expect(filtered).toMatchObject({ kind: "PAGE", counts: { total: 1 } });
    if (filtered.kind === "PAGE")
      expect(filtered.items.map((candidate) => candidate.stableId)).toEqual(["native-actionable"]);

    const allFilters = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("complete-match", {
            artifactKind: "advice",
            handlerFamily: "H11_SAFETY",
            workspaceId: "workspace:two",
            scopeId: null,
            expectedSavingsUsdPerWeek: 10,
            confidence: 0.8,
            safetyClass: "SECRET",
            measurementVerdict: "MANUAL",
            compatibility: "LEGACY",
          }),
          item("near-match", { compatibility: "NATIVE" }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      filters: {
        lifecycle: ["ACTIONABLE"],
        artifactKind: ["advice"],
        handlerFamily: ["H11_SAFETY"],
        workspaceId: ["workspace:two"],
        scopeId: [null],
        valueBand: ["HIGH"],
        confidenceTier: ["HIGH"],
        measurementVerdict: ["MANUAL"],
        safetyClass: ["SECRET"],
        compatibility: ["LEGACY"],
      },
    });
    expect(allFilters).toMatchObject({ kind: "PAGE", counts: { total: 1 } });
    if (allFilters.kind === "PAGE")
      expect(allFilters.items.map((candidate) => candidate.stableId)).toEqual(["complete-match"]);
  });

  it("defaults to actionable work while explicit lifecycle filters expose investigation records", () => {
    const current = createRecommendationQueueSnapshot({
      snapshot,
      items: [item("actionable"), item("investigate", { lifecycle: "INVESTIGATE" })],
    });
    const defaultPage = queryRecommendationQueue({
      current,
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
    });
    expect(defaultPage).toMatchObject({ kind: "PAGE", counts: { total: 1 } });

    const investigations = queryRecommendationQueue({
      current,
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      filters: { lifecycle: ["INVESTIGATE"] },
    });
    expect(investigations).toMatchObject({ kind: "PAGE", counts: { total: 1 } });
  });

  it("returns refresh decisions for changed, expired, policy-mismatched, and absent rank cursors", () => {
    const current = createRecommendationQueueSnapshot({ snapshot, items: [item("a"), item("b")] });
    const first = queryRecommendationQueue({
      current,
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 1,
    });
    expect(first.kind).toBe("PAGE");
    if (first.kind !== "PAGE" || first.nextCursor === null) return;

    const second = queryRecommendationQueue({
      current,
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 1,
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({ kind: "PAGE", items: [{ stableId: "b" }], nextCursor: null });

    const expired = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({ snapshot, items: [item("a"), item("b")] }),
      availableSnapshotIds: new Set(),
      pageSize: 1,
      cursor: first.nextCursor,
    });
    expect(expired).toMatchObject({ kind: "REFRESH_REQUIRED", reason: "SNAPSHOT_EXPIRED" });

    const changed = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot: { ...snapshot, compositionSnapshotId: "snapshot:queue-2", compositionVersion: 2 },
        items: [item("a"), item("b")],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId, "snapshot:queue-2"]),
      pageSize: 1,
      cursor: first.nextCursor,
    });
    expect(changed).toMatchObject({ kind: "REFRESH_REQUIRED", reason: "SNAPSHOT_CHANGED" });

    const policyChanged = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot: { ...snapshot, rankingPolicyVersion: "ranking-policy-next" as never },
        items: [item("a"), item("b")],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 1,
      cursor: first.nextCursor,
    });
    expect(policyChanged).toMatchObject({ kind: "REFRESH_REQUIRED", reason: "POLICY_CHANGED" });

    const absentKey = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({ snapshot, items: [item("replacement")] }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 1,
      cursor: first.nextCursor,
    });
    expect(absentKey).toMatchObject({ kind: "REFRESH_REQUIRED", reason: "CURSOR_NOT_FOUND" });
  });

  it("fails closed for null value and rejects an empty filter", () => {
    const result = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("known", { expectedSavingsUsdPerWeek: 5 }),
          item("unknown", { expectedSavingsUsdPerWeek: null }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      filters: { valueBand: ["UNKNOWN"] },
    });
    expect(result).toMatchObject({ kind: "PAGE", counts: { total: 1 } });
    if (result.kind === "PAGE")
      expect(result.items.map((candidate) => candidate.stableId)).toEqual(["unknown"]);

    const invalid = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({ snapshot, items: [item("known")] }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      filters: { safetyClass: [] },
    });
    expect(invalid).toEqual({ kind: "INVALID_QUERY", reason: "EMPTY_FILTER" });
  });

  it("orders measured results by outcome precedence and fails unmeasured items closed", () => {
    const result = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("unmeasured", {
            measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" },
            expectedSavingsUsdPerWeek: 99,
          }),
          item("pending", { measuredState: { kind: "MEASURED", result: "PENDING" } }),
          item("unsupported", { measuredState: { kind: "MEASURED", result: "UNSUPPORTED" } }),
          item("worse", { measuredState: { kind: "MEASURED", result: "WORSE" } }),
          item("inconclusive", {
            measuredState: { kind: "MEASURED", result: "INCONCLUSIVE" },
          }),
          item("no-effect", { measuredState: { kind: "MEASURED", result: "NO_EFFECT" } }),
          item("improved", { measuredState: { kind: "MEASURED", result: "IMPROVED" } }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      sort: "MEASURED_RESULT",
    });

    expect(result.kind).toBe("PAGE");
    if (result.kind !== "PAGE") return;
    expect(result.items.map((candidate) => candidate.stableId)).toEqual([
      "improved",
      "no-effect",
      "inconclusive",
      "worse",
      "unsupported",
      "pending",
      "unmeasured",
    ]);
    expect(result.counts.total).toBe(7);
    expect(result.counts.byMeasuredResult).toEqual({
      IMPROVED: 1,
      NO_EFFECT: 1,
      INCONCLUSIVE: 1,
      WORSE: 1,
      UNSUPPORTED: 1,
      PENDING: 1,
      NO_CYCLE: 1,
    });
  });

  it("keeps bounded safety pins ahead of measured ordering", () => {
    const result = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("improved", {
            measuredState: { kind: "MEASURED", result: "IMPROVED" },
            expectedSavingsUsdPerWeek: 20,
          }),
          item("safety", {
            measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" },
            expectedSavingsUsdPerWeek: 1,
            safetyClass: "SECRET",
            safetyPin: {
              reviewed: true,
              safetyClass: "SECRET",
              priority: 0,
              reasonCode: "PIN" as never,
            },
          }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      sort: "MEASURED_RESULT",
    });

    expect(result.kind).toBe("PAGE");
    if (result.kind !== "PAGE") return;
    expect(result.items.map((candidate) => candidate.stableId)).toEqual(["safety", "improved"]);
  });

  it("breaks measured-order ties on the default value rank tuple", () => {
    const result = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("lower-confidence", {
            measuredState: { kind: "MEASURED", result: "IMPROVED" },
            expectedSavingsUsdPerWeek: 10,
            confidence: 0.5,
          }),
          item("higher-value", {
            measuredState: { kind: "MEASURED", result: "IMPROVED" },
            expectedSavingsUsdPerWeek: 30,
            confidence: 0.5,
          }),
          item("higher-confidence", {
            measuredState: { kind: "MEASURED", result: "IMPROVED" },
            expectedSavingsUsdPerWeek: 10,
            confidence: 0.9,
          }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      sort: "MEASURED_RESULT",
    });

    expect(result.kind).toBe("PAGE");
    if (result.kind !== "PAGE") return;
    expect(result.items.map((candidate) => candidate.stableId)).toEqual([
      "higher-value",
      "higher-confidence",
      "lower-confidence",
    ]);
  });

  it("keeps measured-order pagination and counts consistent across pages", () => {
    const items = [
      item("improved-a", { measuredState: { kind: "MEASURED", result: "IMPROVED" } }),
      item("improved-b", { measuredState: { kind: "MEASURED", result: "IMPROVED" } }),
      item("no-effect", { measuredState: { kind: "MEASURED", result: "NO_EFFECT" } }),
      item("unmeasured", { measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" } }),
    ];
    const current = createRecommendationQueueSnapshot({ snapshot, items });
    const availableSnapshotIds = new Set([snapshot.compositionSnapshotId]);

    const first = queryRecommendationQueue({
      current,
      availableSnapshotIds,
      pageSize: 2,
      sort: "MEASURED_RESULT",
    });
    expect(first.kind).toBe("PAGE");
    if (first.kind !== "PAGE" || first.nextCursor === null) return;
    expect(first.items.map((candidate) => candidate.stableId)).toEqual([
      "improved-a",
      "improved-b",
    ]);
    expect(first.counts.total).toBe(4);

    const second = queryRecommendationQueue({
      current,
      availableSnapshotIds,
      pageSize: 2,
      sort: "MEASURED_RESULT",
      cursor: first.nextCursor,
    });
    expect(second.kind).toBe("PAGE");
    if (second.kind !== "PAGE") return;
    expect(second.items.map((candidate) => candidate.stableId)).toEqual([
      "no-effect",
      "unmeasured",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(second.counts.total).toBe(4);
  });

  it("refuses a measured-order cursor when the sort changes", () => {
    const current = createRecommendationQueueSnapshot({
      snapshot,
      items: [item("a", { measuredState: { kind: "MEASURED", result: "IMPROVED" } }), item("b")],
    });
    const first = queryRecommendationQueue({
      current,
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 1,
      sort: "MEASURED_RESULT",
    });
    expect(first.kind).toBe("PAGE");
    if (first.kind !== "PAGE" || first.nextCursor === null) return;

    const changedSort = queryRecommendationQueue({
      current,
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 1,
      sort: "ESTIMATED_VALUE",
      cursor: first.nextCursor,
    });
    expect(changedSort).toMatchObject({ kind: "REFRESH_REQUIRED", reason: "QUERY_CHANGED" });
  });

  it("projects a page into legacy consumers without changing order, totals, or cursor state", () => {
    const page = query([item("first"), item("second"), item("third")]);
    expect(page.kind).toBe("PAGE");
    if (page.kind !== "PAGE") return;
    const legacy = projectQueuePageToLegacy(page, (candidate) => ({ rec_id: candidate.stableId }));
    expect(legacy).toMatchObject({
      kind: "PAGE",
      total: 3,
      items: [{ rec_id: "first" }, { rec_id: "second" }],
    });
    if (legacy.kind === "PAGE") expect(legacy.nextCursor).toEqual(page.nextCursor);
  });

  it("projects a measured-order page into legacy consumers without re-ranking", () => {
    const page = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("unmeasured", {
            measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" },
            expectedSavingsUsdPerWeek: 50,
          }),
          item("improved", {
            measuredState: { kind: "MEASURED", result: "IMPROVED" },
            expectedSavingsUsdPerWeek: 1,
          }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      sort: "MEASURED_RESULT",
    });
    expect(page.kind).toBe("PAGE");
    if (page.kind !== "PAGE") return;
    const legacy = projectQueuePageToLegacy(page, (candidate) => ({ rec_id: candidate.stableId }));
    expect(legacy).toMatchObject({
      kind: "PAGE",
      total: 2,
      items: [{ rec_id: "improved" }, { rec_id: "unmeasured" }],
    });
  });

  it("filters and counts by measured result with filter/count parity", () => {
    const result = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("improved", { measuredState: { kind: "MEASURED", result: "IMPROVED" } }),
          item("improved-2", { measuredState: { kind: "MEASURED", result: "IMPROVED" } }),
          item("worse", { measuredState: { kind: "MEASURED", result: "WORSE" } }),
          item("unavailable", { measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" } }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      filters: { measuredResult: ["IMPROVED"] },
    });

    expect(result).toMatchObject({
      kind: "PAGE",
      counts: { total: 2, byMeasuredResult: { IMPROVED: 2 } },
    });
    if (result.kind === "PAGE")
      expect(result.items.map((candidate) => candidate.stableId)).toEqual([
        "improved",
        "improved-2",
      ]);
  });

  it("filters every unavailable item with a null measured-result filter", () => {
    const result = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("no-cycle", { measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" } }),
          item("legacy-unlinked", {
            measuredState: { kind: "UNAVAILABLE", reason: "LEGACY_UNLINKED" },
          }),
          item("superseded", {
            measuredState: { kind: "UNAVAILABLE", reason: "SUPERSEDED_REVISION" },
          }),
          item("improved", { measuredState: { kind: "MEASURED", result: "IMPROVED" } }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      filters: { measuredResult: [null] },
    });

    expect(result).toMatchObject({
      kind: "PAGE",
      counts: {
        total: 3,
        byMeasuredResult: { NO_CYCLE: 1, LEGACY_UNLINKED: 1, SUPERSEDED_REVISION: 1 },
      },
    });
    if (result.kind === "PAGE")
      expect(result.items.map((candidate) => candidate.stableId)).toEqual([
        "legacy-unlinked",
        "no-cycle",
        "superseded",
      ]);
  });

  it("ranks every unavailable reason below measured results under the measured sort", () => {
    const result = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({
        snapshot,
        items: [
          item("no-cycle", {
            measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" },
            expectedSavingsUsdPerWeek: 99,
          }),
          item("legacy-unlinked", {
            measuredState: { kind: "UNAVAILABLE", reason: "LEGACY_UNLINKED" },
            expectedSavingsUsdPerWeek: 99,
          }),
          item("superseded", {
            measuredState: { kind: "UNAVAILABLE", reason: "SUPERSEDED_REVISION" },
            expectedSavingsUsdPerWeek: 99,
          }),
          item("worse", {
            measuredState: { kind: "MEASURED", result: "WORSE" },
            expectedSavingsUsdPerWeek: 1,
          }),
        ],
      }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      sort: "MEASURED_RESULT",
    });

    expect(result.kind).toBe("PAGE");
    if (result.kind !== "PAGE") return;
    expect(result.items.map((candidate) => candidate.stableId)).toEqual([
      "worse",
      "legacy-unlinked",
      "no-cycle",
      "superseded",
    ]);
  });

  it("refuses a cursor when the measured-result filter changes", () => {
    const current = createRecommendationQueueSnapshot({
      snapshot,
      items: [
        item("improved", { measuredState: { kind: "MEASURED", result: "IMPROVED" } }),
        item("worse", { measuredState: { kind: "MEASURED", result: "WORSE" } }),
      ],
    });
    const availableSnapshotIds = new Set([snapshot.compositionSnapshotId]);
    const first = queryRecommendationQueue({
      current,
      availableSnapshotIds,
      pageSize: 1,
      sort: "MEASURED_RESULT",
      filters: { measuredResult: ["IMPROVED", "WORSE"] },
    });
    expect(first.kind).toBe("PAGE");
    if (first.kind !== "PAGE" || first.nextCursor === null) return;

    const changedFilter = queryRecommendationQueue({
      current,
      availableSnapshotIds,
      pageSize: 1,
      sort: "MEASURED_RESULT",
      filters: { measuredResult: ["IMPROVED"] },
      cursor: first.nextCursor,
    });
    expect(changedFilter).toMatchObject({ kind: "REFRESH_REQUIRED", reason: "QUERY_CHANGED" });
  });

  it("rejects an empty measured-result filter", () => {
    const invalid = queryRecommendationQueue({
      current: createRecommendationQueueSnapshot({ snapshot, items: [item("known")] }),
      availableSnapshotIds: new Set([snapshot.compositionSnapshotId]),
      pageSize: 10,
      filters: { measuredResult: [] },
    });
    expect(invalid).toEqual({ kind: "INVALID_QUERY", reason: "EMPTY_FILTER" });
  });

  it("reports the ordering rationale actually applied to the page", () => {
    const current = createRecommendationQueueSnapshot({
      snapshot,
      items: [
        item("improved", { measuredState: { kind: "MEASURED", result: "IMPROVED" } }),
        item("unmeasured", { measuredState: { kind: "UNAVAILABLE", reason: "NO_CYCLE" } }),
      ],
    });
    const availableSnapshotIds = new Set([snapshot.compositionSnapshotId]);
    const rationaleFor = (sort?: Parameters<typeof queryRecommendationQueue>[0]["sort"]) => {
      const result = queryRecommendationQueue({
        current,
        availableSnapshotIds,
        pageSize: 10,
        ...(sort === undefined ? {} : { sort }),
      });
      if (result.kind !== "PAGE") throw new Error("expected a page");
      return result.sortRationale;
    };

    expect(rationaleFor()).toBe("EXPECTED_VALUE_ORDER");
    expect(rationaleFor("CONFIDENCE")).toBe("CONFIDENCE_ORDER");
    expect(rationaleFor("NEWEST_EVIDENCE")).toBe("NEWEST_EVIDENCE_ORDER");
    expect(rationaleFor("MEASURED_RESULT")).toBe("MEASURED_OUTCOME_ORDER");
  });
});
