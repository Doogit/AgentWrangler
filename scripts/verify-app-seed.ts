/**
 * Seed script for verify-app.mjs.
 * Spawned by: node --import tsx/esm scripts/verify-app-seed.ts <dbPath>
 * Writes 1 000-turn synthetic aggregate history (SEC-101 safe, no transcript text).
 */
import { runMigrations } from "../src/db/migrate.js";
import { openDb } from "../src/db/open.js";
import { seedSyntheticHistory } from "./benchmark/synthetic-fixture.js";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("verify-app-seed: missing <dbPath>");
  process.exit(1);
}

const db = openDb(dbPath);
runMigrations(db);
seedSyntheticHistory(db, 1_000);
db.close();
process.stdout.write("seed-ok\n");
