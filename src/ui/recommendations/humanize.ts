/** Humanize structural cause/effect enums at the UI boundary. */
function titleCaseTokens(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const TOOL_CLASS_COPY: Record<string, string> = {
  SHELL: "Shell-command output",
  EXEC: "Command-execution output",
  FILE_READ: "File-read output",
  FILE_EDIT: "File-edit output",
  SEARCH: "Search output",
  WEB: "Web-fetch output",
  CUSTOM_TOOL: "A custom tool's output",
};

export function humanizeCause(cause: string): string {
  const dir = cause.endsWith("_DECREASE") ? "fell" : cause.endsWith("_INCREASE") ? "rose" : null;
  if (cause.startsWith("VOLUME_TERM_") && dir) return `Session volume ${dir}`;
  if (cause.startsWith("INTENSITY_TERM_") && dir) return `Per-turn intensity ${dir}`;
  if (cause.startsWith("UNATTRIBUTED_RESIDUAL_") && dir) return `Unexplained spend ${dir}`;
  if (cause === "TOOL_CONCENTRATION") return "One tool dominates output";
  if (cause.startsWith("TOOL_")) {
    const cls = cause.slice("TOOL_".length);
    return TOOL_CLASS_COPY[cls] ?? `${titleCaseTokens(cls)} output`;
  }
  if (cause.startsWith("CACHE_")) {
    const miss = cause.slice("CACHE_".length);
    if (miss === "WRITE_HEAVY") return "Context written but not reused";
    if (miss === "UNKNOWN") return "Cache pattern unclear";
    return `Cache: ${titleCaseTokens(miss)}`;
  }
  return titleCaseTokens(cause);
}

export function humanizeEffect(effect: string): string {
  if (effect.startsWith("OBSERVED_")) {
    const d = effect.slice("OBSERVED_".length);
    if (d === "INCREASE") return "spend increased";
    if (d === "DECREASE") return "spend decreased";
    if (d === "UNCHANGED") return "spend unchanged";
    return `spend ${titleCaseTokens(d).toLowerCase()}`;
  }
  if (effect.startsWith("FAILURE_COUNT_")) {
    const n = effect.slice("FAILURE_COUNT_".length);
    return `${n} repeated failure${n === "1" ? "" : "s"}`;
  }
  if (effect === "CONCENTRATION_OBSERVED") return "concentration observed";
  if (effect === "BYTE_SHARE_CONCENTRATION") return "dominates output bytes";
  if (effect === "CACHE_RATIO_LOW") return "low cache reuse";
  if (effect === "CACHE_RATIO_UNKNOWN") return "cache reuse unknown";
  if (effect === "UNKNOWN") return "not yet determined";
  return titleCaseTokens(effect).toLowerCase();
}
