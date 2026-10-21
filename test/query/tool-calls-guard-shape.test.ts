/**
 * Review 5 U5 (M5): `guardShape` classifies a `python -c` match that only survives inside a quoted
 * argument as QUOTED_PATTERN, checked before PYTHON_READ; an executing carrier's own quoted
 * argument (it runs, so it is not a harmless literal) still classifies as PYTHON_READ.
 */
import { describe, expect, it } from "vitest";
import { guardShape } from "../../src/query/api/tool-calls.js";

describe("U5 M5: QUOTED_PATTERN vs PYTHON_READ", () => {
  it("classifies a `python -c` match inside a quoted argument as QUOTED_PATTERN", () => {
    expect(guardShape('grep -n "PYTHON_READ\\|python -c" src/x.ts')).toBe("QUOTED_PATTERN");
  });

  it("keeps PYTHON_READ when `python -c` runs outside any quoted argument", () => {
    expect(guardShape("python -c 'print(1)'")).toBe("PYTHON_READ");
  });

  it("keeps PYTHON_READ when the quoted match is inside a command substitution ($()...)", () => {
    expect(guardShape("curl \"$(python -c 'print(1)')\"")).toBe("PYTHON_READ");
  });

  it("keeps PYTHON_READ when the quoted match is an executing carrier's own argument (bash -c)", () => {
    expect(guardShape("bash -c \"python -c 'print(1)'\"")).toBe("PYTHON_READ");
  });

  it("keeps PYTHON_READ when the quoted match is an executing carrier's own argument (ssh <host>)", () => {
    expect(guardShape('ssh box "python -c 1"')).toBe("PYTHON_READ");
  });
});
