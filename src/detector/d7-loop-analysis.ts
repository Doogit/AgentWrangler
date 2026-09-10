const MIN_RUN = 3;
const MIN_TRIGRAM_REPEATS = 3;

export interface D7LoopEvent {
  event_id: string;
  tool_name: string;
  input_hash: string | null;
  exit_class: string | null;
  file_path_hash: string | null;
  /** False keeps the event as a sequence boundary without making it eligible evidence. */
  eligible?: boolean;
  /** Matching writes invalidate scoped read state even when the tool itself is excluded. */
  source_matching_write?: boolean;
}

export interface D7LoopAnalysis {
  identicalCalls: Set<string>;
  testFails: Set<string>;
  redundantReads: Set<string>;
  threeGramLoops: Set<string>;
  repeatExcessEventIds: Set<string>;
  flaggedEventIds: Set<string>;
}

function isEligible(row: D7LoopEvent): boolean {
  return row.eligible !== false;
}

function identicalCallKey(row: D7LoopEvent | undefined): string | null {
  return row === undefined || !isEligible(row) || row.input_hash === null
    ? null
    : `${row.tool_name.length}:${row.tool_name}${row.input_hash}`;
}

function markRuns(
  rows: D7LoopEvent[],
  keyFor: (row: D7LoopEvent) => string | null,
  target: Set<string>,
  excessTarget: Set<string>,
): void {
  let run: D7LoopEvent[] = [];
  let runKey: string | null = null;
  const flush = (): void => {
    if (run.length >= MIN_RUN) {
      for (const row of run) target.add(row.event_id);
      for (const row of run.slice(1)) excessTarget.add(row.event_id);
    }
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
    const reads = regions.get(row.input_hash) ?? [];
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

/** Shared pure structural matcher. Input order is the detector's canonical session order. */
export function analyzeD7LoopEvents(rows: D7LoopEvent[]): D7LoopAnalysis {
  const identicalCalls = new Set<string>();
  const testFails = new Set<string>();
  const redundantReads = new Set<string>();
  const threeGramLoops = new Set<string>();
  const repeatExcessEventIds = new Set<string>();
  markRuns(rows, identicalCallKey, identicalCalls, repeatExcessEventIds);
  markRuns(
    rows,
    (row) => (isEligible(row) && row.exit_class === "TEST_FAIL" ? "TEST_FAIL" : null),
    testFails,
    repeatExcessEventIds,
  );
  markRedundantReads(rows, redundantReads, repeatExcessEventIds);
  markThreeGramLoops(rows, threeGramLoops, repeatExcessEventIds);
  return {
    identicalCalls,
    testFails,
    redundantReads,
    threeGramLoops,
    repeatExcessEventIds,
    flaggedEventIds: new Set([
      ...identicalCalls,
      ...testFails,
      ...redundantReads,
      ...threeGramLoops,
    ]),
  };
}
