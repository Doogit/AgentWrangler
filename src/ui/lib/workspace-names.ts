import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSummary } from "../../query/api/overview";
import { fetchWorkspaces } from "../api/client";
import { workspaceLabel } from "./workspace-label";

let workspaceNamesPromise: Promise<Map<string, WorkspaceSummary>> | undefined;

function loadWorkspaceNames(): Promise<Map<string, WorkspaceSummary>> {
  // 30d is the widest canned window the API accepts; workspaces idle longer
  // than that fall back to the raw-slug label. Promise.resolve tolerates a
  // stubbed client whose fetchWorkspaces returns undefined.
  workspaceNamesPromise ??= Promise.resolve(fetchWorkspaces({ preset: "30d" })).then((response) => {
    const workspaces = response?.data?.items ?? [];
    return new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  });
  return workspaceNamesPromise;
}

/** Resolve workspace IDs to the same owner/name labels used by the Workspaces page. */
export function useWorkspaceNames(): { labelFor: (workspaceId: string) => string } {
  const [workspaces, setWorkspaces] = useState<Map<string, WorkspaceSummary> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadWorkspaceNames()
      .then((names) => {
        if (!cancelled) setWorkspaces(names);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const labelFor = useCallback(
    (workspaceId: string): string =>
      workspaceLabel(workspaces?.get(workspaceId) ?? { workspace_id: workspaceId }),
    [workspaces],
  );

  return { labelFor };
}

/** Test-only cache reset so each mock response is independently exercised. */
export function __resetWorkspaceNamesCache(): void {
  workspaceNamesPromise = undefined;
}
