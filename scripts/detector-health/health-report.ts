/**
 * DH4 health report (spec-detector-health.md §3 DH4): one row per detector, folding DH1 fixtures, live status,
 * DH2 probes, the DH1c pipeline trace and the DH3 oracle verdict. Aggregates only (SEC-101): workspace
 * identifiers in free text are replaced by "workspace A/B/C".
 *
 * Never pass the live DB: detectors and the history walk write to it.
 */

import type Database from "better-sqlite3";
import { buildContext, runDetectors } from "../../src/detector/engine.js";
import { DETECTORS } from "../../src/detector/registry.js";
import type { AnyDetector } from "../../src/detector/types.js";
import { runCase, withCaseDb } from "../../test/detector-health/harness.js";
import { type DetectorHealthCase, loadManifests } from "../../test/detector-health/manifest.js";
import { gradeOracle } from "../../test/detector-health/oracles/grade.js";
import { ORACLES, laneTrace } from "../../test/detector-health/oracles/index.js";
import { type PipelineTrace, tracePipelines } from "../../test/detector-health/pipeline.js";
import { PROBES } from "../../test/detector-health/probes/index.js";
import type { Probe } from "../../test/detector-health/probes/types.js";
import { type LiveProbeRow, liveWeekEnds, runLiveProbes } from "./live-probes.js";

/** Probes that recount the trigger exactly; only these can grade a detector-only week as a false positive. */
const EXACT_PROBES = new Set(["C2", "C3", "C9", "C11", "H1", "D14", "A1", "A2", "C5", "C7"]);
export const ORACLE_NOT_LANDED = "no oracle";

export type Level = "green" | "amber" | "red";
export interface Cell {
  text: string;
  level: Level;
}
export interface HealthRow {
  id: string;
  fixtureFires: Cell;
  nearMissSilent: Cell;
  live: Cell;
  probe: Cell;
  pipeline: Cell;
  oracle: Cell;
  /** DH3 detail for the report's oracle section (workspace labels already scrubbed). */
  oracleDetail?: OracleDetail | undefined;
  overall: Level;
}
export interface OracleDetail {
  mean_signed_err: number | null;
  per_ws: Array<{ label: string; signed_err: number | null; verdict: string }>;
  raw: string;
  price: string;
}

export interface HealthOptions {
  ids?: string[];
  detectors?: readonly AnyDetector[];
  probes?: Record<string, Probe>;
  /** DH3 verdict per detector id; absent = not landed. */
  oracles?: Record<string, string>;
  /** Fixed clock for the fixture runs (fixtures are shifted to it). */
  fixtureNow?: Date;
}

type Db = Database.Database;

function cell(text: string, level: Level): Cell {
  return { text, level };
}

/** Workspace identifiers → "workspace A/B/C", longest first so a slug inside a path is caught whole. */
function scrubber(db: Db): (s: string) => string {
  const ws = db
    .prepare(
      "SELECT workspace_id, project_slug, repo_path, repo_owner, repo_name FROM workspaces ORDER BY workspace_id",
    )
    .all() as Record<string, string | null>[];
  const pairs: [string, string][] = [];
  ws.forEach((w, i) => {
    const label = `workspace ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`;
    for (const v of Object.values(w)) if (v && v.length >= 3) pairs.push([v, label]);
  });
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (s) => pairs.reduce((acc, [v, label]) => acc.split(v).join(label), s);
}

function fixtureCells(
  c: DetectorHealthCase | undefined,
  det: AnyDetector,
  probe: Probe | undefined,
  now: Date,
): { fires: Cell; nearMiss: Cell; probeOnFixture: Cell } {
  if (!c) {
    const missing = cell("MISSING (no manifest)", "red");
    return { fires: missing, nearMiss: missing, probeOnFixture: missing };
  }
  const pos = runCase(det, c.positive, "fires", now);
  const fires = pos.pass
    ? cell(`PASS (${pos.firedCount})`, "green")
    : cell(`FAIL (${pos.status}, ${pos.firedCount} fired)`, "red");
  const failed = c.near_misses.filter((n) => !runCase(det, n, "silent", now).pass);
  const k = c.near_misses.length;
  const nearMiss =
    failed.length === 0
      ? cell(`PASS (${k}/${k})`, "green")
      : cell(
          `FAIL (${k - failed.length}/${k}; fires at ${failed.map((n) => n.target_constant).join(", ")})`,
          "red",
        );
  let probeOnFixture = cell("MISSING (no probe)", "red");
  if (probe) {
    const r = withCaseDb(c.positive, now, (db) => probe(db, now));
    probeOnFixture =
      r.qualifying > 0
        ? cell(`fixture q=${r.qualifying}`, "green")
        : cell(`probe can't fire on its positive (c=${r.candidates}, q=0)`, "red");
  }
  return { fires, nearMiss, probeOnFixture };
}

function probeCell(id: string, onFixture: Cell, weeks: LiveProbeRow[] | null): Cell {
  if (!weeks) return onFixture;
  const counts = new Map<string, number>();
  for (const w of weeks) counts.set(w.outcome, (counts.get(w.outcome) ?? 0) + 1);
  const exact = EXACT_PROBES.has(id);
  const label = (o: string): string => (o === "detector-only" && exact ? "false-positive" : o);
  const parts = [...counts].map(([o, n]) => `${n} ${label(o)}`);
  const missWeeks = weeks.filter((w) => w.outcome === "miss").map((w) => w.weekEnd.slice(5, 10));
  if (missWeeks.length > 0) parts.push(`miss weeks ${missWeeks.join(", ")}`);
  const unstored = weeks.filter((w) => w.fired > 0 && w.stored === 0).length;
  if (unstored > 0) parts.push(`${unstored} wk fired fresh but 0 stored (fresh status used)`);
  let level: Level = onFixture.level;
  if (counts.has("red") || counts.has("miss") || (exact && counts.has("detector-only")))
    level = "red";
  else if (counts.has("detector-only") && level === "green") level = "amber";
  return cell(`${onFixture.text} · ${parts.join(", ")}`, level);
}

function pipelineCell(t: PipelineTrace | undefined, liveStatus: string | undefined): Cell {
  if (!t) return cell("MISSING", "red");
  const buckets = Object.entries(t.buckets)
    .map(([b, n]) => `${b} ${n}`)
    .join(", ");
  const parts = [`rec rows ${t.rec_rows}`, buckets || "no bucket"];
  if (t.absent > 0) parts.push(`${t.absent} absent from API`);
  parts.push(t.diag_causes.length > 0 ? `Diag ${t.diag_causes.length} cause(s)` : "no Diag");
  if (t.sanity.length > 0) parts.push(`flags: ${t.sanity.join("; ")}`);
  if (t.drop) parts.push(`drop: ${t.drop}`);
  // An INACTIVE detector has nothing to deliver; a drop only counts against one that fired.
  if (t.drop && liveStatus === "ACTIVE") return cell(parts.join(" · "), "red");
  return cell(parts.join(" · "), t.sanity.length > 0 ? "amber" : "green");
}

function oracleCell(v: string | undefined): Cell {
  const text = v ?? ORACLE_NOT_LANDED;
  if (text.startsWith("PASS")) return cell(text, "green");
  if (text === ORACLE_NOT_LANDED || text === "SKIPPED") return cell(text, "amber");
  return cell(text, "red"); // UNPROVEN, MISSING, BLOCKED, NOT_EVALUATED, FAIL
}

const RANK: Record<Level, number> = { green: 0, amber: 1, red: 2 };

/** Every column for each detector on `db` (a backup copy) at the pinned `now`. */
export async function buildRows(db: Db, now: Date, opts: HealthOptions = {}): Promise<HealthRow[]> {
  const detectors = opts.detectors ?? DETECTORS;
  const probes = opts.probes ?? PROBES;
  const ids = opts.ids ?? detectors.map((d) => d.id);
  const fixtureNow = opts.fixtureNow ?? now;
  const scrub = scrubber(db);
  const manifests = new Map(loadManifests().map((c) => [c.id, c]));

  // Probes read detector_week_results as stored, so they run before the walk rewrites it.
  const weekEnds = liveWeekEnds(db);
  const probeWeeks = new Map<string, LiveProbeRow[]>();
  for (const id of ids)
    if (probes[id] && detectors.some((d) => d.id === id))
      probeWeeks.set(id, runLiveProbes(db, [id], weekEnds, detectors, probes));

  const statuses = new Map(
    runDetectors(db, buildContext(now), detectors).map((s) => [s.detector_id, s]),
  );
  const traces = new Map((await tracePipelines(db, ids, now)).map((t) => [t.detector_id, t]));

  return ids.map((id) => {
    const det = detectors.find((d) => d.id === id);
    if (!det) throw new Error(`no detector ${id}`);
    const fx = fixtureCells(manifests.get(id), det, probes[id], fixtureNow);
    const st = statuses.get(id);
    const live = !st
      ? cell("MISSING", "red")
      : cell(
          `${st.status}${st.note ? ` — ${scrub(st.note).slice(0, 140)}` : ""}`,
          st.status === "BLOCKED" || st.status === "NOT_EVALUATED" ? "red" : "green",
        );
    const probe = probeCell(id, fx.probeOnFixture, probeWeeks.get(id) ?? null);
    const pipeline = pipelineCell(traces.get(id), st?.status);
    let oracleText = opts.oracles?.[id];
    let oracleDetail: OracleDetail | undefined;
    // A detector's lanes (D7 loop + D7X) are separate registry entries on the same trace.
    const regs = Object.entries(ORACLES).filter(([k, r]) => (r.trace_id ?? k) === id);
    const trace = traces.get(id);
    if (oracleText === undefined && regs.length > 0 && trace) {
      const graded = regs.map(([k, reg]) => {
        try {
          return { k, g: gradeOracle(reg.oracle(db, now), laneTrace(reg, trace), reg.figure, db) };
        } catch (e) {
          return {
            k,
            g: null,
            err: `FAIL (threw: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 80)})`,
          };
        }
      });
      const verdicts = graded.map((x) => (x.g ? x.g.verdict : (x as { err: string }).err));
      oracleText =
        graded.length === 1
          ? verdicts[0]
          : `${verdicts.every((v) => v.startsWith("PASS")) ? "PASS" : "FAIL"} — ${graded.map((x, i) => `${x.k}: ${verdicts[i]}`).join(" · ")}`;
      const ok = graded.flatMap((x) => (x.g ? [x.g] : []));
      if (ok.length > 0) {
        const errs = ok.flatMap((g) =>
          g.per_ws.flatMap((w) => (w.signed_err === null ? [] : [w.signed_err])),
        );
        oracleDetail = {
          mean_signed_err: errs.length > 0 ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
          per_ws: ok.flatMap((g) =>
            g.per_ws.map((w) => ({
              label:
                w.scope !== null
                  ? scrub(w.scope)
                  : w.workspace_id === null
                    ? "global"
                    : scrub(w.workspace_id),
              signed_err: w.signed_err,
              verdict: w.verdict,
            })),
          ),
          raw: ok.map((g) => `${g.raw.matched}/${g.raw.sampled}`).join(" + "),
          price: ok
            .map(
              (g) =>
                `n=${g.price.n}, max Δ ${(g.price.max_rel_diff * 100).toFixed(2)}%, mean ${(g.price.mean_signed_rel_diff * 100).toFixed(2)}%`,
            )
            .join(" + "),
        };
      }
    }
    const oracle = oracleCell(oracleText);
    const cells = [fx.fires, fx.nearMiss, live, probe, pipeline, oracle];
    const overall = cells.reduce<Level>((w, c) => (RANK[c.level] > RANK[w] ? c.level : w), "green");
    return {
      id,
      fixtureFires: fx.fires,
      nearMissSilent: fx.nearMiss,
      live: { ...live, text: scrub(live.text) },
      probe: { ...probe, text: scrub(probe.text) },
      pipeline: { ...pipeline, text: scrub(pipeline.text) },
      oracle: { ...oracle, text: scrub(oracle.text) },
      oracleDetail,
      overall,
    };
  });
}

function md(c: Cell): string {
  const t = c.text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return c.level === "red" ? `**RED** ${t}` : c.level === "amber" ? `*amber* ${t}` : t;
}

const signedPct = (x: number | null): string =>
  x === null ? "n/a" : `${x >= 0 ? "+" : "-"}${(Math.abs(x) * 100).toFixed(1)}%`;

/** DH3 oracles section: one line per graded detector, then the overall mean signed error across recs. */
function oracleSection(rows: HealthRow[]): string[] {
  const graded = rows.filter((r) => r.oracleDetail);
  if (graded.length === 0) return [];
  const errs = graded.flatMap((r) =>
    (r.oracleDetail?.per_ws ?? []).flatMap((w) => (w.signed_err === null ? [] : [w.signed_err])),
  );
  const mean = errs.length > 0 ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
  return [
    "## DH3 oracles",
    "",
    ...graded.map((r) => {
      const d = r.oracleDetail as OracleDetail;
      const ws = d.per_ws.map(
        (w) =>
          `${w.label} ${signedPct(w.signed_err)}${w.verdict === "ok" ? "" : ` (${w.verdict})`}`,
      );
      return `- ${r.id}: mean signed error ${signedPct(d.mean_signed_err)}; ${ws.join(", ") || "no workspaces"}; raw ${d.raw}; price ${d.price}`;
    }),
    "",
    `Mean signed error across recs: ${signedPct(mean)} (${errs.length} workspace figures, ${graded.length} detectors).`,
    "",
  ];
}

export function renderReport(rows: HealthRow[], now: Date, weekEnds: Date[]): string {
  const date = now.toISOString().slice(0, 10);
  const n = (l: Level): number => rows.filter((r) => r.overall === l).length;
  const lines = [
    `# Detector health — ${date}`,
    "",
    `Generated by \`npm run detector-health\` on a SQLite-backup-API copy of the live DB at ${now.toISOString()}.`,
    "Spec `docs/plans/spec-detector-health.md` §3 DH4. Aggregates only (SEC-101).",
    "",
    `**${rows.length} detectors: ${n("red")} red · ${n("amber")} amber · ${n("green")} green.**`,
    "",
    `Live probe weeks: ${weekEnds.length} week ends (${weekEnds.map((d) => d.toISOString().slice(5, 10)).join(", ")}).`,
    weekEnds.length < 8
      ? `The spec asks for ≥ 8; only ${weekEnds.length} are reachable on this DB.`
      : "",
    "",
    "States: **RED** = FAIL, MISSING, BLOCKED, NOT_EVALUATED, UNPROVEN, a probe miss or a probe that can't fire, or a",
    "drop on an ACTIVE detector. *amber* = not yet green: `no oracle`, SKIPPED, a money sanity flag, or a",
    "detector-only week on a composite probe. A failing detector is report-only; hide it by hand (§5 decision 1).",
    "",
    "| Detector | Overall | Fixture fires | Near-miss silent | Live status + note | Probe outcome | Pipeline (DH1c) | Oracle | Report date |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.overall.toUpperCase()} | ${md(r.fixtureFires)} | ${md(r.nearMissSilent)} | ${md(r.live)} | ${md(r.probe)} | ${md(r.pipeline)} | ${md(r.oracle)} | ${date} |`,
    ),
    "",
    ...oracleSection(rows),
  ];
  return lines.join("\n");
}
