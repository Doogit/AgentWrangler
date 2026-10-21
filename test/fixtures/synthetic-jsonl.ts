/**
 * test/fixtures/synthetic-jsonl.ts — synthetic Claude Code JSONL + settings for the audit CLI fixtures.
 *
 * Everything is invented (SEC-101): titles come from the seeded sessions, paths are under a temp dir,
 * no real transcript content. JSONL is derived from the seeded DB so scan.mjs and pack.md describe the
 * same sessions. The waste profile adds a broken hook path (W4) in settings and in the JSONL.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";

interface SessionRow {
  session_id: string;
  title: string | null;
  slug: string;
  cwd: string | null;
}
interface TurnRow {
  message_id: string;
  ts: string;
  model: string;
  is_sidechain: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m: number;
  cache_write_1h: number;
  tool_name: string | null;
}

export function writeSyntheticJsonl(
  db: Database.Database,
  root: string,
  extra: (sessionId: string, cwd: string) => object[] = () => [],
): string[] {
  const sessions = db
    .prepare(
      `SELECT s.session_id, s.title, w.project_slug AS slug, w.discovered_cwd AS cwd
         FROM sessions s JOIN workspaces w ON w.workspace_id = s.workspace_id ORDER BY s.session_id`,
    )
    .all() as SessionRow[];
  const written: string[] = [];
  for (const s of sessions) {
    const cwd = s.cwd ?? `/work/${s.slug}`;
    const turns = db
      .prepare(
        `SELECT t.message_id, t.ts, t.model, t.is_sidechain, t.input_tokens, t.output_tokens,
                t.cache_read_tokens, t.cache_write_5m, t.cache_write_1h,
                (SELECT te.tool_name FROM tool_event_metadata m JOIN tool_events te ON te.event_id = m.event_id
                  WHERE m.owner_message_id = t.message_id LIMIT 1) AS tool_name
           FROM turns t WHERE t.session_id = ? ORDER BY t.ts`,
      )
      .all(s.session_id) as TurnRow[];
    if (turns.length === 0) continue;
    const base = {
      sessionId: s.session_id,
      cwd,
      gitBranch: "main",
      version: "2.1.0",
      userType: "external",
    };
    const first = turns[0]?.ts ?? new Date().toISOString();
    const lines: object[] = [
      {
        ...base,
        type: "user",
        isSidechain: false,
        promptSource: "typed",
        uuid: `${s.session_id}-u0`,
        timestamp: first,
        message: { role: "user", content: s.title ?? "Untitled task" },
      },
      {
        ...base,
        type: "attachment",
        isSidechain: false,
        uuid: `${s.session_id}-a0`,
        timestamp: first,
        attachment: {
          type: "skill_listing",
          skillCount: 2,
          isInitial: true,
          names: ["draft-notes", "tidy-commits"],
          content: "- draft-notes\n- tidy-commits",
        },
      },
      ...extra(s.session_id, cwd).map((a, i) => ({
        ...base,
        type: "attachment",
        isSidechain: false,
        uuid: `${s.session_id}-x${i}`,
        timestamp: first,
        attachment: a,
      })),
    ];
    for (const t of turns) {
      lines.push({
        ...base,
        type: "assistant",
        isSidechain: t.is_sidechain === 1,
        uuid: `${t.message_id}-r`,
        timestamp: t.ts,
        message: {
          id: t.message_id,
          role: "assistant",
          model: t.model,
          usage: {
            input_tokens: t.input_tokens,
            output_tokens: t.output_tokens,
            cache_read_input_tokens: t.cache_read_tokens,
            cache_creation_input_tokens: t.cache_write_5m + t.cache_write_1h,
          },
          content: t.tool_name
            ? [{ type: "tool_use", id: `tu-${t.message_id}`, name: t.tool_name, input: {} }]
            : [],
        },
      });
    }
    const dir = path.join(root, s.slug);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${s.session_id}.jsonl`);
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    written.push(file);
  }
  return written;
}

/** Waste profile files: JSONL (W4 hook errors in w-s4, a healthy hook elsewhere) and a settings.json with a broken hook path. */
export function writeWasteFiles(
  db: Database.Database,
  dir: string,
): { jsonlRoot: string; settingsPath: string; missingHook: string } {
  const hookDir = path.join(dir, "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  const goodHook = path.join(hookDir, "format-check.mjs");
  const missingHook = path.join(hookDir, "release-guard.mjs"); // never created: this is W4
  fs.writeFileSync(goodHook, "// synthetic hook\n");
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: `node "${missingHook}"` }] },
            { matcher: "Edit", hooks: [{ type: "command", command: `node "${goodHook}"` }] },
          ],
        },
      },
      null,
      2,
    ),
  );
  const jsonlRoot = path.join(dir, "projects");
  writeSyntheticJsonl(db, jsonlRoot, (sid) =>
    sid === "w-s4"
      ? [
          ...Array.from({ length: 30 }, () => ({
            type: "hook_non_blocking_error",
            hookName: "PreToolUse:Bash",
            hookEvent: "PreToolUse",
            command: `node "${missingHook}"`,
            stderr: `Error: Cannot find module '${missingHook}'`,
            exitCode: 1,
            durationMs: 41,
          })),
          {
            type: "hook_success",
            hookName: "PreToolUse:Edit",
            hookEvent: "PreToolUse",
            command: `node "${goodHook}"`,
            exitCode: 0,
            durationMs: 55,
          },
        ]
      : [],
  );
  return { jsonlRoot, settingsPath, missingHook };
}
