import type { ClassifierLabel } from "../../src/ingest/types.js";

export interface VersionedDenialFixture {
  version: string | null;
  record: Record<string, unknown>;
  message: Record<string, unknown> | null;
  expectedLabel: ClassifierLabel | null;
}

export interface VersionPrecisionReport {
  version: string;
  labeledN: number;
  correctN: number;
  precision: number;
  driftWatch: boolean;
  belowThreshold: boolean;
}

export interface VersionedDriftCheck {
  reports: VersionPrecisionReport[];
  passing: boolean;
}

export type DenialClassifier = (
  record: Record<string, unknown>,
  message: Record<string, unknown> | null,
  version: string | null,
) => ClassifierLabel | null;

export type DriftWatchSelector = (version: string | null) => { driftWatch: boolean };

const fixtureVersion = (version: string | null) => version ?? "legacy-unversioned";

/**
 * Measure expected-label recall for each persisted CC-version partition. The
 * denominator intentionally excludes expected-null fixtures: those are useful
 * false-positive coverage but must not dilute a changed matcher string into a
 * passing false-negative result. An unlabelled partition remains a visible
 * drift-watch result, but has no precision evidence to fail this gate yet.
 */
export function checkVersionedClassifierDrift(
  fixtures: readonly VersionedDenialFixture[],
  classifier: DenialClassifier,
  selectMatcherSet: DriftWatchSelector,
  minimumPrecision: number,
): VersionedDriftCheck {
  if (!Number.isFinite(minimumPrecision) || minimumPrecision < 0 || minimumPrecision > 1)
    throw new Error("drift_precision_threshold_invalid");

  const partitions = new Map<string, VersionedDenialFixture[]>();
  for (const fixture of fixtures) {
    const version = fixtureVersion(fixture.version);
    partitions.set(version, [...(partitions.get(version) ?? []), fixture]);
  }

  const reports = [...partitions.entries()].map(([version, cases]) => {
    const labeled = cases.filter((fixture) => fixture.expectedLabel !== null);
    const correctN = labeled.filter(
      (fixture) =>
        classifier(fixture.record, fixture.message, fixture.version) === fixture.expectedLabel,
    ).length;
    const precision = labeled.length === 0 ? 1 : correctN / labeled.length;
    const driftWatch = selectMatcherSet(cases[0]?.version ?? null).driftWatch;
    return {
      version,
      labeledN: labeled.length,
      correctN,
      precision,
      driftWatch,
      belowThreshold: precision < minimumPrecision,
    };
  });
  return { reports, passing: reports.every((report) => !report.belowThreshold) };
}

export function assertNoVersionedClassifierDrift(check: VersionedDriftCheck): void {
  const failed = check.reports.filter((report) => report.belowThreshold);
  if (failed.length > 0)
    throw new Error(
      `drift_precision_regression:${failed.map((report) => report.version).join(",")}`,
    );
}
