/**
 * test/ui/App.test.tsx — parseHash URL-parsing tests.
 *
 * Covers: route resolution with query params (RV5 requirement), session-detail
 * URL with encoded path, unknown routes, and bare routes without params.
 */

import { describe, expect, it } from "vitest";
import { parseHash } from "../../src/ui/App";

describe("parseHash — URL-synced param support (RV5)", () => {
  it("resolves #/recommendations with query params to the recommendations route", () => {
    expect(parseHash("#/recommendations?state=proposed").route).toBe("recommendations");
    expect(parseHash("#/recommendations?state=proposed").sessionId).toBeNull();
  });

  it("resolves #/recommendations with multiple params", () => {
    const result = parseHash("#/recommendations?state=dismissed&tier=WARNING&sort=savings");
    expect(result.route).toBe("recommendations");
    expect(result.sessionId).toBeNull();
  });

  it("resolves #/recommendations with focus param (RV6 deep-link)", () => {
    expect(parseHash("#/recommendations?focus=rec-abc123").route).toBe("recommendations");
  });

  it("still resolves bare #/recommendations (no params)", () => {
    expect(parseHash("#/recommendations").route).toBe("recommendations");
  });

  it("resolves other routes with query params correctly", () => {
    expect(parseHash("#/overview?anything=x").route).toBe("overview");
    expect(parseHash("#/sessions?foo=bar").route).toBe("sessions");
    expect(parseHash("#/workspaces?ws=alpha").route).toBe("workspaces");
    expect(parseHash("#/settings?debug=1").route).toBe("settings");
  });

  it("preserves session-detail routing with params absent", () => {
    const result = parseHash("#/sessions/sess-abc-123");
    expect(result.route).toBe("session-detail");
    expect(result.sessionId).toBe("sess-abc-123");
  });

  it("preserves session-detail routing with URL-encoded session id", () => {
    const result = parseHash("#/sessions/path%2Fwith%2Fslashes");
    expect(result.route).toBe("session-detail");
    expect(result.sessionId).toBe("path/with/slashes");
  });

  it("falls back to overview for unknown routes", () => {
    expect(parseHash("#/unknown").route).toBe("overview");
    expect(parseHash("#/unknown?foo=bar").route).toBe("overview");
    expect(parseHash("").route).toBe("overview");
  });

  it("strips query string before route matching — does not confuse path and params", () => {
    // The ?state=... must NOT be treated as part of the route path
    const result = parseHash("#/recommendations?state=proposed&tier=WARNING&group=workspace");
    expect(result.route).toBe("recommendations");
  });
});
