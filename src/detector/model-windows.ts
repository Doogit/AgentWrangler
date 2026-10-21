/**
 * src/detector/model-windows.ts — context window size for a model id (JMS U12).
 *
 * What the data shows: transcripts record only the base model id (e.g. `claude-opus-4-8`,
 * `claude-sonnet-5-5`) and never the window variant, so a `[1m]` / `-1m` marker is not seen in
 * ingested turns. The marker check is kept for ids that do carry one. The working signal is
 * observed usage: a 200k window cannot hold a turn above 200k, so any model with such a turn is
 * provably a 1M-window variant. A 1M model that never went past 200k reads as 200k (the
 * conservative choice: it can only make a long session look MORE degraded, never hide one).
 *
 * SEC-101: model ids and token counts only.
 */

export const STANDARD_WINDOW = 200_000;
export const LARGE_WINDOW = 1_000_000;

const LARGE_MARKER = /(\[1m\]|-1m\b)/i;

/** Window in tokens for `model`, given the largest context any turn on that model reached. */
export function contextWindowFor(model: string, observedMaxContext?: number | null): number {
  if (LARGE_MARKER.test(model)) return LARGE_WINDOW;
  if ((observedMaxContext ?? 0) > STANDARD_WINDOW) return LARGE_WINDOW;
  return STANDARD_WINDOW;
}
