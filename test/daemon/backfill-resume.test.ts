/**
 * test/daemon/backfill-resume.test.ts — P2-U1 resume oracle on the slice-aware corpus.
 *
 * Thin by design: the kill seam (AW_TEST_CRASH_AT) and the digest + replay-counter
 * oracle are P0-U11's (scripts/benchmark/backfill-harness.mts). This only runs them
 * against a small R-3 corpus whose files carry 12 weeks of mtimes and nested
 * subagent transcripts, the shape the slice loop (P2-U4) will walk.
 *
 * Synthetic content only (SEC-101).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateBackfillCorpus,
  loadDistributions,
} from "../../scripts/benchmark/backfill-corpus.mjs";
import {
  type Digest,
  HARNESS_NOW_MS,
  diffDigests,
  ingestDigest,
  ingestFromScratch,
  runCrashScenario,
} from "../../scripts/benchmark/backfill-harness.mjs";

let tmp: string;
let root: string;
let expected: Digest;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-p2u1-resume-"));
  root = path.join(tmp, "root");
  generateBackfillCorpus(
    root,
    { seed: 3, files: 10, totalBytes: 400_000, weeks: 12 },
    loadDistributions(),
    HARNESS_NOW_MS,
  );
  const scratch = ingestFromScratch(root);
  expected = ingestDigest(scratch);
  scratch.close();
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resume oracle (P0-U11) on the slice-aware corpus", () => {
  it.each(["file:3", "mid-tx:2", "after-tx:2"])(
    "kill at %s → restart to done, digests equal, no chunk re-applied",
    (kp) => {
      expect(expected.turns?.count ?? 0).toBeGreaterThan(0);
      const workdir = path.join(tmp, kp.replace(/[^a-z0-9]/gi, "_"));
      fs.mkdirSync(workdir, { recursive: true });
      const r = runCrashScenario({ workdir, root, crashAt: kp, budget: 8_000 });
      expect(r.crashed).toBe(true);
      expect(r.killMarker).toBe(kp);
      expect(r.committedBeforeCrash).toBeGreaterThan(0);
      expect(r.restartedToDone).toBe(true);
      const db = new Database(r.dbPath);
      const actual = ingestDigest(db);
      db.close();
      expect(diffDigests(expected, actual)).toEqual([]);
      expect(r.replayCounter).toBe(0);
    },
    180_000,
  );
});
