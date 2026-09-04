# Security Policy

## Threat model — local-only by design

AgentWrangler runs entirely on your machine: a daemon bound to `127.0.0.1` and a browser UI that
talks only to that loopback address. It has **no cloud backend, sends no telemetry, and no data
leaves your machine**. Its data store is a local SQLite file (`~/.agentwrangler/db.sqlite`).

Because of this design, the security surface is deliberately small:

- The daemon listens only on `127.0.0.1` — it is reachable from other machines only if you
  deliberately expose the port (e.g. via a tunnel or reverse proxy). Don't.
- A read-only GitHub token (for the optional outcomes feature) is read from the `AW_GITHUB_TOKEN`
  environment variable or the OS credential store, is never logged, and is never written to the
  database or surfaced in the UI (the Settings panel shows only *whether* a token is present).
- The privacy invariant (SEC-101): no raw transcript or PR content is persisted — only aggregates,
  ids, counts, and structural anchors.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public issue for a security
problem.

- Preferred: use GitHub's **private vulnerability reporting** ("Report a vulnerability" under the
  repository's **Security** tab), which opens a private advisory thread with the maintainers.

<!-- operator: before public launch, add a direct contact channel here if desired. -->

We aim to acknowledge a report within a few days and will coordinate a fix and disclosure timeline
with you.
