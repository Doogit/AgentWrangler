/** Read-only certification wrapper. All persisted evidence is aggregate only. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  buildClaimLedger,
  conservationReport,
  laneCellKey,
} from "../../src/detector/claim-ledger.js";
import { DETECTOR_CONTRACTS } from "../../src/detector/contracts.js";
import { findHandler } from "../../src/effects/registry.js";
import {
  type RecommendationCard,
  listRecommendations,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { checkD2Quantity } from "./d2-quantity-oracle.js";
import { checkD8Quantity } from "./d8-quantity-oracle.js";
import { checkFriction } from "./friction-oracle.js";
import { checkPrefix, readBaselineEvidence, readMeasured } from "./prefix-oracle.js";

export const FULL_TIER_THRESHOLD_U_PER_WEEK = 5_000_000;
export type Verdict =
  | "PASS"
  | "FAIL"
  | "UNPROVEN"
  | "ESTIMATED"
  | "NOT_FIRING"
  | "SKIP"
  | "MISSING";
export type Step = { verdict: Verdict; counts?: Record<string, number | boolean> };
export type Steps = { tier: Step; C3: Step; C4: Step; C2: Step; C1: Step; C5a: Step };
type Window = { from: string; to: string };
type Options = {
  detectorId: string;
  db: string;
  from?: string;
  to?: string;
  measured?: string;
  dEvidence?: string;
  save?: boolean;
};

export function tierFor(
  valueU: number,
  modeledU: number | null,
  advisory = false,
): "Light" | "Full" {
  return advisory || modeledU === null || valueU < FULL_TIER_THRESHOLD_U_PER_WEEK
    ? "Light"
    : "Full";
}

export function exitFor(steps: Steps, tier: "Light" | "Full"): number {
  const required = [
    steps.tier,
    steps.C3,
    steps.C4,
    steps.C2,
    steps.C1,
    ...(tier === "Full" ? [steps.C5a] : []),
  ];
  if (required.some((step) => step.verdict === "FAIL")) return 1;
  if (required.some((step) => ["UNPROVEN", "MISSING", "NOT_FIRING"].includes(step.verdict)))
    return 3;
  if (tier === "Full" && steps.C1.verdict === "ESTIMATED") return 3;
  return 0;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const ABSOLUTE_PATH = /(?:[a-z]:[\\/]|\/(?:Users|home|tmp)(?:\/|\\))/i;
export function writeSafeReport(file: string, report: unknown): void {
  const json = JSON.stringify(report, null, 2);
  if (UUID.test(json) || ABSOLUTE_PATH.test(json))
    throw new Error("Certification report contains a private identifier or absolute path");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${json}\n`, { flag: "w" });
}

/**
 * Where the report goes: the repo's certification folder only with `--save` (the evidence a
 * certification commit cites); otherwise the OS temp folder, so a check run leaves nothing to delete.
 */
export function reportFile(detectorId: string, save: boolean, date: Date): string {
  return path.join(
    save ? path.join(".claude", "audits") : path.join(os.tmpdir(), "aw-certify"),
    "certification",
    detectorId,
    `${date.toISOString().slice(0, 10)}-certify.json`,
  );
}

function args(argv: string[]): Options {
  const [detectorId, ...flags] = argv;
  if (
    !detectorId ||
    (detectorId !== "--all" &&
      (!/^[A-Z][0-9]{1,2}$/.test(detectorId) || !DETECTOR_CONTRACTS[detectorId]))
  ) {
    throw new Error(
      "Usage: certify <detectorId|--all> [--db path] [--from ISO --to ISO] [--measured json] [--d-evidence json] [--save]",
    );
  }
  const rest = flags.filter((flag) => flag !== "--save");
  const options: Options = {
    detectorId,
    db: path.join(os.homedir(), ".agentwrangler", "db.sqlite"),
    save: rest.length < flags.length,
  };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--db") options.db = value;
    else if (flag === "--from") options.from = value;
    else if (flag === "--to") options.to = value;
    else if (flag === "--measured") options.measured = value;
    else if (flag === "--d-evidence") options.dEvidence = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if ((options.from === undefined) !== (options.to === undefined))
    throw new Error("--from and --to must be given together");
  if (
    options.from &&
    (!Number.isFinite(Date.parse(options.from)) ||
      !Number.isFinite(Date.parse(options.to ?? "")) ||
      Date.parse(options.from) >= Date.parse(options.to ?? ""))
  )
    throw new Error("Expected valid --from before --to");
  return options;
}

function cardsFor(db: Database.Database): RecommendationCard[] {
  setQueryDb(db);
  try {
    const response = listRecommendations();
    if (!response.data) throw new Error("Recommendation query returned no data");
    const { active, limit_warnings, adopted, dismissed, history, below_floor } = response.data;
    return [
      ...active,
      ...limit_warnings,
      ...adopted,
      ...dismissed,
      ...history,
      ...(below_floor ?? []),
    ];
  } finally {
    resetQueryDb();
  }
}

async function snapshotCards(source: Database.Database): Promise<RecommendationCard[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-certify-"));
  const file = path.join(dir, "snapshot.sqlite");
  try {
    await source.backup(file);
    const copy = new Database(file, { fileMustExist: true });
    try {
      return cardsFor(copy);
    } finally {
      copy.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cardWindow(cards: RecommendationCard[]): Window | undefined {
  for (const card of cards) {
    const raw = card.evidence.window;
    if (
      raw &&
      typeof raw === "object" &&
      "from" in raw &&
      "to" in raw &&
      typeof raw.from === "string" &&
      typeof raw.to === "string" &&
      Number.isFinite(Date.parse(raw.from)) &&
      Number.isFinite(Date.parse(raw.to)) &&
      Date.parse(raw.from) < Date.parse(raw.to)
    ) {
      return { from: raw.from, to: raw.to };
    }
  }
  return undefined;
}

/** Valid-but-unmeasured actions pass C4 and are counted; C5a still requires a handler. */
export function actionStep(cards: RecommendationCard[]): Step {
  let actions = 0;
  let failed = 0;
  let missingMetric = 0;
  let unmeasured = 0;
  for (const card of cards) {
    if (!card.actions) continue;
    for (const action of [card.actions.primary, ...card.actions.alternatives]) {
      actions++;
      if (!action.target_metric) missingMetric++;
      const verdict =
        action.option_id === card.actions.primary.option_id
          ? card.action_validation?.primary
          : card.action_validation?.alternatives[action.option_id];
      if (verdict?.ok !== true) failed++;
      else if (verdict.measured === false) unmeasured++;
    }
  }
  return {
    verdict: failed ? "FAIL" : "PASS",
    counts: { actions, failed, missingMetric, unmeasured },
  };
}

type Ledger = ReturnType<typeof buildClaimLedger>;

/** Builds the claim ledger for a window, reusing `cache` (keyed by window) when given. */
function ledgerFor(db: Database.Database, window: Window, cache?: Map<string, Ledger>): Ledger {
  const key = `${window.from}|${window.to}`;
  const cached = cache?.get(key);
  if (cached) return cached;
  const ledger = buildClaimLedger(db, {
    fromIso: window.from,
    toIso: window.to,
    now: new Date(window.to),
  });
  cache?.set(key, ledger);
  return ledger;
}

function c2Step(
  db: Database.Database,
  window: Window,
  detectorId: string,
  cache?: Map<string, Ledger>,
): Step {
  const ledger = ledgerFor(db, window, cache);
  const report = conservationReport(ledger);
  const ownedCells = new Set(
    ledger.claims.filter((c) => c.detectorId === detectorId).map(laneCellKey),
  );
  const violations = [...report.doubleOwned, ...report.overbilled, ...report.overvalued].filter(
    (cell) => ownedCells.has(cell),
  ).length;
  return {
    verdict: violations ? "FAIL" : "PASS",
    counts: {
      ownedClaims: ledger.claims.filter((c) => c.detectorId === detectorId).length,
      violations,
    },
  };
}

/** Per-detector C1 quantity oracles, each written independently of the detector's code. */
const QUANTITY_ORACLES: Record<
  string,
  (
    db: Database.Database,
    window: Window,
  ) => { verdict: "PASS" | "FAIL" | "UNPROVEN"; counts: Record<string, number> }
> = { D2: checkD2Quantity, D8: checkD8Quantity };

/**
 * C1 quantity. A detector with no family oracle is ESTIMATED (spec-certify-command §3 step 5):
 * enough for the Light tier, blocking for Full. Its cards then show "Estimated" once certified.
 */
export function c1Step(
  db: Database.Database,
  options: Options,
  _cards: RecommendationCard[],
  window: Window,
): { step: Step; claudeCodeVersion?: string } {
  const oracle = QUANTITY_ORACLES[options.detectorId];
  if (oracle) {
    const report = oracle(db, window);
    return { step: { verdict: report.verdict, counts: report.counts } };
  }
  const contract = DETECTOR_CONTRACTS[options.detectorId];
  const quantity = contract?.quantity ?? "";
  if (
    options.detectorId === "D1" ||
    (quantity.includes("context") && quantity.includes("tokens"))
  ) {
    const measured = options.measured ? readMeasured(options.measured) : undefined;
    const report = checkPrefix(
      db,
      options.dEvidence ? readBaselineEvidence(options.dEvidence) : undefined,
      undefined,
      window.from,
      0,
      undefined,
      measured,
    );
    const verdict: Verdict = !report.ok
      ? "FAIL"
      : report.checked.unproven || report.checked.dUnproven || !report.checked.dProven
        ? "UNPROVEN"
        : "PASS";
    return {
      step: {
        verdict,
        counts: { ...report.checked, findings: report.findings.length, skips: report.skips.length },
      },
      ...(measured ? { claudeCodeVersion: measured.claudeVersion } : {}),
    };
  }
  if (options.detectorId === "D11" || options.detectorId.startsWith("C")) {
    if (options.detectorId !== "D11" && options.detectorId !== "C5")
      return { step: { verdict: "ESTIMATED" } };
    const report = checkFriction(db);
    const issues = report.issues.filter((i) => i.detector === options.detectorId);
    const historicalFailures = report.historicalIssues.filter(
      (i) => i.detector === options.detectorId && i.status === "FAIL",
    );
    const checked = report.checked[options.detectorId];
    const verdict: Verdict = [...issues, ...historicalFailures].some((i) => i.status === "FAIL")
      ? "FAIL"
      : issues.length || !checked
        ? "UNPROVEN"
        : "PASS";
    return {
      step: {
        verdict,
        counts: { checked, issues: issues.length, historicalFailures: historicalFailures.length },
      },
    };
  }
  return { step: { verdict: "ESTIMATED" } };
}

export function c5aStep(
  db: Database.Database,
  detectorId: string,
  cards: RecommendationCard[],
): Step {
  const row = db
    .prepare(`SELECT e.rec_id AS rec_id, e.action_revision AS revision, e.application_source AS source,
        e.method_version AS method, e.metric_id AS metric,
        json_extract(e.scope_json, '$.workspaceId') AS workspace,
        r.scope_workspace_id AS expected_workspace, r.target_metric AS expected_metric
      FROM effect_cycles e JOIN recommendations r ON r.rec_id=e.rec_id
      WHERE e.detector_id=? AND r.adopted_at IS NOT NULL AND e.applied_at >= r.adopted_at
      ORDER BY e.applied_at DESC, e.cycle_no DESC LIMIT 1`)
    .get(detectorId) as
    | {
        rec_id: string;
        revision: string | null;
        source: string;
        method: string;
        metric: string;
        workspace: string | null;
        expected_workspace: string | null;
        expected_metric: string;
      }
    | undefined;
  if (!row) return { verdict: "MISSING", counts: { cycles: 0 } };
  const revisions = cards
    .filter((c) => c.rec_id === row.rec_id)
    .flatMap((c) =>
      c.actions
        ? [c.actions.primary.option_id, ...c.actions.alternatives.map((a) => a.option_id)]
        : [],
    );
  const revisionMatches = row.revision !== null && revisions.includes(row.revision);
  const scopeMatches = row.workspace === row.expected_workspace;
  const metricMatches =
    findHandler(detectorId, row.expected_metric, row.method)?.target.metricId === row.metric;
  const sourceMatches = row.source === "USER_ATTESTED";
  const methodSupported = row.method.length > 0 && row.method !== "UNSUPPORTED";
  return {
    verdict:
      revisionMatches && scopeMatches && metricMatches && sourceMatches && methodSupported
        ? "PASS"
        : "FAIL",
    counts: { cycles: 1, revisionMatches, scopeMatches },
  };
}

type Hooks = {
  cards?: (db: Database.Database) => Promise<RecommendationCard[]>;
  action?: (cards: RecommendationCard[]) => Step;
  c2?: (db: Database.Database, window: Window, detector: string) => Step;
  c1?: (
    db: Database.Database,
    options: Options,
    cards: RecommendationCard[],
    window: Window,
  ) => { step: Step; claudeCodeVersion?: string };
  c5a?: (db: Database.Database, detector: string, cards: RecommendationCard[]) => Step;
  /** Shared across detectors by `--all`: one ledger per window, one clock. */
  ledgers?: Map<string, Ledger>;
  now?: Date;
};

/**
 * Hooks for a run over many detectors on one DB: the card snapshot (the slow step, minutes on the
 * live DB) is taken once, ledgers are reused per window, and one clock keeps default windows equal.
 */
export function sharedHooks(base: Pick<Hooks, "cards" | "ledgers"> = {}): Hooks {
  const takeCards = base.cards ?? snapshotCards;
  let cards: Promise<RecommendationCard[]> | undefined;
  return {
    cards: (db) => {
      cards ??= takeCards(db);
      return cards;
    },
    ledgers: base.ledgers ?? new Map(),
    now: new Date(),
  };
}

export async function certify(options: Options, hooks: Hooks = {}) {
  const db = new Database(options.db, { readonly: true, fileMustExist: true });
  try {
    const now = hooks.now ?? new Date();
    const defaultWindow = {
      from: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      to: now.toISOString(),
    };
    let window: Window =
      options.from && options.to
        ? { from: new Date(options.from).toISOString(), to: new Date(options.to).toISOString() }
        : defaultWindow;
    const steps: Steps = {
      tier: { verdict: "SKIP" },
      C3: { verdict: "SKIP" },
      C4: { verdict: "SKIP" },
      C2: { verdict: "SKIP" },
      C1: { verdict: "SKIP" },
      C5a: { verdict: "SKIP" },
    };
    let cards: RecommendationCard[] = [];
    let tier: "Light" | "Full" = "Light";
    let claudeCodeVersion: string | undefined;
    const safe = (fn: () => Step): Step => {
      try {
        return fn();
      } catch {
        return { verdict: "FAIL" };
      }
    };
    try {
      cards = await (hooks.cards ?? snapshotCards)(db);
    } catch {
      steps.C3 = { verdict: "FAIL" };
    }
    const relevant = cards.filter((c) => c.detector_id === options.detectorId);
    if (!options.from) window = cardWindow(relevant) ?? defaultWindow;
    steps.tier = safe(() => {
      const ledger = ledgerFor(db, window, hooks.ledgers);
      const valueU = ledger.claims
        .filter((c) => c.detectorId === options.detectorId)
        .reduce((sum, c) => sum + c.value_u, 0);
      const durationWeeks = (Date.parse(window.to) - Date.parse(window.from)) / (7 * 86_400_000);
      const valueUPerWeek = valueU / durationWeeks;
      tier = tierFor(
        valueUPerWeek,
        relevant[0]?.modeled_savings_u_per_wk ?? null,
        relevant.some((card) => card.modeled_formula?.kind === "ADVISORY"),
      );
      return {
        verdict: "PASS",
        counts: {
          ownedClaims: ledger.claims.filter((c) => c.detectorId === options.detectorId).length,
          valueU: Math.round(valueU),
          valueUPerWeek: Math.round(valueUPerWeek),
        },
      };
    });
    // Current cards only: retired/history cards carry stale actions nobody can adopt.
    const firing = relevant.filter(
      (c) => c.state !== "RETIRED" && (c.weeks_ago ?? 0) === 0 && c.weeks_fired !== 0,
    );
    if (steps.C3.verdict !== "FAIL") {
      steps.C3 = {
        verdict: firing.length ? "PASS" : "NOT_FIRING",
        counts: { cards: firing.length },
      };
    }
    if (steps.C3.verdict === "NOT_FIRING") return { tier, window, steps, claudeCodeVersion };
    steps.C4 = safe(() => (hooks.action ?? actionStep)(firing));
    steps.C2 = safe(() =>
      hooks.c2
        ? hooks.c2(db, window, options.detectorId)
        : c2Step(db, window, options.detectorId, hooks.ledgers),
    );
    try {
      const result = (hooks.c1 ?? c1Step)(db, options, relevant, window);
      steps.C1 = result.step;
      claudeCodeVersion = result.claudeCodeVersion;
    } catch {
      steps.C1 = { verdict: "FAIL" };
    }
    steps.C5a = safe(() => (hooks.c5a ?? c5aStep)(db, options.detectorId, relevant));
    return { tier, window, steps, claudeCodeVersion };
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = args(argv);
  if (parsed.detectorId !== "--all") return certifyOne(parsed);
  const hooks = sharedHooks();
  const codes: number[] = [];
  for (const detectorId of Object.keys(DETECTOR_CONTRACTS)) {
    codes.push(await certifyOne({ ...parsed, detectorId }, hooks));
  }
  // Same meaning as one detector: 1 if any FAIL, else 3 if any not ready, else 0.
  return codes.includes(1) ? 1 : codes.includes(3) ? 3 : 0;
}

async function certifyOne(options: Options, hooks: Hooks = {}): Promise<number> {
  const result = await certify(options, hooks);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const report = {
    detectorId: options.detectorId,
    tier: result.tier,
    window: result.window,
    steps: result.steps,
    head,
    ...(options.measured
      ? {
          claudeCodeVersion:
            result.claudeCodeVersion ?? readMeasured(options.measured).claudeVersion,
        }
      : {}),
  };
  const file = reportFile(options.detectorId, options.save === true, new Date());
  writeSafeReport(file, report);
  const { steps, tier } = result;
  const ready = exitFor(steps, tier) === 0 ? "READY" : "NOT READY";
  process.stdout.write(
    `${options.detectorId} · ${tier} · C3 ${steps.C3.verdict} · C4 ${steps.C4.verdict} · C2 ${steps.C2.verdict} · C1 ${steps.C1.verdict} · C5a ${steps.C5a.verdict} → ${ready}\nReport: ${file}\n`,
  );
  return exitFor(steps, tier);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
