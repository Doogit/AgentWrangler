import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { CHECK_GUIDANCE } from "../../src/detector/check-guidance.js";
import { CHECKS, GATES } from "../../src/detector/check-registry.js";
import type { CheckOutcome, SetupGrade } from "../../src/detector/setup-grade.js";
import {
  type JudgeSetupResponse,
  allowAllBashFiles,
  priceGrade,
  untestedEditWhere,
} from "../../src/query/api/judge-setup.js";
import type { RecommendationCard } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import type { EnvScanResult, SettingsScan } from "../../src/scanner/env-scan.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";
import { migratedMemDb } from "../ingest/dbutil.js";

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      })
      .on("error", reject);
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;

let fixtureRoot: string;
const savedEnv = { dir: process.env.AW_CLAUDE_DIR, json: process.env.AW_CLAUDE_JSON };

beforeAll(async () => {
  // Isolate the scan from the real ~/.claude: a temp dir with a malformed settings.json.
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aw-judge-"));
  const claudeDir = path.join(fixtureRoot, ".claude");
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, "settings.json"), "{ not json");
  process.env.AW_CLAUDE_DIR = claudeDir;
  process.env.AW_CLAUDE_JSON = path.join(fixtureRoot, "claude.json");
  db = createInMemoryFixtureDb();
  server = createServer(db, 0, null);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    }),
  );
});
beforeEach(() => setQueryDb(db));
afterEach(() => resetQueryDb());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  if (savedEnv.dir === undefined) Reflect.deleteProperty(process.env, "AW_CLAUDE_DIR");
  else process.env.AW_CLAUDE_DIR = savedEnv.dir;
  if (savedEnv.json === undefined) Reflect.deleteProperty(process.env, "AW_CLAUDE_JSON");
  else process.env.AW_CLAUDE_JSON = savedEnv.json;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

const snapshotCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM setup_grade_snapshots").get() as { n: number }).n;

describe("GET /api/judge-setup", () => {
  it("returns the grade envelope with rubric metadata, and a repeat GET writes no row", async () => {
    const before = snapshotCount();
    const first = await get(port, "/api/judge-setup");
    expect(first.status).toBe(200);
    const body = JSON.parse(first.body) as JudgeSetupResponse;

    expect(body.grade.checks).toHaveLength(CHECKS.length);
    expect(body.grade.window.to).toBeTruthy();
    expect(body.rubric.checks).toHaveLength(CHECKS.length);
    expect(body.rubric.gates.map((g) => g.gate_id)).toEqual(GATES.map((g) => g.gate_id));
    expect(body.rubric.tier_names).toHaveLength(body.rubric.tier_floors.length);
    expect(body.rubric.categories.length).toBeGreaterThan(0);
    expect(body.rubric.version).toMatch(/^cc-docs/);
    expect(body.dollars.per_check).toHaveLength(CHECKS.length);
    // Every check carries the full guidance: what counts, steps, done-when.
    for (const c of body.rubric.checks) {
      expect(c.measured, c.check_id).toBeTruthy();
      expect(c.done_when, c.check_id).toBeTruthy();
      expect(c.how_to?.length, c.check_id).toBeGreaterThan(0);
    }
    // Scan used the temp fixture dir (malformed settings.json), not the real ~/.claude.
    expect(body.unreadable_surfaces).toContain("settings.json");
    expect(JSON.stringify(body.unreadable_surfaces)).not.toContain(fixtureRoot);
    expect("allow_all_bash_files" in body).toBe(false);

    const afterFirst = snapshotCount();
    expect(afterFirst).toBe(before + 1);
    expect(body.recorded).toBe(true);

    const second = await get(port, "/api/judge-setup");
    expect(second.status).toBe(200);
    expect((JSON.parse(second.body) as JudgeSetupResponse).recorded).toBe(false);
    expect(snapshotCount()).toBe(afterFirst);
  });
});

describe("allowAllBashFiles", () => {
  const settings = (allowAllBash: boolean): SettingsScan => ({
    file: "ok",
    permissions: {
      status: "ok",
      data: { allow: [], deny: [], ask: [], defaultMode: null, allowAllBash },
    },
    hooks: { status: "absent" },
  });
  const project = (repoPath: string, s: SettingsScan | null) =>
    ({
      repoPath,
      claudeDir: s ? { status: "ok", data: s } : { status: "absent" },
    }) as unknown as EnvScanResult["projects"][number];

  it("lists the user file and each project file whose rules allow all Bash, in scan order", () => {
    const repoA = path.join("work", "app-a");
    const scan = {
      settings: settings(true),
      projects: [
        project(repoA, settings(true)),
        project(path.join("work", "app-b"), settings(false)),
        project(path.join("work", "app-c"), null),
      ],
    } as unknown as EnvScanResult;
    expect(allowAllBashFiles(scan)).toEqual([
      "~/.claude/settings.json",
      path.join(repoA, ".claude", "settings.json"),
    ]);
  });

  it("is empty when no scope allows all Bash", () => {
    const scan = { settings: settings(false), projects: [] } as unknown as EnvScanResult;
    expect(allowAllBashFiles(scan)).toEqual([]);
  });
});

function outcome(check_id: string, result: CheckOutcome["result"]): CheckOutcome {
  return {
    check_id,
    category: "context_hygiene",
    severity: "important",
    result,
    value: null,
    sample: 10,
    reason: null,
    needs: null,
  };
}

function card(
  detector_id: string,
  allocated_u_per_wk: number | null,
  summable: boolean,
  rec_id = `rec-${detector_id}`,
): RecommendationCard {
  return {
    rec_id,
    detector_id,
    allocated_u_per_wk,
    estimate: { basis: summable ? "E" : "X", rank_value_u_per_wk: null, summable, label: "t" },
  } as unknown as RecommendationCard;
}

function gradeWith(checks: CheckOutcome[], items: { check_id: string }[]): SetupGrade {
  return {
    checks,
    next_tier: {
      tier: "Conductor",
      items: items.map((i) => ({ kind: "check" as const, check_id: i.check_id, message: "m" })),
    },
  } as unknown as SetupGrade;
}

describe("priceGrade", () => {
  const checks = [
    outcome("long_session_share", "FAIL"), // D2, priced + summable
    outcome("interrupt_rate", "PARTIAL"), // D14, priced but non-summable
    outcome("denial_rate", "FAIL"), // C9, no card
    outcome("cache_read_health", "PASS"), // B1, passing -> never priced
    outcome("verify_test_loop", "FAIL"), // no mapping
  ];
  const cards = [
    card("D2", 12_340_000, true, "a"),
    card("D2", 1_000_000, true, "b"),
    card("D14", 9_000_000, false),
    card("B1", 5_000_000, true),
  ];

  it("prices only failing checks with a priced, summable-basis rec", () => {
    const { per_check } = priceGrade(gradeWith(checks, []), cards);
    const byId = new Map(per_check.map((p) => [p.check_id, p]));
    expect(byId.get("long_session_share")?.dollars_per_week).toBe(13.34);
    expect(byId.get("long_session_share")?.rec_ids).toEqual(["a", "b"]);
    expect(byId.get("interrupt_rate")?.dollars_per_week).toBeNull();
    expect(byId.get("denial_rate")?.dollars_per_week).toBeNull();
    expect(byId.get("cache_read_health")?.dollars_per_week).toBeNull();
    expect(byId.get("verify_test_loop")?.dollars_per_week).toBeNull();
  });

  it("labels a mixed next-tier list 'measured items only'", () => {
    const { next_tier_gap } = priceGrade(
      gradeWith(checks, [{ check_id: "long_session_share" }, { check_id: "verify_test_loop" }]),
      cards,
    );
    expect(next_tier_gap).toEqual({
      tier: "Conductor",
      dollars_per_week: 13.34,
      measured_items: 1,
      total_items: 2,
      label: "measured items only",
    });
  });

  it("has no label when every item is priced, and null dollars when none are", () => {
    const all = priceGrade(gradeWith(checks, [{ check_id: "long_session_share" }]), cards);
    expect(all.next_tier_gap?.label).toBeNull();
    const none = priceGrade(gradeWith(checks, [{ check_id: "verify_test_loop" }]), cards);
    expect(none.next_tier_gap?.dollars_per_week).toBeNull();
    expect(none.next_tier_gap?.label).toBe("measured items only");
  });
});

describe("check guidance", () => {
  // done_when is hand-written; pin it to the scoring bar so a threshold change can't leave it stale.
  it("states each check's pass bar in its done_when", () => {
    for (const c of CHECKS) {
      const text = CHECK_GUIDANCE[c.check_id]?.done_when ?? "";
      const bar = c.scoring.pass;
      const perHundred = /^(interrupt_rate|denial_rate)$/.test(c.check_id);
      const shown = perHundred
        ? `${Math.round(bar * 100)} `
        : bar > 0 && bar < 1
          ? `${Math.round(bar * 100)}%`
          : `${bar}`;
      if (c.scoring.direction === "lower" && bar === 0) expect(text, c.check_id).toMatch(/^No /);
      else expect(text, c.check_id).toContain(shown);
    }
  });
});

describe("untestedEditWhere", () => {
  let mem: Database.Database;
  beforeEach(() => {
    mem = migratedMemDb();
    const ws = mem.prepare(
      "INSERT INTO workspaces (workspace_id, project_slug, repo_path, repo_name, registered_at) VALUES (?, ?, ?, ?, '2026-10-01T00:00:00.000Z')",
    );
    ws.run("a", "slug-a", path.join(os.tmpdir(), "code", "Alpha"), null);
    ws.run("b", "slug-b", null, "beta");
    const s = mem.prepare(
      `INSERT INTO sessions (session_id, workspace_id, file_path, state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, ?, ?, 'LIVE', 0, 0, '[]')`,
    );
    const te = mem.prepare(
      "INSERT INTO tool_events (event_id, session_id, ts, tool_name) VALUES (?, ?, ?, ?)",
    );
    const meta = mem.prepare(
      "INSERT INTO tool_event_metadata (event_id, block_index, is_test_command) VALUES (?, 0, ?)",
    );
    const add = (sid: string, wsId: string, tested: boolean, ts = "2026-10-10T00:00:00.000Z") => {
      s.run(sid, wsId, `/f/${sid}.jsonl`);
      te.run(`${sid}-e`, sid, ts, "Edit");
      meta.run(`${sid}-e`, 0);
      te.run(`${sid}-t`, sid, ts, "PowerShell");
      meta.run(`${sid}-t`, tested ? 1 : 0);
    };
    add("a1", "a", false);
    add("a2", "a", false);
    add("a3", "a", true);
    add("b1", "b", false);
    add("b2", "b", true);
    add("old", "b", false, "2026-01-01T00:00:00.000Z");
  });
  afterEach(() => mem.close());

  it("ranks workspaces by untested editing sessions in the window, by repo name or folder", () => {
    const rows = untestedEditWhere(mem, {
      from: "2026-09-15T00:00:00.000Z",
      to: "2026-10-15T00:00:00.000Z",
    });
    expect(rows).toEqual([
      { label: "Alpha", missed: 2, total: 3 },
      { label: "beta", missed: 1, total: 2 },
    ]);
  });
});
