/**
 * scripts/rr/build-audit-fixtures.ts — build the three synthetic audit folders (pro, apikey, waste).
 * Run: npx tsx scripts/rr/build-audit-fixtures.ts
 *
 * Each profile: fresh temp DB (normal migrations + the profile seeder), synthetic JSONL (+ settings for
 * waste), then the real audit generator into <OUT>/fixtures/<profile>/. The waste answer key is written
 * OUTSIDE the repo to <OUT>/answer-key.md; it is the held-out oracle, so it never enters src/ or the prompt.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generateAudit } from "../../src/cli/audit/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";
import {
  WASTE_PROFILE,
  seedApiKeyProfile,
  seedProProfile,
  seedWasteProfile,
} from "../../test/fixtures/seed.js";
import { writeSyntheticJsonl, writeWasteFiles } from "../../test/fixtures/synthetic-jsonl.js";

const OUT = path.join(os.homedir(), ".agentwrangler", "research", "2026-10-05-rec-reset", "u4");
const NOW = new Date("2026-10-06T12:00:00.000Z");
const here = path.dirname(fileURLToPath(import.meta.url));
const realPrompt = path.resolve(here, "..", "..", "src", "cli", "audit", "prompt.md");

async function build(profile: "pro" | "apikey" | "waste"): Promise<string> {
  const work = path.join(OUT, "_work", profile);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const dbPath = path.join(work, "src.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  // Synthetic inputs live next to the audit (scan.mjs reads them; settings.json is for --settings).
  const inputs = path.join(OUT, "fixtures", `${profile}-inputs`);
  fs.rmSync(inputs, { recursive: true, force: true });
  fs.mkdirSync(inputs, { recursive: true });
  let jsonlRoot = path.join(inputs, "projects");
  if (profile === "pro") seedProProfile(db, NOW);
  else if (profile === "apikey") seedApiKeyProfile(db, NOW);
  else seedWasteProfile(db, NOW);
  if (profile === "waste") jsonlRoot = writeWasteFiles(db, inputs).jsonlRoot;
  else writeSyntheticJsonl(db, jsonlRoot);
  db.close();

  let promptPath = realPrompt;
  if (!fs.existsSync(promptPath)) {
    promptPath = path.join(work, "prompt-stub.md");
    fs.writeFileSync(
      promptPath,
      "STUB prompt (real prompt.md not present). Audit dir: {{AUDIT_DIR}}\n",
    );
  }
  // Point scan.mjs at the profile's own settings so a fixture run never reads the real ~/.claude/settings.json.
  const settings = path.join(inputs, "settings.json");
  if (!fs.existsSync(settings)) fs.writeFileSync(settings, "{}\n");
  const out = path.join(OUT, "fixtures", profile);
  await generateAudit({ db: dbPath, out, jsonlRoot, days: 28, promptPath, settingsFiles: [settings] });
  return out;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of ["pro", "apikey", "waste"] as const) {
    const out = await build(p);
    console.log(`${p}: ${out}`);
  }
  // Answer key: shares computed from the audit copy of the waste DB.
  const Database = (await import("better-sqlite3")).default;
  const wdb = new Database(path.join(OUT, "fixtures", "waste", "db.sqlite"), { readonly: true });
  const total = (wdb.prepare("SELECT SUM(cost_equiv_u) AS u FROM turns").get() as { u: number }).u;
  const sess = (id: string) =>
    (
      wdb.prepare("SELECT SUM(cost_equiv_u) AS u FROM turns WHERE session_id = ?").get(id) as {
        u: number;
      }
    ).u;
  const w3Writes = (
    wdb
      .prepare(
        `SELECT SUM(t.cache_write_1h * json_extract(p.unit_prices_json, '$[4]')) AS u
           FROM turns t JOIN pricing_snapshots p ON p.snapshot_id = t.pricing_snapshot_id WHERE t.session_id = 'w-s3'`,
      )
      .get() as { u: number }
  ).u;
  const pct = (u: number) => `${((100 * u) / total).toFixed(1)}%`;
  const row = (id: string, label: string, extra = "") =>
    `| ${label} | ${id} | $${(sess(id) / 1e6).toFixed(2)} | ${pct(sess(id))} | ${extra} |`;
  const key = `# U4 waste profile answer key (HELD OUT: never give this to the prompt writer or the audit agent)

Profile total: $${(total / 1e6).toFixed(2)} (28-day window ends at the latest turn). Workspace slug: ${WASTE_PROFILE.slug}.
Baseline session w-s0 ("${WASTE_PROFILE.sessions[0].title}") is normal Sonnet work and is NOT a waste.

| Waste | Session | $ in session | Share | Where it shows |
|---|---|---|---|---|
${row("w-s1", "W1 oversized subagent", "agent agent-w1-big (general-purpose): 150 turns, ~395k context each. S6 / S6 by type")}
${row("w-s2", "W2 Opus reviewer fan-out", "12 agents agent-w2-rev0..11 (reviewer) on claude-opus-5, 6 short turns each. S6 by type and model")}
${row("w-s3", "W3 idle cache rebuilds", `14 main turns after 2 h gaps, each writes ~200k 1h cache; cache-write $${(w3Writes / 1e6).toFixed(2)}. S4`)}
${row("w-s4", "W4 broken hook path", "settings hook `node .../hooks/release-guard.mjs` does not exist; 30 hook_non_blocking_error attachments in the JSONL (scan.mjs hooks); 30 shell ERROR calls in the DB (S14). Raw-only signal: `scan.mjs hooks` is the only way to see the hook itself")}
${row("w-s5", "W5 Opus mechanical turns", "60 claude-opus-5 main turns, one git/npm Bash call each, ~2.5k output + 2k thinking. S15 / S1")}

A correct finding names the instance (session or agent id), gives $ within a sensible range, and ends in a fix:
W1 cap the agent (turn/context limit or split the task); W2 set the reviewer agents' model to Sonnet/Haiku;
W3 keep the session warm or start fresh instead of resuming after long gaps (or use the 1h cache deliberately);
W4 fix or remove the hook command path in settings; W5 route mechanical git/npm turns to a cheaper model.
Bar: at least 4 of 5 found with a fix.
`;
  fs.writeFileSync(path.join(OUT, "answer-key.md"), key);
  for (const [id, label] of [
    ["w-s1", "W1"],
    ["w-s2", "W2"],
    ["w-s3", "W3"],
    ["w-s4", "W4"],
    ["w-s5", "W5"],
  ] as const) {
    const share = (100 * sess(id)) / total;
    console.log(`${label} ${id} share ${share.toFixed(1)}%${share < 5 ? "  <-- BELOW 5%" : ""}`);
  }
  wdb.close();
  fs.rmSync(path.join(OUT, "_work"), { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
