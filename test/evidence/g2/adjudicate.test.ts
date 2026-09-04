import { describe, expect, it } from "vitest";

import { type G2PacketEntry, adjudicatePacket } from "../../../src/evidence/g2/adjudicate.js";
import type { JudgeClient, JudgeInput } from "../../../src/oauth/judge-g2-client.js";

describe("adjudicatePacket", () => {
  it("adjudicates every entry sequentially and preserves input order", async () => {
    const entries: G2PacketEntry[] = [
      { findingAlias: "first", evidenceKind: "transcript", evidence: { line: 1 } },
      { findingAlias: "second", evidenceKind: "tool_call", evidence: { command: "ls" } },
      { findingAlias: "third", evidenceKind: "summary", evidence: { count: 3 } },
    ];
    const received: JudgeInput[] = [];
    const responses = [
      {
        ok: true as const,
        verdict: "CONFIRMED" as const,
        confidence: 0.91,
        rationaleTag: "direct_support",
      },
      {
        ok: true as const,
        verdict: "REJECTED" as const,
        confidence: 0.42,
        rationaleTag: "insufficient_evidence",
      },
      {
        ok: true as const,
        verdict: "CONFIRMED" as const,
        confidence: 0.77,
        rationaleTag: "corroborated",
      },
    ];
    const judge: JudgeClient = async (input) => {
      received.push(input);
      const response = responses[received.length - 1];
      if (response === undefined) throw new Error("fixture exhausted");
      return response;
    };

    const result = await adjudicatePacket(entries, judge);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual([
        {
          findingAlias: "first",
          verdict: "CONFIRMED",
          confidence: 0.91,
          rationaleTag: "direct_support",
        },
        {
          findingAlias: "second",
          verdict: "REJECTED",
          confidence: 0.42,
          rationaleTag: "insufficient_evidence",
        },
        {
          findingAlias: "third",
          verdict: "CONFIRMED",
          confidence: 0.77,
          rationaleTag: "corroborated",
        },
      ]);
      expect(result.entries).toHaveLength(3);
    }
    expect(received).toEqual([
      { findingAlias: "first", evidenceKind: "transcript", evidence: { line: 1 } },
      { findingAlias: "second", evidenceKind: "tool_call", evidence: { command: "ls" } },
      { findingAlias: "third", evidenceKind: "summary", evidence: { count: 3 } },
    ]);
    expect(received).toHaveLength(3);
  });

  it("stops at the first judge failure", async () => {
    const entries: G2PacketEntry[] = [
      { findingAlias: "first", evidenceKind: "transcript", evidence: { line: 1 } },
      { findingAlias: "second", evidenceKind: "tool_call", evidence: { command: "ls" } },
      { findingAlias: "third", evidenceKind: "summary", evidence: { count: 3 } },
    ];
    const received: JudgeInput[] = [];
    const judge: JudgeClient = async (input) => {
      received.push(input);
      if (received.length === 2) {
        return { ok: false, reason: "HTTP 401 from Messages API" };
      }
      return { ok: true, verdict: "CONFIRMED", confidence: 0.91, rationaleTag: "direct_support" };
    };

    const result = await adjudicatePacket(entries, judge);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.findingAlias).toBe("second");
      expect(result.reason).toBe("HTTP 401 from Messages API");
    }
    expect(received).toHaveLength(2);
    expect(received).toEqual([
      { findingAlias: "first", evidenceKind: "transcript", evidence: { line: 1 } },
      { findingAlias: "second", evidenceKind: "tool_call", evidence: { command: "ls" } },
    ]);
  });
});
