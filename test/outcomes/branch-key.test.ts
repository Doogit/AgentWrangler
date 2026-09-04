import { describe, expect, it } from "vitest";
import { fingerprintBranchRef } from "../../src/outcomes/branch-key.js";

describe("fingerprintBranchRef", () => {
  it("uses the fixed branch-v1 domain-separated SHA-256 contract", () => {
    expect(fingerprintBranchRef("feature/example")).toBe(
      "15d2c5795429d56949b282a697061d546116dd4d50798b119502fa3015d640fb",
    );
  });

  it("removes exactly one refs/heads/ prefix", () => {
    expect(fingerprintBranchRef("refs/heads/feature/example")).toBe(
      fingerprintBranchRef("feature/example"),
    );
    expect(fingerprintBranchRef("refs/heads/refs/heads/feature/example")).not.toBe(
      fingerprintBranchRef("feature/example"),
    );
    expect(fingerprintBranchRef("origin/feature/example")).not.toBe(
      fingerprintBranchRef("feature/example"),
    );
  });

  it("preserves case, Unicode, slashes, and hyphens", () => {
    expect(fingerprintBranchRef("Feature/Example")).toBe(
      "ea28e54c01e4825a45441fa78fe64d3bb26cc988d9d24159989b78449d4107af",
    );
    expect(fingerprintBranchRef("feature/café")).toBe(
      "a470ed43ad0beb0213c7220274c8f7585a2591c9caa8e3a36cf4e167bb8dce36",
    );
    expect(fingerprintBranchRef("Feature/Example")).not.toBe(
      fingerprintBranchRef("feature/example"),
    );
    expect(fingerprintBranchRef("topic/a-b")).not.toBeNull();
    expect(fingerprintBranchRef("topic/a]b")).not.toBeNull();
  });

  it("accepts the UTF-8 byte boundaries and rejects values outside them", () => {
    expect(fingerprintBranchRef("a")).not.toBeNull();
    expect(fingerprintBranchRef("a".repeat(255))).not.toBeNull();
    expect(fingerprintBranchRef(`${"é".repeat(127)}a`)).not.toBeNull();
    expect(fingerprintBranchRef("a".repeat(256))).toBeNull();
    expect(fingerprintBranchRef("é".repeat(128))).toBeNull();
  });

  it.each([
    undefined,
    null,
    42,
    "",
    "HEAD",
    "detached",
    "detached HEAD",
    "(HEAD detached at abc1234)",
    "(no branch)",
    "0123456789abcdef0123456789abcdef01234567",
    "@",
    " leading",
    "trailing ",
    "feature/with space",
    "feature/with\tcontrol",
    "feature\\windows",
    "feature..next",
    "feature@{next",
    "feature~next",
    "feature^next",
    "feature:next",
    "feature?next",
    "feature*next",
    "feature[next",
    "/feature",
    "feature/",
    "feature//next",
    ".feature",
    "feature/.hidden",
    "feature.",
    "feature/next.",
    "feature.lock",
    "feature/next.lock",
    "refs/heads/",
  ])("abstains for invalid ref %j", (value) => {
    expect(fingerprintBranchRef(value)).toBeNull();
  });
});
