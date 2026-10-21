/** Read-only, independent source-count oracle for D11 and C5. Never emits content slices. */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

type DetectorId = "D11" | "C5";
type Window = { from: string; to: string };
type RecRow = {
  detector_id: DetectorId;
  scope_workspace_id: string | null;
  evidence_json: string;
  contract_status: string;
};
type Issue = { detector: DetectorId; status: "FAIL" | "UNPROVEN"; code: string; scope?: string };
export type FrictionReport = {
  status: "PASS" | "FAIL" | "UNPROVEN";
  checked: { D11: number; C5: number };
  historicalChecked: { D11: number; C5: number };
  windows: Array<{ detector: DetectorId; from: string; to: string }>;
  issues: Issue[];
  historicalIssues: Issue[];
};

const id = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const validWindow = (w: Window) =>
  Number.isFinite(Date.parse(w.from)) &&
  Number.isFinite(Date.parse(w.to)) &&
  Date.parse(w.to) > Date.parse(w.from);
const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const metric = (facts: Record<string, unknown>, name: string) => num(obj(facts[name])?.value);

type D11Counts = {
  workspace: string;
  bashCalls: number;
  bashErrors: number;
  psCalls: number;
  psErrors: number;
  preferred: string;
  higher: string;
};
/** Count reconciled calls independently of detector code and capped evidence IDs. */
export function countD11(db: Database.Database, window: Window): D11Counts[] {
  const rows = db
    .prepare(`SELECT s.workspace_id AS workspace, e.tool_name AS tool,
    COUNT(*) AS calls, SUM(CASE WHEN e.exit_class = 'ERROR' THEN 1 ELSE 0 END) AS errors
    FROM tool_events e JOIN sessions s ON s.session_id=e.session_id
    WHERE s.state='RECONCILED' AND e.ts>=? AND e.ts<? AND e.tool_name IN ('Bash','PowerShell')
    GROUP BY s.workspace_id,e.tool_name`)
    .all(window.from, window.to) as Array<{
    workspace: string;
    tool: string;
    calls: number;
    errors: number;
  }>;
  const byWorkspace = new Map<string, Map<string, { calls: number; errors: number }>>();
  for (const row of rows) {
    const tools = byWorkspace.get(row.workspace) ?? new Map();
    tools.set(row.tool, row);
    byWorkspace.set(row.workspace, tools);
  }
  const result: D11Counts[] = [];
  for (const [workspace, tools] of byWorkspace) {
    const b = tools.get("Bash");
    const p = tools.get("PowerShell");
    if (!b || !p || b.calls < 50 || p.calls < 50) continue;
    const br = b.errors / b.calls;
    const pr = p.errors / p.calls;
    const bashWorse = br >= pr;
    const high = bashWorse ? br : pr;
    const low = bashWorse ? pr : br;
    const highErrors = bashWorse ? b.errors : p.errors;
    if (highErrors < 3 || !(low === 0 ? high > 0 : high >= 1.5 * low)) continue;
    result.push({
      workspace,
      bashCalls: b.calls,
      bashErrors: b.errors,
      psCalls: p.calls,
      psErrors: p.errors,
      preferred: bashWorse ? "PowerShell" : "Bash",
      higher: bashWorse ? "Bash" : "PowerShell",
    });
  }
  return result;
}

type C5Counts = {
  workspace: string;
  session: string;
  loops: number;
  repeated: number;
  excess: number;
  tools: number;
  classes: number;
};
/** Normalize only in memory. Neither grouping keys nor raw text leave this function. */
export function countC5(db: Database.Database, window: Window): C5Counts[] {
  const rows = db
    .prepare(`SELECT s.workspace_id AS workspace,e.session_id AS session,
    e.tool_name AS tool,e.tool_error_class AS class,
    json_extract(c.content_json,'$.error') AS error_text
    FROM tool_events e JOIN sessions s ON s.session_id=e.session_id
    JOIN tool_event_metadata m ON m.event_id=e.event_id
    JOIN turns t ON t.message_id=m.owner_message_id AND t.session_id=e.session_id
    LEFT JOIN tool_event_content c ON c.event_id=e.event_id
    WHERE e.ts>=? AND e.ts<? AND s.state='RECONCILED' AND m.owner_message_id IS NOT NULL
      AND t.is_sidechain=0 AND t.provisional=0 AND e.exit_class='ERROR'
      AND e.tool_error_class IS NOT NULL AND e.tool_error_classifier_version='tool-error-1'`)
    .all(window.from, window.to) as Array<{
    workspace: string;
    session: string;
    tool: string;
    class: string;
    error_text: string | null;
  }>;
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const normalized = row.error_text?.trim().replace(/\s+/g, " ").toLowerCase() || row.class;
    const key = JSON.stringify([row.workspace, row.session, row.tool, normalized]);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const sessions = new Map<
    string,
    { workspace: string; session: string; groups: Array<typeof rows> }
  >();
  for (const group of grouped.values()) {
    if (group.length < 3) continue;
    const first = group[0];
    if (!first) continue;
    const key = JSON.stringify([first.workspace, first.session]);
    const entry = sessions.get(key) ?? {
      workspace: first.workspace,
      session: first.session,
      groups: [],
    };
    entry.groups.push(group);
    sessions.set(key, entry);
  }
  return [...sessions.values()].map(({ workspace, session, groups }) => ({
    workspace,
    session,
    loops: groups.length,
    repeated: groups.reduce((n, g) => n + g.length, 0),
    excess: groups.reduce((n, g) => n + g.length - 2, 0),
    tools: new Set(groups.flat().map((r) => r.tool)).size,
    classes: new Set(groups.flat().map((r) => r.class)).size,
  }));
}

/** All scopes in one anchored window are checked, including expected findings with no persisted row. */
export function checkFriction(db: Database.Database): FrictionReport {
  const issues: Issue[] = [];
  const checked = { D11: 0, C5: 0 };
  const historicalIssues: Issue[] = [];
  const historicalChecked = { D11: 0, C5: 0 };
  const latestKeys = new Set<string>();
  const windows: FrictionReport["windows"] = [];
  const recs = db
    .prepare(`SELECT detector_id,scope_workspace_id,evidence_json,contract_status
    FROM recommendations WHERE detector_id IN ('D11','C5') AND provenance='RULE'`)
    .all() as RecRow[];
  const marks = db
    .prepare("SELECT week_start,week_end,detector_ids FROM detector_week_marks")
    .all() as Array<{ week_start: string; week_end: string; detector_ids: string }>;
  const byWindow = new Map<string, Array<{ row: RecRow; payload: Record<string, unknown> }>>();
  for (const row of recs) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = obj(JSON.parse(row.evidence_json));
    } catch {
      /* handled below */
    }
    const embedded = obj(payload?.window);
    const recency = obj(payload?.recency);
    const anchor =
      row.detector_id === "D11" ? obj(payload?.facts)?.last_seen_week_start : embedded?.from;
    const markerId = row.detector_id === "D11" ? "D11@workspace-v2" : "C5";
    const mark = marks.find(
      (m) => m.week_start === anchor && m.detector_ids.split(",").includes(markerId),
    );
    const window =
      row.detector_id === "C5"
        ? { from: embedded?.from, to: embedded?.to }
        : { from: mark?.week_start, to: mark?.week_end };
    if (
      !payload ||
      typeof window.from !== "string" ||
      typeof window.to !== "string" ||
      !validWindow(window as Window) ||
      !mark ||
      mark.week_end !== window.to ||
      (row.detector_id === "C5" &&
        (mark.week_start !== window.from ||
          (recency?.last_seen_week_start !== undefined &&
            recency.last_seen_week_start !== window.from)))
    ) {
      historicalIssues.push({
        detector: row.detector_id,
        status: "UNPROVEN",
        code: "WINDOW_OR_MARK_MISSING",
        ...(row.scope_workspace_id ? { scope: id(row.scope_workspace_id) } : {}),
      });
      continue;
    }
    const key = JSON.stringify([row.detector_id, window.from, window.to]);
    const group = byWindow.get(key) ?? [];
    group.push({ row, payload });
    byWindow.set(key, group);
  }
  for (const detector of ["D11", "C5"] as const) {
    if (!recs.some((r) => r.detector_id === detector))
      issues.push({ detector, status: "UNPROVEN", code: "NO_PERSISTED_FINDINGS" });
    const markerId = detector === "D11" ? "D11@workspace-v2" : "C5";
    const latest = marks
      .filter((mark) => mark.detector_ids.split(",").includes(markerId))
      .sort((a, b) => b.week_start.localeCompare(a.week_start))[0];
    if (!latest || !validWindow({ from: latest.week_start, to: latest.week_end })) {
      issues.push({ detector, status: "UNPROVEN", code: "LATEST_MARK_MISSING" });
      continue;
    }
    // A previously persisted finding can anchor an older week. Evaluate the newest
    // marked week too, even when it has no recommendations to drive byWindow.
    const key = JSON.stringify([detector, latest.week_start, latest.week_end]);
    latestKeys.add(key);
    if (!byWindow.has(key)) byWindow.set(key, []);
  }
  for (const [key, group] of byWindow) {
    const [detector, from, to] = JSON.parse(key) as [DetectorId, string, string];
    const current = latestKeys.has(key);
    const windowIssues = current ? issues : historicalIssues;
    const window = { from, to };
    windows.push({ detector, ...window });
    const expected = detector === "D11" ? countD11(db, window) : countC5(db, window);
    const expectedByScope = new Map<string, D11Counts | C5Counts>();
    if (detector === "D11")
      for (const item of expected as D11Counts[]) expectedByScope.set(item.workspace, item);
    else
      for (const item of expected as C5Counts[])
        expectedByScope.set(JSON.stringify([item.workspace, item.session]), item);
    const seen = new Set<string>();
    for (const { row, payload } of group) {
      const facts = obj(row.detector_id === "D11" ? payload.facts : payload.metrics);
      const sessionIds = payload.session_ids;
      const scope =
        detector === "D11"
          ? (row.scope_workspace_id ?? "")
          : JSON.stringify([
              row.scope_workspace_id,
              Array.isArray(sessionIds) ? sessionIds[0] : null,
            ]);
      const safeScope = id(scope);
      if (seen.has(scope)) {
        windowIssues.push({ detector, status: "FAIL", code: "DUPLICATE_SCOPE", scope: safeScope });
        continue;
      }
      seen.add(scope);
      const item = expectedByScope.get(scope);
      if (
        !item ||
        !facts ||
        (detector === "D11" && row.contract_status !== "V1_VALIDATED") ||
        (detector === "C5" && row.contract_status !== "V2_VALIDATED")
      ) {
        windowIssues.push({
          detector,
          status: "FAIL",
          code: "FINDING_SCOPE_OR_CONTRACT_MISMATCH",
          scope: safeScope,
        });
        continue;
      }
      let match: boolean;
      if (detector === "D11") {
        const d = item as D11Counts;
        match =
          facts.bash_call_count === d.bashCalls &&
          facts.bash_error_count === d.bashErrors &&
          facts.powershell_call_count === d.psCalls &&
          facts.powershell_error_count === d.psErrors &&
          facts.bash_error_ratio === d.bashErrors / d.bashCalls &&
          facts.powershell_error_ratio === d.psErrors / d.psCalls &&
          facts.preferred_tool === d.preferred &&
          facts.higher_error_tool === d.higher;
      } else {
        const c = item as C5Counts;
        match =
          metric(facts, "ERROR_LOOP_COUNT") === c.loops &&
          metric(facts, "REPEATED_ERROR_COUNT") === c.repeated &&
          metric(facts, "LOOP_EXCESS_ERROR_COUNT") === c.excess &&
          metric(facts, "AFFECTED_TOOL_COUNT") === c.tools &&
          metric(facts, "AFFECTED_ERROR_CLASS_COUNT") === c.classes;
      }
      if (!match)
        windowIssues.push({
          detector,
          status: "FAIL",
          code: "FACT_COUNT_MISMATCH",
          scope: safeScope,
        });
      if (current) checked[detector]++;
      else historicalChecked[detector]++;
    }
    // Stable rec IDs retain only their newest firing. An older week may have
    // fired for a scope now anchored elsewhere; only the latest mark demands
    // complete persisted coverage.
    if (current)
      for (const scope of expectedByScope.keys())
        if (!seen.has(scope))
          issues.push({
            detector,
            status: "UNPROVEN",
            code: "EXPECTED_FINDING_MISSING",
            scope: id(scope),
          });
  }
  const status = [...issues, ...historicalIssues].some((i) => i.status === "FAIL")
    ? "FAIL"
    : issues.length || !checked.D11 || !checked.C5
      ? "UNPROVEN"
      : "PASS";
  return { status, checked, historicalChecked, windows, issues, historicalIssues };
}

export function runCli(argv: string[]): number {
  if (argv.length !== 2 || argv[0] !== "--db" || !argv[1]) return 2;
  const db = new Database(argv[1], { readonly: true, fileMustExist: true });
  try {
    const report = checkFriction(db);
    console.log(JSON.stringify(report, null, 2));
    return report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 3;
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch {
    console.error("friction oracle: database unavailable or invalid schema");
    process.exitCode = 1;
  }
}
