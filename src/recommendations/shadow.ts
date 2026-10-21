import { createHash } from "node:crypto";
export type ShadowMismatchKind =
  | "ELIGIBILITY"
  | "CEU_OWNER"
  | "VALUE"
  | "RANK"
  | "DEDUP"
  | "ADDED"
  | "REMOVED";
export interface ShadowProjection {
  readonly opaqueId: string;
  readonly eligible: boolean;
  readonly ownerPoolHashes: readonly string[];
  readonly value: number | null;
  readonly rank: number | null;
  readonly dedupHash: string;
}
export interface ShadowReport {
  readonly compared: number;
  readonly totals: { readonly legacy: number; readonly composed: number };
  readonly mismatchCounts: Readonly<Record<ShadowMismatchKind, number>>;
  readonly mismatches: readonly {
    readonly opaqueId: string;
    readonly codes: readonly ShadowMismatchKind[];
  }[];
}
const opaque = (value: string): string =>
  `shadow:${createHash("sha256").update(value).digest("hex")}`;
export function compareShadow(
  legacy: readonly ShadowProjection[],
  composed: readonly ShadowProjection[],
): ShadowReport {
  const duplicateIds = (items: readonly ShadowProjection[]): ReadonlySet<string> => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const item of items) {
      if (seen.has(item.opaqueId)) duplicates.add(item.opaqueId);
      seen.add(item.opaqueId);
    }
    return duplicates;
  };
  const duplicates = new Set([...duplicateIds(legacy), ...duplicateIds(composed)]);
  const oldById = new Map(legacy.map((item) => [item.opaqueId, item]));
  const newById = new Map(composed.map((item) => [item.opaqueId, item]));
  const mismatchCounts: Record<ShadowMismatchKind, number> = {
    ELIGIBILITY: 0,
    CEU_OWNER: 0,
    VALUE: 0,
    RANK: 0,
    DEDUP: 0,
    ADDED: 0,
    REMOVED: 0,
  };
  const mismatches = [...new Set([...oldById.keys(), ...newById.keys()])].sort().flatMap((id) => {
    const previous = oldById.get(id);
    const next = newById.get(id);
    const codes: ShadowMismatchKind[] = [];
    if (duplicates.has(id)) codes.push("DEDUP");
    if (previous === undefined) codes.push("ADDED");
    else if (next === undefined) codes.push("REMOVED");
    else {
      if (previous.eligible !== next.eligible) codes.push("ELIGIBILITY");
      if (
        [...previous.ownerPoolHashes].sort().join("|") !==
        [...next.ownerPoolHashes].sort().join("|")
      )
        codes.push("CEU_OWNER");
      if (previous.value !== next.value) codes.push("VALUE");
      if (previous.rank !== next.rank) codes.push("RANK");
      if (previous.dedupHash !== next.dedupHash) codes.push("DEDUP");
    }
    for (const code of codes) mismatchCounts[code] += 1;
    return codes.length === 0 ? [] : [{ opaqueId: opaque(id), codes }];
  });
  return {
    compared: new Set([...oldById.keys(), ...newById.keys()]).size,
    totals: { legacy: legacy.length, composed: composed.length },
    mismatchCounts,
    mismatches,
  };
}
