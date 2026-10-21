/**
 * P0-U7: rec writes take the displayed card from the recs snapshot instead of rebuilding it on the
 * main thread (the rebuild reaches C2's synchronous `git ls-files`). The oracle is the snapshot
 * object: its card offers an option a fresh build never offers, so adopting that option succeeds
 * only if the snapshot card was used.
 */
import * as http from "node:http";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/daemon/http.js";
import { createRecsSnapshotService } from "../../src/daemon/recs-snapshot.js";
import {
  type RecommendationCard,
  type RecommendationsView,
  getRecommendationCard,
} from "../../src/query/api/recommendations.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { buildResponse } from "../../src/query/envelope.js";
import { seedValidatedRecommendation } from "../fixtures/recommendations.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const REC_ID = "rec-snapshot-card-01";
const SNAP_ONLY = "snap-only-option";

function post(port: number, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/** The real card for REC_ID plus one alternative only the snapshot offers. */
function snapshotCard(): RecommendationCard {
  const card = getRecommendationCard(REC_ID, true);
  if (!card?.actions) throw new Error("seeded rec has no actions");
  return {
    ...card,
    actions: {
      ...card.actions,
      alternatives: [
        ...card.actions.alternatives,
        { ...card.actions.primary, option_id: SNAP_ONLY },
      ],
    },
  };
}

function view(active: RecommendationCard[]) {
  return buildResponse(
    {
      active,
      limit_warnings: [],
      adopted: [],
      dismissed: [],
      history: [],
    } as unknown as RecommendationsView,
    { claim_kind: "OBS_PROXY" },
  );
}

let db: Database.Database;
beforeAll(() => {
  db = createInMemoryFixtureDb();
});
afterAll(() => db.close());
beforeEach(() => {
  setQueryDb(db);
  for (const table of [
    "recommendation_effects",
    "recommendation_lifecycle_actions",
    "effect_cycles",
  ])
    db.prepare(`DELETE FROM ${table} WHERE rec_id=?`).run(REC_ID);
  db.prepare("DELETE FROM recommendations WHERE rec_id=?").run(REC_ID);
  seedValidatedRecommendation(db, {
    recId: REC_ID,
    templateId: "D2_LONG_FULL_CONTEXT",
    scope: null,
  });
});
afterEach(() => resetQueryDb());

describe("recsSnapshot.peekCard", () => {
  it("is null on a cold service and never starts a build", () => {
    let builds = 0;
    const service = createRecsSnapshotService({
      builder: async () => {
        builds += 1;
        return { result: view([]), stateKey: "k", builtAtMs: Date.now() };
      },
    });
    expect(service.peekCard(REC_ID)).toBeNull();
    expect(builds).toBe(0);
    service.stop();
  });

  it("returns the snapshot's own card object, and null after a lifecycle invalidate", async () => {
    const card = snapshotCard();
    const service = createRecsSnapshotService({
      builder: async () => ({ result: view([card]), stateKey: "k", builtAtMs: Date.now() }),
    });
    await service.get("ws-a");
    expect(service.peekCard(REC_ID)).toBe(card);
    expect(service.peekCard("no-such-rec")).toBeNull();
    service.invalidate();
    expect(service.peekCard(REC_ID)).toBeNull();
    service.stop();
  });
});

describe("POST /api/recommendations/adopt with the snapshot card", () => {
  async function withServer(warm: boolean, run: (port: number) => Promise<void>) {
    const card = snapshotCard();
    const service = createRecsSnapshotService({
      builder: async () => ({ result: view([card]), stateKey: "k", builtAtMs: Date.now() }),
    });
    if (warm) await service.get();
    const server = createServer(db, 0, null, null, null, null, service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      await run((server.address() as { port: number }).port);
    } finally {
      service.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("a warm snapshot supplies the actions: its snapshot-only option is accepted", async () => {
    await withServer(true, async (port) => {
      const status = await post(port, "/api/recommendations/adopt", {
        rec_id: REC_ID,
        completed_change: true,
        option_id: SNAP_ONLY,
      });
      expect(status).toBe(200);
      expect(
        db.prepare("SELECT action_revision FROM effect_cycles WHERE rec_id=?").get(REC_ID),
      ).toEqual({ action_revision: SNAP_ONLY });
    });
  });

  it("a cold snapshot falls back to building the card (the snapshot-only option is rejected)", async () => {
    await withServer(false, async (port) => {
      const rejected = await post(port, "/api/recommendations/adopt", {
        rec_id: REC_ID,
        completed_change: true,
        option_id: SNAP_ONLY,
      });
      expect(rejected).toBe(400);
      const adopted = await post(port, "/api/recommendations/adopt", {
        rec_id: REC_ID,
        completed_change: true,
      });
      expect(adopted).toBe(200);
    });
  });
});
