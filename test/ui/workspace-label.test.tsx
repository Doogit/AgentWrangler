import { describe, expect, it } from "vitest";
import { workspaceLabel } from "../../src/ui/lib/workspace-label";

describe("workspaceLabel", () => {
  it("uses the owner/name canonical label first", () => {
    expect(
      workspaceLabel({
        workspace_id: "C--Users-x-repo",
        repo_owner: "owner",
        repo_name: "repo",
      }),
    ).toBe("owner/repo");
  });

  it("falls back to the final repo path segment", () => {
    expect(
      workspaceLabel({
        workspace_id: "C--Users-x-repo",
        repo_owner: null,
        repo_name: null,
        repo_path: "C:/Users/x/Documents/GitHub/AgentWrangler",
      }),
    ).toBe("AgentWrangler");
  });

  it("falls back to the raw workspace slug", () => {
    expect(workspaceLabel({ workspace_id: "C--Users-x-repo" })).toBe("C--Users-x-repo");
  });

  it("labels the global workspace as Global", () => {
    expect(workspaceLabel({ workspace_id: "__global__" })).toBe("Global");
  });

  it("prefers repo_canonical over derived owner/name when both are present", () => {
    expect(
      workspaceLabel({
        workspace_id: "ws",
        repo_owner: "owner",
        repo_name: "repo",
        repo_canonical: "my-org/my-repo",
      }),
    ).toBe("my-org/my-repo");
  });

  it("prefers owner/repo label over repo_path folder when both are present", () => {
    expect(
      workspaceLabel({
        workspace_id: "ws",
        repo_owner: "owner",
        repo_name: "repo",
        repo_path: "C:/Users/x/Documents/GitHub/DifferentFolder",
      }),
    ).toBe("owner/repo");
  });

  it("returns empty string when workspace_id is absent", () => {
    expect(workspaceLabel({})).toBe("");
  });
});
