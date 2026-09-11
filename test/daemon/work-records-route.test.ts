/** HTTP contract for local ESF3 work-record reads and token-gated mutations. */
import * as http from "node:http";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { runMigrations } from "../../src/db/migrate.js";

interface Response {
  status: number;
  body: string;
}

function request(
  port: number,
  opts: { method?: string; path: string; token?: string; body?: unknown },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "same-origin",
          ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body).toString() }),
          ...(opts.token === undefined ? {} : { "X-AgentWrangler-Token": opts.token }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;
const token = "work-record-test-token";

beforeAll(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
  ).run("ws-route", "route", "2026-09-09T00:00:00.000Z");
  db.prepare(
    "INSERT INTO sessions (session_id, workspace_id, file_path, state) VALUES (?, ?, ?, ?)",
  ).run("session-route", "ws-route", "route.jsonl", "RECONCILED");
  server = createServer(db, 0, null, token);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function issue(kind: string): Promise<string> {
  const result = await request(port, {
    method: "POST",
    path: "/api/work-records/ids",
    token,
    body: { kind },
  });
  expect(result.status).toBe(200);
  return (JSON.parse(result.body) as { data: { id: string } }).data.id;
}

async function createRecord(): Promise<{ id: string; revision: number }> {
  const id = await issue("WORK_RECORD");
  const result = await request(port, {
    method: "POST",
    path: "/api/work-records",
    token,
    body: { work_record_id: id, workspace_id: "ws-route", task_intent: "RESEARCH_PLAN" },
  });
  expect(result.status).toBe(200);
  return {
    id,
    revision: (JSON.parse(result.body) as { data: { record: { current_revision_no: number } } })
      .data.record.current_revision_no,
  };
}

describe("ESF3 work-record routes", () => {
  it("rejects missing and stale write tokens before issuing IDs or mutating", async () => {
    const missing = await request(port, {
      method: "POST",
      path: "/api/work-records/ids",
      body: { kind: "WORK_RECORD" },
    });
    const stale = await request(port, {
      method: "POST",
      path: "/api/work-records/ids",
      token: "stale-token",
      body: { kind: "WORK_RECORD" },
    });
    expect(missing.status).toBe(401);
    expect(stale.status).toBe(401);
  });

  it("requires the current token on every work-record mutation family", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const paths: Array<{ method?: string; path: string }> = [
      { path: "/api/work-records" },
      { path: `/api/work-records/${id}/edit` },
      { path: `/api/work-records/${id}/closeout` },
      { path: `/api/work-records/${id}/archive` },
      { path: `/api/work-records/${id}/reopen` },
      { path: `/api/work-records/${id}/sessions` },
      { path: `/api/work-records/${id}/sessions/session-route/detach` },
      { path: `/api/work-records/${id}/contexts` },
      { path: `/api/work-records/${id}/contexts/${id}/detach` },
      { method: "DELETE", path: `/api/work-records/${id}/delete` },
      { path: "/api/work-records/allocations/recompute" },
    ];
    for (const route of paths) {
      const missing = await request(port, {
        method: route.method ?? "POST",
        path: route.path,
        body: {},
      });
      const stale = await request(port, {
        method: route.method ?? "POST",
        path: route.path,
        token: "stale-token",
        body: {},
      });
      expect(missing.status, route.path).toBe(401);
      expect(stale.status, route.path).toBe(401);
    }
  });

  it("rejects oversized request bodies as client errors", async () => {
    const response = await request(port, {
      method: "POST",
      path: "/api/work-records/ids",
      token,
      body: { kind: "x".repeat(1100) },
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("replays the same create request with its original timestamp", async () => {
    const id = await issue("WORK_RECORD");
    const body = { work_record_id: id, workspace_id: "ws-route", task_intent: "DEBUG" };
    const first = await request(port, { method: "POST", path: "/api/work-records", token, body });
    const replay = await request(port, { method: "POST", path: "/api/work-records", token, body });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstBody = JSON.parse(first.body) as {
      data: { record: { created_at: string }; replayed: boolean };
    };
    const replayBody = JSON.parse(replay.body) as {
      data: { record: { created_at: string }; replayed: boolean };
    };
    expect(replayBody.data.replayed).toBe(true);
    expect(replayBody.data.record.created_at).toBe(firstBody.data.record.created_at);
  });

  it("returns an idempotency conflict when a create ID is reused with different input", async () => {
    const id = await issue("WORK_RECORD");
    const first = await request(port, {
      method: "POST",
      path: "/api/work-records",
      token,
      body: { work_record_id: id, workspace_id: "ws-route", task_intent: "DEBUG" },
    });
    const conflict = await request(port, {
      method: "POST",
      path: "/api/work-records",
      token,
      body: { work_record_id: id, workspace_id: "ws-route", task_intent: "REVIEW" },
    });
    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects unknown fields and routes edit, membership, and detail/list reads", async () => {
    const id = await issue("WORK_RECORD");
    const rejected = await request(port, {
      method: "POST",
      path: "/api/work-records",
      token,
      body: {
        work_record_id: id,
        workspace_id: "ws-route",
        task_intent: "DEBUG",
        title: "private",
      },
    });
    expect(rejected.status).toBe(400);

    const record = await createRecord();
    const editMutation = await issue("MUTATION");
    const edit = {
      mutation_id: editMutation,
      expected_revision_no: record.revision,
      task_intent: "RESEARCH_PLAN",
      outcome_state: "USEFUL",
      repair_band: "NONE",
      effort_band: "LOW",
      feedback_source: "USER_EDIT",
    };
    const edited = await request(port, {
      method: "POST",
      path: `/api/work-records/${record.id}/edit`,
      token,
      body: edit,
    });
    const replay = await request(port, {
      method: "POST",
      path: `/api/work-records/${record.id}/edit`,
      token,
      body: edit,
    });
    expect(edited.status).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({ data: { replayed: true } });

    const stale = await request(port, {
      method: "POST",
      path: `/api/work-records/${record.id}/archive`,
      token,
      body: { mutation_id: await issue("MUTATION"), expected_revision_no: record.revision },
    });
    expect(stale.status).toBe(409);

    const attach = await request(port, {
      method: "POST",
      path: `/api/work-records/${record.id}/sessions`,
      token,
      body: {
        mutation_id: await issue("MUTATION"),
        expected_revision_no: 1,
        session_id: "session-route",
      },
    });
    expect(attach.status).toBe(200);
    const mismatch = await request(port, {
      method: "POST",
      path: `/api/work-records/${record.id}/sessions/session-route/detach`,
      token,
      body: { mutation_id: await issue("MUTATION"), expected_revision_no: 2, session_id: "other" },
    });
    expect(mismatch.status).toBe(400);

    const detail = await request(port, { path: `/api/work-records/${record.id}` });
    const list = await request(port, { path: "/api/work-records?workspace_id=ws-route" });
    expect(JSON.parse(detail.body)).toMatchObject({
      data: { work_record_id: record.id },
      meta: { claim_kind: "EXACT" },
    });
    expect(JSON.parse(list.body)).toMatchObject({
      data: expect.any(Array),
      meta: { n: expect.any(Number) },
    });
  });

  it("routes archive, reopen, and context/session detach with revisioned replay", async () => {
    const record = await createRecord();
    let revision = record.revision;
    const mutate = async (action: string, extra: Record<string, unknown> = {}) => {
      const body = {
        mutation_id: await issue("MUTATION"),
        expected_revision_no: revision,
        ...extra,
      };
      const opts = {
        method: "POST",
        path: `/api/work-records/${record.id}/${action}`,
        token,
        body,
      };
      const first = await request(port, opts);
      expect(first.status, action).toBe(200);
      const data = JSON.parse(first.body).data;
      expect(data.record.current_revision_no).toBe(++revision);
      const replay = await request(port, opts);
      expect(replay.status, action).toBe(200);
      expect(JSON.parse(replay.body).data).toEqual({ ...data, replayed: true });
      return data.record;
    };
    const archived = await mutate("archive");
    expect(archived.archived_at).toEqual(expect.any(String));
    const hidden = await request(port, { path: "/api/work-records?workspace_id=ws-route" });
    expect(
      JSON.parse(hidden.body).data.some(
        (row: { work_record_id: string }) => row.work_record_id === record.id,
      ),
    ).toBe(false);
    expect((await mutate("reopen")).archived_at).toBeNull();
    const contextId = await issue("CONTEXT_REF");
    await mutate("contexts", { context_kind: "WORKTREE", context_ref_id: contextId });
    await mutate(`contexts/${contextId}/detach`, { context_kind: "WORKTREE" });
    await mutate("sessions", { session_id: "session-route" });
    await mutate("sessions/session-route/detach");
    const links = db
      .prepare("SELECT unlinked_at FROM work_record_session_links WHERE work_record_id = ?")
      .all(record.id);
    expect(links).toEqual([{ unlinked_at: expect.any(String) }]);
    const contexts = db
      .prepare("SELECT unlinked_at FROM work_record_context_refs WHERE work_record_id = ?")
      .all(record.id);
    expect(contexts).toEqual([{ unlinked_at: expect.any(String) }]);
  });

  it("requires explicit delete confirmation and provides minimal delete replay", async () => {
    const record = await createRecord();
    const mutation = await issue("MUTATION");
    const denied = await request(port, {
      method: "DELETE",
      path: `/api/work-records/${encodeURIComponent(record.id)}/delete`,
      token,
      body: { mutation_id: mutation, expected_revision_no: record.revision },
    });
    expect(denied.status).toBe(400);
    const deleted = await request(port, {
      method: "DELETE",
      path: `/api/work-records/${encodeURIComponent(record.id)}/delete`,
      token,
      body: { mutation_id: mutation, expected_revision_no: record.revision, confirm: true },
    });
    const replay = await request(port, {
      method: "DELETE",
      path: `/api/work-records/${encodeURIComponent(record.id)}/delete`,
      token,
      body: { mutation_id: mutation, expected_revision_no: record.revision, confirm: true },
    });
    expect(deleted.status).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({
      data: { replayed: true, work_record_id: record.id },
    });
    const read = await request(port, {
      path: `/api/work-records/${encodeURIComponent(record.id)}`,
    });
    expect(read.status).toBe(410);
  });

  it("returns experimental allocation envelopes with a cohort and unpriced qualification", async () => {
    db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, parser_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("turn-route", "session-route", "ws-route", "2026-09-09T12:00:00.000Z", "m", null, "p1");
    db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, cost_claim, parser_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "turn-route-priced",
      "session-route",
      "ws-route",
      "2026-09-09T12:01:00.000Z",
      "m",
      100,
      "LIST_EQUIV_STALE",
      "p1",
    );
    db.prepare(
      "INSERT INTO turns (message_id, session_id, workspace_id, ts, model, cost_equiv_u, cost_claim, parser_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "turn-route-current",
      "session-route",
      "ws-route",
      "2026-09-09T12:02:00.000Z",
      "m",
      200,
      "LIST_EQUIV",
      "p1",
    );
    const record = await createRecord();
    const attach = await request(port, {
      method: "POST",
      path: `/api/work-records/${record.id}/sessions`,
      token,
      body: {
        mutation_id: await issue("MUTATION"),
        expected_revision_no: record.revision,
        session_id: "session-route",
      },
    });
    expect(attach.status).toBe(200);
    const closeout = await request(port, {
      method: "POST",
      path: `/api/work-records/${record.id}/closeout`,
      token,
      body: {
        mutation_id: await issue("MUTATION"),
        expected_revision_no: 1,
        outcome_state: "USEFUL",
        repair_band: "NONE",
        effort_band: "LOW",
      },
    });
    expect(closeout.status).toBe(200);

    const allocationId = await issue("ALLOCATION_REVISION");
    const recomputed = await request(port, {
      method: "POST",
      path: "/api/work-records/allocations/recompute",
      token,
      body: {
        mutation_id: await issue("MUTATION"),
        allocation_revision_id: allocationId,
        workspace_id: "ws-route",
        cohort_from: "2026-09-09T00:00:00.000Z",
        cohort_to: "2026-09-10T00:00:00.000Z",
        evidence_as_of: "2026-09-10T00:00:00.000Z",
      },
    });
    expect(recomputed.status).toBe(200);
    expect(JSON.parse(recomputed.body)).toMatchObject({
      data: { allocation: { allocation_revision_id: allocationId } },
      meta: {
        claim_kind: "EXPERIMENTAL",
        window: { from: "2026-09-09T00:00:00.000Z", to: "2026-09-10T00:00:00.000Z" },
        qualification: { unpriced_turns: 1, claim_kinds_count: 2 },
      },
    });
    // Later ingestion changes must not rewrite a frozen report's qualification.
    db.prepare("UPDATE turns SET cost_claim = 'LIST_EQUIV' WHERE session_id = ?").run(
      "session-route",
    );
    const fetched = await request(port, { path: `/api/work-records/allocations/${allocationId}` });
    expect(fetched.status).toBe(200);
    expect(JSON.parse(fetched.body)).toMatchObject({
      data: { allocation_revision_id: allocationId },
      meta: { claim_kind: "EXPERIMENTAL", qualification: { claim_kinds_count: 2 } },
    });
    const listed = await request(port, {
      path: "/api/work-records/allocations?workspace_id=ws-route",
    });
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body).data).toEqual([
      expect.objectContaining({
        allocation_revision_id: allocationId,
        cohort_from: "2026-09-09T00:00:00.000Z",
        cohort_to: "2026-09-10T00:00:00.000Z",
        // The membership was attached after this report's evidence cutoff.
        allocated_session_count: 0,
        eligible_session_count: 1,
      }),
    ]);
    const otherWorkspace = await request(port, {
      path: "/api/work-records/allocations?workspace_id=other",
    });
    expect(otherWorkspace.status).toBe(200);
    expect(JSON.parse(otherWorkspace.body).data).toEqual([]);
    expect((await request(port, { path: "/api/work-records/allocations" })).status).toBe(400);
  });
});
