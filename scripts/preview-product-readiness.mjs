// Synthetic UI only. Does not import the daemon, DB, credentials or provider clients.
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const repo = fileURLToPath(new URL("../", import.meta.url));
// Fixture-only: the mock client serves the data; never load a local DB or certification store.
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  mode: "test",
  server: { host: "127.0.0.1", port: 47841, strictPort: true, fs: { allow: [repo] } },
  plugins: [{
    name: "product-readiness-fixture-only",
    enforce: "pre",
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/") || /\.[cm]?[jt]sx?(?:\?|$)/.test(req.url)) return next();
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (req.url === "/api/ready") return res.end(JSON.stringify({ ready: true }));
        if (req.url === "/api/status") return res.end(JSON.stringify({ scan_state: "complete", files_seen: 0, sessions: 0 }));
        if (req.url === "/api/history-progress") return res.end(JSON.stringify({ complete: true, processing: false, failed: false, revision: "synthetic" }));
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "Unavailable in synthetic UI preview" }));
      });
    },
  }],
});
await server.listen();
console.log(JSON.stringify({ url: "http://127.0.0.1:47841", pid: process.pid, source: import.meta.url, started: new Date().toISOString() }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void server.close().then(() => process.exit(0)); });
