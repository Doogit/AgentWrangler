export const D7_FORWARD_COVERAGE_RUNNER_VERSION = "d7-forward-coverage-v1" as const;

export interface AggregateCoverageCohort {
  cohort: string;
  reconciledToolUsingSessionsN: number;
  toolEventsN: number;
  coveredSessionsN: number;
  coveredEventsN: number;
  sessionCoverage: number | null;
  eventCoverage: number | null;
}

export interface D7ForwardCoverageReport {
  campaign: "D7_FORWARD_COVERAGE";
  status: "SUFFICIENT" | "INSUFFICIENT" | "DATA_INSUFFICIENT";
  identity: {
    sourceCommit: string;
    runnerVersion: typeof D7_FORWARD_COVERAGE_RUNNER_VERSION;
    scratchDbSha256: string;
    repoMapSha256: string;
    asOf: string;
    windowDays: 30;
  };
  denominator: { reconciledToolUsingSessionsN: number; toolEventsN: number };
  covered: {
    sessionsN: number;
    eventsN: number;
    sessionCoverage: number | null;
    eventCoverage: number | null;
  };
  exclusions: {
    missingMetadataN: number;
    missingOwnerTurnN: number;
    noSignalInputN: number;
    malformedTimestampN: number;
    invariantFailureN: number;
  };
  byUtcDay: readonly AggregateCoverageCohort[];
  byWorkspaceAlias: readonly AggregateCoverageCohort[];
  decision: {
    minimumSessions: 20;
    sessionCoverageThreshold: 0.8;
    eventCoverageThreshold: 0.8;
    replayProofEligible: boolean;
  };
  privacy: { sessionIdN: 0; workspaceIdN: 0; eventIdN: 0; hashN: 0; pathN: 0; transcriptN: 0 };
}
