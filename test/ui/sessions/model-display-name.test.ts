import { describe, expect, it } from "vitest";
import { modelDisplayName } from "../../../src/ui/sessions/HotSessionsPage";

// OV-11 Q4: the Sessions Models column shows display names, not raw model ids.
describe("modelDisplayName", () => {
  it.each([
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-fable-5", "Fable 5"],
    ["claude-3-5-sonnet-20241022", "Sonnet 3.5"],
    ["<synthetic>", "<synthetic>"],
  ])("%s → %s", (model, expected) => {
    expect(modelDisplayName(model)).toBe(expected);
  });
});
