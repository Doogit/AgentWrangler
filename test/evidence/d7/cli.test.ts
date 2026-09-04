import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { LoadedApprovedEvidenceInput } from "../../../src/evidence/common/approved-input.js";
import { runD7CoverageCli } from "../../../src/evidence/d7/cli.js";

const base = [
  "--approval-manifest",
  "approval.json",
  "--approval-sha256",
  "a".repeat(64),
  "--scratch-preparation-manifest",
  "preparation.json",
  "--scratch-preparation-sha256",
  "b".repeat(64),
  "--scratch-db",
  "scratch.sqlite",
  "--approved-scratch-db-sha256",
  "c".repeat(64),
  "--repo-map",
  "repo-map.json",
  "--repo-map-sha256",
  "d".repeat(64),
  "--scratch-state",
  "state",
  "--scratch-verification",
  "verify",
  "--live-db",
  "live.sqlite",
  "--repository-root",
  "repo",
  "--source-commit",
  "e".repeat(40),
  "--as-of",
  "2026-08-27T00:00:00.000Z",
  "--window-days",
  "30",
  "--out",
  "report.json",
];
function loaded(): LoadedApprovedEvidenceInput {
  return {
    scratchDbSha256: "c".repeat(64),
    repoMapSha256: "d".repeat(64),
    repositories: [
      { workspaceId: "ws-a", owner: "private", repo: "private", reportAlias: "repo-001" },
    ],
    openVerifiedScratchDb() {
      const db = new Database(":memory:");
      db.exec(
        "CREATE TABLE sessions(session_id TEXT, workspace_id TEXT, state TEXT); CREATE TABLE tool_events(event_id TEXT, session_id TEXT, ts TEXT, input_hash TEXT, exit_class TEXT); CREATE TABLE tool_event_metadata(event_id TEXT, file_path_hash TEXT, owner_message_id TEXT); CREATE TABLE turns(message_id TEXT, session_id TEXT, workspace_id TEXT, ts TEXT, provisional INTEGER);",
      );
      return db;
    },
  } as unknown as LoadedApprovedEvidenceInput;
}
describe("D7 CLI", () => {
  it("requires exactly the frozen flags and publishes only through the injected boundary", async () => {
    const loadApproved = vi.fn(async () => loaded());
    const publish = vi.fn(
      (
        _approved: Pick<LoadedApprovedEvidenceInput, "scratchStatePath">,
        _out: string,
        _value: string | Buffer,
      ) => ({
        path: "report.json",
        sha256: "f".repeat(64),
        identity: { device: "1", inode: "2", size: "3" },
      }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(
      runD7CoverageCli(base, {
        loadApproved,
        publish,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      }),
    ).resolves.toBe(0);
    expect(loadApproved).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(stdout).toHaveLength(1);
    expect(stderr).toEqual([]);
    expect(publish.mock.calls[0]?.[1]).toBe("report.json");
    expect(publish.mock.calls[0]?.[2]).toContain('"privacy":{"eventIdN":0');
  });
  it.each([
    { label: "missing", args: base.slice(0, -2), failure: "d7_cli_argument_missing" },
    {
      label: "unknown",
      args: [...base.slice(0, -2), "--unknown", "report.json"],
      failure: "d7_cli_argument_unknown_or_duplicate",
    },
    {
      label: "duplicate",
      args: [...base.slice(0, -4), "--out", "one", ...base.slice(-2)],
      failure: "d7_cli_argument_unknown_or_duplicate",
    },
    {
      label: "window",
      args: base.map((value, index) => (base[index - 1] === "--window-days" ? "29" : value)),
      failure: "d7_window_days_invalid",
    },
    {
      label: "as-of",
      args: base.map((value, index) => (base[index - 1] === "--as-of" ? "yesterday" : value)),
      failure: "d7_as_of_invalid",
    },
  ])("refuses $label CLI input before publishing", async ({ args, failure }) => {
    const loadApproved = vi.fn(async () => loaded());
    const publish = vi.fn(
      (
        _approved: Pick<LoadedApprovedEvidenceInput, "scratchStatePath">,
        _out: string,
        _value: string | Buffer,
      ) => ({
        path: "report.json",
        sha256: "f".repeat(64),
        identity: { device: "1", inode: "2", size: "3" },
      }),
    );
    const stderr: string[] = [];
    await expect(
      runD7CoverageCli(args, {
        loadApproved,
        publish,
        stderr: (line) => stderr.push(line),
      }),
    ).resolves.toBe(1);
    expect(publish).not.toHaveBeenCalled();
    expect(stderr.at(-1)).toContain(failure);
    if (failure === "d7_as_of_invalid" || failure === "d7_window_days_invalid") {
      expect(loadApproved).not.toHaveBeenCalled();
    }
  });
});
