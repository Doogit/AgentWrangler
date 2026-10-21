/**
 * Frozen U11 reconciliation between detector-library-v2 rules and the existing
 * runtime registry. This is a build-time contract: it prevents a partial signal
 * overlap from being treated as an already implemented library rule.
 *
 * `extend` means build the complete V2 rule while preserving the existing V1
 * detector behavior. It does not authorize changing the mapped runtime detector.
 */

export type Wave1ReconciliationDisposition = "verify-only" | "extend" | "build";

export interface Wave1ReconciliationRow {
  ruleId: string;
  existingRuntimeId: string | null;
  disposition: Wave1ReconciliationDisposition;
  ruleSource: string;
  behavioralTest: string | null;
  rationale: string;
  precisionRecertificationRequired: true;
}

const LIBRARY_SOURCE = "docs/research/detector-library-v2.md";
const TMD_AUDIT_SOURCE = "docs/planning/TMD-coverage-audit-and-implementation-plan.md";
const TMD_FOLLOWONS_SOURCE = "docs/planning/TMD-followons-implementation-plan-v1.md";

export const WAVE1_RECONCILIATION = [
  {
    ruleId: "A1",
    existingRuntimeId: "D6",
    disposition: "extend",
    ruleSource: `${LIBRARY_SOURCE}#1-category-a--token--cost-waste`,
    behavioralTest: null,
    rationale:
      "D6 aggregates per-session bloat; A1 requires per-tool >25 KB events and tool attribution.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "A5",
    existingRuntimeId: "D9",
    disposition: "extend",
    ruleSource: `${LIBRARY_SOURCE}#1-category-a--token--cost-waste`,
    behavioralTest: null,
    rationale:
      "D9 uses sidechain idle burn; A5 also requires no-user-message and zero-user-turn cases.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "A6",
    existingRuntimeId: "D2",
    disposition: "extend",
    ruleSource: `${LIBRARY_SOURCE}#1-category-a--token--cost-waste`,
    behavioralTest: null,
    rationale:
      "D2 detects long full-context sessions; A6 requires cumulative 60%/80% crossings and turns above 80%.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "A7",
    existingRuntimeId: "D4",
    disposition: "extend",
    ruleSource: `${LIBRARY_SOURCE}#1-category-a--token--cost-waste`,
    behavioralTest: null,
    rationale:
      "D4 is model-routing guidance; A7 specifically measures short Opus turns and CEU share by model.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "A10",
    existingRuntimeId: "D10",
    disposition: "extend",
    ruleSource: `${LIBRARY_SOURCE}#1-category-a--token--cost-waste`,
    behavioralTest: null,
    rationale:
      "D10 measures catalog footprint; A10 requires first-turn schema overhead and MCP-server attribution.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "B1",
    existingRuntimeId: null,
    disposition: "build",
    ruleSource: `${LIBRARY_SOURCE}#2-category-b--cache-efficiency`,
    behavioralTest: null,
    rationale:
      "No runtime detector implements the sequential cache-read collapse event and trigger attribution.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "B2",
    existingRuntimeId: "D8",
    disposition: "extend",
    ruleSource: `${LIBRARY_SOURCE}#2-category-b--cache-efficiency`,
    behavioralTest: null,
    rationale:
      "D8 detects repeated cache-write churn; B2 starts from a B1 miss and classifies the applicable TTL gap.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "B3",
    existingRuntimeId: null,
    disposition: "build",
    ruleSource: `${LIBRARY_SOURCE}#2-category-b--cache-efficiency`,
    behavioralTest: null,
    rationale:
      "No runtime detector classifies a B1 cache miss at a session boundary with large cache creation.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "B4",
    existingRuntimeId: null,
    disposition: "build",
    ruleSource: `${LIBRARY_SOURCE}#2-category-b--cache-efficiency`,
    behavioralTest: null,
    rationale: "No runtime detector classifies a no-gap, mid-session cache-creation spike.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "C1",
    existingRuntimeId: "D11",
    disposition: "extend",
    ruleSource: `${LIBRARY_SOURCE}#3-category-c--tool-errors-loops-permission-friction`,
    behavioralTest: null,
    rationale:
      "D11 compares one substitutable shell pair; C1 requires per-tool rates against a corpus baseline.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "C5",
    existingRuntimeId: "D7",
    disposition: "extend",
    ruleSource: `${LIBRARY_SOURCE}#3-category-c--tool-errors-loops-permission-friction`,
    behavioralTest: null,
    rationale:
      "D7 detects retry waste broadly; C5 requires three identical tool and error-class-hash occurrences.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "D1",
    existingRuntimeId: null,
    disposition: "build",
    ruleSource: `${LIBRARY_SOURCE}#4-category-d--user-friction--corrections`,
    behavioralTest: null,
    rationale:
      "No runtime detector implements the correction lexicon classes with a preceding-turn anchor.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "E1",
    existingRuntimeId: "D7",
    disposition: "extend",
    ruleSource: `${LIBRARY_SOURCE}#5-category-e--context-hygiene`,
    behavioralTest: null,
    rationale:
      "D7 has a cross-session read signal; E1 requires same-path main-chain rereads without an intervening mutation.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "F1",
    existingRuntimeId: null,
    disposition: "build",
    ruleSource: `${LIBRARY_SOURCE}#6-category-f--subagents`,
    behavioralTest: null,
    rationale:
      "D12 is a directional output-volume heuristic; F1 requires Task counts and parallel-versus-serial overlap.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "TMD-D11",
    existingRuntimeId: "D11",
    disposition: "verify-only",
    ruleSource: `${TMD_AUDIT_SOURCE}#item-3--tool-error-rate-by-tool-detector--signal-a--new-detector-d11-d3-retired-do-not-reuse`,
    behavioralTest: "test/detector/d11-tool-error-rate.test.ts",
    rationale:
      "The committed behavioral test covers the separately specified and shipped TMD D11 rule.",
    precisionRecertificationRequired: true,
  },
  {
    ruleId: "TMD-D12",
    existingRuntimeId: "D12",
    disposition: "verify-only",
    ruleSource: `${TMD_FOLLOWONS_SOURCE}#u3--directional-subagent-over-spawn-proxy-item-5`,
    behavioralTest: "test/detector/d12-subagent-overspawn.test.ts",
    rationale:
      "The committed behavioral test covers the separately specified and shipped TMD D12 rule.",
    precisionRecertificationRequired: true,
  },
] as const satisfies readonly Wave1ReconciliationRow[];
