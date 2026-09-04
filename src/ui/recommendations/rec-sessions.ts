import type { RecommendationCard } from "../../query/api/recommendations";

export function sessionIdsForRecommendation(rec: RecommendationCard): string[] {
  const ids = new Set<string>();
  const sessionId = rec.evidence.session_id;
  if (typeof sessionId === "string" && sessionId.length > 0) ids.add(sessionId);
  const sessionIds = rec.evidence.session_ids;
  if (Array.isArray(sessionIds)) {
    for (const id of sessionIds) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return [...ids];
}
