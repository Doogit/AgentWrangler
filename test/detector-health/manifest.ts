/**
 * test/detector-health/manifest.ts — fail-closed loader for per-detector health manifests.
 * Reads <root>/<ID>/manifest.json for every detector dir. Any malformed manifest throws.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DETECTORS } from "../../src/detector/registry.js";

/** Non-transcript tables a case may seed via its `rows` file (`{table: [row, ...]}`). */
export const ROW_TABLES = [
  "limit_snapshots",
  "work_items",
  "observed_outcomes",
  "session_work_links",
  "catalog_items",
  "context_inventory",
  "user_config", // includes key 'per_model_snapshot' (D4); its JSON value is not time-shifted
  "pricing_snapshots",
] as const;
export type RowTable = (typeof ROW_TABLES)[number];
export type CaseRows = Partial<Record<RowTable, Record<string, unknown>[]>>;

/** A case input: a transcript fixture dir, a rows file, or both. */
export interface CaseInput {
  fixture?: string;
  /** Absolute transcript dir (has .jsonl), when `fixture` is set. */
  fixtureDir?: string;
  rows?: string;
  /** Absolute path to the rows JSON, when `rows` is set. */
  rowsFile?: string;
}

export interface DetectorHealthCase {
  id: string;
  /** Absolute dir of the detector (<root>/<ID>). */
  dir: string;
  positive: CaseInput & { expect: "fires" };
  /** From `near_miss` (one) or `near_misses` (one per threshold of a conjunctive trigger). */
  near_misses: (CaseInput & { target_constant: string; expect: "silent" })[];
}

export const DEFAULT_FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/detector-health",
);

function fail(id: string, msg: string): never {
  throw new Error(`detector-health manifest ${id}: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveFixture(dir: string, id: string, label: string, fixture: unknown): string {
  if (typeof fixture !== "string" || fixture === "")
    fail(id, `${label}.fixture must be a non-empty string`);
  const fixtureDir = path.resolve(dir, fixture);
  if (!fs.existsSync(fixtureDir) || !fs.statSync(fixtureDir).isDirectory()) {
    fail(id, `${label}.fixture dir missing: ${fixture}`);
  }
  if (!fs.readdirSync(fixtureDir).some((f) => f.endsWith(".jsonl"))) {
    fail(id, `${label}.fixture dir has no .jsonl: ${fixture}`);
  }
  return fixtureDir;
}

/** Validate a rows file: `{table: [row, ...]}` with known tables and object rows. */
export function readRows(file: string, id = path.basename(file)): CaseRows {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail(id, `rows ${path.basename(file)}: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) fail(id, "rows file must be an object of {table: [rows]}");
  const allowed = new Set<string>(ROW_TABLES);
  for (const [table, rows] of Object.entries(raw)) {
    if (!allowed.has(table)) fail(id, `rows: unknown table ${JSON.stringify(table)}`);
    if (!Array.isArray(rows) || rows.length === 0 || !rows.every(isRecord)) {
      fail(id, `rows.${table} must be a non-empty array of objects`);
    }
  }
  return raw as CaseRows;
}

function resolveInput(
  dir: string,
  id: string,
  label: string,
  c: Record<string, unknown>,
): CaseInput {
  if (c.fixture === undefined && c.rows === undefined) fail(id, `${label} needs fixture or rows`);
  const input: CaseInput = {};
  if (c.fixture !== undefined) {
    input.fixture = c.fixture as string;
    input.fixtureDir = resolveFixture(dir, id, label, c.fixture);
  }
  if (c.rows !== undefined) {
    if (typeof c.rows !== "string" || c.rows === "")
      fail(id, `${label}.rows must be a non-empty string`);
    const rowsFile = path.resolve(dir, c.rows);
    if (!fs.existsSync(rowsFile)) fail(id, `${label}.rows file missing: ${c.rows}`);
    readRows(rowsFile, id);
    input.rows = c.rows;
    input.rowsFile = rowsFile;
  }
  return input;
}

export function loadManifests(root: string = DEFAULT_FIXTURES_ROOT): DetectorHealthCase[] {
  if (!fs.existsSync(root)) return [];
  const known = new Set(DETECTORS.map((d) => d.id));
  const cases: DetectorHealthCase[] = [];
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of dirs) {
    const dir = path.join(root, name);
    const file = path.join(dir, "manifest.json");
    if (!fs.existsSync(file)) fail(name, "manifest.json missing");
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      fail(name, `invalid JSON (${(e as Error).message})`);
    }
    if (!isRecord(raw)) fail(name, "manifest must be an object");
    if (raw.id !== name) fail(name, `id ${JSON.stringify(raw.id)} does not match dir name`);
    if (!known.has(name)) fail(name, "unknown detector id (not in registry)");
    const { positive, near_miss, near_misses } = raw;
    if (!isRecord(positive)) fail(name, "positive missing");
    if (positive.expect !== "fires") fail(name, 'positive.expect must be "fires"');
    if (near_miss !== undefined && near_misses !== undefined) {
      fail(name, "use near_miss or near_misses, not both");
    }
    // `near_misses` is for conjunctive triggers: one near miss per named threshold.
    const list: [string, unknown][] =
      near_misses === undefined
        ? [["near_miss", near_miss]]
        : Array.isArray(near_misses) && near_misses.length > 0
          ? near_misses.map((n, i) => [`near_misses[${i}]`, n])
          : fail(name, "near_misses must be a non-empty array");
    cases.push({
      id: name,
      dir,
      positive: { ...resolveInput(dir, name, "positive", positive), expect: "fires" },
      near_misses: list.map(([label, n]) => {
        if (!isRecord(n)) fail(name, `${label} missing`);
        if (n.expect !== "silent") fail(name, `${label}.expect must be "silent"`);
        if (typeof n.target_constant !== "string" || n.target_constant === "") {
          fail(name, `${label}.target_constant required`);
        }
        return {
          ...resolveInput(dir, name, label, n),
          target_constant: n.target_constant,
          expect: "silent",
        };
      }),
    });
  }
  return cases;
}
