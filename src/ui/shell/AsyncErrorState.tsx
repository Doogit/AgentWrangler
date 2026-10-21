/**
 * Reader-safe presentation for a failed async resource.
 *
 * This component deliberately owns neither the request nor retry policy. Its
 * callers use this closed copy catalog and supply the resource-scoped
 * callback; exception text, response bodies, and local paths cannot become
 * reader-facing copy.
 */

const RESOURCE_COPY = {
  "route-page": { heading: "Could not load this page.", retry: "Retry page" },
  kpis: { heading: "Could not load this period's totals.", retry: "Retry totals" },
  trends: { heading: "Could not load trends.", retry: "Retry trends" },
  "usage-limits": { heading: "Could not load usage limits.", retry: "Retry usage limits" },
  "expensive-sessions": {
    heading: "Could not load this week's expensive sessions.",
    retry: "Retry expensive sessions",
  },
  "across-dashboard": {
    heading: "Could not load the dashboard summary.",
    retry: "Retry summary",
  },
  "context-per-turn": {
    heading: "Could not load context per turn.",
    retry: "Retry context per turn",
  },
  "token-breakdown": {
    heading: "Could not load the token breakdown.",
    retry: "Retry token breakdown",
  },
  "live-sessions": { heading: "Could not load live sessions.", retry: "Retry live sessions" },
  "data-notes": { heading: "Could not load data notes.", retry: "Retry data notes" },
  workspaces: { heading: "Could not load workspaces.", retry: "Retry workspaces" },
  sessions: { heading: "Could not load sessions.", retry: "Retry sessions" },
  "session-detail": { heading: "Could not load this session.", retry: "Retry session" },
  "judge-setup": { heading: "Could not load the setup grade.", retry: "Retry setup grade" },
  recommendations: {
    heading: "Could not load recommendations.",
    retry: "Retry recommendations",
  },
  practices: { heading: "Could not load practices.", retry: "Retry practices" },
  "impact-ledger": { heading: "Could not load the impact ledger.", retry: "Retry impact ledger" },
  "workspace-detail-sessions": {
    heading: "Could not load workspace sessions.",
    retry: "Retry workspace sessions",
  },
  "context-composition": {
    heading: "Could not load context composition.",
    retry: "Retry context composition",
  },
  outcomes: { heading: "Could not load outcomes.", retry: "Retry outcomes" },
  "delivery-metrics": {
    heading: "Could not load delivery metrics.",
    retry: "Retry delivery metrics",
  },
  "closure-proxy": { heading: "Could not load closure data.", retry: "Retry closure data" },
  "cost-per-delivered-outcome": {
    heading: "Could not load cost per delivered outcome.",
    retry: "Retry cost per delivered outcome",
  },
} as const;

const ACTION_COPY = {
  retry: null,
  "reload-dashboard": "Reload dashboard",
} as const;

export type AsyncErrorResourceId = keyof typeof RESOURCE_COPY;
export type AsyncErrorActionId = keyof typeof ACTION_COPY;

export interface AsyncErrorStateProps {
  /** Closed identifier for reader-facing resource copy. */
  resource: AsyncErrorResourceId;
  /** The owning resource loader's retry callback. */
  onRetry: () => void;
  /** Closed recovery action; retry is the default. */
  action?: AsyncErrorActionId;
  /** Optional opaque code; raw errors, response bodies, and paths are invalid. */
  technicalDetail?: string;
}

/** Keep disclosed detail opaque, bounded, and incapable of carrying a path/body. */
export function sanitizeTechnicalDetail(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(normalized) ? normalized : null;
}

function getResourceCopy(
  resource: AsyncErrorResourceId,
): (typeof RESOURCE_COPY)[AsyncErrorResourceId] {
  if (!Object.hasOwn(RESOURCE_COPY, resource)) {
    return RESOURCE_COPY["route-page"];
  }

  return RESOURCE_COPY[resource];
}

function getActionCopy(action: AsyncErrorActionId | undefined, retryCopy: string): string {
  const actionId = action ?? "retry";

  if (!Object.hasOwn(ACTION_COPY, actionId)) {
    return retryCopy;
  }

  return ACTION_COPY[actionId] ?? retryCopy;
}

export default function AsyncErrorState({
  resource,
  onRetry,
  action,
  technicalDetail,
}: AsyncErrorStateProps) {
  const copy = getResourceCopy(resource);
  const safeTechnicalDetail = sanitizeTechnicalDetail(technicalDetail);

  return (
    <section className="async-error-state" role="alert">
      <h2>{copy.heading}</h2>
      <p>Check that the local daemon is available, then try again.</p>
      <button type="button" className="btn-primary" onClick={onRetry}>
        {getActionCopy(action, copy.retry)}
      </button>
      {safeTechnicalDetail !== null && (
        <details className="async-error-state-details">
          <summary>Technical details</summary>
          <p>Failure code: {safeTechnicalDetail}</p>
        </details>
      )}
    </section>
  );
}
