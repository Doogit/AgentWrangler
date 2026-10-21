/**
 * test/ui/client-callers.test.ts — P1-U3 migration ratchet.
 *
 * Counts the `fetchCachedJson` callers that still rely on client.ts's `responseCache` (the ones
 * that do not pass `{ fresh: true }`). Pages move to TanStack one at a time, so the count only
 * goes down: lower BASELINE in the PR that removes a caller. P3-U6 deletes `responseCache` at 0.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const BASELINE = 6;
const UI_ROOT = path.resolve(import.meta.dirname, "../../src/ui");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [fs.readFileSync(full, "utf8")] : [];
  });
}

describe("responseCache callers (P1-U3 ratchet)", () => {
  it(`at most ${BASELINE} fetchCachedJson callers still use responseCache`, () => {
    const text = sources(UI_ROOT).join("\n");
    const uses = (text.match(/fetchCachedJson</g) ?? []).length - 1; // minus the definition
    const fresh = (text.match(/\{ fresh: true \}/g) ?? []).length;
    expect(uses - fresh).toBeLessThanOrEqual(BASELINE);
  });
});
