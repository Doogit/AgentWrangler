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
  command?: unknown;
  subtype?: "local_command" | "away_summary";
}): Record<string, unknown> {
  const record: Record<string, unknown> = {
    type: "system",
    subtype: o.subtype ?? "local_command",
    timestamp: o.ts,
    sessionId: o.session,
  };
  if (o.command !== undefined) record.command = o.command;
  return record;
}

/** A bare user slash-command record; only exact marker content is eligible. */
export function userCommand(o: { session: string; ts: string; content: unknown }): Record<
  string,
  unknown
> {
  return {
    type: "user",
    timestamp: o.ts,
    sessionId: o.session,
    message: { content: o.content },
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

/** Small deterministic PRNG (mulberry32) so a seed reproduces a corpus/split plan exactly. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Multibyte filler (2-, 3- and 4-byte UTF-8 sequences) for split-inside-a-character coverage. */
export const SYNTH_MULTIBYTE = "héllo — 日本語 \u{1f642} ✓";

export interface GeneratedCorpusOptions {
  /** Project slugs (one directory each). */
  slugs?: number;
  /** Session files per slug. */
  filesPerSlug?: number;
  /** Assistant turns per file. */
  turnsPerFile?: number;
}

/**
 * R-3 generator: a deterministic (per seed) synthetic corpus in `writeCorpus`
 * shape. Every file starts with multibyte content, carries tool_use/tool_result
 * pairs, typed prompts, sidechain turns, one compaction command and one
 * malformed (quarantined) line. Timestamps ascend inside July 2026. Synthetic
 * only (SEC-101).
 */
export function generateCorpus(
  seed: number,
  opts: GeneratedCorpusOptions = {},
): Record<string, Record<string, Line[]>> {
  const rnd = seededRandom(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const slugs = opts.slugs ?? 2;
  const filesPerSlug = opts.filesPerSlug ?? 2;
  const turnsPerFile = opts.turnsPerFile ?? 20;
  const base = Date.UTC(2026, 6, 10, 9, 0, 0);
  const corpus: Record<string, Record<string, Line[]>> = {};
  for (let s = 0; s < slugs; s++) {
    const slug = `proj-gen-${s}`;
    const files: Record<string, Line[]> = {};
    for (let f = 0; f < filesPerSlug; f++) {
      const session = `gen-${seed}-${s}-${f}`;
      let t = base + (s * filesPerSlug + f) * 3 * 3_600_000;
      const ts = () => {
        t += int(20, 200) * 1000;
        return new Date(t).toISOString();
      };
      const lines: Line[] = [];
      for (let i = 0; i < turnsPerFile; i++) {
        if (i % 3 === 0) lines.push(userPrompt({ session, ts: ts() }));
        const toolId = `toolu_${session}_${i}`;
        const withTool = i === 0 || rnd() < 0.6;
        const name = ["Bash", "Read", "Edit"][int(0, 2)] ?? "Bash";
        lines.push(
          assistant({
            id: `msg_${session}_${i}`,
            session,
            ts: ts(),
            input: int(1, 900),
            output: int(1, 700),
            cacheRead: int(0, 40_000),
            cw5m: int(0, 3_000),
            cw1h: int(0, 500),
            sidechain: rnd() < 0.15,
            extra: { synthNote: `${SYNTH_MULTIBYTE} #${i}` },
            ...(withTool
              ? {
                  toolUses: [
                    {
                      id: toolId,
                      name,
                      ...(name === "Bash" ? { command: `echo ${SYNTH_MULTIBYTE}` } : {}),
                    },
                  ],
                }
              : {}),
          }),
        );
        if (withTool) {
          lines.push(
            userToolResult({
              session,
              ts: ts(),
              results: [
                { toolUseId: toolId, text: `${SYNTH_MULTIBYTE} ok`, isError: rnd() < 0.15 },
              ],
            }),
          );
        }
        if (i === Math.floor(turnsPerFile / 2)) {
          lines.push(systemCommand({ session, ts: ts(), command: "/compact" }));
          lines.push({ raw: `{"type":"assistant","truncated ${SYNTH_MULTIBYTE}` });
        }
      }
      files[`${session}.jsonl`] = lines;
    }
    corpus[slug] = files;
  }
  return corpus;
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
