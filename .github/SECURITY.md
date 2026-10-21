# Security Policy

## Threat model — local-only by design

AgentWrangler runs entirely on your machine: a daemon bound to `127.0.0.1` and a browser UI that
talks only to that loopback address. It has **no cloud backend and sends no telemetry**. By default
the only outbound call is your own `claude` CLI's `/usage` (turn it off in Settings > Usage limits
from Claude Code, or set `AW_USAGE_CLI=off`); GitHub sync, Judge me and bytes-to-token calibration
are opt-in (see [docs/privacy.md](../docs/privacy.md)). Its data store is a local SQLite file (`~/.agentwrangler/db.sqlite`).

Because of this design, the security surface is deliberately small:

- The daemon listens only on `127.0.0.1` — it is reachable from other machines only if you
  deliberately expose the port (e.g. via a tunnel or reverse proxy). Don't.
- A read-only GitHub token (for the optional outcomes feature) is read from the `AW_GITHUB_TOKEN`
  environment variable or, on Windows, Windows Credential Manager, is never logged, and is never
  written to the database or surfaced in the UI (the Settings panel shows only *whether* a token
  is present).
- AgentWrangler may start your own `claude` CLI (Judge me, Open in Claude Code, `/usage`) with
  `ANTHROPIC_API_KEY` removed from its environment. It never sends your Claude login anywhere.
- The privacy invariant: developer transcript and PR content is never committed or
  published. The local database can hold secrets-filtered command text and error excerpts (see
  [docs/privacy.md](../docs/privacy.md)).

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public issue for a security
problem.

- Preferred: use GitHub's **private vulnerability reporting** ("Report a vulnerability" under the
  repository's **Security** tab), which opens a private advisory thread with the maintainers.

We aim to acknowledge a report within a few days and will coordinate a fix and disclosure timeline
with you.
