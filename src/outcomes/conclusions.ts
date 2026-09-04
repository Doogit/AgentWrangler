/**
 * src/outcomes/conclusions.ts — shared PURE post-processing for GitHub reads.
 *
 * M-03 dedup: both GitHub transports (fetch-based client.ts and gh-CLI
 * gh-cli-client.ts) aggregated check-run conclusions and normalized PR bodies
 * with copy-pasted logic. Only the transport differs (HTTP fetch vs `gh api`
 * subprocess); this module owns the transport-independent post-processing so
 * the two can never drift. NO wire calls, pagination, retry, or timeout logic
 * lives here.
 */

import type { GhCheckRun } from "./github/client.js";
import type { GhResult } from "./github/client.js";

/** Shape of the REST check-runs response body (identical on both transports). */
export interface CheckRunsBody {
  check_runs: GhCheckRun[];
  total_count: number;
}

/** Conclusions that do NOT block a SUCCESS verdict. */
const BENIGN_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * Aggregate a fetched check-runs body into the single conclusion string
 * consumed by work_items.checks_conclusion:
 *   truncated body → {ok:false, reason:"github-checks-truncated:n/m"} (honest
 *   refusal rather than a conclusion from partial data; warns on stderr),
 *   zero runs → "NONE",
 *   any FAILURE → "FAILURE",
 *   anything not SUCCESS/SKIPPED/NEUTRAL → "PENDING",
 *   otherwise → "SUCCESS".
 */
export function aggregateCheckConclusion(body: CheckRunsBody): GhResult<string> {
  const runs = body.check_runs;
  if (body.total_count > runs.length) {
    console.warn(
      `Outcomes: check-runs truncated (${runs.length}/${body.total_count}) — conclusion may be incomplete`,
    );
    return { ok: false, reason: `github-checks-truncated:${runs.length}/${body.total_count}` };
  }
  if (runs.length === 0) return { ok: true, data: "NONE" };
  const conclusions = runs.map((r) => r.conclusion?.toUpperCase() ?? "PENDING");
  if (conclusions.includes("FAILURE")) return { ok: true, data: "FAILURE" };
  if (conclusions.some((c) => !BENIGN_CONCLUSIONS.has(c))) {
    return { ok: true, data: "PENDING" };
  }
  return { ok: true, data: "SUCCESS" };
}

/**
 * Normalize a fetched PR JSON object to the PR-body string: null/missing body
 * → "" (both transports previously duplicated the `?? ""`).
 */
export function normalizePRBody(data: { body: string | null }): string {
  return data.body ?? "";
}
