/** Evidence for settings keys used by copyable recommendation artifacts. */
export interface SettingsKeyEntry {
  key: string;
  source: "DOC_CITED" | "VERSION_GATE" | "LOCAL_CANARY";
  verdict: "SUPPORTED" | "UNKNOWN";
  citation: string;
  minVersion?: string;
}

const caching = "https://code.claude.com/docs/en/prompt-caching.md";
const agents = "https://code.claude.com/docs/en/sub-agents.md";
const settings = "https://code.claude.com/docs/en/settings.md";

/** DOC_CITED rows deliberately remain UNKNOWN until a version gate or canary exists. */
export const SETTINGS_KEY_REGISTRY: readonly SettingsKeyEntry[] = [
  {
    key: "CLAUDE_CODE_PROMPT_CACHE_TTL",
    source: "VERSION_GATE",
    verdict: "SUPPORTED",
    citation: caching,
    minVersion: "2.1.242",
  },
  {
    key: "promptCacheTtl",
    source: "VERSION_GATE",
    verdict: "SUPPORTED",
    citation: caching,
    minVersion: "2.1.242",
  },
  {
    key: "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
    source: "VERSION_GATE",
    verdict: "SUPPORTED",
    citation: caching,
    minVersion: "2.1.242",
  },
  {
    key: "subagentPromptCacheTtl",
    source: "VERSION_GATE",
    verdict: "SUPPORTED",
    citation: caching,
    minVersion: "2.1.242",
  },
  { key: "ENABLE_PROMPT_CACHING_1H", source: "DOC_CITED", verdict: "UNKNOWN", citation: caching },
  { key: "FORCE_PROMPT_CACHING_5M", source: "DOC_CITED", verdict: "UNKNOWN", citation: caching },
  { key: "omitClaudeMd", source: "DOC_CITED", verdict: "UNKNOWN", citation: agents },
  { key: "permissions.allow", source: "DOC_CITED", verdict: "UNKNOWN", citation: settings },
  // Operator-approved 2026-09-26: the operator's own user settings enforce permissions.ask rules.
  { key: "permissions.ask", source: "LOCAL_CANARY", verdict: "SUPPORTED", citation: settings },
  // Operator-approved 2026-09-25: the operator's own user settings enforce a permissions.deny list.
  { key: "permissions.deny", source: "LOCAL_CANARY", verdict: "SUPPORTED", citation: settings },
  { key: "autoCompact", source: "DOC_CITED", verdict: "UNKNOWN", citation: settings },
  { key: "autoCompactWindow", source: "DOC_CITED", verdict: "UNKNOWN", citation: settings },
  { key: "autoCompactEnabled", source: "DOC_CITED", verdict: "UNKNOWN", citation: settings },
];

function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

export function settingsKeyVerdict(
  key: string,
  claudeCodeVersion: string | undefined,
  registry: readonly SettingsKeyEntry[] = SETTINGS_KEY_REGISTRY,
): "SUPPORTED" | "UNKNOWN" {
  const entry = registry.find((candidate) => candidate.key === key);
  if (!entry || entry.verdict !== "SUPPORTED" || entry.source === "DOC_CITED" || !entry.citation)
    return "UNKNOWN";
  if (!entry.minVersion) return entry.source === "LOCAL_CANARY" ? "SUPPORTED" : "UNKNOWN";
  const actual = claudeCodeVersion && versionParts(claudeCodeVersion);
  const minimum = versionParts(entry.minVersion);
  if (!actual || !minimum) return "UNKNOWN";
  for (let i = 0; i < 3; i++) {
    if ((actual[i] ?? 0) > (minimum[i] ?? 0)) return "SUPPORTED";
    if ((actual[i] ?? 0) < (minimum[i] ?? 0)) return "UNKNOWN";
  }
  return "SUPPORTED";
}
