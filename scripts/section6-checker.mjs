/**
 * Independent Section 6 completeness checker.
 *
 * This intentionally consumes the persisted recommendation query and the same
 * prompt/snippet selection used by RecCard. It does not alter detector or
 * recommendation production. The returned report contains only booleans and
 * numeric counts so it is safe to save or share as an aggregate artifact.
 */
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db/open.js";
import { listRecommendations } from "../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../src/query/db-context.js";
import {
  buildPromptArtifact,
  generateAutocompactSnippet,
  generateCacheBehaviorSnippet,
  generateD7LoopRetrySnippet,
  generateDestructiveGuardSnippet,
  generateFrictionRuleSnippet,
  generateModelDefaultSnippet,
  generateSettingsDisableBlock,
} from "../src/ui/recommendations/prompt-templates.js";
import { rawContentReasons } from "./hooks/content-signatures.mjs";

/**
 * The unique detector ids covered by scripts/parity/golden-set.json that render their own live
 * card. B2 is left out: its card folds into D8's (operator, P3.1-T4 / review 1 R2.8).
 */
export const GOLDEN_DETECTOR_IDS = Object.freeze([
  "B1",
  "B4",
  "C2",
  "C3",
  "C4",
  "C5",
  "C7",
  "C9",
  "C11",
  "D7",
  "D8",
  "D14",
  "H1",
]);

const RULE_KEYS = Object.freeze(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "SEC101"]);

/** Golden detectors with a concrete generated-artifact route in the live renderer. */
export const ARTIFACT_REQUIRED_DETECTOR_IDS = Object.freeze(
  GOLDEN_DETECTOR_IDS.filter((detectorId) => detectorId !== "D14"),
);

const PULL_REQUEST_URL =
  /https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\/[^/\s]+\/[^/\s]+\/(?:pull|pulls|merge_requests)\/\d+/i;
const RAW_ABSOLUTE_PATH =
  /(?:\b[A-Za-z]:[\\/]|(?:^|[\s"'`])\/(?:Users|home|private|tmp|var|etc)\/)/;
const RAW_ERROR_OUTPUT =
  /\b(?:stack trace|stderr:|uncaught(?: exception)?|command failed|exit code\s+\d+)\b/i;

/**
 * R7 is a rollback-guidance content check across every artifact shape, not a
 * single structured field. C9's artifact carries a dedicated `rollback` string;
 * every Phase-2.5 GeneratedSnippet bakes a "Rollback:" / "Uninstall:" line into
 * its caption/text instead. A field-only check (`typeof artifact.rollback`) is
 * satisfiable by C9 alone, so it is false for the other 12 by construction —
 * scan the artifact's string VALUES (not keys) for rollback language instead.
 */
const ROLLBACK_LANGUAGE = /\b(?:rollback|uninstall|undo|revert)\b/i;

function objectMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Every string leaf value in a nested artifact, joined — keys excluded. */
function stringLeaves(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
  return Object.values(value).map(stringLeaves).join("\n");
}

function renderedPrimaryArtifact(rec) {
  const snippet =
    generateSettingsDisableBlock(rec) ??
    generateModelDefaultSnippet(rec) ??
    generateAutocompactSnippet(rec) ??
    generateFrictionRuleSnippet(rec) ??
    generateD7LoopRetrySnippet(rec) ??
    generateDestructiveGuardSnippet(rec) ??
    generateCacheBehaviorSnippet(rec);
  const prompt = buildPromptArtifact(rec);

  return {
    artifact: snippet ?? prompt,
    artifactCount: (snippet === null ? 0 : 1) + (prompt === null ? 0 : 1),
  };
}

function evidenceCounts(rec) {
  const evidence = objectMap(rec.evidence);
  const metrics = objectMap(evidence?.metrics);
  const metricCount = metrics === null ? 0 : Object.keys(metrics).length;
  const nestedWindow = objectMap(evidence?.window);
  const hasWindow =
    nestedWindow !== null ||
    (typeof evidence?.window_from === "string" && typeof evidence?.window_to === "string");

  return { hasWindow, metricCount };
}

function metricValue(metric) {
  const map = objectMap(metric);
  return typeof map?.value === "number" && Number.isFinite(map.value) ? map.value : null;
}

/**
 * R6 is intentionally evidence-structural, not a caption word search. A pair
 * must be populated under corresponding PREVIOUS/CURRENT, BEFORE/AFTER, or
 * BASELINE/AFTER closed metric keys.
 */
function hasBeforeAfterMetricPair(rec) {
  const evidence = objectMap(rec.evidence);
  const metrics = objectMap(evidence?.metrics);
  if (metrics === null) return false;

  const keys = Object.keys(metrics);
  const hasValue = (key) => metricValue(metrics[key]) !== null;
  const paired = (beforeToken, afterToken) =>
    keys.some((key) => {
      if (!key.startsWith(beforeToken)) return false;
      const suffix = key.slice(beforeToken.length);
      return hasValue(key) && hasValue(`${afterToken}${suffix}`);
    });

  return (
    paired("PREVIOUS_", "CURRENT_") || paired("BEFORE_", "AFTER_") || paired("BASELINE_", "AFTER_")
  );
}

/**
 * SEC-101 is assessed at the DISTRIBUTION boundary only — the rendered artifact
 * a user copies/pastes (and could commit), never the local DB `evidence`. Under
 * ADR-112 the daemon DB MAY retain targeted content slices a detector consumes;
 * scanning `evidence` here would falsely flag those permitted local retentions.
 * The report itself is independently constrained to booleans/numbers below, but
 * that is not the privacy check.
 */
function hasProhibitedContent(value) {
  const serialized = JSON.stringify(value);
  if (rawContentReasons(serialized).length > 0) return true;
  return (
    PULL_REQUEST_URL.test(serialized) ||
    RAW_ABSOLUTE_PATH.test(serialized) ||
    RAW_ERROR_OUTPUT.test(serialized)
  );
}

function onlyBooleansAndNumbers(value) {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(onlyBooleansAndNumbers);
}

function detectorResult(rec) {
  if (rec === undefined) {
    return {
      R1: false,
      R2: false,
      R3: false,
      R4: false,
      R5: false,
      R6: false,
      R7: false,
      SEC101: true,
      recommendation_count: 0,
      artifact_count: 0,
      metric_count: 0,
      window_count: 0,
    };
  }

  const { artifact, artifactCount } = renderedPrimaryArtifact(rec);
  const { hasWindow, metricCount } = evidenceCounts(rec);

  const result = {
    R1:
      typeof rec.rec_id === "string" &&
      rec.rec_id.length > 0 &&
      typeof rec.title === "string" &&
      rec.title.length > 0,
    R2: metricCount > 0 && hasWindow,
    R3: typeof rec.category === "string" && rec.category.length > 0,
    R4: artifact !== null,
    R5: rec.scope_workspace_id === null || typeof rec.scope_workspace_id === "string",
    R6: hasBeforeAfterMetricPair(rec),
    R7: ROLLBACK_LANGUAGE.test(stringLeaves(artifact)),
    SEC101: !hasProhibitedContent(artifact),
    recommendation_count: 1,
    artifact_count: artifactCount,
    metric_count: metricCount,
    window_count: hasWindow ? 1 : 0,
  };
  return result;
}

/**
 * Render the live recommendation path for every golden detector from `db`.
 * R1-R7 are the observable fallback rules described by the Section 6 plan:
 * identity/title, metric/window, category, action artifact, scope, named
 * before/after pair, and rollback guidance in the artifact respectively.
 */
export function runSection6Checker(db) {
  setQueryDb(db);
  try {
    const view = listRecommendations().data;
    const cards = new Map();
    // B5 split the PROPOSED lane into the ranked `active` list, the pinned safety slot,
    // and the Track-D friction lane. Scan `active` first so a detector with both a priced
    // and a null-$/wk card (e.g. B1) resolves to its ranked card. A card under its floor
    // (P3.1 review 2) is not listed but is still built, so its rendering is checked too.
    for (const section of [
      view.active,
      view.pinned_safety ?? [],
      view.friction_safety ?? [],
      view.adopted,
      view.dismissed,
      view.below_floor ?? [],
    ]) {
      for (const card of section) {
        if (!cards.has(card.rec_id)) cards.set(card.rec_id, card);
      }
    }

    const report = {};
    for (const detectorId of GOLDEN_DETECTOR_IDS) {
      const card = [...cards.values()].find((candidate) => candidate.detector_id === detectorId);
      report[detectorId] = detectorResult(card);
    }

    for (const detectorId of GOLDEN_DETECTOR_IDS) {
      const result = report[detectorId];
      if (!RULE_KEYS.every((key) => typeof result[key] === "boolean")) {
        throw new TypeError("Section 6 report rule result was not boolean");
      }
      if (!onlyBooleansAndNumbers(result)) {
        throw new TypeError("Section 6 report included non-numeric content");
      }
    }
    return report;
  } finally {
    resetQueryDb();
  }
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = process.argv[2];
  if (dbPath === undefined) throw new TypeError("A shared seed database path is required");
  const db = openDb(dbPath);
  try {
    process.stdout.write(`${JSON.stringify(runSection6Checker(db))}\n`);
  } finally {
    db.close();
  }
}
