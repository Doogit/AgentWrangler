import { describe, expect, it } from "vitest";
import { classifyDenial, selectDenialMatcherSet } from "../../src/ingest/parser.js";
import type { ClassifierLabel } from "../../src/ingest/types.js";
import {
  type VersionedDenialFixture,
  assertNoVersionedClassifierDrift,
  checkVersionedClassifierDrift,
} from "./drift-check.js";

const denial = (kind: string, text: string) => ({
  record: { toolDenialKind: kind },
  message: { content: [{ type: "tool_result", is_error: true, content: text }] },
});

const fixture = (
  version: string,
  kind: string,
  text: string,
  expectedLabel: ClassifierLabel | null,
): VersionedDenialFixture => ({ version, ...denial(kind, text), expectedLabel });

const FIXTURES: readonly VersionedDenialFixture[] = [
  fixture(
    "2.1.260",
    "user-rejected",
    "The user doesn't want to proceed with this tool use now.",
    "user-rejected",
  ),
  fixture("2.1.260", "", "PreToolUse:Bash hook error: fixture", "hook-block"),
  fixture("2.1.260", "", "Permission to use Bash has been denied.", "deny-rule"),
  fixture(
    "3.0.0",
    "user-rejected",
    "The user doesn't want to proceed with this tool use now.",
    null,
  ),
];

const [cataloguedFixture, , , newerFixture] = FIXTURES;
if (!cataloguedFixture || !newerFixture) throw new Error("U10 fixture contract is incomplete");

describe("U10 version-gated classifier drift check", () => {
  it("selects the catalogued matcher only for its CC-version partition", () => {
    expect(selectDenialMatcherSet("2.1.260")).toEqual({
      matcherSet: "catalog-2.1",
      driftWatch: false,
    });
    expect(selectDenialMatcherSet("3.0.0")).toEqual({ matcherSet: "default", driftWatch: true });

    expect(
      classifyDenial(
        cataloguedFixture.record,
        cataloguedFixture.message,
        cataloguedFixture.version,
      ),
    ).toBe("user-rejected");
    expect(
      classifyDenial(newerFixture.record, newerFixture.message, newerFixture.version),
    ).toBeNull();
  });

  it("flags a version partition when a changed string creates a false negative", () => {
    const changed = [
      ...FIXTURES.map((entry) => ({ ...entry })),
      ...Array.from({ length: 10 }, () => fixture("2.1.260", "", "SYNTH_EXPECTED_NULL", null)),
    ];
    changed[0] = fixture(
      "2.1.260",
      "user-rejected",
      "Changed Claude Code denial text.",
      "user-rejected",
    );
    const check = checkVersionedClassifierDrift(
      changed,
      classifyDenial,
      selectDenialMatcherSet,
      0.9,
    );
    expect(check.passing).toBe(false);
    expect(check.reports).toContainEqual(
      expect.objectContaining({
        version: "2.1.260",
        labeledN: 3,
        precision: 2 / 3,
        belowThreshold: true,
      }),
    );
    expect(() => assertNoVersionedClassifierDrift(check)).toThrow(
      "drift_precision_regression:2.1.260",
    );
  });

  it("keeps a newer version tagged, unlabelled, and visible to the drift watch", () => {
    const check = checkVersionedClassifierDrift(
      FIXTURES,
      classifyDenial,
      selectDenialMatcherSet,
      1,
    );
    expect(
      classifyDenial(newerFixture.record, newerFixture.message, newerFixture.version),
    ).toBeNull();
    expect(check.reports).toContainEqual(
      expect.objectContaining({ version: "3.0.0", driftWatch: true, precision: 1 }),
    );
    expect(() => assertNoVersionedClassifierDrift(check)).not.toThrow();
  });
});
