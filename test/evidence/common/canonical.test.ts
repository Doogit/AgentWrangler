import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256Canonical,
  sha256File,
} from "../../../src/evidence/common/canonical.js";

let temporaryDirectory: string | undefined;

afterEach(() => {
  if (temporaryDirectory !== undefined) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("canonical evidence JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = { z: 1, nested: { beta: true, alpha: "x" }, rows: [{ b: 2, a: 1 }, 3] };
    const right = { rows: [{ a: 1, b: 2 }, 3], nested: { alpha: "x", beta: true }, z: 1 };

    expect(canonicalJson(left)).toBe(
      '{"nested":{"alpha":"x","beta":true},"rows":[{"a":1,"b":2},3],"z":1}',
    );
    expect(canonicalJson(right)).toBe(canonicalJson(left));
    expect(sha256Canonical(right)).toBe(sha256Canonical(left));
  });

  it("rejects values JSON would silently weaken", () => {
    expect(() => canonicalJson({ value: undefined })).toThrow("canonical_unsupported_value");
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("canonical_non_finite_number");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("canonical_cycle");
  });

  it("canonicalizes prototype-shaped record keys without mutation or digest aliasing", () => {
    const special = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"prototype":2}',
    ) as Record<string, unknown>;
    const ordinary = { constructor: 1, prototype: 2 };
    expect(canonicalJson(special)).toBe(
      '{"__proto__":{"polluted":true},"constructor":1,"prototype":2}',
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(sha256Canonical(special)).not.toBe(sha256Canonical(ordinary));
  });

  it("streams file SHA-256 deterministically", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aw-evidence-canonical-"));
    const file = path.join(temporaryDirectory, "artifact.bin");
    fs.writeFileSync(file, "approved evidence bytes", "utf8");
    const first = await sha256File(file);
    const second = await sha256File(file);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });
});
