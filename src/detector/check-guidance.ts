/**
 * src/detector/check-guidance.ts — the plain-English fix guidance for every setup-grade check
 * (operator 2026-10-14: each "To reach X" item must say what counts, what to do and when it is
 * done, like the allow-all Bash item). Display only; nothing here changes a score.
 *
 * `measured`: what the check looks at, in words a user can act on.
 * `done_when`: the pass bar; keep it in step with the check's `scoring.pass` (a test pins this).
 * `how_to`: steps for checks whose registry entry has none.
 */

export interface CheckGuidance {
  measured: string;
  done_when: string;
  how_to?: readonly string[];
}

const RELOAD = "Reload this page to re-grade.";

export const CHECK_GUIDANCE: Readonly<Record<string, CheckGuidance>> = {
  degraded_context: {
    measured:
      "Main-thread turns sent with the context window at least 70% full (140k tokens on a 200k window, 400k on a 1M window), over the last 30 days.",
    done_when: `5% of turns or fewer run that full. ${RELOAD}`,
    how_to: [
      "Run /clear when you start a new task instead of carrying the old one along.",
      "Check /context during long work and clear or compact before it passes 70%.",
      "Hand searches and research to a subagent: it reads in its own window and returns a short summary.",
    ],
  },
  compaction_rate_long: {
    measured:
      "Sessions of 60+ turns that compacted (by /compact or auto-compact), over the last 30 days.",
    done_when: `25% of long sessions or fewer compact. ${RELOAD}`,
    how_to: [
      "At a task boundary, have Claude write progress to a plan or notes file, then /clear instead of compacting.",
      "Split big work into separate sessions, one task each.",
    ],
  },
  long_session_share: {
    measured: "Sessions that ran 150 turns or more, over the last 30 days.",
    done_when: `10% of sessions or fewer reach 150 turns. ${RELOAD}`,
    how_to: [
      "Keep one task per session and /clear between tasks.",
      "Save progress to a plan file before clearing so nothing is lost.",
    ],
  },
  claude_md_lean: {
    measured: "The longest CLAUDE.md file found in ~/.claude and your project folders, in lines.",
    done_when: `Every CLAUDE.md is 200 lines or fewer. ${RELOAD}`,
    how_to: [
      "Keep only rules Claude needs every session; move reference detail into separate docs or skills.",
      "Point to those docs with a short line (or an @path import) instead of pasting them in.",
    ],
  },
  memory_lean: {
    measured: "The longest auto-memory index (MEMORY.md) across your projects, in lines.",
    done_when: `Every MEMORY.md is 200 lines or fewer. ${RELOAD}`,
    how_to: [
      "Keep MEMORY.md as one-line pointers; put the detail in the linked memory files.",
      "Delete memories that are resolved, stale or duplicated.",
    ],
  },
  subagent_use: {
    measured: "Sessions of 20+ turns that used at least one subagent, over the last 30 days.",
    done_when: `30% or more of those sessions use a subagent. ${RELOAD}`,
    how_to: [
      'Ask for it directly: "use a subagent to find where X is handled".',
      "Define agents for work you delegate often (/agents), so Claude reaches for them on its own.",
    ],
  },
  custom_agents_defined: {
    measured: "Agent definitions in ~/.claude/agents or a project's .claude/agents folder.",
    done_when: `At least 1 agent is defined. ${RELOAD}`,
    how_to: [
      "Run /agents and create one for a task you delegate often (code review, search, test runs).",
      "Give it a clear description so Claude knows when to use it, and a cheaper model when the work is simple.",
    ],
  },
  opus_share: {
    measured: "Main-thread turns answered by an Opus model, over the last 30 days.",
    done_when: `50% of turns or fewer run on Opus. ${RELOAD}`,
    how_to: [
      'Make Sonnet the default ("model": "sonnet" in ~/.claude/settings.json, or /model) and switch to Opus for hard problems.',
      "Give subagents a cheaper model in their definition (model: sonnet or haiku).",
    ],
  },
  mid_session_model_switch: {
    measured: "Sessions of 5+ turns that used more than one model on the main thread.",
    done_when: `10% of sessions or fewer switch models. ${RELOAD}`,
    how_to: [
      "Pick the model when the session starts; to change it, /clear and start fresh.",
      "To use a different model for part of the work, hand that part to a subagent with its own model.",
    ],
  },
  model_mix: {
    measured:
      "Distinct model families (Opus, Sonnet, Haiku) used on the main thread, over the last 30 days.",
    done_when: `2 or more model families in use. ${RELOAD}`,
    how_to: [
      "Use Sonnet for routine work and Opus for hard reasoning, chosen per session with /model.",
    ],
  },
  no_allow_all_bash: {
    measured:
      'Allow rules of "Bash", "Bash(*)" or "*" in ~/.claude/settings.json and every project\'s .claude/settings.json.',
    done_when: `No settings file holds an allow-all Bash rule. ${RELOAD}`,
  },
  safe_default_mode: {
    measured:
      '"defaultMode": "bypassPermissions" in ~/.claude/settings.json or any project\'s settings.',
    done_when: `No settings file defaults to bypassPermissions. ${RELOAD}`,
  },
  secrets_deny_rule: {
    measured:
      "A deny rule in your settings that covers .env files, secrets, credentials or key files.",
    done_when: `At least 1 such deny rule exists. ${RELOAD}`,
    how_to: [
      'In ~/.claude/settings.json add: "permissions": { "deny": ["Read(./.env)", "Read(./.env.*)", "Read(./secrets/**)"] }.',
      "Add any other key or credential paths your projects use.",
    ],
  },
  hooks_guard_tools: {
    measured: "PreToolUse hook commands in your user or project settings.",
    done_when: `At least 1 PreToolUse hook is configured. ${RELOAD}`,
    how_to: [
      'Add a PreToolUse hook (matcher "Bash") that runs a script and exits with code 2 to block a command shape you never want, such as force-push.',
      "Run /hooks to add one interactively.",
    ],
  },
  verify_test_loop: {
    measured:
      "Sessions that edited files (Edit, Write, MultiEdit, NotebookEdit) and also ran a test from Bash or PowerShell: npm/pnpm/yarn test or a test*/verify* script, vitest, jest, playwright test, pytest, cargo/go/dotnet test and the like, anywhere in a chained command. Typecheck and lint alone don't count, and neither do tests run outside Claude (by you, CI or another tool).",
    done_when: `50% or more of editing sessions run a test. ${RELOAD}`,
    how_to: [
      'Give every repo one command that runs its tests (for example a "test" or "verify" script).',
      'Add a line to each project\'s CLAUDE.md: "Run npm test before you say a change is done."',
      "For a hard guarantee, add a Stop hook that runs the tests and blocks finishing while they fail.",
    ],
  },
  explore_before_edit: {
    measured:
      "Editing sessions with 3+ reads or searches, or a subagent or plan-mode exit, before the first edit, and no edit rejected for not reading the file first.",
    done_when: `80% or more of editing sessions explore first. ${RELOAD}`,
    how_to: [
      "Start changes in plan mode (Shift+Tab) so Claude reads and plans before editing.",
      'Or ask it to "read the relevant files first, then make the change".',
    ],
  },
  verification_hook: {
    measured: "PostToolUse, Stop or SubagentStop hook commands in your user or project settings.",
    done_when: `At least 1 such hook is configured. ${RELOAD}`,
    how_to: [
      'Add a PostToolUse hook on "Edit|Write" that runs your formatter or type checker.',
      "Or a Stop hook that runs the tests before Claude finishes.",
    ],
  },
  claude_md_coverage: {
    measured: "Your projects that have a CLAUDE.md file.",
    done_when: `70% or more of your projects have one. ${RELOAD}`,
    how_to: ["Open Claude Code in each project without one and run /init, then trim the result."],
  },
  skills_defined: {
    measured:
      "Skills in ~/.claude/skills, a project's .claude/skills folder, or an installed plugin.",
    done_when: `At least 1 skill is defined. ${RELOAD}`,
    how_to: [
      "Turn a workflow you repeat into a skill: a folder with a SKILL.md that says when to use it and the steps.",
    ],
  },
  memory_enabled: {
    measured: "Auto-memory folders (~/.claude/projects/<project>/memory) that have content.",
    done_when: `At least 1 project has memory. ${RELOAD}`,
    how_to: [
      'Check auto memory is on with /memory, then ask Claude to "remember" a fact worth keeping.',
    ],
  },
  mcp_footprint: {
    measured: "MCP servers configured at user level plus servers from enabled plugins.",
    done_when: `5 MCP servers or fewer. ${RELOAD}`,
    how_to: [
      "List them with `claude mcp list` and remove ones you rarely use (`claude mcp remove <name>`).",
      "Disable plugins you don't need with /plugin; add a server to a single project's .mcp.json instead of everywhere.",
    ],
  },
  hooks_configured: {
    measured: "Hook commands of any kind in your user or project settings.",
    done_when: `At least 1 hook is configured. ${RELOAD}`,
    how_to: ["Run /hooks and add one, for example a PostToolUse hook that formats edited files."],
  },
  cache_read_health: {
    measured:
      "Share of input tokens read from the prompt cache instead of sent fresh, over the last 30 days.",
    done_when: `85% or more of input tokens come from cache. ${RELOAD}`,
    how_to: [
      "Don't change the model, CLAUDE.md or MCP servers mid-session; each change rebuilds the cache.",
      "Resume within a few minutes or start fresh; a long pause lets the cache expire.",
    ],
  },
  interrupt_rate: {
    measured:
      "Times you stopped Claude mid-turn (Esc) per 100 of your messages, over the last 30 days.",
    done_when: `5 or fewer interrupts per 100 messages. ${RELOAD}`,
    how_to: [
      "Put the full ask and the done-criteria in the first prompt.",
      "Agree on a plan in plan mode (Shift+Tab) before Claude starts changing things.",
    ],
  },
  edit_survival: {
    measured:
      "Share of the lines committed from your Claude sessions that are still in the code 14 days after the commit. Only commits at least 14 days old count.",
    done_when: `80% or more of committed lines survive 14 days. ${RELOAD}`,
    how_to: [
      "Have Claude run the tests and check the result before it commits, not after.",
      "Agree on the approach in plan mode (Shift+Tab) before large changes, so the first version is the one you keep.",
    ],
  },
  autonomy_depth: {
    measured: "Claude's steps (model responses, usually one tool call each) per message you send.",
    done_when: `10 or more steps per message. ${RELOAD}`,
    how_to: [
      "Hand over whole tasks with clear success criteria instead of one step at a time.",
      "Pre-approve routine commands (or use auto mode) so Claude isn't stopped for each one.",
    ],
  },
  denial_rate: {
    measured:
      "Tool calls blocked by a deny rule or hook, or rejected by you, per 100 of your messages.",
    done_when: `2 or fewer denials per 100 messages. ${RELOAD}`,
    how_to: [
      "Find the rule or hook that blocks most often and tell Claude about it in CLAUDE.md so it stops trying.",
      "If you keep rejecting the same safe command, add a narrow allow rule for it.",
    ],
  },
};
