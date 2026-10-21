import { lazy, useEffect, useRef, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import { pollStatusNow, useStatusPoller } from "./api/status-poller";
import HelpPage from "./help/HelpPage";
import Sidebar from "./nav/Sidebar";
import LoadBoundary from "./shell/LoadBoundary";
import PipelineStatusBar from "./shell/PipelineStatusBar";
import StatusChip from "./shell/StatusChip";
import { detailScope, scopedHash, workspaceReturnTarget } from "./workspaces/workspace-scope";

const DiagnosticsPage = lazy(() => import("./diagnostics/DiagnosticsPage"));
const GlossaryPage = lazy(() => import("./glossary/GlossaryPage"));
const JudgeSetupPage = lazy(() => import("./judge-setup/JudgeSetupPage"));
const OverviewPage = lazy(() => import("./overview/OverviewPage"));
const RecommendationsPage = lazy(() => import("./recommendations/RecommendationsPage"));
const HotSessionsPage = lazy(() => import("./sessions/HotSessionsPage.js"));
const SessionDetailPage = lazy(() => import("./sessions/SessionDetailPage"));
const SettingsPage = lazy(() => import("./settings/SettingsPage"));
const WorkspaceDetailPage = lazy(() => import("./workspaces/WorkspaceDetailPage"));
const WorkspacesPage = lazy(() => import("./workspaces/WorkspacesPage"));

export type AppRoute =
  | "overview"
  | "judge-setup"
  | "diagnostics"
  | "recommendations"
  | "settings"
  | "workspaces"
  | "sessions"
  | "help"
  | "glossary"
  | "session-detail"
  | "workspace-detail";

interface ParsedRoute {
  route: AppRoute;
  sessionId: string | null;
  workspaceId: string | null;
  anchorMessageId: string | null;
  anchorTurnIndex: number | null;
}

function overviewRoute(): ParsedRoute {
  return {
    route: "overview",
    sessionId: null,
    workspaceId: null,
    anchorMessageId: null,
    anchorTurnIndex: null,
  };
}

// Exported for testing.
export function parseHash(hash: string): ParsedRoute {
  // Strip query params before route matching — hash params like `#/recommendations?state=…`
  // must still resolve to the recommendations route. RV5 and later routes may carry params.
  const qIdx = hash.indexOf("?");
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);
  const params = new URLSearchParams(qIdx === -1 ? "" : hash.slice(qIdx + 1));
  const anchorMessageId = params.get("anchor");
  const turnParam = params.get("turn");
  const requestedTurn = turnParam === null || turnParam.trim() === "" ? null : Number(turnParam);
  const anchorTurnIndex =
    requestedTurn !== null && Number.isInteger(requestedTurn) && requestedTurn >= 0
      ? requestedTurn
      : null;

  const sessionMatch = /^#\/sessions\/([^/?]+)$/.exec(path);
  if (sessionMatch?.[1] !== undefined) {
    try {
      return {
        route: "session-detail",
        sessionId: decodeURIComponent(sessionMatch[1]),
        workspaceId: null,
        anchorMessageId,
        anchorTurnIndex,
      };
    } catch {
      return overviewRoute();
    }
  }

  const wsDetailMatch = /^#\/workspaces\/([^/?]+)$/.exec(path);
  if (wsDetailMatch?.[1] !== undefined) {
    try {
      return {
        route: "workspace-detail",
        sessionId: null,
        workspaceId: decodeURIComponent(wsDetailMatch[1]),
        anchorMessageId: null,
        anchorTurnIndex: null,
      };
    } catch {
      return overviewRoute();
    }
  }

  switch (path) {
    case "#/overview":
      return overviewRoute();
    case "#/judge-setup":
    case "#/briefs": // retired tab; App rewrites the hash to #/judge-setup
      return {
        route: "judge-setup",
        sessionId: null,
        workspaceId: null,
        anchorMessageId: null,
        anchorTurnIndex: null,
      };
    case "#/diagnostics":
      return {
        route: "diagnostics",
        sessionId: null,
        workspaceId: null,
        anchorMessageId: null,
        anchorTurnIndex: null,
      };
    case "#/recommendations":
      return {
        route: "recommendations",
        sessionId: null,
        workspaceId: null,
        anchorMessageId: null,
        anchorTurnIndex: null,
      };
    case "#/workspaces":
      return {
        route: "workspaces",
        sessionId: null,
        workspaceId: null,
        anchorMessageId: null,
        anchorTurnIndex: null,
      };
    case "#/settings":
      return {
        route: "settings",
        sessionId: null,
        workspaceId: null,
        anchorMessageId: null,
        anchorTurnIndex: null,
      };
    case "#/sessions":
      return {
        route: "sessions",
        sessionId: null,
        workspaceId: null,
        anchorMessageId: null,
        anchorTurnIndex: null,
      };
    case "#/help":
      return { ...overviewRoute(), route: "help" };
    case "#/glossary":
      return {
        route: "glossary",
        sessionId: null,
        workspaceId: null,
        anchorMessageId: null,
        anchorTurnIndex: null,
      };
    default:
      return overviewRoute();
  }
}

function subscribeToHashChanges(onStoreChange: () => void): () => void {
  window.addEventListener("hashchange", onStoreChange);
  return () => window.removeEventListener("hashchange", onStoreChange);
}

function getHashSnapshot(): string {
  return window.location.hash;
}

function getServerHashSnapshot(): string {
  return "";
}

function RouteFocusOnCommit({
  mainRef,
  routeKey,
  shouldFocus,
}: {
  mainRef: RefObject<HTMLElement | null>;
  routeKey: string;
  shouldFocus: boolean;
}) {
  useEffect(() => {
    if (!shouldFocus || routeKey !== window.location.hash.split("?")[0]) return;

    const main = mainRef.current;
    const target = main?.querySelector<HTMLElement>("h1") ?? main;
    if (target === null || target === undefined) return;
    target.tabIndex = -1;
    target.focus();
  }, [mainRef, routeKey, shouldFocus]);

  return null;
}

export default function App() {
  const hash = useSyncExternalStore(subscribeToHashChanges, getHashSnapshot, getServerHashSnapshot);
  const routeFocusKey = hash.split("?")[0] ?? "";
  const { route, sessionId, workspaceId, anchorMessageId, anchorTurnIndex } = parseHash(hash);
  const backTargetRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const initialHashRef = useRef(hash);
  const routeTransitionSeenRef = useRef(false);
  if (routeFocusKey !== initialHashRef.current.split("?")[0]) {
    routeTransitionSeenRef.current = true;
  }
  useEffect(() => {
    if (route !== "session-detail" && route !== "workspace-detail") {
      backTargetRef.current = hash || "#/overview";
    }
  }, [hash, route]);

  // The Briefs tab became "Judge my setup": rewrite old #/briefs links in place.
  useEffect(() => {
    if (hash.split("?")[0] !== "#/briefs") return;
    window.history.replaceState(null, "", "#/judge-setup");
    window.dispatchEvent(new Event("hashchange"));
  }, [hash]);

  // P1-U5: the shell paints before the daemon is ready, so the pre-JS overlay goes on the
  // first commit, not on first data. reveal() is a no-op once dismissed.
  useEffect(() => {
    window.__awBoot?.reveal();
  }, []);

  // Daemon unreachability comes from the shared status poller (P2-U5), so every route — not
  // only the Overview — sees it. A tab that was connected first shows the quiet paused notice;
  // the full card replaces the page only after ~60 s of failures (or if it never connected).
  const { paused, unreachable } = useStatusPoller();

  if (unreachable && route !== "help") {
    return (
      <main className="daemon-unreachable" aria-labelledby="daemon-unreachable-title">
        <section className="daemon-unreachable-card">
          <div className="daemon-unreachable-brand" aria-label="AgentWrangler">
            <span className="daemon-unreachable-mark" aria-hidden="true">
              AW
            </span>
            <span>AgentWrangler</span>
          </div>
          <h1 id="daemon-unreachable-title">Local daemon unavailable</h1>
          <p>The dashboard cannot reach the AgentWrangler daemon on this computer.</p>
          <p>
            <a href="#/help?topic=troubleshooting&section=daemon">Open recovery Help</a>
          </p>
          <p>For an npm installation, start the installed command or use npx:</p>
          <code className="daemon-unreachable-command">agentwrangler</code>
          <code className="daemon-unreachable-command">npx agentwrangler@latest</code>
          <p>From a source checkout with dependencies installed:</p>
          <code className="daemon-unreachable-command">npm run daemon</code>
          <button
            type="button"
            className="btn-primary daemon-unreachable-retry"
            onClick={() => {
              // The status poller keeps running and clears this card on its own; Retry asks now.
              pollStatusNow();
            }}
          >
            Retry connection
          </button>
        </section>
      </main>
    );
  }

  const navigate = (nextRoute: AppRoute) => {
    if (nextRoute !== "session-detail" && nextRoute !== "workspace-detail") {
      window.location.hash = `#/${nextRoute}`;
    }
  };

  const openSession = (sessionId: string) => {
    window.location.hash = `#/sessions/${encodeURIComponent(sessionId)}`;
  };

  const workspaceBack = () => {
    const origin = backTargetRef.current;
    if (origin !== null && origin.split("?")[0] !== "#/workspaces") return origin;
    // The list offers 7d/30d/all; retain its origin for the legacy detail-only 24h control.
    const scope = detailScope(hash);
    if (scope === "24h" && origin !== null) return origin;
    return scopedHash("#/workspaces", scope === "24h" ? "7d" : scope, origin ?? hash);
  };
  const backTarget =
    route === "workspace-detail"
      ? workspaceBack()
      : (workspaceReturnTarget(hash) ?? backTargetRef.current ?? "#/sessions");
  const closeSession = () => {
    window.location.hash = backTarget;
  };
  const backLabel =
    [
      ["#/sessions", "Back to sessions"],
      ["#/diagnostics", "Back to usage patterns"],
      ["#/overview", "Back to overview"],
      ["#/workspaces", "Back to workspaces"],
      ["#/recommendations", "Back to recommendations"],
    ].find(([prefix]) => prefix !== undefined && backTarget.startsWith(prefix))?.[1] ?? "Back";

  // Show workspaces nav item as active for the workspace-detail route too.
  const sidebarActive: AppRoute =
    route === "workspace-detail" ? "workspaces" : route === "session-detail" ? "sessions" : route;

  return (
    <div className="shell">
      {/* biome-ignore lint/a11y/useValidAnchor: the hash router requires preserving the current route while focusing this in-page target. */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <Sidebar active={sidebarActive} onNavigate={navigate} />
      <main ref={mainRef} id="main-content" className="main-content" tabIndex={-1}>
        <div className="shell-topline">
          <StatusChip />
          {paused && <output className="live-paused">Live updates paused — reconnecting</output>}
          {route !== "help" && route !== "glossary" && (
            <p className="help-context">
              <a href={`#/help?topic=${sidebarActive}`}>Help with this page</a>
            </p>
          )}
        </div>
        <LoadBoundary key={route} label="page">
          {route === "help" && <HelpPage hash={hash} />}
          {route === "overview" && <OverviewPage onSelectSession={openSession} />}
          {route === "judge-setup" && <JudgeSetupPage />}
          {route === "diagnostics" && <DiagnosticsPage />}
          {route === "recommendations" && <RecommendationsPage />}
          {route === "settings" && <SettingsPage />}
          {route === "workspaces" && <WorkspacesPage />}
          {route === "sessions" && <HotSessionsPage onSelectSession={openSession} />}
          {route === "glossary" && <GlossaryPage />}
          {route === "session-detail" && sessionId !== null && (
            <SessionDetailPage
              sessionId={sessionId}
              onBack={closeSession}
              backLabel={backLabel}
              anchorMessageId={anchorMessageId}
              anchorTurnIndex={anchorTurnIndex}
            />
          )}
          {route === "workspace-detail" && workspaceId !== null && (
            <WorkspaceDetailPage workspaceId={workspaceId} onBack={closeSession} />
          )}
          <RouteFocusOnCommit
            mainRef={mainRef}
            routeKey={routeFocusKey}
            shouldFocus={route !== "help" && routeTransitionSeenRef.current}
          />
        </LoadBoundary>
      </main>
      <PipelineStatusBar />
    </div>
  );
}
