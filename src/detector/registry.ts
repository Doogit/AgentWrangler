/**
 * src/detector/registry.ts — the registered Tier-1 detectors.
 *
 * Evaluated detectors fire recommendations; UNEVALUATED_DETECTORS carry a fixed
 * status/note so the query layer can report them honestly in the detectors[]
 * strip. Ids are reconciled to engine-spec §2.0 (runtime ids frozen for anything
 * that has fired — D1/D2/D4/D5). Spec-D3 is RETIRED (its routing concept is
 * realized at runtime D4); its id must not be reused.
 */

import { a1Detector } from "./detectors/a1_tool_result_bloat.js";
import { a2Detector } from "./detectors/a2_task_output_bloat.js";
import { b1Detector } from "./detectors/b1_cache_read_collapse.js";
import { b2Detector } from "./detectors/b2_cache_ttl_gap.js";
import { b3Detector } from "./detectors/b3_resume_cache_miss.js";
import { b4Detector } from "./detectors/b4_mid_session_prefix_break.js";
import { c1Detector } from "./detectors/c1_tool_error_rate.js";
import { c2Detector } from "./detectors/c2_content_not_found.js";
import { c3Detector } from "./detectors/c3_edit_before_read.js";
import { c4Detector } from "./detectors/c4_failed_edit_recovery.js";
import { c5Detector } from "./detectors/c5_same_error_loop.js";
import { c6Detector } from "./detectors/c6_edit_flip_flop.js";
import { c7Detector } from "./detectors/c7_bash_failure_cluster.js";
import { c9Detector } from "./detectors/c9_denial_friction.js";
import { c11Detector } from "./detectors/c11_mcp_output_cap.js";
import { d1Detector } from "./detectors/d1_ctx_always_loaded.js";
import { d2Detector } from "./detectors/d2_session_long_full_context.js";
import { d4Detector } from "./detectors/d4_model_mismatch.js";
import { d5Detector } from "./detectors/d5_limit_burn_forecast.js";
import { d6Detector } from "./detectors/d6_tool_result_bloat.js";
import { d7Detector } from "./detectors/d7_loop_retry_waste.js";
import { d8Detector } from "./detectors/d8_cache_write_churn.js";
import { d9Detector } from "./detectors/d9_idle_background_session.js";
import { d10Detector } from "./detectors/d10_catalog_footprint.js";
import { d11Detector } from "./detectors/d11_tool_error_rate.js";
import { d12Detector } from "./detectors/d12_subagent_overspawn.js";
import { d14Detector } from "./detectors/d14_interrupt_cancel.js";
import { e1Detector } from "./detectors/e1_orientation_before_first_edit.js";
import { e2Detector } from "./detectors/e2_main_thread_mechanical_runs.js";
import { g11Detector } from "./detectors/g11_high_spend_failure.js";
import { h1Detector } from "./detectors/h1_destructive_operations.js";
import type { AnyDetector, DetectorStatusKind } from "./types.js";

/** The detectors this engine evaluates and can fire. */
export const DETECTORS: AnyDetector[] = [
  a1Detector,
  a2Detector,
  b1Detector,
  b2Detector,
  b3Detector,
  b4Detector,
  c1Detector,
  c2Detector,
  c3Detector,
  c4Detector,
  c5Detector,
  c6Detector,
  c7Detector,
  c9Detector,
  c11Detector,
  d1Detector,
  d2Detector,
  d4Detector,
  d5Detector,
  d6Detector,
  d7Detector,
  d8Detector,
  d9Detector,
  d10Detector,
  d11Detector,
  d12Detector,
  d14Detector,
  e1Detector,
  e2Detector,
  g11Detector,
  h1Detector,
];

/** Detectors catalogued but not evaluated, with their fixed live status. */
export const UNEVALUATED_DETECTORS: Array<{
  id: string;
  name: string;
  status: DetectorStatusKind;
  note: string;
}> = [];
