// "Judge me" lifecycle (JMS-P2 U9): consent preview, approval nonce, the isolated judge run, verdict storage.
// The browser never sends a payload, only the hash of one it was shown. The daemon keeps the shown bytes, so
// what runs is exactly what the user saw even though the scorecard numbers drift every few seconds. Approve and
// run rebuild only to compare the config shape (standing hash): a config change → 409 needs_consent.
// One run at a time per daemon.
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Db } from "../db/open.js";
import { awaitDbWriteGate } from "../db/write-gate.js";
import { CHECKS } from "../detector/check-registry.js";
import {
  DEFAULT_RUBRIC,
  type SetupGrade,
  gradeSetup,
  recordGradeSnapshot,
  rubricVersion,
} from "../detector/setup-grade.js";
import { type IdentityContext, identityFromOs } from "../query/api/judge-payload-scrub.js";
import {
  type JudgeBlock,
  type JudgeSources,
  buildJudgePayload,
  readJudgeSources,
} from "../query/api/judge-payload.js";
import { configGet, configSet } from "../query/settings-store.js";
import { type EnvScanOptions, type EnvScanResult, scanEnvironment } from "../scanner/env-scan.js";
import {
  CLI_CONTEXT_DISCLOSURES,
  type JudgeCliReason,
  type JudgeSpawn,
  runClaudeJudge,
} from "./claude-cli.js";
import {
  JUDGE_VERDICT_SCHEMA,
  type JudgeVerdict,
  buildJudgeSystemPrompt,
  payloadSources,
  validateVerdict,
} from "./verdict.js";

/** Chosen from the 2026-10-13 A/B (Opus found all five trial findings; Haiku/Sonnet two or three);
 *  operator sign-off 2026-10-13. */
export const JUDGE_DEFAULT_MODEL = "claude-opus-5-5";
const NONCE_TTL_MS = 10 * 60 * 1000;
/** Shown payloads kept for approve/run (each is ~60 KB). */
const MAX_SHOWN = 8;
const KEY = {
  names: "judge.extra_names",
  repos: "judge.included_repos",
  standing: "judge.standing_hash",
} as const;
/** Env vars the CLI child inherits that change where its traffic goes or which CAs it trusts. */
const NETWORK_ENV = /^(?:https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_extra_ca_certs)$/i;

export interface JudgeServiceDeps {
  db: Db;
  spawn?: JudgeSpawn;
  scan?: EnvScanOptions;
  env?: Record<string, string | undefined>;
  identity?: () => IdentityContext;
  model?: string;
  now?: () => Date;
}

export interface StoredVerdict {
  verdict_id: number;
  created_at: string;
  snapshot_id: number | null;
  payload_hash: string;
  model: string;
  cost_usd: number | null;
  verdict: JudgeVerdict;
  /** The grade changed since this verdict was made (R23). */
  outdated: boolean;
}

export type ConsentView =
  | {
      state: "ready";
      payload: string;
      shapeHash: string;
      model: string;
      standing: boolean;
      disclosures: string[];
      network_env: string[];
      extra_names: string[];
      repos: { path: string; included: boolean }[];
    }
  | { state: "blocked"; blocked: JudgeBlock[] };

export type JudgeRunResult =
  | { status: 200; body: StoredVerdict }
  | { status: 403; body: { error: "consent_required" } }
  | { status: 409; body: { error: "needs_consent" | "in_flight" } }
  | { status: 422; body: { error: "blocked"; blocked: JudgeBlock[] } }
  | { status: 502; body: { error: JudgeCliReason | "invalid_verdict" } };

function readList(db: Db, key: string): string[] | null {
  const raw = configGet(db, key);
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : null;
  } catch {
    return null;
  }
}

/** The disk reads behind a consent payload. Pure fs, so the daemon can run it off the event loop. */
export interface JudgeInputs {
  scan: EnvScanResult;
  sources: JudgeSources;
  /** The grade and payload built from the scan, when the caller asked for them (see `JudgePrep`). */
  prepared?: { grade: SetupGrade; built: ReturnType<typeof buildJudgePayload> };
}

/** Ask `gatherJudgeInputs` to also grade and build the payload (the CPU-heavy part), as of `nowIso`. */
export interface JudgePrep {
  model: string;
  nowIso: string;
}

export function gatherJudgeInputs(
  db: Db,
  scanOpts?: EnvScanOptions,
  prep?: JudgePrep,
): JudgeInputs {
  const scan = scanEnvironment(db, scanOpts);
  const repoPaths = scan.projects.map((p) => p.repoPath).filter((p): p is string => p !== null);
  const included = readList(db, KEY.repos);
  const sources = readJudgeSources({
    claudeDir: scanOpts?.claudeDir ?? path.join(os.homedir(), ".claude"),
    claudeJsonPath: scanOpts?.claudeJsonPath ?? path.join(os.homedir(), ".claude.json"),
    projectRepoPaths: repoPaths,
    ...(included !== null ? { includedRepos: included } : {}),
  });
  if (prep === undefined) return { scan, sources };
  const grade = gradeSetup({ db, scan, now: prep.nowIso });
  const built = buildJudgePayload({
    grade,
    rubricVersion: rubricVersion(DEFAULT_RUBRIC),
    sources,
    identity: identityFromOs(),
    extraNames: readList(db, KEY.names) ?? [],
    modelId: prep.model,
  });
  return { scan, sources, prepared: { grade, built } };
}

interface Shown {
  built: Extract<ReturnType<typeof buildJudgePayload>, { ok: true }>;
  snap: { snapshot_id: number; content_hash: string } | null;
  expires: number;
}

interface VerdictRow {
  verdict_id: number;
  created_at: string;
  snapshot_id: number | null;
  grade_hash: string;
  payload_hash: string;
  model: string;
  verdict_json: string;
  cost_usd: number | null;
}

export function createJudgeService(deps: JudgeServiceDeps) {
  const { db } = deps;
  const env = deps.env ?? process.env;
  const model = deps.model ?? JUDGE_DEFAULT_MODEL;
  const now = deps.now ?? (() => new Date());
  const nonces = new Map<string, { shapeHash: string; expires: number }>();
  const shown = new Map<string, Shown>();
  let inFlight: AbortController | null = null;

  function remember(built: Shown["built"], snap: Shown["snap"]): void {
    const t = now().getTime();
    for (const [h, s] of shown) if (s.expires <= t) shown.delete(h);
    shown.delete(built.payloadHash);
    shown.set(built.payloadHash, { built, snap, expires: t + NONCE_TTL_MS });
    for (const h of shown.keys()) {
      if (shown.size <= MAX_SHOWN) break;
      shown.delete(h);
    }
  }

  /** The payload shown under `shapeHash`, if still held and the config shape hasn't changed since. */
  function shownFor(
    shapeHash: string,
  ): { ok: true; shown: Shown } | { ok: false; status: 409 | 422; blocked?: JudgeBlock[] } {
    const s = shown.get(shapeHash);
    if (s === undefined || s.expires <= now().getTime()) return { ok: false, status: 409 };
    const { built } = prepare();
    if (!built.ok) return { ok: false, status: 422, blocked: built.blocked };
    if (built.standingHash !== s.built.standingHash) return { ok: false, status: 409 };
    return { ok: true, shown: s };
  }

  function prepare(inputs?: JudgeInputs) {
    const { scan, sources, prepared } = inputs ?? gatherJudgeInputs(db, deps.scan);
    const { grade } = recordGradeSnapshot({
      db,
      scan,
      now: prepared ? prepared.grade.window.to : now(),
      ...(prepared ? { grade: prepared.grade } : {}),
    });
    const snap = latestSnapshot();
    const repoPaths = scan.projects.map((p) => p.repoPath).filter((p): p is string => p !== null);
    const included = readList(db, KEY.repos);
    const extraNames = readList(db, KEY.names) ?? [];
    const built =
      prepared?.built ??
      buildJudgePayload({
        grade,
        rubricVersion: rubricVersion(DEFAULT_RUBRIC),
        sources,
        identity: (deps.identity ?? identityFromOs)(),
        extraNames,
        modelId: model,
      });
    return { built, snap, repoPaths, included, extraNames };
  }

  function latestSnapshot(): { snapshot_id: number; content_hash: string } | null {
    return (
      (db
        .prepare(
          "SELECT snapshot_id, content_hash FROM setup_grade_snapshots ORDER BY snapshot_id DESC LIMIT 1",
        )
        .get() as { snapshot_id: number; content_hash: string } | undefined) ?? null
    );
  }

  function toStored(row: VerdictRow): StoredVerdict {
    return {
      verdict_id: row.verdict_id,
      created_at: row.created_at,
      snapshot_id: row.snapshot_id,
      payload_hash: row.payload_hash,
      model: row.model,
      cost_usd: row.cost_usd,
      verdict: JSON.parse(row.verdict_json) as JudgeVerdict,
      outdated: latestSnapshot()?.content_hash !== row.grade_hash,
    };
  }

  return {
    /** The scan paths this service reads, so a caller can do `gatherJudgeInputs` off the event loop. */
    scanOptions(): EnvScanOptions {
      return deps.scan ?? {};
    },

    /** Grade + payload prep for an off-thread `judge-inputs` scan; null when an injected identity needs the main thread. */
    prep(): JudgePrep | null {
      return deps.identity === undefined ? { model, nowIso: now().toISOString() } : null;
    },

    /** `inputs`: the disk reads, when the caller already did them off the event loop. */
    consent(inputs?: JudgeInputs): ConsentView {
      const { built, snap, repoPaths, included, extraNames } = prepare(inputs);
      if (!built.ok) return { state: "blocked", blocked: built.blocked };
      remember(built, snap);
      const inc = included === null ? null : new Set(included);
      return {
        state: "ready",
        payload: built.bytes,
        shapeHash: built.payloadHash,
        model,
        standing: configGet(db, KEY.standing) === built.standingHash,
        disclosures: [...CLI_CONTEXT_DISCLOSURES],
        network_env: Object.keys(env)
          .filter((k) => NETWORK_ENV.test(k) && env[k])
          .sort(),
        extra_names: extraNames,
        repos: repoPaths.map((p) => ({ path: p, included: inc === null || inc.has(p) })),
      };
    },

    /** Issue a single-use nonce for the payload the user saw; `remember` also stores don't-ask-again. */
    approve(
      shapeHash: string,
      remember: boolean,
    ):
      | { status: 200; body: { consentNonce: string } }
      | { status: 409 | 422; body: { error: string } } {
      const s = shownFor(shapeHash);
      if (!s.ok)
        return s.status === 422
          ? { status: 422, body: { error: "blocked" } }
          : { status: 409, body: { error: "needs_consent" } };
      if (remember) configSet(db, KEY.standing, s.shown.built.standingHash);
      const nonce = randomBytes(32).toString("hex");
      nonces.set(nonce, { shapeHash, expires: now().getTime() + NONCE_TTL_MS });
      return { status: 200, body: { consentNonce: nonce } };
    },

    revoke(): void {
      configSet(db, KEY.standing, null);
    },

    /** Don't-ask-again is on for some setup shape. */
    remembered(): boolean {
      return configGet(db, KEY.standing) !== null;
    },

    /** Consent-screen edits: extra names to scrub, and the repos to include (null = all). */
    setSources(extraNames: string[], includedRepos: string[] | null): void {
      configSet(db, KEY.names, JSON.stringify(extraNames));
      configSet(db, KEY.repos, includedRepos === null ? null : JSON.stringify(includedRepos));
    },

    async run(shapeHash: string, consentNonce: string | null): Promise<JudgeRunResult> {
      if (inFlight !== null) return { status: 409, body: { error: "in_flight" } };
      const ac = new AbortController();
      inFlight = ac;
      try {
        const s = shownFor(shapeHash);
        if (!s.ok)
          return s.status === 422
            ? { status: 422, body: { error: "blocked", blocked: s.blocked ?? [] } }
            : { status: 409, body: { error: "needs_consent" } };
        const { built, snap } = s.shown;
        const granted = consentNonce === null ? undefined : nonces.get(consentNonce);
        if (consentNonce !== null) nonces.delete(consentNonce);
        const nonceOk =
          granted !== undefined &&
          granted.shapeHash === shapeHash &&
          granted.expires > now().getTime();
        if (!nonceOk && configGet(db, KEY.standing) !== built.standingHash) {
          return { status: 403, body: { error: "consent_required" } };
        }

        const sources = payloadSources(built.payload.claude_md.map((c) => c.source));
        const res = await runClaudeJudge({
          payload: built.bytes,
          systemPrompt: buildJudgeSystemPrompt(CHECKS, sources),
          jsonSchema: JUDGE_VERDICT_SCHEMA,
          model,
          baseEnv: env,
          signal: ac.signal,
          ...(deps.spawn ? { spawn: deps.spawn } : {}),
        });
        if (!res.ok) return { status: 502, body: { error: res.reason } };
        const verdict = validateVerdict(res.data, {
          checkIds: new Set(CHECKS.map((c) => c.check_id)),
          sources: new Set(sources),
        });
        if (verdict === null) return { status: 502, body: { error: "invalid_verdict" } };

        await awaitDbWriteGate(); // the verdict write follows the judge run's await
        const info = db
          .prepare(
            `INSERT INTO judge_verdicts (created_at, snapshot_id, grade_hash, payload_hash, model, verdict_json, cost_usd)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            now().toISOString(),
            snap?.snapshot_id ?? null,
            snap?.content_hash ?? "",
            built.payloadHash,
            model,
            JSON.stringify(verdict),
            res.costUsd,
          );
        const row = db
          .prepare("SELECT * FROM judge_verdicts WHERE verdict_id = ?")
          .get(info.lastInsertRowid) as VerdictRow;
        return { status: 200, body: toStored(row) };
      } finally {
        inFlight = null;
      }
    },

    cancel(): boolean {
      if (inFlight === null) return false;
      inFlight.abort();
      return true;
    },

    latest(): StoredVerdict | null {
      const row = db
        .prepare("SELECT * FROM judge_verdicts ORDER BY verdict_id DESC LIMIT 1")
        .get() as VerdictRow | undefined;
      return row ? toStored(row) : null;
    },
  };
}

export type JudgeService = ReturnType<typeof createJudgeService>;

const services = new WeakMap<Db, JudgeService>();

/** One long-lived service per DB, so nonces and single-flight span requests. `make` is the test seam. */
export function judgeServiceFor(db: Db, make: () => JudgeService): JudgeService {
  let s = services.get(db);
  if (s === undefined) {
    s = make();
    services.set(db, s);
  }
  return s;
}
