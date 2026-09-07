/**
 * src/ui/nav/Sidebar.tsx — Main navigation sidebar.
 *
 * WP4 surface (Settings) is disabled here until that work package lands.
 * WP5 surfaces (Workspaces, Recommendations) are similarly disabled.
 */

import { useEffect, useRef, useState } from "react";
import type { AppRoute } from "../App";
import { fetchStatus, getLastFetchTimestamp } from "../api/client";
import { relativeTime } from "../lib/relative-time";
import { type Theme, setTheme } from "../lib/theme";
import { useForegroundPoll } from "../lib/use-foreground-poll";

interface SidebarProps {
  active: AppRoute;
  onNavigate: (route: AppRoute) => void;
}

export default function Sidebar({ active, onNavigate }: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navigate = (route: AppRoute) => {
    setMenuOpen(false);
    onNavigate(route);
    if (window.matchMedia?.("(max-width: 800px)").matches) toggleRef.current?.focus();
  };
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

  useForegroundPoll(
    fetchStatus,
    30_000,
    () => {
      setConnected(true);
      setLastFetchedAt(getLastFetchTimestamp("/api/status"));
    },
    () => setConnected(false),
  );

  const [, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const statusLabel =
    connected === false ? "Unreachable" : connected === true ? "Connected" : "Checking";
  return (
    <nav
      className="sidebar"
      aria-label="Main navigation"
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen) {
          setMenuOpen(false);
          toggleRef.current?.focus();
        }
      }}
    >
      <div className="brand">
        <div className="brandmark" aria-hidden="true" />
        AgentWrangler
      </div>
      <button
        ref={toggleRef}
        type="button"
        className="mobile-nav-toggle"
        aria-expanded={menuOpen}
        aria-controls="main-navigation-links"
        onClick={() => setMenuOpen((open) => !open)}
      >
        {menuOpen ? "Close menu" : "Menu"}
      </button>
      <div id="main-navigation-links" className={`sidebar-links${menuOpen ? " is-open" : ""}`}>
        <p className="navgroup">Observe</p>
        <button
          type="button"
          className={`nav-btn${active === "overview" ? " active" : ""}`}
          onClick={() => navigate("overview")}
          aria-current={active === "overview" ? "page" : undefined}
        >
          Overview
        </button>
        <button
          type="button"
          className={`nav-btn${active === "workspaces" ? " active" : ""}`}
          onClick={() => navigate("workspaces")}
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
          onClick={() => navigate("sessions")}
          aria-current={active === "sessions" ? "page" : undefined}
        >
          Sessions
        </button>
        <button
          type="button"
          className={`nav-btn${active === "recommendations" ? " active" : ""}`}
          onClick={() => navigate("recommendations")}
          aria-current={active === "recommendations" ? "page" : undefined}
        >
          Recommendations
        </button>
        <button
          type="button"
          className={`nav-btn${active === "briefs" ? " active" : ""}`}
          onClick={() => navigate("briefs")}
          aria-current={active === "briefs" ? "page" : undefined}
        >
          Briefs
        </button>
        <p className="navgroup">Configure</p>
        <button
          type="button"
          className={`nav-btn${active === "settings" ? " active" : ""}`}
          onClick={() => navigate("settings")}
          aria-current={active === "settings" ? "page" : undefined}
        >
          Settings
        </button>
        <button
          type="button"
          className={`nav-btn nav-btn-small${active === "glossary" ? " active" : ""}`}
          onClick={() => navigate("glossary")}
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
            Last status check:{" "}
            {lastFetchedAt === undefined
              ? "not yet"
              : relativeTime(new Date(lastFetchedAt).toISOString())}
          </p>
        </div>
      </div>
    </nav>
  );
}
