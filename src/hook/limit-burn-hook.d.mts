/** Public, testable surface of the dependency-free hook executable. */
export function stageFromStatus(status: unknown): "checkpoint" | "soft" | null;
export function stageToStdout(stage: unknown): string;
