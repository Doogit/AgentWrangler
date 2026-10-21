import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DETECTORS } from "../../src/detector/registry.js";
import { loadManifests } from "./manifest.js";

const ID = DETECTORS[0]?.id ?? "";
let root: string;

function write(
  id: string,
  manifest: unknown,
  opts: { jsonl?: boolean; dirs?: string[] } = {},
): void {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of opts.dirs ?? ["pos", "near"]) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
    if (opts.jsonl !== false) fs.writeFileSync(path.join(dir, d, "s.jsonl"), "{}\n");
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
}

const good = (id: string) => ({
  id,
  positive: { fixture: "pos", expect: "fires" },
  near_miss: { fixture: "near", target_constant: "THRESHOLD", expect: "silent" },
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dh-manifest-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadManifests", () => {
  it("returns [] for a missing root and an empty root", () => {
    expect(loadManifests(path.join(root, "nope"))).toEqual([]);
    expect(loadManifests(root)).toEqual([]);
  });

  it("loads a valid case", () => {
    write(ID, good(ID));
    const cases = loadManifests(root);
    expect(cases).toHaveLength(1);
    const [c] = cases;
    expect(c?.id).toBe(ID);
    expect(c?.near_misses.map((n) => n.target_constant)).toEqual(["THRESHOLD"]);
    expect(fs.existsSync(c?.positive.fixtureDir ?? "")).toBe(true);
  });

  it("throws on id/dir mismatch", () => {
    write(ID, good("ZZ"));
    expect(() => loadManifests(root)).toThrow(/does not match dir/);
  });

  it("throws on unknown detector id", () => {
    write("ZZ99", good("ZZ99"));
    expect(() => loadManifests(root)).toThrow(/unknown detector/);
  });

  it("throws on missing fixture dir", () => {
    write(ID, { ...good(ID), positive: { fixture: "gone", expect: "fires" } });
    expect(() => loadManifests(root)).toThrow(/fixture dir missing/);
  });

  it("throws when fixture dir has no .jsonl", () => {
    write(ID, good(ID), { jsonl: false });
    expect(() => loadManifests(root)).toThrow(/no \.jsonl/);
  });

  it("throws on near_miss without target_constant", () => {
    write(ID, { ...good(ID), near_miss: { fixture: "near", expect: "silent" } });
    expect(() => loadManifests(root)).toThrow(/target_constant/);
  });

  it("throws on wrong expect value", () => {
    write(ID, { ...good(ID), positive: { fixture: "pos", expect: "silent" } });
    expect(() => loadManifests(root)).toThrow(/positive\.expect/);
  });

  it("loads a rows-only case", () => {
    write(ID, { ...good(ID), positive: { rows: "pos.rows.json", expect: "fires" } });
    fs.writeFileSync(
      path.join(root, ID, "pos.rows.json"),
      JSON.stringify({ limit_snapshots: [{ ts: "2027-01-01T00:00:00.000Z", used_pct: 50 }] }),
    );
    const [c] = loadManifests(root);
    expect(c?.positive.fixtureDir).toBeUndefined();
    expect(c?.positive.rowsFile).toBe(path.join(root, ID, "pos.rows.json"));
  });

  it("throws on a rows file with an unknown table", () => {
    write(ID, { ...good(ID), positive: { rows: "pos.rows.json", expect: "fires" } });
    fs.writeFileSync(
      path.join(root, ID, "pos.rows.json"),
      JSON.stringify({ turns: [{ ts: "x" }] }),
    );
    expect(() => loadManifests(root)).toThrow(/unknown table "turns"/);
  });

  it("loads near_misses[] (one per conjunctive threshold)", () => {
    const { near_miss, ...rest } = good(ID);
    write(ID, { ...rest, near_misses: [near_miss, { ...near_miss, target_constant: "OTHER" }] });
    const [c] = loadManifests(root);
    expect(c?.near_misses.map((n) => n.target_constant)).toEqual(["THRESHOLD", "OTHER"]);
  });

  it("throws on near_miss and near_misses together, or an empty near_misses", () => {
    write(ID, { ...good(ID), near_misses: [good(ID).near_miss] });
    expect(() => loadManifests(root)).toThrow(/not both/);
    const { near_miss: _, ...rest } = good(ID);
    write(ID, { ...rest, near_misses: [] });
    expect(() => loadManifests(root)).toThrow(/non-empty array/);
  });

  it("throws on a near_misses entry without target_constant", () => {
    const { near_miss, ...rest } = good(ID);
    write(ID, { ...rest, near_misses: [near_miss, { fixture: "near", expect: "silent" }] });
    expect(() => loadManifests(root)).toThrow(/near_misses\[1\]\.target_constant/);
  });

  it("throws when a case has neither fixture nor rows", () => {
    write(ID, { ...good(ID), positive: { expect: "fires" } });
    expect(() => loadManifests(root)).toThrow(/positive needs fixture or rows/);
  });

  it("throws when a detector dir has no manifest.json", () => {
    fs.mkdirSync(path.join(root, ID));
    expect(() => loadManifests(root)).toThrow(/manifest\.json missing/);
  });
});
