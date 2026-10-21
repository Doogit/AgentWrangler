/** Read a V2 metric value first, then the equivalent V1 flat fact. */

type EvidenceLike = {
  evidence?: Record<string, unknown>;
  facts?: Record<string, unknown>;
};

function metricValue(input: EvidenceLike, key: string): unknown {
  const metrics = input.evidence?.metrics;
  if (metrics !== null && typeof metrics === "object" && !Array.isArray(metrics)) {
    const metric = (metrics as Record<string, unknown>)[key];
    if (metric !== null && typeof metric === "object" && !Array.isArray(metric)) {
      const value = (metric as Record<string, unknown>).value;
      if (value !== undefined) return value;
    }
  }
  return input.facts?.[key];
}

export function numberMetric(input: EvidenceLike, key: string): number | null {
  const value = metricValue(input, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringMetric(input: EvidenceLike, key: string): string | null {
  const value = metricValue(input, key);
  return typeof value === "string" ? value : null;
}

/** Stamp the detector contract's target metric on every option. */
export function withTargetMetric<T extends { target_metric?: string }>(
  actions: { primary: T; alternatives: T[] },
  target_metric: string,
): { primary: T; alternatives: T[] } {
  return {
    primary: { ...actions.primary, target_metric },
    alternatives: actions.alternatives.map((option) => ({ ...option, target_metric })),
  };
}
