import type { Db } from "../../db/open.js";

export function isG2JudgeOptIn(db: Db): boolean {
  const row = db
    .prepare("SELECT value FROM user_config WHERE key = 'g2_claude_judge_opt_in'")
    .get() as { value: string | null } | undefined;

  return row?.value === "true";
}

export interface JudgeVerdictRow {
  findingId: string;
  verdict: "CONFIRMED" | "REJECTED";
  confidence: number;
}

export function persistJudgeVerdicts(db: Db, verdicts: readonly JudgeVerdictRow[]): void {
  const updateVerdict = db.prepare(
    "UPDATE review_findings SET human_state = ?, confidence = ?, source = 'LLM' WHERE finding_id = ?",
  );

  db.transaction(() => {
    for (const verdict of verdicts) {
      updateVerdict.run(verdict.verdict, verdict.confidence, verdict.findingId);
    }
  })();
}
