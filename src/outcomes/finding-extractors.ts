/**
 * Pure, deterministic projections for the experimental E1/E2/E3 finding
 * extractors. These functions never read or write the operator database.
 * Callers must keep the returned evidence text in memory or approved ephemeral
 * evidence state; production persists only the structural identifiers.
 */

export const EXTRACTOR_VERSIONS = {
  E1: "unresolved-thread-v1",
  E2: "deferral-section-v1",
  E3: "diff-marker-v1",
} as const;

export type ExtractorId = keyof typeof EXTRACTOR_VERSIONS;

export interface ReviewThreadInput {
  id: string;
  isResolved: boolean;
}

export interface ReviewThreadFinding {
  sourceFindingId: string;
  evidenceRef: string;
  status: "ADDRESSED" | "DEFERRED";
  evidence: {
    stateAtRelevantTime: "RESOLVED" | "UNRESOLVED";
    temporalBasis: "CURRENT_STATE_ONLY";
  };
}

export interface DeferralFinding {
  sourceFindingId: string;
  evidenceRef: string;
  status: "DEFERRED";
  /** Raw matched list item for a future approval-bounded packet projection. */
  evidenceText: string;
}

export interface DiffMarkerFinding {
  sourceFindingId: string;
  evidenceRef: string;
  status: "UNKNOWN";
  /** Raw added line for a future approval-bounded packet projection. */
  evidenceText: string;
  filePath: string;
  lineNumber: number;
}

export interface DiffMarkerCandidate {
  evidenceText: string;
  filePath: string;
  lineNumber: number;
}

/**
 * Project current GitHub review-thread state. Current `isResolved` is never
 * represented as proof of state at merge.
 */
export function projectReviewThreadFindings(
  workItemId: string,
  threads: readonly ReviewThreadInput[],
): ReviewThreadFinding[] {
  return threads.map((thread) => ({
    sourceFindingId: `e1:${workItemId}:${thread.id}`,
    evidenceRef: thread.id,
    status: thread.isResolved ? "ADDRESSED" : "DEFERRED",
    evidence: {
      stateAtRelevantTime: thread.isResolved ? "RESOLVED" : "UNRESOLVED",
      temporalBasis: "CURRENT_STATE_ONLY",
    },
  }));
}

const DEFERRAL_HEADING_RE = /^#{1,4}\s*(deferred|follow[- ]?ups?|known issues|out of scope)\b/im;

function deferralKeywordClass(headingLine: string): string {
  const keyword = (
    /(deferred|follow[- ]?ups?|known issues|out of scope)/i.exec(headingLine)?.[1] ?? ""
  ).toLowerCase();
  if (keyword.startsWith("defer")) return "deferred";
  if (keyword.startsWith("follow")) return "follow-ups";
  if (keyword.startsWith("known")) return "known-issues";
  if (keyword.startsWith("out")) return "out-of-scope";
  return "section";
}

export function extractDeferralFindings(body: string, workItemId: string): DeferralFinding[] {
  const results: DeferralFinding[] = [];
  let inSection = false;
  let sectionClass = "section";
  let itemIndex = 0;

  for (const line of body.split("\n")) {
    if (DEFERRAL_HEADING_RE.test(line)) {
      inSection = true;
      sectionClass = deferralKeywordClass(line);
      itemIndex = 0;
      continue;
    }
    if (!inSection) continue;
    if (/^#{1,4}\s/.test(line)) {
      inSection = false;
      continue;
    }
    if (!/^\s*[-*]\s+\S/.test(line)) continue;

    results.push({
      sourceFindingId: `e2:${workItemId}:${results.length}`,
      evidenceRef: `${workItemId}:e2:${sectionClass}:${itemIndex}`,
      status: "DEFERRED",
      evidenceText: line,
    });
    itemIndex++;
  }

  return results;
}

const EXCLUDED_GLOBS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /composer\.lock$/,
  /Gemfile\.lock$/,
  /poetry\.lock$/,
  /go\.sum$/,
  /node_modules\//,
  /vendor\//,
  /dist\//,
  /build\//,
  /\.min\.js$/,
  /\.min\.css$/,
];

const TODO_FIXME_RE = /\b(TODO|FIXME)\b/;
const DIFF_FILE_RE = /^\+\+\+\s+b\/(.+)$/;
const DIFF_HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_ADD_RE = /^\+(?!\+\+)/;

function isExcludedFile(filePath: string): boolean {
  return EXCLUDED_GLOBS.some((pattern) => pattern.test(filePath));
}

/** Pure E3 detection seam. It deliberately has no commit or work-item identity. */
export function projectDiffMarkerCandidates(diff: string): DiffMarkerCandidate[] {
  const results: DiffMarkerCandidate[] = [];
  let currentFile = "";
  let lineNumber = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = DIFF_FILE_RE.exec(line);
    if (fileMatch !== null) {
      currentFile = fileMatch[1] ?? "";
      continue;
    }

    const hunkMatch = DIFF_HUNK_RE.exec(line);
    if (hunkMatch !== null) {
      lineNumber = Number.parseInt(hunkMatch[1] ?? "0", 10) - 1;
      continue;
    }

    if (DIFF_ADD_RE.test(line)) {
      lineNumber++;
      if (!isExcludedFile(currentFile) && TODO_FIXME_RE.test(line)) {
        results.push({
          evidenceText: line.slice(1),
          filePath: currentFile,
          lineNumber,
        });
      }
    } else if (line.startsWith(" ")) {
      lineNumber++;
    }
  }

  return results;
}

export function extractDiffMarkerFindings(
  diff: string,
  commitSha: string,
  workItemId: string,
): DiffMarkerFinding[] {
  return projectDiffMarkerCandidates(diff).map((candidate, index) => ({
    sourceFindingId: `e3:${workItemId}:${index}`,
    evidenceRef: `${candidate.filePath}:${candidate.lineNumber}@${commitSha.slice(0, 7)}`,
    status: "UNKNOWN",
    ...candidate,
  }));
}
