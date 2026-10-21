/**
 * scripts/benchmark/backfill-corpus.mts — R-3 corpus generator (P2-U1, D11).
 *
 * Writes a synthetic JSONL corpus shaped by the committed aggregates in
 * `distributions.json`: file sizes (census p50/p99 shape, scaled to a byte
 * target), bytes per line, tool mix, line-type mix, session duration and
 * subagent nesting. File mtimes spread over `weeks` (file i → week i % weeks);
 * each file's newest turn sits 1–30 s before its mtime, so the corpus matches
 * D4's assumption. Adversarial cases that break it are hand-written in tests.
 *
 * Deterministic per (seed, spec). Every string is fabricated (SEC-101).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GENERATOR_VERSION = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const Z99 = 2.326;

interface Quantiles {
  p10: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface Distributions {
  fileBytes: Quantiles;
  sessionDurationMin: Quantiles;
  bytesPerLine: Quantiles;
  nestingDepthShare: Record<string, number>;
  toolUsesPerTurn: number;
  toolMix: Record<string, number>;
  lineTypeShare: Record<string, number>;
  datasets: Record<string, DatasetSpec & { note?: string }>;
}

export interface DatasetSpec {
  seed: number;
  files: number;
  totalBytes: number;
  weeks: number;
  /** One file of exactly about this size (S5's ≥ 200 MB file). */
  bigFileBytes?: number;
}

export interface CorpusFileFacts {
  rel: string;
  bytes: number;
  mtimeMs: number;
  newestTurnMs: number;
  turns: number;
}

export interface CorpusManifest {
  generator: number;
  files: number;
  totalBytes: number;
  /** sha1 over every file's relative path and bytes, in generation order. */
  digest: string;
  perFile: CorpusFileFacts[];
  toolCounts: Record<string, number>;
}

export function loadDistributions(): Distributions {
  return JSON.parse(
    fs.readFileSync(path.join(HERE, "distributions.json"), "utf8"),
  ) as Distributions;
}

/** mulberry32, same as test/ingest/synth.ts seededRandom. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A lognormal draw through the census p50 and p99. */
function lognormal(rnd: () => number, q: Quantiles): number {
  const mu = Math.log(Math.max(1, q.p50));
  const sigma = (Math.log(Math.max(2, q.p99)) - mu) / Z99;
  const u = Math.max(1e-12, rnd());
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  return Math.exp(mu + sigma * z);
}

function pick(rnd: () => number, shares: Record<string, number>): string {
  const entries = Object.entries(shares);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let x = rnd() * total;
  for (const [k, v] of entries) {
    x -= v;
    if (x <= 0) return k;
  }
  return (entries.at(-1) as [string, number])[0];
}

/** File byte targets: census shape, scaled to the dataset total, capped at the census max. */
function fileTargets(rnd: () => number, spec: DatasetSpec, dist: Distributions): number[] {
  const big = spec.bigFileBytes;
  const n = big === undefined ? spec.files : spec.files - 1;
  const target = big === undefined ? spec.totalBytes : spec.totalBytes - big;
  const raw = Array.from({ length: n }, () => lognormal(rnd, dist.fileBytes));
  const lo = 4_096;
  const hi = dist.fileBytes.max;
  let sizes = raw;
  for (let i = 0; i < 8; i++) {
    const free = sizes.filter((s) => s > lo && s < hi);
    const pinned = sizes.reduce((s, x) => s + (x <= lo || x >= hi ? x : 0), 0);
    const k =
      (target - pinned) /
      Math.max(
        1,
        free.reduce((s, x) => s + x, 0),
      );
    sizes = sizes.map((s) => (s > lo && s < hi ? Math.min(hi, Math.max(lo, s * k)) : s));
  }
  const out = sizes.map((s) => Math.round(s));
  return big === undefined ? out : [big, ...out];
}

const FILLER_UNIT = "synthetic filler héllo 日本語 \u{1f642} ✓ ";
const FILLER_UNIT_BYTES = Buffer.byteLength(FILLER_UNIT);

function filler(bytes: number): string {
  const n = Math.max(0, Math.floor(bytes));
  const reps = Math.floor(n / FILLER_UNIT_BYTES);
  return FILLER_UNIT.repeat(reps) + "x".repeat(n - reps * FILLER_UNIT_BYTES);
}

type Kind = "prompt" | "assistant" | "result" | "attachment" | "system";

interface LineDesc {
  kind: Kind;
  fill: number;
  tool?: string;
  tokens?: [number, number, number, number, number];
  model?: string;
  bytes: number;
}

interface FileCtx {
  session: string;
  agentId?: string;
  turn: number;
}

function lineObject(d: LineDesc, ctx: FileCtx, ts: string, idx: number): Record<string, unknown> {
  const base: Record<string, unknown> = { type: "", timestamp: ts, sessionId: ctx.session };
  if (ctx.agentId !== undefined) {
    base.isSidechain = true;
    base.agentId = ctx.agentId;
  }
  const toolId = `toolu_${ctx.session}_${ctx.agentId ?? "m"}_${ctx.turn}`;
  switch (d.kind) {
    case "prompt":
      return {
        ...base,
        type: "user",
        promptSource: "typed",
        message: { role: "user", content: filler(d.fill) },
      };
    case "assistant": {
      const [input, output, cacheRead, cw5m, cw1h] = d.tokens as number[];
      const content: unknown[] = [{ type: "text", text: filler(d.fill) }];
      if (d.tool !== undefined)
        content.push({ type: "tool_use", id: toolId, name: d.tool, input: {} });
      return {
        ...base,
        type: "assistant",
        message: {
          id: `msg_${ctx.session}_${ctx.agentId ?? "m"}_${idx}`,
          model: d.model,
          content,
          usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: (cw5m as number) + (cw1h as number),
            cache_creation: { ephemeral_5m_input_tokens: cw5m, ephemeral_1h_input_tokens: cw1h },
          },
        },
      };
    }
    case "result":
      return {
        ...base,
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: toolId, content: filler(d.fill) }],
        },
      };
    case "attachment":
      return {
        ...base,
        type: "attachment",
        attachment: { type: "synthetic", content: filler(d.fill) },
      };
    case "system":
      return { ...base, type: "system", subtype: "synthetic_note", content: filler(d.fill) };
  }
}

const TS_PLACEHOLDER = new Date(0).toISOString();

/** Pass 1: line descriptors until the byte target is met (exact sizes, placeholder timestamps). */
function planLines(
  rnd: () => number,
  target: number,
  dist: Distributions,
  ctx: FileCtx,
): LineDesc[] {
  const tools = Object.entries(dist.toolMix);
  const attachPerTurn = (dist.lineTypeShare.attachment ?? 0) / (dist.lineTypeShare.assistant ?? 1);
  const systemPerTurn = (dist.lineTypeShare.system ?? 0) / (dist.lineTypeShare.assistant ?? 1);
  const lines: LineDesc[] = [];
  let bytes = 0;
  const push = (kind: Kind, extra: Partial<LineDesc> = {}) => {
    const d: LineDesc = { kind, fill: 0, bytes: 0, ...extra };
    const bare =
      Buffer.byteLength(JSON.stringify(lineObject(d, ctx, TS_PLACEHOLDER, lines.length))) + 1;
    const room = target - bytes - bare;
    d.fill = Math.max(0, Math.min(Math.round(lognormal(rnd, dist.bytesPerLine)) - bare, room));
    d.bytes = bare + d.fill;
    lines.push(d);
    bytes += d.bytes;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  push("prompt");
  while (bytes < target) {
    ctx.turn++;
    if (rnd() < 0.05) push("prompt");
    const tool = rnd() < dist.toolUsesPerTurn ? pick(rnd, Object.fromEntries(tools)) : undefined;
    const toolName = tool === "__other" ? "mcp__synthetic__tool" : tool;
    push("assistant", {
      ...(toolName === undefined ? {} : { tool: toolName }),
      tokens: [int(1, 900), int(1, 1_500), int(0, 80_000), int(0, 4_000), int(0, 800)],
      model: rnd() < 0.8 ? "claude-sonnet-4-6" : "claude-opus-4-6",
    });
    if (toolName !== undefined && bytes < target) push("result");
    let attach = Math.floor(attachPerTurn) + (rnd() < attachPerTurn % 1 ? 1 : 0);
    while (attach-- > 0 && bytes < target) push("attachment");
    if (rnd() < systemPerTurn && bytes < target) push("system");
  }
  return lines;
}

/** The generator's own top-level dirs under a scan root (see `slug` in generateBackfillCorpus). */
const GENERATED_SLUG_DIR = /^proj-r3-\d+$/;

/**
 * Generate the corpus under `root` (created). Any earlier generated `proj-r3-<n>` dirs under it are
 * removed first, so files of a previous corpus are never ingested with this one; nothing else in
 * `root` is touched. Returns per-file facts and a content digest.
 */
export function generateBackfillCorpus(
  root: string,
  spec: DatasetSpec,
  dist: Distributions,
  nowMs: number,
): CorpusManifest {
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && GENERATED_SLUG_DIR.test(entry.name)) {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  }
  const top = rng(spec.seed);
  const targets = fileTargets(top, spec, dist);
  const slugs = Math.max(1, Math.round(spec.files / 40));
  const hash = crypto.createHash("sha1");
  const perFile: CorpusFileFacts[] = [];
  const toolCounts: Record<string, number> = {};
  const parents: string[][] = Array.from({ length: slugs }, () => []);
  let total = 0;

  targets.forEach((target, i) => {
    const rnd = rng((spec.seed * 1_000_003 + i * 7_919) >>> 0);
    const s = i % slugs;
    const slug = `proj-r3-${s}`;
    // the big file (index 0 when present) is a main session; others follow the census nesting
    const depth =
      spec.bigFileBytes !== undefined && i === 0 ? "0" : pick(rnd, dist.nestingDepthShare);
    const own = `r3-${spec.seed}-${i}`;
    const slugParents = parents[s] as string[];
    let rel: string;
    let ctx: FileCtx;
    if (depth === "0" || slugParents.length === 0) {
      slugParents.push(own);
      rel = path.join(slug, `${own}.jsonl`);
      ctx = { session: own, turn: 0 };
    } else {
      const parent = slugParents[Math.floor(rnd() * slugParents.length)] as string;
      const agentId = `agent-${own}`;
      rel =
        depth === "2"
          ? path.join(slug, parent, "subagents", `${agentId}.jsonl`)
          : path.join(slug, parent, "subagents", "workflows", `wf-${own}`, `${agentId}.jsonl`);
      ctx = { session: parent, agentId, turn: 0 };
    }

    const week = i % spec.weeks;
    const plannedMtime =
      Math.floor((nowMs - week * WEEK - 1_000 - rnd() * (WEEK - 3_600_000)) / 1_000) * 1_000;
    const newest = plannedMtime - (1_000 + Math.floor(rnd() * 29_000));
    const durationMs =
      Math.min(dist.sessionDurationMin.max, Math.max(1, lognormal(rnd, dist.sessionDurationMin))) *
      60_000;

    const lines = planLines(rnd, target, dist, ctx);
    const start = newest - durationMs;
    const step = lines.length > 1 ? durationMs / (lines.length - 1) : 0;

    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "w");
    hash.update(rel.split(path.sep).join("/")).update("\n");
    ctx.turn = 0;
    let bytes = 0;
    let turns = 0;
    let buf: string[] = [];
    let bufBytes = 0;
    const flush = () => {
      const chunk = Buffer.from(buf.join(""), "utf8");
      fs.writeSync(fd, chunk);
      hash.update(chunk);
      buf = [];
      bufBytes = 0;
    };
    lines.forEach((d, idx) => {
      if (d.kind === "assistant") {
        ctx.turn++;
        turns++;
        if (d.tool !== undefined) toolCounts[d.tool] = (toolCounts[d.tool] ?? 0) + 1;
      }
      const ts = new Date(
        idx === lines.length - 1 ? newest : Math.round(start + step * idx),
      ).toISOString();
      const text = `${JSON.stringify(lineObject(d, ctx, ts, idx))}\n`;
      const n = Buffer.byteLength(text);
      buf.push(text);
      bufBytes += n;
      bytes += n;
      if (bufBytes >= 1 << 20) flush();
    });
    flush();
    fs.closeSync(fd);
    fs.utimesSync(file, new Date(plannedMtime), new Date(plannedMtime));
    total += bytes;
    perFile.push({ rel, bytes, mtimeMs: plannedMtime, newestTurnMs: newest, turns });
  });

  return {
    generator: GENERATOR_VERSION,
    files: perFile.length,
    totalBytes: total,
    digest: hash.digest("hex"),
    perFile,
    toolCounts,
  };
}

// CLI (verify:app scan-root mode): `gen <root> <seed> <files> <totalBytes> <weeks>`,
// relative to the real clock; prints aggregate facts only.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, root, seed, files, totalBytes, weeks] = process.argv.slice(2);
  if (cmd !== "gen" || root === undefined) throw new Error("usage: gen <root> <seed> <files> <totalBytes> <weeks>");
  const m = generateBackfillCorpus(
    root,
    { seed: Number(seed), files: Number(files), totalBytes: Number(totalBytes), weeks: Number(weeks) },
    loadDistributions(),
    Date.now(),
  );
  const mtimeWeeks = new Set(m.perFile.map((f) => Math.floor((Date.now() - f.mtimeMs) / WEEK))).size;
  const turns = m.perFile.reduce((s, f) => s + f.turns, 0);
  console.log(JSON.stringify({ files: m.files, totalBytes: m.totalBytes, turns, mtimeWeeks }));
}
