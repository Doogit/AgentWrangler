import type { Db } from "../src/db/open.js";

export interface Section6DetectorResult {
  [rule: string]: boolean | number;
  R1: boolean;
  R2: boolean;
  R3: boolean;
  R4: boolean;
  R5: boolean;
  R6: boolean;
  R7: boolean;
  SEC101: boolean;
  recommendation_count: number;
  artifact_count: number;
  metric_count: number;
  window_count: number;
}

export type GoldenDetectorId =
  | "B1"
  | "B2"
  | "B4"
  | "C2"
  | "C3"
  | "C4"
  | "C5"
  | "C7"
  | "C9"
  | "C11"
  | "D7"
  | "D8"
  | "D14"
  | "H1";

export const GOLDEN_DETECTOR_IDS: readonly GoldenDetectorId[];
export const ARTIFACT_REQUIRED_DETECTOR_IDS: readonly GoldenDetectorId[];
export function runSection6Checker(db: Db): Record<GoldenDetectorId, Section6DetectorResult>;
