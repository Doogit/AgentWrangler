import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const styles = fs.readFileSync(path.resolve(TEST_DIR, "../../src/ui/styles.css"), "utf8");

// KTD-10's new custom properties. --meter-track is deliberately excluded: it already
// existed before this change, so it is not re-declared in either theme block.
const NEW_TOKENS = ["--inset", "--accent", "--accent-on"];

function rootBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  if (!match) throw new Error(`Could not find a ${selector} block in styles.css`);
  return match[1] ?? "";
}

const HEX_OR_RGB = /#[0-9a-f]{3,8}\b|rgb\(|rgba\(/i;

describe("design tokens (KTD-10)", () => {
  const darkRoot = rootBlock(":root");
  const lightRoot = rootBlock(':root[data-theme="light"]');

  it.each(NEW_TOKENS)("declares %s in the dark :root block", (token) => {
    expect(darkRoot).toMatch(new RegExp(`${token}\\s*:`));
  });

  it.each(NEW_TOKENS)('declares %s in the light :root[data-theme="light"] block', (token) => {
    expect(lightRoot).toMatch(new RegExp(`${token}\\s*:`));
  });

  it("--meter-track already exists and is left untouched", () => {
    expect(darkRoot).toMatch(/--meter-track\s*:/);
  });

  describe("new component rules", () => {
    const beginMarker = "/* KTD-10 BEGIN: diagnostics-triage design additions";
    const endMarker = "/* KTD-10 END */";
    const beginIdx = styles.indexOf(beginMarker);
    const endIdx = styles.indexOf(endMarker);

    it("is delimited by begin/end markers", () => {
      expect(beginIdx).toBeGreaterThan(-1);
      expect(endIdx).toBeGreaterThan(beginIdx);
    });

    const newRules = styles.slice(beginIdx, endIdx);

    it("contains no hex, rgb() or rgba() color literals", () => {
      expect(newRules).not.toMatch(HEX_OR_RGB);
    });

    it.each([
      '[data-accent="spend"]',
      '[data-accent="reliability"]',
      '[data-accent="risk"]',
      ".handoff-none",
      ".label-caps",
      ".meter > span",
      ".rank-num",
      ".chip-plain",
      ".inset-panel",
      ".cmd-row",
    ])("defines %s", (selector) => {
      expect(newRules).toContain(selector);
    });
  });
});
