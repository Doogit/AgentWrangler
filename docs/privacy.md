# Privacy model

AgentWrangler is built around one invariant, enforced in code and CI and referred to
throughout the codebase as **SEC-101**:

> No raw transcript or PR content is ever persisted — not in the database, not in any
> committed file, not in the UI. Only aggregates, ids, counts, and structural anchors.

## Local-only by design

- The daemon binds to **`127.0.0.1`** only. The dashboard talks exclusively to that loopback
  address. There is no cloud backend, no telemetry, no account, and nothing phones home.
- All data lives in a local SQLite file: `~/.agentwrangler/db.sqlite`. Deleting that directory
  removes everything AgentWrangler knows.
- The daemon reads the transcripts Claude Code already writes to `~/.claude/projects` — it
  adds no instrumentation to your sessions.

## What is stored

Aggregates and structure only: token counts by flavor and model, timestamps, session and
workspace ids, turn counts, detector measurements (byte counts, event counts, shares), PR/commit
**identifiers** and their states, and file-position anchors used to resume ingestion.

## What is never stored

- Raw transcript text — no prompts, no responses, no tool outputs.
- PR titles, bodies, diffs, or review comments — only ids, numbers, and states.
- Credentials of any kind. The optional GitHub token is read from the environment (or the OS
  credential store) at use time, is never logged, and is never written to the database; the
  Settings panel shows only *whether* a token is present.

Even the screenshots and demo GIF committed to this repository follow the invariant — they are
captured from a sanitized fixture instance with anonymized names, never from live data.

## The two opt-in exceptions

Both are **off by default**, clearly labeled in the UI, and refuse to run unless you enable
them:

1. **Bytes→token calibration** (Settings → Bytes→token calibration). Sends ~150 sampled
   tool-output snippets to Anthropic's free token-counter API to calibrate estimate accuracy.
   This is text your Claude Code session already sent to Anthropic when it ran. Nothing is
   stored from the exchange except the resulting bytes-per-token ratio.
2. **G2 deferral judge** (`npm run evidence:judge-g2 -- --execute`, gated by the
   `g2_claude_judge_opt_in` setting). An evidence-validation CLI that calls the Claude API with
   your local Claude Code OAuth credential to adjudicate deferral findings. Without the opt-in
   it refuses to run; no rationale text is persisted.

Everything else works with zero network calls to anyone.

## Threat model and reporting

The daemon is reachable from other machines only if you deliberately expose the port (tunnel,
reverse proxy) — don't. For the full threat model and how to report a vulnerability privately,
see [SECURITY.md](../.github/SECURITY.md).
