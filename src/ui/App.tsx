import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fetchGlobalOverview, isDaemonUnreachableError } from "./api/client";
import BriefsPage from "./briefs/BriefsPage";
import GlossaryPage from "./glossary/GlossaryPage";
import Sidebar from "./nav/Sidebar";
import OverviewPage from "./overview/OverviewPage";
import RecommendationsPage from "./recommendations/RecommendationsPage";
import HotSessionsPage from "./sessions/HotSessionsPage.js";
import SessionDetailPage from "./sessions/SessionDetailPage";
import SettingsPage from "./settings/SettingsPage";
import WorkspaceDetailPage from "./workspaces/WorkspaceDetailPage";
import WorkspacesPage from "./workspaces/WorkspacesPage";

export type AppRoute =
  | "overview"
  | "briefs"
  | "recommendations"
  | "settings"
  | "workspaces"
  | "sessions"
  | "glossary"
  | "session-detail"
  | "workspace-detail";

interface ParsedRoute {
  route: AppRoute;
  sessionId: string | null;
  workspaceId: string | null;
}

function overviewRoute(): ParsedRoute {
  return { route: "overview", sessionId: null, workspaceId: null };
}

// Exported for testing.
export function parseHash(hash: string): ParsedRoute {
  // Strip query params before route matching — hash params like `#/recommendations?state=…`
  // must still resolve to the recommendations route. RV5 and later routes may carry params.
  const qIdx = hash.indexOf("?");
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);

  const sessionMatch = /^#\/sessions\/([^/?]+)$/.exec(path);
  if (sessionMatch?.[1] !== undefined) {
    try {
      return {
        route: "session-detail",
        sessionId: decodeURIComponent(sessionMatch[1]),
        workspaceId: null,
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
      };
    } catch {
      return overviewRoute();
    }
  }

  switch (path) {
    case "#/overview":
      return overviewRoute();
    case "#/briefs":
      return { route: "briefs", sessionId: null, workspaceId: null };
    case "#/recommendations":
      return { route: "recommendations", sessionId: null, workspaceId: null };
    case "#/workspaces":
      return { route: "workspaces", sessionId: null, workspaceId: null };
    case "#/settings":
      return { route: "settings", sessionId: null, workspaceId: null };
    case "#/sessions":
      return { route: "sessions", sessionId: null, workspaceId: null };
    case "#/glossary":
      return { route: "glossary", sessionId: null, workspaceId: null };
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

export default function App() {
  const [connectionState, setConnectionState] = useState<"ready" | "unreachable">("ready");
  const [retryCount, setRetryCount] = useState(0);
  const hash = useSyncExternalStore(subscribeToHashChanges, getHashSnapshot, getServerHashSnapshot);
  const { route, sessionId, workspaceId } = parseHash(hash);
  const backTargetRef = useRef<string>("#/overview");
  useEffect(() => {
    if (route !== "session-detail" && route !== "workspace-detail") {
      backTargetRef.current = hash || "#/overview";
    }
  }, [hash, route]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCount is a deliberate re-trigger nonce for the Retry button, not read in the body.
  useEffect(() => {
    let active = true;

    void fetchGlobalOverview({ preset: "7d" })
      .then(() => {
        if (active) setConnectionState("ready");
      })
      .catch((error: unknown) => {
        if (active) setConnectionState(isDaemonUnreachableError(error) ? "unreachable" : "ready");
      });

    return () => {
      active = false;
    };
  }, [retryCount]);

  if (connectionState === "unreachable") {
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
          <p>Start it from this project, then try again:</p>
          <code className="daemon-unreachable-command">npm run daemon</code>
          <button
            type="button"
            className="btn-primary daemon-unreachable-retry"
            onClick={() => {
              setConnectionState("ready");
              setRetryCount((count) => count + 1);
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

  const closeSession = () => {
    window.location.hash = backTargetRef.current;
  };

  // Show workspaces nav item as active for the workspace-detail route too.
  const sidebarActive: AppRoute = route === "workspace-detail" ? "workspaces" : route;

  return (
    <div className="shell">
      <Sidebar active={sidebarActive} onNavigate={navigate} />
      <div className="main-content">
        {route === "overview" && <OverviewPage onSelectSession={openSession} />}
        {route === "briefs" && <BriefsPage />}
        {route === "recommendations" && <RecommendationsPage />}
        {route === "settings" && <SettingsPage />}
        {route === "workspaces" && <WorkspacesPage />}
        {route === "sessions" && <HotSessionsPage onSelectSession={openSession} />}
        {route === "glossary" && <GlossaryPage />}
        {route === "session-detail" && sessionId !== null && (
          <SessionDetailPage sessionId={sessionId} onBack={closeSession} />
        )}
        {route === "workspace-detail" && workspaceId !== null && (
          <WorkspaceDetailPage workspaceId={workspaceId} onBack={closeSession} />
        )}
      </div>
    </div>
  );
}
