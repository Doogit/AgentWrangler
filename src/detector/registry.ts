/**
 * src/detector/registry.ts — the registered Tier-1 detectors.
 *
 * Evaluated detectors fire recommendations; UNEVALUATED_DETECTORS carry a fixed
 * status/note so the query layer can report them honestly in the detectors[]
 * strip. Ids are reconciled to engine-spec §2.0 (runtime ids frozen for anything
 * that has fired — D1/D2/D4/D5). Spec-D3 is RETIRED (its routing concept is
 * realized at runtime D4); its id must not be reused.
 */

import { d1Detector } from "./detectors/d1_ctx_always_loaded.js";
import { d2Detector } from "./detectors/d2_session_long_full_context.js";
import { d4Detector } from "./detectors/d4_model_mismatch.js";
import { d5Detector } from "./detectors/d5_limit_burn_forecast.js";
import { d6Detector } from "./detectors/d6_tool_result_bloat.js";
import { d7Detector } from "./detectors/d7_loop_retry_waste.js";
import { d8Detector } from "./detectors/d8_cache_write_churn.js";
import { d9Detector } from "./detectors/d9_idle_background_session.js";
import { d10Detector } from "./detectors/d10_catalog_footprint.js";
import type { Detector, DetectorStatusKind } from "./types.js";

/** The detectors this engine evaluates and can fire. */
export const DETECTORS: Detector[] = [
  d1Detector,
  d2Detector,
  d4Detector,
  d5Detector,
  d6Detector,
  d7Detector,
  d8Detector,
  d9Detector,
  d10Detector,
];

/** Detectors catalogued but not evaluated, with their fixed live status. */
export const UNEVALUATED_DETECTORS: Array<{
  id: string;
  name: string;
  status: DetectorStatusKind;
  note: string;
}> = [];
