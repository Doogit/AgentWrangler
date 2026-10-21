/** Resolve the same effective roots for ingestion, Settings, and calibration. */
export function resolveScanRoots(
  persisted: string | null,
  defaults: string[],
  caller?: unknown,
): string[] {
  if (caller !== undefined) {
    return isStringArray(caller) ? caller : defaults;
  }
  if (persisted === null) return defaults;
  try {
    const parsed: unknown = JSON.parse(persisted);
    return isStringArray(parsed) ? parsed : defaults;
  } catch {
    return defaults;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((root) => typeof root === "string");
}
