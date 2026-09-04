import { describe, expect, it, vi } from "vitest";
import { formatAbsolute, relativeTime } from "../../../src/ui/lib/relative-time";
import { shortId } from "../../../src/ui/lib/short-id";

describe("identifier and time display helpers", () => {
  it("shortens ids to eight characters and an ellipsis", () => {
    expect(shortId("abc12345-6789-0000-0000-000000000000")).toBe("abc12345…");
  });

  it("uses compact relative-time buckets and a readable absolute date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T07:21:00Z"));
    expect(relativeTime("2026-08-30T05:21:00Z")).toBe("2h ago");
    expect(relativeTime("2026-08-27T07:21:00Z")).toBe("3d ago");
    expect(formatAbsolute("2026-08-27T23:21:00Z")).toMatch(/^Aug 27,/);
    vi.useRealTimers();
  });
});
