/**
 * test/ui/parse.test.ts — P1-U1 `safeSection`: a malformed section degrades to
 * `{ok: false}` and never throws; unknown fields pass through; each section
 * logs once with a stable prefix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/mini";
import { resetSectionLog, safeSection } from "../../src/ui/api/parse";

const schema = z.looseObject({ cost_equiv_u: z.number(), items: z.array(z.string()) });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetSectionLog();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("safeSection", () => {
  it("returns ok with the parsed data for a valid section", () => {
    const result = safeSection("kpis", schema, { cost_equiv_u: 5, items: ["a"] });
    expect(result).toEqual({ ok: true, data: { cost_equiv_u: 5, items: ["a"] } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns ok: false with an issue for a wrong type, without throwing", () => {
    const result = safeSection("kpis", schema, { cost_equiv_u: "5", items: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue).toContain("cost_equiv_u");
  });

  it.each([undefined, null, "oops", 42, []])("never throws on a non-object (%j)", (raw) => {
    expect(() => safeSection("kpis", schema, raw)).not.toThrow();
    expect(safeSection("kpis", schema, raw).ok).toBe(false);
  });

  it("keeps unknown extra fields", () => {
    const result = safeSection("kpis", schema, { cost_equiv_u: 1, items: [], extra: true });
    expect(result).toEqual({ ok: true, data: { cost_equiv_u: 1, items: [], extra: true } });
  });

  it("logs once per section with a stable prefix", () => {
    safeSection("kpis", schema, { cost_equiv_u: "x", items: [] });
    safeSection("kpis", schema, { cost_equiv_u: "y", items: [] });
    safeSection("flavor", schema, null);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/^\[aw:section\] kpis: /);
    expect(String(warn.mock.calls[1]?.[0])).toMatch(/^\[aw:section\] flavor: /);
  });
});
