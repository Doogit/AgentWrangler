import { loadConfig } from "../../src/daemon/config.js";
import type { FindingAnchorV2, FindingEnvelopeV2 } from "../../src/detector/privacy-contract.js";
import { findingIds } from "../../src/detector/privacy-contract.js";
import { DETECTORS } from "../../src/detector/registry.js";
import type { DetectorContext, DetectorV2, FiredV2 } from "../../src/detector/types.js";
import { openQueryOnlyDb } from "../../src/evidence/common/sqlite.js";

type TurnRow = {
  message_id: string;
  session_id: string;
  ts: string;
  parser_version: string;
};

type MetricRow = {
  event_id: string;
  session_id: string;
  ts: string | null;
  cc_version: string | null;
};

type ToolOwnerRow = {
  event_id: string;
  owner_message_id: string | null;
};

type AnchorVersions = {
  parserVersions: Set<string>;
  claudeCodeVersions: Set<string>;
};

type Candidate = {
  sessionId: string;
  selectionKey: string;
  parserVersion: string | null;
  claudeCodeVersion: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function addIfPresent(target: Set<string>, value: string | null | undefined): void {
  if (value !== null && value !== undefined && value.length > 0) target.add(value);
}

function only(values: Set<string>): string | null {
  return values.size === 1 ? ([...values][0] ?? null) : null;
}

function main(): void {
  const db = openQueryOnlyDb(loadConfig().dbPath);
  try {
    const sessions = db.prepare("SELECT session_id FROM sessions").all() as Array<{
      session_id: string;
    }>;
    const sessionBySafeId = new Map(
      sessions.map((row) => [findingIds.session(row.session_id), row.session_id]),
    );

    const turns = db
      .prepare(
        `SELECT message_id, session_id, ts, parser_version
           FROM turns
          ORDER BY session_id, ts, message_id`,
      )
      .all() as TurnRow[];
    const turnBySafeMessage = new Map(
      turns.map((row) => [findingIds.message(row.message_id), row]),
    );
    const turnsBySession = new Map<string, TurnRow[]>();
    for (const row of turns) {
      const existing = turnsBySession.get(row.session_id) ?? [];
      existing.push(row);
      turnsBySession.set(row.session_id, existing);
    }

    const metrics = db
      .prepare(
        `SELECT event_id, session_id, COALESCE(event_ts, user_turn_ts) AS ts, cc_version
           FROM ingest_metric_events`,
      )
      .all() as MetricRow[];
    const metricBySafeEvent = new Map(metrics.map((row) => [findingIds.event(row.event_id), row]));
    const metricsBySession = new Map<string, MetricRow[]>();
    for (const row of metrics) {
      const existing = metricsBySession.get(row.session_id) ?? [];
      existing.push(row);
      metricsBySession.set(row.session_id, existing);
    }

    const toolOwners = db
      .prepare("SELECT event_id, owner_message_id FROM tool_event_metadata")
      .all() as ToolOwnerRow[];
    const ownerBySafeEvent = new Map(
      toolOwners.map((row) => [findingIds.event(row.event_id), row.owner_message_id]),
    );

    const sessionParserVersions = new Map<string, Set<string>>();
    for (const row of turns) {
      const versions = sessionParserVersions.get(row.session_id) ?? new Set<string>();
      addIfPresent(versions, row.parser_version);
      sessionParserVersions.set(row.session_id, versions);
    }
    const sessionClaudeVersions = new Map<string, Set<string>>();
    for (const row of metrics) {
      const versions = sessionClaudeVersions.get(row.session_id) ?? new Set<string>();
      addIfPresent(versions, row.cc_version);
      sessionClaudeVersions.set(row.session_id, versions);
    }

    const now = new Date();
    const ctx: DetectorContext = {
      now,
      fromIso: new Date(now.getTime() - 7 * DAY_MS).toISOString(),
      toIso: now.toISOString(),
    };

    const summaries = DETECTORS.filter(
      (detector): detector is DetectorV2 => detector.contractVersion === 2,
    ).map((detector) => {
      const outcome = detector.evaluate(db, ctx);
      const surfacedCandidates = outcome.fired.map((fired) =>
        candidateFromFinding(
          fired,
          sessionBySafeId,
          turnBySafeMessage,
          turnsBySession,
          metricBySafeEvent,
          metricsBySession,
          ownerBySafeEvent,
          sessionParserVersions,
          sessionClaudeVersions,
        ),
      );
      const candidateBySession = new Map<string, Candidate>();
      for (const candidate of surfacedCandidates) {
        const selected = candidateBySession.get(candidate.sessionId);
        if (selected === undefined || candidate.selectionKey < selected.selectionKey) {
          candidateBySession.set(candidate.sessionId, candidate);
        }
      }
      const candidates = [...candidateBySession.values()];

      const exactStrata = new Map<string, Set<string>>();
      const unresolvedVersionSessions = new Set<string>();
      for (const candidate of candidates) {
        if (candidate.parserVersion === null || candidate.claudeCodeVersion === null) {
          unresolvedVersionSessions.add(candidate.sessionId);
          continue;
        }
        const key = `${candidate.parserVersion}\0${candidate.claudeCodeVersion}`;
        const distinctSessions = exactStrata.get(key) ?? new Set<string>();
        distinctSessions.add(candidate.sessionId);
        exactStrata.set(key, distinctSessions);
      }

      const strata = [...exactStrata.entries()]
        .map(([key, distinctSessions]) => {
          const separator = key.indexOf("\0");
          if (separator < 1 || separator === key.length - 1) {
            throw new Error("u12_preflight_invalid_version_stratum");
          }
          return {
            parser_version: key.slice(0, separator),
            claude_code_version: key.slice(separator + 1),
            distinct_positive_sessions: distinctSessions.size,
          };
        })
        .sort(
          (left, right) =>
            right.distinct_positive_sessions - left.distinct_positive_sessions ||
            left.parser_version.localeCompare(right.parser_version) ||
            left.claude_code_version.localeCompare(right.claude_code_version),
        );
      const distinctPositiveSessions = candidates.length;
      const maximumExactStratum = Math.max(
        0,
        ...strata.map((stratum) => stratum.distinct_positive_sessions),
      );

      return {
        detector_id: detector.id,
        rule_id: detector.descriptor.rule_id,
        rule_version: detector.descriptor.defaults.assessment.provenance.version,
        surfaced_findings: surfacedCandidates.length,
        selected_one_per_session_candidates: candidates.length,
        distinct_positive_sessions: distinctPositiveSessions,
        unresolved_version_sessions: unresolvedVersionSessions.size,
        exact_version_strata: strata,
        minimum_population_available: distinctPositiveSessions >= 35,
        exact_stratum_at_minimum: maximumExactStratum >= 35,
      };
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          version: "u12-aggregate-preflight-v1",
          window_days: 7,
          detector_count: summaries.length,
          detectors: summaries,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    db.close();
  }
}

function candidateFromFinding(
  fired: FiredV2,
  sessionBySafeId: Map<string, string>,
  turnBySafeMessage: Map<string, TurnRow>,
  turnsBySession: Map<string, TurnRow[]>,
  metricBySafeEvent: Map<string, MetricRow>,
  metricsBySession: Map<string, MetricRow[]>,
  ownerBySafeEvent: Map<string, string | null>,
  sessionParserVersions: Map<string, Set<string>>,
  sessionClaudeVersions: Map<string, Set<string>>,
): Candidate {
  const payload = fired.payload as FindingEnvelopeV2;
  const certificationSafeSession = [
    ...new Set(payload.anchors.map((anchor) => anchor.session_id)),
  ].sort()[0];
  const sessionId = certificationSafeSession
    ? sessionBySafeId.get(certificationSafeSession)
    : undefined;
  if (sessionId === undefined) throw new Error("u12_preflight_anchor_session_unresolved");

  const versions: AnchorVersions = {
    parserVersions: new Set<string>(),
    claudeCodeVersions: new Set<string>(),
  };
  for (const anchor of payload.anchors) {
    const anchorVersions = resolveAnchorVersions(
      anchor,
      sessionBySafeId,
      turnBySafeMessage,
      turnsBySession,
      metricBySafeEvent,
      metricsBySession,
      ownerBySafeEvent,
      sessionParserVersions,
      sessionClaudeVersions,
    );
    if (anchorVersions === null) {
      return {
        sessionId,
        selectionKey: payload.evidence_digest,
        parserVersion: null,
        claudeCodeVersion: null,
      };
    }
    versions.parserVersions.add(anchorVersions.parserVersion);
    versions.claudeCodeVersions.add(anchorVersions.claudeCodeVersion);
  }
  return {
    sessionId,
    selectionKey: payload.evidence_digest,
    parserVersion: only(versions.parserVersions),
    claudeCodeVersion: only(versions.claudeCodeVersions),
  };
}

function resolveAnchorVersions(
  anchor: FindingAnchorV2,
  sessionBySafeId: Map<string, string>,
  turnBySafeMessage: Map<string, TurnRow>,
  turnsBySession: Map<string, TurnRow[]>,
  metricBySafeEvent: Map<string, MetricRow>,
  metricsBySession: Map<string, MetricRow[]>,
  ownerBySafeEvent: Map<string, string | null>,
  sessionParserVersions: Map<string, Set<string>>,
  sessionClaudeVersions: Map<string, Set<string>>,
): { parserVersion: string; claudeCodeVersion: string } | null {
  const sessionId = sessionBySafeId.get(anchor.session_id);
  if (sessionId === undefined) throw new Error("u12_preflight_anchor_session_unresolved");

  let turn: TurnRow | undefined;
  if (anchor.message_id !== undefined) turn = turnBySafeMessage.get(anchor.message_id);
  if (turn === undefined && anchor.event_id !== undefined) {
    const ownerMessageId = ownerBySafeEvent.get(anchor.event_id);
    if (ownerMessageId) turn = turnBySafeMessage.get(findingIds.message(ownerMessageId));
  }
  if (turn === undefined && anchor.turn_index !== undefined) {
    turn = turnsBySession.get(sessionId)?.[anchor.turn_index];
  }
  if (turn === undefined) {
    const matches = (turnsBySession.get(sessionId) ?? []).filter(
      (row) => row.ts === anchor.timestamp,
    );
    if (matches.length === 1) turn = matches[0];
  }
  const parserVersions = new Set<string>();
  addIfPresent(parserVersions, turn?.parser_version);
  if (parserVersions.size === 0) {
    for (const version of sessionParserVersions.get(sessionId) ?? []) {
      parserVersions.add(version);
    }
  }

  const claudeCodeVersions = new Set<string>();
  const metric = anchor.event_id === undefined ? undefined : metricBySafeEvent.get(anchor.event_id);
  addIfPresent(claudeCodeVersions, metric?.cc_version);
  for (const row of metricsBySession.get(sessionId) ?? []) {
    if (row.ts === anchor.timestamp) addIfPresent(claudeCodeVersions, row.cc_version);
  }
  if (claudeCodeVersions.size === 0) {
    for (const version of sessionClaudeVersions.get(sessionId) ?? []) {
      claudeCodeVersions.add(version);
    }
  }

  const parserVersion = only(parserVersions);
  const claudeCodeVersion = only(claudeCodeVersions);
  return parserVersion === null || claudeCodeVersion === null
    ? null
    : { parserVersion, claudeCodeVersion };
}

try {
  main();
} catch {
  process.stderr.write("U12 aggregate preflight failed without emitting private details.\n");
  process.exitCode = 1;
}
