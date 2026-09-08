"use strict";

// Loaded before the production daemon. It confines filesystem identity through
// the parent's environment and fails closed on every external I/O surface the
// daemon can otherwise reach during boot or recurring work.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const { syncBuiltinESMExports } = require("node:module");

const PREFIX = "agent-wrangler-production-profile-";
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`production profile guard requires ${name}`);
  return value;
};
const root = fs.realpathSync(required("AW_PROFILE_SYNTHETIC_ROOT"));
if (!path.basename(root).startsWith(PREFIX)) {
  throw new Error("production profile guard rejects a non-profile root");
}
const isInside = (candidate) => {
  const relative = path.relative(root, fs.realpathSync(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
};
for (const name of [
  "AW_DB_PATH",
  "AW_SCAN_ROOT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "TEMP",
  "TMP",
]) {
  if (!isInside(required(name))) throw new Error(`production profile guard rejects ${name}`);
}
if (path.basename(fs.realpathSync(process.env.AW_DB_PATH)) !== "synthetic.sqlite") {
  throw new Error("production profile guard requires synthetic.sqlite");
}
if (process.env.AW_UI_ROOT && !isInside(process.env.AW_UI_ROOT)) {
  throw new Error("production profile guard rejects AW_UI_ROOT outside the profile root");
}
if (process.env.AW_PORT !== "0" || process.env.AW_NO_OPEN !== "1") {
  throw new Error("production profile guard requires an ephemeral port and disabled browser open");
}

let boundaryAttempts = 0;
const emit = (event) => {
  if (typeof process.send === "function") process.send({ awProfile: true, ...event });
};
const blocked = (surface) => {
  boundaryAttempts += 1;
  emit({ event: "boundary-blocked", surface });
  const error = new Error(`production profile blocked ${surface}`);
  error.code = "AW_PROFILE_BOUNDARY";
  throw error;
};

for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {
  childProcess[name] = (..._args) => blocked(`child_process.${name}`);
}
syncBuiltinESMExports();

const loopback = (host) =>
  host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
const connectionHost = (args) => {
  const first = args[0];
  if (typeof first === "object" && first !== null) return first.host ?? first.hostname;
  if (typeof first === "number") return typeof args[1] === "string" ? args[1] : "localhost";
  return undefined;
};
for (const [owner, name] of [
  [net, "connect"],
  [net, "createConnection"],
  [tls, "connect"],
]) {
  const original = owner[name];
  owner[name] = function guardedConnect(...args) {
    const host = connectionHost(args);
    if (!loopback(host)) return blocked(`${owner === tls ? "tls" : "net"}.${name}`);
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();

globalThis.fetch = async (..._args) => blocked("fetch");

const nativeSetInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
const registrations = new Map();
let nextTimerId = 1;
let timerMode = "paused";
const maxAcceleratedFires = 2;
const acceleratedDelay = (delay) => {
  if (delay <= 2_000) return 200;
  if (delay <= 30_000) return 400;
  if (delay <= 10 * 60_000) return 600;
  return 800;
};
const schedule = (registration) => {
  if (registration.cancelled || registration.nativeHandle || timerMode === "paused") return;
  registration.fires = 0;
  const actualDelay =
    timerMode === "production"
      ? registration.originalDelay
      : acceleratedDelay(registration.originalDelay);
  registration.nativeHandle = nativeSetInterval(() => {
    registration.fires += 1;
    const beforeCpu = process.cpuUsage();
    const before = performance.now();
    emit({
      event: "timer-fired",
      id: registration.id,
      originalDelayMs: registration.originalDelay,
      mode: timerMode,
      fire: registration.fires,
    });
    try {
      registration.callback(...registration.args);
    } finally {
      const cpu = process.cpuUsage(beforeCpu);
      emit({
        event: "timer-returned",
        id: registration.id,
        originalDelayMs: registration.originalDelay,
        mode: timerMode,
        elapsedMs: performance.now() - before,
        cpuMs: (cpu.user + cpu.system) / 1_000,
      });
      if (timerMode === "accelerated" && registration.fires >= maxAcceleratedFires) {
        nativeClearInterval(registration.nativeHandle);
        registration.nativeHandle = null;
      }
    }
  }, actualDelay);
};

globalThis.setInterval = (callback, delay = 0, ...args) => {
  const handle = {
    ref() {
      return handle;
    },
    unref() {
      return handle;
    },
    hasRef() {
      return false;
    },
    refresh() {
      return handle;
    },
  };
  const registration = {
    id: nextTimerId++,
    callback,
    args,
    originalDelay: Number(delay),
    nativeHandle: null,
    fires: 0,
    cancelled: false,
  };
  registrations.set(handle, registration);
  emit({
    event: "timer-registered",
    id: registration.id,
    originalDelayMs: registration.originalDelay,
  });
  schedule(registration);
  return handle;
};
globalThis.clearInterval = (handle) => {
  const registration = registrations.get(handle);
  if (!registration) return nativeClearInterval(handle);
  registration.cancelled = true;
  if (registration.nativeHandle) nativeClearInterval(registration.nativeHandle);
  registration.nativeHandle = null;
};

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const snapshot = (requestId) => {
  const cpu = process.cpuUsage();
  emit({
    event: "sample",
    requestId,
    cpuUserUs: cpu.user,
    cpuSystemUs: cpu.system,
    rssBytes: process.memoryUsage().rss,
    eventLoopP50Ns: loop.percentile(50),
    eventLoopP95Ns: loop.percentile(95),
    eventLoopMaxNs: loop.max,
    boundaryAttempts,
  });
  loop.reset();
};
process.on("message", (message) => {
  if (!message || message.awProfile !== true) return;
  if (message.command === "sample") snapshot(message.requestId);
  if (message.command === "stop-timers") {
    timerMode = "paused";
    for (const registration of registrations.values()) {
      if (registration.nativeHandle) nativeClearInterval(registration.nativeHandle);
      registration.nativeHandle = null;
    }
    emit({ event: "timers-stopped", requestId: message.requestId });
  }
  if (message.command === "start-timers") {
    timerMode = message.mode === "production" ? "production" : "accelerated";
    for (const registration of registrations.values()) schedule(registration);
    emit({ event: "timers-started", requestId: message.requestId, mode: timerMode });
  }
});

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function profileListen(...args) {
  this.once("listening", () => {
    const address = this.address();
    emit({ event: "server-listening", address });
  });
  return originalListen.apply(this, args);
};

emit({ event: "guard-ready", root });
