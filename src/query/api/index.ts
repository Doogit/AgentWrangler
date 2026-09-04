/**
 * src/query/api/index.ts — LocalQueryAPI barrel.
 *
 * The stable read seam between the daemon and the SPA.
 * FROZEN in WP0 — method names and return-type shapes must not change without
 * a plan decision (changing them breaks WP2/WP3/WP4 concurrently in flight).
 *
 * Ownership split (for parallel fan-out per §12):
 *  - overview.ts: WP2 (getGlobalOverview, listWorkspaces, getWorkspace,
 *                      listSessions, getSession, getTurnTimeline)
 *  - settings.ts: WP4 (getSettings, updateSettings)
 *
 * The UI never imports sql or better-sqlite3 directly. All data access goes
 * through this barrel.
 */

export type {
  ApiResponse,
  ClaimKind,
  QueryWindow,
  Qualification,
  DrilldownIds,
  ResponseMeta,
} from "../envelope.js";
export { stubResponse, buildResponse } from "../envelope.js";

// Overview / spend path (WP2)
export type {
  WindowFilter,
  Cursor,
  GlobalOverview,
  BurnForecast,
  ContextPerTurnRow,
  ModelMixRow,
  LiveSessionRow,
  WorkspaceSummary,
  WorkspaceDetail,
  SessionSummary,
  TurnRow,
  PagedList,
} from "./overview.js";
export {
  getGlobalOverview,
  listWorkspaces,
  getWorkspace,
  listSessions,
  getSession,
  getTurnTimeline,
  listLiveSessions,
} from "./overview.js";

// Settings (WP4)
export type {
  Settings,
  SettingsUpdate,
  WorkspaceMapping,
  ParserHealth,
  CalibrateResult,
  CalibrateBytesPerTokenResult,
} from "./settings.js";
export {
  getSettings,
  updateSettings,
  resetDatabase,
  calibrateLimit,
  calibrateBytesPerToken,
} from "./settings.js";

// Recommendations (DetectorEngine WP)
export type {
  RecommendationCard,
  RecommendationGroup,
  DetectorStatus,
  RecommendationsView,
  ModeledFormula,
} from "./recommendations.js";
export {
  listRecommendations,
  getRecommendationCard,
  dismissRecommendation,
  adoptRecommendation,
  deriveActiveGroups,
  buildSeededPrompt,
} from "./recommendations.js";

// Assisted apply (W3-A)
export type { ApplyJobPublic, ApplyJobStatus } from "../../apply/jobs.js";
export { startApplyJob, getApplyJob, confirmApplyJob, rollbackApplyJob } from "../../apply/jobs.js";

// Open in Claude Code ↗ — O11 Apply Console phase 1 (Option B)
export type { OpenTerminalResult } from "../../apply/open-terminal.js";
export { openTerminalForRec } from "../../apply/open-terminal.js";

// Impact Ledger (W4)
export type { EffectRow, LedgerEntry, LedgerView } from "./recommendations-ledger.js";
export { listLedger } from "./recommendations-ledger.js";

// Outcomes (WP5)
export type {
  SuccessRateData,
  WorkspaceOutcomeSummary,
  WorkItemDetail,
  FindingSummary,
  LinkageRateData,
} from "./outcomes.js";
export {
  getSuccessRate,
  listWorkspaceOutcomes,
  getWorkspaceOutcomeDetail,
  getLinkageRate,
} from "./outcomes.js";

// Stored deterministic weekly reports
export type { Report } from "./reports.js";
export { generateWeeklyReport, listReports, getReport } from "./reports.js";

// Spend-Viz-v2 — flavor decomposition + cache efficiency
export type {
  FlavorKey,
  FlavorRow,
  FlavorDecomposition,
  CacheEfficiency,
  CacheEfficiencySignal,
} from "./spend-flavor.js";
export {
  classifyCacheEfficiency,
  getFlavorDecomposition,
  getCacheEfficiency,
} from "./spend-flavor.js";

// Spend-Viz-v2 — cache-write spike timeline
export type { CacheWriteTrend, CacheWriteBucketRow } from "./trends.js";
export { getCacheWriteTrend, detectSpikes } from "./trends.js";

// B5 context composition (standalone; does not extend frozen WorkspaceDetail)
export type {
  ContextComposition,
  ContextCompositionKey,
  ContextCompositionRow,
} from "./context-composition.js";
export { getContextComposition } from "./context-composition.js";

// Context-budget hook contract (standalone; does not extend frozen settings).
export type { ContextBudget } from "./context-budget.js";
export { getContextBudget } from "./context-budget.js";

// Delivery proxy metrics (L2a)
export type { DeliveryMetrics, DeliveryQueryOpts } from "./delivery.js";
export { getDeliveryMetrics } from "./delivery.js";

// Effectiveness path metrics (EF1 + EF2)
export type {
  SessionDelivery,
  AbandonedSpendSplit,
  AbandonedSpendSplitOpts,
  ClosureStatus,
  ClosureProxy,
} from "./effectiveness.js";
export {
  computeSessionDelivery,
  getAbandonedSpendSplit,
  getClosureProxy,
  getSessionClosureStatus,
} from "./effectiveness.js";
export type { SessionDriver, SessionDrivers } from "./session-drivers.js";
export { getSessionDrivers } from "./session-drivers.js";
export type { LoopGuard } from "./loop-guard.js";
export { getLoopGuard } from "./loop-guard.js";
export type { HookConfig, HookConfigUpdate } from "./hook-config.js";
export { getHookConfig, updateHookConfig } from "./hook-config.js";
export type { HookInstallResult } from "./hook-install.js";
export { installHookRoute, uninstallHookRoute } from "./hook-install.js";
export type { IdleSession } from "./idle-sessions.js";
export { getIdleSessions } from "./idle-sessions.js";

// Burn-status (RV8 — OAuth-backed rate-limit burn)
export type { BurnStatus } from "./burn-status.js";
export { getBurnStatus } from "./burn-status.js";
export type { SelfChurnMetrics, SelfChurnQueryOpts } from "./self-churn.js";
export { getSelfChurn } from "./self-churn.js";
export type { OffloadShareMetrics, OffloadShareQueryOpts } from "./offload-share.js";
export { getOffloadShare } from "./offload-share.js";
export type {
  SessionSpendPercentile,
  WeeklyMetricSelfPercentile,
  WeeklySelfPercentile,
} from "./self-percentiles.js";
export { getSessionSpendPercentile, getWeeklySelfPercentile } from "./self-percentiles.js";

// Lifecycle cost-per-success (R4a)
export type { CostPerSuccess } from "./cost-per-success.js";
export { getCostPerSuccess } from "./cost-per-success.js";
