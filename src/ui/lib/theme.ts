/**
 * src/ui/lib/theme.ts — explicit light/dark theme with localStorage persistence.
 *
 * The dashboard ships dark by default (its only historical palette). An explicit user
 * choice is stored under THEME_KEY and reflected as `data-theme` on the document root,
 * where the styles.css light overrides pick it up. There is no OS-preference following:
 * the pre-toggle behavior (always dark) is preserved exactly when no choice is stored.
 */

export type Theme = "dark" | "light";

const THEME_KEY = "aw-theme";
const DEFAULT_THEME: Theme = "dark";

export function getStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // storage unavailable (private mode / disabled) — theme still applies for this session.
  }
}

/** Resolve the active theme (stored choice, else the dark default) and apply it to the root. */
export function initTheme(): Theme {
  const theme = getStoredTheme() ?? DEFAULT_THEME;
  applyTheme(theme);
  return theme;
}
