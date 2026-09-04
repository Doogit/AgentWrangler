/**
 * src/ui/nav/Sidebar.tsx — Main navigation sidebar.
 *
 * WP4 surface (Settings) is disabled here until that work package lands.
 * WP5 surfaces (Workspaces, Recommendations) are similarly disabled.
 */

import { useEffect, useState } from "react";
import type { AppRoute } from "../App";
import { fetchStatus, getLastFetchTimestamp } from "../api/client";
import { relativeTime } from "../lib/relative-time";
import { type Theme, setTheme } from "../lib/theme";

interface SidebarProps {
  active: AppRoute;
  onNavigate: (route: AppRoute) => void;
}

export default function Sidebar({ active, onNavigate }: SidebarProps) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | undefined>(() =>
    getLastFetchTimestamp("/api/status"),
  );
  const [theme, setThemeState] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  useEffect(() => {
    let activeRequest = true;
    void fetchStatus()
      .then(() => {
        if (!activeRequest) return;
        setConnected(true);
        setLastFetchedAt(getLastFetchTimestamp("/api/status"));
      })
      .catch(() => {
        if (activeRequest) setConnected(false);
      });
    return () => {
      activeRequest = false;
    };
  }, []);

  const statusLabel =
    connected === false ? "Unreachable" : connected === true ? "Connected" : "Checking";
  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="brand">
        <div className="brandmark" aria-hidden="true" />
        AgentWrangler
      </div>
      <p className="navgroup">Observe</p>
      <button
        type="button"
        className={`nav-btn${active === "overview" ? " active" : ""}`}
        onClick={() => onNavigate("overview")}
        aria-current={active === "overview" ? "page" : undefined}
      >
        Overview
      </button>
      <button
        type="button"
        className={`nav-btn${active === "workspaces" ? " active" : ""}`}
        onClick={() => onNavigate("workspaces")}
        aria-current={active === "workspaces" ? "page" : undefined}
      >
        Workspaces
        <span className="nav-badge chip-experimental" aria-label="EXPERIMENTAL">
          EXP
        </span>
      </button>
      <button
        type="button"
        className={`nav-btn${active === "sessions" ? " active" : ""}`}
        onClick={() => onNavigate("sessions")}
        aria-current={active === "sessions" ? "page" : undefined}
      >
        Sessions
      </button>
      <button
        type="button"
        className={`nav-btn${active === "recommendations" ? " active" : ""}`}
        onClick={() => onNavigate("recommendations")}
        aria-current={active === "recommendations" ? "page" : undefined}
      >
        Recommendations
      </button>
      <button
        type="button"
        className={`nav-btn${active === "briefs" ? " active" : ""}`}
        onClick={() => onNavigate("briefs")}
        aria-current={active === "briefs" ? "page" : undefined}
      >
        Briefs
      </button>
      <p className="navgroup">Configure</p>
      <button
        type="button"
        className={`nav-btn${active === "settings" ? " active" : ""}`}
        onClick={() => onNavigate("settings")}
        aria-current={active === "settings" ? "page" : undefined}
      >
        Settings
      </button>
      <button
        type="button"
        className={`nav-btn nav-btn-small${active === "glossary" ? " active" : ""}`}
        onClick={() => onNavigate("glossary")}
        aria-current={active === "glossary" ? "page" : undefined}
      >
        How to read this dashboard
      </button>
      <button
        type="button"
        className="theme-toggle"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      >
        {theme === "dark" ? "☀ Light theme" : "☾ Dark theme"}
      </button>
      <div className="sidebox" aria-label="Daemon status">
        <b style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            className="nav-dot"
            aria-hidden="true"
            style={{ background: connected === false ? "var(--red)" : "var(--green)" }}
          />
          Daemon {statusLabel}
        </b>
        <p className="sidebox-sub">{window.location.host}</p>
        <p className="sidebox-sub" title="Last successful daemon status fetch">
          Last ingest:{" "}
          {lastFetchedAt === undefined
            ? "not yet"
            : relativeTime(new Date(lastFetchedAt).toISOString())}
        </p>
      </div>
    </nav>
  );
}
