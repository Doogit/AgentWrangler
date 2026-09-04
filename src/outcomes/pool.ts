/**
 * src/outcomes/pool.ts — bounded-concurrency async map helper.
 *
 * Runs `fn` over `items` with at most `concurrency` promises in flight.
 * Results are returned in input order. The only Promise.all is over the fixed
 * set of worker loops — never over the (unbounded) item list.
 */
export const DEFAULT_CONCURRENCY = 4;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await fn(items[index] as T, index);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}
