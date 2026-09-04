import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openQueryOnlyDb } from "../../../src/evidence/common/sqlite.js";
import { writeApprovedStateJson } from "../../../src/evidence/common/state.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-evidence-state-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("query-only database opener", () => {
  it("allows reads and refuses writes", () => {
    const dbPath = path.join(root, "fixture.sqlite");
    const writer = new Database(dbPath);
    writer.exec("CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    writer.prepare("INSERT INTO proof (value) VALUES ('kept')").run();
    writer.close();

    const reader = openQueryOnlyDb(dbPath);
    try {
      expect(reader.pragma("query_only", { simple: true })).toBe(1);
      expect(reader.prepare("SELECT value FROM proof").get()).toEqual({ value: "kept" });
      expect(() => reader.prepare("DELETE FROM proof").run()).toThrow();
    } finally {
      reader.close();
    }
  });
});

describe("atomic approved-state JSON", () => {
  it("writes canonical private JSON once through a same-directory rename", () => {
    const state = path.join(root, "state");
    fs.mkdirSync(state);
    const result = writeApprovedStateJson(state, "manifest.json", { z: 2, a: { y: 1, x: 0 } });
    expect(fs.readFileSync(result.path, "utf8")).toBe('{"a":{"x":0,"y":1},"z":2}\n');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fs.readdirSync(state)).toEqual(["manifest.json"]);
    expect(() => writeApprovedStateJson(state, "manifest.json", {})).toThrow(
      "state_file_already_exists",
    );
    expect(() => writeApprovedStateJson(state, "../escape.json", {})).toThrow(
      "invalid_state_file_name",
    );
  });
});
