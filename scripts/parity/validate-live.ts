/** Read-only, structural validation report for recommendation actions. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { listRecommendations } from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";

const dbFlag = process.argv.indexOf("--db");
const dbPath = dbFlag >= 0 ? process.argv[dbFlag + 1] : undefined;
if (!dbPath || dbFlag !== 2 || process.argv.length !== 4) {
  throw new Error("Usage: tsx scripts/parity/validate-live.ts --db <path>");
}

function safeId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

function reasonCode(reason: string): string {
  if (reason === "target metric mismatch or missing") return "MISSING_OR_MISMATCHED_TARGET_METRIC";
  if (reason.includes("settings key")) return "UNKNOWN_SETTINGS_KEY";
  if (reason.includes("file_ref") || reason.includes("target file")) return "UNRESOLVED_FILE";
  if (reason.includes("hook")) return "INVALID_HOOK";
  if (reason.includes("permission")) return "PERMISSION_CONFLICT";
  if (reason.includes("settings")) return "INVALID_SETTINGS_ARTIFACT";
  return "OTHER_VALIDATION_FAILURE";
}

// listRecommendations() refreshes expired dismissal state. Run that query on a
// disposable SQLite backup so the live DB remains strictly read-only.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-validate-live-"));
const snapshotPath = path.join(tempDir, "snapshot.sqlite");
try {
  const sourceDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(snapshotPath);
  } finally {
    sourceDb.close();
  }
  const db = new Database(snapshotPath, { fileMustExist: true });
  try {
    setQueryDb(db);
    const response = listRecommendations();
    if (!response.data) throw new Error("Recommendation query returned no data");
    const groups = [
      ["active", response.data.active],
      ["limit_warning", response.data.limit_warnings],
      ["adopted", response.data.adopted],
      ["dismissed", response.data.dismissed],
      ["history", response.data.history],
    ] as const;
    let actions = 0;
    let failed = 0;
    let missingMetric = 0;
    const rows: string[] = [];
    for (const [group, cards] of groups) {
      for (const card of cards) {
        if (!card.actions) {
          rows.push(`| ${safeId(card.rec_id)} | ${group} | none | NO_ACTION |`);
          continue;
        }
        for (const action of [card.actions.primary, ...card.actions.alternatives]) {
          actions++;
          if (!action.target_metric) missingMetric++;
          const verdict =
            action.option_id === card.actions.primary.option_id
              ? card.action_validation?.primary
              : card.action_validation?.alternatives[action.option_id];
          const outcome =
            verdict?.ok === true
              ? "PASS"
              : verdict?.ok === false
                ? reasonCode(verdict.reason)
                : "MISSING_VALIDATION";
          if (outcome !== "PASS") failed++;
          rows.push(
            `| ${safeId(card.rec_id)} | ${group} | ${safeId(action.option_id)} | ${outcome} |`,
          );
        }
      }
    }
    process.stdout.write(
      [
        "# Live recommendation action validation",
        "",
        `Recommendations: ${groups.reduce((sum, [, cards]) => sum + cards.length, 0)}`,
        `Actions: ${actions}; failed: ${failed}; missing target_metric: ${missingMetric}`,
        "",
        "| Recommendation hash | State group | Option hash | Result |",
        "| --- | --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
    );
  } finally {
    resetQueryDb();
    db.close();
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
