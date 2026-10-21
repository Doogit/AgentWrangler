import { describe, expect, it } from "vitest";
import { isBenignFailure } from "../../src/detector/turn-claim.js";
import { isExcluded } from "./probes/C5.js";

// The probe re-derives the detector's benign list from raw text; the two must agree.
describe("C5 probe exclusions", () => {
  it("excludes a silent Get-NetTCPConnection port probe from any shell tool, like the detector", () => {
    const command = "Get-NetTCPConnection -LocalPort 47851 -State Listen";
    for (const tool_name of ["Bash", "PowerShell"]) {
      const call = { tool_name, error: "Exit code 1", command };
      expect(isExcluded(call)).toBe(true);
      expect(isBenignFailure(command, call.error, tool_name)).toBe(true);
    }
  });

  it("keeps a port probe that printed an error", () => {
    const call = {
      tool_name: "PowerShell",
      error: "Exit code 1\nGet-NetTCPConnection : No matching objects found",
      command: "Get-NetTCPConnection -LocalPort 47851",
    };
    expect(isExcluded(call)).toBe(false);
    expect(isBenignFailure(call.command, call.error, call.tool_name)).toBe(false);
  });
});
