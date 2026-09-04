/**
 * src/ui/overview/LiveStrip.tsx — Live sessions strip.
 *
 * Contract:
 *   - LIVE sessions get an orange left-border (.live-row-live).
 *   - RECONCILED sessions (state change) get no accent (.live-row-reconciled).
 *     LiveSessionRow is always LIVE by API contract, so all rows use live-row-live.
 *   - Container is aria-live="polite" so screen readers announce updates.
 *   - Loading (skeleton) ≠ empty (no sessions) ≠ error — three distinct states.
 *
 * Running cost is list-equiv (micro-USD → USD). Context is raw token count.
 */

import { useEffect, useState } from "react";
import type { LiveSessionRow } from "../../query/api/overview";
import { type WorkspaceLabelInput, workspaceLabel } from "../lib/workspace-label";
import Chip from "../shell/Chip";
import EmptyState from "../shell/EmptyState";
import { SkeletonBlock } from "../shell/Skeleton";

type MappableLiveSessionRow = LiveSessionRow & WorkspaceLabelInput;

interface LiveStripProps {
  sessions: MappableLiveSessionRow[];
  isLoading: boolean;
  isPending?: boolean;
  error: string | null;
  lastFetchedAt?: number | undefined;
  onSelectSession?: ((sessionId: string) => void) | undefined;
}

function fmtRunningCost(u: number): string {
  const usd = u / 1_000_000;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function fmtCtx(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

function fmtModel(m: string): string {
  // "claude-opus-5" → "Opus 5"
  const stripped = m.replace("claude-", "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function fmtStarted(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function labelWorkspace(session: MappableLiveSessionRow): string {
  return workspaceLabel({
    workspace_id: session.workspace_id,
    repo_owner: session.repo_owner ?? null,
    repo_name: session.repo_name ?? null,
    repo_path: session.repo_path ?? null,
    repo_canonical: session.repo_canonical ?? null,
  });
}

function formatFreshness(lastFetchedAt: number | undefined, now: number): string | null {
  if (lastFetchedAt === undefined) return null;
  return `updated ${Math.max(0, Math.floor((now - lastFetchedAt) / 1_000))}s ago`;
}

export default function LiveStrip({
  sessions,
  isLoading,
  isPending = false,
  error,
  lastFetchedAt,
  onSelectSession,
}: LiveStripProps) {
  const count = sessions.length;
  const [now, setNow] = useState(() => Date.now());
  const freshness = formatFreshness(lastFetchedAt, now);

  useEffect(() => {
    if (lastFetchedAt === undefined) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [lastFetchedAt]);

  return (
    <div className="live-strip-wrap">
      <div className="live-strip">
        <div className="live-strip-head">
          <span>
            <span className={`live-dot${count > 0 ? " on" : ""}`} aria-hidden="true" />
            LIVE ({count})
          </span>
          <span className="live-strip-freshness">
            {freshness === null ? "freshness ≤30 s" : freshness}
          </span>
        </div>

        {/* aria-live="polite" so screen readers announce additions/removals */}
        <div aria-live="polite" aria-label="Live sessions">
          {isLoading && <SkeletonBlock height={48} />}

          {!isPending && !isLoading && error !== null && (
            <div className="empty-state">
              <span className="empty-state-icon" aria-hidden="true">
                ⚠
              </span>
              <span className="empty-state-text">Live session data unavailable — will retry</span>
            </div>
          )}

          {!isPending && !isLoading && error === null && count === 0 && (
            <div className="live-strip-empty">
              <EmptyState
                headline="No active sessions"
                why="The daemon is connected, but no observed Claude Code session is running."
                whatWillAppear="Live cost, context, and model aggregates will appear while a session is active."
                command="claude"
              />
            </div>
          )}

          {!isPending && !isLoading && error === null && count > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Running cost</th>
                  <th>Context</th>
                  <th>Model</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((sess) => (
                  <tr key={sess.session_id} className="live-row-live">
                    <td>
                      {onSelectSession === undefined ? (
                        labelWorkspace(sess)
                      ) : (
                        <button
                          type="button"
                          className="live-session-link"
                          onClick={() => onSelectSession(sess.session_id)}
                        >
                          {labelWorkspace(sess)}
                        </button>
                      )}
                    </td>
                    <td>
                      {fmtRunningCost(sess.running_usd_u)} <Chip kind="LIVE" label="LIVE" />
                    </td>
                    <td>{fmtCtx(sess.current_context_tokens)}</td>
                    <td>{fmtModel(sess.model)}</td>
                    <td>{fmtStarted(sess.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
