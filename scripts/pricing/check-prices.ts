/**
 * scripts/pricing/check-prices.ts — dev-side price check (PRICE-O55-F2). Never run by the daemon.
 *
 * Fetches the official pricing page (markdown variant), parses the model price
 * table and diffs it against LIST_PRICES + KNOWN_MODELS in src/ingest/pricing.ts.
 *
 *   npx tsx scripts/pricing/check-prices.ts [--file <saved-copy.md>]
 *
 * Exit 0 = match · 1 = difference · 2 = fetch/parse failure (never a silent pass).
 *
 * Rules:
 *  - Retired models (page marks the row "retired"/"deprecated") are skipped, except that a
 *    KNOWN_MODELS id still counts as present on the page.
 *  - ERROR (exit 1): a page price differs from the tier price; a KNOWN_MODELS id is absent
 *    from the page; a KNOWN_MODELS tier has no LIST_PRICES row.
 *  - WARNING (exit 0 alone): a current page model is not in KNOWN_MODELS but its price matches
 *    the tier modelTier() gives it (priced correctly, just unconfirmed); or modelTier() cannot
 *    price it at all (also warned, since it would be $0).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWN_MODELS,
  LIST_PRICES,
  LONG_PROMPT_TIERS,
  modelTier,
} from "../../src/ingest/pricing.js";

const PAGE_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
const MIN_MODELS = 5;
const EPS = 1e-9;

/** [input, output, cacheRead, cacheWrite5m, cacheWrite1h] $/MTok, same order as LIST_PRICES. */
export type PagePrices = [number, number, number, number, number];

export interface PageModel {
  id: string;
  name: string;
  retired: boolean;
  prices: PagePrices;
  /** The page's "(for prompts over N tokens)" row: compared to the tier's LONG_PROMPT_TIERS tier. */
  longPrompt?: boolean;
}

export class ParseError extends Error {}

function cellText(raw: string): string {
  return raw
    .replace(/<sup>.*?<\/sup>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dollars(raw: string): number {
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(raw);
  if (m?.[1] === undefined) throw new ParseError(`no $ price in cell: ${raw.trim()}`);
  return Number(m[1].replace(/,/g, ""));
}

/** "Claude Opus 5.5" -> "claude-opus-5-5". */
function pageNameToId(name: string): string {
  const m = /^Claude (\w+) (\d+(?:\.\d+)*)$/.exec(name);
  if (m?.[1] === undefined || m[2] === undefined) {
    throw new ParseError(`unrecognized model name: ${name}`);
  }
  return `claude-${m[1].toLowerCase()}-${m[2].replace(/\./g, "-")}`;
}

/** Parse the model price table (the first table whose header has "Base input"). */
export function parsePricePage(text: string): PageModel[] {
  const lines = text.split(/\r?\n/);
  const split = (l: string): string[] =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const h = lines.findIndex((l) => l.startsWith("|") && /base input/i.test(l));
  if (h < 0) throw new ParseError("price table header (Base input) not found");
  const header = split(lines[h] ?? "");
  const col = (re: RegExp): number => {
    const i = header.findIndex((c) => re.test(c));
    if (i < 0) throw new ParseError(`price table column not found: ${re}`);
    return i;
  };
  const ci = {
    input: col(/base input/i),
    w5: col(/5m/i),
    w1: col(/1h/i),
    read: col(/cache hit|cache read/i),
    output: col(/output/i),
  };
  const models: PageModel[] = [];
  for (let i = h + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("|")) break;
    const cells = split(line);
    const first = cells[0] ?? "";
    const get = (idx: number): number => dollars(cells[idx] ?? "");
    const name = cellText(first);
    models.push({
      id: pageNameToId(name),
      name,
      retired: /retired|deprecated/i.test(first),
      prices: [get(ci.input), get(ci.output), get(ci.read), get(ci.w5), get(ci.w1)],
      ...(/prompts over/i.test(first) ? { longPrompt: true } : {}),
    });
  }
  if (models.length < MIN_MODELS) {
    throw new ParseError(`only ${models.length} models parsed (expected at least ${MIN_MODELS})`);
  }
  return models;
}

/** A KNOWN_MODELS id matches a page id exactly or as a dated id (`<page-id>-YYYYMMDD`). */
function knownIdFor(pageId: string): string | undefined {
  return Object.keys(KNOWN_MODELS).find(
    (k) => k === pageId || new RegExp(`^${pageId}-\\d{8}$`).test(k),
  );
}

const NAMES = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

export function checkPrices(models: PageModel[]): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const present = new Set<string>();
  for (const m of models) {
    const known = knownIdFor(m.id);
    if (known !== undefined) present.add(known);
    if (m.retired) continue;
    const baseTier = known !== undefined ? KNOWN_MODELS[known] : modelTier(m.id);
    if (baseTier === undefined || baseTier === null) {
      warnings.push(`${m.id} (${m.name}): not in KNOWN_MODELS and modelTier() cannot price it`);
      continue;
    }
    const tier = m.longPrompt === true ? LONG_PROMPT_TIERS[baseTier]?.tier : baseTier;
    if (tier === undefined) {
      errors.push(`${m.id}: page has a long-prompt price but tier "${baseTier}" has none`);
      continue;
    }
    const list = LIST_PRICES[tier];
    if (list === undefined) {
      errors.push(`${m.id}: tier "${tier}" has no LIST_PRICES row`);
      continue;
    }
    m.prices.forEach((page, i) => {
      if (Math.abs(page - (list[i] ?? Number.NaN)) > EPS) {
        errors.push(
          `${m.id}: tier "${tier}" ${NAMES[i]} is $${list[i]}/MTok in LIST_PRICES, page says $${page}`,
        );
      }
    });
    if (known === undefined) {
      warnings.push(
        `${m.id} (${m.name}): not in KNOWN_MODELS (priced as "${tier}", price matches)`,
      );
    }
  }
  for (const id of Object.keys(KNOWN_MODELS)) {
    if (!present.has(id)) errors.push(`${id}: in KNOWN_MODELS but absent from the price page`);
  }
  return { errors, warnings };
}

async function loadPage(args: string[]): Promise<string> {
  const f = args.indexOf("--file");
  if (f >= 0) {
    const path = args[f + 1];
    if (path === undefined) throw new Error("--file needs a path");
    return readFileSync(path, "utf8");
  }
  const res = await fetch(PAGE_URL);
  if (!res.ok) throw new Error(`GET ${PAGE_URL} -> HTTP ${res.status}`);
  return res.text();
}

async function main(): Promise<number> {
  let models: PageModel[];
  try {
    models = parsePricePage(await loadPage(process.argv.slice(2)));
  } catch (e) {
    console.error(`check-prices: FAILED to fetch/parse: ${(e as Error).message}`);
    return 2;
  }
  const { errors, warnings } = checkPrices(models);
  console.log(`check-prices: parsed ${models.length} models from the price page`);
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`DIFF  ${e}`);
  if (errors.length > 0) {
    console.log(
      `check-prices: ${errors.length} difference(s). Follow spec step 4 (docs/plans/2026-10-01-price-tier-fix-spec.md).`,
    );
    return 1;
  }
  console.log(`check-prices: OK (LIST_PRICES + KNOWN_MODELS match; ${warnings.length} warning(s))`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // exitCode (not process.exit) so Windows can close the fetch handle cleanly.
  main().then((code) => {
    process.exitCode = code;
  });
}
