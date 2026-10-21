import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecsSnapshotService, prewarmRecsSnapshot } from "../../src/daemon/recs-snapshot.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

// Isolated migrated DB so nothing opens the developer's live ~/.agentwrangler DB.
const isolatedDb = createInMemoryFixtureDb();
beforeEach(() => setQueryDb(isolatedDb));
afterEach(() => resetQueryDb());

const MIN = 60_000;

function setup() {
  const clock = { t: 1_000_000_000_000 };
  const tokens = { state: "s1", ingest: "i1" };
  let builds = 0;
  const service = createRecsSnapshotService({
    builder: async () => {
      builds += 1;
      return {
        result: { data: null } as never,
        builtAtMs: clock.t,
      };
    },
    now: () => clock.t,
    inputsToken: () => tokens.state,
    ingestToken: () => tokens.ingest,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { clock, tokens, service, builds: () => builds, settle };
}

describe("recs snapshot staleness (RB1-A)", () => {
  it("a 10-minute bucket rollover with unchanged tokens starts no build", async () => {
    const s = setup();
    await s.service.get();
    s.clock.t += 11 * MIN;
    await s.service.get();
    await s.settle();
    expect(s.builds()).toBe(1);
    s.service.stop();
  });

  it("ingest mark changed at age 5 min starts no build; at age 11 min starts one", async () => {
    const s = setup();
    await s.service.get();
    s.tokens.ingest = "i2";
    s.clock.t += 5 * MIN;
    await s.service.get();
    await s.settle();
    expect(s.builds()).toBe(1);
    s.clock.t += 6 * MIN;
    await s.service.get();
    await s.settle();
    expect(s.builds()).toBe(2);
    s.service.stop();
  });

  it("state key changed at age 1 min serves the snapshot once and rebuilds once", async () => {
    const s = setup();
    const first = await s.service.get();
    s.tokens.state = "s2";
    s.clock.t += MIN;
    expect(await s.service.get()).toBe(first);
    await s.settle();
    expect(s.builds()).toBe(2);
    await s.service.get();
    await s.settle();
    expect(s.builds()).toBe(2);
    s.service.stop();
  });

  it("unchanged tokens at age >= 1 h rebuild exactly once", async () => {
    const s = setup();
    await s.service.get();
    s.clock.t += 59 * MIN;
    await s.service.get();
    await s.settle();
    expect(s.builds()).toBe(1);
    s.clock.t += 2 * MIN;
    await s.service.get();
    await s.service.get();
    await s.settle();
    expect(s.builds()).toBe(2);
    s.service.stop();
  });

  it("a build held in the gate while the token changes is stamped with the post-change token", async () => {
    const clock = { t: 1_000_000_000_000 };
    const tokens = { state: "s1", ingest: "i1" };
    let builds = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createRecsSnapshotService({
      builder: async (_scope, onStart) => {
        builds += 1;
        await held; // queued behind the heavy-job gate
        onStart?.(); // the gate lets it run
        return { result: { data: null } as never, builtAtMs: clock.t };
      },
      now: () => clock.t,
      inputsToken: () => tokens.state,
      ingestToken: () => tokens.ingest,
    });
    const first = service.get();
    tokens.state = "s2"; // the history walk lands while the build waits
    tokens.ingest = "i2";
    release();
    await first;
    clock.t += 11 * MIN;
    await service.get();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(builds).toBe(1);
    const peeked = service.peek();
    expect(peeked.state === "ready" && peeked.stale).toBe(false);
    service.stop();
  });

  it("invalidate() makes the next get await one fresh build", async () => {
    const s = setup();
    await s.service.get();
    s.service.invalidate();
    await s.service.get();
    expect(s.builds()).toBe(2);
    s.service.stop();
  });

  it("boot: pre-warm waits for the first pass, so boot plus first pass is one build", async () => {
    const s = setup();
    let settle!: () => void;
    const firstPass = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const warm = prewarmRecsSnapshot(s.service, firstPass);
    await s.settle();
    expect(s.builds()).toBe(0);
    settle();
    await warm;
    expect(s.builds()).toBe(1);
    s.service.stop();
  });

  it("boot: a failed first pass still settles the pre-warm", async () => {
    const s = setup();
    const warm = prewarmRecsSnapshot(s.service, Promise.resolve());
    await warm;
    expect(s.builds()).toBe(1);
    s.service.stop();
  });

  it("the daemon wiring no longer calls recsSnapshot.markStale and gates boot builds on bootPipelineSettled", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/daemon/index.ts"), "utf8");
    expect(source).not.toMatch(/recsSnapshot\.markStale/);
    expect(source).toMatch(/prewarmRecsSnapshot\(recsSnapshot, bootPipelineSettled\)/);
    expect(source).toMatch(
      /await bootPipelineSettled;\s*\n\s*if \(lifecycle\.isShutDown\) return;\s*\n\s*const recs = await recsSnapshot\.get\(\)/,
    );
  });
});
