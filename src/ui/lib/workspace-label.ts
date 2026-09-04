export type WorkspaceLabelInput = {
  workspace_id?: string | null;
  repo_owner?: string | null;
  repo_name?: string | null;
  repo_path?: string | null;
  repo_canonical?: string | null;
};

/**
 * Return a human-readable workspace label.
 *
 * The `__global__` sentinel is handled first. Otherwise, the three-level
 * fallback is canonical owner/name, the final non-empty repo_path segment,
 * and finally the raw workspace_id slug.
 */
export function workspaceLabel(ws: WorkspaceLabelInput): string {
  if (ws.workspace_id === "__global__" || ws.repo_path === "__global__") {
    return "Global";
  }

  if (ws.repo_owner != null && ws.repo_name != null) {
    return ws.repo_canonical ?? `${ws.repo_owner}/${ws.repo_name}`;
  }

  if (typeof ws.repo_path === "string" && ws.repo_path.length > 0) {
    const repoFolder = ws.repo_path.split(/[\\/]/).filter(Boolean).pop();
    if (repoFolder) {
      return repoFolder;
    }
  }

  return ws.workspace_id ?? "";
}
