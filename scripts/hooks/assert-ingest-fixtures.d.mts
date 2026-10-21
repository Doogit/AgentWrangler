export function manifestViolations(
  entries: Array<{ sha: string; file: string }>,
  manifest: Record<string, string>,
): string[];
export function committedFixtureEntries(root: string): Array<{ sha: string; file: string }>;
export function ingestFixtureViolations(root: string): string[];
