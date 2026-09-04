/**
 * test/ingest/synth.ts — synthetic transcript builders for the ingestion suite.
 *
 * SEC-101 / spike convention: NO real transcript content. Every field here is
 * fabricated (zeroed or nonsense tokens, fake ids). These builders write
 * `<root>/<slug>/<session>.jsonl` corpora matching the discovery layout.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface AssistantOpts {
  id: string;
  session: string;
  ts: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cw5m?: number;
  cw1h?: number;
  cwTotal?: number;
  sidechain?: boolean;
  effort?: string;
  toolUses?: Array<{ id: string; name: string; command?: string; input?: unknown }>;
  extra?: Record<string, unknown>;
}

/** An assistant usage record (a "turn"). */
export function assistant(o: AssistantOpts): Record<string, unknown> {
  const cw5m = o.cw5m ?? 0;
  const cw1h = o.cw1h ?? 0;
  const cwTotal = o.cwTotal ?? cw5m + cw1h;
  const usage: Record<string, unknown> = {
    input_tokens: o.input ?? 0,
    output_tokens: o.output ?? 0,
    cache_read_input_tokens: o.cacheRead ?? 0,
    cache_creation_input_tokens: cwTotal,
  };
  if (cw5m > 0 || cw1h > 0) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: cw5m,
      ephemeral_1h_input_tokens: cw1h,
    };
  }
  const message: Record<string, unknown> = {
    id: o.id,
    model: o.model ?? "claude-sonnet-4-6",
    usage,
  };
  if (o.effort !== undefined) message.effort = o.effort;
  if (o.toolUses !== undefined) {
    message.content = o.toolUses.map((t) => ({
      type: "tool_use",
      id: t.id,
      name: t.name,
      input: t.input ?? (t.command !== undefined ? { command: t.command } : {}),
    }));
  }
  const rec: Record<string, unknown> = {
    type: "assistant",
    timestamp: o.ts,
    sessionId: o.session,
    message,
  };
  if (o.sidechain) rec.isSidechain = true;
  if (o.extra) Object.assign(rec, o.extra);
  return rec;
}

/** A user record carrying tool_result blocks. */
export function userToolResult(o: {
  session: string;
  ts: string;
  results: Array<{ toolUseId: string; text: string; isError?: boolean }>;
}): Record<string, unknown> {
  return {
    type: "user",
    timestamp: o.ts,
    sessionId: o.session,
    message: {
      content: o.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolUseId,
        content: r.text,
        ...(r.isError === undefined ? {} : { is_error: r.isError }),
      })),
    },
  };
}

/** A system local_command record (e.g. /compact, /clear). */
export function systemCommand(o: {
  session: string;
  ts: string;
  command: string;
}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "local_command",
    timestamp: o.ts,
    sessionId: o.session,
    command: o.command,
  };
}

/** A synthetic/empty-model record (excluded from cost). */
export function synthetic(o: { session: string; ts: string }): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp: o.ts,
    sessionId: o.session,
    message: {
      id: `syn-${o.ts}`,
      model: "<synthetic>",
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

/** A typed user-prompt record (projects isUserTurn=true). */
export function userPrompt(o: {
  session: string;
  ts: string;
  promptSource?: string;
}): Record<string, unknown> {
  return {
    type: "user",
    timestamp: o.ts,
    sessionId: o.session,
    promptSource: o.promptSource ?? "typed",
    message: { role: "user", content: "SYNTH_USER_CONTENT_DO_NOT_STORE" },
  };
}

export type Line = Record<string, unknown> | { raw: string };

/** Serialise a list of records/raw lines to JSONL text (trailing newline). */
export function toJsonl(lines: Line[]): string {
  return `${lines.map((l) => ("raw" in l ? l.raw : JSON.stringify(l))).join("\n")}\n`;
}

/** Write a corpus `{ slug: lines }` under `root`, creating the dir tree. */
export function writeCorpus(root: string, corpus: Record<string, Record<string, Line[]>>): void {
  for (const [slug, files] of Object.entries(corpus)) {
    const dir = path.join(root, slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, lines] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), toJsonl(lines), "utf8");
    }
  }
}
