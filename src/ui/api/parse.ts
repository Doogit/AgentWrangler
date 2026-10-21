/**
 * src/ui/api/parse.ts — P1-U1 tolerant contract boundary.
 *
 * `safeSection` validates one page section before render. A malformed section
 * becomes `{ok: false}` so only that card degrades; it never throws. Each
 * section logs once per page life with the stable `[aw:section]` prefix.
 */

import type * as z from "zod/mini";

export type SectionResult<T> = { ok: true; data: T } | { ok: false; issue: string };

const logged = new Set<string>();

export function safeSection<S extends z.ZodMiniType>(
  section: string,
  schema: S,
  raw: unknown,
): SectionResult<z.output<S>> {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const first = result.error.issues[0];
  const issue =
    first === undefined
      ? "invalid section"
      : `${first.path.length > 0 ? first.path.join(".") : "(root)"}: ${first.message}`;
  if (!logged.has(section)) {
    logged.add(section);
    console.warn(`[aw:section] ${section}: ${issue}`);
  }
  return { ok: false, issue };
}

/** Test seam: forget which sections have logged. */
export function resetSectionLog(): void {
  logged.clear();
}
