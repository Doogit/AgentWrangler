import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const styles = fs.readFileSync(path.resolve(TEST_DIR, "../../src/ui/styles.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("shared layout consistency", () => {
  it("centers the desktop sidebar brand without changing the base card contract", () => {
    expect(rule(".brand")).toMatch(/align-items:\s*center/);
    expect(rule(".brand")).toMatch(/text-align:\s*center/);
    expect(rule(".card")).not.toMatch(/padding\s*:/);
  });

  it("provides explicit padded card and card-body variants", () => {
    expect(rule(".card-padded")).toMatch(/padding:\s*var\(--space-4\)/);
    expect(rule(".card-body-padded")).toMatch(
      /padding:\s*var\(--space-3\)\s+var\(--space-4\)\s+var\(--space-4\)/,
    );
  });

  it("REL-FIX bug 1: main content centres horizontally only, so short pages sit at the top", () => {
    // `.main-content` is a grid item of the min-height:100vh `.shell`; a vertical auto margin
    // floats any page shorter than the viewport down (~200 px band above the header).
    expect(rule(".main-content")).toMatch(/margin:\s*0 auto;/);
    expect(styles).not.toMatch(/\.main-content\s*\{[^}]*margin(?:-top|-bottom)?:\s*auto/);
  });
});
