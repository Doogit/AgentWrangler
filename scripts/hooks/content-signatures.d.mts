export const TRANSCRIPT_LINE_MIN: number;
export const OVERSIZED_LINE: number;
export const ENTROPY_RUN: number;
export function isExampleOrFixturePath(relPath: string): boolean;
export function decodeText(buf: Buffer): string | null;
export function lineReasons(line: string, relPath?: string | null): string[];
export function rawContentReasons(
  text: string,
  relPath?: string | null,
): Array<{ line: number; reason: string }>;
export function scanDirectory(
  dir: string,
): Array<{ file: string; line: number; reason: string }>;
