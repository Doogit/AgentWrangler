/**
 * src/daemon/data-version.ts — the in-memory `data_version` counter (perf plan §3.2, P1-U0).
 *
 * Not `PRAGMA data_version`: the pragma does not move for a connection's own writes, and
 * main-thread ingest writes on the connection the router reads. Bumped at ingest commits,
 * walk completion and lifecycle (non-GET API) writes. Snapshot workers open the DB read-only,
 * so snapshot completion changes nothing a `direct` route reads and does not bump it.
 * Writes from other processes are not seen; the GET memo's minute bucket bounds that staleness.
 *
 * P2-U2 (poll-first, D6): a bump may name a scope, which also moves that scope's counter.
 * `/api/status` serves the scopes so a polling client refetches only what changed (review M4):
 *   live      ingest chunk commits and reconciles (the live and status sections)
 *   ingest    a completed slice, metric baseline seeding, probe and outcomes writes
 *   detectors a detector walk completion
 *   lifecycle a non-GET API write
 * `clock` is not a counter: it is the local and UTC day, so a day boundary is visible.
 */

export type DataScope = "live" | "ingest" | "detectors" | "lifecycle";

export interface DataScopes {
  live: number;
  ingest: number;
  detectors: number;
  lifecycle: number;
  /** `<local YYYY-MM-DD>|<UTC YYYY-MM-DD>` */
  clock: string;
}

let version = 0;
const scopes: Record<DataScope, number> = { live: 0, ingest: 0, detectors: 0, lifecycle: 0 };

export function getDataVersion(): number {
  return version;
}

export function bumpDataVersion(scope?: DataScope): void {
  version++;
  if (scope !== undefined) scopes[scope]++;
}

function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function getDataScopes(now: Date = new Date()): DataScopes {
  return { ...scopes, clock: `${localDay(now)}|${now.toISOString().slice(0, 10)}` };
}
