/**
 * test/daemon/job-budgets.test.ts — P0-U14 job and detector budget registry.
 *
 * (1) Static check: no raw setInterval / re-arming setTimeout in src/daemon,
 *     src/ingest, src/outcomes outside the scheduleJob helper. The checker
 *     (timer-static-check.ts) is itself proven on fixture text, so a stub with
 *     a raw setInterval makes it fail (the plan's "stub module" test) without
 *     planting files in src/.
 * (2) Registry: every scheduleJob name and every registered detector id has a
 *     budget entry; a synthetic detector id / job name with no entry fails;
 *     every entry names its measurement source.
 *
 * Oracle: the fixture strings and the synthetic ids written in this file, and
 * the DETECTORS array owned by src/detector/registry.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DETECTOR_BUDGETS,
  JOB_BUDGETS,
  detectorBudgetWarnings,
  findUnbudgetedDetectors,
  findUnbudgetedJobs,
} from "../../src/daemon/job-budgets.js";
import { DETECTORS } from "../../src/detector/registry.js";
import {
  type OneShotAllow,
  checkTimerSources,
  findScheduleJobCalls,
  scanSource,
} from "./timer-static-check.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCANNED_DIRS = ["src/daemon", "src/ingest", "src/outcomes"];

/** One-shot timeouts (deadlines, sleeps, debounce): not recurring jobs, so allowed with a reason. */
const ONE_SHOT_ALLOW: OneShotAllow[] = [
  { file: "src/daemon/diagnostics-snapshot.ts", count: 1, reason: "Promise.race build-timeout" },
  {
    file: "src/daemon/index.ts",
    count: 4,
    reason:
      "test-hook boot delay, 60 s deferred self-churn collect, two setTimeout(0) boot macrotasks",
  },
  { file: "src/daemon/lifecycle.ts", count: 1, reason: "boot-fallback kick, cleared on shutdown" },
  { file: "src/daemon/outcomes-control.ts", count: 1, reason: "connection-test deadline" },
  { file: "src/daemon/outcomes-pass.ts", count: 1, reason: "outcomes pass deadline" },
  { file: "src/outcomes/github/client.ts", count: 1, reason: "retry backoff sleep in a loop" },
  { file: "src/outcomes/github/credential.ts", count: 1, reason: "credential read timeout" },
  { file: "src/outcomes/github/gh-cli-client.ts", count: 1, reason: "gh spawn timeout" },
];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listTs(rel));
    else if (/\.(ts|mts|tsx|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function loadSources() {
  return SCANNED_DIRS.flatMap(listTs).map((file) => ({
    file,
    text: fs.readFileSync(path.join(REPO_ROOT, file), "utf8"),
  }));
}

describe("timer static check: the checker itself (fixture text)", () => {
  it("fails a stub module with a raw setInterval", () => {
    const stub = "export function start() { setInterval(() => {}, 1000); }\n";
    expect(scanSource("src/daemon/stub.ts", stub, 0)).toEqual([
      { file: "src/daemon/stub.ts", line: 1, kind: "raw-setInterval" },
    ]);
    expect(scanSource("src/daemon/stub.ts", "globalThis.setInterval(f, 5);", 0)[0]?.kind).toBe(
      "raw-setInterval",
    );
  });

  it("fails a re-arming setTimeout (callback re-registers, or names the enclosing fn)", () => {
    const viaNested = "function tick() { setTimeout(() => { work(); setTimeout(tick, 1); }, 1); }";
    const viaSelfArg = "function tick() { setTimeout(tick, 1000); }";
    const viaSelfCall = "const loop = () => { setTimeout(() => loop(), 50); };";
    const viaMethod = "class A { pump() { setTimeout(this.pump, 1); } }";
    for (const src of [viaNested, viaSelfArg, viaSelfCall, viaMethod]) {
      const kinds = scanSource("src/daemon/x.ts", src, 1).map((v) => v.kind);
      expect(kinds, src).toContain("rearming-setTimeout");
    }
  });

  it("a one-shot setTimeout fails unless allow-listed, and never beyond its count", () => {
    const oneShot = "await new Promise((r) => setTimeout(r, 5));";
    expect(scanSource("src/daemon/x.ts", oneShot, 0).map((v) => v.kind)).toEqual([
      "unlisted-setTimeout",
    ]);
    expect(scanSource("src/daemon/x.ts", oneShot, 1)).toEqual([]);
    expect(scanSource("src/daemon/x.ts", `${oneShot}\n${oneShot}`, 1).map((v) => v.kind)).toEqual([
      "over-allowlist",
    ]);
    // An allow entry never excuses a re-arming timer.
    expect(scanSource("src/daemon/x.ts", "function t(){ setTimeout(t, 1); }", 5)).toHaveLength(1);
  });

  it("fails aliased and imported timers, and an allow-list entry larger than the real count", () => {
    const cases = [
      'import * as timers from "node:timers";\ntimers.setInterval(f, 1);',
      'import { setInterval as si } from "node:timers";\nsi(f, 1);',
      "const si = setInterval;\nsi(f, 1);",
    ];
    for (const src of cases) {
      expect(scanSource("src/daemon/x.ts", src, 0).length, src).toBeGreaterThan(0);
    }
    const kinds = (src: string) => scanSource("src/daemon/x.ts", src, 0).map((v) => v.kind);
    expect(kinds(cases[0] as string)).toContain("raw-setInterval");
    expect(kinds(cases[1] as string)).toContain("timer-import");
    expect(kinds(cases[2] as string)).toContain("timer-alias");
    const oneShot = "await new Promise((r) => setTimeout(r, 5));";
    expect(checkTimerSources([{ file: "src/daemon/x.ts", text: oneShot }], [])).toHaveLength(1);
    expect(
      checkTimerSources(
        [{ file: "src/daemon/x.ts", text: oneShot }],
        [{ file: "src/daemon/x.ts", count: 1, reason: "test one-shot" }],
      ),
    ).toEqual([]);
    expect(
      checkTimerSources(
        [{ file: "src/daemon/x.ts", text: oneShot }],
        [{ file: "src/daemon/x.ts", count: 2, reason: "test one-shot" }],
      ).map((v) => v.kind),
    ).toEqual(["under-allowlist"]);
  });

  it("ignores timer words in comments and strings, and exempts the helper file", () => {
    const text = '// setInterval(x, 1)\nconst s = "setTimeout(a, 1)";\n';
    expect(scanSource("src/daemon/x.ts", text, 0)).toEqual([]);
    expect(scanSource("src/daemon/schedule-job.ts", "setInterval(f, 1);", 0)).toEqual([]);
  });

  it("finds scheduleJob calls and flags a non-literal name", () => {
    const calls = findScheduleJobCalls(
      "src/daemon/x.ts",
      'scheduleJob("a.b", 1, f);\nscheduleJob(name, 1, f);',
    );
    expect(calls.map((c) => c.name)).toEqual(["a.b", null]);
  });
});

describe("timer static check: real sources", () => {
  it("has no raw setInterval, re-arming setTimeout, or unlisted one-shot in daemon/ingest/outcomes", () => {
    expect(checkTimerSources(loadSources(), ONE_SHOT_ALLOW)).toEqual([]);
  });

  it("every allow-list entry names an existing file and carries a reason", () => {
    for (const a of ONE_SHOT_ALLOW) {
      expect(fs.existsSync(path.join(REPO_ROOT, a.file)), a.file).toBe(true);
      expect(a.reason.length).toBeGreaterThan(5);
    }
  });
});

describe("budget registry", () => {
  it("every scheduleJob call uses a literal name that has a budget entry, and every timer entry is used", () => {
    const calls = loadSources().flatMap((s) => findScheduleJobCalls(s.file, s.text));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.name === null)).toEqual([]);
    const names = calls.map((c) => c.name as string);
    expect(findUnbudgetedJobs(names)).toEqual([]);
    const timerEntries = Object.entries(JOB_BUDGETS)
      .filter(([, b]) => b.kind === "timer")
      .map(([name]) => name);
    expect(timerEntries.filter((n) => !names.includes(n))).toEqual([]);
  });

  it("every registered detector has a budget entry, and no entry is orphaned", () => {
    const ids = DETECTORS.map((d) => d.id);
    expect(findUnbudgetedDetectors(ids)).toEqual([]);
    expect(Object.keys(DETECTOR_BUDGETS).filter((id) => !ids.includes(id))).toEqual([]);
  });

  it("a synthetic detector id or job name with no entry fails", () => {
    expect(findUnbudgetedDetectors([...DETECTORS.map((d) => d.id), "Z99-synthetic"])).toEqual([
      "Z99-synthetic",
    ]);
    expect(findUnbudgetedJobs(["synthetic.no-entry"])).toEqual(["synthetic.no-entry"]);
  });

  it("every entry links its measurement source and has positive budgets", () => {
    for (const [name, b] of Object.entries(JOB_BUDGETS)) {
      expect(b.source.length, name).toBeGreaterThan(20);
      expect(b.budget_ms, name).toBeGreaterThan(0);
      expect(b.period_ms, name).toBeGreaterThanOrEqual(0);
      expect(b.lane.length, name).toBeGreaterThan(0);
    }
    for (const [id, b] of Object.entries(DETECTOR_BUDGETS)) {
      expect(b.source, id).toMatch(/det-bench/);
      expect(b.ms, id).toBeGreaterThan(0);
      expect(b.rows_read, id).toBeGreaterThanOrEqual(0);
    }
  });

  it("budget warnings compare the per-evaluation average, so a multi-week walk is not flagged", () => {
    // Per-window budgets (det-bench measures one W0 evaluation). A history walk
    // evaluates each detector once per stale week; the cold per-boot run logged
    // 29 false warnings when the walk's summed totals were compared directly.
    const b = DETECTOR_BUDGETS.D7;
    if (b === undefined) throw new Error("D7 budget missing");
    const fourWeeks = { ms: b.ms * 4, rows: b.rows_read * 4, evals: 4 };
    expect(detectorBudgetWarnings({ D7: fourWeeks })).toEqual([]);
    const oneHeavy = { ms: b.ms * 2, rows: b.rows_read * 2, evals: 1 };
    expect(detectorBudgetWarnings({ D7: oneHeavy })).toHaveLength(1);
    expect(detectorBudgetWarnings({ D7: { ms: b.ms * 2, rows: 1 } })).toHaveLength(1);
  });

  it("a detector benched at 0 rows / ~0 ms does not warn on a small read", () => {
    expect(DETECTOR_BUDGETS.A2?.rows_read).toBe(0);
    expect(detectorBudgetWarnings({ A2: { ms: 15, rows: 50, evals: 1 } })).toEqual([]);
  });

  it("lists the U13-profile recurring work and the measured boot-once entries", () => {
    for (const name of [
      "ingest.tail-tick",
      "ingest.discovery-tick",
      "ingest.full-walk",
      "ingest.reconcile-idle-floor",
      "ingest.detector-idle-floor",
      "lifecycle.outcomes-tick",
      "perf.loop-lag-reset",
      "perf.process-sampler",
      "boot.diagnostics-7d-30d",
      "boot.weekly-report",
      "boot.outcomes-linker-reads",
      "boot.commit-linker",
    ]) {
      expect(JOB_BUDGETS[name as keyof typeof JOB_BUDGETS], name).toBeDefined();
    }
    expect(JOB_BUDGETS["boot.diagnostics-7d-30d"].source).toMatch(/fix deferred/);
  });
});
