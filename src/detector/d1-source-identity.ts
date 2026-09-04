/** Source tuple used to correlate a D1 recommendation with inventory history. */
export interface D1SourceIdentity {
  component: string;
  fileRef: string;
}

interface D1Evidence {
  component?: unknown;
  file_ref?: unknown;
}

export interface D1SourceBackedRecommendation {
  detector_id: string | null;
  target_metric: string | null;
}

/**
 * Parse the source tuple emitted in D1 evidence.
 *
 * This intentionally preserves the measurement path's permissive compatibility
 * contract: both fields must be strings, but empty strings are not rejected.
 */
export function parseD1SourceIdentity(evidenceJson: string): D1SourceIdentity | null {
  try {
    const value = JSON.parse(evidenceJson) as D1Evidence;
    if (
      value &&
      typeof value === "object" &&
      typeof value.component === "string" &&
      typeof value.file_ref === "string"
    ) {
      return { component: value.component, fileRef: value.file_ref };
    }
  } catch {
    // Malformed evidence has no usable source identity.
  }
  return null;
}

/** D1 recommendations, including the legacy target-metric encoding. */
export function isD1SourceBackedRecommendation(rec: D1SourceBackedRecommendation): boolean {
  return rec.detector_id === "D1" || (rec.target_metric ?? "").startsWith("CONTEXT_TOKENS:");
}
