import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { d11Detector } from "../../src/detector/detectors/d11_tool_error_rate.js";
import { runDetectors } from "../../src/detector/index.js";
import { d11Outcome } from "../../src/detector/turn-claim.js";
import type { DetectorContext } from "../../src/detector/types.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const NOW = new Date("2027-01-08T00:00:00.000Z");
const CTX: DetectorContext = {
  now: NOW,
  fromIso: "2027-01-01T00:00:00.000Z",
  toIso: NOW.toISOString(),
};

let db: Database.Database;
let sequence = 0;

beforeEach(() => {
  db = createInMemoryFixtureDb();
  sequence = 0;
  db.prepare(
    `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
     VALUES ('ws-d11', 'ws-d11', '2027-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
     VALUES ('session-d11', 'ws-d11', '/fixture/d11.jsonl', ?, ?,
             'RECONCILED', 0, 0, '[]')`,
  ).run(CTX.fromIso, CTX.fromIso);
});

afterEach(() => db.close());

/** A failure the shell itself caused: a parse error or an unknown command. */
const SHELL_FAILURE = {
  Bash: {
    command: 'echo "x',
    error: "Exit code 2\n/usr/bin/bash: -c: line 1: unexpected EOF while looking for matching `\"'",
  },
  PowerShell: {
    command: "head -5 x.txt",
    error:
      "Exit code 1\nhead : The term 'head' is not recognized as the name of a cmdlet, function, script file, or operable program.",
  },
};

function addToolEvents(
  toolName: "Bash" | "PowerShell",
  calls: number,
  errors: number,
  options: {
    isSidechain?: boolean;
    costEquivU?: number;
    workspaceId?: string;
    /** Stored command + error of each failed call. */
    failure?: { command: string; error: string };
  } = {},
): void {
  const workspaceId = options.workspaceId ?? "ws-d11";
  const sessionId = workspaceId === "ws-d11" ? "session-d11" : `session-${workspaceId}`;
  if (workspaceId !== "ws-d11") {
    db.prepare(
      "INSERT OR IGNORE INTO workspaces (workspace_id, project_slug, registered_at) VALUES (?, ?, ?)",
    ).run(workspaceId, workspaceId, CTX.fromIso);
    db.prepare(
      `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, file_path, first_turn_at, last_turn_at,
        state, turn_count, cost_equiv_u, hygiene_flags)
       VALUES (?, ?, ?, ?, ?, 'RECONCILED', 0, 0, '[]')`,
    ).run(sessionId, workspaceId, `/fixture/${workspaceId}.jsonl`, CTX.fromIso, CTX.fromIso);
  }
  const insert = db.prepare(
    `INSERT INTO tool_events
       (event_id, session_id, ts, tool_name, input_bytes, result_bytes,
        input_hash, exit_class, commit_sha)
     VALUES (?, ?, '2027-01-02T00:00:00.000Z', ?, 1, NULL,
             NULL, ?, NULL)`,
  );
  // Review 3 B3: D11 counts only failures the shell caused, so a failure defaults to one.
  const failure = options.failure ?? SHELL_FAILURE[toolName];
  for (let index = 0; index < calls; index++) {
    const eventId = `event-d11-${sequence++}`;
    const ownerMessageId = `turn-${eventId}`;
    insert.run(eventId, sessionId, toolName, index < errors ? "ERROR" : "OK");
    if (index < errors) {
      db.prepare("INSERT INTO tool_event_content (event_id, content_json) VALUES (?, ?)").run(
        eventId,
        JSON.stringify(failure),
      );
    }
    db.prepare(
      `INSERT INTO turns
         (message_id, session_id, workspace_id, ts, model, is_sidechain,
          cost_equiv_u, cost_claim, provisional, parser_version)
       VALUES (?, ?, ?, '2027-01-02T00:00:00.000Z',
               'claude-sonnet-4', ?, ?, 'LIST_EQUIV', 0, 'test-v1')`,
    ).run(
      ownerMessageId,
      sessionId,
      workspaceId,
      options.isSidechain ? 1 : 0,
      options.costEquivU ?? 100,
    );
    db.prepare(
      `INSERT INTO tool_event_metadata
         (event_id, file_path_hash, owner_message_id, block_index, is_test_command)
       VALUES (?, NULL, ?, 0, 0)`,
    ).run(eventId, ownerMessageId);
  }
}

describe("D11 TOOL_ERROR_RATE", () => {
  it("stays inactive when either tool has fewer than the minimum calls", () => {
    addToolEvents("Bash", 10, 9);
    addToolEvents("PowerShell", 10, 1);

    const outcome = d11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("INACTIVE");
    expect(outcome.fired).toEqual([]);
  });

  it("leaves out calls that never ran and benign exits (review 1 R3.4)", () => {
    addToolEvents("Bash", 100, 0);
    // Blocked by a hook before running: C9 counts these, not D11.
    addToolEvents("PowerShell", 40, 40, {
      failure: {
        command: "Set-Location x",
        error: "PreToolUse:PowerShell hook error: Blocked PowerShell shape",
      },
    });
    // taskkill exit 128: the process was already gone, which is what was wanted.
    addToolEvents("PowerShell", 30, 30, {
      failure: { command: "taskkill /PID 1 /T /F", error: "Exit code 128\nERROR: not found" },
    });
    addToolEvents("PowerShell", 30, 0);

    const outcome = d11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("INACTIVE");
    expect(outcome.fired).toEqual([]);
  });

  it("treats git diff --quiet exit 1 ('there are changes') as an answer, not a failure", () => {
    expect(d11Outcome("ERROR", "git diff --cached --quiet; echo x", "Exit code 1\nx")).toBe("OK");
    expect(d11Outcome("ERROR", "git -C r diff --exit-code main", "Exit code 1")).toBe("OK");
  });

  it("D11a: a failing test, lint, typecheck or build is the code's failure, not the shell's", () => {
    for (const command of [
      "npx --no-install vitest run test/query",
      "npm run -s typecheck",
      "npm run lint 2>&1 | tail -3",
      "npm run build:ui",
      "npm test",
      "npx tsc --noEmit",
      "npx biome check src",
      "npm run verify:app",
    ]) {
      expect(d11Outcome("ERROR", command, "Exit code 1\nFAIL x")).toBe("OK");
    }
  });

  // Review 3 B3: a failure counts only when the shell itself failed; a script, gate, hook or
  // program that ran and failed would fail the same way in the other shell.
  it("B3: counts parse errors and unknown commands, not failures of what ran", () => {
    for (const error of [
      "Exit code 2\n/usr/bin/bash: eval: line 3: unexpected EOF while looking for matching `\"'",
      "Exit code 2\n/usr/bin/bash: -c: line 1: syntax error near unexpected token `)'",
      "Exit code 127\n/usr/bin/bash: line 1: rev: command not found",
      "Exit code 1\nhead : The term 'head' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      "Exit code 1\nParserError: Unexpected token '}' in expression or statement.",
      'Exit code 1\nThe string is missing the terminator: ".',
      "Exit code 1\nThe token '&&' is not a valid statement separator in this version.",
    ]) {
      expect(d11Outcome("ERROR", "x", error)).toBe("ERROR");
    }
    for (const [command, error] of <Array<[string, string]>>[
      ["git commit -F msg.txt", "Exit code 1\n○\n│╲\n gitleaks\nleaks found: 1"],
      [
        "node scripts/launch/export.mjs --check",
        "Exit code 1\nERROR: private working tree has uncommitted tracked changes",
      ],
      ["gitleaks version --no-banner", "Exit code 1\nError: unknown flag: --no-banner"],
      ["npm run typecheck | Select-String error", "Exit code 1\nsrc/x.ts(1,1): error TS2322"],
      ["git diff main", "Exit code 1\nfatal: bad revision"],
      [
        "node -e \"require('better-sqlite3')\"",
        "Exit code 1\nError [ERR_MODULE_NOT_FOUND]: Cannot find package",
      ],
      ["ls x", "Exit code 2\nls: cannot access 'x': No such file or directory"],
    ]) {
      expect(d11Outcome("ERROR", command, error)).toBe("OK");
    }
    // No stored error: the cause is unknown, so it is not counted.
    expect(d11Outcome("ERROR", null, null)).toBe("OK");
  });

  it("counts a shell failure that ran", () => {
    addToolEvents("Bash", 100, 7);
    addToolEvents("PowerShell", 60, 18);
    const fired = d11Detector.evaluate(db, CTX).fired[0];
    if (fired?.payload.template_id !== "D11_TOOL_ERROR_RATE") throw new Error("expected D11");
    expect(fired.payload.facts.powershell_error_count).toBe(18);
    expect(fired.payload.facts.powershell_call_count).toBe(60);
  });

  it("stays inactive when the error-rate ratio is below threshold", () => {
    // 8% vs 7% — both above MIN_CALLS but ratio 1.14x < 1.5x.
    addToolEvents("Bash", 100, 7);
    addToolEvents("PowerShell", 100, 8);

    const outcome = d11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("INACTIVE");
    expect(outcome.fired).toEqual([]);
  });

  it("fires a directional workspace recommendation for a large shell error-rate gap", () => {
    addToolEvents("Bash", 100, 7);
    addToolEvents("PowerShell", 60, 18);

    const outcome = d11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
    const fired = outcome.fired[0];
    if (fired === undefined) throw new Error("expected one D11 recommendation");
    if (fired.payload.template_id !== "D11_TOOL_ERROR_RATE") {
      throw new Error("expected D11 payload");
    }
    expect(fired.scope_workspace_id).toBe("ws-d11");
    expect(fired.scopeKey).toContain("ws-d11");

    // The 18 consecutive PowerShell errors form a D7 loop, so the D7 pre-exclusion
    // takes all but 2 of those turns. D11 prices the 2 it keeps: 2 * 100 microUSD
    // * (18 - 60 * 0.07) / 18 excess-error fraction * 0.5 avoidance = 76.7 -> 77.
    // The headline stays null; the P2 estimate lives in modeled_formula_json.
    expect(fired.modeled_savings_u_per_wk).toBeNull();
    expect(fired.modeled_formula_json).toMatchObject({
      estimate: { basis: "E", rank_value_u_per_wk: 77 },
    });
    // Deterministic: Bash 7/100 = 7.0%, PowerShell 18/60 = 30.0%.
    expect(fired.payload.facts.bash_error_ratio).toBe(0.07);
    expect(fired.payload.facts.powershell_error_ratio).toBe(0.3);
    expect("headroom" in fired.payload.facts).toBe(false);
    // Bash is the lower-error tool here → advice must prefer Bash.
    expect(fired.payload.facts.preferred_tool).toBe("Bash");
    expect(fired.payload.facts.higher_error_tool).toBe("PowerShell");
    expect(fired.payload.facts.session_ids).toEqual(["session-d11"]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id = ?").get("session-d11"),
    ).toEqual({ n: 1 });

    runDetectors(db, { now: NOW });
    const stored = db
      .prepare("SELECT modeled_formula_json FROM recommendations WHERE detector_id = 'D11'")
      .get() as { modeled_formula_json: string };
    expect(JSON.parse(stored.modeled_formula_json).estimate).toMatchObject({
      basis: "E",
      rank_value_u_per_wk: 77,
    });
  });

  it("emits independent opposite directions and workspace-only evidence and estimates", () => {
    addToolEvents("Bash", 100, 4);
    addToolEvents("PowerShell", 60, 12);
    addToolEvents("Bash", 60, 12, { workspaceId: "ws-other", isSidechain: true });
    addToolEvents("PowerShell", 100, 4, { workspaceId: "ws-other" });

    const outcome = d11Detector.evaluate(db, CTX);
    expect(outcome.fired).toHaveLength(2);
    const byWorkspace = new Map(outcome.fired.map((fired) => [fired.scope_workspace_id, fired]));
    const first = byWorkspace.get("ws-d11");
    const second = byWorkspace.get("ws-other");
    if (
      first?.payload.template_id !== "D11_TOOL_ERROR_RATE" ||
      second?.payload.template_id !== "D11_TOOL_ERROR_RATE"
    )
      throw new Error("expected D11 payloads");
    expect(first.scopeKey).not.toBe(second.scopeKey);
    expect(first.payload.facts.preferred_tool).toBe("Bash");
    expect(second.payload.facts.preferred_tool).toBe("PowerShell");
    expect(first.payload.facts.session_ids).toEqual(["session-d11"]);
    expect(second.payload.facts.session_ids).toEqual(["session-ws-other"]);
    expect(first.payload.facts.bash_call_count).toBe(100);
    expect(second.payload.facts.bash_call_count).toBe(60);
    expect(second.modeled_formula_json?.estimate.rank_value_u_per_wk).toBeGreaterThan(0);
  });

  it("does not pool sparse workspaces into a threshold crossing", () => {
    addToolEvents("Bash", 30, 6);
    addToolEvents("PowerShell", 30, 0);
    addToolEvents("Bash", 30, 6, { workspaceId: "ws-other" });
    addToolEvents("PowerShell", 30, 0, { workspaceId: "ws-other" });
    expect(d11Detector.evaluate(db, CTX).fired).toEqual([]);
  });

  it("T9: prices the flagged shell's main-chain errors that C1 now leaves to it", () => {
    // D11 fires on PowerShell here, so C1 leaves PowerShell out (operator decision 2026-09-26)
    // and D11 claims its main-chain errors. D7 owns two of the three (one consecutive error
    // run), so D11 prices one main-chain turn plus the sidechain error: 200 microUSD.
    addToolEvents("Bash", 100, 0);
    addToolEvents("PowerShell", 60, 3);
    addToolEvents("PowerShell", 1, 1, { isSidechain: true });

    const outcome = d11Detector.evaluate(db, CTX);
    const fired = outcome.fired[0];
    if (fired === undefined) throw new Error("expected one D11 recommendation");
    if (fired.payload.template_id !== "D11_TOOL_ERROR_RATE") {
      throw new Error("expected D11 payload");
    }

    // Lower rate is zero, so all four higher-shell errors are excess:
    // 200 priced microUSD * (4 / 4) * 0.5 = 100 microUSD/week.
    expect(fired.modeled_savings_u_per_wk).toBeNull();
    expect(fired.modeled_formula_json).toMatchObject({
      estimate: { basis: "E", rank_value_u_per_wk: 100 },
    });
  });

  it("derives the preferred tool from the data (advice never hardcoded)", () => {
    // PowerShell is the better-behaved shell this window → advice must prefer it.
    addToolEvents("Bash", 100, 18);
    addToolEvents("PowerShell", 60, 4);

    const outcome = d11Detector.evaluate(db, CTX);
    const fired = outcome.fired[0];
    if (fired === undefined) throw new Error("expected one D11 recommendation");
    if (fired.payload.template_id !== "D11_TOOL_ERROR_RATE") {
      throw new Error("expected D11 payload");
    }
    expect(fired.payload.facts.preferred_tool).toBe("PowerShell");
    expect(fired.payload.facts.higher_error_tool).toBe("Bash");
  });

  it("stays inactive via the zero-error-rate branch below the higher-error floor", () => {
    // PowerShell 0/60 = 0%, Bash 1/100 = 1%; one error is not global guidance.
    addToolEvents("Bash", 100, 1);
    addToolEvents("PowerShell", 60, 0);

    const outcome = d11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("INACTIVE");
    expect(outcome.fired).toEqual([]);
  });

  it("fires via the zero-error-rate branch at the higher-error floor", () => {
    // PowerShell 0/60 = 0%, Bash 3/100 = 3%; three errors clears the floor.
    addToolEvents("Bash", 100, 3);
    addToolEvents("PowerShell", 60, 0);

    const outcome = d11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    const fired = outcome.fired[0];
    if (fired === undefined) throw new Error("expected one D11 recommendation");
    if (fired.payload.template_id !== "D11_TOOL_ERROR_RATE") {
      throw new Error("expected D11 payload");
    }
    expect(fired.payload.facts.preferred_tool).toBe("PowerShell");
    expect(fired.payload.facts.powershell_error_ratio).toBe(0);
  });

  it("continues firing for a roughly 2.36x shell error-rate ratio", () => {
    // PowerShell 33/100 = 33%, Bash 14/100 = 14%; ratio is about 2.36x.
    addToolEvents("Bash", 100, 14);
    addToolEvents("PowerShell", 100, 33);

    const outcome = d11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    expect(outcome.fired).toHaveLength(1);
  });

  it("fires at exactly the 1.5x ratio boundary (inclusive >=)", () => {
    // Float-exact rates so the boundary is unambiguous: Bash 8/128 = 0.0625,
    // PowerShell 12/128 = 0.09375, and 1.5 * 0.0625 === 0.09375 exactly.
    addToolEvents("Bash", 128, 8);
    addToolEvents("PowerShell", 128, 12);

    const outcome = d11Detector.evaluate(db, CTX);
    expect(outcome.status).toBe("ACTIVE");
    const fired = outcome.fired[0];
    if (fired === undefined) throw new Error("expected one D11 recommendation");
    if (fired.payload.template_id !== "D11_TOOL_ERROR_RATE") {
      throw new Error("expected D11 payload");
    }
    expect(fired.payload.facts.preferred_tool).toBe("Bash");
  });
});
