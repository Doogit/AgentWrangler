import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureApplyJobsForTests,
  confirmApplyJob,
  getApplyJob,
  resetApplyJobsForTests,
  rollbackApplyJob,
  startApplyJob,
} from "../../src/apply/jobs.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;
let tmpDir: string;
let workspaceCwd: string;
let fileRef: string;
let stubPath: string;

function insertRec(
  recId: string,
  opts: { scope?: string | null; fileRef?: string | null } = {},
): void {
  const evidence: Record<string, unknown> = {
    component: "CLAUDE_MD",
    file_ref: opts.fileRef === undefined ? fileRef : opts.fileRef,
    steps: [{ kind: "trim", target: "CLAUDE_MD", max_lines: 80 }],
  };
  db.prepare(
    `INSERT INTO recommendations
       (rec_id, provenance, detector_id, category, scope_workspace_id, lever,
        modeled_savings_u_per_wk, modeled_formula_json, evidence_json,
        target_metric, state, created_at, dismissed_until)
     VALUES (?, 'RULE', 'D1', 'CONTEXT', ?, 'Trim workspace CLAUDE.md', 1000,
       '{"model":"D1","inputs":{}}', ?, 'avg_context_per_turn',
       'PROPOSED', '2026-08-25T00:00:00.000Z', NULL)`,
  ).run(recId, opts.scope === undefined ? "ws-alpha" : opts.scope, JSON.stringify(evidence));
}

async function waitForStatus(
  jobId: string,
  statuses: Array<"DRY_DONE" | "APPLIED" | "FAILED" | "ROLLED_BACK">,
) {
  for (let i = 0; i < 80; i++) {
    const job = getApplyJob(jobId).data;
    if (job !== null && statuses.includes(job.status as (typeof statuses)[number])) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${statuses.join(",")}`);
}

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-apply-test-"));
  workspaceCwd = path.join(tmpDir, "workspace");
  fileRef = path.join(workspaceCwd, ".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(fileRef), { recursive: true });
  fs.writeFileSync(fileRef, "original\n", "utf-8");
  stubPath = path.resolve("test/apply/stubs/claude-stub.cjs");
  configureApplyJobsForTests({
    claudeBin: process.execPath,
    claudeArgsPrefix: [stubPath],
    tmpRoot: path.join(tmpDir, "jobs"),
    timeoutMs: 2000,
    env: { AGENTWRANGLER_STUB_MODE: "success" },
  });
});

afterEach(() => {
  resetApplyJobsForTests();
  resetQueryDb();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("apply jobs", () => {
  it("sanitizes Claude Code nesting variables before spawning", async () => {
    const previousClaudeDecode = process.env.CLAUDECODE;
    const previousEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    class FakeApplyChild extends EventEmitter {
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      readonly stdin = new EventEmitter();
      readonly kill = () => true;
    }

    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    try {
      configureApplyJobsForTests({
        tmpRoot: path.join(tmpDir, "jobs"),
        timeoutMs: 2000,
        env: { AGENTWRANGLER_STUB_MODE: "success" },
        spawn: (_command, _args, options) => {
          capturedEnv = options.env;
          const child = new FakeApplyChild();
          queueMicrotask(() => {
            child.stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({ type: "result", subtype: "success", result: "Dry run complete" })}\n`,
              ),
            );
            child.emit("close", 0);
          });
          return child as unknown as ChildProcessWithoutNullStreams;
        },
      });
      insertRec("rec-env-sanitized");

      const started = startApplyJob("rec-env-sanitized", workspaceCwd).data;
      if (started === null) throw new Error("missing start response");
      const dry = await waitForStatus(started.job_id, ["DRY_DONE"]);

      expect(dry.status).toBe("DRY_DONE");
      expect(capturedEnv?.CLAUDECODE).toBeUndefined();
      expect(
        Object.keys(capturedEnv ?? {}).filter((key) => key.startsWith("CLAUDE_CODE_")),
      ).toEqual([]);
      expect(capturedEnv?.PATH ?? capturedEnv?.Path).toBeDefined();
    } finally {
      if (previousClaudeDecode === undefined) Reflect.deleteProperty(process.env, "CLAUDECODE");
      else process.env.CLAUDECODE = previousClaudeDecode;
      if (previousEntrypoint === undefined)
        Reflect.deleteProperty(process.env, "CLAUDE_CODE_ENTRYPOINT");
      else process.env.CLAUDE_CODE_ENTRYPOINT = previousEntrypoint;
    }
  });

  it("runs dry-run, confirms apply, marks the recommendation adopted, and records the actual diff", async () => {
    insertRec("rec-apply-success");

    const started = startApplyJob("rec-apply-success", workspaceCwd).data;
    if (started === null) throw new Error("missing start response");
    const dry = await waitForStatus(started.job_id, ["DRY_DONE"]);
    expect(dry.status).toBe("DRY_DONE");
    expect(dry.diff_preview).toContain("batch this edit to a /clear");

    confirmApplyJob(started.job_id);
    const applied = await waitForStatus(started.job_id, ["APPLIED"]);
    expect(applied.status).toBe("APPLIED");
    expect(applied.diff_applied).toContain("Applied trim");
    expect(fs.readFileSync(fileRef, "utf-8")).toBe("trimmed\n");

    const rec = db
      .prepare("SELECT state, adopted_at FROM recommendations WHERE rec_id = ?")
      .get("rec-apply-success") as { state: string; adopted_at: string | null };
    expect(rec.state).toBe("ADOPTED");
    expect(rec.adopted_at).not.toBeNull();
  });

  it("rejects absent file_ref without spawning", () => {
    insertRec("rec-no-file", { fileRef: null });
    expect(() => startApplyJob("rec-no-file", workspaceCwd)).toThrow(/file_ref absent/);
  });

  it("rejects global-scope recommendations", () => {
    insertRec("rec-global", { scope: null });
    expect(() => startApplyJob("rec-global", workspaceCwd)).toThrow(/global-file recs/);
  });

  it("rejects traversal before spawn", () => {
    insertRec("rec-traversal", { fileRef: "../outside.md" });
    expect(() => startApplyJob("rec-traversal", workspaceCwd)).toThrow(/inside workspace_cwd/);
  });

  it("keeps a completed dry-run exclusive until it is confirmed or resolved", async () => {
    insertRec("rec-single-flight");

    const started = startApplyJob("rec-single-flight", workspaceCwd).data;
    if (started === null) throw new Error("missing start response");
    await waitForStatus(started.job_id, ["DRY_DONE"]);

    expect(() => startApplyJob("rec-single-flight", workspaceCwd)).toThrow(
      /job already in progress/,
    );
  });

  it("restores the backup and fails when Claude reports an out-of-scope write", async () => {
    configureApplyJobsForTests({
      claudeBin: process.execPath,
      claudeArgsPrefix: [stubPath],
      tmpRoot: path.join(tmpDir, "jobs"),
      timeoutMs: 2000,
      env: { AGENTWRANGLER_STUB_MODE: "out-of-scope" },
    });
    insertRec("rec-out-of-scope");

    const started = startApplyJob("rec-out-of-scope", workspaceCwd).data;
    if (started === null) throw new Error("missing start response");
    await waitForStatus(started.job_id, ["DRY_DONE"]);
    confirmApplyJob(started.job_id);
    const failed = await waitForStatus(started.job_id, ["FAILED"]);

    expect(failed.error_msg).toContain("out-of-scope writes detected");
    expect(fs.readFileSync(fileRef, "utf-8")).toBe("original\n");
  });

  it("rolls back an applied job to the pre-apply backup", async () => {
    insertRec("rec-rollback");

    const started = startApplyJob("rec-rollback", workspaceCwd).data;
    if (started === null) throw new Error("missing start response");
    await waitForStatus(started.job_id, ["DRY_DONE"]);
    confirmApplyJob(started.job_id);
    await waitForStatus(started.job_id, ["APPLIED"]);

    rollbackApplyJob(started.job_id);
    const rolledBack = await waitForStatus(started.job_id, ["ROLLED_BACK"]);

    expect(rolledBack.status).toBe("ROLLED_BACK");
    expect(fs.readFileSync(fileRef, "utf-8")).toBe("original\n");
  });

  it("marks the job failed before spawn when settings JSON is invalid", async () => {
    insertRec("rec-bad-settings");
    const started = startApplyJob("rec-bad-settings", workspaceCwd, {
      settingsGenerator: () => "{",
    }).data;
    if (started === null) throw new Error("missing start response");

    const failed = await waitForStatus(started.job_id, ["FAILED"]);
    expect(failed.error_msg).toContain("settings file generation error");
  });

  it("marks the job failed when the dry-run process times out", async () => {
    configureApplyJobsForTests({
      claudeBin: process.execPath,
      claudeArgsPrefix: [stubPath],
      tmpRoot: path.join(tmpDir, "jobs"),
      timeoutMs: 100,
      env: { AGENTWRANGLER_STUB_MODE: "sleep" },
    });
    insertRec("rec-timeout");

    const started = startApplyJob("rec-timeout", workspaceCwd).data;
    if (started === null) throw new Error("missing start response");
    const failed = await waitForStatus(started.job_id, ["FAILED"]);

    expect(failed.error_msg).toContain("job timed out");
  });

  it("marks the job failed when stdout exceeds the cap", async () => {
    configureApplyJobsForTests({
      claudeBin: process.execPath,
      claudeArgsPrefix: [stubPath],
      tmpRoot: path.join(tmpDir, "jobs"),
      timeoutMs: 2000,
      stdoutCapBytes: 1024,
      env: { AGENTWRANGLER_STUB_MODE: "big-output" },
    });
    insertRec("rec-stdout-cap");

    const started = startApplyJob("rec-stdout-cap", workspaceCwd).data;
    if (started === null) throw new Error("missing start response");
    const failed = await waitForStatus(started.job_id, ["FAILED"]);

    expect(failed.error_msg).toContain("stdout cap exceeded");
  });
});
