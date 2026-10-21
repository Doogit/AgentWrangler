/**
 * test/ingest/test-seams.test.ts — P0-U11 test-only seams are inert unless AW_TEST_HOOKS=1.
 * (The child-process side of "ignored without hooks" lives in backfill-harness.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_INGESTOR_OPTIONS } from "../../src/ingest/ingestor.js";
import { parseCrashSpec, parseTestSeams } from "../../src/ingest/test-seams.js";

describe("AW_TEST_* seams", () => {
  it("ignores AW_TEST_CRASH_AT, AW_TEST_NOW and AW_TEST_TX_BUDGET_MS when AW_TEST_HOOKS is not 1", () => {
    const env = {
      AW_TEST_CRASH_AT: "after-tx",
      AW_TEST_NOW: "2026-07-20T00:00:00Z",
      AW_TEST_TX_BUDGET_MS: "0",
    };
    const inert = { crash: null, nowMs: null, txBudgetMs: null };
    expect(parseTestSeams(env)).toEqual(inert);
    expect(parseTestSeams({ ...env, AW_TEST_HOOKS: "0" })).toEqual(inert);
    expect(parseTestSeams({ ...env, AW_TEST_HOOKS: "true" })).toEqual(inert);
    expect(parseTestSeams({})).toEqual(inert);
  });

  it("parses the ingest tx budget under AW_TEST_HOOKS=1 (P2-U4a)", () => {
    const budget = (v: string) =>
      parseTestSeams({ AW_TEST_HOOKS: "1", AW_TEST_TX_BUDGET_MS: v }).txBudgetMs;
    expect(budget("0")).toBe(0);
    expect(budget("25")).toBe(25);
    expect(budget("x")).toBeNull();
  });

  it("parses every kill point and the fixed clock under AW_TEST_HOOKS=1", () => {
    const at = (crash: string) =>
      parseTestSeams({ AW_TEST_HOOKS: "1", AW_TEST_CRASH_AT: crash }).crash;
    expect(at("file:3")).toEqual({ kind: "file", n: 3 });
    expect(at("bytes:4096")).toEqual({ kind: "bytes", n: 4096 });
    expect(at("mid-tx")).toEqual({ kind: "mid-tx", n: 1 });
    expect(at("mid-tx:2")).toEqual({ kind: "mid-tx", n: 2 });
    expect(at("after-tx")).toEqual({ kind: "after-tx", n: 1 });
    expect(at("after-tx:2")).toEqual({ kind: "after-tx", n: 2 });
    expect(at("mid-reconcile")).toEqual({ kind: "mid-reconcile", n: 1 });
    const iso = parseTestSeams({ AW_TEST_HOOKS: "1", AW_TEST_NOW: "2026-07-20T00:00:00.000Z" });
    expect(iso.nowMs).toBe(Date.UTC(2026, 6, 20));
    expect(parseTestSeams({ AW_TEST_HOOKS: "1", AW_TEST_NOW: "1784505600000" }).nowMs).toBe(
      1784505600000,
    );
  });

  it("rejects malformed crash specs", () => {
    expect(parseCrashSpec("file")).toBeNull();
    expect(parseCrashSpec("bytes")).toBeNull();
    expect(parseCrashSpec("nonsense")).toBeNull();
    expect(parseCrashSpec("after-tx:x")).toBeNull();
  });

  it("leaves the default Ingestor clock real in this process (hooks off)", () => {
    expect(Math.abs(DEFAULT_INGESTOR_OPTIONS.now().getTime() - Date.now())).toBeLessThan(5_000);
  });
});
