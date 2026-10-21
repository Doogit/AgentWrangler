/**
 * src/ui/recommendations/RecCard.tsx — one active recommendation card.
 *
 * Default (collapsed) state: title + per-turn-delta headline +
 * ONE honesty chip + Dismiss/Adopt/Copy prompt/expand buttons. The Evidence
 * table, formula, provenance, target_metric, and caveats are behind a
 * "Show details / methodology" toggle that expands inline.
 *
 * Headline fix: leads with the per-turn delta; modeled savings stay in details.
 * Raw weekly-token counts are dropped from the visible headline to avoid
 * the ~10× overstatement when cache reads (0.1× cap-weight) are shown
 * at full weight.
 *
 * D1 backfire caveat: editing the cached prefix forces one full-price
 * cache WRITE next turn — warn the user in the expanded section.
 */

import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { EffectEvidencePage } from "../../effects/api-contract";
import { callUsage } from "../../query/api/rec-actions/trigger"; // browser-safe: formatting only
import type { CardActionOption } from "../../query/api/rec-actions/types";
import { buildSeededPrompt } from "../../query/api/rec-prompt"; // browser-safe; avoids pulling server-side graph
import type {
  BoundedStep,
  RecommendationCard,
  RecommendationGroup,
} from "../../query/api/recommendations";
import { fetchHookConfig, installHook } from "../api/client";
import {
  attestRollbackEffect,
  changeRecommendationLifecycle,
  closeEffect,
  createEffectIdempotencyKey,
  fetchEffectEvidence,
  rollbackEffect,
  stopEffect,
  trackEffect,
} from "../api/effect-client";
import { useExperimentalActions } from "../hooks/useExperimentalActions";
import {
  CATEGORY_LABEL,
  COPY_LABEL,
  CopyIcon,
  REVIEW_LABEL,
  RecChips,
  ReviewIcon,
  SavingsMeter,
  evidenceWindowLabel,
  headlineSavings,
  isD1Heuristic,
  isQuantified,
  meterBounds,
  netAboveRange,
  trackUnavailableReason,
} from "../lib/rec-presentation";
import { useWorkspaceNames } from "../lib/workspace-names";
import Chip from "../shell/Chip";
import InfoTip from "../shell/InfoTip";
import EffectEvidence, { measuringStatusLine } from "./EffectEvidence";
import EvaluationDisclosure from "./EvaluationDisclosure";
import {
  type GeneratedSnippet,
  generateAutocompactSnippet,
  generateCacheBehaviorSnippet,
  generateD7LoopRetrySnippet,
  generateDestructiveGuardSnippet,
  generateFrictionRuleSnippet,
  generateModelDefaultSnippet,
  generateSettingsDisableBlock,
  generateSubagentRoutingSnippet,
} from "./prompt-templates";
import { sessionIdsForRecommendation } from "./rec-sessions";

/**
 * Self-contained copy-able snippet block (RI8). Used for secondary generated
 * snippets offered alongside the primary one (e.g. the D4 subagent-routing
 * snippet beside the model-default config); owns its own copied state.
 */
function SnippetBlock({ snippet }: { snippet: GeneratedSnippet }) {
  const [copied, setCopied] = useState(false);
  const labelId = useId();
  return (
    <div className="rec-prompt-artifact rec-generated-snippet" data-language={snippet.language}>
      <label className="rec-section-label" htmlFor={labelId}>
        {snippet.caption}
      </label>
      <textarea id={labelId} readOnly value={snippet.text} />
      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          void navigator.clipboard.writeText(snippet.text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? "Copied ✓" : "Copy snippet"}
      </button>
    </div>
  );
}

/**
 * A long What's wrong text starts clamped with a button that opens it in place (layout review
 * 2, operator 2026-09-26): the card fits one laptop screen, and the full text stays in the DOM.
 */
function ProblemText({ text, long }: { text: string; long: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className={long && !open ? "rec-problem rec-clamped" : "rec-problem"}>{text}</p>
      {long && (
        <button
          type="button"
          className="btn-secondary rec-clamp-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show full text"}
        </button>
      )}
    </>
  );
}

/**
 * An action's steps and copy prompt. The steps and the prompt past ~6 lines open with one
 * button (layout review 2, operator 2026-09-26); the prompt box always shows its start.
 */
function ActionPrompt({ option, label }: { option: CardActionOption; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const long = option.copy_text.length > 360 || option.copy_text.split("\n").length > 6;
  const steps = option.detail.length > 0;
  return (
    <>
      {open && steps && (
        <ul className="rec-action-detail">
          {option.detail.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {label}
      <pre className={long && !open ? "rec-copy-preview rec-clamped" : "rec-copy-preview"}>
        {option.copy_text}
      </pre>
      {(long || steps) && (
        <button
          type="button"
          className="btn-secondary rec-clamp-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open
            ? "Show less"
            : steps && long
              ? "Show steps and full prompt"
              : steps
                ? "Show steps"
                : "Show full prompt"}
        </button>
      )}
    </>
  );
}

type ApplyUiState =
  | { status: "idle" }
  | { status: "dry_running"; jobId: string }
  | { status: "dry_done"; jobId: string; diffPreview: string }
  | { status: "confirming"; jobId: string; diffPreview: string }
  | { status: "applied"; jobId: string; diffApplied: string | null }
  | { status: "rolled_back" }
  | { status: "failed"; message: string };

type PendingRecommendationAction = "adopt" | "dismiss" | "track" | null;
type CycleAction = "stop" | "close" | "rollback" | "attest-rollback";
type WriteAction =
  | Exclude<PendingRecommendationAction, null>
  | CycleAction
  | "undo-adopt"
  | "reopen";

const ACTION_UNDO_WINDOW_MS = 5_000;

const ACTION_KIND_HELP = {
  CONFIG: "A settings change you apply once",
  EDIT: "A change to a file such as CLAUDE.md",
  COMMAND: "A command to run",
  HABIT: "A working-practice change; can't be enforced",
  INVESTIGATE: "A specific session to look at",
} as const;

const BASIS_HELP = {
  P: "Measured tokens × list price × an assumed share avoidable",
  E: "Estimated from your usage",
  O: "Overlaps a higher-ranked rec; counted once",
  R: "Upper-bound risk, not a saving; excluded from the total",
  X: "Not ranked",
} as const;

function EffectHistory({
  recId,
  canRetrack,
  onRetrack,
}: {
  recId: string;
  canRetrack: boolean;
  onRetrack: () => void;
}) {
  const [state, setState] = useState<
    | { status: "loading"; cycles: never[]; legacy: never[]; nextCycle: null; nextLegacy: null }
    | {
        status: "ready" | "loading_more" | "error";
        cycles: EffectEvidencePage["cycles"];
        legacy: EffectEvidencePage["legacy"];
        nextCycle: string | null;
        nextLegacy: string | null;
        message?: string;
      }
  >({ status: "loading", cycles: [], legacy: [], nextCycle: null, nextLegacy: null });

  function load(more: boolean) {
    const previous = state;
    if (
      more &&
      (previous.status === "loading" ||
        (previous.nextCycle === null && previous.nextLegacy === null))
    )
      return;
    setState(
      more && previous.status !== "loading"
        ? (() => {
            const { message: _message, ...history } = previous;
            return { ...history, status: "loading_more" as const };
          })()
        : { status: "loading", cycles: [], legacy: [], nextCycle: null, nextLegacy: null },
    );
    void fetchEffectEvidence(
      recId,
      more && previous.status !== "loading"
        ? { cycle: previous.nextCycle, legacy: previous.nextLegacy }
        : {},
    )
      .then((page) => {
        const existingCycles = more && previous.status !== "loading" ? previous.cycles : [];
        const existingLegacy = more && previous.status !== "loading" ? previous.legacy : [];
        const cycles = [...existingCycles, ...page.cycles].filter(
          (item, index, items) =>
            items.findIndex((candidate) => candidate.cycleId === item.cycleId) === index,
        );
        const legacy = [...existingLegacy, ...page.legacy].filter(
          (item, index, items) =>
            items.findIndex((candidate) => candidate.cycleId === item.cycleId) === index,
        );
        setState({
          status: "ready",
          cycles,
          legacy,
          // A stream that was already exhausted must remain exhausted when the
          // other stream advances independently.
          nextCycle:
            more && previous.status !== "loading" && previous.nextCycle === null
              ? null
              : page.next_cycle_cursor,
          nextLegacy:
            more && previous.status !== "loading" && previous.nextLegacy === null
              ? null
              : page.next_legacy_cursor,
        });
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Could not load measurement history.";
        setState(
          more && previous.status !== "loading"
            ? { ...previous, status: "error", message }
            : {
                status: "error",
                cycles: [],
                legacy: [],
                nextCycle: null,
                nextLegacy: null,
                message,
              },
        );
      });
  }

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", cycles: [], legacy: [], nextCycle: null, nextLegacy: null });
    void fetchEffectEvidence(recId)
      .then((page) => {
        if (cancelled) return;
        setState({
          status: "ready",
          cycles: page.cycles,
          legacy: page.legacy,
          nextCycle: page.next_cycle_cursor,
          nextLegacy: page.next_legacy_cursor,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          cycles: [],
          legacy: [],
          nextCycle: null,
          nextLegacy: null,
          message: error instanceof Error ? error.message : "Could not load measurement history.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [recId]);

  const canLoadMore =
    state.status !== "loading" && (state.nextCycle !== null || state.nextLegacy !== null);
  return (
    <section className="rec-effect-history" aria-label="Measurement history">
      <h4>Measurement history</h4>
      {state.status === "loading" && <p aria-busy="true">Loading measurement history…</p>}
      {state.status === "error" && (
        <div role="alert">
          Could not load measurement history: {state.message}{" "}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => load(state.cycles.length > 0 || state.legacy.length > 0)}
          >
            Retry loading history
          </button>
        </div>
      )}
      {state.status !== "loading" && state.cycles[0] !== undefined && (
        <EffectEvidence cycle={state.cycles[0]} cycles={state.cycles} />
      )}
      {state.status !== "loading" && state.legacy.length > 0 && (
        <ul>
          {state.legacy.map((item) => (
            <li key={item.cycleId}>
              Legacy target-metric result: {item.verdict ?? item.state.replaceAll("_", " ")} (
              {item.measuredAt.slice(0, 10)}) — read-only
              {canRetrack && (
                <>
                  {" "}
                  <button type="button" className="btn-secondary" onClick={onRetrack}>
                    Retrack with versioned measurement
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {state.status === "ready" && state.cycles.length === 0 && state.legacy.length === 0 && (
        <p>No recorded measurement history.</p>
      )}
      {(canLoadMore || state.status === "loading_more") && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => load(true)}
          disabled={state.status === "loading_more"}
        >
          {state.status === "loading_more" ? "Loading…" : "Load more history"}
        </button>
      )}
    </section>
  );
}

interface ApplyJobPayload {
  job_id: string;
  status:
    | "PENDING"
    | "DRY_RUNNING"
    | "DRY_DONE"
    | "CONFIRMING"
    | "APPLIED"
    | "FAILED"
    | "ROLLED_BACK";
  diff_preview: string | null;
  diff_applied: string | null;
  error_msg: string | null;
}

function fmtUsd(u: number): string {
  const usd = u / 1_000_000;
  // Sub-cent: show in ¢ to avoid the misleading "$0.00" display.
  if (usd > 0 && usd < 0.01) {
    const cents = usd * 100;
    return `${cents.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}¢`;
  }
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) {
    const decimals = n < 10_000 ? 3 : 0;
    return `${(n / 1_000)
      .toFixed(decimals)
      .replace(/\.0+$/, "")
      .replace(/(\.\d*?)0+$/, "$1")}K`;
  }
  return n.toLocaleString();
}

/** Same strings as the server's `DETECTOR_GROUP_LABELS` (`src/query/api/recommendations.ts`). */
export const DETECTOR_GROUP_LABELS: Record<string, string> = {
  A1: "Large tool results",
  A2: "Large task outputs",
  B1: "Cache read drops",
  B2: "Cache timeouts",
  B3: "Resume cache misses",
  B4: "Cache prefix breaks",
  C1: "Failed tool calls",
  C2: "Content not found",
  C3: "Edits before reads",
  C4: "Failed edits",
  C5: "Repeated errors",
  C6: "Edit flip-flops",
  C7: "Shell failure clusters",
  C9: "Guard blocks",
  C11: "Output cap errors",
  D1: "CLAUDE.md / memory",
  D2: "Long sessions",
  D4: "Model choice",
  D5: "Limit warning",
  D6: "Large tool results",
  D7: "Repeated attempts and reads",
  D8: "Cache misses",
  D9: "Background sessions",
  D10: "Tool catalog",
  D11: "Shell errors",
  D12: "Subagent overuse",
  D14: "Interrupted turns",
  E1: "Long orientation",
  E2: "Main-model routine runs",
  G11: "Costly failures",
  H1: "Destructive commands",
};

const CATEGORY_GROUP_FALLBACK: Record<string, string> = {
  CACHE: "Cache misses",
  CONTEXT: "Long sessions",
  LIMIT: "Limit warning",
  MODEL: "Model choice",
  SESSION_HYGIENE: "Background sessions",
  TOOLING: "Tooling",
};

function groupLabel(rec: RecommendationCard): string {
  return (
    DETECTOR_GROUP_LABELS[rec.detector_id] ?? CATEGORY_GROUP_FALLBACK[rec.category] ?? rec.category
  );
}

/** Strip absolute path prefixes (Windows/Unix) to produce workspace-relative display strings. */
function stripAbsPath(s: string): string {
  // Windows: C:\Users\foo\... or C:/Users/foo/...
  const win = s.match(/^[A-Za-z]:[/\\](?:[^/\\]+[/\\]){1,4}(.+)$/);
  if (win?.[1]) return win[1];
  // Unix: /Users/foo/... or /home/foo/...
  const unix = s.match(/^\/(?:Users|home)\/[^/]+\/(.+)$/);
  if (unix?.[1]) return unix[1];
  return s;
}

/** One-line label for a rec's target: "D1 · CLAUDE.md · global" or "D2 · AgentWrangler". */
export function recTargetLabel(rec: RecommendationCard, labelFor: (id: string) => string): string {
  const parts: string[] = [DETECTOR_GROUP_LABELS[rec.detector_id] ?? rec.detector_id];
  if (rec.file_ref != null) {
    parts.push(rec.file_ref.split(/[/\\]/).pop() ?? rec.file_ref);
  }
  parts.push(rec.scope_workspace_id != null ? labelFor(rec.scope_workspace_id) : "global");
  return parts.join(" · ");
}

/** Short D1 headline, e.g. "Trim Doogit/AgentWrangler memory to 1,000 tokens or less". */
function d1Headline(rec: RecommendationCard, labelFor: (id: string) => string): string | null {
  if (rec.detector_id !== "D1") return null;
  const { component, source_target: target } = rec.evidence;
  if (typeof target !== "number" || (component !== "MEMORY" && component !== "CLAUDE_MD"))
    return null;
  const where = rec.scope_workspace_id != null ? labelFor(rec.scope_workspace_id) : "global";
  const file = component === "MEMORY" ? "memory" : "CLAUDE.md";
  return `Trim ${where} ${file} to ${target.toLocaleString("en-US")} tokens or less`;
}

function fmtValue(v: unknown): string {
  if (typeof v === "string") return stripAbsPath(v);
  if (Array.isArray(v))
    return v
      .map((x) =>
        typeof x === "string"
          ? stripAbsPath(x)
          : x !== null && typeof x === "object"
            ? JSON.stringify(x)
            : String(x),
      )
      .join(", ");
  if (typeof v === "number") return v.toLocaleString();
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function evidenceNumber(rec: RecommendationCard, key: string): number | null {
  const value = rec.evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function evidenceString(rec: RecommendationCard, key: string): string | null {
  const value = rec.evidence[key];
  return typeof value === "string" ? value : null;
}

const CAUSE_FACET_LABELS: Record<string, string> = {
  idle_gap: "idle gap",
  model_switch: "model switch",
  session_reopen: "session reopen",
  prefix_config_change: "prefix/config change",
  dynamic_content: "dynamic content",
};

function causeFacetFacts(rec: RecommendationCard): string[] {
  const facets = rec.evidence.cause_facets;
  if (facets === null || typeof facets !== "object" || Array.isArray(facets)) return [];
  return Object.entries(facets as Record<string, unknown>)
    .filter(([, value]) => typeof value === "boolean" || typeof value === "string")
    .map(([key, value]) => `Cause facet — ${CAUSE_FACET_LABELS[key] ?? key}: ${fmtValue(value)}.`);
}

function fmtPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

/** D2-local one-decimal percent (R6-06): its 44.7% must match the $ math elsewhere on the card. */
function fmtPercentD2(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** A long session id shortened to its first and last four characters, e.g. "2a79…754c". */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

/** Format the anchor week as a date range: "YYYY-MM-DD – YYYY-MM-DD" (7-day window). */
function anchorWeekRange(weekStart: string): string {
  const start = weekStart.slice(0, 10);
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return `${start} – ${d.toISOString().slice(0, 10)}`;
}

/** Short absolute date for inline copy, e.g. "Sep 25" (UTC, matches evidenceWindowLabel). */
function shortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "an unknown date";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(ms);
}

function unvalidatedAssumptionNote(rec: RecommendationCard): string | null {
  switch (rec.detector_id) {
    case "D2": {
      const fraction = evidenceNumber(rec, "reduction_fraction");
      return fraction === null
        ? null
        : `The ${fmtPercentD2(fraction)} is modelled on these sessions; one split per 150 model calls and a 2K summary are assumptions.`;
    }
    case "D8": {
      const fraction = evidenceNumber(rec, "avoidance_fraction");
      return fraction === null
        ? null
        : `Unvalidated assumption: assumes ${fmtPercent(fraction)} of the observed cache re-writes are avoidable — a default, not calibrated.`;
    }
    case "D4": {
      const fraction = rec.modeled_formula.inputs.reduction_fraction;
      return typeof fraction !== "number" || !Number.isFinite(fraction)
        ? null
        : `Unvalidated assumption: assumes ${fmtPercent(fraction)} of flagged Opus turns are Sonnet-movable — a default.`;
    }
    case "D1": {
      const target = evidenceNumber(rec, "source_target");
      const component = evidenceString(rec, "component");
      return target === null || component === null
        ? null
        : `Unvalidated assumption: compares against a default target of ${fmtTokens(target)} tokens for ${component} — not calibrated to your project.`;
    }
    case "C2":
      // Review 1 R2.2: the error text is ~100 bytes; the cost is the retry round trip.
      return "Unvalidated assumption: each failed lookup is priced at half the cost of the turn that made it (about one retry at that context size), not the size of the error itself.";
    default:
      return null;
  }
}

const FAMILY_RANK_RATIONALE: Record<string, string> = {
  D8: "Cache misses can require the model to rewrite saved context",
  D2: "Long sessions send accumulated context with each request, so they are worth reviewing early",
  D4: "Changing models may help if your Opus or all-models limit fills first",
  D9: "Background work can be useful; check what the agents were doing before ending sessions",
  D1: "Cached reads cost less than fresh writes, so trimming always-loaded context has less impact than fixing cache misses",
};

function rankExplanation(rec: RecommendationCard, rank: number, _displayGroup: string): string {
  const rationale =
    FAMILY_RANK_RATIONALE[rec.detector_id] ??
    "This type of waste has a fixed position in the ranking order";
  return `Why #${rank}: ${rationale}. Items inside this group are ordered by estimated weekly savings.`;
}

function observedFacts(rec: RecommendationCard): string[] {
  switch (rec.detector_id) {
    case "D8": {
      const count = evidenceNumber(rec, "churn_event_count");
      const creation = evidenceNumber(rec, "total_churn_creation_tokens");
      const sessionCap = evidenceNumber(rec, "session_cap_weighted_tokens");
      return [
        count === null
          ? "Cache re-writes followed long idle gaps in this session."
          : `${count.toLocaleString()} cache re-write${count === 1 ? "" : "s"} followed long idle gaps in this session.`,
        creation === null
          ? null
          : `Those re-writes created ${fmtTokens(creation)} cache tokens${sessionCap === null ? "." : ` in a session that used ${fmtTokens(sessionCap)} cap-weighted tokens.`}`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D2": {
      const count = evidenceNumber(rec, "qualifying_session_count");
      const turnThreshold = evidenceNumber(rec, "turn_count_threshold");
      const contextThreshold = evidenceNumber(rec, "avg_context_threshold");
      const weeklyReads = evidenceNumber(rec, "cache_read_tokens_per_week");
      const rawContextAverage = evidenceNumber(rec, "raw_context_average_tokens_per_turn");
      const rawContextBasis = evidenceString(rec, "raw_context_basis");
      const capWeightedBurn = evidenceNumber(rec, "cap_weighted_burn_tokens_per_week");
      const capWeightedBurnBasis = evidenceString(rec, "cap_weighted_burn_basis");
      const cacheReadExposureTokens = evidenceNumber(rec, "cache_read_exposure_tokens_per_week");
      const cacheReadExposureSpend = evidenceNumber(rec, "cache_read_exposure_spend_u_per_week");
      const cacheReadExposureBasis = evidenceString(rec, "cache_read_exposure_spend_basis");
      return [
        count === null
          ? "Multiple long, high-context sessions crossed the threshold for long sessions."
          : `${count.toLocaleString()} long, high-context session${count === 1 ? "" : "s"} crossed the threshold for long sessions.`,
        turnThreshold === null || contextThreshold === null
          ? null
          : `The detector looked for at least ${turnThreshold.toLocaleString()} turns averaging ${fmtTokens(contextThreshold)} context tokens.`,
        weeklyReads === null
          ? null
          : `Those sessions read ${fmtTokens(weeklyReads)} cached tokens this week.`,
        rawContextAverage === null
          ? null
          : `Raw-context average: ${fmtTokens(rawContextAverage)} tokens per turn${rawContextBasis === null ? "." : ` (basis ${rawContextBasis}).`}`,
        capWeightedBurn === null
          ? null
          : `Cap-weighted burn: ${fmtTokens(capWeightedBurn)} tokens this week${capWeightedBurnBasis === null ? "." : ` (basis ${capWeightedBurnBasis}).`}`,
        cacheReadExposureTokens === null || cacheReadExposureSpend === null
          ? null
          : `Cache-read exposure: ${fmtTokens(cacheReadExposureTokens)} tokens plus ${fmtUsd(cacheReadExposureSpend)} list-equivalent USD${cacheReadExposureBasis === null ? "." : ` (basis ${cacheReadExposureBasis}).`}`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D4": {
      const mismatch = evidenceNumber(rec, "mismatch_turns_per_week");
      const total = evidenceNumber(rec, "total_opus_turns_per_week");
      const fraction = evidenceNumber(rec, "mismatch_fraction");
      return [
        mismatch === null || total === null
          ? "Some Opus turns matched the pattern of large input and short responses."
          : `${mismatch.toLocaleString()} of ${total.toLocaleString()} weekly Opus turns${fraction === null ? "" : ` (${fmtPercent(fraction)})`} matched the pattern of large input and short responses.`,
        "Session records cannot show which limit fills first. Check /usage in Claude Code before changing models.",
      ];
    }
    case "D6": {
      const bytes = evidenceNumber(rec, "tool_result_bytes");
      const share = evidenceNumber(rec, "bloat_share");
      const sessionCap = evidenceNumber(rec, "session_cap_weighted_tokens");
      const attributedTool = evidenceString(rec, "attributed_tool");
      const attributedBytes = evidenceNumber(rec, "attributed_result_bytes");
      const carryTurns = evidenceNumber(rec, "carry_turns");
      const carryExposure = evidenceNumber(rec, "carry_exposure_tokens_directional");
      return [
        bytes === null
          ? "Tool-result output crossed the session-level bloat threshold."
          : `${bytes.toLocaleString()} measured tool-result bytes${share === null ? "." : `; after estimating bytes as tokens, the detector puts that output at about ${fmtPercent(share)} of this session${sessionCap === null ? " context." : `'s ${fmtTokens(sessionCap)} cap-weighted context.`}`}`,
        attributedTool === null
          ? "Attribution is session-level: this measurement cannot yet name which tool produced the excess output."
          : `Tool identified: ${attributedTool}.`,
        attributedBytes === null
          ? null
          : `Output size in bytes: ${attributedBytes.toLocaleString()}.`,
        carryTurns === null
          ? null
          : `Later turns carrying this output: ${carryTurns.toLocaleString()}.`,
        carryExposure === null
          ? null
          : `Estimated tokens carried into later turns: ${fmtTokens(carryExposure)} tokens.`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D7": {
      const coverage = evidenceNumber(rec, "owner_turn_metadata_coverage");
      const covered = evidenceNumber(rec, "owner_turn_metadata_covered_event_count");
      const denominator = evidenceNumber(rec, "owner_turn_metadata_denominator_event_count");
      const workspaceN = evidenceNumber(rec, "workspace_qualifying_session_count");
      const contextFrom = evidenceString(rec, "workspace_context_from");
      const contextTo = evidenceString(rec, "workspace_context_to");
      const affected = rec.evidence.workspace_affected_session_ids;
      const recovered = rec.evidence.workspace_recovered_session_ids;
      const hasContext =
        workspaceN !== null &&
        contextFrom !== null &&
        contextTo !== null &&
        Array.isArray(affected) &&
        affected.every((id) => typeof id === "string") &&
        Array.isArray(recovered) &&
        recovered.every((id) => typeof id === "string");
      return [
        "Review the affected sessions and measured trigger facts below.",
        hasContext
          ? `Workspace cohort context: ${affected.length} / ${workspaceN} repeated test-failure sessions; ${recovered.length} recovered test sequences. [${contextFrom}, ${contextTo})`
          : null,
        hasContext
          ? `Workspace affected IDs: ${affected.join(", ") || "none"}. Recovered IDs: ${recovered.join(", ") || "none"}.`
          : null,
        hasContext
          ? "Workspace context is an observation, not this session's count or evidence of task success. The detector match remains session-specific."
          : null,
        coverage === null
          ? null
          : `Tool events linked to a model response: ${fmtPercent(coverage)}.`,
        covered === null ? null : `Linked tool events: ${covered.toLocaleString()}.`,
        denominator === null
          ? null
          : `Total tool events checked: ${denominator.toLocaleString()} in-window events.`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D9": {
      const share = evidenceNumber(rec, "sidechain_share");
      const capTokens = evidenceNumber(rec, "sidechain_cap_weighted_tokens");
      const turns = evidenceNumber(rec, "sidechain_turn_count");
      const linkage = evidenceString(rec, "linkage_note");
      return [
        share === null
          ? "Background and sidechain work crossed the directional usage threshold."
          : `Background and sidechain work used ${fmtPercent(share)} of cap-weighted tokens${capTokens === null ? "." : ` (${fmtTokens(capTokens)})`}${turns === null ? "." : ` across ${turns.toLocaleString()} turns.`}`,
        linkage === null
          ? "Parallel agents may be doing useful work; review their tasks before ending them."
          : "Links between a session and its background agents are inferred. Review their tasks before ending them.",
      ];
    }
    case "D1": {
      const component = evidenceString(rec, "component") ?? "Always-loaded context";
      const heuristic = isD1Heuristic(rec);
      const source = evidenceNumber(rec, "source_tokens");
      const target = evidenceNumber(rec, "source_target");
      const delta = evidenceNumber(rec, "delta_context_tokens");
      return [
        source === null || target === null
          ? `${component} is larger than its configured always-loaded target.`
          : `${component} ${heuristic ? "estimated at" : "measured at"} ${fmtTokens(source)} tokens against a ${fmtTokens(target)} target.`,
        delta === null
          ? null
          : `The proposed trim would remove about ${fmtTokens(delta)} ${heuristic ? "estimated " : ""}repeated context tokens per turn.`,
      ].filter((fact): fact is string => fact !== null);
    }
    case "D10": {
      const catalog = evidenceNumber(rec, "catalog_tokens");
      const target = evidenceNumber(rec, "catalog_target_tokens");
      const delta = evidenceNumber(rec, "delta_context_tokens");
      const sources = evidenceNumber(rec, "source_count");
      const turns = evidenceNumber(rec, "turns_per_week");
      const effectiveCatalogState = evidenceString(rec, "effective_catalog_state");
      const alwaysLoadCount = evidenceNumber(rec, "always_load_count");
      // U7 rows carry removable_tokens; their catalog_target_tokens is the 5%-of-mean-context gate, not a target.
      const removable = evidenceNumber(rec, "removable_tokens");
      return [
        removable !== null
          ? `The tool inventory scan estimated ${catalog === null ? "an unknown number of" : fmtTokens(catalog)} catalog tokens; about ${fmtTokens(removable)} are in items with no recorded use this week${target === null ? "." : ` (5% of the mean context per turn is ${fmtTokens(target)}).`}`
          : catalog === null || target === null
            ? "The tool, plugin, and skill catalog exceeded its configured context target."
            : `The tool inventory scan estimated ${fmtTokens(catalog)} catalog tokens against a ${fmtTokens(target)} target${delta === null ? "." : `, or ${fmtTokens(delta)} tokens above target.`}`,
        `${sources === null ? "This is a global catalog estimate" : `The global inventory contains ${sources.toLocaleString()} catalog source${sources === 1 ? "" : "s"}`}${turns === null ? "." : `; the weekly projection models repeated reads across ${turns.toLocaleString()} turn${turns === 1 ? "" : "s"}.`}`,
        effectiveCatalogState === null
          ? null
          : `Effective catalog state: ${effectiveCatalogState}.`,
        alwaysLoadCount === null ? null : `Always-load count: ${alwaysLoadCount.toLocaleString()}.`,
      ].filter((fact): fact is string => fact !== null);
    }
    default:
      return ["Review the affected sessions and measured trigger facts below."];
  }
}

function impactCaveat(rec: RecommendationCard): string {
  switch (rec.detector_id) {
    case "D8": {
      const fraction = evidenceNumber(rec, "avoidance_fraction");
      return `Projection only — it assumes ${fraction === null ? "some" : fmtPercent(fraction)} of the observed cache re-writes are avoidable.`;
    }
    case "D2": {
      const fraction = evidenceNumber(rec, "reduction_fraction");
      const gross = evidenceNumber(rec, "gross_savings_u_per_wk");
      const rebuild = evidenceNumber(rec, "rebuild_u_per_wk");
      const fractionText = fraction === null ? "a partial" : `a ${fmtPercentD2(fraction)}`;
      return gross === null || rebuild === null
        ? `Projection only — it assumes ${fractionText} reduction in the observed cache-read load.`
        : `Projection only — it assumes ${fractionText} reduction (${fmtUsd(gross)}), minus ${fmtUsd(rebuild)} to rebuild after each split.`;
    }
    case "D4":
      return "Changing models may help if your all-models or Opus limit fills first. Check /usage in Claude Code before changing; no savings estimate is shown.";
    case "D6":
      return "Rough estimate: text size is converted at four bytes per token. Large output is not necessarily waste; check whether the task needed it.";
    case "D9":
      return "Background work may be useful. We cannot yet separate necessary parallel work from avoidable work, so no savings estimate is shown.";
    case "D7":
      return evidenceString(rec, "template_id") === "D7_CROSS_SESSION_REREAD"
        ? "Range only — a re-read after /clear is expected; only look-up files are worth pointing at."
        : "Projection only — it assumes 50% of the repeat turns were avoidable; some repeats made progress.";
    case "D1":
      return isD1Heuristic(rec)
        ? "Source token count and per-turn reduction use a chars/4 heuristic. The displayed savings range varies the trim assumption only; it does not bound token-count uncertainty. Steady cache reads are priced below fresh writes, and the first turn after editing can cost more."
        : "Projection only — steady cache reads are priced below fresh writes, and the first turn after editing the cached prefix can cost more.";
    case "D10": {
      const delta = evidenceNumber(rec, "delta_context_tokens");
      return `Projection only — the catalog threshold is unvalidated, and the estimate assumes ${delta === null ? "excess catalog context" : `${fmtTokens(delta)} excess catalog tokens`} can be removed from repeated reads; this is not measured or achieved savings.`;
    }
    default:
      return "Modeled projection — not measured, achieved, or billed savings.";
  }
}

function successMeasure(rec: RecommendationCard): string {
  switch (rec.detector_id) {
    case "D8":
      return "Compare the next 7 days with this window: look for fewer cache-creation spikes after idle gaps and a higher cache-read-to-creation ratio.";
    case "D2":
      return "Re-check after 7 days: average context per turn should fall without more retries, rework, or failed outcomes.";
    case "D4":
      return "Only if /usage confirms the all-models or Opus cap is binding, re-check this workspace's Opus share after 7 days.";
    case "D6":
      return "Re-run the detector on later sessions: tool-result bytes and share should fall without more failed tool calls, retries, or missing context.";
    case "D9":
      return "Check again after 7 days: background agents should use fewer tokens while still completing useful work.";
    case "D1":
      return "After the next file scan, compare the size of instructions loaded in every session, then confirm average context per turn falls without lost guidance.";
    case "D10": {
      const catalog = evidenceNumber(rec, "catalog_tokens");
      const target = evidenceNumber(rec, "catalog_target_tokens");
      const removable = evidenceNumber(rec, "removable_tokens");
      if (removable !== null) {
        return `After the next tool inventory scan: the catalog estimate${catalog === null ? "" : ` (${fmtTokens(catalog)} now)`} should fall by about ${fmtTokens(removable)}, the items with no recorded use, while required tools remain available.`;
      }
      return `After the next tool inventory scan: the tool, plugin, and skill catalog estimate should move${catalog === null ? "" : ` from ${fmtTokens(catalog)}`}${target === null ? " below its target" : ` toward ${fmtTokens(target)}`} while required tools remain available.`;
    }
    default:
      return "Re-run the detector after 7 days and compare its target signal with this window.";
  }
}

/** Derive a human-readable display string for a BoundedStep. */
function stepDisplay(step: BoundedStep): string {
  switch (step.kind) {
    case "trim":
      return `Trim ${step.target}${step.max_lines !== undefined ? ` (max ${step.max_lines} lines)` : ""}`;
    case "disable_plugin":
      return `Disable plugin: ${step.plugin_id}`;
    case "route_model":
      return `Route ${step.from} → ${step.to}`;
    case "route_tool":
      return `Route ${toolStepLabel(step.from)} → ${toolStepLabel(step.to)}`;
    case "session_boundary":
      return "Start a fresh session with /clear between tasks";
    case "generic":
      return step.description;
  }
}

/** SEC-101: direct card consumers can bypass query coercion, so sanitize again at render. */
function toolStepLabel(toolName: string): string {
  if (!toolName.startsWith("mcp__")) return toolName;
  return /browser|chrome/i.test(toolName) ? "An MCP browser tool" : "An MCP tool";
}

/**
 * Per-detector primary-action routing (RV4). Behavioral detectors lead with the
 * shipped hook; idle/limit detectors route to their Settings panel; artifact
 * detectors keep the copy-prompt primary.
 */
type RecRoute = "hook" | "settings-idle" | "settings-calibrate" | "copy";

function recRoute(detectorId: string): RecRoute {
  if (detectorId === "D2" || detectorId === "D8" || detectorId === "D7") return "hook";
  if (detectorId === "D9") return "settings-idle";
  if (detectorId === "D5") return "settings-calibrate";
  return "copy";
}

// Share only an in-flight check across cards. Completed values are revalidated
// on remount, browser focus/visibility, and a successful settings mutation.
let hookCheck: Promise<boolean> | null = null;

function fetchHookInstalled(): Promise<boolean> {
  if (hookCheck !== null) return hookCheck;
  const pending = Promise.resolve()
    .then(() => fetchHookConfig())
    .then((res) => {
      if (res?.data === null || res?.data === undefined)
        throw new Error("Hook status unavailable.");
      return res.data.installed;
    });
  hookCheck = pending;
  const clear = () => {
    if (hookCheck === pending) hookCheck = null;
  };
  void pending.then(clear, clear);
  return pending;
}

/** Test-only: clear shared in-flight state between renders. */
export function __resetHookInstallCache(): void {
  hookCheck = null;
}

/** Primary action for behavioral (D2/D8/D7) cards: install the shipped hook. */
export function HookInstallButton({ onInstalled }: { onInstalled?: () => void }) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const revalidate = () => {
      hookCheck = null;
      setRefreshKey((key) => key + 1);
    };
    const visible = () => {
      if (!document.hidden) revalidate();
    };
    window.addEventListener("focus", revalidate);
    window.addEventListener("agentwrangler:hooks-changed", revalidate);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("agentwrangler:hooks-changed", revalidate);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey triggers status revalidation
  useEffect(() => {
    let active = true;
    setError(null);
    void fetchHookInstalled()
      .then((value) => {
        if (active) setInstalled(value);
      })
      .catch((e: unknown) => {
        if (active) {
          setInstalled(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  async function onInstall() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await installHook();
      setInstalled(true);
      onInstalled?.();
    } catch (e: unknown) {
      setInstalled(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-primary"
        onClick={() => (installed === null ? setRefreshKey((key) => key + 1) : void onInstall())}
        disabled={busy || installed === true || (installed === null && error === null)}
      >
        {busy
          ? "Installing…"
          : installed === true
            ? "Installed ✓"
            : installed === null
              ? error === null
                ? "Checking hook…"
                : "Retry status check"
              : "Install hook"}
      </button>
      {error !== null && (
        <span className="rec-apply-status rec-apply-status--error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function isStartupFailure(message: string): boolean {
  return /(?:^|\s)spawn(?:\s|$)/i.test(message.trim());
}

function inferWorkspaceCwd(fileRef: string | null): string | null {
  if (fileRef === null) return null;
  // Assisted-apply-eligible recs target the project CLAUDE.md, which the context
  // probe records at <repo_path>/CLAUDE.md (repo root, no .claude/ segment).
  // Accept that shape and the legacy .claude/CLAUDE.md layout.
  const cwd = fileRef.replace(/[\\/](?:\.claude[\\/])?CLAUDE\.md$/i, "");
  if (cwd === fileRef) return null;
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(cwd)) return null;
  return cwd;
}

function canAssistedApplyForRec(rec: RecommendationCard): boolean {
  return (
    rec.action_validation?.primary.ok === true &&
    rec.state === "PROPOSED" &&
    rec.file_ref !== null &&
    rec.scope_workspace_id !== null &&
    inferWorkspaceCwd(rec.file_ref) !== null
  );
}

function hasValidatedCopyText(rec: RecommendationCard, text: string): boolean {
  if (!rec.actions || !rec.action_validation) return false;
  return [rec.actions.primary, ...rec.actions.alternatives].some((action) => {
    const verdict =
      action.option_id === rec.actions?.primary.option_id
        ? rec.action_validation?.primary
        : rec.action_validation?.alternatives[action.option_id];
    return verdict?.ok === true && action.copy_text === text;
  });
}

async function fetchSessionToken(): Promise<string> {
  const res = await fetch("/api/token", { signal: AbortSignal.timeout(8_000) });
  if (res.ok) {
    const data = (await res.json()) as { token?: unknown };
    if (typeof data.token === "string" && data.token.length > 0) return data.token;
  }
  throw new Error("Unable to authorize this action. Check the daemon and retry.");
}

async function responseText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `${res.status}`;
  } catch {
    return res.text();
  }
}

/** RV6 highlight banner shown on the focused (deep-linked) card. */
function FocusHighlightBanner({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <output className="rec-focus-banner">
      <span className="rec-focus-banner-label">Linked recommendation</span>
      <button
        type="button"
        className="rec-focus-dismiss"
        aria-label="Dismiss highlight"
        onClick={onDismiss}
      >
        ✕
      </button>
    </output>
  );
}

/**
 * Scope badge — ONE per rendered card.
 * Global recs (scope_workspace_id === null): violet "global · ×N workspaces" badge.
 * Workspace recs: blue "workspace · <label>" badge.
 */
function ScopeBadge({ rec }: { rec: RecommendationCard }) {
  const { labelFor } = useWorkspaceNames();
  if (rec.cross_workspace) {
    const label =
      rec.workspace_multiplier !== null
        ? `global · ×${rec.workspace_multiplier} workspaces`
        : "global";
    return <span className="rec-scope-badge rec-scope-badge--global">{label}</span>;
  }
  const wsId = rec.scope_workspace_id;
  const label = wsId !== null ? labelFor(wsId) : "";
  return <span className="rec-scope-badge rec-scope-badge--workspace">workspace · {label}</span>;
}

/** Best-effort scroll a focused card into view; jsdom lacks scrollIntoView. */
function scrollFocusedIntoView(el: HTMLElement | null): void {
  if (el === null || typeof el.scrollIntoView !== "function") return;
  try {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    // jsdom: scrollIntoView is not implemented — highlight/expand still apply.
  }
}

interface SingleRecCardProps {
  rec: RecommendationCard;
  /** Cross-list rank (1 = highest-leverage). Optional; defaults to 1 for standalone use. */
  rank?: number;
  /** Whether to present this detector card as part of a ranked queue. */
  showRank?: boolean;
  /** True for the #1 ranked card — renders flagship badge + rationale. */
  isFlagship?: boolean;
  /** Render as a member row inside a detector group rather than a standalone card. */
  grouped?: boolean;
  /** Show affected session links in the member row. */
  showSessionRows?: boolean;
  /** RV6 deep-link target: when it equals this rec's id, auto-expand (and, when standalone, highlight). */
  focusRecId?: string | null;
  /** Clear the focus deep-link when the user dismisses the highlight. */
  onDismissFocus?: () => void;
  onDismiss?: (recId: string) => void | Promise<void>;
  onAdopt?: (recId: string, optionId?: string) => void | Promise<void>;
  onEffectMutated?: () => void;
  savingsScale?: number | undefined;
  /** R6-18: cards after #1 (and the focused card) start folded to fit more on one screen. */
  defaultFolded?: boolean;
}

function SingleRecCard({
  rec,
  rank = 1,
  showRank = true,
  isFlagship,
  grouped = false,
  showSessionRows = false,
  focusRecId = null,
  onDismissFocus,
  onDismiss,
  onAdopt,
  onEffectMutated,
  savingsScale,
  defaultFolded = false,
}: SingleRecCardProps) {
  const { labelFor } = useWorkspaceNames();
  const experimental = useExperimentalActions();
  const focused = focusRecId !== null && focusRecId === rec.rec_id;
  const [expanded, setExpanded] = useState(focused);
  // Layout review 2 item 7: the header folds the card to its title and $ line.
  // R6-18: cards after #1 start folded (defaultFolded), keeping only their title/$/primary button.
  const [folded, setFolded] = useState(defaultFolded);
  const [callsOpen, setCallsOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const detailsHeadingRef = useRef<HTMLHeadingElement>(null);
  const detailsLauncherRef = useRef<HTMLButtonElement>(null);
  const evaluationLauncherRef = useRef<HTMLButtonElement>(null);
  const [evaluationOpen, setEvaluationOpen] = useState(false);

  // Auto-expand + scroll when this card becomes the deep-link target (RV6).
  // Grouped members expand here; the group card owns scroll/highlight.
  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    if (!grouped) scrollFocusedIntoView(cardRef.current);
  }, [focused, grouped]);
  useEffect(() => {
    if (expanded) detailsHeadingRef.current?.focus();
  }, [expanded]);
  const [artifactCopied, setArtifactCopied] = useState(false);
  const [copiedOptionId, setCopiedOptionId] = useState<string | null>(null);
  const [guidedShown, setGuidedShown] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [applyState, setApplyState] = useState<ApplyUiState>({ status: "idle" });
  // Local evidence deliberately does not persist until the existing adopt endpoint is used.
  const [actionEvidence, setActionEvidence] = useState<"none" | "supported" | "manual">("none");
  const [manualAttested, setManualAttested] = useState(false);
  const [trackGateOpen, setTrackGateOpen] = useState(false);
  const capability = rec.effect_capability;
  const [cycle, setCycle] = useState(rec.effect_cycle ?? null);
  useEffect(() => {
    setCycle(rec.effect_cycle ?? null);
  }, [rec.effect_cycle]);
  const trackKey = useRef<string | null>(null);
  const decisionKeys = useRef(new Map<string, string>());
  const lifecycleKeys = useRef(new Map<string, string>());
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [retrackConfirmation, setRetrackConfirmation] = useState(false);
  const [retrackAttested, setRetrackAttested] = useState(false);
  const [openTerminalMsg, setOpenTerminalMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [openTerminalPending, setOpenTerminalPending] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingRecommendationAction>(null);
  const [pendingTimeoutId, setPendingTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAdoptOptionId = useRef<string | undefined>(undefined);
  const savingRef = useRef(false);
  const [writeState, setWriteState] = useState<
    | { status: "idle" | "saving" }
    | { status: "saved"; action: WriteAction }
    | { status: "failed"; action: WriteAction; message: string }
  >({ status: "idle" });
  const detailsId = useId();
  const snippetLabelId = useId();

  const f = rec.modeled_formula;
  const hasSavings = rec.modeled_savings_u_per_wk !== null;
  const isD1 = rec.detector_id === "D1";
  const isD4 = rec.detector_id === "D4";
  const lifecycleState = rec.state as string;
  const retired = lifecycleState === "RETIRED";
  const verdict = cycle?.state === "FINALIZED" ? cycle.targetDirection : null;
  const improved = !retired && lifecycleState === "MEASURED_EFFECTIVE";
  const noImprovement =
    !retired &&
    (verdict === "WORSENED" ||
      verdict === "UNCHANGED" ||
      (cycle === null && rec.legacy_effect_verdict === "NO_EFFECT"));
  const measuring =
    !improved &&
    !noImprovement &&
    !retired &&
    rec.detector_id !== "D5" &&
    (cycle?.state === "OPEN_SETTLING" || cycle?.state === "OPEN_MEASURING");
  // R6-07: read the payload exclusions directly (not `scope.sourceIdentity`, which is an
  // opaque scope id, not a signal of whether an edit was observed). Final evidence, when
  // present, takes priority over an interim (provisional) reading.
  const cycleFollowUpEvidence = cycle?.finalEvidence ?? cycle?.provisionalEvidence ?? null;
  const noChangeSeen = (cycleFollowUpEvidence?.after?.excluded?.NO_CHANGED_OBSERVATION ?? 0) > 0;
  const noBaselineOnRecord = (cycle?.baselineEvidence?.excluded?.NO_BASELINE ?? 0) > 0;
  const before = cycle?.finalEvidence?.before.value;
  const after = cycle?.finalEvidence?.after.value;
  const measuredReduction =
    cycle?.state === "FINALIZED" &&
    cycle.targetDirection === "IMPROVED" &&
    cycle?.targetDefinition.unit === "tokens" &&
    (cycle.targetDefinition.sampleUnit === "source observation" ||
      cycle.targetDefinition.sampleUnit === "session") &&
    typeof before === "number" &&
    typeof after === "number" &&
    Number.isFinite(before - after) &&
    before > after
      ? (before - after).toLocaleString(undefined, { maximumFractionDigits: 2 })
      : null;
  const assumptionNote = unvalidatedAssumptionNote(rec);
  // R6-14: fall back through the evidence bag before saying the count is unavailable.
  const sessionCountForWindow =
    rec.trigger?.evidence?.session_count ??
    evidenceNumber(rec, "session_count") ??
    evidenceNumber(rec, "qualifying_session_count");
  const hasVisibleSavings = hasSavings && !isD4;
  const isAdopted =
    !retired &&
    (rec.state !== "PROPOSED" || pendingAction === "adopt" || pendingAction === "track");
  const terminalCycle =
    cycle !== null &&
    (cycle.state === "STOPPED" || cycle.state === "FINALIZED" || cycle.state === "UNSUPPORTED");
  const unsupportedCycle = cycle !== null && cycle.versionStatus !== "SUPPORTED";
  const canStartCycle = capability?.mode === "TRACKABLE" && !unsupportedCycle;
  const canMutateCycle =
    cycle !== null &&
    !unsupportedCycle &&
    (capability?.mode === "TRACKABLE" || capability?.mode === "MANUAL");
  const canRetrack = terminalCycle && canStartCycle && cycle?.rollbackStatus !== "PENDING";

  async function changeLifecycle(action: "undo-adopt" | "reopen") {
    if (savingRef.current) return;
    savingRef.current = true;
    setWriteState({ status: "saving" });
    try {
      let key = decisionKeys.current.get(action);
      if (key === undefined) {
        key = createEffectIdempotencyKey(rec.rec_id, action);
        decisionKeys.current.set(action, key);
      }
      await changeRecommendationLifecycle(rec.rec_id, action, key);
      setWriteState({ status: "saved", action });
      onEffectMutated?.();
    } catch (error) {
      setWriteState({
        status: "failed",
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      savingRef.current = false;
    }
  }
  const displayGroup = groupLabel(rec);
  const workspaceCwd = inferWorkspaceCwd(rec.file_ref);
  const canAssistedApply = canAssistedApplyForRec(rec);
  const primaryFailure =
    rec.action_validation?.primary.ok === true
      ? null
      : rec.action_validation?.primary.ok === false
        ? rec.action_validation.primary.reason
        : "validation result unavailable";
  const availableAlternatives =
    rec.actions?.alternatives.filter(
      (option) => rec.action_validation?.alternatives[option.option_id]?.ok === true,
    ) ?? [];
  const causeFacets = causeFacetFacts(rec);
  const observationFacts = observedFacts(rec);
  const promptArtifact =
    rec.actions && primaryFailure === null ? { text: rec.actions.primary.copy_text } : null;
  // Open in Claude Code ↗ (O11 Option B) reaches every workspace-scoped rec that
  // has a seedable prompt — the daemon resolves the cwd from the workspace, so
  // reach is not limited to file-ref recs the way headless assisted-apply is.
  const canOpenTerminal =
    rec.state === "PROPOSED" && rec.scope_workspace_id !== null && promptArtifact !== null;
  const route = recRoute(rec.detector_id);
  // C9 renders no generated snippet: its card shows rec.actions only. It must NOT
  // fall through the `??` chain to a non-C9 generator.
  const generatedCandidate: GeneratedSnippet | null =
    primaryFailure !== null || rec.detector_id === "C9"
      ? null
      : (generateSettingsDisableBlock(rec) ??
        generateModelDefaultSnippet(rec) ??
        generateAutocompactSnippet(rec) ??
        generateFrictionRuleSnippet(rec) ??
        generateD7LoopRetrySnippet(rec) ??
        generateDestructiveGuardSnippet(rec) ??
        generateCacheBehaviorSnippet(rec));
  // Secondary snippet offered alongside the primary (RI8): D4 subagent routing.
  const generatedSnippet =
    generatedCandidate && hasValidatedCopyText(rec, generatedCandidate.text)
      ? generatedCandidate
      : null;
  const secondaryCandidate: GeneratedSnippet | null =
    primaryFailure === null ? generateSubagentRoutingSnippet(rec) : null;
  const generatedSnippet2 =
    secondaryCandidate && hasValidatedCopyText(rec, secondaryCandidate.text)
      ? secondaryCandidate
      : null;
  // Only Phase 2.5 friction/destructive/cache snippets supersede the investigation
  // copy-prompt; D4/D10 snippets still coexist with it.
  const promptSuperseded = generatedSnippet?.supersedesInvestigationPrompt === true;
  const visibleFactCount =
    rec.detector_id === "D7" && "workspace_context_from" in rec.evidence ? 5 : 2;
  const visibleObservationFacts = observationFacts.slice(0, visibleFactCount);
  const diagnosticObservationFacts = observationFacts.slice(visibleFactCount);

  // Per-turn delta: from evidence.delta_context_tokens (present on D1/CONTEXT recs)
  const deltaCtx =
    typeof rec.evidence.delta_context_tokens === "number"
      ? rec.evidence.delta_context_tokens
      : null;
  const sessionIds = rec.trigger?.session_ids ?? sessionIdsForRecommendation(rec);

  // Collapsed headline: per-turn delta as the primary anchor.
  // Raw weekly-token count is intentionally dropped to avoid the 10× overstatement.
  const turnAnchor =
    deltaCtx !== null
      ? `-${fmtTokens(deltaCtx)} ${isD1Heuristic(rec) ? "estimated " : ""}tokens/turn`
      : null;
  const headlineText = isD4
    ? "If your Opus or all-models cap is binding (check /usage) — these turns are Sonnet-movable."
    : (turnAnchor ?? "Directional — no modeled savings");

  const estimate = rec.estimate ?? rec.modeled_formula.estimate;
  const basis = estimate?.basis;
  const primaryAction = rec.actions?.primary;
  const copyLabel = primaryAction ? COPY_LABEL[primaryAction.kind] : undefined;
  const reviewLabel = primaryAction ? REVIEW_LABEL[primaryAction.kind] : undefined;
  const copyReady = primaryFailure === null && Boolean(primaryAction?.copy_text);
  // The trigger line already shows the evidence dates, so the anchor week is only a fallback.
  const recency = [
    rec.last_seen_week_start != null && !rec.trigger?.window
      ? anchorWeekRange(rec.last_seen_week_start)
      : null,
    rec.last_seen_week_start != null && rec.weeks_ago != null && rec.weeks_ago > 0
      ? `last seen ${rec.weeks_ago} ${rec.weeks_ago === 1 ? "week" : "weeks"} ago · fired in ${rec.weeks_fired ?? "?"} of ${rec.weeks_evaluated ?? "?"} weeks`
      : null,
  ].filter((part): part is string => part !== null);
  const copyAction = (text: string, optionId: string) => {
    if (optionId === primaryAction?.option_id && primaryFailure !== null) return;
    if (
      optionId !== primaryAction?.option_id &&
      !availableAlternatives.some((option) => option.option_id === optionId)
    )
      return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedOptionId(optionId);
      setActionEvidence("manual");
    });
  };

  function handleAnalyze() {
    const prompt = buildSeededPrompt(rec);
    void navigator.clipboard.writeText(prompt);
  }

  function handleCopyPromptArtifact() {
    if (promptArtifact === null) return;
    void navigator.clipboard.writeText(promptArtifact.text).then(() => {
      setArtifactCopied(true);
      setActionEvidence("manual");
      setTimeout(() => setArtifactCopied(false), 2000);
    });
  }

  function handleCopySnippet() {
    if (generatedSnippet === null) return;
    void navigator.clipboard.writeText(generatedSnippet.text).then(() => {
      setSnippetCopied(true);
      setActionEvidence("manual");
      setTimeout(() => setSnippetCopied(false), 2000);
    });
  }

  function clearPendingAction() {
    if (pendingTimeoutRef.current !== null) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
    setPendingTimeoutId(null);
    setPendingAction(null);
  }

  async function commitAction(action: "adopt" | "dismiss", optionId?: string) {
    if (
      action === "adopt" &&
      (optionId === undefined
        ? primaryFailure !== null
        : !availableAlternatives.some((option) => option.option_id === optionId))
    )
      return;
    const commit = action === "adopt" ? onAdopt : onDismiss;
    if (commit === undefined || savingRef.current) return;
    savingRef.current = true;
    setWriteState({ status: "saving" });
    try {
      if (action === "adopt") await onAdopt?.(rec.rec_id, optionId);
      else await onDismiss?.(rec.rec_id);
      setWriteState({ status: "saved", action });
    } catch (error: unknown) {
      setWriteState({
        status: "failed",
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      savingRef.current = false;
    }
  }

  async function commitTrack() {
    if (savingRef.current || !canStartCycle) return;
    savingRef.current = true;
    setWriteState({ status: "saving" });
    try {
      trackKey.current ??= createEffectIdempotencyKey(rec.rec_id, "track");
      const result = await trackEffect(rec.rec_id, trackKey.current);
      if (!result.supported || result.cycle === undefined) {
        throw new Error(result.reason ?? "Measurement is not supported for this change.");
      }
      setCycle(result.cycle);
      setHistoryRefreshKey((key) => key + 1);
      setWriteState({ status: "saved", action: "track" });
      onEffectMutated?.();
    } catch (error: unknown) {
      setWriteState({
        status: "failed",
        action: "track",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      savingRef.current = false;
    }
  }

  function scheduleAction(action: Exclude<PendingRecommendationAction, null>, optionId?: string) {
    if (
      action === "adopt" &&
      (optionId === undefined
        ? primaryFailure !== null
        : !availableAlternatives.some((option) => option.option_id === optionId))
    )
      return;
    const commit = action === "adopt" ? onAdopt : action === "dismiss" ? onDismiss : undefined;
    if (
      (action !== "track" && commit === undefined) ||
      pendingTimeoutRef.current !== null ||
      savingRef.current
    )
      return;

    setWriteState({ status: "idle" });
    if (action === "adopt") lastAdoptOptionId.current = optionId;
    setPendingAction(action);
    const timeoutId = setTimeout(() => {
      pendingTimeoutRef.current = null;
      setPendingTimeoutId(null);
      setPendingAction(null);
      if (action === "track") void commitTrack();
      else void commitAction(action, optionId);
    }, ACTION_UNDO_WINDOW_MS);
    pendingTimeoutRef.current = timeoutId;
    setPendingTimeoutId(timeoutId);
  }

  function requestTrack() {
    if (terminalCycle) {
      if (!canRetrack) return;
      setRetrackAttested(false);
      setRetrackConfirmation(true);
      return;
    }
    scheduleAction("track");
  }

  function confirmRetrack() {
    if (!canRetrack || !retrackAttested || savingRef.current || pendingAction !== null) return;
    trackKey.current = null;
    setRetrackConfirmation(false);
    scheduleAction("track");
  }

  function lifecycleKey(action: CycleAction, cycleId: string): string {
    const intent = `${action}:${cycleId}`;
    const existing = lifecycleKeys.current.get(intent);
    if (existing !== undefined) return existing;
    const created = createEffectIdempotencyKey(rec.rec_id, intent);
    lifecycleKeys.current.set(intent, created);
    return created;
  }

  async function runCycleAction(action: CycleAction) {
    if (cycle === null || !canMutateCycle || savingRef.current || pendingAction !== null) return;
    const currentCycle = cycle;
    savingRef.current = true;
    setWriteState({ status: "saving" });
    try {
      const key = lifecycleKey(action, currentCycle.cycleId);
      if (action === "stop" || action === "close") {
        const result = await (action === "stop" ? stopEffect : closeEffect)(
          currentCycle.cycleId,
          key,
        );
        setCycle(result);
      } else {
        const operation = await (action === "rollback" ? rollbackEffect : attestRollbackEffect)(
          currentCycle.cycleId,
          key,
        );
        // Rollback responses describe an operation; re-read its cycle so terminal
        // state, comparison evidence and attribution boundaries remain authoritative.
        const page = await fetchEffectEvidence(rec.rec_id);
        const updated = page.cycles.find((item) => item.cycleId === operation.cycleId);
        if (updated === undefined)
          throw new Error(
            "Change recorded, but its measurement could not be refreshed. Retry to reload it.",
          );
        setCycle(updated);
      }
      setHistoryRefreshKey((key) => key + 1);
      setWriteState({ status: "saved", action });
      onEffectMutated?.();
    } catch (error: unknown) {
      setWriteState({
        status: "failed",
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      savingRef.current = false;
    }
  }

  useEffect(() => {
    return () => {
      if (pendingTimeoutRef.current !== null) clearTimeout(pendingTimeoutRef.current);
    };
  }, []);

  async function pollJob(jobId: string, previousPreview: string | null = null): Promise<void> {
    for (let i = 0; i < 90; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
      const res = await fetch(`/api/recommendations/jobs/${encodeURIComponent(jobId)}`);
      if (!res.ok) throw new Error(await responseText(res));
      const body = (await res.json()) as { data?: ApplyJobPayload };
      const job = body.data;
      if (job === undefined) throw new Error("Malformed job response");
      if (job.status === "DRY_DONE") {
        setApplyState({
          status: "dry_done",
          jobId,
          diffPreview: job.diff_preview ?? "Dry run completed with no preview output.",
        });
        return;
      }
      if (job.status === "APPLIED") {
        setApplyState({ status: "applied", jobId, diffApplied: job.diff_applied });
        setActionEvidence("supported");
        return;
      }
      if (job.status === "ROLLED_BACK") {
        setApplyState({ status: "rolled_back" });
        setActionEvidence("none");
        setManualAttested(false);
        return;
      }
      if (job.status === "FAILED") {
        setApplyState({ status: "failed", message: job.error_msg ?? "Apply job failed" });
        return;
      }
      if (job.status === "CONFIRMING" && previousPreview !== null) {
        setApplyState({ status: "confirming", jobId, diffPreview: previousPreview });
      }
    }
    throw new Error("Timed out waiting for apply job");
  }

  function handleAssistedApply() {
    if (!canAssistedApply || workspaceCwd === null) return;
    setApplyState({ status: "dry_running", jobId: "" });
    void fetchSessionToken()
      .then((token) =>
        fetch(`/api/recommendations/${encodeURIComponent(rec.rec_id)}/apply`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify({ workspace_cwd: workspaceCwd }),
        }),
      )
      .then(async (res) => {
        if (!res.ok) throw new Error(await responseText(res));
        const body = (await res.json()) as { data?: { job_id?: string } };
        const jobId = body.data?.job_id;
        if (typeof jobId !== "string") throw new Error("Malformed apply response");
        setApplyState({ status: "dry_running", jobId });
        await pollJob(jobId);
      })
      .catch((e: unknown) => {
        setApplyState({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      });
  }

  function handleOpenTerminal() {
    if (
      openTerminalPending ||
      !canOpenTerminal ||
      promptArtifact === null ||
      rec.scope_workspace_id === null
    )
      return;
    setOpenTerminalMsg(null);
    setOpenTerminalPending(true);
    const workspaceId = rec.scope_workspace_id;
    void fetchSessionToken()
      .then((token) =>
        fetch(`/api/recommendations/${encodeURIComponent(rec.rec_id)}/open-terminal`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify({ prompt: promptArtifact.text }),
        }),
      )
      .then(async (res) => {
        const body = (await res.json()) as { launched?: boolean; reason?: string };
        if (res.ok && body.launched === true) {
          setOpenTerminalMsg({
            ok: true,
            text: `Opened a terminal in ${labelFor(workspaceId)}.`,
          });
          setActionEvidence("manual");
        } else {
          setOpenTerminalMsg({
            ok: false,
            text: body.reason ?? "No terminal found — Copy prompt instead.",
          });
        }
      })
      .catch(() => {
        setOpenTerminalMsg({ ok: false, text: "No terminal found — Copy prompt instead." });
      })
      .finally(() => setOpenTerminalPending(false));
  }

  function handleConfirmApply() {
    if (primaryFailure !== null || applyState.status !== "dry_done") return;
    const { jobId, diffPreview } = applyState;
    setApplyState({ status: "confirming", jobId, diffPreview });
    void fetchSessionToken()
      .then((token) =>
        fetch(`/api/recommendations/jobs/${encodeURIComponent(jobId)}/confirm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify({}),
        }),
      )
      .then(async (res) => {
        if (!res.ok) throw new Error(await responseText(res));
        await pollJob(jobId, diffPreview);
      })
      .catch((e: unknown) => {
        setApplyState({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      });
  }

  function handleRollbackApply() {
    if (applyState.status !== "applied") return;
    const { jobId } = applyState;
    void fetchSessionToken()
      .then((token) =>
        fetch(`/api/recommendations/jobs/${encodeURIComponent(jobId)}/rollback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-AgentWrangler-Token": token } : {}),
          },
          body: JSON.stringify({}),
        }),
      )
      .then(async (res) => {
        if (!res.ok) throw new Error(await responseText(res));
        setApplyState({ status: "rolled_back" });
        setActionEvidence("none");
        setManualAttested(false);
      })
      .catch((e: unknown) => {
        setApplyState({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      });
  }

  function requestManualRollback() {
    void runCycleAction("rollback");
  }

  function toggleDetails() {
    if (expanded) {
      setExpanded(false);
      detailsLauncherRef.current?.focus();
      return;
    }
    setExpanded(true);
  }

  function onDetailsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setExpanded(false);
    detailsLauncherRef.current?.focus();
  }

  function closeEvaluation() {
    setEvaluationOpen(false);
    evaluationLauncherRef.current?.focus();
  }

  const rootClass = grouped ? "rec-session-row" : "card rec-card";
  const highlightClass = focused ? " rec-focus-highlight" : "";
  const foldedClass = folded && !grouped ? " rec-folded" : "";

  // A click on empty header space folds or unfolds; clicks on its controls do their own job.
  function onHeadClick(event: MouseEvent<HTMLDivElement>) {
    if (grouped) return;
    if ((event.target as Element).closest("button, a, input, textarea, summary")) return;
    if (window.getSelection()?.toString()) return;
    setFolded(!folded);
  }

  return (
    <div
      ref={cardRef}
      className={`${rootClass}${highlightClass}${foldedClass}`}
      data-category={rec.category.toLowerCase()}
      style={{ marginBottom: 13 }}
    >
      {focused && (
        <FocusHighlightBanner
          {...(onDismissFocus === undefined ? {} : { onDismiss: onDismissFocus })}
        />
      )}
      {/* Flagship banner for the #1 ranked card */}
      {!grouped && showRank && isFlagship && (
        <div className="rec-flagship-banner">
          <span className="rec-flagship-badge">CHECK FIRST</span>
          <span className="rec-flagship-rationale">
            Reusing saved context can reduce repeated token use.
          </span>
        </div>
      )}

      {/* Collapsed row — always visible */}
      <div className="rec-collapsed-row">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a pointer shortcut; the title button is the keyboard toggle */}
        <div className="rec-card-head" onClick={onHeadClick}>
          <div className="rec-card-head-copy">
            {!grouped && showRank && (
              <span className="overview-top-rec-rank" aria-label={`Rank ${rank}`}>
                {rank}
              </span>
            )}
            {/* One scannable line, grouped by function: what (category) · action kind ·
                status · where (scope). */}
            <div className="rec-chip-row" aria-label="Recommendation claim indicators">
              <RecChips
                rec={rec}
                afterCategory={
                  displayGroup !== (CATEGORY_LABEL[rec.category] ?? rec.category) && (
                    <span className="rec-category-chip">{displayGroup}</span>
                  )
                }
              />
              {measuring && cycle !== null ? (
                <>
                  <span className="rec-confidence-tier" aria-label="Measuring effect">
                    {measuringStatusLine(cycle)}
                  </span>
                  <InfoTip
                    label="Measurement status"
                    content="Days since the change was adopted, out of the measurement window. When the window ends, the verdict compares the measured target before and after the change."
                  />
                </>
              ) : improved ? (
                <span className="rec-confidence-tier" aria-label="Fixed">
                  Fixed ✓
                  {measuredReduction === null
                    ? ""
                    : ` −${measuredReduction} tokens/${cycle?.targetDefinition.sampleUnit}`}
                </span>
              ) : noImprovement ? (
                <span className="rec-confidence-tier" aria-label="No improvement measured">
                  Applied — no improvement measured
                </span>
              ) : null}
              {!rec.actionability_ok && (
                <span
                  className="rec-category-chip"
                  title="This recommendation needs a concrete structured step before it can be actioned."
                >
                  needs steps
                </span>
              )}
              <ScopeBadge rec={rec} />
              <InfoTip
                label="What the claim chips mean"
                content="These labels distinguish recorded measurements from estimates. A recorded measurement does not prove that a suggestion will save tokens."
              />
            </div>
            <div className="rec-header-row">
              <h3 className="rec-title">
                {grouped ? (
                  (rec.title ?? rec.lever)
                ) : (
                  <button
                    type="button"
                    className="rec-title-toggle"
                    aria-expanded={!folded}
                    onClick={() => setFolded(!folded)}
                  >
                    {rec.title ?? rec.lever}
                  </button>
                )}
              </h3>
            </div>
            {grouped && (
              <span className="kpi-off-hint rec-target-label">{recTargetLabel(rec, labelFor)}</span>
            )}
            <span className="rec-description rec-headline-text">
              {d1Headline(rec, labelFor) ?? primaryAction?.summary ?? headlineText}
              {primaryAction && (
                <InfoTip
                  label={`${primaryAction.kind} action`}
                  content={ACTION_KIND_HELP[primaryAction.kind]}
                />
              )}
            </span>
          </div>
          <div className="rec-card-head-savings">
            <SavingsMeter
              rec={rec}
              scale={
                savingsScale ?? meterBounds(rec)?.[1] ?? Math.max(0, headlineSavings(rec) ?? 0)
              }
              testIdSuffix={rec.rec_id}
            />
            {estimate && basis && basis !== "X" && (
              <div className="rec-impact-line">
                <Chip
                  kind={basis === "P" || basis === "E" ? "OBS_PROXY" : "ATTENTION"}
                  label={
                    rec.detector_id === "H1"
                      ? "RISK (upper bound)"
                      : basis === "P"
                        ? isD1Heuristic(rec)
                          ? "Token estimate"
                          : "Modeled"
                        : basis === "E"
                          ? "Usage-estimated"
                          : basis === "O"
                            ? "Overlap"
                            : "Risk"
                  }
                />
                <InfoTip
                  label="Estimate basis"
                  content={
                    isD1Heuristic(rec)
                      ? "Source token count uses a chars/4 heuristic; measured usage does not validate that quantity."
                      : BASIS_HELP[basis]
                  }
                />
                {(rec.category === "SAFETY" ||
                  rec.detector_id === "H1" ||
                  rec.detector_id === "B5") && (
                  <>
                    <Chip kind="ATTENTION" label="⚠ Safety" />
                    <InfoTip
                      label="Safety"
                      content="Safety finding; review the risk before acting."
                    />
                  </>
                )}
              </div>
            )}
          </div>
          <div className="rec-card-head-actions">
            {primaryAction &&
              rec.state === "PROPOSED" &&
              !improved &&
              !retired &&
              (reviewLabel || !copyReady ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    expanded ? detailsHeadingRef.current?.focus() : setExpanded(true)
                  }
                >
                  <ReviewIcon />
                  {reviewLabel ?? "Review evidence"}
                </button>
              ) : copyLabel ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => copyAction(primaryAction.copy_text, primaryAction.option_id)}
                >
                  <CopyIcon />
                  {copiedOptionId === primaryAction.option_id ? "Copied" : copyLabel}
                </button>
              ) : null)}
            {rec.state === "PROPOSED" &&
              !improved &&
              !retired &&
              (rec.detector_id === "D5" ? (
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!onAdopt || pendingAction !== null || writeState.status === "saving"}
                  onClick={() => scheduleAction("adopt")}
                >
                  Acknowledge
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={
                      capability?.mode !== "TRACKABLE" ||
                      unsupportedCycle ||
                      (terminalCycle && !canRetrack) ||
                      pendingAction !== null ||
                      writeState.status === "saving"
                    }
                    title="Records a baseline for this completed change; it changes no files."
                    onClick={() =>
                      terminalCycle || manualAttested ? requestTrack() : setTrackGateOpen(true)
                    }
                  >
                    Track
                  </button>
                  {(capability?.mode !== "TRACKABLE" || unsupportedCycle) && (
                    <InfoTip
                      label="Why Track is unavailable"
                      content={trackUnavailableReason(rec)}
                    />
                  )}
                </>
              ))}
            {primaryAction &&
              primaryFailure === null &&
              rec.state === "PROPOSED" &&
              !improved &&
              !retired && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => scheduleAction("adopt")}
                  disabled={!onAdopt || pendingAction !== null || writeState.status === "saving"}
                >
                  Adopt
                </button>
              )}
            {primaryAction && rec.state === "PROPOSED" && !improved && !retired && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => scheduleAction("dismiss")}
                disabled={!onDismiss || pendingAction !== null || writeState.status === "saving"}
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
        {trackGateOpen && (
          <div className="rec-tracking-gate">
            <p>Tracking records a baseline after you complete the change.</p>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setManualAttested(true);
                setTrackGateOpen(false);
                requestTrack();
              }}
            >
              I completed the change
            </button>
            <button type="button" className="btn-secondary" onClick={() => setTrackGateOpen(false)}>
              Cancel
            </button>
          </div>
        )}
        {/* Body order follows the card-review page: what's wrong (TL;DR, then in full),
            evidence and calls, the suggested action and alternatives in full, then related
            cards. Each section is its own accented block (operator 2026-09-26). */}
        {rec.trigger?.problem && (
          <section className="rec-section rec-block rec-block-problem" aria-label="What's wrong">
            <h4 className="rec-section-label">What's wrong</h4>
            {rec.trigger.summary && (
              <p className="rec-tldr">
                <span className="rec-tldr-label">TL;DR</span> {rec.trigger.summary}
              </p>
            )}
            <ProblemText text={rec.trigger.problem} long={rec.trigger.problem.length > 260} />
            {rec.trigger.why && (
              <details className="rec-why">
                <summary className="btn-secondary rec-disclosure">Why this matters</summary>
                <p className="rec-why-text">{rec.trigger.why}</p>
              </details>
            )}
          </section>
        )}
        {rec.trigger && (
          <section
            className="rec-section rec-block rec-block-evidence rec-trigger"
            aria-label="Evidence"
          >
            <h4 className="rec-section-label">Evidence</h4>
            {rec.trigger.facts.length > 0 && (
              <dl className="rec-facts">
                {rec.trigger.facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p>
              {evidenceWindowLabel(
                sessionCountForWindow,
                rec.trigger.window,
                rec.detector_id === "D11" && sessionCountForWindow !== null
                  ? ` used ${evidenceString(rec, "higher_error_tool") ?? "one tool"}`
                  : undefined,
              )}
              {sessionCountForWindow === null && (
                <InfoTip
                  label="Why session count is unavailable"
                  content="The full cohort was not established; the sessions listed above are examples, not the count."
                />
              )}
            </p>
            {(rec.trigger.evidence?.sessions.length ?? rec.trigger.session_ids.length) > 0 && (
              <span>
                Sessions:{" "}
                {(
                  rec.trigger.evidence?.sessions.map((session) => session.session_id) ??
                  rec.trigger.session_ids
                ).map((id, index) => (
                  <span key={id}>
                    {index > 0 && ", "}
                    <a href={`#/sessions/${encodeURIComponent(id)}`} title={id}>
                      {shortId(id)}
                    </a>
                  </span>
                ))}
              </span>
            )}
            {rec.trigger.calls !== undefined && rec.trigger.calls.length > 0 && (
              <>
                {/* Layout review 2 (operator 2026-09-26): Evidence opens with its facts; the
                    calls behind them are one click away. */}
                {(callsOpen || rec.trigger.facts.length === 0) && (
                  <>
                    <h4 className="rec-section-label rec-calls-label">
                      {rec.detector_id === "A1" ? "Largest calls" : "Example calls"}
                    </h4>
                    <ol className="rec-trigger-calls">
                      {rec.trigger.calls.map((call) => (
                        <li key={`${call.kind}:${call.target}`}>
                          <code>{call.target}</code>: {callUsage(call)}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
                {rec.trigger.facts.length > 0 && (
                  <button
                    type="button"
                    className="btn-secondary rec-clamp-toggle"
                    aria-expanded={callsOpen}
                    onClick={() => setCallsOpen(!callsOpen)}
                  >
                    {callsOpen
                      ? "Hide calls"
                      : `Show ${rec.detector_id === "A1" ? "largest" : "example"} calls (${rec.trigger.calls.length})`}
                  </button>
                )}
              </>
            )}
          </section>
        )}
        {recency.length > 0 && <p className="rec-recency">{recency.join(" · ")}</p>}
        {improved && (
          <button
            type="button"
            className="btn-secondary"
            disabled={writeState.status === "saving"}
            onClick={() => void changeLifecycle("reopen")}
          >
            Reopen
          </button>
        )}
        {showSessionRows && !rec.trigger && sessionIds.length > 0 && (
          <ul className="rec-session-links" aria-label="Affected sessions">
            {sessionIds.map((sessionId) => (
              <li key={sessionId}>
                <span className="rec-session-label">Session</span>{" "}
                <a href={`#/sessions/${encodeURIComponent(sessionId)}`} title={sessionId}>
                  {shortId(sessionId)}
                </a>
              </li>
            ))}
          </ul>
        )}
        {/* D1 secondary-lever label (taxonomy R9 / D8 design §9.7):
              always visible in collapsed state so the user sees the framing before acting. */}
        {!grouped && isD1 && !measuring && (
          <p className="rec-d1-secondary-lever">
            Review the {isD1Heuristic(rec) ? "estimated" : "measured"} file size before editing.
            Keep instructions the project still needs.
          </p>
        )}
        {/* R6-07: an adopted D1 cycle can sit in OPEN_MEASURING for its whole window while the
              file is never edited. Say so plainly instead of leaving "Measuring" unexplained. */}
        {!grouped && isD1 && measuring && cycle !== null && noChangeSeen && (
          <p className="rec-d1-no-change">
            No change to {rec.file_ref ?? "the file"} seen since you adopted on{" "}
            {shortDate(cycle.appliedAt)}. Make the edit, or Undo adopt.
            {noBaselineOnRecord &&
              " No before-size on record; the verdict will use the size at adoption."}
          </p>
        )}
        {primaryAction && rec.state === "PROPOSED" && !improved && !retired && (
          <div className="rec-decision-actions">
            {primaryFailure !== null ? (
              <p>Action withheld — failed validation: {primaryFailure}</p>
            ) : (
              <section
                className="rec-section rec-block rec-block-action"
                aria-label="Suggested action"
              >
                <h4 className="rec-section-label">Suggested action</h4>
                <p className="rec-action-summary">{primaryAction.summary}</p>
                <ActionPrompt
                  option={primaryAction}
                  label={<h4 className="rec-section-label">Copy prompt</h4>}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => copyAction(primaryAction.copy_text, primaryAction.option_id)}
                >
                  {copiedOptionId === primaryAction.option_id ? "Copied ✓" : "Copy"}
                </button>
              </section>
            )}
            {availableAlternatives.length > 0 && (
              <div className="rec-alternatives">
                <div className="rec-alternatives-list">
                  {availableAlternatives.map((option) => (
                    <section
                      className="rec-alternative rec-block rec-block-alternative"
                      key={option.option_id}
                      aria-label="Alternative"
                    >
                      <h4 className="rec-section-label">Alternative</h4>
                      <p className="rec-action-summary">
                        {option.summary}{" "}
                        <InfoTip
                          label={`${option.kind} action`}
                          content={ACTION_KIND_HELP[option.kind]}
                        />
                      </p>
                      <ActionPrompt option={option} />
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => scheduleAction("adopt", option.option_id)}
                        disabled={
                          !onAdopt || pendingAction !== null || writeState.status === "saving"
                        }
                      >
                        Adopt this option
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => copyAction(option.copy_text, option.option_id)}
                      >
                        {copiedOptionId === option.option_id ? "Copied ✓" : "Copy"}
                      </button>
                    </section>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {measuring && primaryAction && primaryFailure === null && (
          <details className="rec-measuring-fixes">
            <summary className="btn-secondary rec-disclosure">Recommended Action</summary>
            <div className="rec-alternatives-list">
              {[primaryAction, ...availableAlternatives].map((option) => (
                <div className="rec-alternative" key={option.option_id}>
                  {/* The headline already states the primary summary. */}
                  {option !== primaryAction && <p>{option.summary}</p>}
                  {/* Show exactly what Copy prompt puts on the clipboard. */}
                  <pre className="rec-copy-preview">{option.copy_text}</pre>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => copyAction(option.copy_text, option.option_id)}
                  >
                    {copiedOptionId === option.option_id ? "Copied ✓" : "Copy prompt"}
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
        {rec.related !== undefined && rec.related.length > 0 && (
          <section
            className="rec-section rec-block rec-block-related rec-related"
            aria-label="Related cards"
          >
            <h4 className="rec-section-label">Related cards</h4>
            <ul>
              {rec.related.map((link) => (
                <li key={link.rec_id}>
                  <a href={`#/recommendations?focus=${encodeURIComponent(link.rec_id)}`}>
                    {link.title}
                  </a>
                  : {link.why}
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="rec-actions">
          {measuring && (
            <>
              <button type="button" className="btn-primary" disabled>
                Adopted
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={writeState.status === "saving"}
                title="Undo the recorded adoption and stop open measurement. This does not revert files."
                onClick={() => void changeLifecycle("undo-adopt")}
              >
                Undo adopt
              </button>
            </>
          )}
          <button
            ref={detailsLauncherRef}
            type="button"
            className="btn-secondary rec-expand-btn"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={toggleDetails}
          >
            {expanded ? "Hide details ▲" : "Show details ▼"}
          </button>
          {/* With a measurement cycle, "Measurement details" below already covers Evaluation.
              These sit in the row as plain buttons: the More menu usually held only
              Evaluation (layout review 2, operator 2026-09-26). */}
          {!improved && !retired && cycle === null && (
            <>
              {!primaryAction && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => scheduleAction("dismiss")}
                  disabled={!onDismiss || pendingAction !== null || writeState.status === "saving"}
                >
                  Dismiss
                </button>
              )}
              {experimental && canOpenTerminal && (
                <button
                  type="button"
                  className="btn-secondary"
                  title="Opens your terminal in this workspace running an interactive Claude Code session seeded with the prompt. The daemon changes no files."
                  onClick={handleOpenTerminal}
                  disabled={openTerminalPending}
                >
                  Open in Claude Code ↗
                </button>
              )}
              <button
                ref={evaluationLauncherRef}
                type="button"
                className="btn-secondary"
                aria-expanded={evaluationOpen}
                onClick={() => (evaluationOpen ? closeEvaluation() : setEvaluationOpen(true))}
              >
                Evaluation
              </button>
            </>
          )}
        </div>
        {!grouped && !isAdopted && !retired && route === "settings-idle" && (
          <div className="rec-primary-action">
            <a className="btn-primary" href="#/sessions">
              Open Sessions
            </a>
          </div>
        )}
        {!grouped && !isAdopted && !retired && route === "settings-calibrate" && (
          <div className="rec-primary-action">
            <a className="btn-primary" href="#/settings?section=calibration">
              Calibrate budget hook
            </a>
          </div>
        )}
        {!grouped && !improved && !retired && generatedSnippet && (
          <div
            className="rec-prompt-artifact rec-generated-snippet"
            data-language={generatedSnippet.language}
          >
            <label className="rec-section-label" htmlFor={snippetLabelId}>
              {generatedSnippet.caption}
            </label>
            <textarea id={snippetLabelId} readOnly value={generatedSnippet.text} />
            <button type="button" className="btn-secondary" onClick={handleCopySnippet}>
              {snippetCopied ? "Copied ✓" : "Copy snippet"}
            </button>
          </div>
        )}
        {!grouped && !improved && !retired && generatedSnippet2 && (
          <SnippetBlock snippet={generatedSnippet2} />
        )}
        {rec.detector_id !== "D5" &&
          actionEvidence === "manual" &&
          !manualAttested &&
          !measuring && (
            <div className="rec-tracking-gate">
              <p>
                A copied prompt or launched terminal is not proof of a change. Confirm only after
                you completed it and it remains applied for the measurement window.
              </p>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setManualAttested(true)}
              >
                I completed the change
              </button>
            </div>
          )}
        {rec.detector_id !== "D5" &&
          capability !== undefined &&
          capability.mode !== "TRACKABLE" && (
            <p className="rec-tracking-gate">
              {capability.reason === "HANDLER_UNAVAILABLE"
                ? "AgentWrangler can't measure this change yet. You can still copy it and adopt it, but there will be no before/after result."
                : capability.mode === "READ_ONLY"
                  ? "This recommendation is read-only; measurement cannot be started."
                  : capability.mode === "MANUAL"
                    ? "Measurement is manual for this recommendation; no countdown or result is being recorded."
                    : "This recommendation is acknowledged without impact measurement."}
            </p>
          )}
        {rec.detector_id !== "D5" && capability === undefined && (
          <p className="rec-tracking-gate">
            Measurement availability is unknown for this older recommendation. It remains manual and
            no countdown is shown.
          </p>
        )}
        {evaluationOpen && (
          <EvaluationDisclosure
            rec={rec}
            cycle={cycle}
            capability={capability}
            canRetrack={canRetrack}
            onClose={closeEvaluation}
          />
        )}
        {rec.detector_id !== "D5" &&
          actionEvidence !== "none" &&
          (actionEvidence === "supported" || manualAttested) &&
          !isAdopted && (
            <p className="rec-tracking-gate">
              Tracking records a baseline; it does not prove effectiveness. You can stop measurement
              later without changing your file.
            </p>
          )}
        {cycle !== null && (
          <div className="rec-tracking-gate">
            {!canMutateCycle ? (
              <p>This measurement is read-only; lifecycle controls are unavailable.</p>
            ) : (
              <div className="rec-actions-secondary">
                {(cycle.state === "OPEN_SETTLING" || cycle.state === "OPEN_MEASURING") && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void runCycleAction("stop")}
                    disabled={writeState.status === "saving" || pendingAction !== null}
                  >
                    Stop measurement
                  </button>
                )}
                {cycle.state === "FINALIZED" && cycle.attributionClosedAt === null && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void runCycleAction("close")}
                    disabled={writeState.status === "saving" || pendingAction !== null}
                  >
                    Close attribution
                  </button>
                )}
              </div>
            )}
            <details className="rec-diagnostics rec-measurement-details">
              <summary>Measurement details</summary>
              <div className="rec-diagnostics-body">
                {canMutateCycle &&
                  cycle.rollbackStatus !== "PENDING" &&
                  cycle.rollbackStatus !== "SUCCEEDED" &&
                  cycle.rollbackStatus !== "USER_ATTESTED" && (
                    <div>
                      <p>
                        To undo the file change, revert it manually. Stopping measurement alone does
                        not revert files.
                      </p>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={writeState.status === "saving" || pendingAction !== null}
                        onClick={() => void runCycleAction("attest-rollback")}
                      >
                        I reverted the change
                      </button>
                    </div>
                  )}
                <EffectHistory
                  key={`${rec.rec_id}:${historyRefreshKey}`}
                  recId={rec.rec_id}
                  canRetrack={canRetrack}
                  onRetrack={requestTrack}
                />
              </div>
            </details>
          </div>
        )}
        {cycle === null && rec.legacy_effect_verdict != null && (
          <div className="rec-tracking-gate">
            <EffectHistory
              key={`${rec.rec_id}:${historyRefreshKey}`}
              recId={rec.rec_id}
              canRetrack={canRetrack}
              onRetrack={requestTrack}
            />
          </div>
        )}
        {retrackConfirmation && (
          <div className="rec-tracking-gate">
            <p>This starts a new measurement cycle. Earlier cycles stay in the history above.</p>
            <label>
              <input
                type="checkbox"
                checked={retrackAttested}
                onChange={(event) => setRetrackAttested(event.target.checked)}
              />
              I completed another change and want to measure it.
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={confirmRetrack}
              disabled={!retrackAttested || !canRetrack || writeState.status === "saving"}
            >
              Confirm retrack
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setRetrackConfirmation(false)}
            >
              Cancel retrack
            </button>
          </div>
        )}
        {!grouped && route === "copy" && primaryFailure === null && !measuring && (
          <p className="rec-actions-hint">
            {experimental && canOpenTerminal
              ? "Open in Claude Code launches your terminal in this workspace with the prompt loaded — you review and drive every edit."
              : promptSuperseded
                ? "Paste the snippet above into the named file, then review the change."
                : "Copy the prompt into Claude Code in this workspace, then review the proposed changes."}
          </p>
        )}
        {pendingAction !== null && pendingTimeoutId !== null && (
          <output className="rec-action-toast">
            <span>
              {pendingAction === "adopt"
                ? "Adopt pending — Undo"
                : pendingAction === "track"
                  ? "Track pending — Undo"
                  : "Dismiss pending — Undo"}
              <span className="rec-target-label"> · {recTargetLabel(rec, labelFor)}</span>
            </span>
            <button type="button" className="rec-action-toast-undo" onClick={clearPendingAction}>
              Undo
            </button>
          </output>
        )}
        {writeState.status === "saving" && <output>Saving change…</output>}
        {writeState.status === "saved" && (
          <output>
            {writeState.action === "undo-adopt"
              ? "Adoption decision undone; files unchanged"
              : writeState.action === "reopen"
                ? "Recommendation reopened"
                : writeState.action === "adopt"
                  ? rec.detector_id === "D5"
                    ? "Acknowledgment saved"
                    : capability?.mode === "TRACKABLE"
                      ? "Tracking saved"
                      : "Adoption saved · Effect not measured"
                  : writeState.action === "track"
                    ? "Tracking saved"
                    : writeState.action === "stop"
                      ? cycle?.state === "STOPPED"
                        ? "Measurement stopped"
                        : "Measurement refreshed"
                      : writeState.action === "close"
                        ? "Attribution closed"
                        : writeState.action === "rollback"
                          ? "Manual rollback request recorded; no files changed"
                          : writeState.action === "attest-rollback"
                            ? "Rollback attestation recorded; actual rollback time is unknown"
                            : "Dismissal saved"}
            <span className="rec-target-label"> · {recTargetLabel(rec, labelFor)}</span>
          </output>
        )}
        {writeState.status === "failed" && (
          <div className="rec-apply-status rec-apply-status--error" role="alert">
            Could not save: {writeState.message} · {recTargetLabel(rec, labelFor)}{" "}
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                writeState.action === "undo-adopt" || writeState.action === "reopen"
                  ? void changeLifecycle(writeState.action)
                  : writeState.action === "track"
                    ? void commitTrack()
                    : writeState.action === "adopt" || writeState.action === "dismiss"
                      ? void commitAction(
                          writeState.action,
                          writeState.action === "adopt" ? lastAdoptOptionId.current : undefined,
                        )
                      : void runCycleAction(writeState.action)
              }
            >
              Retry <span aria-hidden="true">{recTargetLabel(rec, labelFor)}</span>
            </button>
          </div>
        )}
        {openTerminalMsg !== null && (
          <output
            className={`rec-apply-status${openTerminalMsg.ok ? "" : " rec-apply-status--error"}`}
            {...(openTerminalMsg.ok ? {} : { role: "alert" as const })}
          >
            {openTerminalMsg.text}
          </output>
        )}
        {experimental && applyState.status === "dry_done" && (
          <div className="rec-apply-panel">
            <div className="rec-section-label">Dry-run preview</div>
            <pre className="rec-apply-preview">{applyState.diffPreview}</pre>
            <div className="rec-actions-secondary">
              <button type="button" className="btn-primary" onClick={handleConfirmApply}>
                Confirm apply
              </button>
            </div>
          </div>
        )}
        {experimental && applyState.status === "confirming" && (
          <div className="rec-apply-panel">
            <div className="rec-section-label">Applying</div>
            <p className="kpi-off-hint">Claude Code is applying the confirmed edit.</p>
          </div>
        )}
        {experimental && applyState.status === "applied" && (
          <div className="rec-apply-panel">
            <div className="rec-section-label">Applied</div>
            {applyState.diffApplied !== null && (
              <pre className="rec-apply-preview">{applyState.diffApplied}</pre>
            )}
            {capability === undefined && cycle === null ? (
              <div className="rec-actions-secondary">
                <button type="button" className="btn-secondary" onClick={handleRollbackApply}>
                  Roll back
                </button>
              </div>
            ) : (
              <div className="rec-tracking-gate">
                <p>
                  This versioned recommendation has no safe whole-file rollback. Revert the change
                  manually; that does not erase its measurement history.
                </p>
                {cycle === null ? (
                  <p>
                    Start tracking the completed change before recording a rollback attestation.
                  </p>
                ) : cycle.rollbackStatus === "MANUAL" || cycle.rollbackStatus === "UNSUPPORTED" ? (
                  <p>After reverting the file, use “I reverted the change” above.</p>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!canMutateCycle || writeState.status === "saving"}
                    onClick={requestManualRollback}
                  >
                    Revert manually
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {experimental && applyState.status === "rolled_back" && (
          <p className="rec-apply-status">Rolled back to the pre-apply backup.</p>
        )}
        {experimental && applyState.status === "failed" && (
          <div className="rec-apply-panel" role="alert">
            <div className="rec-section-label">
              {isStartupFailure(applyState.message)
                ? "Apply could not start"
                : "Apply did not complete"}
            </div>
            <p className="rec-apply-status rec-apply-status--error">
              {isStartupFailure(applyState.message)
                ? "Couldn't start the local Claude Code CLI — use Copy prompt instead."
                : "The assisted apply did not complete — try again or use Copy prompt instead."}
            </p>
            <div className="rec-actions-secondary">
              <button type="button" className="btn-primary" onClick={handleAssistedApply}>
                Retry
              </button>
              <button type="button" className="btn-secondary" onClick={handleCopyPromptArtifact}>
                {artifactCopied ? "Copied ✓" : "Copy prompt"}
              </button>
            </div>
            <details className="rec-diagnostics">
              <summary>Developer diagnostics</summary>
              <div className="rec-diagnostics-body">
                <code>{applyState.message}</code>
              </div>
            </details>
          </div>
        )}
      </div>

      {/* Expanded details — methodology behind the toggle */}
      {expanded && (
        <div id={detailsId} className="rec-details" onKeyDown={onDetailsKeyDown}>
          <h4 ref={detailsHeadingRef} className="rec-section-label" tabIndex={-1}>
            Recommendation details
          </h4>
          {grouped && (
            <h4 className="rec-section-label" hidden>
              Recommendation details
            </h4>
          )}
          {!grouped && showRank && (
            <div className="rec-section rec-rank-explanation">
              <h4 className="rec-section-label">Why this is ranked here</h4>
              <p>{rankExplanation(rec, rank, displayGroup)}</p>
            </div>
          )}

          <div className="rec-section">
            <h4 className="rec-section-label">
              What we observed{" "}
              <InfoTip
                label="Understanding these measurements"
                content="Context is the text sent to the model with a request. Cache reads reuse saved text; cache writes save it again. Cap-weighted tokens estimate allowance use using different weights for these operations; they do not report your actual remaining limit. A turn is one model response."
              />
            </h4>
            <ul className="rec-observations">
              {visibleObservationFacts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>

          <div className="rec-section rec-modeled">
            <h4 className="rec-section-label">Possible reduction</h4>
            {hasVisibleSavings && (
              <div className="rec-savings-value">
                {isD1Heuristic(rec) && rec.range_u_per_wk
                  ? `${fmtUsd(rec.range_u_per_wk[0])}–${fmtUsd(rec.range_u_per_wk[1])}/wk`
                  : `${fmtUsd(rec.modeled_savings_u_per_wk as number)}/wk`}{" "}
                <InfoTip
                  label="What this weekly savings estimate means"
                  content="Estimated weekly cost reduction if this change is adopted. Unvalidated modeled estimate based on recent usage patterns. Does not reflect actual measured savings."
                />
                {typeof rec.allocated_u_per_wk === "number" && (
                  <>
                    {" "}
                    <span className="rec-savings-before-overlaps">Before overlaps</span>
                    <InfoTip
                      label="Before overlaps"
                      content={
                        netAboveRange(rec)
                          ? `This detector's own estimate, before removing tokens already counted by a more specific fix. The net-of-overlaps figure (${fmtUsd(rec.allocated_u_per_wk as number)}/wk) covers more than this fix, so the card shows this fix's range instead.`
                          : "This detector's own estimate, before removing tokens already counted by a more specific fix. The card's headline figure above is the net-of-overlaps amount."
                      }
                    />
                  </>
                )}
                {rec.allocated_u_per_wk === null && (
                  <>
                    {" "}
                    <span className="rec-savings-before-overlaps">
                      Standalone estimate (not on the spend ledger)
                    </span>
                    <InfoTip
                      label="Standalone estimate"
                      content={
                        typeof rec.reliability_u_per_wk === "number"
                          ? "This detector's own estimate. It has no spend-ledger producer, so the card headline shows the recovery-turn upper bound instead and this figure is not netted against other recommendations."
                          : rec.estimate?.summable === false
                            ? "This detector's own estimate. Some of its cost is also counted by other cards, so the headline shows it as an estimate that is not in the page total, and it is not netted against other recommendations."
                            : "This detector's own estimate. It has no spend-ledger producer yet, so the card headline reads Not estimated and this figure is not netted against other recommendations."
                      }
                    />
                  </>
                )}
                {!isD1Heuristic(rec) &&
                  rec.pct_of_weekly_spend !== null &&
                  rec.pct_of_weekly_spend !== undefined && (
                    <>
                      {" "}
                      <span className="rec-savings-pct">
                        ({rec.pct_of_weekly_spend.toFixed(1)}% of weekly spend)
                      </span>
                      <InfoTip
                        label="What percentage of weekly spend this represents"
                        content="This estimate as a share of your reconciled trailing 7-day workspace spend. Use as rough context only — the modeled estimate and spend figure use different calculation methods."
                      />
                    </>
                  )}
                <Chip kind="MODELED" />
                <Chip kind="LIST_EQUIV" label="LIST_EQUIV · modeled USD" />
              </div>
            )}
            <p className="rec-modeled-note">{impactCaveat(rec)}</p>
            {assumptionNote !== null && <p className="rec-unvalidated-note">{assumptionNote}</p>}
            {/* B5 provenance: surface formula expression + result as an unvalidated estimate. */}
            {(f.expression !== undefined || f.result_usd_per_wk !== undefined) && (
              <details className="rec-formula-provenance">
                <summary>Show modeled estimate details</summary>
                <p className="rec-unvalidated-note">
                  Unvalidated modeled estimate — inputs may not reflect your actual usage.
                </p>
                {f.expression !== undefined && (
                  <p className="rec-formula-expression">
                    Formula: <code>{f.expression}</code>
                  </p>
                )}
                {f.result_usd_per_wk !== undefined && (
                  <p className="rec-formula-result">Result: ${f.result_usd_per_wk.toFixed(2)}/wk</p>
                )}
                {Object.keys(f.inputs).length > 0 && (
                  <ul className="rec-formula-inputs">
                    {Object.entries(f.inputs).map(([k, v]) => (
                      <li key={k}>
                        <span className="rec-evidence-key">{k}</span>: {String(v)}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            )}
          </div>

          {/* D1 backfire caveat: editing the cached prefix triggers a full cache-write next turn */}
          {isD1 && (
            <p className="rec-caveat-d1">
              Make this edit between tasks or after /clear. Changing instructions already in the
              session can increase token use on the next message because saved context must be
              rewritten.
            </p>
          )}

          {/* Lever / action */}
          <div className="rec-section">
            <h4 className="rec-section-label">Action</h4>
            <p className="rec-lever">{rec.lever}</p>
          </div>

          {/* Steps — numbered action list; steps key excluded from evidence table below */}
          {rec.steps.length > 0 && (
            <div className="rec-section">
              <h4 className="rec-section-label">Steps</h4>
              <ol className="rec-steps">
                {rec.steps.map((step, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps are ordered; content may repeat
                  <li key={i}>{stepDisplay(step)}</li>
                ))}
              </ol>
            </div>
          )}

          <div className="rec-section">
            <h4 className="rec-section-label">How to measure success</h4>
            <p className="rec-success-measure">{successMeasure(rec)}</p>
          </div>

          <details className="rec-diagnostics">
            <summary>Developer diagnostics</summary>
            <div className="rec-diagnostics-body">
              <div className="rec-section">
                <div className="rec-section-label">Provenance and scope</div>
                <ul className="rec-evidence">
                  <li>
                    <span className="rec-evidence-key">rec_id</span>: {rec.rec_id}
                  </li>
                  <li>
                    <span className="rec-evidence-key">detector</span>: {rec.detector_id} ·{" "}
                    {rec.category}
                  </li>
                  <li>
                    <span className="rec-evidence-key">state</span>: {rec.state}
                  </li>
                  <li>
                    <span className="rec-evidence-key">scope</span>:{" "}
                    {rec.scope_workspace_id ?? "global"}
                  </li>
                  <li>
                    <span className="rec-evidence-key">created_at</span>: {rec.created_at}
                  </li>
                  <li>
                    <span className="rec-evidence-key">run cost</span>:{" "}
                    {rec.run_cost_u === null ? "not yet recorded" : fmtUsd(rec.run_cost_u)}
                  </li>
                  {rec.file_ref !== null && (
                    <li>
                      <span className="rec-evidence-key">file_ref</span>: {fmtValue(rec.file_ref)}
                    </li>
                  )}
                </ul>
              </div>

              {diagnosticObservationFacts.length > 0 && (
                <div className="rec-section">
                  <div className="rec-section-label">Evidence details</div>
                  <ul className="rec-evidence rec-observed-evidence">
                    {diagnosticObservationFacts.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </div>
              )}

              {causeFacets.length > 0 && (
                <div className="rec-section">
                  <div className="rec-section-label">Cause facets</div>
                  <ul className="rec-evidence">
                    {causeFacets.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="rec-section">
                <div className="rec-section-label">Raw detector evidence</div>
                <ul className="rec-evidence rec-evidence-raw">
                  {Object.entries(rec.evidence)
                    .filter(([key]) => key !== "steps" && key !== "title")
                    .map(([key, value]) => (
                      <li key={key}>
                        <span className="rec-evidence-key">{key}</span>: {fmtValue(value)}
                      </li>
                    ))}
                </ul>
              </div>

              <div className="rec-section">
                <div className="rec-section-label">Internal target metric</div>
                <code>{rec.target_metric}</code>
              </div>

              <div className="rec-section rec-formula-diagnostics">
                <div className="rec-section-label">Modeled formula</div>
                <p className="rec-formula-expr">
                  <code>{f.expression ?? f.model}</code>
                </p>
                <ul className="rec-formula-inputs">
                  {Object.entries(f.inputs).map(([key, value]) => (
                    <li key={key}>
                      <span className="rec-evidence-key">{key}</span>: {fmtValue(value)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </details>

          {/* Analyze with Claude — secondary action, in expanded section */}
          <div className="rec-actions-secondary">
            <button type="button" className="btn-secondary" onClick={handleAnalyze}>
              Analyze with Claude
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function GroupedRecCard({
  group,
  rank,
  showRank = true,
  isFlagship,
  focusRecId = null,
  onDismissFocus,
  onDismiss,
  onAdopt,
  onEffectMutated,
  savingsScale,
}: {
  group: RecommendationGroup;
  savingsScale?: number | undefined;
  rank: number;
  showRank?: boolean;
  isFlagship?: boolean;
  focusRecId?: string | null;
  onDismissFocus?: () => void;
  onDismiss?: (recId: string) => void | Promise<void>;
  onAdopt?: (recId: string, optionId?: string) => void | Promise<void>;
  onEffectMutated?: () => void;
}) {
  const [snippetCopied, setSnippetCopied] = useState(false);
  const snippetLabelId = useId();
  const focused = focusRecId !== null && group.recs.some((rec) => rec.rec_id === focusRecId);
  const cardRef = useRef<HTMLDivElement>(null);

  // Scroll the group card into view when it holds the deep-link target (RV6).
  useEffect(() => {
    if (focused) scrollFocusedIntoView(cardRef.current);
  }, [focused]);

  const representative = group.recs[0];
  if (representative === undefined) return null;

  const isMinorItems = group.detector_id === "MINOR_ITEMS";
  const route = recRoute(representative.detector_id);
  const representativeWithheld = representative.action_validation?.primary.ok !== true;
  const generatedCandidate: GeneratedSnippet | null = representativeWithheld
    ? null
    : (generateSettingsDisableBlock(representative) ??
      generateModelDefaultSnippet(representative) ??
      generateAutocompactSnippet(representative) ??
      generateFrictionRuleSnippet(representative) ??
      generateD7LoopRetrySnippet(representative) ??
      generateDestructiveGuardSnippet(representative) ??
      generateCacheBehaviorSnippet(representative));
  // Secondary snippet offered alongside the primary (RI8): D4 subagent routing.
  const generatedSnippet =
    generatedCandidate && hasValidatedCopyText(representative, generatedCandidate.text)
      ? generatedCandidate
      : null;
  const secondaryCandidate: GeneratedSnippet | null = representativeWithheld
    ? null
    : generateSubagentRoutingSnippet(representative);
  const generatedSnippet2 =
    secondaryCandidate && hasValidatedCopyText(representative, secondaryCandidate.text)
      ? secondaryCandidate
      : null;
  // Only Phase 2.5 friction/destructive/cache snippets supersede the investigation
  // copy-prompt; D4/D10 snippets still coexist with it.
  const promptSuperseded = generatedSnippet?.supersedesInvestigationPrompt === true;
  const canDryRun = group.recs.some(canAssistedApplyForRec);
  const groupRankExplanation = isMinorItems
    ? "These recommendations are below the $1/week modeled-savings floor, so they stay together as minor items instead of taking separate top-level cards."
    : rankExplanation(representative, rank, group.label);
  // P3.L L6: group figures follow the card headline; the D1-heuristic range only applies to
  // legacy cards (allocated_u_per_wk undefined).
  const legacyHeuristic = (rec: RecommendationCard) =>
    rec.allocated_u_per_wk === undefined && isD1Heuristic(rec);
  const groupHeadline = group.recs.some((rec) => typeof headlineSavings(rec) === "number")
    ? group.recs.reduce((sum, rec) => sum + (headlineSavings(rec) ?? 0), 0)
    : null;
  const hasHeuristicD1 = group.recs.some(legacyHeuristic);
  const groupLow = group.recs.reduce(
    (sum, rec) =>
      sum + (legacyHeuristic(rec) ? (rec.range_u_per_wk?.[0] ?? 0) : (headlineSavings(rec) ?? 0)),
    0,
  );
  const groupHigh = group.recs.reduce(
    (sum, rec) =>
      sum + (legacyHeuristic(rec) ? (rec.range_u_per_wk?.[1] ?? 0) : (headlineSavings(rec) ?? 0)),
    0,
  );
  const groupMeterHigh = group.recs.reduce((sum, rec) => sum + (meterBounds(rec)?.[1] ?? 0), 0);
  const savingsSummary = hasHeuristicD1
    ? `${fmtUsd(groupLow)}–${fmtUsd(groupHigh)}/wk modeled trim-assumption range; source tokens unmeasured`
    : group.total_savings_u_per_wk > 0
      ? `${fmtUsd(group.total_savings_u_per_wk)}/wk modeled across this group`
      : "No modeled savings; review the directional evidence below";

  function handleCopySnippet() {
    if (generatedSnippet === null) return;
    void navigator.clipboard.writeText(generatedSnippet.text).then(() => {
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 2000);
    });
  }

  const memberRows = group.recs.map((rec) => (
    <SingleRecCard
      key={rec.rec_id}
      rec={rec}
      grouped
      showSessionRows
      savingsScale={savingsScale}
      focusRecId={focusRecId}
      {...(onDismiss === undefined ? {} : { onDismiss })}
      {...(onAdopt === undefined ? {} : { onAdopt })}
      {...(onEffectMutated === undefined ? {} : { onEffectMutated })}
    />
  ));

  return (
    <div
      ref={cardRef}
      className={`card rec-card rec-group-card${isMinorItems ? " rec-minor-items-card" : ""}${
        focused ? " rec-focus-highlight" : ""
      }`}
      data-detector-id={group.detector_id}
      data-category={representative.category.toLowerCase()}
      style={{ marginBottom: 13 }}
    >
      {focused && (
        <FocusHighlightBanner
          {...(onDismissFocus === undefined ? {} : { onDismiss: onDismissFocus })}
        />
      )}
      {!isMinorItems && showRank && isFlagship && (
        <div className="rec-flagship-banner">
          <span className="rec-flagship-badge">CHECK FIRST</span>
          <span className="rec-flagship-rationale">
            Reusing saved context can reduce repeated token use.
          </span>
        </div>
      )}
      <div className="rec-group-header">
        <div className="rec-header-row">
          {!isMinorItems && showRank && <span className="rec-rank-badge">#{rank}</span>}
          <RecChips rec={representative} />
          <h3 className="rec-title">{group.label}</h3>
          <span className="rec-group-count">
            {group.recs.length} recommendation{group.recs.length === 1 ? "" : "s"}
          </span>
          <ScopeBadge rec={representative} />
        </div>
        <div className="rec-group-summary">
          <span>
            {group.session_count} affected session{group.session_count === 1 ? "" : "s"}
          </span>
          {group.recs.some(isQuantified) ? (
            <SavingsMeter
              rec={{
                ...representative,
                evidence: hasHeuristicD1
                  ? { ...representative.evidence, attribution_method: "CHARS4_ESTIMATE" }
                  : representative.evidence,
                modeled_savings_u_per_wk: group.recs.every(
                  (member) => member.modeled_savings_u_per_wk !== null,
                )
                  ? group.recs.reduce(
                      (sum, member) => sum + (member.modeled_savings_u_per_wk ?? 0),
                      0,
                    )
                  : null,
                // P3.L L6: the group headline is the sum of the member headlines (allocated,
                // net of overlaps). Legacy groups (no member carries allocated) stay undefined
                // so the meter falls back to the standalone figure as before.
                ...(group.recs.every((member) => member.allocated_u_per_wk === undefined)
                  ? {}
                  : { allocated_u_per_wk: groupHeadline }),
                range_u_per_wk: [
                  group.recs.reduce((sum, member) => sum + (meterBounds(member)?.[0] ?? 0), 0),
                  groupMeterHigh,
                ],
              }}
              scale={Math.max(savingsScale ?? 0, groupMeterHigh)}
              testIdSuffix={`group-${group.detector_id}`}
            />
          ) : (
            <span>{savingsSummary}</span>
          )}
        </div>
        {showRank && (
          <div className="rec-section rec-rank-explanation">
            <h4 className="rec-section-label">Why this is ranked here</h4>
            <p>{groupRankExplanation}</p>
          </div>
        )}
        {!isMinorItems && !representative.actions && route === "copy" && (
          <p className="rec-actions-hint">
            {canDryRun
              ? "Open in Claude Code (experimental) launches your terminal in the workspace with the prompt loaded — you review every edit."
              : promptSuperseded
                ? "Paste the snippet above into the named file, then review the change."
                : "Copy the prompt into Claude Code in this workspace, then review the proposed changes."}
          </p>
        )}
        {!isMinorItems && route === "settings-idle" && (
          <div className="rec-primary-action">
            <a className="btn-primary" href="#/sessions">
              Open Sessions
            </a>
          </div>
        )}
        {!isMinorItems && route === "settings-calibrate" && (
          <div className="rec-primary-action">
            <a className="btn-primary" href="#/settings?section=calibration">
              Calibrate budget hook
            </a>
          </div>
        )}
        {!isMinorItems && generatedSnippet && (
          <div
            className="rec-prompt-artifact rec-generated-snippet"
            data-language={generatedSnippet.language}
          >
            <label className="rec-section-label" htmlFor={snippetLabelId}>
              {generatedSnippet.caption}
            </label>
            <textarea id={snippetLabelId} readOnly value={generatedSnippet.text} />
            <button type="button" className="btn-secondary" onClick={handleCopySnippet}>
              {snippetCopied ? "Copied ✓" : "Copy snippet"}
            </button>
          </div>
        )}
        {!isMinorItems && generatedSnippet2 && <SnippetBlock snippet={generatedSnippet2} />}
        {group.detector_id === "D1" && (
          <p className="rec-d1-secondary-lever">
            Review the {group.recs.some(isD1Heuristic) ? "estimated" : "measured"} file size before
            editing. Keep instructions the project still needs.
          </p>
        )}
      </div>
      {isMinorItems ? (
        <details className="rec-minor-items" {...(focused ? { open: true } : {})}>
          <summary>
            Show {group.recs.length} minor item{group.recs.length === 1 ? "" : "s"}
          </summary>
          <div className="rec-group-members">{memberRows}</div>
        </details>
      ) : (
        <div className="rec-group-members">{memberRows}</div>
      )}
    </div>
  );
}

interface RecCardProps {
  rec?: RecommendationCard;
  group?: RecommendationGroup;
  /** Cross-list rank (1 = highest-leverage). Optional; defaults to 1 for standalone use. */
  rank?: number;
  /** Whether to present this detector card as part of a ranked queue. */
  showRank?: boolean;
  /** True for the #1 ranked group — renders flagship badge + rationale. */
  isFlagship?: boolean;
  /** RV6 deep-link target: the rec_id to scroll to, highlight, and auto-expand. */
  focusRecId?: string | null;
  /** Called to clear the focus deep-link when the user dismisses the highlight. */
  onDismissFocus?: () => void;
  onDismiss?: (recId: string) => void | Promise<void>;
  onAdopt?: (recId: string, optionId?: string) => void | Promise<void>;
  onEffectMutated?: () => void;
  savingsScale?: number | undefined;
  /** R6-18: cards after #1 (and the focused card) start folded to fit more on one screen. */
  defaultFolded?: boolean;
}

export default function RecCard({
  rec,
  group,
  rank = 1,
  showRank = true,
  isFlagship,
  focusRecId = null,
  onDismissFocus,
  onDismiss,
  onAdopt,
  onEffectMutated,
  savingsScale,
  defaultFolded = false,
}: RecCardProps) {
  if (group !== undefined) {
    return (
      <GroupedRecCard
        group={group}
        savingsScale={savingsScale}
        rank={rank}
        showRank={showRank}
        focusRecId={focusRecId}
        {...(isFlagship === undefined ? {} : { isFlagship })}
        {...(onDismissFocus === undefined ? {} : { onDismissFocus })}
        {...(onDismiss === undefined ? {} : { onDismiss })}
        {...(onAdopt === undefined ? {} : { onAdopt })}
        {...(onEffectMutated === undefined ? {} : { onEffectMutated })}
      />
    );
  }
  if (rec === undefined) return null;
  return (
    <SingleRecCard
      rec={rec}
      savingsScale={savingsScale}
      rank={rank}
      showRank={showRank}
      showSessionRows
      focusRecId={focusRecId}
      defaultFolded={defaultFolded}
      {...(isFlagship === undefined ? {} : { isFlagship })}
      {...(onDismissFocus === undefined ? {} : { onDismissFocus })}
      {...(onDismiss === undefined ? {} : { onDismiss })}
      {...(onAdopt === undefined ? {} : { onAdopt })}
      {...(onEffectMutated === undefined ? {} : { onEffectMutated })}
    />
  );
}
