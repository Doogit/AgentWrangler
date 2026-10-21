/** Isolated Vite fixture preview: no daemon, local database or provider credentials. */
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const repo = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.AW_HELP_PREVIEW_PORT ?? 47832);
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  mode: "test",
  server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [repo] } },
  plugins: [
    {
      name: "help-fixture-readiness",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/api/") || /\.[cm]?[jt]sx?(?:\?|$)/.test(req.url))
            return next();
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          if (req.url === "/api/ready") return res.end(JSON.stringify({ ready: true }));
          if (req.url === "/api/status")
            return res.end(JSON.stringify({ scan_state: "complete", files_seen: 0, sessions: 0 }));
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "Unavailable in synthetic Help preview" }));
        });
      },
    },
  ],
});
await server.listen();
console.log(`Synthetic Help preview: http://127.0.0.1:${port}/#/help`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
