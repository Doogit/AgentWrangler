/** Return a privacy-preserving, recognizable identifier label. */
export function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}
