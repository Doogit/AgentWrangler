import type { WindowFilter } from "../../query/api/overview";

export type WorkspaceScope = "24h" | "7d" | "30d" | "all";

export function detailScope(hash: string): WorkspaceScope {
  const value = new URLSearchParams(hash.split("?")[1] ?? "").get("window");
  return value === "24h" || value === "30d" || value === "all" ? value : "7d";
}

export function scopeFilter(scope: WorkspaceScope): WindowFilter {
  return scope === "all" ? { from: "1970-01-01T00:00:00.000Z" } : { preset: scope };
}

export function scopedHash(path: string, scope: WorkspaceScope, source: string): string {
  const params = new URLSearchParams(source.split("?")[1] ?? "");
  params.set("window", scope);
  return `${path}?${params}`;
}

export function subscribeToScope(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function currentHash(): string {
  return window.location.hash;
}

/** Only workspace detail routes emitted by this UI are accepted as reload return targets. */
export function workspaceReturnTarget(hash: string): string | null {
  const target = new URLSearchParams(hash.split("?")[1] ?? "").get("returnTo");
  if (target === null || !/^#\/workspaces\/[^/?#]+(?:\?[^#]*)?$/.test(target)) return null;
  try {
    decodeURIComponent(target.split("?")[0]?.slice("#/workspaces/".length) ?? "");
  } catch {
    return null;
  }
  return target;
}
