/**
 * test/detector/context-probe.test.ts — ContextInventoryProbe unit tests.
 *
 * Covers:
 *   - token sizing (Math.ceil(utf8_bytes / 4))
 *   - __global__ sentinel workspace created automatically
 *   - idempotent UPSERT (same probe_id on re-probe, no row accumulation)
 *   - SEC-101: no content column in context_inventory; no file text in stored rows
 *   - per-workspace MEMORY probing
 *   - per-workspace project CLAUDE.md probing (when repo_path is set)
 *   - plugin/skill catalog sizing (MCP_SCHEMAS)
 *   - makeProbeId determinism
 *   - context_inventory_history append-on-change (T4)
 *   - buildPluginCatalog excludes plugins disabled via enabledPlugins in settings.json (T4)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { compactContextHistory } from "../../src/detector/context-history-retention.js";
import {
  GLOBAL_WORKSPACE_ID,
  encodeToolSearchState,
  makeProbeId,
  parseToolSearchState,
  runContextProbe,
} from "../../src/detector/context-probe.js";

// ── Temp-dir helpers ──────────────────────────────────────────────────────────

const SCRATCHPAD = path.join(os.tmpdir(), "aw-context-probe-test");

let claudeDir: string;
let db: Database.Database;
const NOW = new Date("2026-01-08T00:00:00.000Z");

function mkDir(...parts: string[]): string {
  const p = path.join(...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/** UTF-8 byte length → expected token count. */
function expectedTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, "utf8") / 4);
}

function expectedHash(content: string): string {
  return crypto.createHash("sha1").update(content, "utf8").digest("hex");
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Each test gets a unique temp claudeDir under the scratchpad.
  claudeDir = mkDir(SCRATCHPAD, `probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  db.close();
  // Clean up temp dir
  try {
    fs.rmSync(claudeDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function inventoryRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM context_inventory ORDER BY probe_id").all() as Array<
    Record<string, unknown>
  >;
}

function requireRow(
  rows: Array<Record<string, unknown>>,
  label = "inventory row",
): Record<string, unknown> {
  const r = rows[0];
  if (r === undefined) throw new Error(`expected at least one ${label} but found none`);
  return r;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("makeProbeId", () => {
  it("is deterministic — same inputs yield same output", () => {
    const a = makeProbeId("ws-1", "CLAUDE_MD", "/some/path/CLAUDE.md");
    const b = makeProbeId("ws-1", "CLAUDE_MD", "/some/path/CLAUDE.md");
    expect(a).toBe(b);
  });

  it("starts with 'probe-' followed by 16 hex chars", () => {
    expect(makeProbeId("ws-1", "CLAUDE_MD", "/p")).toMatch(/^probe-[0-9a-f]{16}$/);
  });

  it("differs when workspace_id differs", () => {
    const a = makeProbeId("ws-1", "CLAUDE_MD", "/p");
    const b = makeProbeId("ws-2", "CLAUDE_MD", "/p");
    expect(a).not.toBe(b);
  });

  it("differs when component differs", () => {
    const a = makeProbeId("ws-1", "CLAUDE_MD", "/p");
    const b = makeProbeId("ws-1", "MEMORY", "/p");
    expect(a).not.toBe(b);
  });
});

describe("global CLAUDE.md probing", () => {
  it("sizes tokens correctly via Math.ceil(utf8_bytes / 4)", () => {
    const content = "A".repeat(400); // 400 UTF-8 bytes → 100 tokens
    writeFile(path.join(claudeDir, "CLAUDE.md"), content);

    const { rows } = runContextProbe(db, NOW, { claudeDir });
    expect(rows).toBe(1);

    const inv = inventoryRows();
    expect(inv.length).toBe(1);
    const r = requireRow(inv);
    expect(r.workspace_id).toBe(GLOBAL_WORKSPACE_ID);
    expect(r.component).toBe("CLAUDE_MD");
    expect(r.tokens).toBe(expectedTokens(content));
    expect(r.attribution_version).toBe("chars4-v1");
  });

  it("creates __global__ sentinel workspace automatically", () => {
    writeFile(path.join(claudeDir, "CLAUDE.md"), "hello");

    const before = db.prepare("SELECT COUNT(*) AS n FROM workspaces").get() as { n: number };
    expect(before.n).toBe(0);

    runContextProbe(db, NOW, { claudeDir });

    const after = db
      .prepare("SELECT * FROM workspaces WHERE workspace_id = ?")
      .get(GLOBAL_WORKSPACE_ID) as Record<string, unknown> | undefined;
    expect(after).toBeDefined();
    expect(after?.project_slug).toBe("__global__");
  });

  it("does NOT write a row when CLAUDE.md is absent", () => {
    // No CLAUDE.md created
    const { rows } = runContextProbe(db, NOW, { claudeDir });
    expect(rows).toBe(0);
    expect(inventoryRows().length).toBe(0);
  });
});

describe("idempotent UPSERT", () => {
  it("running the probe twice yields the same single row (no duplicate accumulation)", () => {
    const content = "# Rules\n\nBe concise.";
    writeFile(path.join(claudeDir, "CLAUDE.md"), content);

    runContextProbe(db, NOW, { claudeDir });
    runContextProbe(db, new Date("2026-01-09T00:00:00.000Z"), { claudeDir });

    const rows = inventoryRows();
    expect(rows.length).toBe(1); // same probe_id → single row
    // probed_at updated to the second run's timestamp
    expect(requireRow(rows).probed_at).toBe("2026-01-09T00:00:00.000Z");
  });

  it("probe_id is stable across runs for the same source", () => {
    const content = "# Global rules";
    writeFile(path.join(claudeDir, "CLAUDE.md"), content);

    runContextProbe(db, NOW, { claudeDir });
    const first = requireRow(inventoryRows()).probe_id;

    runContextProbe(db, new Date("2026-01-09T00:00:00.000Z"), { claudeDir });
    const second = requireRow(inventoryRows()).probe_id;

    expect(first).toBe(second);
  });
});

describe("SEC-101 — no content stored", () => {
  it("context_inventory schema has no 'content' column", () => {
    const cols = (
      db.prepare("PRAGMA table_info(context_inventory)").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(cols).not.toContain("content");
  });

  it("file text does not appear in any stored inventory row", () => {
    const SECRET_TEXT = "TOP_SECRET_CONTENT_12345";
    writeFile(path.join(claudeDir, "CLAUDE.md"), `# Rules\n${SECRET_TEXT}`);

    runContextProbe(db, NOW, { claudeDir });

    const rows = inventoryRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain(SECRET_TEXT);
    }
  });
});

describe("per-workspace memory probing", () => {
  it("sums all *.md files in the memory directory", () => {
    // Register a workspace
    db.prepare(
      `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES ('ws-1', 'proj-1', '2026-01-01T00:00:00.000Z')`,
    ).run();

    const memDir = mkDir(claudeDir, "projects", "proj-1", "memory");
    writeFile(path.join(memDir, "a.md"), "A".repeat(200)); // 50 tokens
    writeFile(path.join(memDir, "b.md"), "B".repeat(200)); // 50 tokens
    // Combined = 400 bytes → 100 tokens

    runContextProbe(db, NOW, { claudeDir });

    const memRow = db
      .prepare(
        "SELECT * FROM context_inventory WHERE workspace_id = 'ws-1' AND component = 'MEMORY'",
      )
      .get() as Record<string, unknown> | undefined;

    expect(memRow).toBeDefined();
    expect(memRow?.tokens).toBe(expectedTokens(`${"A".repeat(200)}\n${"B".repeat(200)}`));
    expect(memRow?.workspace_id).toBe("ws-1");
  });

  it("does not write a MEMORY row if the memory directory has no .md files", () => {
    db.prepare(
      `INSERT INTO workspaces (workspace_id, project_slug, registered_at)
       VALUES ('ws-empty', 'proj-empty', '2026-01-01T00:00:00.000Z')`,
    ).run();
    // No memory dir created

    runContextProbe(db, NOW, { claudeDir });

    const memRow = db
      .prepare("SELECT COUNT(*) AS n FROM context_inventory WHERE component = 'MEMORY'")
      .get() as { n: number };
    expect(memRow.n).toBe(0);
  });
});

describe("per-workspace project CLAUDE.md", () => {
  it("probes project CLAUDE.md when repo_path is set", () => {
    const repoPath = mkDir(claudeDir, "fake-repo");
    db.prepare(
      `INSERT INTO workspaces (workspace_id, project_slug, repo_path, registered_at)
       VALUES ('ws-repo', 'proj-repo', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(repoPath);

    const content = "# Project Rules\n\nDo the thing.";
    writeFile(path.join(repoPath, "CLAUDE.md"), content);

    runContextProbe(db, NOW, { claudeDir });

    const repoRow = db
      .prepare(
        "SELECT * FROM context_inventory WHERE workspace_id = 'ws-repo' AND component = 'CLAUDE_MD'",
      )
      .get() as Record<string, unknown> | undefined;

    expect(repoRow).toBeDefined();
    expect(repoRow?.tokens).toBe(expectedTokens(content));
    expect((repoRow?.file_ref as string | undefined)?.endsWith("CLAUDE.md")).toBe(true);
  });

  it("skips project CLAUDE.md when repo_path is null", () => {
    db.prepare(
      `INSERT INTO workspaces (workspace_id, project_slug, repo_path, registered_at)
       VALUES ('ws-no-repo', 'proj-no-repo', NULL, '2026-01-01T00:00:00.000Z')`,
    ).run();

    runContextProbe(db, NOW, { claudeDir });

    const repoRow = db
      .prepare("SELECT COUNT(*) AS n FROM context_inventory WHERE workspace_id = 'ws-no-repo'")
      .get() as { n: number };
    expect(repoRow.n).toBe(0);
  });
});

describe("plugin/skill catalog (MCP_SCHEMAS)", () => {
  it("writes an MCP_SCHEMAS row when plugins file exists", () => {
    const pluginsDir = mkDir(claudeDir, "plugins");
    writeFile(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify([{ name: "supabase", description: "Supabase plugin" }]),
    );

    runContextProbe(db, NOW, { claudeDir });

    const catalogRow = db
      .prepare(
        "SELECT * FROM context_inventory WHERE workspace_id = ? AND component = 'MCP_SCHEMAS'",
      )
      .get(GLOBAL_WORKSPACE_ID) as Record<string, unknown> | undefined;

    expect(catalogRow).toBeDefined();
    expect(typeof catalogRow?.tokens).toBe("number");
    expect((catalogRow?.tokens as number) > 0).toBe(true);
  });

  it("writes an MCP_SCHEMAS row when skill SKILL.md files exist", () => {
    const skillDir = mkDir(claudeDir, "skills", "my-skill");
    writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: my-skill\ndescription: Does something useful\nenabled: true\n---\n# My Skill",
    );

    runContextProbe(db, NOW, { claudeDir });

    const catalogRow = db
      .prepare(
        "SELECT * FROM context_inventory WHERE workspace_id = ? AND component = 'MCP_SCHEMAS'",
      )
      .get(GLOBAL_WORKSPACE_ID) as Record<string, unknown> | undefined;

    expect(catalogRow).toBeDefined();
    expect((catalogRow?.tokens as number) > 0).toBe(true);
  });

  it("does not write MCP_SCHEMAS row when catalog is empty", () => {
    // No plugins or skills created
    runContextProbe(db, NOW, { claudeDir });

    const catalogRow = db
      .prepare("SELECT COUNT(*) AS n FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { n: number };
    expect(catalogRow.n).toBe(0);
  });

  it("token count matches expected sizing of catalog text", () => {
    // Write a skill that generates known catalog text
    const skillDir = mkDir(claudeDir, "skills", "known-skill");
    // Frontmatter: name=known-skill, description=Does things
    // catalog line will be: "skill:known-skill Does things"
    writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: known-skill\ndescription: Does things\n---\n# Known Skill",
    );

    runContextProbe(db, NOW, { claudeDir });

    const catalogRow = db
      .prepare(
        "SELECT tokens FROM context_inventory WHERE workspace_id = ? AND component = 'MCP_SCHEMAS'",
      )
      .get(GLOBAL_WORKSPACE_ID) as { tokens: number } | undefined;

    // Expected: "skill:known-skill Does things" → token count
    const expectedCatalog = "skill:known-skill Does things";
    expect(catalogRow?.tokens).toBe(expectedTokens(expectedCatalog));
  });

  it("includes direct skills from enabled plugin cache installs without double counting", () => {
    const installPath = mkDir(claudeDir, "plugins", "cache", "market", "enabled", "1.0.0");
    writeFile(
      path.join(installPath, "skills", "plugin-skill", "SKILL.md"),
      "---\nname: plugin-skill\ndescription: Plugin provided\n---\n# Instructions",
    );
    writeFile(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "enabled@market": [
            { scope: "user", installPath },
            { scope: "project", installPath },
          ],
        },
      }),
    );

    runContextProbe(db, NOW, { claudeDir });

    const expected = "plugin:enabled@market\nskill:plugin-skill Plugin provided";
    const catalogRow = db
      .prepare("SELECT tokens, file_hash FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { tokens: number; file_hash: string } | undefined;
    expect(catalogRow?.tokens).toBe(expectedTokens(expected));
    expect(catalogRow?.file_hash).toBe(expectedHash(expected));
  });

  it("preserves distinct skill files that render the same catalog text", () => {
    const alphaPath = mkDir(claudeDir, "plugins", "cache", "market", "alpha", "1.0.0");
    const betaPath = mkDir(claudeDir, "plugins", "cache", "market", "beta", "1.0.0");
    const sharedSkill = "---\nname: shared-skill\ndescription: Same text\n---";
    writeFile(path.join(alphaPath, "skills", "shared", "SKILL.md"), sharedSkill);
    writeFile(path.join(betaPath, "skills", "shared", "SKILL.md"), sharedSkill);
    writeFile(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "alpha@market": [{ installPath: alphaPath }],
          "beta@market": [{ installPath: betaPath }],
        },
      }),
    );

    runContextProbe(db, NOW, { claudeDir });

    const expected = [
      "plugin:alpha@market",
      "plugin:beta@market",
      "skill:shared-skill Same text",
      "skill:shared-skill Same text",
    ].join("\n");
    const catalogRow = db
      .prepare("SELECT tokens, file_hash FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { tokens: number; file_hash: string } | undefined;
    expect(catalogRow?.tokens).toBe(expectedTokens(expected));
    expect(catalogRow?.file_hash).toBe(expectedHash(expected));
  });

  it("excludes both metadata and nested skills for a disabled versioned plugin", () => {
    const enabledPath = mkDir(claudeDir, "plugins", "cache", "market", "enabled", "1.0.0");
    const disabledPath = mkDir(claudeDir, "plugins", "cache", "market", "disabled", "1.0.0");
    writeFile(
      path.join(enabledPath, "skills", "kept-skill", "SKILL.md"),
      "---\nname: kept-skill\ndescription: Kept\n---",
    );
    writeFile(
      path.join(disabledPath, "skills", "removed-skill", "SKILL.md"),
      "---\nname: removed-skill\ndescription: Removed\n---",
    );
    writeFile(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "disabled@market": [{ installPath: disabledPath }],
          "enabled@market": [{ installPath: enabledPath }],
        },
      }),
    );
    writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "disabled@market": false } }),
    );

    runContextProbe(db, NOW, { claudeDir });

    const expected = "plugin:enabled@market\nskill:kept-skill Kept";
    const catalogRow = db
      .prepare("SELECT tokens, file_hash FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { tokens: number; file_hash: string } | undefined;
    expect(catalogRow?.tokens).toBe(expectedTokens(expected));
    expect(catalogRow?.file_hash).toBe(expectedHash(expected));
  });

  it("ignores malformed, missing, and out-of-cache install paths", () => {
    mkDir(claudeDir, "plugins", "cache");
    const outsidePath = mkDir(claudeDir, "outside-plugin");
    writeFile(
      path.join(outsidePath, "skills", "escaped-skill", "SKILL.md"),
      "---\nname: escaped-skill\ndescription: Must not be read\n---",
    );
    writeFile(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "malformed@market": [{ installPath: 42 }],
          "missing@market": [{}],
          "outside@market": [{ installPath: outsidePath }],
        },
      }),
    );

    expect(() => runContextProbe(db, NOW, { claudeDir })).not.toThrow();

    const expected = [
      "plugin:malformed@market",
      "plugin:missing@market",
      "plugin:outside@market",
    ].join("\n");
    const catalogRow = db
      .prepare("SELECT tokens, file_hash FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { tokens: number; file_hash: string } | undefined;
    expect(catalogRow?.tokens).toBe(expectedTokens(expected));
    expect(catalogRow?.file_hash).toBe(expectedHash(expected));
  });

  it("rejects a cache-contained symlink or junction whose target escapes the cache root", () => {
    const cacheRoot = mkDir(claudeDir, "plugins", "cache");
    const outsidePath = mkDir(claudeDir, "outside-linked-plugin");
    writeFile(
      path.join(outsidePath, "skills", "escaped-skill", "SKILL.md"),
      "---\nname: escaped-skill\ndescription: Must not be read\n---",
    );
    const linkedInstall = path.join(cacheRoot, "linked-install");
    fs.symlinkSync(outsidePath, linkedInstall, process.platform === "win32" ? "junction" : "dir");
    writeFile(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "linked@market": [{ installPath: linkedInstall }] },
      }),
    );

    runContextProbe(db, NOW, { claudeDir });

    const expected = "plugin:linked@market";
    const catalogRow = db
      .prepare("SELECT tokens, file_hash FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { tokens: number; file_hash: string } | undefined;
    expect(catalogRow?.tokens).toBe(expectedTokens(expected));
    expect(catalogRow?.file_hash).toBe(expectedHash(expected));
  });

  it("degrades cleanly when installed plugin metadata is malformed JSON", () => {
    const malformed = "{not-valid-json";
    writeFile(path.join(claudeDir, "plugins", "installed_plugins.json"), malformed);

    expect(() => runContextProbe(db, NOW, { claudeDir })).not.toThrow();

    const catalogRow = db
      .prepare("SELECT tokens, file_hash FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { tokens: number; file_hash: string } | undefined;
    expect(catalogRow?.tokens).toBe(expectedTokens(malformed));
    expect(catalogRow?.file_hash).toBe(expectedHash(malformed));
  });

  it("produces a deterministic catalog independent of plugin metadata order", () => {
    const alphaPath = mkDir(claudeDir, "plugins", "cache", "market", "alpha", "1.0.0");
    const zetaPath = mkDir(claudeDir, "plugins", "cache", "market", "zeta", "1.0.0");
    writeFile(
      path.join(alphaPath, "skills", "zeta-skill", "SKILL.md"),
      "---\nname: zeta-skill\ndescription: Last\n---",
    );
    writeFile(
      path.join(zetaPath, "skills", "alpha-skill", "SKILL.md"),
      "---\nname: alpha-skill\ndescription: First\n---",
    );
    const metadataPath = path.join(claudeDir, "plugins", "installed_plugins.json");
    writeFile(
      metadataPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "zeta@market": [{ installPath: zetaPath }],
          "alpha@market": [{ installPath: alphaPath }],
        },
      }),
    );
    runContextProbe(db, NOW, { claudeDir });
    const first = db
      .prepare("SELECT file_hash FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { file_hash: string };

    writeFile(
      metadataPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "alpha@market": [{ installPath: alphaPath }],
          "zeta@market": [{ installPath: zetaPath }],
        },
      }),
    );
    runContextProbe(db, new Date("2026-01-09T00:00:00.000Z"), { claudeDir });
    const second = db
      .prepare("SELECT file_hash FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { file_hash: string };

    expect(second.file_hash).toBe(first.file_hash);
    const history = db
      .prepare(
        "SELECT COUNT(*) AS n FROM context_inventory_history WHERE component = 'MCP_SCHEMAS'",
      )
      .get() as { n: number };
    expect(history.n).toBe(1);
  });

  it("stores only aggregate catalog fields, not plugin skill text", () => {
    const installPath = mkDir(claudeDir, "plugins", "cache", "market", "private", "1.0.0");
    const privateText = "PRIVATE_PLUGIN_DESCRIPTION_12345";
    writeFile(
      path.join(installPath, "skills", "private-skill", "SKILL.md"),
      `---\nname: private-skill\ndescription: ${privateText}\n---\nSECRET_BODY`,
    );
    writeFile(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "private@market": [{ installPath }] },
      }),
    );

    runContextProbe(db, NOW, { claudeDir });

    const storedRows = [
      ...(db
        .prepare("SELECT * FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
        .all() as Array<Record<string, unknown>>),
      ...(db
        .prepare("SELECT * FROM context_inventory_history WHERE component = 'MCP_SCHEMAS'")
        .all() as Array<Record<string, unknown>>),
    ];
    expect(storedRows.length).toBe(2);
    expect(JSON.stringify(storedRows)).not.toContain(privateText);
    expect(JSON.stringify(storedRows)).not.toContain("SECRET_BODY");
    for (const stored of storedRows) expect(Object.keys(stored)).not.toContain("content");
  });
});

describe("Tool-Search config state", () => {
  function writeCatalog(): void {
    writeFile(
      path.join(claudeDir, "plugins", "installed_plugins.json"),
      JSON.stringify([
        { name: "alpha", description: "First plugin" },
        { name: "beta", description: "Second plugin" },
      ]),
    );
  }

  function stateRow(): Record<string, unknown> {
    const row = db
      .prepare(
        "SELECT * FROM context_inventory WHERE workspace_id = ? AND component = 'SETTINGS_SYSTEM'",
      )
      .get(GLOBAL_WORKSPACE_ID) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("expected Tool-Search state row");
    return row;
  }

  it.each([
    ["unset defaults to deferred", {}, "deferred", "deferred", 0],
    ["true selects deferred", { env: { ENABLE_TOOL_SEARCH: "true" } }, "deferred", "deferred", 0],
    [
      "auto selects threshold mode",
      { env: { ENABLE_TOOL_SEARCH: "auto:5" } },
      "threshold",
      "threshold",
      0,
    ],
    [
      "false selects upfront mode",
      { env: { ENABLE_TOOL_SEARCH: "false" } },
      "disabled",
      "upfront",
      0,
    ],
    [
      "alwaysLoad overrides deferred mode",
      {
        env: { ENABLE_TOOL_SEARCH: "true" },
        mcpServers: { core: { alwaysLoad: true }, optional: { alwaysLoad: false } },
      },
      "deferred",
      "alwaysLoad",
      1,
    ],
    [
      "denying ToolSearch records disabled mode",
      { env: { ENABLE_TOOL_SEARCH: "true" }, permissions: { deny: ["ToolSearch"] } },
      "disabled",
      "upfront",
      0,
    ],
  ] as const)("records %s", (_label, settings, mode, effective, alwaysLoadCount) => {
    writeCatalog();
    writeFile(path.join(claudeDir, "settings.json"), JSON.stringify(settings));

    runContextProbe(db, NOW, { claudeDir });

    const row = stateRow();
    expect(row.tokens).toBe(0);
    expect(row.file_ref).toBe(path.join(claudeDir, "settings.json"));
    expect(row.attribution_version).not.toContain("First plugin");
    expect(row.attribution_version).not.toContain("Second plugin");

    const state = parseToolSearchState(row.attribution_version as string);
    expect(state?.tool_search_mode).toBe(mode);
    expect(state?.effective_catalog_state).toBe(effective);
    expect(state?.always_load_count).toBe(alwaysLoadCount);
    expect(state?.catalog_item_count).toBe(2);
    expect(state?.catalog_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(state?.always_load_flags.every((flag) => !flag.server_id_hash.includes("core"))).toBe(
      true,
    );
  });

  it("counts always-load servers beyond the persisted 256-flag cap", () => {
    writeCatalog();
    const mcpServers: Record<string, { alwaysLoad: boolean }> = {};
    // 260 non-always-load servers sort ahead of the always-load ones and fill the
    // 256-flag persisted cap, pushing the always-load servers outside the slice.
    for (let i = 0; i < 260; i++) {
      mcpServers[`aaa-${String(i).padStart(3, "0")}`] = { alwaysLoad: false };
    }
    mcpServers["zzz-core-1"] = { alwaysLoad: true };
    mcpServers["zzz-core-2"] = { alwaysLoad: true };
    writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "true" }, mcpServers }),
    );

    runContextProbe(db, NOW, { claudeDir });

    const state = parseToolSearchState(stateRow().attribution_version as string);
    expect(state?.always_load_flags_truncated).toBe(true);
    expect(state?.always_load_flags.length).toBe(256);
    // The persisted slice is all non-always-load, but the count and derived
    // catalog state must reflect the full set, not the truncated flags.
    expect(state?.always_load_count).toBe(2);
    expect(state?.effective_catalog_state).toBe("alwaysLoad");
  });

  it("stores stable state metadata without settings content and round-trips its encoding", () => {
    const state = {
      tool_search_mode: "deferred" as const,
      effective_catalog_state: "alwaysLoad" as const,
      configured_value: "true",
      always_load_flags: [{ server_id_hash: "a".repeat(16), always_load: true }],
      always_load_count: 1,
      always_load_flags_truncated: false,
      catalog_item_count: 3,
      catalog_item_count_truncated: false,
      catalog_hash: "b".repeat(40),
    };
    expect(parseToolSearchState(encodeToolSearchState(state))).toEqual(state);
  });
});

// ── T4: context_inventory_history ─────────────────────────────────────────────

describe("context_inventory_history — append-on-change", () => {
  function historyRows(): Array<Record<string, unknown>> {
    return db.prepare("SELECT * FROM context_inventory_history ORDER BY id").all() as Array<
      Record<string, unknown>
    >;
  }

  it("appends a history row on first probe (new source)", () => {
    writeFile(path.join(claudeDir, "CLAUDE.md"), "v1 content");

    runContextProbe(db, NOW, { claudeDir });

    const hist = historyRows();
    expect(hist.length).toBe(1);
    expect(hist[0]?.component).toBe("CLAUDE_MD");
    expect(hist[0]?.workspace_id).toBe(GLOBAL_WORKSPACE_ID);
    expect(hist[0]?.observed_at).toBe(NOW.toISOString());
  });

  it("appends a second history row when file_hash changes", () => {
    writeFile(path.join(claudeDir, "CLAUDE.md"), "v1 content");
    runContextProbe(db, NOW, { claudeDir });

    // Change the file content → different hash
    writeFile(path.join(claudeDir, "CLAUDE.md"), "v2 content — different");
    const NOW2 = new Date("2026-01-09T00:00:00.000Z");
    runContextProbe(db, NOW2, { claudeDir });

    const hist = historyRows();
    expect(hist.length).toBe(2);
    expect(hist[1]?.observed_at).toBe(NOW2.toISOString());
  });

  it("does NOT append a history row when file_hash is unchanged", () => {
    const content = "same content — no change";
    writeFile(path.join(claudeDir, "CLAUDE.md"), content);

    runContextProbe(db, NOW, { claudeDir });
    // Same content, second probe
    runContextProbe(db, new Date("2026-01-09T00:00:00.000Z"), { claudeDir });

    const hist = historyRows();
    // Only one history row despite two probes
    expect(hist.length).toBe(1);
  });

  it("keeps no-change probes quiet and appends a reversion after old history is compacted", () => {
    const filePath = path.join(claudeDir, "CLAUDE.md");
    writeFile(filePath, "v1 content");
    runContextProbe(db, NOW, { claudeDir });
    writeFile(filePath, "v2 content");
    runContextProbe(db, new Date("2026-01-09T00:00:00.000Z"), { claudeDir });

    const compacted = compactContextHistory(db, new Date("2026-05-01T00:00:00.000Z"), {
      maxAgeDays: 1,
      maxUnprotectedRowsPerSource: 0,
    });
    expect(compacted).toMatchObject({ ok: true, summary: { rows_deleted: 1, rows_after: 1 } });

    runContextProbe(db, new Date("2026-05-02T00:00:00.000Z"), { claudeDir });
    expect(historyRows()).toHaveLength(1);

    writeFile(filePath, "v1 content");
    runContextProbe(db, new Date("2026-05-03T00:00:00.000Z"), { claudeDir });
    const history = historyRows();
    expect(history).toHaveLength(2);
    expect(history[1]?.file_hash).toBe(expectedHash("v1 content"));
  });

  it("history row mirrors context_inventory column values", () => {
    const content = "ABC";
    writeFile(path.join(claudeDir, "CLAUDE.md"), content);
    runContextProbe(db, NOW, { claudeDir });

    const hist = historyRows();
    expect(hist.length).toBe(1);
    const h = requireRow(hist, "history row");
    expect(h.workspace_id).toBe(GLOBAL_WORKSPACE_ID);
    expect(h.component).toBe("CLAUDE_MD");
    expect(h.tokens).toBe(expectedTokens(content));
    expect(h.attribution_version).toBe("chars4-v1");
    // file_hash must be a 40-char sha1 hex
    expect(typeof h.file_hash).toBe("string");
    expect((h.file_hash as string).length).toBe(40);
  });
});

// ── T4: enabledPlugins exclusion ──────────────────────────────────────────────

describe("buildPluginCatalog — enabledPlugins exclusion", () => {
  it("excludes a plugin set to false in settings.json enabledPlugins (array format)", () => {
    const pluginsDir = mkDir(claudeDir, "plugins");
    writeFile(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify([
        { name: "plugin-enabled", description: "Kept" },
        { name: "plugin-disabled", description: "Removed" },
      ]),
    );
    writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "plugin-disabled": false } }),
    );

    runContextProbe(db, NOW, { claudeDir });

    const catalogRow = db
      .prepare(
        "SELECT tokens FROM context_inventory WHERE workspace_id = ? AND component = 'MCP_SCHEMAS'",
      )
      .get(GLOBAL_WORKSPACE_ID) as { tokens: number } | undefined;

    // Only the enabled plugin's catalog line counts
    const expected = "plugin:plugin-enabled Kept";
    expect(catalogRow?.tokens).toBe(expectedTokens(expected));
  });

  it("excludes a plugin set to false in settings.json enabledPlugins (object format)", () => {
    const pluginsDir = mkDir(claudeDir, "plugins");
    writeFile(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({ "plugin-a": { description: "Alpha" }, "plugin-b": { description: "Beta" } }),
    );
    writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "plugin-b": false } }),
    );

    runContextProbe(db, NOW, { claudeDir });

    const catalogRow = db
      .prepare(
        "SELECT tokens FROM context_inventory WHERE workspace_id = ? AND component = 'MCP_SCHEMAS'",
      )
      .get(GLOBAL_WORKSPACE_ID) as { tokens: number } | undefined;

    const expected = "plugin:plugin-a Alpha";
    expect(catalogRow?.tokens).toBe(expectedTokens(expected));
  });

  it("includes all plugins when settings.json is absent", () => {
    const pluginsDir = mkDir(claudeDir, "plugins");
    writeFile(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify([{ name: "my-plugin", description: "Works" }]),
    );
    // No settings.json written

    runContextProbe(db, NOW, { claudeDir });

    const catalogRow = db
      .prepare("SELECT COUNT(*) AS n FROM context_inventory WHERE component = 'MCP_SCHEMAS'")
      .get() as { n: number };
    expect(catalogRow.n).toBe(1);

    const tokenRow = db
      .prepare(
        "SELECT tokens FROM context_inventory WHERE workspace_id = ? AND component = 'MCP_SCHEMAS'",
      )
      .get(GLOBAL_WORKSPACE_ID) as { tokens: number } | undefined;
    const expected = "plugin:my-plugin Works";
    expect(tokenRow?.tokens).toBe(expectedTokens(expected));
  });

  it("includes all plugins when enabledPlugins is absent from settings.json", () => {
    const pluginsDir = mkDir(claudeDir, "plugins");
    writeFile(
      path.join(pluginsDir, "installed_plugins.json"),
      JSON.stringify([{ name: "my-plugin", description: "Works" }]),
    );
    writeFile(path.join(claudeDir, "settings.json"), JSON.stringify({ theme: "dark" }));

    runContextProbe(db, NOW, { claudeDir });

    const tokenRow = db
      .prepare(
        "SELECT tokens FROM context_inventory WHERE workspace_id = ? AND component = 'MCP_SCHEMAS'",
      )
      .get(GLOBAL_WORKSPACE_ID) as { tokens: number } | undefined;
    expect(tokenRow?.tokens).toBe(expectedTokens("plugin:my-plugin Works"));
  });
});
