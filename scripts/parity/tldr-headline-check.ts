/**
 * P3.L-F D2 - independent oracle for "the TL;DR quotes the headline $".
 * Contract: docs/plans/Archive/2026-10-03-tldr-headline-spec.md. Written from the spec alone; no src/ imports.
 *
 *   npx tsx scripts/parity/tldr-headline-check.ts --cards <cards.json>
 *   npx tsx scripts/parity/tldr-headline-check.ts --self-test
 *
 * I1  TL;DR $ clause matches the spec table (legacy cards, alloc absent, are skipped).
 * I2  every number in the TL;DR appears among the numbers in problem + facts values.
 * I3  every quoted $ is present in the problem; a spec reconcile sentence in the problem carries the
 *     headline $, and appears only when the TL;DR quotes that $ (alloc / rel respectively).
 *
 * Exit 0 = all hold; 1 = violations (or a surviving mutation); 2 = bad flags/inputs.
 */
import fs from "node:fs";

// biome-ignore lint/suspicious/noExplicitAny: cards.json is untrusted JSON
type Json = any;
type Inv = "I1" | "I2" | "I3";
interface Violation {
  rec_id: string;
  detector: string;
  invariant: Inv;
  expected: string;
  actual: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const money = (u: number): string => `$${(u / 1e6).toFixed(2)}`;
/** A $ amount shows as more than $0.00 (after the same rounding as the meter). */
const shownPositive = (u: number): boolean => Number((u / 1e6).toFixed(2)) > 0;

const SAVES = (m: string) => ` Fixing it saves about ${m} a week.`;
const FAILS = (m: string) => ` The failures cost up to ${m} a week.`;
const ALLOC_SENTENCE = (m: string) => ` After overlap with other cards, this card's share is ${m} a week.`;
const REL_SENTENCE = (m: string) => ` The turns after these failures cost up to ${m} a week.`;

const NUM_RE = /\d+(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?/g;
const DOLLAR_RE = /\$\d+(?:,\d{3})*(?:\.\d+)?/g;
const ALLOC_SENTENCE_RE = /After overlap with other cards, this card's share is (\$\d+(?:,\d{3})*(?:\.\d+)?) a week\./g;
const REL_SENTENCE_RE = /The turns after these failures cost up to (\$\d+(?:,\d{3})*(?:\.\d+)?) a week\./g;

const numbersOf = (s: string): string[] =>
  (s.match(NUM_RE) ?? []).map((n) => n.replace(/,/g, ""));
const dollarsOf = (s: string): string[] => s.match(DOLLAR_RE) ?? [];
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Expected clause for a card, or "legacy" (skip). Re-review N4 (operator 2026-10-05): a numeric
 * allocated above the card's range_u_per_wk shows the range only, so the clause quotes "$lo–$hi";
 * `ms` lists the $ amounts the TL;DR may quote.
 */
function expectedClause(c: Json): {
  kind: "saves" | "fails" | "none" | "legacy";
  text: string;
  m: string;
  ms: string[];
} {
  const alloc = c.allocated_u_per_wk;
  const rel = c.reliability_u_per_wk;
  const range = c.range_u_per_wk;
  if (alloc === undefined) return { kind: "legacy", text: "", m: "", ms: [] };
  if (isNum(alloc) && Array.isArray(range) && isNum(range[0]) && isNum(range[1]) && alloc > range[1]) {
    const m = `${money(range[0])}–${money(range[1])}`;
    return { kind: "saves", text: SAVES(m), m, ms: [money(range[0]), money(range[1])] };
  }
  const one = (k: "saves" | "fails" | "none", text: string, m: string) => ({ kind: k, text, m, ms: m ? [m] : [] });
  if (isNum(alloc)) {
    if (shownPositive(alloc)) return one("saves", SAVES(money(alloc)), money(alloc));
    return one("none", "", "");
  }
  if (alloc === null && isNum(rel) && shownPositive(rel))
    return one("fails", FAILS(money(rel)), money(rel));
  return one("none", "", "");
}

export function checkCard(c: Json): Violation[] {
  const out: Violation[] = [];
  const base = { rec_id: String(c.rec_id), detector: String(c.detector_id) };
  const v = (invariant: Inv, expected: string, actual: string) =>
    out.push({ ...base, invariant, expected, actual });
  const trig = c.trigger ?? {};
  const summary = str(trig.summary);
  const problem = str(trig.problem);
  const factsText = (Array.isArray(trig.facts) ? trig.facts : [])
    .map((f: Json) => str(f?.value))
    .join(" ");
  const exp = expectedClause(c);
  const quoted = dollarsOf(summary);
  const hasSaves = /saves about/.test(summary);
  const hasFails = /failures cost up to/.test(summary);

  // I1
  if (exp.kind === "saves") {
    if (!summary.includes(exp.text))
      v("I1", `clause "${exp.text.trim()}"`, `summary "${summary}"`);
    else if (hasFails || quoted.some((d) => !exp.ms.includes(d)))
      v("I1", `only ${exp.m} quoted, saves clause`, `quoted ${quoted.join(", ")}; summary "${summary}"`);
  } else if (exp.kind === "fails") {
    if (!summary.includes(exp.text))
      v("I1", `clause "${exp.text.trim()}"`, `summary "${summary}"`);
    else if (hasSaves || quoted.some((d) => d !== exp.m))
      v("I1", `only ${exp.m} quoted, failures wording`, `quoted ${quoted.join(", ")}; summary "${summary}"`);
  } else if (exp.kind === "none") {
    if (quoted.length > 0 || hasSaves || hasFails)
      v("I1", "no $ clause", `summary "${summary}"`);
  }

  // I2
  const backing = new Set(numbersOf(`${problem} ${factsText}`));
  const unbacked = [...new Set(numbersOf(summary))].filter((n) => !backing.has(n));
  if (unbacked.length > 0)
    v("I2", "every TL;DR number in problem or facts", `unbacked: ${unbacked.join(", ")}`);

  // I3
  const missing = [...new Set(quoted)].filter((d) => !problem.includes(d));
  if (missing.length > 0) v("I3", "quoted $ present in problem", `missing: ${missing.join(", ")}`);
  const allocHits = [...problem.matchAll(ALLOC_SENTENCE_RE)].map((m) => m[1] ?? "");
  const relHits = [...problem.matchAll(REL_SENTENCE_RE)].map((m) => m[1] ?? "");
  if (exp.kind !== "legacy") {
    for (const d of allocHits)
      if (exp.kind !== "saves" || d !== exp.m)
        v("I3", exp.kind === "saves" ? `alloc sentence with ${exp.m}` : "no alloc sentence", `alloc sentence with ${d}`);
    for (const d of relHits)
      if (exp.kind !== "fails" || d !== exp.m)
        v("I3", exp.kind === "fails" ? `reliability sentence with ${exp.m}` : "no reliability sentence", `reliability sentence with ${d}`);
  }
  return out;
}

export function checkCards(cards: Json[]): { violations: Violation[]; legacy: number; checked: number } {
  const violations: Violation[] = [];
  let legacy = 0;
  for (const c of cards) {
    if (c.allocated_u_per_wk === undefined) legacy++;
    violations.push(...checkCard(c));
  }
  return { violations, legacy, checked: cards.length };
}

// Self-test

const mk = (patch: Json): Json => ({
  rec_id: "r",
  detector_id: "D2",
  modeled_savings_u_per_wk: 99_000_000,
  ...patch,
  trigger: {
    summary: "",
    problem: "Seven turns re-read 12,000 tokens.",
    facts: [{ label: "turns", value: "7" }],
    ...(patch.trigger ?? {}),
  },
});

/** One correct card per spec-table case. */
const GOOD: Record<string, Json> = {
  "alloc > 0 (appended sentence)": mk({
    allocated_u_per_wk: 28_790_000,
    trigger: {
      summary: `Seven turns re-read 12,000 tokens.${SAVES("$28.79")}`,
      problem: `Seven turns re-read 12,000 tokens.${ALLOC_SENTENCE("$28.79")}`,
    },
  }),
  "alloc > 0 (problem already has the $)": mk({
    allocated_u_per_wk: 18_040_000,
    trigger: {
      summary: `Seven turns.${SAVES("$18.04")}`,
      problem: "Seven turns cost $18.04 over the window.",
    },
  }),
  "alloc shows $0.00": mk({
    allocated_u_per_wk: 3_000,
    trigger: { summary: "Seven turns re-read 12,000 tokens." },
  }),
  "alloc 0": mk({ allocated_u_per_wk: 0, trigger: { summary: "Seven turns." } }),
  "alloc null, rel > 0": mk({
    allocated_u_per_wk: null,
    reliability_u_per_wk: 4_560_000,
    trigger: {
      summary: `Seven turns failed.${FAILS("$4.56")}`,
      problem: `Seven turns failed.${REL_SENTENCE("$4.56")}`,
    },
  }),
  "alloc null, rel $0.00": mk({
    allocated_u_per_wk: null,
    reliability_u_per_wk: 1_000,
    trigger: { summary: "Seven turns failed." },
  }),
  "alloc null, rel null": mk({
    allocated_u_per_wk: null,
    reliability_u_per_wk: null,
    trigger: { summary: "Seven turns failed." },
  }),
  "alloc null, rel absent": mk({ allocated_u_per_wk: null, trigger: { summary: "Seven turns." } }),
  "alloc above the range (N4): range clause": mk({
    allocated_u_per_wk: 2_590_000,
    range_u_per_wk: [87_457, 185_514],
    trigger: {
      summary: `Seven turns.${SAVES("$0.09–$0.19")}`,
      problem: "Seven turns. This fix is modeled to save $0.09–$0.19 a week.",
    },
  }),
  "legacy (alloc absent)": mk({
    trigger: { summary: "Seven turns. Fixing it saves about $1.57 a week.", problem: "Seven turns cost $1.57 standalone." },
  }),
};

const MUTATIONS: Array<{ name: string; card: Json }> = [
  {
    name: "(a) standalone $ in the clause instead of allocated",
    card: mk({
      allocated_u_per_wk: 28_790_000,
      trigger: {
        summary: `Seven turns.${SAVES("$28.95")}`,
        problem: `Seven turns.${ALLOC_SENTENCE("$28.79")}`,
      },
    }),
  },
  {
    name: "(b) reconcile sentence missing, TL;DR $ unbacked",
    card: mk({
      allocated_u_per_wk: 28_790_000,
      trigger: { summary: `Seven turns.${SAVES("$28.79")}`, problem: "Seven turns re-read 12,000 tokens." },
    }),
  },
  {
    name: "(c) clause present on a $0.00 headline",
    card: mk({
      allocated_u_per_wk: 0,
      trigger: {
        summary: `Seven turns.${SAVES("$0.46")}`,
        problem: "Seven turns cost $0.46 standalone.",
      },
    }),
  },
  {
    name: '(d) "saves about" wording on a reliability card',
    card: mk({
      allocated_u_per_wk: null,
      reliability_u_per_wk: 4_560_000,
      trigger: {
        summary: `Seven turns failed.${SAVES("$4.56")}`,
        problem: `Seven turns failed.${REL_SENTENCE("$4.56")}`,
      },
    }),
  },
  {
    name: "(e) D1 range instead of the point on a numeric headline",
    card: mk({
      allocated_u_per_wk: 10_300_000,
      trigger: {
        summary: "Seven turns. Fixing it saves about $1.57–$10.30 a week.",
        problem: `Seven turns.${ALLOC_SENTENCE("$10.30")} Range $1.57 to $10.30.`,
      },
    }),
  },
  {
    name: "(f) clause missing when alloc > 0",
    card: mk({
      allocated_u_per_wk: 28_790_000,
      trigger: { summary: "Seven turns re-read 12,000 tokens." },
    }),
  },
  {
    name: "(g) reconcile sentence quotes the wrong $",
    card: mk({
      allocated_u_per_wk: 28_790_000,
      trigger: {
        summary: `Seven turns.${SAVES("$28.79")}`,
        problem: `Seven turns. $28.79 is quoted elsewhere.${ALLOC_SENTENCE("$28.95")}`,
      },
    }),
  },
  {
    name: "(h) net $ quoted when alloc is above the range (N4)",
    card: mk({
      allocated_u_per_wk: 2_590_000,
      range_u_per_wk: [87_457, 185_514],
      trigger: {
        summary: `Seven turns.${SAVES("$2.59")}`,
        problem: `Seven turns.${ALLOC_SENTENCE("$2.59")}`,
      },
    }),
  },
];

function selfTest(): number {
  let bad = 0;
  for (const [name, card] of Object.entries(GOOD)) {
    const v = checkCard(card);
    const ok = v.length === 0;
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  good case: ${name}${ok ? "" : ` -- ${JSON.stringify(v)}`}`);
  }
  for (const m of MUTATIONS) {
    const v = checkCard(m.card);
    const killed = v.length > 0;
    if (!killed) bad++;
    console.log(
      `${killed ? "KILLED" : "SURVIVED"}  ${m.name}${killed ? ` [${[...new Set(v.map((x) => x.invariant))].join(",")}]` : ""}`,
    );
  }
  console.log(bad === 0 ? "SELF-TEST PASS" : `SELF-TEST FAIL (${bad})`);
  return bad === 0 ? 0 : 1;
}

// CLI

function usage(msg: string): never {
  console.error(`${msg}\nUsage: tldr-headline-check.ts --cards <cards.json> | --self-test`);
  process.exit(2);
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();
  const i = argv.indexOf("--cards");
  const p = i >= 0 ? argv[i + 1] : undefined;
  if (!p) usage("--cards <cards.json> or --self-test is required");
  if (!fs.existsSync(p)) usage(`file not found: ${p}`);
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(doc?.data?.active)) usage("cards.json has no data.active array");
  const r = checkCards(doc.data.active);
  for (const x of r.violations)
    console.log(`VIOLATION rec=${x.rec_id} detector=${x.detector} ${x.invariant}\n  expected: ${x.expected}\n  actual:   ${x.actual}`);
  console.log(
    `cards=${r.checked} legacy_skipped=${r.legacy} violations=${r.violations.length} ` +
      `by_invariant=${JSON.stringify(
        r.violations.reduce<Record<string, number>>((a, x) => ((a[x.invariant] = (a[x.invariant] ?? 0) + 1), a), {}),
      )}`,
  );
  console.log(r.violations.length === 0 ? "TLDR-HEADLINE-CHECK PASS" : "TLDR-HEADLINE-CHECK FAIL");
  return r.violations.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 2;
}
