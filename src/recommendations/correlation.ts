import type { CeuPoolId, FindingId, SafeCode } from "./types.js";

export interface EngineFinding {
  readonly id: FindingId;
  readonly detectorId: string;
  readonly schemaVersion: number;
  readonly observedAt: string;
  readonly correlationKey: string;
  readonly ceuPoolId: CeuPoolId;
  readonly ceuPerWeek: number | null;
  readonly confidence: number | null;
}
export interface CorrelationLink {
  readonly findingId: FindingId;
  readonly correlationKey: string;
  readonly ceuPoolId: CeuPoolId;
  readonly role: "PRIMARY" | "SUPPORTING";
  readonly contributionCeuPerWeek: number;
}
export interface CorrelationResult {
  readonly links: readonly CorrelationLink[];
  readonly canonicalFindings: readonly EngineFinding[];
  readonly reasonCodes: readonly SafeCode[];
  readonly valid: boolean;
}
const canonicalTime = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const isPreciseNonNegative = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(value * 1_000_000);
const compareFinding = (a: EngineFinding, b: EngineFinding): number =>
  a.correlationKey.localeCompare(b.correlationKey) || a.id.localeCompare(b.id);

/** Canonical correlation gives each pool one primary owner and zero-value supporting links. */
export function correlateFindings(findings: readonly EngineFinding[]): CorrelationResult {
  const sorted = [...findings].sort(compareFinding);
  const ids = new Set<string>();
  const keyToPool = new Map<string, string>();
  const poolToKey = new Map<string, string>();
  let valid = sorted.length > 0;
  for (const finding of sorted) {
    const mappedPool = keyToPool.get(finding.correlationKey);
    const mappedKey = poolToKey.get(finding.ceuPoolId);
    if (
      ids.has(finding.id) ||
      finding.id.length === 0 ||
      finding.detectorId.length === 0 ||
      !Number.isSafeInteger(finding.schemaVersion) ||
      finding.schemaVersion < 1 ||
      !canonicalTime(finding.observedAt) ||
      finding.correlationKey.length === 0 ||
      finding.ceuPoolId.length === 0 ||
      !isPreciseNonNegative(finding.ceuPerWeek) ||
      finding.confidence === null ||
      !Number.isFinite(finding.confidence) ||
      finding.confidence < 0 ||
      finding.confidence > 1 ||
      (mappedPool !== undefined && mappedPool !== finding.ceuPoolId) ||
      (mappedKey !== undefined && mappedKey !== finding.correlationKey)
    )
      valid = false;
    ids.add(finding.id);
    keyToPool.set(finding.correlationKey, finding.ceuPoolId);
    poolToKey.set(finding.ceuPoolId, finding.correlationKey);
  }
  const groups = new Map<string, EngineFinding[]>();
  for (const finding of sorted)
    groups.set(finding.correlationKey, [...(groups.get(finding.correlationKey) ?? []), finding]);
  const links: CorrelationLink[] = [];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const primary = group[0];
    if (primary === undefined) continue;
    const poolValue = primary.ceuPerWeek;
    if (group.some((finding) => finding.ceuPerWeek !== poolValue)) valid = false;
    for (const [index, finding] of group.entries())
      links.push({
        findingId: finding.id,
        correlationKey: key,
        ceuPoolId: finding.ceuPoolId,
        role: index === 0 ? "PRIMARY" : "SUPPORTING",
        contributionCeuPerWeek: index === 0 && poolValue !== null ? poolValue : 0,
      });
  }
  return {
    links,
    canonicalFindings: sorted,
    valid,
    reasonCodes: valid ? [] : (["CORRELATION_INVALID" as SafeCode] as const),
  };
}
