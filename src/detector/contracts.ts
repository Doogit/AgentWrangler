/** Declared quantity and assumption provenance for every evaluated detector. */
import { DEFAULT_CAP_READ_COEFF } from "../query/cap-weighted.js";
import {
  A1_AVOIDANCE_FRACTION,
  A2_AVOIDANCE_FRACTION,
  B1_AVOIDANCE_FRACTION,
  B3_AVOIDANCE_FRACTION,
  B4_AVOIDANCE_FRACTION,
  CX_WASTED_TURN_AVOIDANCE_FRACTION,
  D1_D10_AVOIDANCE_FRACTION,
  D1_TRIM_TO_TARGET_FRACTION,
  D2_CALLS_PER_SPLIT,
  D2_SUMMARY_TOKENS,
  D4_REALIZABLE_AVOIDANCE_FRACTION,
  D4_REDUCTION_FRACTION,
  D6_AVOIDANCE_FRACTION,
  D7_AVOIDANCE_FRACTION,
  D8_AVOIDANCE_FRACTION,
  D12_AVOIDANCE_FRACTION,
  E1_AVOIDANCE_FRACTION,
  E2_AVOIDANCE_FRACTION,
  G11_AVOIDANCE_FRACTION,
} from "./savings.js";

export type SubagentScope = "MAIN_ONLY" | "MAIN_AND_FORK" | "MAIN_AND_NONEXPLORE_SUBAGENTS" | "ALL";

export type ConstantDecl =
  | { name: string; value: number; status: "CITED"; citation: string }
  | { name: string; value: number; status: "ASSUMED"; min: number; max: number };

export type QuantityContract = {
  quantity: string;
  source: { kind: "DOC" | "MEASURED" | "CANARY"; ref: string };
  subagentScope: SubagentScope | Record<string, SubagentScope>;
  window: "W0";
  constants: ConstantDecl[];
};

const assumed = (name: string, value: number, min = 0.33, max = 0.7): ConstantDecl => ({
  name,
  value,
  status: "ASSUMED",
  min,
  max,
});

const measured = (
  quantity: string,
  ref: string,
  constants: ConstantDecl[] = [],
  subagentScope: QuantityContract["subagentScope"] = "ALL",
): QuantityContract => ({
  quantity,
  source: { kind: "MEASURED", ref },
  subagentScope,
  window: "W0",
  constants,
});

const wastedTurn = assumed("CX_WASTED_TURN_AVOIDANCE_FRACTION", CX_WASTED_TURN_AVOIDANCE_FRACTION);
const cacheRead = "turns.cache_read_tokens and session pricing snapshots";
const costEquiv = "claimed turns.cost_equiv_u";

export const DETECTOR_CONTRACTS: Record<string, QuantityContract> = {
  A1: measured(
    "avoidable tool-result carry bytes converted to tokens",
    "tool_events.result_bytes and subsequent turns",
    [assumed("A1_AVOIDANCE_FRACTION", A1_AVOIDANCE_FRACTION)],
  ),
  A2: measured(
    "avoidable task-output bytes converted to tokens",
    "tool_events.result_bytes",
    [assumed("A2_AVOIDANCE_FRACTION", A2_AVOIDANCE_FRACTION)],
    "MAIN_ONLY",
  ),
  B1: measured(
    "avoidable cache recreation tokens",
    "turns.cache_creation_tokens and cache reads",
    [assumed("B1_AVOIDANCE_FRACTION", B1_AVOIDANCE_FRACTION)],
    "MAIN_ONLY",
  ),
  B2: measured("cache-read gaps longer than one hour", cacheRead, [], "MAIN_ONLY"),
  B3: measured(
    "avoidable resume cache recreation tokens",
    "turns.cache_creation_tokens",
    [assumed("B3_AVOIDANCE_FRACTION", B3_AVOIDANCE_FRACTION)],
    "MAIN_ONLY",
  ),
  B4: measured(
    "avoidable mid-session prefix recreation tokens",
    "turns.cache_creation_tokens",
    [assumed("B4_AVOIDANCE_FRACTION", B4_AVOIDANCE_FRACTION)],
    "MAIN_ONLY",
  ),
  C1: measured("tool-error recovery turn cost", costEquiv, [wastedTurn], "MAIN_ONLY"),
  C2: measured("not-found retry turn cost", costEquiv, [wastedTurn], "MAIN_ONLY"),
  C3: measured("edit-before-read recovery turn cost", costEquiv, [wastedTurn], "MAIN_ONLY"),
  C4: measured("failed-edit recovery turn cost", costEquiv, [wastedTurn], "MAIN_ONLY"),
  C5: measured(
    "advisory same-error-loop CEU floor; non-summable overlap context",
    "retained error events, owning turns and pricing snapshots; no economic claim",
    [],
    "MAIN_ONLY",
  ),
  C6: measured("edit flip-flop redo turn cost", costEquiv, [wastedTurn], "MAIN_ONLY"),
  C7: measured("bash-failure recovery turn cost", costEquiv, [wastedTurn], "MAIN_ONLY"),
  C9: measured("denial re-plan turn cost", costEquiv, [wastedTurn], "MAIN_ONLY"),
  C11: measured("output-cap failed-call and retry turn cost", costEquiv, [wastedTurn], "MAIN_ONLY"),
  D1: {
    quantity: "per-source context tokens above target times eligible downstream turns",
    source: { kind: "DOC", ref: "code.claude.com/docs/en/sub-agents.md" },
    subagentScope: { memory: "MAIN_AND_FORK", claudeMd: "MAIN_AND_NONEXPLORE_SUBAGENTS" },
    window: "W0",
    constants: [assumed("D1_TRIM_TO_TARGET_FRACTION", D1_TRIM_TO_TARGET_FRACTION, 0.5, 1)],
  },
  // Review 3 B5: the reduction is measured from context growth; the split cadence and summary
  // size it rests on are the assumptions.
  D2: measured("weekly cache-read spend in qualifying long-context sessions", cacheRead, [
    assumed("D2_CALLS_PER_SPLIT", D2_CALLS_PER_SPLIT, 75, 300),
    assumed("D2_SUMMARY_TOKENS", D2_SUMMARY_TOKENS, 1_000, 10_000),
  ]),
  D4: measured(
    "observed model price differential across qualifying turns",
    "turns token columns and pricing snapshots",
    [
      assumed("D4_REALIZABLE_AVOIDANCE_FRACTION", D4_REALIZABLE_AVOIDANCE_FRACTION),
      assumed("D4_REDUCTION_FRACTION", D4_REDUCTION_FRACTION),
    ],
  ),
  D5: measured(
    "cap-weighted limit-burn trend; warning has no priced savings",
    "turns token columns and user_config.cap_read_coeff",
    [assumed("cap_read_coeff", DEFAULT_CAP_READ_COEFF, 0.05, 0.2)],
  ),
  D6: measured(
    "tool-result carry exposure tokens",
    "tool_events.result_bytes and subsequent turns",
    [assumed("D6_AVOIDANCE_FRACTION", D6_AVOIDANCE_FRACTION)],
  ),
  D7: measured("repeat excess tokens or cross-session redundant reads", "turns and tool_events", [
    assumed("D7_AVOIDANCE_FRACTION", D7_AVOIDANCE_FRACTION),
  ]),
  D8: measured("cache-write churn creation tokens", "turns.cache_creation_tokens", [
    assumed("D8_AVOIDANCE_FRACTION", D8_AVOIDANCE_FRACTION),
  ]),
  D9: measured(
    "workspaces with fork subagent sessions",
    "src/detector/detectors/d9_idle_background_session.ts",
  ),
  D10: measured("catalog context delta times global turns", "context_inventory and turns", [
    assumed("D1_D10_AVOIDANCE_FRACTION", D1_D10_AVOIDANCE_FRACTION),
  ]),
  D11: measured("tool-error recovery turn cost", costEquiv, [wastedTurn]),
  D12: measured(
    "avoidable subagent result bytes converted to tokens",
    "tool_events.result_bytes",
    [assumed("D12_AVOIDANCE_FRACTION", D12_AVOIDANCE_FRACTION)],
    "MAIN_ONLY",
  ),
  D14: measured("interrupt/cancel recovery turn cost", costEquiv, [wastedTurn], "MAIN_ONLY"),
  E1: measured(
    "cost of pre-edit turns past the workspace p50 in sessions over its p75",
    costEquiv,
    [assumed("E1_AVOIDANCE_FRACTION", E1_AVOIDANCE_FRACTION)],
    "MAIN_ONLY",
  ),
  E2: measured(
    "main-thread mechanical run cost less a Sonnet subagent's cost for the same turns",
    costEquiv,
    [assumed("E2_AVOIDANCE_FRACTION", E2_AVOIDANCE_FRACTION)],
    "MAIN_ONLY",
  ),
  G11: measured("high-spend failure excess tokens", "turns token columns", [
    assumed("G11_AVOIDANCE_FRACTION", G11_AVOIDANCE_FRACTION),
  ]),
  H1: measured(
    "destructive-operation work-at-risk cost",
    "tool_events and turns.cost_equiv_u",
    [],
    "MAIN_ONLY",
  ),
};

function contractFor(id: string): QuantityContract {
  const contract = DETECTOR_CONTRACTS[id];
  if (!Object.hasOwn(DETECTOR_CONTRACTS, id) || !contract) {
    throw new Error(`Unknown detector id: ${id}`);
  }
  return contract;
}

export function hasAssumed(id: string): boolean {
  return contractFor(id).constants.some((constant) => constant.status === "ASSUMED");
}

/**
 * The value at the bounds of the first assumed fraction: savings scale with a fraction linearly.
 * Other assumptions (D2's split cadence and summary size) do not: D2 stores the range it gets by
 * re-running its model at their bounds (`savings_low/high_u_per_wk`), and the card uses that.
 */
export function rangeFor(id: string, valueU: number): [number, number] {
  const factor = contractFor(id).constants.find(
    (constant): constant is Extract<ConstantDecl, { status: "ASSUMED" }> =>
      constant.status === "ASSUMED" && constant.name.endsWith("_FRACTION"),
  );
  if (!factor) return [valueU, valueU];
  return [
    Math.round((valueU / factor.value) * factor.min),
    Math.round((valueU / factor.value) * factor.max),
  ];
}
