/**
 * test/daemon/static-child-fixture.ts — child-process fixture for
 * test/daemon/static.test.ts's crash-safety test.
 *
 * An in-process `process.on` spy can't observe an uncaught stream error
 * (vitest reports it at the suite level, not as a test failure), so that
 * test runs the real static handler in a real child process instead: the
 * parent deletes a served asset, GETs it, and asserts the child is still
 * alive (`exitCode === null`) rather than having crashed.
 *
 * Usage: node --import tsx/esm test/daemon/static-child-fixture.ts <uiRoot>
 * Reports the listening port via IPC: process.send({ port }).
 */

import Database from "better-sqlite3";
import { createServer } from "../../src/daemon/http.js";

const uiRoot = process.argv[2];
if (!uiRoot) {
  console.error("usage: static-child-fixture.ts <uiRoot>");
  process.exit(1);
}

const db = new Database(":memory:");
const server = createServer(db, 0, uiRoot);

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  if (process.send) {
    process.send({ port });
  } else {
    console.log(JSON.stringify({ port }));
  }
});
