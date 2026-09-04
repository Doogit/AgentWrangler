import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOOK_CONFIG,
  getHookConfig,
  updateHookConfig,
} from "../../src/query/api/hook-config.js";
import { resetQueryDb, setQueryDb } from "../../src/query/db-context.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

let db: Database.Database;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  setQueryDb(db);
});

afterEach(() => {
  resetQueryDb();
  db.close();
});

describe("hook config", () => {
  it("returns documented defaults when no dedicated keys exist", () => {
    expect(getHookConfig().data).toMatchObject(DEFAULT_HOOK_CONFIG);
    expect(typeof getHookConfig().data?.installed).toBe("boolean");
  });

  it("persists a partial update and reads it back", () => {
    const updated = updateHookConfig({
      context_window: 1_000_000,
      soft_pct: 0.5,
      stale_s: 90,
      d7_fail_count: 4,
      d7_window_turns: 12,
    }).data;
    expect(updated).toMatchObject({
      context_window: 1_000_000,
      soft_pct: 0.5,
      stale_s: 90,
      hard_pct: 0.8,
      d7_fail_count: 4,
      d7_window_turns: 12,
    });
    // getHookConfig() adds the `installed` field (t1); updateHookConfig() returns
    // the config alone. Compare the config keys, and assert `installed` separately.
    const { installed, ...persisted } = getHookConfig().data ?? { installed: undefined };
    expect(typeof installed).toBe("boolean");
    expect(persisted).toEqual(updated);
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = 'hook_config.context_window'").get(),
    ).toEqual({ value: "1000000" });
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = 'hook_config.d7_fail_count'").get(),
    ).toEqual({ value: "4" });
    expect(
      db.prepare("SELECT value FROM user_config WHERE key = 'hook_config.d7_window_turns'").get(),
    ).toEqual({ value: "12" });
  });

  it.each([
    { hard_pct: 2 },
    { hard_pct: 0.5 }, // must exceed the default soft_pct (0.6)
    { soft_pct: 0 },
    { context_window: 0 },
    { stale_s: -1 },
    { d7_fail_count: 0 },
    { d7_window_turns: 1.5 },
  ])("rejects invalid configuration %#", (update) => {
    expect(() => updateHookConfig(update)).toThrow("Invalid hook config");
  });
});
