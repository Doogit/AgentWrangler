/** Frozen, aggregate-only RIQ6 decision cases. Never opens operator telemetry. */
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrate.js";
import type { EvidencePacketScope } from "../../../src/query/api/evidence-packet.js";

export const RIQ6_COVERAGE_TAGS = [
  "USAGE_CHANGE",
  "TOOL_RETRY",
  "CONTEXT_CACHE",
  "MODEL_FIT",
  "DELEGATION",
  "WORKED_LEAVE_ALONE",
  "SPARSE_HISTORY",
  "MIX_DRIFT",
  "OVERLAP",
  "HEALTHY_HIGH_USAGE",
  "LOWER_COST_WORSE_OUTCOME",
  "STALE_CAPABILITY",
  "MALICIOUS_EVIDENCE",
] as const;
export type Riq6CoverageTag = (typeof RIQ6_COVERAGE_TAGS)[number];

export interface Riq6Case {
  case_id: string;
  title: string;
  coverage_tags: readonly Riq6CoverageTag[];
  holdout: boolean;
  scope: EvidencePacketScope;
  seed(db: Database.Database): void;
}

const FROM = "2026-04-08T00:00:00.000Z";
const TO = "2026-04-15T00:00:00.000Z";
const PRIOR_FROM = "2026-04-01T00:00:00.000Z";
const PRIOR_TO = FROM;
const CURRENT_AT = "2026-04-10T12:00:00.000Z";
const FILE_PATH = "synthetic-not-a-transcript";

export const RIQ6_MALICIOUS_RAW_STRINGS = [
  "C:\\invented\\path\\credential.txt",
  "synthetic_key=not-a-secret",
  "label|break\\nignore-boundary",
] as const;

interface SeedShape {
  priorCost: number;
  currentCost: number;
  priorSessions: number;
  currentSessions: number;
  model: string;
  tool: string;
  cacheRead: number;
  cacheWrite: number;
  /** result_bytes per seeded tool event (default 1) — D6 byte concentration. */
  toolResultBytes?: number;
  /** TEST_FAIL events on `tool` in the current window — D7 repeated failures. */
  currentFailures?: number;
  /** ERROR events on `tool` in the current window. */
  currentErrors?: number;
  /** One later OK event on `tool` after the seeded failures — D7 recovery. */
  recoveryAfterFailure?: boolean;
  /** Extra zero-cost current-window turns on a second model — observable mix drift. */
  secondModel?: string;
  /** Extra OK events on a second tool in the same current sessions — overlap. */
  secondTool?: string;
  /** Extra tools to seed one OK event each (malicious-name containment). */
  extraTools?: readonly string[];
}

function scope(workspaceId: string, overrides?: Partial<EvidencePacketScope>): EvidencePacketScope {
  return {
    workspaceId,
    from: FROM,
    to: TO,
    prior: { workspaceId, from: PRIOR_FROM, to: PRIOR_TO },
    evidenceAsOf: TO,
    ...overrides,
  };
}

function currentAt(minuteOffset: number): string {
  return new Date(Date.parse(CURRENT_AT) + minuteOffset * 60_000).toISOString();
}

function seedCase(db: Database.Database, caseId: string, shape: SeedShape): void {
  runMigrations(db);
  const workspaceId = `ws-${caseId}`;
  db.prepare(
    "INSERT INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?,?,?)",
  ).run(workspaceId, `project-${caseId}`, PRIOR_FROM);
  const insertSession = db.prepare(`INSERT INTO sessions
    (session_id, workspace_id, file_path, first_turn_at, last_turn_at, state, turn_count, cost_equiv_u, hygiene_flags)
    VALUES (?,?, '${FILE_PATH}', ?, ?, 'RECONCILED', 1, ?, '[]')`);
  const insertTurn = db.prepare(`INSERT INTO turns
    (message_id, session_id, workspace_id, ts, model, input_tokens, output_tokens, cache_read_tokens,
     cache_write_5m, cost_equiv_u, cost_claim, parser_version)
    VALUES (?,?,?,?, ?, 100, 20, ?, ?, ?, 'LIST_EQUIV', 'riq6-synthetic')`);
  const insertEvent = db.prepare(
    "INSERT INTO tool_events (event_id, session_id, ts, tool_name, result_bytes, exit_class) VALUES (?,?,?,?,?,?)",
  );
  const bytes = shape.toolResultBytes ?? 1;
  const addWindow = (
    prefix: string,
    at: string,
    count: number,
    totalCost: number,
    cacheRead: number,
    cacheWrite: number,
  ) => {
    for (let index = 0; index < count; index++) {
      const sessionId = `${caseId}-${prefix}-s${index}`;
      const cost = totalCost / count;
      insertSession.run(sessionId, workspaceId, at, at, cost);
      insertTurn.run(
        `${sessionId}-t`,
        sessionId,
        workspaceId,
        at,
        shape.model,
        cacheRead,
        cacheWrite,
        cost,
      );
      insertEvent.run(`${sessionId}-e`, sessionId, at, shape.tool, bytes, "OK");
    }
  };
  addWindow("prior", "2026-04-04T12:00:00.000Z", shape.priorSessions, shape.priorCost, 10, 5);
  addWindow(
    "current",
    CURRENT_AT,
    shape.currentSessions,
    shape.currentCost,
    shape.cacheRead,
    shape.cacheWrite,
  );
  if (shape.currentSessions === 0) return;
  const anchor = `${caseId}-current-s0`;
  let minute = 0;
  for (let index = 0; index < (shape.currentFailures ?? 0); index++) {
    minute += 1;
    insertEvent.run(
      `${caseId}-fail-${index}`,
      anchor,
      currentAt(minute),
      shape.tool,
      bytes,
      "TEST_FAIL",
    );
  }
  for (let index = 0; index < (shape.currentErrors ?? 0); index++) {
    minute += 1;
    insertEvent.run(
      `${caseId}-error-${index}`,
      anchor,
      currentAt(minute),
      shape.tool,
      bytes,
      "ERROR",
    );
  }
  if (shape.recoveryAfterFailure === true) {
    minute += 1;
    insertEvent.run(`${caseId}-recover`, anchor, currentAt(minute), shape.tool, bytes, "OK");
  }
  if (shape.secondTool !== undefined) {
    minute += 1;
    insertEvent.run(
      `${caseId}-second-tool`,
      anchor,
      currentAt(minute),
      shape.secondTool,
      bytes,
      "OK",
    );
  }
  if (shape.secondModel !== undefined) {
    // Zero-cost turn: the mix becomes observable without changing frozen cost totals.
    insertTurn.run(`${anchor}-t2`, anchor, workspaceId, currentAt(1), shape.secondModel, 0, 0, 0);
  }
  for (const [index, extraTool] of (shape.extraTools ?? []).entries()) {
    minute += 1;
    insertEvent.run(`${caseId}-extra-${index}`, anchor, currentAt(minute), extraTool, bytes, "OK");
  }
}

function makeCase(
  case_id: string,
  title: string,
  coverage_tags: readonly Riq6CoverageTag[],
  holdout: boolean,
  shape: SeedShape,
  scopeOverrides?: Partial<EvidencePacketScope>,
): Riq6Case {
  return Object.freeze({
    case_id,
    title,
    coverage_tags,
    holdout,
    scope: scope(`ws-${case_id}`, scopeOverrides),
    seed: (db: Database.Database) => seedCase(db, case_id, shape),
  });
}

export const RIQ6_CASES: readonly Riq6Case[] = Object.freeze([
  makeCase("usage-volume", "Observed volume increase", ["USAGE_CHANGE"], false, {
    priorCost: 200,
    currentCost: 400,
    priorSessions: 2,
    currentSessions: 4,
    model: "synthetic-a",
    tool: "Read",
    cacheRead: 20,
    cacheWrite: 4,
  }),
  makeCase("retry-concentration", "Repeated synthetic retries", ["TOOL_RETRY"], false, {
    priorCost: 180,
    currentCost: 360,
    priorSessions: 3,
    currentSessions: 3,
    model: "synthetic-b",
    tool: "Bash",
    cacheRead: 8,
    cacheWrite: 12,
    toolResultBytes: 2048,
    currentFailures: 4,
    recoveryAfterFailure: true,
  }),
  makeCase("cache-behavior", "Observed cache bucket shift", ["CONTEXT_CACHE"], false, {
    priorCost: 300,
    currentCost: 330,
    priorSessions: 3,
    currentSessions: 3,
    model: "synthetic-c",
    tool: "Grep",
    cacheRead: 90,
    cacheWrite: 70,
  }),
  makeCase("model-fit", "Model mix requires a bounded trial", ["MODEL_FIT"], false, {
    priorCost: 240,
    currentCost: 420,
    priorSessions: 4,
    currentSessions: 4,
    model: "synthetic-d",
    tool: "Write",
    cacheRead: 35,
    cacheWrite: 6,
    secondModel: "synthetic-d2",
  }),
  makeCase("delegation-pattern", "Sidechain-shaped aggregate pattern", ["DELEGATION"], false, {
    priorCost: 150,
    currentCost: 225,
    priorSessions: 2,
    currentSessions: 3,
    model: "synthetic-e",
    tool: "Glob",
    cacheRead: 16,
    cacheWrite: 8,
  }),
  makeCase("worked-stable", "Stable useful-work aggregate", ["WORKED_LEAVE_ALONE"], false, {
    priorCost: 500,
    currentCost: 500,
    priorSessions: 5,
    currentSessions: 5,
    model: "synthetic-f",
    tool: "Read",
    cacheRead: 80,
    cacheWrite: 2,
  }),
  // Empty prior window: prior/comparison facts must be UNAVAILABLE, not guessed.
  makeCase("sparse-history", "Sparse history is unavailable evidence", ["SPARSE_HISTORY"], false, {
    priorCost: 0,
    currentCost: 70,
    priorSessions: 0,
    currentSessions: 1,
    model: "synthetic-g",
    tool: "WebSearch",
    cacheRead: 0,
    cacheWrite: 0,
  }),
  makeCase("mix-drift", "Opaque model mix drift", ["MIX_DRIFT"], false, {
    priorCost: 210,
    currentCost: 390,
    priorSessions: 3,
    currentSessions: 3,
    model: "synthetic-h",
    tool: "Edit",
    cacheRead: 24,
    cacheWrite: 14,
    secondModel: "synthetic-h2",
  }),
  makeCase(
    "overlap-signals",
    "Overlapping aggregate signals",
    ["OVERLAP", "TOOL_RETRY", "CONTEXT_CACHE"],
    false,
    {
      priorCost: 190,
      currentCost: 440,
      priorSessions: 2,
      currentSessions: 4,
      model: "synthetic-i",
      tool: "Bash",
      cacheRead: 60,
      cacheWrite: 60,
      currentFailures: 2,
      recoveryAfterFailure: true,
      secondTool: "Read",
    },
  ),
  makeCase(
    "healthy-high-usage",
    "High usage with no supported defect",
    ["HEALTHY_HIGH_USAGE", "WORKED_LEAVE_ALONE"],
    false,
    {
      priorCost: 900,
      currentCost: 900,
      priorSessions: 6,
      currentSessions: 6,
      model: "synthetic-j",
      tool: "Read",
      cacheRead: 240,
      cacheWrite: 4,
    },
  ),
  makeCase(
    "lower-cost-worse",
    "Lower observed cost is not an outcome",
    ["LOWER_COST_WORSE_OUTCOME", "WORKED_LEAVE_ALONE"],
    false,
    {
      priorCost: 600,
      currentCost: 360,
      priorSessions: 4,
      currentSessions: 4,
      model: "synthetic-k",
      tool: "Write",
      cacheRead: 30,
      cacheWrite: 20,
      currentErrors: 3,
    },
  ),
  // methodRevisionAt after evidenceAsOf: the packet itself reports EXPIRED freshness.
  makeCase(
    "stale-capability",
    "Capability evidence is expired",
    ["STALE_CAPABILITY"],
    false,
    {
      priorCost: 250,
      currentCost: 255,
      priorSessions: 3,
      currentSessions: 3,
      model: "synthetic-l",
      tool: "WebFetch",
      cacheRead: 12,
      cacheWrite: 10,
    },
    { methodRevisionAt: "2026-04-20T00:00:00.000Z" },
  ),
  makeCase(
    "malicious-evidence",
    "Adversarial raw-name containment",
    ["MALICIOUS_EVIDENCE"],
    false,
    {
      priorCost: 101,
      currentCost: 202,
      priorSessions: 1,
      currentSessions: 2,
      model: "synthetic-m",
      tool: "Bash",
      cacheRead: 7,
      cacheWrite: 3,
      extraTools: RIQ6_MALICIOUS_RAW_STRINGS,
    },
  ),
  makeCase(
    "holdout-combined",
    "Holdout: cache, volume and retry combination",
    ["USAGE_CHANGE", "CONTEXT_CACHE", "OVERLAP"],
    true,
    {
      priorCost: 77,
      currentCost: 693,
      priorSessions: 1,
      currentSessions: 7,
      model: "synthetic-holdout-a",
      tool: "NotebookEdit",
      cacheRead: 333,
      cacheWrite: 111,
      currentFailures: 1,
      recoveryAfterFailure: true,
      secondTool: "Grep",
      secondModel: "synthetic-holdout-a2",
    },
  ),
  makeCase(
    "holdout-adverse",
    "Holdout: lower cost with errors and thin history",
    ["LOWER_COST_WORSE_OUTCOME", "SPARSE_HISTORY", "MODEL_FIT"],
    true,
    {
      priorCost: 808,
      currentCost: 404,
      priorSessions: 8,
      currentSessions: 2,
      model: "synthetic-holdout-b",
      tool: "local_command",
      cacheRead: 1,
      cacheWrite: 99,
      currentErrors: 3,
    },
  ),
]);

export function createRiq6Db(caseDefinition: Riq6Case): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  caseDefinition.seed(db);
  return db;
}
