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
import { seedSyntheticHistory } from "./synthetic-fixture.js";

const STARTUP_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 30_000;
const SYNTHETIC_TURNS = 1_000;

type CdpResponse = {
  fromDiskCache?: boolean;
  fromPrefetchCache?: boolean;
  fromServiceWorker?: boolean;
};

type CdpRequest = {
  requestId: string;
  response?: CdpResponse;
  fromDiskCache?: boolean;
  fromPrefetchCache?: boolean;
  fromServiceWorker?: boolean;
};

type PerformanceNavigation = { duration?: number; startTime?: number; loadEventEnd?: number };
type PerformanceEntry = { duration?: number; transferSize?: number; initiatorType?: string };

export type BrowserSample = {
  navigation?: PerformanceNavigation;
  requests?: CdpRequest[];
  retainedCacheEntries?: PerformanceEntry[];
};

export type BrowserMeasureRaw = {
  cold: BrowserSample;
  warm: BrowserSample;
  longTasks?: Array<{ duration?: number }>;
  commits?: Array<{ duration?: number }>;
};

export type BrowserMeasureSummary = {
  cold_navigation_ms: number;
  warm_navigation_ms: number;
  cold_request_count: number;
  warm_request_count: number;
  retained_cache_entries: number;
  long_task_count: number;
  long_task_total_ms: number;
  long_task_max_ms: number;
  commit_duration_ms: number;
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

/** Pure summary of CDP and Performance API-shaped values; intentionally no I/O. */
export function summarizeBrowserSamples(raw: BrowserMeasureRaw): BrowserMeasureSummary {
  const longTasks = raw.longTasks ?? [];
  const taskDurations = longTasks
    .map((entry) => finite(entry.duration))
    .filter((value) => value > 0);
  const commits = raw.commits ?? [];
  const retained = raw.warm.retainedCacheEntries ?? [];
  const cachedRequests = (raw.warm.requests ?? []).filter(isCached).length;
  const retainedResources = retained.filter(
    (entry) =>
      finite(entry.transferSize) === 0 &&
      entry.initiatorType !== "navigation" &&
      entry.initiatorType !== "other",
  ).length;
  return {
    cold_navigation_ms: navigationMs(raw.cold.navigation),
    warm_navigation_ms: navigationMs(raw.warm.navigation),
    cold_request_count: raw.cold.requests?.length ?? 0,
    warm_request_count: raw.warm.requests?.length ?? 0,
    // CDP identifies cache hits and Resource Timing catches entries retained without a response event.
    retained_cache_entries: Math.max(cachedRequests, retainedResources),
    long_task_count: taskDurations.length,
    long_task_total_ms: taskDurations.reduce((sum, duration) => sum + duration, 0),
    long_task_max_ms: Math.max(0, ...taskDurations),
    // LayoutDuration is Chrome's aggregate renderer layout/commit time, in milliseconds here.
    commit_duration_ms: commits.reduce((sum, entry) => sum + finite(entry.duration), 0),
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

async function startSyntheticChild(tempDir: string): Promise<ChildHarness> {
  const dbPath = path.join(tempDir, "synthetic.sqlite");
  const claudeDir = path.join(tempDir, "empty-claude");
  fs.mkdirSync(claudeDir);
  const db = openDb(dbPath);
  runMigrations(db);
  seedSyntheticHistory(db, SYNTHETIC_TURNS);
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

async function startSyntheticUi(
  childPort: number,
): Promise<{ url: string; close(): Promise<void> }> {
  const uiRoot = path.resolve("dist/ui");
  if (!fs.existsSync(path.join(uiRoot, "index.html")))
    throw new Error(
      "Production UI assets are unavailable; run npm run build:ui before browser measurement",
    );
  const server = http.createServer((request, response) => {
    const requestUrl = request.url ?? "/";
    if (requestUrl.startsWith("/api/")) {
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: childPort,
          path: requestUrl,
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

async function browserSample(
  client: CdpClient,
  sessionId: string,
  url: string,
): Promise<BrowserSample & { commit: number; longTasks: Array<{ duration?: number }> }> {
  const beforeMetrics = await client.call<{ metrics: Array<{ name: string; value: number }> }>(
    "Performance.getMetrics",
    {},
    sessionId,
  );
  const beforeLayoutSeconds =
    beforeMetrics.metrics.find((metric) => metric.name === "LayoutDuration")?.value ?? 0;
  const requests: CdpRequest[] = [];
  const removeRequest = client.on("Network.requestWillBeSent", (params) => {
    requests.push({ requestId: String(params.requestId ?? "") });
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
    const performance = await client.call<{
      result: {
        value: {
          navigation?: PerformanceNavigation[];
          resources?: PerformanceEntry[];
          longTasks?: Array<{ duration?: number }>;
        };
      };
    }>(
      "Runtime.evaluate",
      {
        // loadEventEnd stays 0 until the load handler finishes, so poll before sampling.
        expression:
          "new Promise((resolve) => { let tries = 0; const check = () => { const nav = performance.getEntriesByType('navigation')[0]; if ((nav && nav.loadEventEnd > 0) || tries >= 100) resolve({ navigation: performance.getEntriesByType('navigation').map(({ duration, startTime, loadEventEnd }) => ({ duration, startTime, loadEventEnd })), resources: performance.getEntriesByType('resource').map(({ duration, transferSize, initiatorType }) => ({ duration, transferSize, initiatorType })), longTasks: window.__awBrowserMeasure?.longTasks ?? [] }); else { tries += 1; setTimeout(check, 10); } }; check(); })",
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
    const value = performance.result.value;
    return {
      navigation: value.navigation?.[0] ?? {},
      requests,
      retainedCacheEntries: value.resources ?? [],
      longTasks: value.longTasks ?? [],
      commit: Math.max(0, afterLayoutSeconds - beforeLayoutSeconds) * 1_000,
    };
  } finally {
    removeRequest();
    removeResponse();
  }
}

async function main(): Promise<void> {
  // Keep the temporary root compatible with the child's synthetic-path guard.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-wrangler-synthetic-"));
  let chrome: Chrome | undefined;
  let child: ChildHarness | undefined;
  let ui: { url: string; close(): Promise<void> } | undefined;
  try {
    chrome = await launchChrome(path.join(tempDir, "chrome-profile"));
    if (!chrome) {
      console.log("Chrome unavailable, skipping browser run");
      return;
    }
    child = await startSyntheticChild(tempDir);
    ui = await startSyntheticUi(child.port);
    if (!isLoopbackUrl(ui.url)) throw new Error("Refusing a non-loopback browser target");
    const connection = await connect(chrome.wsUrl);
    try {
      const target = await connection.client.call<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      const attached = await connection.client.call<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
      );
      const sessionId = attached.sessionId;
      await connection.client.call("Page.enable", {}, sessionId);
      await connection.client.call("Network.enable", {}, sessionId);
      await connection.client.call("Performance.enable", {}, sessionId);
      await connection.client.call(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          source:
            "window.__awBrowserMeasure={longTasks:[]};new PerformanceObserver((list)=>window.__awBrowserMeasure.longTasks.push(...list.getEntries().map(({duration})=>({duration})))).observe({type:'longtask',buffered:true});",
        },
        sessionId,
      );
      const cold = await browserSample(connection.client, sessionId, ui.url);
      const warm = await browserSample(connection.client, sessionId, ui.url);
      console.log(
        JSON.stringify(
          {
            synthetic_only: true,
            production_assets: true,
            ...summarizeBrowserSamples({
              cold,
              warm,
              longTasks: [...cold.longTasks, ...warm.longTasks],
              commits: [{ duration: cold.commit }, { duration: warm.commit }],
            }),
          },
          null,
          2,
        ),
      );
    } finally {
      connection.close();
    }
  } finally {
    await ui?.close();
    await child?.close();
    await chrome?.close();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
