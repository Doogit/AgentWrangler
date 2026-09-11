import { useCallback, useEffect, useState } from "react";
import type { WorkspaceNameRow } from "../../query/api/overview";
import { fetchWorkspaceNames } from "../api/client";
import { workspaceLabel } from "./workspace-label";

let workspaceNamesPromise: Promise<Map<string, WorkspaceNameRow>> | undefined;

function loadWorkspaceNames(): Promise<Map<string, WorkspaceNameRow>> {
  // /api/workspace-names is unwindowed, so workspaces idle beyond the widest
  // canned window (30d) still resolve friendly labels (UIR-8). Promise.resolve
  // tolerates a stubbed client whose fetchWorkspaceNames returns undefined.
  workspaceNamesPromise ??= Promise.resolve(fetchWorkspaceNames())
    .then((rows) => {
      return new Map((rows ?? []).map((row) => [row.workspace_id, row]));
    })
    .catch((err: unknown) => {
      // Don't cache a rejection: the next mount retries instead of rendering
      // raw slugs for the rest of the page session.
      workspaceNamesPromise = undefined;
      throw err;
    });
  return workspaceNamesPromise;
}

/** Resolve workspace IDs to the same owner/name labels used by the Workspaces page. */
export function useWorkspaceNames(): { labelFor: (workspaceId: string) => string } {
  const [workspaces, setWorkspaces] = useState<Map<string, WorkspaceNameRow> | null>(null);

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
