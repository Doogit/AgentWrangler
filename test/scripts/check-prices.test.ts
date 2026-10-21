/**
 * test/scripts/check-prices.test.ts — scripts/pricing/check-prices.ts parse + diff.
 * Fixture is a hand-written copy of the price page table shape (not derived from
 * LIST_PRICES), so a drift in either side shows up as a diff.
 */

import { describe, expect, it } from "vitest";
import { ParseError, checkPrices, parsePricePage } from "../../scripts/pricing/check-prices.js";

const HEADER = `Intro text.

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |`;

const ROWS = {
  fable51:
    "| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |",
  fable5: "| Claude Fable 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |",
  opus55:
    "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |",
  opus5: "| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
  opus48: "| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
  opus47: "| Claude Opus 4.7 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
  opus46: "| Claude Opus 4.6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
  opus45: "| Claude Opus 4.5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |",
  mythos51:
    "| Claude Mythos 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok | $50 / MTok |",
  mythos5: "| Claude Mythos 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |",
  sonnet45:
    "| Claude Sonnet 4.5 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |",
  opus41:
    "| Claude Opus 4.1 ([retired, except on Bedrock](https://x.test/d)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |",
  sonnet55:
    // F24: the live page (2026-10-14) says $0.10<sup>2</sup>; this copy had $0.20.
    "| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |",
  sonnet5:
    "| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |",
  sonnet46:
    "| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |",
  haiku55:
    "| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |",
  haiku55long:
    "| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |",
  haiku45: "| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |",
};

function page(
  overrides: Partial<typeof ROWS> = {},
  drop: (keyof typeof ROWS)[] = [],
  extra: string[] = [],
) {
  const rows = { ...ROWS, ...overrides };
  const body = (Object.keys(rows) as (keyof typeof ROWS)[])
    .filter((k) => !drop.includes(k))
    .map((k) => rows[k]);
  return `${[HEADER, ...body, ...extra].join("\n")}\n\nFooter.\n`;
}

describe("check-prices", () => {
  it("matches: no errors; retired row skipped; dated haiku id matches", () => {
    const models = parsePricePage(page());
    expect(models).toHaveLength(18);
    expect(models.find((m) => m.id === "claude-opus-4-1")?.retired).toBe(true);
    expect(checkPrices(models)).toEqual({ errors: [], warnings: [] });
  });

  it("F24: checks the Haiku 5.5 over-100k row against the long-prompt tier", () => {
    const models = parsePricePage(
      page({
        haiku55long:
          "| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $3 / MTok |",
      }),
    );
    expect(models.filter((m) => m.longPrompt === true).map((m) => m.id)).toEqual([
      "claude-haiku-5-5",
    ]);
    expect(checkPrices(models).errors).toEqual([
      'claude-haiku-5-5: tier "haiku-5-5-long" output is $2.5/MTok in LIST_PRICES, page says $3',
    ]);
  });

  it("reports a price mismatch against the tier", () => {
    const models = parsePricePage(
      page({
        opus55:
          "| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.40 / MTok | $20 / MTok |",
      }),
    );
    const { errors } = checkPrices(models);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('claude-opus-5-5: tier "opus-5-5" cacheRead is $0.2/MTok');
    expect(errors[0]).toContain("page says $0.4");
  });

  it("warns (exit-0 class) on an unknown model whose price matches its fallback tier", () => {
    const models = parsePricePage(
      page(
        {},
        [],
        ["| Claude Opus 4.9 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |"],
      ),
    );
    const { errors, warnings } = checkPrices(models);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      'claude-opus-4-9 (Claude Opus 4.9): not in KNOWN_MODELS (priced as "opus", price matches)',
    ]);
  });

  it("errors on an unknown model whose price differs from its fallback tier", () => {
    const models = parsePricePage(
      page(
        {},
        [],
        ["| Claude Opus 6 | $7 / MTok | $8.75 / MTok | $14 / MTok | $0.70 / MTok | $35 / MTok |"],
      ),
    );
    expect(
      checkPrices(models).errors.some((e) => e.startsWith('claude-opus-6: tier "opus" input')),
    ).toBe(true);
  });

  it("errors when a KNOWN_MODELS id is absent from the page", () => {
    const { errors } = checkPrices(parsePricePage(page({}, ["fable51"])));
    expect(errors).toEqual(["claude-fable-5-1: in KNOWN_MODELS but absent from the price page"]);
  });

  it("fails to parse (never a silent pass) on a missing table or too few models", () => {
    expect(() => parsePricePage("no table here")).toThrow(ParseError);
    expect(() => parsePricePage([HEADER, ROWS.opus5, ROWS.fable5].join("\n"))).toThrow(
      /only 2 models parsed/,
    );
    expect(() =>
      parsePricePage(page({ opus5: "| Claude Opus 5 | free | $6 | $10 | $0.5 | $25 |" })),
    ).toThrow(ParseError);
  });
});
