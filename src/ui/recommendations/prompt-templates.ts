import type { RecommendationCard } from "../../query/api/recommendations";
import type { SessionDrivers } from "../../query/api/session-drivers";
import { workspaceLabel } from "../lib/workspace-label";

export type PromptArtifactFlavor = "TURNKEY" | "GUIDED";

export interface PromptArtifact {
  text: string;
  flavor: PromptArtifactFlavor;
}

function evNum(rec: RecommendationCard, key: string): number | null {
  const value = rec.evidence[key];
  return typeof value === "number" ? value : null;
}

function evStr(rec: RecommendationCard, key: string): string | null {
  const value = rec.evidence[key];
  return typeof value === "string" ? value : null;
}

function fmtNum(value: number): string {
  return value.toLocaleString("en-US");
}

function measuredLine(label: string, value: number | null, unit = ""): string | null {
  return value === null ? null : `${label}: ${fmtNum(value)}${unit}`;
}

function fileLine(fileRef: string | null): string | null {
  return fileRef === null ? null : `File: ${fileRef}`;
}

function joinLines(lines: Array<string | null>): string {
  return lines.filter((line): line is string => line !== null).join("\n");
}

function buildD1(rec: RecommendationCard): PromptArtifact {
  const sourceTokens = evNum(rec, "source_tokens");
  const sourceTarget = evNum(rec, "source_target");
  const deltaTokens = evNum(rec, "delta_context_tokens");
  const component = evStr(rec, "component");

  return {
    flavor: "TURNKEY",
    text: joinLines([
      "TASK: Trim the always-loaded context source below to the measured target.",
      "MEASURED CONTEXT:",
      component === null ? null : `Component: ${component}`,
      fileLine(rec.file_ref),
      measuredLine("Measured source tokens", sourceTokens, " tokens"),
      measuredLine("Measured trim target", sourceTarget, " tokens"),
      measuredLine("Measured context reduction", deltaTokens, " tokens"),
      "CONSTRAINTS: Relocate content into lazy-loaded files — do not delete instructions. Apply always-loaded-file edits at a /clear or session boundary — editing the cached prefix mid-session forces a full-price cache re-write (backfire).",
      sourceTokens === null || sourceTarget === null
        ? "ACCEPTANCE: Run the next inventory probe and confirm the always-loaded size and context-per-turn dropped."
        : `ACCEPTANCE: Run the next inventory probe and confirm always-loaded size drops from ${fmtNum(sourceTokens)} toward ${fmtNum(sourceTarget)} tokens per turn.`,
    ]),
  };
}

function buildD10(rec: RecommendationCard): PromptArtifact {
  const catalogTokens = evNum(rec, "catalog_tokens");
  const catalogTargetTokens = evNum(rec, "catalog_target_tokens");
  const deltaTokens = evNum(rec, "delta_context_tokens");
  const sourceCount = evNum(rec, "source_count");
  const turnsPerWeek = evNum(rec, "turns_per_week");

  return {
    flavor: "TURNKEY",
    text: joinLines([
      "TASK: Move rarely-used MCP tool catalogs to lazy-load.",
      "MEASURED CONTEXT:",
      fileLine(rec.file_ref),
      measuredLine("Measured catalog tokens", catalogTokens, " tokens"),
      measuredLine("Measured catalog target", catalogTargetTokens, " tokens"),
      measuredLine("Measured context reduction", deltaTokens, " tokens"),
      measuredLine("Measured source count", sourceCount),
      measuredLine("Measured turns per week", turnsPerWeek),
      "CONSTRAINTS: Set alwaysLoad:false per server; keep frequently-used servers eager.",
      catalogTokens === null || catalogTargetTokens === null
        ? "ACCEPTANCE: Re-run the inventory probe and confirm catalog tokens moved toward the target."
        : `ACCEPTANCE: Re-run the inventory probe and confirm catalog tokens move from ${fmtNum(catalogTokens)} toward ${fmtNum(catalogTargetTokens)} tokens.`,
    ]),
  };
}

function buildD4(rec: RecommendationCard): PromptArtifact {
  const mismatchTurns = evNum(rec, "mismatch_turns_per_week");
  const totalOpusTurns = evNum(rec, "total_opus_turns_per_week");
  const mismatchFraction = evNum(rec, "mismatch_fraction");

  return {
    flavor: "TURNKEY",
    text: joinLines([
      "TASK: Default this workspace to Sonnet after confirming the binding cap.",
      "MEASURED CONTEXT:",
      fileLine(rec.file_ref),
      measuredLine("Measured mismatch turns per week", mismatchTurns),
      measuredLine("Measured total Opus turns per week", totalOpusTurns),
      measuredLine("Measured mismatch fraction", mismatchFraction),
      mismatchTurns === null || totalOpusTurns === null
        ? "CONSTRAINTS: Transcripts cannot reveal which usage cap is binding; check /usage before re-routing."
        : `CONSTRAINTS: Transcripts cannot reveal which usage cap is binding; ${fmtNum(mismatchTurns)} mismatch turns out of ${fmtNum(totalOpusTurns)} Opus turns require a /usage check before re-routing.`,
      mismatchTurns === null || totalOpusTurns === null
        ? "ACCEPTANCE: After confirming via /usage that the cap is binding, re-check this workspace's Opus share after 7 days."
        : `ACCEPTANCE: After confirming the cap is binding, re-check this workspace's Opus share after 7 days against ${fmtNum(mismatchTurns)} mismatch turns and ${fmtNum(totalOpusTurns)} total Opus turns.`,
    ]),
  };
}

function buildGuided(
  rec: RecommendationCard,
  task: string,
  constraints: string,
  acceptance: string,
  metrics: Array<[string, number | string | null]>,
): PromptArtifact {
  return {
    flavor: "GUIDED",
    text: joinLines([
      `TASK: ${task}`,
      "MEASURED CONTEXT:",
      fileLine(rec.file_ref),
      ...metrics.map(([label, value]) =>
        typeof value === "number"
          ? measuredLine(label, value)
          : value === null
            ? null
            : `${label}: ${value}`,
      ),
      `CONSTRAINTS: ${constraints}`,
      `ACCEPTANCE: ${acceptance}`,
    ]),
  };
}

/** Scope preamble prepended to every prompt artifact to identify the target config files.
 * Formatted as a bullet ("- SCOPE: ...") so it starts with "- " and passes the
 * build-brief assertParity check (requires digit or "^- " per line). */
function scopePreamble(rec: RecommendationCard): string {
  if (rec.scope_workspace_id === null) {
    return "- SCOPE: Global — targets ~/.claude/settings.json and ~/.claude/CLAUDE.md (applies to all workspaces).";
  }
  const label = workspaceLabel({ workspace_id: rec.scope_workspace_id });
  return `- SCOPE: Workspace "${label}" — targets .claude/settings.json or CLAUDE.md in that repo.`;
}

/**
 * Caption for the Copy button explaining the prompt's target.
 * Rendered beneath the Copy button in RecCard.
 */
export function scopePromptCaption(rec: RecommendationCard): string {
  return rec.scope_workspace_id === null
    ? "targets ~/.claude — applies everywhere"
    : "prompt targets this repo's CLAUDE.md";
}

function buildPromptArtifactInner(rec: RecommendationCard): PromptArtifact | null {
  switch (rec.detector_id) {
    case "D1":
      return buildD1(rec);
    case "D10":
      return buildD10(rec);
    case "D4":
      return buildD4(rec);
    case "D2":
      return buildGuided(
        rec,
        "Work through reducing average context per turn across the flagged long sessions with Claude or an agent, using only the measured context below.",
        "Insert /clear boundaries between tasks and lazy-load reference material; do not drop needed instructions.",
        "Re-check after 7 days: average context per turn falls without more retries or failed outcomes.",
        [
          ["Measured qualifying session count", evNum(rec, "qualifying_session_count")],
          [
            "Measured raw context average tokens per turn",
            evNum(rec, "raw_context_average_tokens_per_turn"),
          ],
          [
            "Measured cap-weighted burn tokens per week",
            evNum(rec, "cap_weighted_burn_tokens_per_week"),
          ],
          ["Measured cache-read tokens per week", evNum(rec, "cache_read_tokens_per_week")],
          [
            "Measured cache-read exposure spend u per week",
            evNum(rec, "cache_read_exposure_spend_u_per_week"),
          ],
        ],
      );
    case "D6":
      return buildGuided(
        rec,
        "Work through cutting the oversized tool-result output identified below with Claude or an agent, using the measured context.",
        "Narrow tool queries or paginate results; keep required context.",
        "Re-run the detector on later sessions: tool-result bytes and share fall without more failed tool calls.",
        [
          ["Measured tool-result bytes", evNum(rec, "tool_result_bytes")],
          ["Measured bloat share", evNum(rec, "bloat_share")],
          ["Measured session cap-weighted tokens", evNum(rec, "session_cap_weighted_tokens")],
          ["Attributed tool", evStr(rec, "attributed_tool")],
        ],
      );
    case "D8":
      return buildGuided(
        rec,
        "Work through preventing the cache re-writes that follow idle gaps in this session with Claude or an agent, using the measured context.",
        "Batch edits to session boundaries and avoid editing the cached prefix mid-session.",
        "Compare the next 7 days: fewer cache-creation spikes after idle gaps and a higher cache-read-to-creation ratio.",
        [
          ["Measured churn event count", evNum(rec, "churn_event_count")],
          ["Measured total churn creation tokens", evNum(rec, "total_churn_creation_tokens")],
          ["Measured session cap-weighted tokens", evNum(rec, "session_cap_weighted_tokens")],
        ],
      );
  }
  return null;
}

export function buildPromptArtifact(rec: RecommendationCard): PromptArtifact | null {
  const inner = buildPromptArtifactInner(rec);
  if (inner === null) return null;
  const preamble = scopePreamble(rec);
  return { ...inner, text: `${preamble}\n${inner.text}` };
}

/**
 * Build a session-grounded GUIDED prompt (INT-2) from a drivers payload.
 * Task: reduce what this session overpaid for.
 * Measured context: all driver measured quantities (≥3 when drivers present).
 * Acceptance: next comparable session's driver deltas.
 */
export function buildSessionDriversPrompt(drivers: SessionDrivers): PromptArtifact {
  const driverLabels = drivers.drivers.map((d) => d.label).join(", ") || "identified cost drivers";

  const measuredLines: Array<string | null> = [
    `Session percentile: ${drivers.percentile.toFixed(1)}th (trailing 30d)`,
  ];
  for (const driver of drivers.drivers) {
    for (const [key, value] of Object.entries(driver.measured)) {
      if (typeof value === "number") {
        measuredLines.push(measuredLine(`Measured ${driver.label} ${key}`, value));
      } else {
        measuredLines.push(`Measured ${driver.label} ${key}: ${String(value)}`);
      }
    }
    if (driver.approx_usd !== undefined) {
      measuredLines.push(
        `Approximate savings potential (${driver.label}): $${driver.approx_usd.toFixed(2)}/wk`,
      );
    }
  }

  return {
    flavor: "GUIDED",
    text: joinLines([
      `TASK: Work through reducing what this session overpaid for (${driverLabels}) with Claude or an agent, using only the measured context below.`,
      "MEASURED CONTEXT:",
      ...measuredLines,
      "CONSTRAINTS: Fix only what the measurements name — do not delete needed context or instructions.",
      "ACCEPTANCE: In the next comparable session, driver deltas show reduced share, fewer events, or lower byte counts for each driver above.",
    ]),
  };
}

export interface GeneratedSnippet {
  language: "jsonc" | "sh";
  caption: string;
  text: string;
}

/**
 * RI10 (R3): opaque trailer-writer artifact. A `prepare-commit-msg` git hook that
 * appends `Agent-Session-Id: <uuid>` to every commit, where the uuid is generated
 * once per repo and stored locally in `.git/`. RI1's linker matches this trailer
 * against local session ids, so adoption is self-serve.
 *
 * PRIVACY (spec Key Decision): it NEVER emits or derives from the `claude.ai`
 * session URL — the URL leak is the documented privacy complaint. The opaque
 * per-repo uuid is the linkage id.
 */
export function generateTrailerWriterSnippet(): GeneratedSnippet {
  return {
    language: "sh",
    caption:
      "Install: save as .git/hooks/prepare-commit-msg and `chmod +x` it. Uninstall: delete that file. Appends an opaque Agent-Session-Id trailer (stored in .git/, never the session URL) so AgentWrangler links your future commits to their PRs.",
    text: joinLines([
      "#!/bin/sh",
      "# AgentWrangler: append an opaque per-repo session-id trailer for local spend→PR linkage.",
      "# The id is stored only in .git/ — never the assistant session URL.",
      'id_file="$(git rev-parse --git-dir)/agentwrangler-session-id"',
      'if [ ! -f "$id_file" ]; then',
      "  (uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid) | tr 'A-Z' 'a-z' > \"$id_file\"",
      "fi",
      'sid="$(cat "$id_file")"',
      "if ! grep -qi '^Agent-Session-Id:' \"$1\"; then",
      '  printf \'\\nAgent-Session-Id: %s\\n\' "$sid" >> "$1"',
      "fi",
    ]),
  };
}

export function generateSettingsDisableBlock(rec: RecommendationCard): GeneratedSnippet | null {
  const catalogTokens = evNum(rec, "catalog_tokens");

  if (rec.detector_id !== "D10" || catalogTokens === null || !Number.isFinite(catalogTokens)) {
    return null;
  }

  const catalogTargetTokens = evNum(rec, "catalog_target_tokens");
  const deltaTokens = evNum(rec, "delta_context_tokens");
  const toolSearchMode = evStr(rec, "tool_search_mode") ?? "unknown";
  const configuredValue = evStr(rec, "configured_value") ?? "unset";
  const alwaysLoadCount = evNum(rec, "always_load_count");
  const jsonBody = toolSearchMode === "deferred" ? "{}" : '{\n  "enableToolSearch": true\n}';

  return {
    language: "jsonc",
    caption: "Suggested settings.json (lazy-load MCP tools)",
    text: joinLines([
      "// ~/.claude/settings.json — reduce always-loaded MCP tool catalog",
      `// Measured catalog: ${fmtNum(catalogTokens)} tokens, ${
        deltaTokens === null || !Number.isFinite(deltaTokens) ? "unavailable" : fmtNum(deltaTokens)
      } over the ${
        catalogTargetTokens === null || !Number.isFinite(catalogTargetTokens)
          ? "unavailable"
          : fmtNum(catalogTargetTokens)
      } target`,
      `// Current tool-search mode: ${toolSearchMode} (configured: ${configuredValue})`,
      jsonBody,
      alwaysLoadCount !== null && Number.isFinite(alwaysLoadCount) && alwaysLoadCount > 0
        ? `// ${fmtNum(alwaysLoadCount)} MCP server(s) currently set alwaysLoad:true — review each and set alwaysLoad:false for rarely-used ones.`
        : null,
    ]),
  };
}

/**
 * RI8 (R12): early-autocompact override for context-heavy detectors (D2/D8).
 * The threshold is a community-derived heuristic (60–75% band), NOT an Anthropic
 * figure — the caption and comments carry the unverified label so it never reads
 * as a measured recommendation.
 */
export function generateAutocompactSnippet(rec: RecommendationCard): GeneratedSnippet | null {
  if (rec.detector_id !== "D2" && rec.detector_id !== "D8") return null;
  return {
    language: "jsonc",
    caption:
      "Suggested settings.json env — earlier autocompact (community-derived heuristic, 60–75% band — unverified)",
    text: joinLines([
      "// ~/.claude/settings.json — trigger autocompact earlier to cap context growth.",
      "// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=75 is a community-derived heuristic (60–75% band) — unverified by Anthropic.",
      '{\n  "env": {\n    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "75"\n  }\n}',
    ]),
  };
}

/**
 * RI8 (R12): route read-only subagents to Haiku, offered alongside the D4 model
 * default. Set in agent frontmatter or at dispatch — no measured quantity, so it
 * is presented as a paste-able artifact only.
 */
export function generateSubagentRoutingSnippet(rec: RecommendationCard): GeneratedSnippet | null {
  if (rec.detector_id !== "D4") return null;
  return {
    language: "jsonc",
    caption: "Suggested subagent routing — default read-only subagents to Haiku",
    text: joinLines([
      "// Route read-only subagents (search, grep, lookup) to Haiku; keep Sonnet/Opus for edits + reasoning.",
      "// Set in .claude/agents/<name>.md frontmatter, or pass model: 'haiku' at dispatch.",
      "---\nmodel: haiku\n---",
    ]),
  };
}

export function generateModelDefaultSnippet(rec: RecommendationCard): GeneratedSnippet | null {
  const totalOpusTurns = evNum(rec, "total_opus_turns_per_week");

  if (rec.detector_id !== "D4" || totalOpusTurns === null || !Number.isFinite(totalOpusTurns)) {
    return null;
  }

  const mismatchTurns = evNum(rec, "mismatch_turns_per_week");
  const mismatchFraction = evNum(rec, "mismatch_fraction");
  const advisoryNote = evStr(rec, "advisory_note");
  const advisoryLine =
    advisoryNote === null
      ? "// Advisory: only helps if your all-models/Opus/5h cap is binding — check /usage first."
      : `// ${advisoryNote}`;
  const diagnosticSavings = evNum(rec, "diagnostic_savings_u_per_wk_if_all_models_cap_binds");

  return {
    language: "jsonc",
    caption: "Suggested .claude/settings.json (model default)",
    text: joinLines([
      "// <repo root>/.claude/settings.json — default this workspace to Sonnet",
      advisoryLine,
      `// Measured: ${mismatchTurns === null || !Number.isFinite(mismatchTurns) ? 0 : fmtNum(mismatchTurns)} of ${fmtNum(totalOpusTurns)} Opus turns are high-context low-output (${Math.round(
        (mismatchFraction === null || !Number.isFinite(mismatchFraction) ? 0 : mismatchFraction) *
          100,
      )}%).`,
      diagnosticSavings !== null && Number.isFinite(diagnosticSavings)
        ? `// Diagnostic ceiling, only if that cap binds: ~$${(diagnosticSavings / 1_000_000).toFixed(2)}/wk`
        : null,
      '{\n  "model": "sonnet"\n}',
    ]),
  };
}
