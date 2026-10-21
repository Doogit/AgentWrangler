/**
 * scripts/lib/perf-budget-gate.mts — P3-U1 enforcing route-budget gate (verify:app step (g)).
 *
 * Each attempt samples every budgeted GET `samples` times (request 0 is a warm-up) and takes the
 * nearest-rank p95. The verdict per route is the MEDIAN of the attempts' p95s (not the min), all
 * attempts printed. /api/perf?since=<attempt start>'s event-loop p99 (that attempt's own span, every
 * sample in it) is read at each attempt's end; mid-attempt polls only log where it peaked. The median of the attempts must be <= LOOP_P99_MAX_MS. Any attempt that
 * overlapped ingest (isIngesting) must ALSO be <= LOOP_P99_MAX_MS on its own. No route is exempt, no waiting.
 * Erasable-syntax TS: verify-app.mjs imports it under plain Node 24.
 */

export const LOOP_P99_MAX_MS = 50;

export interface GateEntry {
  route: string;
  url: string;
  budget: number;
}

export interface GateRouteResult {
  route: string;
  budget: number;
  /** p95 per attempt, ms */
  p95s: number[];
  median: number;
}

export interface GateResult {
  ok: boolean;
  failures: string[];
  routes: GateRouteResult[];
  /** /api/perf loop p99 over each attempt's whole span, ms */
  loopP99s: number[];
  /** % of each attempt's requests sent while isIngesting() was true */
  overlaps: number[];
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2) + (s.length % 2 === 0 ? 1 : 0)] as number;
}

/** Nearest-rank p95. */
export function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.95 * s.length) - 1)] as number;
}

async function timedGet(url: string): Promise<{ status: number; ms: number; body: string }> {
  const t0 = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = await res.text();
  return { status: res.status, ms: performance.now() - t0, body };
}

/**
 * Loop p99 over the samples since `since` (epoch ms): the attempt's own span, not the daemon's 60 s
 * window. A string is why the read failed (status, `covered: false`, a thrown fetch/timeout).
 */
async function loopP99(base: string, since: number): Promise<number | string> {
  const t0 = performance.now();
  try {
    const { status, body } = await timedGet(`${base}/api/perf?since=${since}`);
    if (status !== 200) return `HTTP ${status}`;
    const lag = (JSON.parse(body) as { loop_lag?: { p99?: number; covered?: boolean } }).loop_lag;
    // covered: false = the daemon's sampler was not running for the whole span; never a pass.
    if (lag?.covered === false) return `covered: false, since ${since}`;
    return typeof lag?.p99 === "number" ? lag.p99 : "no loop_lag.p99 in body";
  } catch (error) {
    return `${String(error)} after ${(performance.now() - t0).toFixed(0)} ms`;
  }
}

export async function runBudgetGate(opts: {
  base: string;
  entries: GateEntry[];
  samples?: number;
  attempts?: number;
  log?: (line: string) => void;
  /** Called after every request (warm-up included) with the 0-based attempt index. */
  onSample?: (attempt: number) => void;
  /** True while the daemon is ingesting; checked after each request to count the attempt's overlap. */
  isIngesting?: () => boolean;
}): Promise<GateResult> {
  const {
    base,
    entries,
    samples = 50,
    attempts = 3,
    log = () => {},
    onSample = () => {},
    isIngesting,
  } = opts;
  const perRoute = new Map<string, number[]>(entries.map((e) => [e.route, []]));
  const failures: string[] = [];
  const loopP99s: number[] = [];
  const overlaps: number[] = [];
  for (let a = 0; a < attempts; a++) {
    let ingestReqs = 0;
    let totalReqs = 0;
    let loopMax = 0;
    let loopMaxRoute = "";
    let lastLogged = 0;
    // Arms the daemon's on-demand loop sampler before the span. A cold arm reads covered: false.
    const arm = await loopP99(base, Date.now());
    if (typeof arm === "string" && !arm.startsWith("covered: false"))
      log(`    loop sampler arm read failed (attempt ${a + 1}): ${arm}`);
    const attemptStart = Date.now(); // P3-U1: loop p99 is read over this attempt's own span only
    for (const e of entries) {
      const ms: number[] = [];
      const seen = (read: number | string) => {
        if (typeof read === "string") {
          log(`    loop p99 read failed at ${e.route} (attempt ${a + 1}): ${read}`);
          return;
        }
        if (read > LOOP_P99_MAX_MS && read !== lastLogged) {
          lastLogged = read;
          log(`    loop p99 ${lastLogged.toFixed(1)} ms at ${e.route} (attempt ${a + 1})`);
        }
        if (read > loopMax) {
          loopMax = read;
          loopMaxRoute = e.route;
        }
      };
      for (let i = 0; i < samples + 1; i++) {
        const r = await timedGet(`${base}${e.url}`);
        onSample(a);
        totalReqs += 1;
        if (isIngesting?.()) ingestReqs += 1;
        if (r.status !== 200) {
          failures.push(`${e.route}: HTTP ${r.status} on attempt ${a + 1} (${e.url})`);
          break;
        }
        if (i > 0) ms.push(r.ms); // request 0 is a warm-up
        if (i > 0 && i % 25 === 0) seen(await loopP99(base, attemptStart));
      }
      if (ms.length === samples) perRoute.get(e.route)?.push(p95(ms));
      seen(await loopP99(base, attemptStart));
    }
    const overlap = totalReqs > 0 ? (100 * ingestReqs) / totalReqs : 0;
    // The gated value is the p99 over the attempt's WHOLE span, read once at its end (every sample
    // in it). The mid-attempt polls only locate the route; an early poll over a few dozen ticks is
    // effectively a max, not a p99. A failed read fails the attempt, never passes it.
    const span = await loopP99(base, attemptStart);
    if (typeof span === "string")
      failures.push(`/api/perf: attempt ${a + 1} loop p99 unreadable (${span})`);
    const spanP99 = typeof span === "number" ? span : Number.POSITIVE_INFINITY;
    log(
      `  attempt ${a + 1}: loop p99 ${spanP99.toFixed(1)} ms over the attempt (running-p99 peak ${loopMax.toFixed(1)} ms at ${loopMaxRoute || "-"}); ${ingestReqs}/${totalReqs} requests (${overlap.toFixed(1)}%) during ingest`,
    );
    loopP99s.push(spanP99);
    overlaps.push(overlap);
    // An attempt that overlapped ingest is gated on its own: the median of 3 must not hide it.
    if (ingestReqs > 0 && spanP99 > LOOP_P99_MAX_MS)
      failures.push(
        `/api/perf: attempt ${a + 1} overlapped ingest (${overlap.toFixed(1)}%), loop p99 ${spanP99.toFixed(1)} ms > ${LOOP_P99_MAX_MS} ms (running-p99 peak at ${loopMaxRoute || "-"})`,
      );
  }
  const routes: GateRouteResult[] = [];
  for (const e of entries) {
    const p95s = perRoute.get(e.route) as number[];
    if (p95s.length === 0) continue; // already failed with an HTTP status
    const med = median(p95s);
    routes.push({ route: e.route, budget: e.budget, p95s, median: med });
    const over = med > e.budget;
    log(
      `  [${over ? "FAIL" : "ok"}] ${e.route}  p95 per attempt ${p95s.map((x) => x.toFixed(1)).join(" / ")} ms, median ${med.toFixed(1)} ms (budget ${e.budget} ms)`,
    );
    if (over)
      failures.push(
        `${e.route}: median p95 ${med.toFixed(1)} ms > budget ${e.budget} ms (attempts ${p95s.map((x) => x.toFixed(1)).join(" / ")})`,
      );
  }
  const loopMed = loopP99s.length > 0 ? median(loopP99s) : 0;
  log(
    `  [${loopMed > LOOP_P99_MAX_MS ? "FAIL" : "ok"}] /api/perf loop p99 per attempt ${loopP99s.map((x) => x.toFixed(1)).join(" / ")} ms, median ${loopMed.toFixed(1)} ms (max ${LOOP_P99_MAX_MS} ms; ingest-overlapped attempts also gated alone)`,
  );
  if (loopMed > LOOP_P99_MAX_MS)
    failures.push(
      `/api/perf: loop p99 ${loopMed.toFixed(1)} ms > ${LOOP_P99_MAX_MS} ms (attempts ${loopP99s.map((x) => x.toFixed(1)).join(" / ")})`,
    );
  return { ok: failures.length === 0, failures, routes, loopP99s, overlaps };
}
