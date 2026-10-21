const MIN_RUN = 3;
const MIN_TRIGRAM_REPEATS = 3;
/**
 * Max wall-clock gap (seconds) between two consecutive members of a same-tool
 * ERROR run. The canonical sequence is enrichment-filtered, so unenriched events
 * dropped between two same-tool ERRORs could otherwise fabricate a false
 * "consecutive" run; a timestamp ceiling breaks such fabricated adjacency.
 * 120s clears the largest genuine retry gap observed in the live 7d slice (~71s).
 */
const MAX_RUN_GAP_SEC = 120;

export interface D7LoopEvent {
  event_id: string;
  /** ISO timestamp; bounds ERROR runs by MAX_RUN_GAP_SEC against fabricated adjacency. */
  ts: string;
  tool_name: string;
  input_hash: string | null;
  exit_class: string | null;
  file_path_hash: string | null;
  /**
   * The result size. A read of the same region that returns a different size got new content (the
   * file changed, e.g. a test run rewrote it), so it starts a new read group (re-review N2).
   * Absent = unknown: reads are grouped by path and region only.
   */
  result_bytes?: number | null;
  /** False keeps the event as a sequence boundary without making it eligible evidence. */
  eligible?: boolean;
  /** Matching writes invalidate scoped read state even when the tool itself is excluded. */
  source_matching_write?: boolean;
  /**
   * The context the call ran in: a subagent's agent id, or null/absent for the main thread. A
   * repeat counts only inside one context (review 6 R6-10).
   */
  context?: string | null;
  /**
   * The assistant message that issued the call. Calls in one message ran before any result was
   * seen, so for signals 1 and 5 they count once (F14). Absent = each call counts.
   */
  owner_message_id?: string | null;
}

export interface D7LoopAnalysis {
  identicalCalls: Set<string>;
  testFails: Set<string>;
  redundantReads: Set<string>;
  threeGramLoops: Set<string>;
  errorRuns: Set<string>;
  editWithoutRead: Set<string>;
  repeatExcessEventIds: Set<string>;
  flaggedEventIds: Set<string>;
}

function isEligible(row: D7LoopEvent): boolean {
  return row.eligible !== false;
}

function identicalCallKey(row: D7LoopEvent | undefined): string | null {
  if (row === undefined || !isEligible(row) || row.input_hash === null) return null;
  const key = `${row.tool_name.length}:${row.tool_name}${row.input_hash}`;
  // N2: a Read that returns a different size got new content, so it is not the same call. Other
  // tools keep the input-only key: a failing retry's output often differs a little.
  return row.tool_name.toLowerCase() === "read" && row.result_bytes != null
    ? `${key}#${row.result_bytes}`
    : key;
}

function sameMessage(a: D7LoopEvent | undefined, b: D7LoopEvent): boolean {
  return a?.owner_message_id != null && a.owner_message_id === b.owner_message_id;
}

/** Run length with same-message neighbours counted once (F14). */
function messageCount(run: D7LoopEvent[]): number {
  return run.filter((row, i) => !sameMessage(run[i - 1], row)).length;
}

/** Marks a qualifying run; the first message's calls are not excess, every later one is. */
function markRun(
  run: D7LoopEvent[],
  onePerMessage: boolean,
  target: Set<string>,
  excessTarget: Set<string>,
): void {
  if ((onePerMessage ? messageCount(run) : run.length) < MIN_RUN) return;
  for (const row of run) target.add(row.event_id);
  const firstExcess = onePerMessage
    ? run.findIndex((row, i) => i > 0 && !sameMessage(run[i - 1], row))
    : 1;
  for (const row of run.slice(firstExcess)) excessTarget.add(row.event_id);
}

function markRuns(
  rows: D7LoopEvent[],
  keyFor: (row: D7LoopEvent) => string | null,
  target: Set<string>,
  excessTarget: Set<string>,
  onePerMessage = false,
): void {
  let run: D7LoopEvent[] = [];
  let runKey: string | null = null;
  const flush = (): void => {
    markRun(run, onePerMessage, target, excessTarget);
    run = [];
    runKey = null;
  };
  for (const row of rows) {
    const key = keyFor(row);
    if (key !== null && key === runKey) run.push(row);
    else {
      flush();
      if (key !== null) {
        run = [row];
        runKey = key;
      }
    }
  }
  flush();
}

/**
 * Flags runs of >= MIN_RUN consecutive same-tool ERROR events (signal c; subsumes
 * browser-timeout loops). Keys by tool_name (Option B) so unrelated tools' errors
 * never conflate. A non-eligible or non-ERROR event, a tool change, a changed
 * input_hash (the detector stores the call's error text there when it has it, so a
 * different value means a different call or a different error: not a retry), or a gap
 * beyond MAX_RUN_GAP_SEC ends the current run (the gap guard defeats adjacency
 * fabricated by dropped unenriched events).
 */
function markErrorRuns(rows: D7LoopEvent[], target: Set<string>, excessTarget: Set<string>): void {
  let run: D7LoopEvent[] = [];
  const flush = (): void => {
    markRun(run, true, target, excessTarget);
    run = [];
  };
  for (const row of rows) {
    if (!isEligible(row) || row.exit_class !== "ERROR") {
      flush();
      continue;
    }
    const previous = run.at(-1);
    const gapSec =
      previous === undefined ? 0 : (Date.parse(row.ts) - Date.parse(previous.ts)) / 1000;
    if (
      previous === undefined ||
      row.tool_name !== previous.tool_name ||
      row.input_hash !== previous.input_hash ||
      Number.isNaN(gapSec) ||
      gapSec > MAX_RUN_GAP_SEC
    ) {
      flush();
      run = [row];
    } else {
      run.push(row);
    }
  }
  flush();
}

/**
 * Flags an eligible Edit whose file_path_hash had no preceding in-session Read
 * (signal g). Edit-only by design: the harness requires Read-before-Edit, while
 * Write legitimately creates new files (95% of live Writes have no prior Read),
 * so scoping Write in would be almost all false positives. The session-level
 * coverage floor (applied at the detector) guards against a dropped establishing
 * Read fabricating a false miss.
 */
function markEditWithoutPriorRead(rows: D7LoopEvent[], target: Set<string>): void {
  const readPaths = new Set<string>();
  for (const row of rows) {
    if (!isEligible(row) || row.file_path_hash === null) continue;
    const tool = row.tool_name.toLowerCase();
    if (tool === "read") readPaths.add(row.file_path_hash);
    else if (tool === "edit" && !readPaths.has(row.file_path_hash)) target.add(row.event_id);
  }
}

function markRedundantReads(
  rows: D7LoopEvent[],
  target: Set<string>,
  excessTarget: Set<string>,
): void {
  const readsSinceWrite = new Map<string, Map<string, D7LoopEvent[]>>();
  const markIfQualifying = (reads: D7LoopEvent[] | undefined): void => {
    if (reads && reads.length >= MIN_RUN) {
      for (const row of reads) target.add(row.event_id);
      for (const row of reads.slice(1)) excessTarget.add(row.event_id);
    }
  };
  const flushPath = (pathIdentity: string): void => {
    const regions = readsSinceWrite.get(pathIdentity);
    if (regions !== undefined) for (const reads of regions.values()) markIfQualifying(reads);
    readsSinceWrite.delete(pathIdentity);
  };
  for (const row of rows) {
    const pathIdentity = row.file_path_hash;
    const tool = row.tool_name.toLowerCase();
    if (
      (tool === "edit" || tool === "write") &&
      (isEligible(row) || row.source_matching_write === true)
    ) {
      if (pathIdentity !== null) flushPath(pathIdentity);
      continue;
    }
    // Scope exclusions are hard sequence boundaries. In particular, an
    // excluded tool call must not let same-path reads on either side join.
    if (!isEligible(row)) {
      for (const regions of readsSinceWrite.values())
        for (const reads of regions.values()) markIfQualifying(reads);
      readsSinceWrite.clear();
      continue;
    }
    if (pathIdentity === null) continue;
    if (tool !== "read" || row.input_hash === null) continue;
    const regions = readsSinceWrite.get(pathIdentity) ?? new Map<string, D7LoopEvent[]>();
    let reads = regions.get(row.input_hash) ?? [];
    const last = reads.at(-1)?.result_bytes;
    if (last !== undefined && row.result_bytes !== undefined && last !== row.result_bytes) {
      markIfQualifying(reads);
      reads = [];
    }
    reads.push(row);
    regions.set(row.input_hash, reads);
    readsSinceWrite.set(pathIdentity, regions);
  }
  for (const regions of readsSinceWrite.values())
    for (const reads of regions.values()) markIfQualifying(reads);
}

function markThreeGramLoops(
  rows: D7LoopEvent[],
  target: Set<string>,
  excessTarget: Set<string>,
): void {
  const tripleLength = 3;
  const minimumRunLength = tripleLength * MIN_TRIGRAM_REPEATS;
  for (let start = 0; start <= rows.length - minimumRunLength; ) {
    const first = identicalCallKey(rows[start]);
    const second = identicalCallKey(rows[start + 1]);
    const third = identicalCallKey(rows[start + 2]);
    if (
      first === null ||
      second === null ||
      third === null ||
      (first === second && second === third)
    ) {
      start += 1;
      continue;
    }
    let end = start + tripleLength;
    while (
      end + tripleLength <= rows.length &&
      identicalCallKey(rows[end]) === first &&
      identicalCallKey(rows[end + 1]) === second &&
      identicalCallKey(rows[end + 2]) === third
    )
      end += tripleLength;
    if (end - start < minimumRunLength) {
      start += 1;
      continue;
    }
    for (const row of rows.slice(start, end)) target.add(row.event_id);
    for (const row of rows.slice(start + tripleLength, end)) excessTarget.add(row.event_id);
    start = end;
  }
}

/**
 * An event C3 owns (U7 D7): an Edit that failed because the file was not read first (C3's own
 * candidate predicate). The loop card leaves it out, so C3 and D7 never price the same turn.
 * C5's same-error loops are NOT left out: C5 carries no $ (operator MED-3, 2026-09-22), so D7 stays
 * the one owner of their loop economics.
 */
export function isClaimedByC3(event: {
  tool_name: string;
  tool_error_class: string | null;
  tool_error_classifier_version: string | null;
}): boolean {
  return (
    event.tool_name === "Edit" &&
    event.tool_error_class === "NOT_READ" &&
    event.tool_error_classifier_version === "tool-error-1"
  );
}

/** Options for {@link analyzeD7LoopEvents}. */
export interface AnalyzeD7Options {
  /**
   * Include the coverage-gated friction signals (same-tool ERROR runs and
   * Edit-without-prior-Read). Off by default so callers that lack a per-session
   * owner-turn-metadata coverage number (e.g. scoped ESF observers) keep their
   * original four-signal semantics. The D7 detector enables it only for sessions
   * that meet the coverage floor, since a dropped unenriched event can otherwise
   * fabricate a false ERROR-run adjacency or a false missing-Read.
   */
  includeFrictionSignals?: boolean;
}

/** Shared pure structural matcher. Input order is the detector's canonical session order. */
export function analyzeD7LoopEvents(
  rows: D7LoopEvent[],
  opts: AnalyzeD7Options = {},
): D7LoopAnalysis {
  const includeFriction = opts.includeFrictionSignals ?? false;
  const identicalCalls = new Set<string>();
  const testFails = new Set<string>();
  const redundantReads = new Set<string>();
  const threeGramLoops = new Set<string>();
  const errorRuns = new Set<string>();
  const editWithoutRead = new Set<string>();
  const repeatExcessEventIds = new Set<string>();
  const byContext = new Map<string, D7LoopEvent[]>();
  for (const row of rows) {
    const list = byContext.get(row.context ?? "");
    if (list === undefined) byContext.set(row.context ?? "", [row]);
    else list.push(row);
  }
  for (const contextRows of byContext.values()) {
    markRuns(contextRows, identicalCallKey, identicalCalls, repeatExcessEventIds, true);
    markRuns(
      contextRows,
      (row) => (isEligible(row) && row.exit_class === "TEST_FAIL" ? "TEST_FAIL" : null),
      testFails,
      repeatExcessEventIds,
    );
    markRedundantReads(contextRows, redundantReads, repeatExcessEventIds);
    markThreeGramLoops(contextRows, threeGramLoops, repeatExcessEventIds);
    if (includeFriction) {
      markErrorRuns(contextRows, errorRuns, repeatExcessEventIds);
      markEditWithoutPriorRead(contextRows, editWithoutRead);
    }
  }
  return {
    identicalCalls,
    testFails,
    redundantReads,
    threeGramLoops,
    errorRuns,
    editWithoutRead,
    repeatExcessEventIds,
    // An edit without a prior read means "never read in this session", not a repeat, so it is
    // reported but flags no loop turn (review 2 D7a1).
    flaggedEventIds: new Set([
      ...identicalCalls,
      ...testFails,
      ...redundantReads,
      ...threeGramLoops,
      ...errorRuns,
    ]),
  };
}
