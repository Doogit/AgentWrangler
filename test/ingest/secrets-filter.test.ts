/**
 * test/ingest/secrets-filter.test.ts — SEC-101 W-C unit coverage.
 *
 * The retention-time secrets filter must drop obvious credential material while
 * leaving ordinary command/error text (and its structure) intact so C5/D7 can
 * still match repeats.
 */

import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/ingest/secrets-filter.js";

describe("SEC-101 W-C redactSecrets", () => {
  it("redacts OpenAI-style keys", () => {
    const out = redactSecrets("export KEY=sk-proj-abcdef0123456789ABCDEF0123 && run");
    expect(out).not.toContain("sk-proj-abcdef0123456789");
    expect(out).toContain("[REDACTED:key]");
    expect(out).toContain("export KEY=");
    expect(out).toContain("&& run");
  });

  it("redacts GitHub, AWS, and Slack tokens", () => {
    expect(redactSecrets(`token ghp_${"a".repeat(36)}`)).toContain("[REDACTED:key]");
    expect(redactSecrets("id AKIAIOSFODNN7EXAMPLE here")).toContain("[REDACTED:key]");
    expect(redactSecrets("slack xoxb-123456789012-abcdefghijkl")).toContain("[REDACTED:key]");
  });

  it("redacts a PEM private key block including the body", () => {
    // Assembled at runtime so no source line here matches the W-B PEM-header
    // content scanner (which flags a full BEGIN…PRIVATE KEY line in any file).
    const dashes = "-".repeat(5);
    const pem = [
      `${dashes}BEGIN RSA PRIVATE KEY${dashes}`,
      "MIIEowIBAAKCAQEA0Zx6y+secretbodyline",
      `${dashes}END RSA PRIVATE KEY${dashes}`,
    ].join("\n");
    const out = redactSecrets(`before\n${pem}\nafter`);
    expect(out).toContain("[REDACTED:pem]");
    expect(out).not.toContain("secretbodyline");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("redacts bearer/authorization tokens", () => {
    expect(redactSecrets("curl -H 'Authorization: Bearer abcDEF0123456789ghiJKL'")).toContain(
      "[REDACTED:token]",
    );
  });

  it("redacts unlabelled high-entropy blobs", () => {
    const blob = "Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0Lm+/=abcdEFGH";
    const out = redactSecrets(`value=${blob}`);
    expect(out).toContain("[REDACTED:secret]");
    expect(out).not.toContain(blob);
  });

  it("redacts underscore-prefixed provider keys (Stripe sk_live_/rk_test_)", () => {
    // Joined at runtime so no literal Stripe-shaped key sits in source (GitHub push protection blocks it).
    const key = ["sk", "live", "51H8xY2eZ0abcdefGHIJ0123"].join("_");
    expect(redactSecrets(`STRIPE=${key}`)).toContain("[REDACTED:");
    expect(redactSecrets(`STRIPE=${key}`)).not.toContain(key);
  });

  it("redacts credentials in URL userinfo but keeps scheme/user/host", () => {
    // Joined at runtime so no literal credential URL sits in source (TruffleHog flags it).
    const url = ["https://admin", "MyDbPassword123@github.com/x.git"].join(":");
    const out = redactSecrets(`git clone ${url}`);
    expect(out).not.toContain("MyDbPassword123");
    expect(out).toContain("https://admin:");
    expect(out).toContain("@github.com/x.git");
  });

  it("redacts short / punctuation-delimited / low-entropy secret assignments", () => {
    // Shapes the >=24-char high-entropy backstop cannot see.
    expect(redactSecrets("PGPASSWORD=hunter2 psql -h db")).not.toContain("hunter2");
    expect(redactSecrets("PGPASSWORD=hunter2 psql -h db")).toContain("PGPASSWORD=");
    expect(redactSecrets("curl -H 'X-Api-Key: mySecretPassword' https://x")).not.toContain(
      "mySecretPassword",
    );
    expect(redactSecrets("DB_PASSWORD=correct-horse-battery-staple")).not.toContain(
      "correct-horse-battery-staple",
    );
  });

  it("redacts a secret straddling the 4000-char slice boundary (redact-then-cut)", () => {
    // A high-entropy token positioned across MAX_SLICE_CHARS: redaction must run
    // on a window past the cap so the leading fragment is not left in place.
    const secret = "Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0Lm+/=abcdEFGH";
    const padded = `PASSWORD=${"a".repeat(3990)}${secret}`;
    // parser.retentionSlice owns the cut; here we assert redactSecrets clears the
    // token when it sees the window. The boundary wiring is covered in parser.
    expect(redactSecrets(padded)).not.toContain(secret);
  });

  it("S5b: leaves file paths intact but still redacts slashed base64 keys", () => {
    for (const path of [
      "npx vitest run src/ui/recommendations/RecCard.test.tsx",
      "cat docs/handoffs/2026-09-26-card-review/review-2-findings.md",
      "ls .worktrees/p3-1-t8-detectors/src/query/api/rec-actions",
    ]) {
      expect(redactSecrets(path)).toBe(path);
    }
    const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(redactSecrets(`secret ${aws}`)).not.toContain(aws);
  });

  it("leaves ordinary command text untouched", () => {
    const cmd = "npm run test -- --reporter=dot && git status --porcelain";
    expect(redactSecrets(cmd)).toBe(cmd);
  });

  it("is a no-op on empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});
