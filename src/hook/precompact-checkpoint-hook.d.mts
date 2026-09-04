/** Public, testable surface of the dependency-free PreCompact checkpoint hook. */

export function checkpointDir(): string;
export function snapshotName(sessionId: string, now: Date): string;
export function writeCheckpoint(
  transcriptPath: unknown,
  sessionId: string,
  dir: string,
  now?: Date,
): string | null;
export function enforceRetention(dir: string, maxCount?: number, maxBytes?: number): void;
