import type { JudgeClient } from "../../oauth/judge-g2-client.js";

export interface G2PacketEntry {
  findingAlias: string;
  evidenceKind: string;
  evidence: unknown;
}

export interface AdjudicatedEntry {
  findingAlias: string;
  verdict: "CONFIRMED" | "REJECTED";
  confidence: number;
  rationaleTag: string;
}

export type AdjudicateResult =
  | { ok: true; entries: AdjudicatedEntry[] }
  | { ok: false; reason: string; findingAlias: string };

export async function adjudicatePacket(
  entries: readonly G2PacketEntry[],
  judge: JudgeClient,
): Promise<AdjudicateResult> {
  const adjudicatedEntries: AdjudicatedEntry[] = [];

  for (const entry of entries) {
    const result = await judge({
      findingAlias: entry.findingAlias,
      evidenceKind: entry.evidenceKind,
      evidence: entry.evidence,
    });

    if (!result.ok) {
      return { ok: false, reason: result.reason, findingAlias: entry.findingAlias };
    }

    adjudicatedEntries.push({
      findingAlias: entry.findingAlias,
      verdict: result.verdict,
      confidence: result.confidence,
      rationaleTag: result.rationaleTag,
    });
  }

  return { ok: true, entries: adjudicatedEntries };
}
