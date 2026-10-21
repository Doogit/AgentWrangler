import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SetupGrade, gradeSetup } from "../../src/detector/setup-grade.js";
import {
  type IdentityContext,
  detectSecrets,
  gitIdentityNames,
  scrubIdentity,
} from "../../src/query/api/judge-payload-scrub.js";
import {
  CLAUDE_MD_EXCERPT_MAX_CHARS,
  type JudgeBuildResult,
  type JudgeSources,
  assertAllowListed,
  buildJudgePayload,
  readJudgeSources,
} from "../../src/query/api/judge-payload.js";
import { scanEnvironment } from "../../src/scanner/env-scan.js";
import { createInMemoryFixtureDb } from "../fixtures/seed.js";

const IDENTITY: IdentityContext = { home: "C:\\Users\\jdoe", usernames: ["jdoe"] };
const MODEL = "claude-sonnet-5-5";

function grade(): SetupGrade {
  return {
    window: { from: "2026-09-13T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z" },
    checks: [
      {
        check_id: "claude_md_lean",
        category: "context",
        severity: "major",
        result: "FAIL",
        value: 12.5,
        sample: 40,
        reason: null,
        needs: null,
      },
    ] as unknown as SetupGrade["checks"],
    categories: [
      {
        category: "context",
        label: "Context",
        weight: 1,
        status: "scored",
        score: 60,
        scored_checks: 1,
        total_checks: 1,
      },
    ],
    coverage: 1,
    overall: 60,
    overall_before_hold: 60,
    tier_by_score: "Practitioner",
    tier: "Practitioner",
    gates: [],
    caps: [],
    data_needed: null,
    next_tier: null,
  };
}

function emptySources(): JudgeSources {
  return { settings: [], mcp: [], claudeMd: [] };
}

function build(sources: JudgeSources, g: SetupGrade = grade()): JudgeBuildResult {
  return buildJudgePayload({
    grade: g,
    rubricVersion: "rv1",
    sources,
    identity: IDENTITY,
    modelId: MODEL,
  });
}

function ok(r: JudgeBuildResult) {
  if (!r.ok) throw new Error(`expected ok, got blocked ${JSON.stringify(r.blocked)}`);
  return r;
}

const SENTINELS = {
  mcpEnv: "SENTINEL-MCP-ENV-VALUE",
  mcpHeader: "SENTINEL-MCP-HEADER-VALUE",
  mcpArg: "SENTINEL-MCP-ARG",
  mcpUrl: "sentinel-mcp-host.example.com",
  hookEnv: "SENTINEL-HOOK-INLINE-ENV",
  hookArg: "SENTINEL-HOOK-ARG",
  webhook: "sentinel-webhook.example.com",
  settingsEnv: "SENTINEL-SETTINGS-ENV-VALUE",
  memory: "SENTINEL-MEMORY-CONTENT",
  transcript: "SENTINEL-TRANSCRIPT-TEXT",
};

const ADVERSARIAL: JudgeSources = {
  settings: [
    {
      scope: "user",
      raw: {
        env: { GITHUB_TOKEN: SENTINELS.settingsEnv, OTHER: "x" },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: `FOO=${SENTINELS.hookEnv} /usr/local/bin/guard.sh --x ${SENTINELS.hookArg}`,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                { type: "command", command: `curl -s https://${SENTINELS.webhook}/hook?sig=abc` },
                { type: "http", url: `https://${SENTINELS.webhook}/notify` },
              ],
            },
          ],
        },
      },
    },
  ],
  mcp: [
    {
      scope: "user",
      raw: {
        mcpServers: {
          local: {
            command: "npx",
            args: [SENTINELS.mcpArg],
            env: { API_KEY: SENTINELS.mcpEnv },
          },
          remote: {
            type: "http",
            url: `https://${SENTINELS.mcpUrl}/mcp`,
            headers: { Authorization: SENTINELS.mcpHeader },
          },
        },
      },
    },
  ],
  claudeMd: [{ source: "user", text: "# Prefs\n- Be concise." }],
};

describe("judge payload — allow-list projection (narrow by exclusion)", () => {
  it("each excluded class never reaches the payload", () => {
    const r = ok(build(ADVERSARIAL));
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(r.bytes, name).not.toContain(value);
    }
    expect(r.bytes).not.toContain("guard.sh --x");
  });

  it("MCP servers: name + transport + local/remote only", () => {
    const r = ok(build(ADVERSARIAL));
    expect(r.payload.mcp_servers).toEqual([
      { name: "local", scope: "user", transport: "stdio", location: "local" },
      { name: "remote", scope: "user", transport: "http", location: "remote" },
    ]);
  });

  it("hooks: event + matcher + executable basename + script basename only", () => {
    const r = ok(build(ADVERSARIAL));
    expect(r.payload.hooks).toEqual([
      {
        scope: "user",
        event: "PreToolUse",
        matcher: "Bash",
        executable: "guard.sh",
        script: null,
      },
      { scope: "user", event: "Stop", matcher: null, executable: "curl", script: null },
      { scope: "user", event: "Stop", matcher: null, executable: null, script: null },
    ]);
  });

  function hookSources(command: string): JudgeSources {
    return {
      ...emptySources(),
      settings: [
        {
          scope: "user",
          raw: { hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } },
        },
      ],
    };
  }

  it("hooks: script = basename of the first script-file arg; other args never sent", () => {
    const r = ok(
      build(hookSources(`node C:\\x\\hooks\\context-budget.mjs --a ${SENTINELS.hookArg}`)),
    );
    expect(r.payload.hooks).toEqual([
      {
        scope: "user",
        event: "PreToolUse",
        matcher: null,
        executable: "node",
        script: "context-budget.mjs",
      },
    ]);
    expect(r.bytes).not.toContain(SENTINELS.hookArg);
    expect(r.bytes).not.toContain("C:\\x");
    expect(r.bytes).not.toContain("hooks\\");
  });

  it("hooks: script extensions .js .cjs .ts .py .sh .ps1 are recognized; others → null", () => {
    for (const [cmd, script] of [
      ["node a/b.js", "b.js"],
      ["node b.cjs", "b.cjs"],
      ["npx tsx c.ts --flag", "c.ts"],
      ["python3 /opt/d.py", "d.py"],
      ["bash ./e.sh", "e.sh"],
      ['powershell -File "C:\\s\\f.ps1"', "f.ps1"],
      ["node --version", null],
      ["curl -sO https://dl.example.com/get.sh", null],
      ["git status", null],
    ] as const) {
      const r = ok(build(hookSources(cmd)));
      expect(r.payload.hooks[0]?.script, cmd).toBe(script);
    }
  });

  it("hooks: a separate args array is read for the script name; other args never sent", () => {
    const r = ok(
      build({
        ...emptySources(),
        settings: [
          {
            scope: "project",
            raw: {
              hooks: {
                PreToolUse: [
                  {
                    hooks: [
                      {
                        type: "command",
                        command: "node",
                        args: [".claude/hooks/pre-bash-guard.mjs", SENTINELS.hookArg],
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      }),
    );
    expect(r.payload.hooks[0]).toMatchObject({ executable: "node", script: "pre-bash-guard.mjs" });
    expect(r.bytes).not.toContain(SENTINELS.hookArg);
  });

  it("hooks: a secret-shaped script name blocks", () => {
    const r = build(hookSources("node ghp_0123456789abcdefghijABCDEFGHIJ012345.js"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blocked).toContainEqual({ source: "hook script (user)", match_class: "provider-key" });
  });

  it("hooks: quoted paths resolve to the basename; inline shell scripts → null", () => {
    const r = ok(
      build({
        ...emptySources(),
        settings: [
          {
            scope: "user",
            raw: {
              hooks: {
                Stop: [
                  {
                    hooks: [
                      { type: "command", command: '"C:\\Program Files\\nodejs\\node.exe" x.js' },
                      {
                        type: "command",
                        command: "cmd=$(jq -r '.x'); if [ -n \"$cmd\" ]; then exit 2; fi",
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      }),
    );
    expect(r.payload.hooks.map((h) => h.executable)).toEqual(["node.exe", null]);
    expect(r.payload.hooks.map((h) => h.script)).toEqual(["x.js", null]);
  });

  it("settings env: key names only", () => {
    const r = ok(build(ADVERSARIAL));
    expect(r.payload.settings_env_keys).toEqual([
      { scope: "user", keys: ["GITHUB_TOKEN", "OTHER"] },
    ]);
  });

  it("scorecard: ids, results, measured value + sample, and tier — no window, reason or needs", () => {
    const r = ok(build(emptySources()));
    expect(r.payload.scorecard).toEqual({
      rubric_version: "rv1",
      tier: "Practitioner",
      tier_by_score: "Practitioner",
      overall: 60,
      coverage: 1,
      categories: [{ category: "context", status: "scored", score: 60 }],
      checks: [{ check_id: "claude_md_lean", result: "FAIL", value: 12.5, sample: 40 }],
      gates: [],
      caps: [],
    });
  });

  it("unlisted key in the payload → throws (fail closed)", () => {
    const r = ok(build(emptySources()));
    expect(() => assertAllowListed(r.payload)).not.toThrow();
    expect(() => assertAllowListed({ ...r.payload, extra: 1 })).toThrow(
      /"extra" is not in the allow-list/,
    );
    expect(() => assertAllowListed({ ...r.payload, extra: { nested: 1 } })).toThrow(
      /"extra" is not in the allow-list/,
    );
    const injected = structuredClone(r.payload) as unknown as {
      scorecard: { checks: Record<string, unknown>[] };
    };
    injected.scorecard.checks[0] = { ...injected.scorecard.checks[0], session_id: "s1" };
    expect(() => assertAllowListed(injected)).toThrow(
      /"scorecard\.checks\[0\]\.session_id" is not in the allow-list/,
    );
  });

  it("extra input fields on the grade never reach the payload", () => {
    const g = grade() as SetupGrade & { session_ids: string[] };
    g.session_ids = [SENTINELS.transcript];
    (g.checks[0] as unknown as Record<string, unknown>).evidence = SENTINELS.transcript;
    const r = ok(build(emptySources(), g));
    expect(r.bytes).not.toContain(SENTINELS.transcript);
  });
});

describe("judge payload — secrets detect-then-block (AE7)", () => {
  const cases: [string, string, string][] = [
    ["github token", "token ghp_0123456789abcdefghijABCDEFGHIJ012345 here", "provider-key"],
    ["anthropic key", "use sk-ant-api03-abcdefghijklmnopqrstuvwx", "provider-key"],
    ["AWS id", "AKIAABCDEFGHIJKLMNOP", "provider-key"],
    // Assembled at runtime so the SEC-101 pre-commit scan doesn't read the fixture as a real key.
    [
      "PEM",
      `-----BEGIN RSA ${"PRIVATE"} KEY-----\nabc\n-----END RSA ${"PRIVATE"} KEY-----`,
      "private-key",
    ],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl", "jwt"],
    ["bearer", "Authorization: Bearer abcdefghijklmnop1234", "bearer-token"],
    ["named assignment", "PASSWORD=hunter2", "named-secret"],
    ["quoted JSON key", '"GITHUB_TOKEN": "short"', "named-secret"],
    ["url ?key=", "see https://x.test/a?key=abc", "url-credential"],
    ["url ?sig=", "see https://x.test/a?x=1&sig=abc", "url-credential"],
    ["url ?auth=", "see https://x.test/a?auth=abc", "url-credential"],
    ["entropy", "blob Zx8Qp2Lm9Vt4Rk7Wn3Yh6Jd1Fs5Gb0Cq", "high-entropy"],
  ];
  for (const [name, text, cls] of cases) {
    it(`${name} in a CLAUDE.md excerpt → send blocked with class ${cls}`, () => {
      const r = build({ ...emptySources(), claudeMd: [{ source: "user", text }] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.blocked).toContainEqual({ source: "CLAUDE.md (user)", match_class: cls });
      expect(JSON.stringify(r)).not.toContain(text.slice(6, 20));
    });
  }

  it("word-like long identifiers and paths do not block", () => {
    expect(detectSecrets("perf-campaign-ambient-control and useEffectCleanupFunctionName")).toEqual(
      [],
    );
    expect(detectSecrets("src/query/api/judge-payload-scrub.ts")).toEqual([]);
    expect(
      detectSecrets("docs/plans/session-oAuthRedirectHandler-v2 and HTTPServerConfig2026"),
    ).toEqual([]);
  });

  it("random base64 still blocks", () => {
    expect(detectSecrets("aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q=")).toEqual(["high-entropy"]);
    expect(detectSecrets("q9X2vB7kLm4RtY8wPz3NcH6jD1sF5gA0")).toEqual(["high-entropy"]);
  });

  it("a secret in an excluded field (hook command) does not block", () => {
    const r = build({
      ...emptySources(),
      settings: [
        {
          scope: "user",
          raw: {
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: "TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345 x",
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("a secret-shaped MCP server name blocks (names are free text)", () => {
    const r = build({
      ...emptySources(),
      mcp: [
        {
          scope: "user",
          raw: { mcpServers: { ghp_0123456789abcdefghijABCDEFGHIJ012345: { command: "x" } } },
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
});

describe("judge payload — path / identity scrub", () => {
  const spellings: [string, string][] = [
    ["windows", "C:\\Users\\jdoe\\repo\\x.ts"],
    ["windows lower drive", "c:\\users\\JDOE\\repo"],
    ["forward slash", "C:/Users/jdoe/repo"],
    ["JSON-escaped", "C:\\\\Users\\\\jdoe\\\\repo"],
    ["git bash", "/c/Users/jdoe/repo"],
    ["wsl", "/mnt/c/Users/jdoe/repo"],
    ["posix home", "/home/jdoe/repo"],
    ["mac home", "/Users/jdoe/repo"],
    ["UNC", "\\\\fileserver\\share\\jdoe\\repo"],
    ["UNC wsl", "\\\\wsl$\\Ubuntu\\home\\jdoe"],
    ["OneDrive", "C:\\Users\\jdoe\\OneDrive - Contoso Ltd\\docs"],
    ["URL-encoded", "file=C%3A%5CUsers%5Cjdoe%5Crepo"],
    ["URL-encoded posix", "p=%2Fhome%2Fjdoe%2Frepo"],
    ["bare username", "ask jdoe first"],
    ["email local-part", "mail jdoe at work"],
  ];
  for (const [name, text] of spellings) {
    it(`${name} → no username, no host/org left`, () => {
      const out = scrubIdentity(text, IDENTITY).text;
      expect(out.toLowerCase()).not.toContain("jdoe");
      expect(out).not.toContain("fileserver");
      expect(out).not.toContain("Contoso");
    });
  }

  it("home path becomes ~ and keeps the rest of the path", () => {
    expect(scrubIdentity("C:\\Users\\jdoe\\repo\\x.ts", IDENTITY).text).toBe("~\\repo\\x.ts");
    expect(scrubIdentity("/mnt/c/Users/jdoe/repo", IDENTITY).text).toBe("~/repo");
  });

  it("git identity: user.name and email local-part are collected", () => {
    const cfg = '[core]\n\tname = notme\n[user]\n\tname = Jane Doe\n\temail = "jd42@example.com"\n';
    expect(gitIdentityNames(cfg)).toEqual(["Jane Doe", "jd42"]);
    const out = scrubIdentity("ping Jane Doe or jd42", {
      home: "/home/x",
      usernames: gitIdentityNames(cfg),
    }).text;
    expect(out).toBe("ping [USER] or [USER]");
  });

  it("another user's home path is scrubbed too", () => {
    expect(scrubIdentity("C:\\Users\\alice\\x", IDENTITY).text).toBe("~\\x");
  });

  it("emails, IPs and hostnames in a CLAUDE.md excerpt → scrubbed", () => {
    const r = ok(
      build({
        ...emptySources(),
        claudeMd: [
          {
            source: "user",
            text: "Contact bob.smith@corp.example.com; db at 10.0.4.17 or fe80::1ff:fe23:4567:890a; deploy to build01.internal.corp. Edit CLAUDE.md and package.json.",
          },
        ],
      }),
    );
    const excerpt = r.payload.claude_md[0]?.excerpt ?? "";
    expect(excerpt).not.toBe("");
    expect(excerpt).not.toContain("bob.smith");
    expect(excerpt).not.toContain("10.0.4.17");
    expect(excerpt).not.toContain("fe80::1ff");
    expect(excerpt).not.toContain("build01");
    expect(excerpt).toContain("CLAUDE.md");
    expect(excerpt).toContain("package.json");
  });

  it("loopback addresses stay: they state a security property", () => {
    const text =
      "Daemon on 127.0.0.1:47821 and ::1, open http://localhost:3000/x or http://127.0.0.1:47821/#/judge; db at 10.0.0.5";
    expect(scrubIdentity(text, IDENTITY).text).toBe(
      "Daemon on 127.0.0.1:47821 and ::1, open http://localhost:3000/x or http://127.0.0.1:47821/#/judge; db at [IP]",
    );
  });

  it("a loopback URL still loses the user's name", () => {
    expect(scrubIdentity("http://localhost:8080/files/jdoe/x", IDENTITY).text).toBe(
      "http://localhost:8080/files/[USER]/x",
    );
  });

  it("operator-added names are scrubbed everywhere in the payload", () => {
    const r = ok(
      buildJudgePayload({
        grade: grade(),
        rubricVersion: "rv1",
        sources: {
          ...emptySources(),
          mcp: [{ scope: "user", raw: { mcpServers: { "kevin-tools": { command: "x" } } } }],
          claudeMd: [
            { source: "user", text: "Kevin's rules. Ask KEVIN first; Kevinator is fine." },
          ],
        },
        identity: IDENTITY,
        extraNames: ["Kevin", " ", "k"],
        modelId: MODEL,
      }),
    );
    expect(r.payload.claude_md[0]?.excerpt).toBe(
      "[USER]'s rules. Ask [USER] first; Kevinator is fine.",
    );
    expect(r.payload.mcp_servers[0]?.name).toBe("[USER]-tools");
  });

  it("URLs in an excerpt are replaced", () => {
    const out = scrubIdentity("docs at https://code.claude.com/docs/en/hooks#x", IDENTITY).text;
    expect(out).toBe("docs at [URL]");
  });

  it("a bare host drops its path (owner handle)", () => {
    expect(scrubIdentity("`github.com/someowner/repo` is public", IDENTITY).text).toBe(
      "`[HOST]` is public",
    );
  });

  it("MCP names, matchers and env key names are scrubbed as free text", () => {
    const r = ok(
      build({
        settings: [
          {
            scope: "user",
            raw: {
              env: { JDOE_HOME: "x" },
              hooks: { PreToolUse: [{ matcher: "C:\\Users\\jdoe\\x", hooks: [] }] },
            },
          },
        ],
        mcp: [{ scope: "user", raw: { mcpServers: { "jdoe-tools": { command: "x" } } } }],
        claudeMd: [],
      }),
    );
    expect(r.bytes.toLowerCase()).not.toContain("jdoe");
  });
});

describe("judge payload — excerpt caps and hashes (AE6)", () => {
  it("a ~20k-char CLAUDE.md is sent whole", () => {
    const text = "word ".repeat(4000);
    const r = ok(build({ ...emptySources(), claudeMd: [{ source: "user", text }] }));
    expect(r.payload.claude_md[0]).toEqual({ source: "user", excerpt: text, truncated: false });
  });

  it("a 60k-char CLAUDE.md is capped at the safety limit and marked truncated", () => {
    const r = ok(
      build({ ...emptySources(), claudeMd: [{ source: "user", text: "word ".repeat(12000) }] }),
    );
    const e = r.payload.claude_md[0];
    expect(CLAUDE_MD_EXCERPT_MAX_CHARS).toBe(50000);
    expect(e?.excerpt.length).toBe(CLAUDE_MD_EXCERPT_MAX_CHARS);
    expect(e?.truncated).toBe(true);
  });

  it("a secret just past the safety cap still blocks", () => {
    const text = `${"word ".repeat(10000)}ghp_0123456789abcdefghijABCDEFGHIJ012345`;
    expect(build({ ...emptySources(), claudeMd: [{ source: "user", text }] }).ok).toBe(false);
  });

  it("check value/sample change → same standing hash, different payload hash", () => {
    const g2 = grade();
    g2.checks = g2.checks.map((c) => ({ ...c, value: 99, sample: 7 }));
    const a = ok(build(ADVERSARIAL));
    const b = ok(build(ADVERSARIAL, g2));
    expect(b.payload.scorecard.checks[0]).toMatchObject({ value: 99, sample: 7 });
    expect(a.standingHash).toBe(b.standingHash);
    expect(a.payloadHash).not.toBe(b.payloadHash);
  });

  it("CLAUDE.md content change → different standing hash", () => {
    const a = ok(build({ ...emptySources(), claudeMd: [{ source: "user", text: "Be concise." }] }));
    const b = ok(build({ ...emptySources(), claudeMd: [{ source: "user", text: "Be verbose." }] }));
    expect(a.standingHash).not.toBe(b.standingHash);
  });

  it("re-grade alone (scorecard numbers change) → same standing hash, different payload hash", () => {
    const g2 = grade();
    g2.overall = 80;
    g2.checks = g2.checks.map((c) => ({ ...c, result: "PASS" }));
    const a = ok(build(ADVERSARIAL));
    const b = ok(build(ADVERSARIAL, g2));
    expect(a.standingHash).toBe(b.standingHash);
    expect(a.payloadHash).not.toBe(b.payloadHash);
  });

  it("model or rubric change → different standing hash", () => {
    const a = ok(build(ADVERSARIAL));
    const b = ok(
      buildJudgePayload({
        grade: grade(),
        rubricVersion: "rv1",
        sources: ADVERSARIAL,
        identity: IDENTITY,
        modelId: "other",
      }),
    );
    const c = ok(
      buildJudgePayload({
        grade: grade(),
        rubricVersion: "rv2",
        sources: ADVERSARIAL,
        identity: IDENTITY,
        modelId: MODEL,
      }),
    );
    expect(b.standingHash).not.toBe(a.standingHash);
    expect(c.standingHash).not.toBe(a.standingHash);
  });

  it("build is deterministic: same input → identical bytes and hashes", () => {
    const a = ok(build(ADVERSARIAL));
    const b = ok(build(ADVERSARIAL));
    expect(a.bytes).toBe(b.bytes);
    expect(a.payloadHash).toBe(b.payloadHash);
  });
});

describe("judge payload — read from disk + real grade", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aw-judge-payload-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("memory files and transcript text never reach the payload", () => {
    const claudeDir = path.join(root, ".claude");
    const memDir = path.join(claudeDir, "projects", "p1", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), `- ${SENTINELS.memory}`);
    fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "# Global\n- Be concise.");
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ env: { K: SENTINELS.settingsEnv } }),
    );
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# Repo\n- Run tests.");
    fs.writeFileSync(
      path.join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { db: { command: "x", env: { P: SENTINELS.mcpEnv } } } }),
    );
    const claudeJsonPath = path.join(root, "claude.json");

    const db = createInMemoryFixtureDb();
    const scan = scanEnvironment(db, { claudeDir, claudeJsonPath });
    const g = gradeSetup({ db, scan, now: new Date() });
    const sources = readJudgeSources({ claudeDir, claudeJsonPath, projectRepoPaths: [repo] });
    const r = ok(
      buildJudgePayload({
        grade: g,
        rubricVersion: "rv1",
        sources,
        identity: { home: root, usernames: [] },
        modelId: MODEL,
      }),
    );
    expect(r.payload.claude_md.map((c) => c.source)).toEqual(["user", "project 1"]);
    expect(r.payload.mcp_servers).toEqual([
      { name: "db", scope: "project", transport: "stdio", location: "local" },
    ]);
    expect(r.bytes).not.toContain(SENTINELS.memory);
    expect(r.bytes).not.toContain(SENTINELS.settingsEnv);
    expect(r.bytes).not.toContain(SENTINELS.mcpEnv);
    expect(r.bytes).not.toContain(root);
    // Grade inputs come from the DB (sessions, transcripts); only ids/results/tiers travel.
    for (const c of r.payload.scorecard.checks) {
      expect(Object.keys(c).sort()).toEqual(["check_id", "result", "sample", "value"]);
    }
  });

  it("MCP: ~/.claude.json per-project servers and plugin servers are read; values never sent", () => {
    const claudeDir = path.join(root, ".claude");
    const install = path.join(claudeDir, "plugins", "cache", "mkt", "toolbox", "1.0.0");
    fs.mkdirSync(install, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "toolbox@mkt": [{ scope: "user", installPath: install }] },
      }),
    );
    fs.writeFileSync(
      path.join(install, ".mcp.json"),
      JSON.stringify({
        search: { command: "node", args: [SENTINELS.mcpArg], env: { K: SENTINELS.mcpEnv } },
      }),
    );
    const repo = path.join(root, "repo");
    const other = path.join(root, "unscanned");
    fs.mkdirSync(repo, { recursive: true });
    const claudeJsonPath = path.join(root, "claude.json");
    fs.writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        projects: {
          // Claude Code may key projects with forward slashes on Windows.
          [repo.replaceAll("\\", "/")]: {
            mcpServers: {
              db: {
                type: "http",
                url: `https://${SENTINELS.mcpUrl}/mcp`,
                headers: { Authorization: SENTINELS.mcpHeader },
              },
            },
          },
          [other]: { mcpServers: { notScanned: { command: "x" } } },
        },
      }),
    );

    const sources = readJudgeSources({ claudeDir, claudeJsonPath, projectRepoPaths: [repo] });
    const r = ok(
      buildJudgePayload({
        grade: grade(),
        rubricVersion: "rv1",
        sources,
        identity: { home: root, usernames: [] },
        modelId: MODEL,
      }),
    );
    expect(r.payload.mcp_servers).toEqual([
      { name: "toolbox:search", scope: "plugin", transport: "stdio", location: "local" },
      { name: "db", scope: "project", transport: "http", location: "remote" },
    ]);
    for (const v of [SENTINELS.mcpArg, SENTINELS.mcpEnv, SENTINELS.mcpUrl, SENTINELS.mcpHeader]) {
      expect(r.bytes).not.toContain(v);
    }
    expect(r.bytes).not.toContain("toolbox@mkt");
    expect(r.bytes).not.toContain("mcp__plugin");
  });

  it("included repos: only listed repos are read; others send nothing", () => {
    const claudeDir = path.join(root, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const keep = path.join(root, "keep");
    const drop = path.join(root, "drop");
    for (const [repo, tag] of [
      [keep, "KEEP"],
      [drop, "DROP"],
    ] as const) {
      fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(repo, "CLAUDE.md"), `# ${tag}-MD`);
      fs.writeFileSync(
        path.join(repo, ".claude", "settings.json"),
        JSON.stringify({ env: { [`${tag}_ENV`]: "x" } }),
      );
      fs.writeFileSync(
        path.join(repo, ".mcp.json"),
        JSON.stringify({ mcpServers: { [`${tag}-mcp`]: { command: "x" } } }),
      );
    }
    const claudeJsonPath = path.join(root, "claude.json");
    fs.writeFileSync(
      claudeJsonPath,
      JSON.stringify({ projects: { [drop]: { mcpServers: { "DROP-proj": { command: "x" } } } } }),
    );
    const bytes = (includedRepos?: readonly string[]) =>
      ok(
        buildJudgePayload({
          grade: grade(),
          rubricVersion: "rv1",
          sources: readJudgeSources({
            claudeDir,
            claudeJsonPath,
            projectRepoPaths: [drop, keep],
            ...(includedRepos === undefined ? {} : { includedRepos }),
          }),
          identity: { home: root, usernames: [] },
          modelId: MODEL,
        }),
      ).bytes;

    const all = bytes();
    for (const s of ["DROP-MD", "DROP_ENV", "DROP-mcp", "DROP-proj", "KEEP-MD"]) {
      expect(all).toContain(s);
    }

    // Matching ignores separator spelling (and case on Windows).
    const some = bytes([keep.replaceAll("\\", "/")]);
    expect(some).toContain("KEEP-MD");
    expect(some).toContain("KEEP_ENV");
    expect(some).toContain("KEEP-mcp");
    expect(some).not.toContain("DROP");

    expect(bytes([])).not.toMatch(/KEEP|DROP/);
  });
});
