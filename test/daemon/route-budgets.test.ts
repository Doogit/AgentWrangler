/**
 * test/daemon/route-budgets.test.ts — P0-U9 route budget registry.
 *
 * Oracle: router.ts's own source text (parsed here, not by the registry module), so a
 * route added to the router without a budget fails this test. The checker functions are
 * also exercised against synthetic source strings, so "an unregistered route fails" is
 * proven independently of the real router.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { median, p95, runBudgetGate } from "../../scripts/lib/perf-budget-gate.mjs";
import {
  ROUTE_BUDGETS,
  type RouteBudget,
  initialBudgetMs,
} from "../../src/daemon/route-budgets.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, "src", "daemon", "router.ts"), "utf8");

/** Turn a route-matching regex literal body into route keys (`:id` for captured segments). */
function regexToRoutes(body: string): string[] {
  const key = body
    .replace(/\(\?:(?:[^()]|\([^()]*\))*\)\?/g, "") // optional non-capturing suffixes are other verbs' routes
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\(\[\^\/\][+*]\)/g, ":id");
  const alt = /\(([\w-]+(?:\|[\w-]+)+)\)/.exec(key);
  if (!alt) return [key];
  return (alt[1] as string).split("|").map((a) => key.replace(alt[0], a));
}

/** Every GET route the router source handles. Parametric segments are written `:id`. */
function extractGetRoutes(src: string): string[] {
  const routes = new Set<string>();
  for (const m of src.matchAll(/method === "GET" && pathname === "([^"]+)"/g))
    routes.add(m[1] as string);
  for (const m of src.matchAll(/method === "GET" && pathname\.startsWith\("([^"]+)"\)/g)) {
    routes.add(`${m[1]}:id`);
  }
  // `const X = pathname.match(/re/)` (or `const X = helper(pathname)` where helper matches a
  // regex) counts only when it is used behind `method === "GET" && X`.
  const usedWithGet = (name: string) => new RegExp(`method === "GET" && \\(?${name}\\b`).test(src);
  const re = String.raw`((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\[])+)`; // regex-literal body, [..] classes may hold "/"
  for (const m of src.matchAll(
    new RegExp(String.raw`const (\w+) = pathname\.match\(\s*/${re}/\s*,?\s*\)`, "g"),
  )) {
    if (usedWithGet(m[1] as string)) for (const r of regexToRoutes(m[2] as string)) routes.add(r);
  }
  for (const h of src.matchAll(/const (\w+) = (\w+)\(pathname\);/g)) {
    if (!usedWithGet(h[1] as string)) continue;
    const fn = new RegExp(
      String.raw`function ${h[2]}\([^)]*\)[^{]*\{[\s\S]*?pathname\.match\(\s*/${re}/`,
    ).exec(src);
    if (fn) for (const r of regexToRoutes(fn[1] as string)) routes.add(r);
  }
  return [...routes].sort();
}

function findRegistryGaps(routerSrc: string, registry: Record<string, unknown>) {
  const routes = extractGetRoutes(routerSrc);
  return {
    missing: routes.filter((r) => !(r in registry)),
    stale: Object.keys(registry).filter((r) => !routes.includes(r)),
  };
}

/**
 * Committed snapshot of every audit_p95_ms (perf-audit-2026-09 section 6, idle c1 p95). A route
 * absent here has no audit row. Editing an audit value in the registry alone fails the test.
 */
const AUDIT_SNAPSHOT: Record<string, number> = {
  "/api/agents-liveness": 2049.4,
  "/api/burn-status": 2.58,
  "/api/context-budget": 14.13,
  "/api/cost-per-success": 216.44,
  "/api/delivery": 1293.37,
  "/api/diagnostics": 187.67,
  "/api/efficiency-headroom": 97.45,
  "/api/esf/effects": 5.61,
  "/api/esf/observations": 734.61,
  "/api/esf/session-observations/:id": 82.69,
  "/api/history-progress": 0.7,
  "/api/hook-config": 1.66,
  "/api/hot-sessions": 535.21,
  "/api/hot-sessions/models": 31.83,
  "/api/hot-sessions/page": 718.9,
  "/api/idle-sessions": 558.17,
  "/api/live": 7.44,
  "/api/loop-guard": 46.79,
  "/api/oauth/status": 2,
  "/api/outcomes/detail": 1.56,
  "/api/outcomes/linkage": 7.09,
  "/api/outcomes/success-rate": 4.3,
  "/api/outcomes/sync-status": 1.76,
  "/api/outcomes/token-status": 1.59,
  "/api/outcomes/workspaces": 192.64,
  "/api/overview": 135.78,
  "/api/practices": 333.67,
  "/api/ready": 0.54,
  "/api/recommendation-queue": 3.85,
  "/api/recommendations": 1013.51,
  "/api/recommendations/feedback": 2.09,
  "/api/recommendations/goal": 2.16,
  "/api/recommendations/ledger": 19.62,
  "/api/reports": 1,
  "/api/reports/:id": 1.08,
  "/api/self-percentiles/weekly": 147.21,
  "/api/sessions/:id": 29.44,
  "/api/sessions/:id/breakdown": 38.29,
  "/api/sessions/:id/diagnostics": 64.83,
  "/api/sessions/:id/drivers": 4.66,
  "/api/sessions/:id/spend-percentile": 2.26,
  "/api/sessions/:id/turns": 6.58,
  "/api/settings": 15.05,
  "/api/status": 2.04,
  "/api/trends": 574.19,
  "/api/trends/headroom": 600.53,
  "/api/workspace-names": 1.7,
  "/api/workspaces": 125.75,
  "/api/workspaces/:id/closure-proxy": 1233.83,
  "/api/workspaces/:id/context": 23.55,
  "/api/workspaces/:id/cost-per-success": 154.23,
  "/api/workspaces/:id/delivery": 8312.58,
  "/api/workspaces/:id/offload-share": 66.78,
  "/api/workspaces/:id/self-churn": 158.03,
  "/api/workspaces/:id/sessions": 621.73,
};

/**
 * Registry problems: an audit_p95_ms that differs from the snapshot, or a p95_ms above
 * max(250, ceil(1.2 x snapshot audit)) without a substantive `raised` ref. Stream routes are exempt.
 */
function findRaiseViolations(
  budgets: Record<string, RouteBudget>,
  snapshot: Record<string, number>,
): string[] {
  const bad: string[] = [];
  for (const [route, b] of Object.entries(budgets)) {
    if (b.audit_p95_ms !== snapshot[route]) {
      bad.push(`${route}: audit_p95_ms ${b.audit_p95_ms} != snapshot ${snapshot[route]}`);
      continue;
    }
    if (b.source === "stream") continue;
    const initial = initialBudgetMs(snapshot[route]);
    if (b.p95_ms > initial && (b.raised ?? "").trim().split(/\s+/).length < 2) {
      bad.push(`${route}: p95_ms ${b.p95_ms} > initial ${initial} without a raised ref`);
    }
  }
  return bad;
}

describe("route budget registry (P0-U9)", () => {
  it("every GET route in router.ts has a registry entry", () => {
    const routes = extractGetRoutes(ROUTER_SRC);
    expect(routes.length).toBeGreaterThan(50); // the parser really found the router's routes
    expect(findRegistryGaps(ROUTER_SRC, ROUTE_BUDGETS).missing).toEqual([]);
  });

  it("has no entry for a route the router does not serve", () => {
    expect(findRegistryGaps(ROUTER_SRC, ROUTE_BUDGETS).stale).toEqual([]);
  });

  it("an unregistered route stub fails the check (synthetic source)", () => {
    const stub = `${ROUTER_SRC}\n    if (method === "GET" && pathname === "/api/zz-stub") { return; }\n`;
    expect(findRegistryGaps(stub, ROUTE_BUDGETS).missing).toEqual(["/api/zz-stub"]);
    const parametric = `${ROUTER_SRC}\n    const zzMatch = pathname.match(/^\\/api\\/zz\\/([^/]+)\\/detail$/);\n    if (method === "GET" && zzMatch?.[1]) { return; }\n`;
    expect(findRegistryGaps(parametric, ROUTE_BUDGETS).missing).toEqual(["/api/zz/:id/detail"]);
    // and a registry entry with no route is reported stale
    expect(findRegistryGaps("", { "/api/gone": { p95_ms: 250, source: "direct" } }).stale).toEqual([
      "/api/gone",
    ]);
  });

  it("parses parametric, startsWith, helper and alternation routes the same way the router spells them", () => {
    const routes = extractGetRoutes(ROUTER_SRC);
    for (const r of [
      "/api/workspaces/:id/delivery",
      "/api/sessions/:id/diagnostics",
      "/api/sessions/:id/breakdown",
      "/api/sessions/:id",
      "/api/recommendations/jobs/:id",
      "/api/esf/session-observations/:id",
    ]) {
      expect(routes, r).toContain(r);
    }
    // POST-only regex routes are not GET routes
    expect(routes).not.toContain("/api/esf/effects/track");
  });

  it("P1-U6a test 7: every Appendix A interaction read has a registry entry", () => {
    // Oracle: the perf plan's Appendix A (§13) GET column, copied here by hand.
    const appendixA = [
      "/api/esf/effects",
      "/api/practices",
      "/api/recommendations/ledger",
      "/api/efficiency-headroom",
      "/api/recommendations/jobs/:id",
      "/api/hook-config",
      "/api/recommendations",
      "/api/sessions/:id",
      "/api/sessions/:id/turns",
      "/api/sessions/:id/drivers",
      "/api/sessions/:id/spend-percentile",
      "/api/sessions/:id/diagnostics",
      "/api/sessions/:id/breakdown",
      "/api/esf/session-observations/:id",
      "/api/hot-sessions/page",
      "/api/workspaces",
      "/api/trends",
      "/api/workspaces/:id/sessions",
      "/api/workspaces/:id/cost-per-success",
      "/api/workspaces/:id/delivery",
      "/api/workspaces/:id/context",
      "/api/workspaces/:id/closure-proxy",
      "/api/outcomes/workspaces",
      "/api/esf/observations",
      "/api/diagnostics",
      "/api/trends/headroom",
    ];
    expect(appendixA.filter((r) => !(r in ROUTE_BUDGETS))).toEqual([]);
  });

  it("P1-U8: the delivery and practices routes are served from a snapshot", () => {
    for (const route of ["/api/delivery", "/api/practices", "/api/workspaces/:id/delivery"]) {
      expect(ROUTE_BUDGETS[route]?.source, route).toBe("snapshot");
    }
  });

  it("every entry has a positive p95_ms and a known source", () => {
    for (const [route, b] of Object.entries(ROUTE_BUDGETS)) {
      expect(b.p95_ms, route).toBeGreaterThan(0);
      expect(["rollup", "snapshot", "direct", "stream"], route).toContain(b.source);
    }
  });

  it("initial budget = max(250, ceil(1.2 x audit idle c1 p95))", () => {
    expect(initialBudgetMs(undefined)).toBe(250);
    expect(initialBudgetMs(2.09)).toBe(250);
    expect(initialBudgetMs(1013.51)).toBe(1217);
    expect(initialBudgetMs(8312.58)).toBe(9976);
  });

  it("no registry entry is above its initial budget without a `raised` ref, and audit values match the snapshot", () => {
    expect(findRaiseViolations(ROUTE_BUDGETS, AUDIT_SNAPSHOT)).toEqual([]);
    expect(Object.keys(AUDIT_SNAPSHOT).filter((r) => !(r in ROUTE_BUDGETS))).toEqual([]);
  });

  it("the raise checker flags unjustified raises and audit edits (synthetic registry)", () => {
    const snap = { "/api/a": 10, "/api/m": 10 };
    const raisedEntry: RouteBudget = { p95_ms: 400, audit_p95_ms: 10, source: "direct" };
    expect(findRaiseViolations({ "/api/a": raisedEntry }, snap)).toHaveLength(1);
    expect(findRaiseViolations({ "/api/a": { ...raisedEntry, raised: "x" } }, snap)).toHaveLength(
      1,
    );
    expect(
      findRaiseViolations(
        { "/api/a": { ...raisedEntry, raised: "perf-audit-2026-09 §6 re-measure" } },
        snap,
      ),
    ).toEqual([]);
    // a raise on an entry that is written across many lines is still caught (no line parsing)
    const multi: RouteBudget = {
      p95_ms: 5000,
      audit_p95_ms: 10,
      source: "direct",
      untimed: "upstream",
    };
    expect(findRaiseViolations({ "/api/m": multi }, snap)).toHaveLength(1);
    // bumping audit_p95_ms together with p95_ms does not launder the raise
    expect(
      findRaiseViolations(
        { "/api/a": { p95_ms: 12000, audit_p95_ms: 10000, source: "direct" } },
        snap,
      ),
    ).toHaveLength(1);
    expect(
      findRaiseViolations({ "/api/a": { p95_ms: 250, audit_p95_ms: 10, source: "direct" } }, snap),
    ).toEqual([]);
    expect(
      findRaiseViolations(
        { "/api/c": { p95_ms: 9999, source: "stream" } },
        { "/api/c": undefined as never },
      ),
    ).toEqual([]);
  });
});

describe("step (g) enforcing gate (P3-U1)", () => {
  let server: http.Server;
  let base = "";
  let perfLoopP99 = 5;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const send = () => {
        res.setHeader("content-type", "application/json");
        res.end(
          req.url?.startsWith("/api/perf")
            ? JSON.stringify({ loop_lag: { p99: perfLoopP99 } })
            : "{}",
        );
      };
      if (req.url === "/api/zz-slow") setTimeout(send, 400);
      else send();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("a route stub sleeping 400 ms registered at 250 fails the gate, naming route and ms", async () => {
    const r = await runBudgetGate({
      base,
      entries: [
        { route: "/api/zz-slow", url: "/api/zz-slow", budget: 250 },
        { route: "/api/zz-fast", url: "/api/zz-fast", budget: 250 },
      ],
      samples: 3,
      attempts: 3,
      log: () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/\/api\/zz-slow.*\d{3}\.\d ms.*250 ms/);
    expect(r.routes.find((x) => x.route === "/api/zz-slow")?.p95s).toHaveLength(3);
  }, 30_000);

  it("a fast route inside its budget passes and prints all 3 attempts", async () => {
    const lines: string[] = [];
    const r = await runBudgetGate({
      base,
      entries: [{ route: "/api/zz-fast", url: "/api/zz-fast", budget: 250 }],
      samples: 10,
      attempts: 3,
      log: (l: string) => lines.push(l),
    });
    expect(r.ok).toBe(true);
    expect(lines.join("\n")).toMatch(/\/api\/zz-fast.*\d+\.\d.*\d+\.\d.*\d+\.\d/);
  }, 30_000);

  it("an /api/perf loop p99 above 50 ms fails the gate", async () => {
    perfLoopP99 = 80;
    const r = await runBudgetGate({
      base,
      entries: [{ route: "/api/zz-fast", url: "/api/zz-fast", budget: 250 }],
      samples: 3,
      attempts: 3,
      log: () => {},
    });
    perfLoopP99 = 5;
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/loop p99 80\.0 ms > 50 ms/);
  }, 30_000);

  it("an attempt that overlapped ingest fails on its own loop p99, even when the median of 3 is fine", async () => {
    let ingesting = true;
    const lagServer = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      // Every /api/perf read during attempt 1 (the ingest attempt) reads 80, later attempts read 5.
      res.end(
        req.url?.startsWith("/api/perf")
          ? JSON.stringify({ loop_lag: { p99: ingesting ? 80 : 5 } })
          : "{}",
      );
    });
    await new Promise<void>((r) => lagServer.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(lagServer.address() as { port: number }).port}`;
    const r = await runBudgetGate({
      base: b,
      entries: [{ route: "/api/zz-fast", url: "/api/zz-fast", budget: 250 }],
      samples: 3,
      attempts: 3,
      log: () => {},
      isIngesting: () => ingesting,
      onSample: (a: number) => {
        ingesting = a === 0;
      },
    } as Parameters<typeof runBudgetGate>[0]);
    await new Promise<void>((res) => lagServer.close(() => res()));
    expect(r.loopP99s[0]).toBeGreaterThan(50);
    expect(Math.max(...r.loopP99s.slice(1))).toBeLessThanOrEqual(50);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/attempt 1.*ingest.*loop p99 80\.0 ms > 50 ms/);
  }, 30_000);

  it("the gated loop p99 is the whole-span read at the attempt's end, not an early running-p99 poll", async () => {
    const reads: number[] = [];
    const spanServer = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (!req.url?.startsWith("/api/perf")) {
        res.end("{}");
        return;
      }
      // Per attempt with one route: the arming read, a mid-attempt poll (few ticks, reads like a
      // max), then the end read.
      const v = reads.length % 3 === 2 ? 30 : 80;
      reads.push(v);
      res.end(JSON.stringify({ loop_lag: { p99: v } }));
    });
    await new Promise<void>((r) => spanServer.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(spanServer.address() as { port: number }).port}`;
    const r = await runBudgetGate({
      base: b,
      entries: [{ route: "/api/zz-fast", url: "/api/zz-fast", budget: 250 }],
      samples: 3,
      attempts: 3,
      log: () => {},
      isIngesting: () => true,
    });
    await new Promise<void>((res) => spanServer.close(() => res()));
    expect(reads).toHaveLength(9);
    expect(r.loopP99s).toEqual([30, 30, 30]);
    expect(r.ok).toBe(true);
  }, 30_000);

  it("an end read the daemon marks covered: false (sampler not running all span) fails the gate", async () => {
    const gapServer = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        req.url?.startsWith("/api/perf")
          ? JSON.stringify({ loop_lag: { p99: 5, covered: false } })
          : "{}",
      );
    });
    await new Promise<void>((r) => gapServer.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(gapServer.address() as { port: number }).port}`;
    const r = await runBudgetGate({
      base: b,
      entries: [{ route: "/api/zz-fast", url: "/api/zz-fast", budget: 250 }],
      samples: 3,
      attempts: 3,
      log: () => {},
    });
    await new Promise<void>((res) => gapServer.close(() => res()));
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(
      /attempt 1 loop p99 unreadable \(covered: false, since \d+\)/,
    );
  }, 30_000);

  it("an unreadable /api/perf at an attempt's end fails the gate, never passes it", async () => {
    const badServer = http.createServer((req, res) => {
      res.statusCode = req.url?.startsWith("/api/perf") ? 500 : 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    await new Promise<void>((r) => badServer.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(badServer.address() as { port: number }).port}`;
    const r = await runBudgetGate({
      base: b,
      entries: [{ route: "/api/zz-fast", url: "/api/zz-fast", budget: 250 }],
      samples: 3,
      attempts: 3,
      log: () => {},
    });
    await new Promise<void>((res) => badServer.close(() => res()));
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/attempt 1 loop p99 unreadable \(HTTP 500\)/);
  }, 30_000);

  it("each attempt polls /api/perf?since=<its own start>: a spike injected during attempt 1 does not reach attempts 2-3", async () => {
    let spikeAt = 0;
    const sinces: number[] = [];
    const spanServer = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/perf")) {
        const since = Number(new URL(req.url, "http://x").searchParams.get("since"));
        sinces.push(since);
        res.end(JSON.stringify({ loop_lag: { p99: spikeAt >= since ? 80 : 5 } }));
        return;
      }
      if (spikeAt === 0) spikeAt = Date.now(); // the spike lands inside attempt 1
      res.end("{}");
    });
    await new Promise<void>((r) => spanServer.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(spanServer.address() as { port: number }).port}`;
    const t0 = Date.now();
    const r = await runBudgetGate({
      base: b,
      entries: [{ route: "/api/zz-fast", url: "/api/zz-fast", budget: 250 }],
      samples: 3,
      attempts: 3,
      log: () => {},
    });
    await new Promise<void>((res) => spanServer.close(() => res()));
    expect(sinces.every((s) => Number.isFinite(s) && s >= t0)).toBe(true);
    expect(r.loopP99s[0]).toBe(80);
    expect(r.loopP99s[1]).toBe(5);
    expect(r.loopP99s[2]).toBe(5);
  }, 30_000);

  it("the gate does not honour gateLoop:false or settle (no ungated pass, no waiting out the lag window)", async () => {
    perfLoopP99 = 80;
    const t0 = Date.now();
    const r = await runBudgetGate({
      base,
      entries: [{ route: "/api/zz-fast", url: "/api/zz-fast", budget: 250 }],
      samples: 2,
      attempts: 2,
      log: () => {},
      gateLoop: false,
      settle: true,
    } as unknown as Parameters<typeof runBudgetGate>[0]);
    perfLoopP99 = 5;
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it("verify-app step (g) samples every timed budgeted route in ONE gated pass (no tail / ungated pass)", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "verify-app.mjs"), "utf8");
    const g = src.slice(
      src.indexOf("async function routeBudgetGateInner"),
      src.indexOf("// ── (h) Scan-root mode"),
    );
    expect(g.match(/runBudgetGate\(\{/g)).toHaveLength(1);
    expect(g).toMatch(/entries: timedEntries,/);
    expect(g).not.toMatch(/SPAWN_ROUTES|tailEntries|gateLoop|settle:|HOST_DEPENDENT/);
    expect(g).not.toMatch(/setTimeout|sleep\(/);
    // every non-skipped route lands in timedEntries (no extra filter after the probe loop)
    expect(g).not.toMatch(/timedEntries\.filter/);
  });

  it("uses the median of 3 attempts, not the min or max", () => {
    expect(median([300, 100, 100])).toBe(100);
    expect(median([300, 300, 100])).toBe(300);
    expect(median([5, 1, 3])).toBe(3);
    expect(p95(Array.from({ length: 50 }, (_, i) => i + 1))).toBe(48); // nearest rank: ceil(.95*50)=48th
  });
});
