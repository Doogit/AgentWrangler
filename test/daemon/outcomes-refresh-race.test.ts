import * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import type { OutcomesControlService } from "../../src/daemon/outcomes-control.js";
import { refreshGithubTokenStatus } from "../../src/outcomes/github/credential.js";
import type { GithubTokenStatus } from "../../src/outcomes/github/credential.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

vi.mock("../../src/outcomes/github/credential.js", () => ({
  getGithubTokenStatus: vi.fn(),
  refreshGithubTokenStatus: vi.fn(),
}));

describe.each(["success", "failure"])("credential refresh %s fencing", (outcome) => {
  it("invalidates evidence before reading and again when the read settles", async () => {
    const db = createInMemoryFixtureDb();
    let resolve!: (status: GithubTokenStatus) => void;
    let reject!: (error: Error) => void;
    vi.mocked(refreshGithubTokenStatus).mockReturnValue(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const invalidateConnection = vi.fn();
    const control = { invalidateConnection } as unknown as OutcomesControlService;
    const server = createServer(db, 0, null, "synthetic", null, control);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    const result = new Promise<string>((done, fail) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/outcomes/token-refresh",
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AgentWrangler-Token": "synthetic" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => done(body));
        },
      );
      req.on("error", fail);
      req.end("{}");
    });
    try {
      await vi.waitFor(() => expect(refreshGithubTokenStatus).toHaveBeenCalled());
      expect(invalidateConnection).toHaveBeenCalledTimes(1);
      if (outcome === "success") resolve({ configured: false, source: null });
      else reject(new Error("synthetic-secret-must-not-leak"));
      const body = await result;
      expect(invalidateConnection).toHaveBeenCalledTimes(2);
      expect(body).not.toContain("synthetic-secret-must-not-leak");
      if (outcome === "failure") expect(JSON.parse(body).state).toBe("store-error");
    } finally {
      resolve({ configured: false, source: null });
      await result;
      await new Promise<void>((done) => server.close(() => done()));
      db.close();
      vi.clearAllMocks();
    }
  });
});
