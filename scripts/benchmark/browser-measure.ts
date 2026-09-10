/**
 * Synthetic browser measurement over the Chrome DevTools Protocol.
 *
 * Run with: node --import tsx/esm scripts/benchmark/browser-measure.ts
 *
 * This intentionally uses a fresh, temporary Chrome profile and the production
 * Vite output in dist/ui.  It never starts the operator daemon, reads an
 * operator database, or allows a non-loopback browser target.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/open.js";
import {
  SYNTHETIC_WINDOW_FROM,
  SYNTHETIC_WINDOW_TO,
  seedSyntheticHistory,
} from "./synthetic-fixture.js";

const STARTUP_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 30_000;
const BROWSER_SCALES = [1_000, 10_000, 100_000] as const;
const PROFILING_SCALE = 1_000;

/** Hash routes measured per scale, with the API request that marks readiness. */
const BROWSER_ROUTES = [
  { name: "overview", hash: "#/overview", api: "/api/overview?", selector: "rv7-tile-row" },
  { name: "hot_sessions", hash: "#/sessions", api: "/api/hot-sessions", selector: null },
  { name: "workspaces", hash: "#/workspaces", api: "/api/workspaces?", selector: null },
  {
    name: "recommendations",
    hash: "#/recommendations",
    api: "/api/recommendations",
    selector: null,
  },
] as const;

type BrowserRoute = (typeof BROWSER_ROUTES)[number];

type CdpResponse = {
  fromDiskCache?: boolean;
  fromPrefetchCache?: boolean;
  fromServiceWorker?: boolean;
};

type CdpRequest = {
  requestId: string;
  url?: string;
  method?: string;
  response?: CdpResponse;
  fromDiskCache?: boolean;
  fromPrefetchCache?: boolean;
  fromServiceWorker?: boolean;
};

type PerformanceNavigation = { duration?: number; startTime?: number; loadEventEnd?: number };
type PerformanceEntry = { duration?: number; transferSize?: number; initiatorType?: string };

export type BrowserSample = {
  navigation?: PerformanceNavigation;
  overviewReadyMs?: number;
  requests?: CdpRequest[];
  retainedCacheEntries?: PerformanceEntry[];
};

export type BrowserMeasureRaw = {
  cold: BrowserSample;
  warm: BrowserSample;
  longTasks?: Array<{ duration?: number }>;
  layoutDurations?: Array<{ duration?: number }>;
};

export type BrowserMeasureSummary = {
  cold_navigation_ms: number;
  warm_navigation_ms: number;
  cold_overview_ready_ms: number;
  warm_overview_ready_ms: number;
  cold_request_count: number;
  warm_request_count: number;
  eligible_request_count: number;
  duplicate_eligible_requests: number;
  retained_cache_entries: number;
  long_task_count: number;
  long_task_total_ms: number;
  long_task_max_ms: number;
  layout_duration_ms: number;
};

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function navigationMs(navigation: PerformanceNavigation | undefined): number {
  if (!navigation) return 0;
  if (finite(navigation.duration) > 0) return finite(navigation.duration);
  return Math.max(0, finite(navigation.loadEventEnd) - finite(navigation.startTime));
}

function isCached(request: CdpRequest): boolean {
  return Boolean(
    request.fromDiskCache ||
      request.fromPrefetchCache ||
      request.fromServiceWorker ||
      request.response?.fromDiskCache ||
      request.response?.fromPrefetchCache ||
      request.response?.fromServiceWorker,
  );
}

function normalizedApiPath(url: URL): string {
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

function normalizedEligibleApiUrl(request: CdpRequest): string | undefined {
  if (request.method !== "GET" || !request.url || !isLoopbackUrl(request.url)) return undefined;
  const url = new URL(request.url);
  if (
    !url.pathname.startsWith("/api/") ||
    url.pathname === "/api/live" ||
    url.pathname === "/api/status" ||
    url.pathname === "/api/burn-status"
  )
    return undefined;
  return normalizedApiPath(url);
}

/** Pure summary of CDP and Performance API-shaped values; intentionally no I/O. */
export function summarizeBrowserSamples(raw: BrowserMeasureRaw): BrowserMeasureSummary {
  const longTasks = raw.longTasks ?? [];
  const taskDurations = longTasks
    .map((entry) => finite(entry.duration))
    .filter((value) => value > 0);
  const layoutDurations = raw.layoutDurations ?? [];
  const retained = raw.warm.retainedCacheEntries ?? [];
  const cachedRequests = (raw.warm.requests ?? []).filter(isCached).length;
  // Duplicates are counted per document — cold and warm are separate navigations,
  // so a URL fetched once in each is reuse across documents, not duplication.
  const perDocument = [raw.cold.requests ?? [], raw.warm.requests ?? []].map((requests) =>
    requests
      .map((request) => ({ request, url: normalizedEligibleApiUrl(request) }))
      .filter((entry): entry is { request: CdpRequest; url: string } => entry.url !== undefined),
  );
  const eligibleRequests = perDocument.flat();
  let duplicateEligibleRequests = 0;
  for (const documentRequests of perDocument) {
    const eligibleFetchCounts = new Map<string, number>();
    for (const { request, url } of documentRequests)
      if (!isCached(request)) eligibleFetchCounts.set(url, (eligibleFetchCounts.get(url) ?? 0) + 1);
    duplicateEligibleRequests += [...eligibleFetchCounts.values()].filter(
      (count) => count >= 2,
    ).length;
  }
  const retainedResources = retained.filter(
    (entry) =>
      finite(entry.transferSize) === 0 &&
      entry.initiatorType !== "navigation" &&
      entry.initiatorType !== "other",
  ).length;
  return {
    cold_navigation_ms: navigationMs(raw.cold.navigation),
    warm_navigation_ms: navigationMs(raw.warm.navigation),
    cold_overview_ready_ms: finite(raw.cold.overviewReadyMs),
    warm_overview_ready_ms: finite(raw.warm.overviewReadyMs),
    cold_request_count: raw.cold.requests?.length ?? 0,
    warm_request_count: raw.warm.requests?.length ?? 0,
    eligible_request_count: eligibleRequests.length,
    duplicate_eligible_requests: duplicateEligibleRequests,
    // CDP identifies cache hits and Resource Timing catches entries retained without a response event.
    retained_cache_entries: Math.max(cachedRequests, retainedResources),
    long_task_count: taskDurations.length,
    long_task_total_ms: taskDurations.reduce((sum, duration) => sum + duration, 0),
    long_task_max_ms: Math.max(0, ...taskDurations),
    // Chrome LayoutDuration is aggregate renderer layout time, not React commit duration.
    layout_duration_ms: layoutDurations.reduce((sum, entry) => sum + finite(entry.duration), 0),
  };
}

type ChildHarness = { port: number; close(): Promise<void> };

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function waitForReady(child: childProcess.ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Synthetic daemon child did not become ready")),
      STARTUP_TIMEOUT_MS,
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      for (;;) {
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          const event = JSON.parse(line) as { event?: string; port?: unknown };
          const port = Number(event.port);
          if (event.event === "ready" && Number.isInteger(port) && port > 0) {
            clearTimeout(timer);
            resolve(port);
            return;
          }
        } catch {
          // The child emits JSON lines; ignore an incomplete/non-event line.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Synthetic daemon child exited ${code} before ready`));
    });
  });
}

async function startSyntheticChild(tempDir: string, turns: number): Promise<ChildHarness> {
  const dbPath = path.join(tempDir, "synthetic.sqlite");
  const claudeDir = path.join(tempDir, "empty-claude");
  fs.mkdirSync(claudeDir);
  const db = openDb(dbPath);
  runMigrations(db);
  seedSyntheticHistory(db, turns);
  db.close();
  const childScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "synthetic-daemon-child.ts",
  );
  const child = childProcess.spawn(
    process.execPath,
    ["--import", "tsx/esm", childScript, "--db", dbPath, "--claude-dir", claudeDir],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const port = await waitForReady(child);
  return {
    port,
    async close(): Promise<void> {
      if (!child.killed && child.exitCode === null) child.stdin?.write('{"command":"shutdown"}\n');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function contentType(file: string): string {
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json";
  return "text/html; charset=utf-8";
}

/**
 * The synthetic fixture is historical, while the production Overview defaults
 * to a real-clock 7-day preset. Keep the production UI unchanged and rewrite
 * only fixture-backed preset requests to its fixed, populated window.
 */
export function syntheticBenchmarkApiPath(requestUrl: string): string {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname.startsWith("/api/") && url.searchParams.has("preset")) {
    url.searchParams.delete("preset");
    url.searchParams.set("from", SYNTHETIC_WINDOW_FROM);
    url.searchParams.set("to", SYNTHETIC_WINDOW_TO);
  }
  return normalizedApiPath(url);
}

async function startSyntheticUi(
  childPort: number,
  uiRootDir = "dist/ui",
  rewritePresets = true,
): Promise<{ url: string; close(): Promise<void> }> {
  const uiRoot = path.resolve(uiRootDir);
  if (!fs.existsSync(path.join(uiRoot, "index.html")))
    throw new Error(
      `Production UI assets are unavailable at ${uiRootDir}; run npm run build:ui${
        uiRootDir === "dist/ui" ? "" : ":profiling"
      } before browser measurement`,
    );
  const server = http.createServer((request, response) => {
    const requestUrl = request.url ?? "/";
    if (requestUrl.startsWith("/api/")) {
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: childPort,
          path: rewritePresets ? syntheticBenchmarkApiPath(requestUrl) : requestUrl,
          method: request.method,
          headers: request.headers,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
      return;
    }
    const pathname = decodeURIComponent(requestUrl.split("?")[0] ?? "/");
    const candidate = path.resolve(uiRoot, `.${pathname}`);
    const file =
      candidate.startsWith(`${uiRoot}${path.sep}`) && fs.existsSync(candidate)
        ? candidate
        : path.join(uiRoot, "index.html");
    response.writeHead(200, {
      "Content-Type": contentType(file),
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Synthetic UI did not receive an ephemeral port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function chromeCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const configured: string[] = [
    process.env.CHROME_PATH,
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  return configured.filter((candidate) => fs.existsSync(candidate));
}

type Chrome = { process: childProcess.ChildProcess; wsUrl: string; close(): Promise<void> };

async function launchChrome(profileDir: string): Promise<Chrome | undefined> {
  const executable = chromeCandidates()[0];
  if (!executable) return undefined;
  let chrome: childProcess.ChildProcess;
  try {
    chrome = childProcess.spawn(
      executable,
      [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-gpu",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
  } catch {
    return undefined;
  }
  const wsUrl = await new Promise<string | undefined>((resolve) => {
    let stderr = "";
    const timer = setTimeout(() => resolve(undefined), STARTUP_TIMEOUT_MS);
    chrome.stderr?.setEncoding("utf8");
    chrome.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    chrome.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  if (!wsUrl) {
    chrome.kill();
    return undefined;
  }
  return {
    process: chrome,
    wsUrl,
    close: async () => {
      if (chrome.exitCode !== null) return;
      chrome.kill();
      await new Promise<void>((resolve) => chrome.once("exit", () => resolve()));
    },
  };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message?: string };
      };
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "CDP error"));
        else pending.resolve(message.result);
        return;
      }
      if (message.method)
        for (const listener of this.listeners.get(message.method) ?? [])
          listener(message.params ?? {});
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  once(method: string, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const listener = (params: Record<string, unknown>) => {
        clearTimeout(timer);
        this.listeners.set(
          method,
          (this.listeners.get(method) ?? []).filter((item) => item !== listener),
        );
        resolve(params);
      };
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    });
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    return () =>
      this.listeners.set(
        method,
        (this.listeners.get(method) ?? []).filter((item) => item !== listener),
      );
  }
}

type CdpRuntimeEvaluation<T> = {
  result?: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

function requireRuntimeValue<T>(evaluation: CdpRuntimeEvaluation<T>, label: string): T {
  const exception = evaluation.exceptionDetails;
  if (exception) {
    throw new Error(
      `${label} failed in the page: ${exception.exception?.description ?? exception.text ?? "unknown exception"}`,
    );
  }
  if (evaluation.result?.value === undefined) throw new Error(`${label} did not return a value`);
  return evaluation.result.value;
}

async function connect(wsUrl: string): Promise<{ client: CdpClient; close(): void }> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("CDP WebSocket connection timed out")),
      STARTUP_TIMEOUT_MS,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket connection failed"));
      },
      { once: true },
    );
  });
  return { client: new CdpClient(socket), close: () => socket.close() };
}

/** Route readiness: its API request observed, nothing aria-busy, double rAF settle. */
function readinessExpression(api: string, selector: string | null): string {
  const selectorCheck =
    selector === null ? "true" : `Boolean(document.querySelector('[data-testid="${selector}"]'))`;
  return `new Promise((resolve, reject) => { const deadline = performance.now() + 30000; const check = () => { const apiLoaded = performance.getEntriesByType('resource').some((entry) => entry.name.includes('${api}')); const busy = document.querySelector('[aria-busy="true"]'); if (${selectorCheck} && apiLoaded && !busy) { requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))); return; } if (performance.now() >= deadline) { reject(new Error('Route did not finish rendering after its API query')); return; } setTimeout(check, 25); }; check(); })`;
}

async function navigateBlank(client: CdpClient, sessionId: string): Promise<void> {
  const load = client.once("Page.loadEventFired", PAGE_TIMEOUT_MS);
  await client.call("Page.navigate", { url: "about:blank" }, sessionId);
  await load;
}

async function browserSample(
  client: CdpClient,
  sessionId: string,
  url: string,
  readiness: { api: string; selector: string | null },
): Promise<
  BrowserSample & {
    layoutDuration: number;
    longTasks: Array<{ duration?: number }>;
    reactCommits: Array<{ duration?: number | null }>;
    overviewReadyMs: number;
  }
> {
  const beforeMetrics = await client.call<{ metrics: Array<{ name: string; value: number }> }>(
    "Performance.getMetrics",
    {},
    sessionId,
  );
  const beforeLayoutSeconds =
    beforeMetrics.metrics.find((metric) => metric.name === "LayoutDuration")?.value ?? 0;
  const requests: CdpRequest[] = [];
  const removeRequest = client.on("Network.requestWillBeSent", (params) => {
    const request = params.request as Record<string, unknown> | undefined;
    requests.push({
      requestId: String(params.requestId ?? ""),
      ...(typeof request?.url === "string" ? { url: request.url } : {}),
      ...(typeof request?.method === "string" ? { method: request.method } : {}),
    });
  });
  const removeResponse = client.on("Network.responseReceived", (params) => {
    const received = params.response as Record<string, unknown> | undefined;
    const response: CdpResponse | undefined = received
      ? {
          ...(typeof received.fromDiskCache === "boolean"
            ? { fromDiskCache: received.fromDiskCache }
            : {}),
          ...(typeof received.fromPrefetchCache === "boolean"
            ? { fromPrefetchCache: received.fromPrefetchCache }
            : {}),
          ...(typeof received.fromServiceWorker === "boolean"
            ? { fromServiceWorker: received.fromServiceWorker }
            : {}),
        }
      : undefined;
    const request = requests.find((entry) => entry.requestId === String(params.requestId ?? ""));
    if (request && response) request.response = response;
  });
  try {
    const load = client.once("Page.loadEventFired", PAGE_TIMEOUT_MS);
    await client.call("Page.navigate", { url }, sessionId);
    await load;
    const readinessResult = await client.call<CdpRuntimeEvaluation<number>>(
      "Runtime.evaluate",
      {
        expression: readinessExpression(readiness.api, readiness.selector),
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    const performance = await client.call<
      CdpRuntimeEvaluation<{
        navigation?: PerformanceNavigation[];
        resources?: PerformanceEntry[];
        longTasks?: Array<{ duration?: number }>;
        reactCommits?: Array<{ duration?: number | null }>;
      }>
    >(
      "Runtime.evaluate",
      {
        // loadEventEnd stays 0 until the load handler finishes, so poll before sampling.
        expression:
          "new Promise((resolve) => { let tries = 0; const check = () => { const nav = performance.getEntriesByType('navigation')[0]; if ((nav && nav.loadEventEnd > 0) || tries >= 100) resolve({ navigation: performance.getEntriesByType('navigation').map(({ duration, startTime, loadEventEnd }) => ({ duration, startTime, loadEventEnd })), resources: performance.getEntriesByType('resource').map(({ duration, transferSize, initiatorType }) => ({ duration, transferSize, initiatorType })), longTasks: window.__awBrowserMeasure?.longTasks ?? [], reactCommits: window.__awBrowserMeasure?.reactCommits ?? [] }); else { tries += 1; setTimeout(check, 10); } }; check(); })",
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    const metrics = await client.call<{ metrics: Array<{ name: string; value: number }> }>(
      "Performance.getMetrics",
      {},
      sessionId,
    );
    const afterLayoutSeconds =
      metrics.metrics.find((metric) => metric.name === "LayoutDuration")?.value ?? 0;
    const value = requireRuntimeValue(performance, "Browser performance sample");
    return {
      navigation: value.navigation?.[0] ?? {},
      requests,
      retainedCacheEntries: value.resources ?? [],
      longTasks: value.longTasks ?? [],
      reactCommits: value.reactCommits ?? [],
      layoutDuration: Math.max(0, afterLayoutSeconds - beforeLayoutSeconds) * 1_000,
      overviewReadyMs: requireRuntimeValue(readinessResult, "Route readiness"),
    };
  } finally {
    removeRequest();
    removeResponse();
  }
}

// Installed before every document: long-task observer plus a minimal React
// DevTools hook. With the profiling bundle (dist/ui-profiling) each commit's
// root actualDuration is real; with the production bundle it is null.
const PAGE_INSTRUMENTATION_SOURCE =
  "window.__awBrowserMeasure={longTasks:[],reactCommits:[]};" +
  "new PerformanceObserver((list)=>window.__awBrowserMeasure.longTasks.push(...list.getEntries().map(({duration})=>({duration})))).observe({type:'longtask',buffered:true});" +
  "window.__REACT_DEVTOOLS_GLOBAL_HOOK__={isDisabled:false,supportsFiber:true,renderers:new Map(),inject:function(){return 1;},onScheduleFiberRoot:function(){},onCommitFiberRoot:function(id,root){try{var d=root&&root.current&&root.current.actualDuration;window.__awBrowserMeasure.reactCommits.push({duration:typeof d==='number'?d:null});}catch(e){}},onCommitFiberUnmount:function(){},onPostCommitFiberRoot:function(){},checkDCE:function(){}};";

const APP_CACHE_STATS_EXPRESSION =
  "(() => { const cache = window.__awResponseCache; if (!(cache instanceof Map)) return { available: false }; let bytes = 0; for (const entry of cache.values()) { try { bytes += JSON.stringify(entry.data).length; } catch {} } return { available: true, entries: cache.size, approx_payload_bytes: bytes }; })()";

interface PageSession {
  sessionId: string;
  close(): Promise<void>;
}

async function openPageSession(client: CdpClient): Promise<PageSession> {
  const target = await client.call<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const attached = await client.call<{ sessionId: string }>("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;
  await client.call("Page.enable", {}, sessionId);
  await client.call("Network.enable", {}, sessionId);
  await client.call("Performance.enable", {}, sessionId);
  await client.call(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: PAGE_INSTRUMENTATION_SOURCE },
    sessionId,
  );
  return {
    sessionId,
    close: async () => {
      await client.call("Target.closeTarget", { targetId: target.targetId });
    },
  };
}

async function evaluate<T>(
  client: CdpClient,
  sessionId: string,
  expression: string,
  label: string,
): Promise<T> {
  const result = await client.call<CdpRuntimeEvaluation<T>>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  return requireRuntimeValue(result, label);
}

/** In-document hash navigation; readiness mirrors readinessExpression. */
function spaHopExpression(hash: string, api: string): string {
  return `new Promise((resolve, reject) => { location.hash = '${hash}'; const deadline = performance.now() + 30000; const check = () => { const apiLoaded = performance.getEntriesByType('resource').some((entry) => entry.name.includes('${api}')); const busy = document.querySelector('[aria-busy="true"]'); if (apiLoaded && !busy) { requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))); return; } if (performance.now() >= deadline) { reject(new Error('SPA route ${hash} did not become ready')); return; } setTimeout(check, 25); }; check(); })`;
}

const OVERVIEW_REQUEST_COUNT_EXPRESSION =
  "performance.getEntriesByType('resource').filter((entry) => /\\/api\\/overview(\\?|$)/.test(entry.name)).length";

function summarizeDurations(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  const nearestRank = (quantile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
  return {
    count: sorted.length,
    total_ms: Number(sorted.reduce((sum, value) => sum + value, 0).toFixed(3)),
    p50_ms: Number(nearestRank(0.5).toFixed(3)),
    p95_ms: Number(nearestRank(0.95).toFixed(3)),
    max_ms: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
  };
}

async function measureScale(client: CdpClient, scale: number): Promise<Record<string, unknown>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-synthetic-"));
  let child: ChildHarness | undefined;
  let ui: { url: string; close(): Promise<void> } | undefined;
  let session: PageSession | undefined;
  try {
    child = await startSyntheticChild(tempDir, scale);
    ui = await startSyntheticUi(child.port);
    if (!isLoopbackUrl(ui.url)) throw new Error("Refusing a non-loopback browser target");
    session = await openPageSession(client);
    const routeResults: Record<string, unknown>[] = [];
    for (const route of BROWSER_ROUTES) {
      // Each cold sample starts from a cleared browser cache; the shared Chrome
      // profile would otherwise carry asset cache across scales and routes.
      await client.call("Network.clearBrowserCache", {}, session.sessionId);
      await navigateBlank(client, session.sessionId);
      const cold = await browserSample(client, session.sessionId, `${ui.url}${route.hash}`, route);
      await navigateBlank(client, session.sessionId);
      const warm = await browserSample(client, session.sessionId, `${ui.url}${route.hash}`, route);
      routeResults.push({
        name: route.name,
        hash: route.hash,
        ...summarizeBrowserSamples({
          cold,
          warm,
          longTasks: [...cold.longTasks, ...warm.longTasks],
          layoutDurations: [{ duration: cold.layoutDuration }, { duration: warm.layoutDuration }],
        }),
      });
    }
    // Application query-cache retention: one document visiting every measured
    // route in place, then the retained module-level response-cache stats.
    await navigateBlank(client, session.sessionId);
    const first = BROWSER_ROUTES[0];
    await browserSample(client, session.sessionId, `${ui.url}${first.hash}`, first);
    for (const route of BROWSER_ROUTES.slice(1)) {
      await evaluate(
        client,
        session.sessionId,
        spaHopExpression(route.hash, route.api),
        `SPA hop ${route.name}`,
      );
    }
    const appCache = await evaluate<Record<string, unknown>>(
      client,
      session.sessionId,
      APP_CACHE_STATS_EXPRESSION,
      "App cache stats",
    );
    return {
      scale_turns: scale,
      routes: routeResults,
      app_cache_retention: {
        ...appCache,
        method:
          "One document SPA-navigates across all measured routes, then reads the module-level responseCache (window.__awResponseCache) cardinality and approximate retained payload bytes.",
      },
    };
  } finally {
    if (session) await session.close();
    await ui?.close();
    await child?.close();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Live moving-preset cache behavior: with preset rewriting disabled, the app
 * resolves its rolling preset against the real clock (the historical fixture is
 * out of range, so responses are empty). A revisit within the response-cache
 * TTL that issues no new overview request demonstrates that the document-local
 * cache reuses a rolling-preset key even though its effective window advanced.
 */
async function measureLivePresetCache(client: CdpClient): Promise<Record<string, unknown>> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-synthetic-"));
  let child: ChildHarness | undefined;
  let ui: { url: string; close(): Promise<void> } | undefined;
  let session: PageSession | undefined;
  try {
    child = await startSyntheticChild(tempDir, PROFILING_SCALE);
    ui = await startSyntheticUi(child.port, "dist/ui", false);
    if (!isLoopbackUrl(ui.url)) throw new Error("Refusing a non-loopback browser target");
    session = await openPageSession(client);
    await navigateBlank(client, session.sessionId);
    const load = client.once("Page.loadEventFired", PAGE_TIMEOUT_MS);
    await client.call("Page.navigate", { url: `${ui.url}#/overview` }, session.sessionId);
    await load;
    await evaluate(
      client,
      session.sessionId,
      readinessExpression("/api/overview?", null),
      "Live preset overview readiness",
    );
    const firstVisitRequests = await evaluate<number>(
      client,
      session.sessionId,
      OVERVIEW_REQUEST_COUNT_EXPRESSION,
      "Overview request count",
    );
    await evaluate(
      client,
      session.sessionId,
      spaHopExpression("#/workspaces", "/api/workspaces?"),
      "SPA hop workspaces",
    );
    await evaluate(
      client,
      session.sessionId,
      spaHopExpression("#/overview", "/api/overview?"),
      "SPA hop back to overview",
    );
    const revisitRequests = await evaluate<number>(
      client,
      session.sessionId,
      OVERVIEW_REQUEST_COUNT_EXPRESSION,
      "Overview request count after revisit",
    );
    const appCache = await evaluate<Record<string, unknown>>(
      client,
      session.sessionId,
      APP_CACHE_STATS_EXPRESSION,
      "App cache stats",
    );
    return {
      available: true,
      preset_rewriting_disabled: true,
      fixture_note:
        "The historical fixture is outside the live preset window, so responses are empty; cache-key behavior is unaffected by payload size.",
      overview_requests_first_visit: firstVisitRequests,
      overview_requests_after_spa_revisit: revisitRequests,
      revisit_within_ttl_refetched: revisitRequests > firstVisitRequests,
      app_cache_retention: appCache,
    };
  } finally {
    if (session) await session.close();
    await ui?.close();
    await child?.close();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** React commit durations from the profiling bundle (dist/ui-profiling). */
async function measureReactCommits(client: CdpClient): Promise<Record<string, unknown>> {
  if (!fs.existsSync(path.resolve("dist/ui-profiling", "index.html"))) {
    return {
      available: false,
      reason:
        "dist/ui-profiling is missing; run npm run build:ui:profiling before browser measurement",
    };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-synthetic-"));
  let child: ChildHarness | undefined;
  let ui: { url: string; close(): Promise<void> } | undefined;
  let session: PageSession | undefined;
  try {
    child = await startSyntheticChild(tempDir, PROFILING_SCALE);
    ui = await startSyntheticUi(child.port, "dist/ui-profiling");
    if (!isLoopbackUrl(ui.url)) throw new Error("Refusing a non-loopback browser target");
    session = await openPageSession(client);
    const overview = BROWSER_ROUTES[0];
    await client.call("Network.clearBrowserCache", {}, session.sessionId);
    await navigateBlank(client, session.sessionId);
    const cold = await browserSample(
      client,
      session.sessionId,
      `${ui.url}${overview.hash}`,
      overview,
    );
    await navigateBlank(client, session.sessionId);
    const warm = await browserSample(
      client,
      session.sessionId,
      `${ui.url}${overview.hash}`,
      overview,
    );
    const durations = (samples: Array<{ duration?: number | null }>): number[] =>
      samples
        .map((entry) => entry.duration)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const coldDurations = durations(cold.reactCommits);
    const warmDurations = durations(warm.reactCommits);
    if (coldDurations.length === 0)
      throw new Error("Profiling bundle produced no React commit durations");
    return {
      available: true,
      assets: "dist/ui-profiling (react-dom/profiling; separate build identity from dist/ui)",
      scale_turns: PROFILING_SCALE,
      route: overview.name,
      cold_commits: summarizeDurations(coldDurations),
      warm_commits: summarizeDurations(warmDurations),
    };
  } finally {
    if (session) await session.close();
    await ui?.close();
    await child?.close();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function main(): Promise<void> {
  // Keep the temporary root compatible with the child's synthetic-path guard.
  const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-synthetic-"));
  let chrome: Chrome | undefined;
  try {
    chrome = await launchChrome(path.join(chromeDir, "chrome-profile"));
    if (!chrome) {
      console.log("Chrome unavailable, skipping browser run");
      return;
    }
    const connection = await connect(chrome.wsUrl);
    try {
      const scales: Record<string, unknown>[] = [];
      for (const scale of BROWSER_SCALES) scales.push(await measureScale(connection.client, scale));
      const livePresetCache = await measureLivePresetCache(connection.client);
      const reactCommits = await measureReactCommits(connection.client);
      console.log(
        JSON.stringify(
          {
            synthetic_only: true,
            production_assets: true,
            synthetic_window: { from: SYNTHETIC_WINDOW_FROM, to: SYNTHETIC_WINDOW_TO },
            preset_requests_rewritten_to_synthetic_window: true,
            readiness_definition:
              "Route readiness: the route's API request appears in resource timing, nothing is aria-busy, then a double requestAnimationFrame settle. Overview additionally requires its tile row.",
            cold_definition:
              "Each cold navigation starts from a cleared browser cache via Network.clearBrowserCache; warm repeats the same navigation with the cache retained.",
            scales,
            live_preset_cache: livePresetCache,
            react_commit_profiling: reactCommits,
          },
          null,
          2,
        ),
      );
    } finally {
      connection.close();
    }
  } finally {
    await chrome?.close();
    fs.rmSync(chromeDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
