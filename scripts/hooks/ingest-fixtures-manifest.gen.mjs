#!/usr/bin/env node
// Regenerate scripts/hooks/ingest-fixtures-manifest.json from the current
// committed ingest fixtures. Run ONLY after a deliberate, reviewed change to a
// test/fixtures/ingest/ file — the manifest diff is the reviewer's provenance
// checkpoint (SEC-101 W-A, ADR-112). Requires the change to be staged/committed
// so `git ls-files -s` reports the new blob SHA.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { committedFixtureEntries } from "./assert-ingest-fixtures.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const manifest = {};
for (const { file, sha } of committedFixtureEntries(root)) manifest[file] = sha;
const out = `${JSON.stringify(manifest, null, 2)}\n`;
fs.writeFileSync(path.join(root, "scripts/hooks/ingest-fixtures-manifest.json"), out, "utf8");
console.log(`Wrote manifest with ${Object.keys(manifest).length} fixture(s).`);
