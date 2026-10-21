/**
 * src/ui/nav/Sidebar.tsx — Main navigation sidebar.
 *
 * WP4 surface (Settings) is disabled here until that work package lands.
 * WP5 surfaces (Workspaces, Recommendations) are similarly disabled.
 */

import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { AppRoute } from "../App";
import { useStatusPoller } from "../api/status-poller";
import { relativeTime } from "../lib/relative-time";
import { type Theme, setTheme } from "../lib/theme";

interface SidebarProps {
  active: AppRoute;
  onNavigate: (route: AppRoute) => void;
}

const NAV_GROUPS = [
  {
    label: "Observe",
    routes: [
      { route: "overview", label: "Overview" },
      { route: "workspaces", label: "Workspaces" },
      { route: "sessions", label: "Sessions" },
    ],
  },
  {
    label: "Analyze",
    routes: [
      { route: "judge-setup", label: "Rate my setup" },
      { route: "diagnostics", label: "Usage patterns" },
      { route: "recommendations", label: "Recommendations" },
    ],
  },
  {
    label: "Configure",
    routes: [{ route: "settings", label: "Settings" }],
  },
] as const satisfies ReadonlyArray<{
  label: string;
  routes: ReadonlyArray<{
    route: AppRoute;
    label: string;
  }>;
}>;

function isRouteActive(active: AppRoute, route: AppRoute): boolean {
  if (route === "sessions" && active === "session-detail") return true;
  if (route === "workspaces" && active === "workspace-detail") return true;
  return active === route;
}

function isNativeModifiedClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

export default function Sidebar({ active, onNavigate }: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navigate = (route: AppRoute) => {
    setMenuOpen(false);
    onNavigate(route);
  };
  const handleRouteClick = (event: ReactMouseEvent<HTMLAnchorElement>, route: AppRoute) => {
    if (event.defaultPrevented || isNativeModifiedClick(event)) return;
    navigate(route);
  };
  // The shared status poller (P2-U5): connected/last check come from its last poll.
  const { connected, fetchedAt: lastFetchedAt } = useStatusPoller();
  const [theme, setThemeState] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  const [, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !navRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [menuOpen]);

  const statusLabel =
    connected === false ? "Unreachable" : connected === true ? "Connected" : "Checking";
  return (
    <nav
      ref={navRef}
      className="sidebar"
      aria-label="Main navigation"
      onKeyDown={(event) => {
        if (event.key === "Escape" && menuOpen) {
          setMenuOpen(false);
          toggleRef.current?.focus();
        }
      }}
    >
      {/* biome-ignore lint/a11y/useValidAnchor: this is a real destination in the app's hash router. */}
      <a
        className="brand"
        href="#/overview"
        onClick={(event) => handleRouteClick(event, "overview")}
      >
        <img
          src="/media/Agent-Wrangler-Logo@2x.png"
          srcSet="/media/Agent-Wrangler-Logo@4x.png 2x"
          width={100}
          height={100}
          alt=""
        />
        <b>AgentWrangler</b>
      </a>
      <button
        ref={toggleRef}
        type="button"
        className="mobile-nav-toggle"
        aria-expanded={menuOpen}
        aria-controls="main-navigation-links"
        onClick={() => {
          if (menuOpen) {
            setMenuOpen(false);
            toggleRef.current?.focus();
            return;
          }
          setMenuOpen(true);
        }}
      >
        {menuOpen ? "Close menu" : "Menu"}
      </button>
      <div id="main-navigation-links" className={`sidebar-links${menuOpen ? " is-open" : ""}`}>
        <div className="nav-groups">
          {NAV_GROUPS.map((group) => {
            const headingId = `sidebar-${group.label.toLowerCase()}-heading`;
            return (
              <section key={group.label} className="nav-group" aria-labelledby={headingId}>
                <h2 id={headingId} className="nav-group-title">
                  {group.label}
                </h2>
                <ul className="nav-list">
                  {group.routes.map((item) => {
                    const current = isRouteActive(active, item.route);
                    return (
                      <li key={item.route}>
                        <a
                          className={`nav-link${current ? " active" : ""}`}
                          href={`#/${item.route}`}
                          onClick={(event) => handleRouteClick(event, item.route)}
                          aria-current={current ? "page" : undefined}
                        >
                          {item.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
        <div className="nav-utilities">
          {/* biome-ignore lint/a11y/useValidAnchor: native destination in the hash router. */}
          <a
            className={`nav-link nav-link-small${active === "help" ? " active" : ""}`}
            href="#/help"
            onClick={(event) => handleRouteClick(event, "help")}
            aria-current={active === "help" ? "page" : undefined}
          >
            Help
          </a>
          {/* biome-ignore lint/a11y/useValidAnchor: this is a real destination in the app's hash router. */}
          <a
            className={`nav-link nav-link-small${active === "glossary" ? " active" : ""}`}
            href="#/glossary"
            onClick={(event) => handleRouteClick(event, "glossary")}
            aria-current={active === "glossary" ? "page" : undefined}
          >
            How to read this dashboard
          </a>
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
      </div>
    </nav>
  );
}
