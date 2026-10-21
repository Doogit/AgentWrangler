/**
 * DH2 probe for C7 BASH_FAILURE_CLUSTER_V2 (contract card C7).
 * Per workspace: >= 3 failed Bash calls in one reconciled session, main chain, settled turns,
 * sharing a signature (exit code + first non-empty output line, masked, 80 chars). RC-B removed
 * the 0.1% spend floor; the recs view's de-minimis floor handles small clusters.
 *
 * No classifier columns: a failed call = stored raw error text beginning "Exit code N". The
 * "command-family label present" check is approximated as "command text stored". Benign and
 * denial exclusions reuse C5's text re-derivation.
 */

import type Database from "better-sqlite3";
import { isExcluded, loadErrCalls } from "./C5.js";
import type { Probe, ProbeResult } from "./types.js";

const C7_MIN_FAILURES = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Exit code + first non-empty line after the "Exit code N" header, masked, lower-cased, 80 chars. */
function signature(error: string): string | null {
  const lines = error.split(/\r?\n/);
  const m = /^Exit code (\d+)/.exec(lines[0] ?? "");
  if (!m) return null;
  const first = (lines.slice(1).find((l) => l.trim() !== "") ?? "").trim();
  const masked = first
    .toLowerCase()
    .replace(ANSI_RE, "")
    .replace(/(?:[a-z]:)?[\w.~-]*[\\/][\w.\\/~-]*/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .slice(0, 80);
  return `${m[1]}|${masked}`;
}

export const probeC7: Probe = (db: Database.Database, now: Date): ProbeResult => {
  const to = now.toISOString();
  const from = new Date(now.getTime() - WEEK_MS).toISOString();
  const bash = loadErrCalls(db, from, to).filter(
    (c) => c.tool_name === "Bash" && /^Exit code \d+/.test(c.error),
  );

  const clusterCount = (calls: typeof bash): Map<string, typeof bash> => {
    const m = new Map<string, typeof bash>();
    for (const c of calls) {
      const sig = signature(c.error);
      if (sig === null) continue;
      const key = `${c.workspace_id}\u0000${c.session_id}\u0000${sig}`;
      m.set(key, [...(m.get(key) ?? []), c]);
    }
    return m;
  };

  // Relaxed: no chain/state/exclusion filter, >= 2 failures per signature.
  const candidateWs = new Set<string>();
  for (const [key, calls] of clusterCount(bash)) {
    if (calls.length >= 2) candidateWs.add(key.split("\u0000")[0] ?? "");
  }

  const exactCalls = bash.filter(
    (c) =>
      c.session_reconciled &&
      c.owner_main &&
      c.owner_settled &&
      c.command !== null &&
      c.command.trim() !== "" &&
      !isExcluded(c),
  );
  const wsCalls = new Map<string, typeof bash>(); // workspace -> failures in qualifying clusters
  let bestCount = 0;
  for (const [key, calls] of clusterCount(exactCalls)) {
    bestCount = Math.max(bestCount, calls.length);
    if (calls.length < C7_MIN_FAILURES) continue;
    const ws = key.split("\u0000")[0] ?? "";
    wsCalls.set(ws, [...(wsCalls.get(ws) ?? []), ...calls]);
  }

  return {
    candidates: candidateWs.size,
    qualifying: wsCalls.size,
    gates: [
      {
        name: "C7_MIN_FAILURES",
        value: bestCount,
        threshold: C7_MIN_FAILURES,
        op: ">=",
        pass: bestCount >= C7_MIN_FAILURES,
      },
    ],
    note: "Workspaces with >= 3 failed Bash calls ('Exit code N' error text) sharing a masked signature in one reconciled main-chain session (no spend floor since RC-B). Candidates = workspaces with any signature repeated >= 2 before chain/benign filters. Family label approximated by 'command text present'; D7 turn ownership not modelled.",
  };
};
