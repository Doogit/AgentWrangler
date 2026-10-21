import { describe, expect, it } from "vitest";
import { registeredFindingDescriptors } from "../../../src/detector/finding-registry.js";
import { RECOMMENDATION_TEMPLATES } from "../../../src/detector/privacy-contract.js";
import { DETECTORS } from "../../../src/detector/registry.js";
import { CAUSES, EXCLUDED_KEYS, causeForKey } from "../../../src/query/api/diagnostics-causes.js";

/**
 * Pure structural check: does every enumerated (detector_id, id) key map to exactly one cause
 * or one exclusion, does every detector appear in >=1 key, and does every registry key reference
 * a real template or rule? Exposed as a pure function of its inputs so the mutation test can call
 * it with an extra fake descriptor and assert it fails.
 */
function checkRegistry(
  templateEntries: readonly { detector_id: string; template_id: string }[],
  ruleEntries: readonly { detector_id: string; rule_id: string }[],
  detectorIds: readonly string[],
  causes: readonly {
    keys: readonly { detector_id: string; id: string }[];
  }[],
  excludedKeys: readonly { detector_id: string; id: string }[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  const registryKeys = new Set<string>();
  for (const cause of causes) {
    for (const key of cause.keys) registryKeys.add(`${key.detector_id}\u0000${key.id}`);
  }
  const excludedSet = new Set<string>();
  for (const key of excludedKeys) excludedSet.add(`${key.detector_id}\u0000${key.id}`);

  // Every enumerated template/rule maps to exactly one cause or one exclusion.
  const enumeratedKeys = [
    ...templateEntries.map((t) => ({ detector_id: t.detector_id, id: t.template_id })),
    ...ruleEntries.map((r) => ({ detector_id: r.detector_id, id: r.rule_id })),
  ];
  for (const key of enumeratedKeys) {
    const k = `${key.detector_id}\u0000${key.id}`;
    const inRegistry = registryKeys.has(k);
    const inExcluded = excludedSet.has(k);
    if (inRegistry && inExcluded) {
      errors.push(`key (${key.detector_id}, ${key.id}) is both mapped and excluded`);
    } else if (!inRegistry && !inExcluded) {
      errors.push(`key (${key.detector_id}, ${key.id}) is neither mapped nor excluded`);
    }
  }

  // No registry key references a non-existent template or rule.
  const validKeys = new Set(enumeratedKeys.map((k) => `${k.detector_id}\u0000${k.id}`));
  for (const cause of causes) {
    for (const key of cause.keys) {
      const k = `${key.detector_id}\u0000${key.id}`;
      if (!validKeys.has(k))
        errors.push(`registry key (${key.detector_id}, ${key.id}) matches no template or rule`);
    }
  }
  for (const key of excludedKeys) {
    const k = `${key.detector_id}\u0000${key.id}`;
    if (!validKeys.has(k))
      errors.push(`excluded key (${key.detector_id}, ${key.id}) matches no template or rule`);
  }

  // Every detector id appears in >=1 key (mapped or excluded).
  const coveredDetectors = new Set<string>();
  for (const key of registryKeys) coveredDetectors.add(key.split("\u0000")[0] ?? "");
  for (const key of excludedSet) coveredDetectors.add(key.split("\u0000")[0] ?? "");
  for (const id of detectorIds) {
    if (!coveredDetectors.has(id)) errors.push(`detector ${id} appears in no registry key`);
  }

  return { ok: errors.length === 0, errors };
}

function templateEntriesFromContract(): { detector_id: string; template_id: string }[] {
  return Object.entries(RECOMMENDATION_TEMPLATES).map(([templateId, def]) => ({
    detector_id: (def as { detector_id: string }).detector_id,
    template_id: templateId,
  }));
}

function ruleEntriesFromDescriptors(): { detector_id: string; rule_id: string }[] {
  return registeredFindingDescriptors().map((d) => ({
    detector_id: d.owner_detector_id,
    rule_id: d.rule_id,
  }));
}

describe("diagnostics-causes registry", () => {
  const templateEntries = templateEntriesFromContract();
  const ruleEntries = ruleEntriesFromDescriptors();
  const detectorIds = DETECTORS.map((d) => d.id);

  it("maps every V1 template and V2 rule to exactly one cause or exclusion, with no dangling keys", () => {
    const result = checkRegistry(templateEntries, ruleEntries, detectorIds, CAUSES, EXCLUDED_KEYS);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("(D14, D2) maps to 'You interrupted or cancelled the agent'", () => {
    const cause = causeForKey("D14", "D2");
    expect(cause.name).toBe("You interrupted or cancelled the agent");
  });

  it("(D2, D2_LONG_FULL_CONTEXT) maps to 'Context grows too large'", () => {
    const cause = causeForKey("D2", "D2_LONG_FULL_CONTEXT");
    expect(cause.name).toContain("Context grows too large");
  });

  it("D7's two templates map to two different causes", () => {
    const crossSession = causeForKey("D7", "D7_CROSS_SESSION_REREAD");
    const retryLoop = causeForKey("D7", "D7_RETRY_LOOP");
    expect(crossSession.cause_id).not.toBe(retryLoop.cause_id);
  });

  it("throws for an unknown key rather than bucketing it", () => {
    expect(() => causeForKey("Z1", "NOT_A_REAL_KEY")).toThrow();
  });

  it("mutation: an extra fake descriptor not in the registry fails the check", () => {
    const fakeRuleEntries = [...ruleEntries, { detector_id: "Z1", rule_id: "Z1_FAKE_RULE" }];
    const result = checkRegistry(
      templateEntries,
      fakeRuleEntries,
      detectorIds,
      CAUSES,
      EXCLUDED_KEYS,
    );
    expect(result.ok).toBe(false);
  });
});
