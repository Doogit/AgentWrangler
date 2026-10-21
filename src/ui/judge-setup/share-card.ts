import type { JudgeSetupResponse } from "../../query/api/judge-setup";

/**
 * Text share card (JMS R13). Built only from the tier, scores and category labels, which are
 * fixed rubric vocabulary. It never reads check values, rec ids, citations, paths, workspace
 * names or config text, so nothing from the scan can reach the clipboard.
 */
export function buildShareCard(data: JudgeSetupResponse): string {
  const { grade } = data;
  const lines: string[] = ["My Claude Code setup, graded by AgentWrangler"];
  if (grade.tier !== null && grade.overall !== null) {
    lines.push(`Tier: ${grade.tier} (${Math.floor(grade.overall)}/100)`);
  } else {
    lines.push("Tier: not enough data yet");
  }
  for (const cap of grade.caps.filter((c) => c.binding)) {
    lines.push(`Capped at ${cap.tier}`);
  }
  if (grade.overall !== null && (grade.overall_before_hold ?? grade.overall) !== grade.overall) {
    lines.push(
      `Score before the hold: ${Math.floor(grade.overall_before_hold as number)}/100 (shown as ${Math.floor(grade.overall)})`,
    );
  }
  for (const cat of grade.categories) {
    lines.push(
      cat.score === null
        ? `- ${cat.label}: not enough data`
        : `- ${cat.label}: ${Math.round(cat.score)}/100`,
    );
  }
  return lines.join("\n");
}
