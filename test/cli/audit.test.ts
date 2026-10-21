/**
 * `agentwrangler audit` (RR U4): generator, copy-only guarantee, query.mjs guard, scan.mjs on the
 * synthetic waste profile, and the SEC-101 content scan over the generated packs.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeText, rawContentReasons } from "../../scripts/hooks/content-signatures.mjs";
import { generateAudit } from "../../src/cli/audit/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";
import { seedApiKeyProfile, seedProProfile, seedWasteProfile } from "../fixtures/seed.js";
import { writeSyntheticJsonl, writeWasteFiles } from "../fixtures/synthetic-jsonl.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
let tmp: string;
let srcDb: string;
let out: string;
let files: { jsonlRoot: string; settingsPath: string; missingHook: string };
let before: { mtimeMs: number; size: number; migrations: number };
let after: { mtimeMs: number; size: number; migrations: number };
let promptSrc: string;

const migrationCount = (p: string): number => {
  const d = new Database(p, { readonly: true });
  try {
    return (d.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
  } finally {
    d.close();
  }
};
const stat = (p: string) => {
  const s = fs.statSync(p);
  return { mtimeMs: s.mtimeMs, size: s.size, migrations: migrationCount(p) };
};
const node = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: path.dirname(script) });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-audit-test-"));
  srcDb = path.join(tmp, "src.sqlite");
  const db = openDb(srcDb);
  runMigrations(db);
  seedWasteProfile(db, NOW);
  files = writeWasteFiles(db, path.join(tmp, "inputs"));
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  promptSrc = path.join(tmp, "prompt-src.md");
  fs.writeFileSync(promptSrc, "Audit folder: {{AUDIT_DIR}} and again {{AUDIT_DIR}}\n");
  before = stat(srcDb);
  out = path.join(tmp, "audit");
  await generateAudit({
    db: srcDb,
    out,
    jsonlRoot: files.jsonlRoot,
    days: 28,
    promptPath: promptSrc,
  });
  after = stat(srcDb);
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("audit generator", () => {
  it("writes every file and fills the prompt placeholder", () => {
    for (const f of [
      "db.sqlite",
      "schema.md",
      "pack.md",
      "query.mjs",
      "scan.mjs",
      "render.mjs",
      "prompt.md",
    ]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }
    const prompt = fs.readFileSync(path.join(out, "prompt.md"), "utf8");
    expect(prompt).toBe(`Audit folder: ${out} and again ${out}\n`);
    expect(fs.readFileSync(path.join(out, "schema.md"), "utf8")).toContain("## turns");
  });

  it("pack.md has the basis and every section, and spend-by-model equals an independent SQL sum", () => {
    const pack = fs.readFileSync(path.join(out, "pack.md"), "utf8");
    for (const h of [
      "Pricing basis",
      "Window:",
      "## Total spend",
      "## Spend by model",
      "## Main thread vs subagent",
      "## Spend by project",
      "## S1 main-session model routing",
      "## S4 idle cache rebuild",
      "## S6 oversized subagents",
      "## S8 hook denies",
      "## S13 long wall-clock sessions",
      "## S14 shell errors",
      "## S15 output-heavy mechanical turns",
      "## Diagnostics causes",
      "## Context inventory",
      "## Tool error classes",
    ]) {
      expect(pack, h).toContain(h);
    }
    const copy = new Database(path.join(out, "db.sqlite"), { readonly: true });
    const rows = copy
      .prepare("SELECT model, SUM(cost_equiv_u) AS u FROM turns GROUP BY model")
      .all() as { model: string; u: number }[];
    copy.close();
    expect(rows.length).toBeGreaterThan(1);
    const section = pack.split("## Spend by model")[1]?.split("## ")[0] ?? "";
    for (const r of rows) {
      expect(section).toContain(`| ${r.model} |`);
      expect(section).toContain(`$${(r.u / 1e6).toFixed(4)}`);
    }
  });

  it("copy-only: the source DB file is unchanged and was not migrated", () => {
    expect(after).toEqual(before);
  });

  it("fails clearly when prompt.md is missing", async () => {
    await expect(
      generateAudit({
        db: srcDb,
        out: path.join(tmp, "x"),
        jsonlRoot: tmp,
        days: 28,
        promptPath: path.join(tmp, "nope.md"),
      }),
    ).rejects.toThrow(/audit prompt not found/);
    expect(fs.existsSync(path.join(tmp, "x"))).toBe(false);
  });

  it("refuses an --out folder whose db.sqlite is the source DB, leaving the source intact", async () => {
    const dir = path.join(tmp, "self");
    fs.mkdirSync(dir, { recursive: true });
    const self = path.join(dir, "db.sqlite");
    fs.copyFileSync(srcDb, self);
    const size = fs.statSync(self).size;
    await expect(
      generateAudit({ db: self, out: dir, jsonlRoot: tmp, days: 28, promptPath: promptSrc }),
    ).rejects.toThrow(/would overwrite the source database/);
    expect(fs.statSync(self).size).toBe(size);
  });

  it("builds packs for the pro and API-key profiles too", async () => {
    for (const [name, seed] of [
      ["pro", seedProProfile],
      ["apikey", seedApiKeyProfile],
    ] as const) {
      const p = path.join(tmp, `${name}.sqlite`);
      const db = openDb(p);
      runMigrations(db);
      seed(db, NOW);
      writeSyntheticJsonl(db, path.join(tmp, `${name}-projects`));
      db.close();
      const o = path.join(tmp, `${name}-audit`);
      await generateAudit({
        db: p,
        out: o,
        jsonlRoot: path.join(tmp, `${name}-projects`),
        days: 28,
        promptPath: promptSrc,
      });
      expect(fs.readFileSync(path.join(o, "pack.md"), "utf8")).toContain("## Spend by model");
    }
  });
});

describe("query.mjs", () => {
  const q = () => path.join(out, "query.mjs");
  it("runs a SELECT and PRAGMA table_info", () => {
    const r = node(q(), "SELECT COUNT(*) AS n FROM turns");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\| n \|[\s\S]*\| 396 \|/);
    expect(node(q(), "PRAGMA table_info(turns)").status).toBe(0);
  });
  it.each([
    "UPDATE turns SET model = 'x'",
    "DELETE FROM turns",
    "ATTACH DATABASE 'other.db' AS o",
    "SELECT 1; SELECT 2",
    "SELECT 1; DELETE FROM turns",
    "DROP TABLE turns",
    "PRAGMA journal_mode = DELETE",
    "SELECT load_extension('x')",
  ])("rejects %s", (sql) => {
    const r = node(q(), sql);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("rejected");
  });
  it("leaves the data untouched", () => {
    const copy = new Database(path.join(out, "db.sqlite"), { readonly: true });
    const n = (copy.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
    copy.close();
    expect(n).toBe(396);
  });
});

describe("scan.mjs on the waste profile", () => {
  const s = () => path.join(out, "scan.mjs");
  it("finds the broken hook path and the hook errors", () => {
    const r = node(s(), "hooks", "--settings", files.settingsPath);
    expect(r.status).toBe(0);
    const recs = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const missing = recs.filter((x) => x.kind === "missing-hook-path");
    expect(missing).toHaveLength(1);
    expect(String(missing[0]?.missing)).toContain("release-guard.mjs");
    const err = recs.find((x) => x.kind === "hook-non-blocking-error");
    expect(err?.session).toBe("w-s4");
    expect(err?.count).toBe(30);
    expect(recs.some((x) => x.kind === "hook-runs")).toBe(true);
  });
  it("first-prompts, listings and session work and respect --limit", () => {
    const fp = node(s(), "first-prompts", "--limit", "2").stdout.trim().split("\n");
    expect(fp).toHaveLength(2);
    expect(JSON.parse(fp[0] as string).prompt).toBeTruthy();
    expect(node(s(), "listings", "--limit", "1").stdout).toContain("skill_listing");
    const sess = node(s(), "session", "w-s5").stdout.trim().split("\n");
    expect(sess).toHaveLength(60);
    expect(JSON.parse(sess[0] as string).tools).toEqual(["Bash"]);
  });
  it("is bounded: output stops at the line cap", () => {
    const root = path.join(tmp, "big", "ws");
    fs.mkdirSync(root, { recursive: true });
    const rec = (i: number) =>
      JSON.stringify({
        type: "assistant",
        sessionId: "big",
        timestamp: `2026-10-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
        message: { model: "m", usage: {}, content: [] },
      });
    fs.writeFileSync(
      path.join(root, "big.jsonl"),
      `${Array.from({ length: 400 }, (_, i) => rec(i)).join("\n")}\n`,
    );
    const r = node(s(), "session", "big", "--root", path.join(tmp, "big"));
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(301);
    expect(lines[300]).toContain("output truncated");
  });
});

describe("render.mjs (U4b): findings.json to report.html", () => {
  const finding = (over: Record<string, unknown>) => ({
    signal: "S4",
    title: "Idle cache rebuild",
    instances: 12,
    usd_low: 1,
    usd_high: 2,
    method: "cache write minus cache read on turns after a gap over the TTL",
    verified_by: "DB",
    low_n: false,
    fix: { type: "Install", summary: "Add a hook", content: '{"hooks":{}}' },
    evidence: [{ label: "Turns after a gap", query: "SELECT 1", output: "| n |\n| 12 |" }],
    ...over,
  });
  const findings = {
    window: { start: "2026-09-08", end: "2026-10-06" },
    total_spend_usd: 1234.5,
    pricing_basis: "API list price",
    turns: 396,
    findings: [
      finding({ title: "Small one", usd_low: 0.5, usd_high: 1.5 }),
      finding({ title: "Broken hook <script>alert(1)</script>", usd_low: null, usd_high: null }),
      finding({ title: "Big one", usd_low: 10, usd_high: 308.625, instances: 12345 }),
    ],
    nothing_found: [{ signal: "S9", name: "Hook latency", note: "not measurable: no hook runs" }],
  };
  const dir = () => path.join(tmp, "render");
  const r = () => path.join(out, "render.mjs");

  beforeAll(() => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), "findings.json"), JSON.stringify(findings));
  });

  it("ranks by high-end $ with unpriced (broken) findings last, and shows % of spend", () => {
    const res = node(r(), dir());
    expect(res.status, res.stderr).toBe(0);
    const html = fs.readFileSync(path.join(dir(), "report.html"), "utf8");
    const big = html.indexOf("Big one");
    const small = html.indexOf("Small one");
    const broken = html.indexOf("Broken hook");
    expect(big).toBeGreaterThan(-1);
    expect(big).toBeLessThan(small);
    expect(small).toBeLessThan(broken);
    expect(html).toContain("$10.00–$308.63");
    expect(html).toContain("25.0%");
    expect(html).toContain("Hook latency");
    expect(html).toContain("Total spend $1,234.50");
    expect(html).toContain("12,345 instances");
  });

  it("escapes content, gives each fix a copy button, and collapses evidence", () => {
    const html = fs.readFileSync(path.join(dir(), "report.html"), "utf8");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html.match(/data-copy=/g)).toHaveLength(3);
    expect(html.match(/<details/g)).toHaveLength(3);
    expect(html).toMatch(/<details[^>]*>\s*<summary>[^<]*Evidence/);
  });

  it("fails with the field name when findings.json is malformed", () => {
    const bad = path.join(tmp, "render-bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(
      path.join(bad, "findings.json"),
      JSON.stringify({ ...findings, findings: [finding({ fix: undefined })] }),
    );
    const res = node(r(), bad);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("findings[0].fix");
    expect(fs.existsSync(path.join(bad, "report.html"))).toBe(false);
  });

  it.each([
    ["findings[0].evidence[0]", { findings: [finding({ evidence: [null] })] }],
    ["nothing_found[0]", { nothing_found: [null] }],
  ])("fails with %s named when a list entry is null", (field, over) => {
    const bad = path.join(tmp, `render-null-${field.replace(/\W/g, "")}`);
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "findings.json"), JSON.stringify({ ...findings, ...over }));
    const res = node(r(), bad);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(field);
  });

  it("the shipped prompt asks for findings.json and the render step", () => {
    const shipped = fs.readFileSync(path.join("src", "cli", "audit", "prompt.md"), "utf8");
    expect(shipped).toContain("{{AUDIT_DIR}}/findings.json");
    expect(shipped).toContain("node {{AUDIT_DIR}}/render.mjs {{AUDIT_DIR}}");
    // S1's fix shape: never a mid-session model switch (U4b review).
    expect(shipped).toContain("never a mid-session `/model` switch");
  });
});

describe("SEC-101 content scan over generated synthetic packs", () => {
  it("raw-content scan finds nothing in the generated audit files", () => {
    const targets = [
      ...["pack.md", "schema.md", "prompt.md", "query.mjs", "scan.mjs", "render.mjs"].map((f) =>
        path.join(out, f),
      ),
    ];
    for (const t of targets) {
      const text = decodeText(fs.readFileSync(t));
      if (text === null) continue;
      expect(rawContentReasons(text, path.basename(t)), t).toEqual([]);
    }
  });
});
