# ADR-112: SEC-101 — runtime at-rest ban → distribution-boundary control

**Status:** Accepted · **Date:** 2026-09-19
**Decision of record:** `docs/plans/Archive/PRODUCT-DIRECTION.md` §11 (operator, 2026-09-18).
**Implementing spec:** `docs/plans/Archive/spec-sec101-rescope.md`. **Registry:** `docs/plans/Archive/00-RECOVERY-PLAN.md` §Phase-3.

## Decision

Rescope SEC-101 from a **runtime at-rest ban** — "no raw transcript/PR content in any DB row or UI;
aggregates, ids, counts, structural anchors only" — to a **distribution-boundary control**: **no
*developer* transcript/PR content ever reaches a commit or the public npm/GitHub export**, enforced
hard at the boundary (pre-commit content scan, fixture CI gate, `export.mjs`). The local daemon DB
MAY retain the **targeted content slices** a named detector/handler consumes (not full transcripts).

Do **not** remove SEC-101. Move it.

## Context

The single most recurring blocker to useful recommendation output — hit a dozen-plus times — was
"the data is in the transcripts but SEC-101 discarded it." The pasted investigation prompt gave
Claude *less* than the card already showed, because the runtime dropped the content grounding
requires (PRODUCT-DIRECTION.md §6/§7.1). SEC-101 conflated two separable concerns with **opposite
reversibility**:

- **(A) Raw content at rest in the user's local DB.** For a local-only app this is not a new
  exposure: `~/.agentwrangler/db.sqlite` and `~/.claude/…` share one trust boundary (one disk, one
  OS account); the transcripts are the more canonical copy. Anyone who can read the DB can already
  read the transcripts. Retaining targeted slices onto the user's own machine leaks nothing to
  anyone. Reversible — retained content is purgeable by a local migration.
- **(B) The *developer's* own content escaping into commits / the public export.** The real,
  irreversible risk (git history, shipped npm package). Independent of whether the runtime DB holds
  content. NOT reversible once distributed.

## Precondition (explicit, load-bearing)

**Local-only.** This decision holds ONLY while the DB stays on the user's machine. If AgentWrangler
ever adds share / sync / backup / cloud / telemetry — anything that moves the DB off-machine — the
retained-content DB changes from "same boundary as the transcripts" to a genuine egress surface, and
**this ADR must re-open** with explicit content-egress gating before that feature ships.

## Consequences

- Drop (A) as a runtime ban; enforce (B) hard at the distribution boundary. Sequence **W-B first**
  (harden the boundary before any content is retained) → **W-A** (targeted-slice retention +
  allow-list register) → **W-C** (user-side secrets filter, parallel to W-A). See spec §W-B/W-A/W-C.
- The pre-commit / CI / export gates gain a **raw-content scan** (transcript-JSONL shape,
  high-entropy blobs, oversized single-line dumps); `trufflehogGate` becomes **fail-closed** in the
  publish path. This is real gate engineering — the §8 "SEC-101 privacy layer" KEEP row is now
  "SEC-101 *distribution-boundary* layer" and is no longer "cheap to finish."
- The `ALLOWLIST` in `test/daemon/sec101.test.ts` becomes the **single audit register** of where
  content is deliberately retained; every retained column names its consuming detector/handler. The
  column-name guard and serialization tripwire stay green **by design**, never by weakening them.
- Retention is **targeted slices, never whole transcripts** — smaller on-disk secret footprint, and
  every retained field traces to a declared consumer (mirrors the §6 grounding standard). A slice
  with no consuming lane is not retained.
- Downstream: supersedes the "aggregates/ids/counts only" framing in PRODUCT-DIRECTION.md §2 and the
  "empty prompt is the privacy contract working" premise in §6/§7.1 — those failure modes were the
  runtime ban biting.

## Accepted residuals (W-B content gate)

Two independent adversarial reviews (2026-09-19) hardened the W-B content gate and surfaced residual
limits, accepted here for a **local-only** app with human review plus the independent trufflehog
oracle at export:

- **Transcript-shape carve-out for `docs/` and `test/fixtures/ingest/`.** These are the only tree
  locations that legitimately hold transcript-shaped JSON (doc examples, synthetic ingest fixtures);
  the strict any-length rule would false-positive there. Inside them, a *short* real transcript pasted
  as "test data" evades the shape check (it is still caught if oversized / high-entropy / PEM). The
  proper backstop — a synthetic-provenance assertion over `test/fixtures/ingest/` (mirroring the u12
  fixture gate) — is **W-A fixture-posture work**; until then the process rule "committed test data is
  synthetic, never a real transcript" plus review is load-bearing. The carve-out is kept as narrow as
  the tree requires.
- **Shared detector across the three gates.** Pre-commit, CI, and export share one signature module,
  so CI defends the `--no-verify` *bypass* axis, not the *detection* axis. Transcript detection at the
  boundary is a heuristic tripwire, not a proof of absence.
- **Pretty-printed / multi-line transcript JSON and UTF-16-without-BOM files** evade the line-oriented
  shape check (caught only if oversized/entropy/PEM). Commit/CI secret coverage beyond the PEM header
  is deferred to trufflehog (fail-closed at `--push`) and W-C's retention-time filter.

These residuals are the reason W-C and the trufflehog fail-closed gate are part of the rescope, not
optional extras. If the local-only precondition above is ever lifted, they must be re-evaluated.

## Alternatives considered

- **Full removal of SEC-101.** Rejected: buys nothing extra for a local app and pays the full
  one-way-door cost — content in users' DBs / git history / npm export is irreversible.
- **Keep the runtime ban; ground prompts on aggregates only.** Rejected as the status quo that
  produced "worse than just asking Claude": the aggregates cannot carry instance-level diagnosis the
  card already displays.

## Amendment 2026-10-13 — "Judge me" setup-review egress

**Status:** Accepted (operator, 2026-10-13; table widened 2026-10-13 after a usefulness check on real
config: per-check values + sample, hook script basename, full CLAUDE.md). **Decision of record:** `docs/plans/00-MASTER-PLAN.md`
JMS-P2 row; plan `docs/plans/2026-10-12-001-feat-judge-my-setup-plan.md` U7–U10. **Implements:**
`src/query/api/judge-payload.ts` (frozen allow-list + builder) and its path/username scrubber sibling.

### Surface

A second off-machine egress surface, distinct from the local DB, the public export and the Gauge-1
packet: the **judge-my-setup payload** sent when the user clicks "Judge me" on the Rate my setup tab
and approves the consent screen. It is NOT transcript content and NOT the DB.

**Transport.** The daemon runs the user's own installed, unmodified `claude` CLI in print mode, payload
on stdin, tools and MCP disabled for the call. Anthropic's terms do not let a third-party app use the
Claude Code OAuth token (`.claude/audits/2026-10-13-jms-p2-terms.md`), so AgentWrangler never reads,
stores or sends that token for this feature; the CLI authenticates through Anthropic's own sign-in.
Usage bills to the user's own plan.

### Decision

The payload may carry only:

| Source | Sent | Never sent |
|---|---|---|
| Scorecard | check ids, pass/fail/partial, measured value and sample size per check, category and tier results, rubric version | dollar evidence rows, session ids |
| MCP servers | name, transport, local/remote | args, env, headers, URLs |
| Hooks | event, matcher, program basename, script file basename | full command, other args, inline env, paths, URLs |
| Settings `env` | key names | values |
| CLAUDE.md files | full text after secrets block + path/username/email/IP/hostname scrub (safety cap ~50k chars per file, marked truncated) | anything over the safety cap |
| Auto-memory files | nothing | all content |
| Transcripts | nothing | all content |

`judge-payload.ts` throws on any key absent from the allow-list. New fields require this amendment to
be updated first.

### Safety basis

- **Narrow by exclusion.** Value-bearing fields (env values, headers, args, URLs) are excluded, not
  scrubbed: the secrets filter's quoted-JSON-key gap means scrubbing them is not reliable.
- **Detect, then block.** A secrets detect pass runs on each raw excerpt first. Any typed-pattern or
  entropy hit **blocks the send** and shows the match class. Redaction only applies to what remains.
- **Path and identity scrub** on all free text: every Windows/POSIX/WSL/UNC/OneDrive/escaped/URL-encoded
  spelling of the home path, the bare username, email local-part, emails, IPs, hostnames.
- **Fail closed.** Unlisted key → throw. Detect hit → no send.
- **User-initiated and consented.** Nothing is sent without a click on "Judge me" plus approval of the
  exact payload shown on screen, or a standing "don't ask again" bound to a hash of the excerpt set
  (any config change re-prompts). The daemon rebuilds the payload server-side; the browser never
  supplies it.
- **User's own account**, through the user's own `claude` CLI. No AgentWrangler server, key or relay.
- **Never logged.** The payload and raw model text are not written to logs. Only the validated verdict,
  the grade-snapshot id and the payload **hash** are stored. The verdict never changes any score.

### Re-open clause

The local-only precondition above is unchanged. This amendment re-opens if the payload gains any
field outside the table, if the transport changes (direct API call, other credential, any relay), or
if verdicts or payloads are ever shared, synced or exported.

## Amendment 2026-09-25 — in-app content restrictions removed

**Status:** Accepted (operator, 2026-09-25). Supersedes the "targeted slices only / named consumer /
allow-list register" consequences above.

**Decision.** Inside the app there is no content restriction: the local DB, the API and the UI may
store and show transcript content (error text, commands, file sections, prompts) wherever it makes a
recommendation more useful. Rationale: local-only app; the transcripts already sit on the same disk
under the same account, so a copy in `~/.agentwrangler/db.sqlite` adds no exposure. The runtime
restrictions (closed-vocabulary recommendation contracts, content-rejecting triggers, the
column-name guard) repeatedly stripped information the app needs and are to be removed.

**Kept, unchanged:** the distribution boundary — no developer transcript/PR content in any commit or
the public npm/GitHub export (pre-commit content scan, fixture CI gate, `export.mjs`, trufflehog
fail-closed at `--push`). The local-only precondition above stays load-bearing: any share / sync /
backup / cloud / telemetry feature re-opens this decision.

**Scope test (operator):** remove every content restriction that limits the app's usefulness.
Applied: the W-C secrets filter stays (it redacts credentials only, no usefulness cost); the opt-in
Gauge-1 prompt arm is an off-machine egress, not an in-app restriction, and keeps its allow-list.

## Amendment 2026-09-21 — Gauge-1 parity egress widened to friction counts

**Status:** Accepted · **Decision of record:** `docs/plans/Archive/00-EXECUTION-PLAN-DW.md` §2 (Update
2026-09-21). **Implements:** `scripts/parity/sec101-allow-list.ts` (`METRIC_FIELDS_BY_CODE`),
`scripts/parity/gauge1.ts` (`querySessionMetrics`).

### Surface

This amendment governs a distinct egress surface from the body above: the **Gauge-1 parity
evidence packet** — the only place a metric leaves the machine, via the opt-in Claude-prompt arm
(`gauge1.ts` `defaultPromptArmFn`, default OFF). It is NOT the local daemon DB and NOT the public
export; `buildSafePacket` throws on any field absent from the frozen allow-list.

### Decision

The packet was **spend-only** (D1/D2/D4/D6/D8/D10 + anchors), so the two-gauge harness could not
measure the friction detectors (C2–C11, D14, H1) even though they fire. Widen the allow-list to
carry friction **counts keyed by CLOSED enums** so the H2 golden set can reach real 15–25 detector
breadth. Added fields (each a count, filed under its consuming detector code):

| Code | Fields | Source column (closed enum) |
|---|---|---|
| C2 | `err_NOT_FOUND` | `tool_events.tool_error_class` |
| C3 | `err_NOT_READ` | `tool_events.tool_error_class` |
| C4 | `err_STALE_STRING`, `err_PATCH_FAILED` | `tool_events.tool_error_class` |
| C5 | `tool_error_count` (all classes, this session) | `tool_events.tool_error_class` |
| C7 | `bashfail_BASH_GIT/_NPM/_PYTHON/_TEST/_BUILD/_OTHER` | `tool_events.bash_command_family` |
| C9 | `denial_count` + `denial_interrupt_cancel/_user_rejected/_hook_block/_deny_rule` | `ingest_metric_events.classifier_label` |
| C11 | `err_MCP_CONTENT_TOO_LARGE` | `tool_events.tool_error_class` |
| D14 | `interrupt_count` + `intr_PURE_INTERRUPT/_KILLED_NO_PROMPT/_HUMAN_DENY` | `tool_events.interrupt_kind` |
| H1 | `destructive_op_count` (total) | `ingest_metric_events.destructive_op` |

### Safety basis (reaffirmed, counts of closed labels only)

- **Every value is a count of a CHECK-/type-constrained closed enum.** The enums are fixed in the
  DB schema (`025_tool_error_classifier.sql`, `022_classifier_boundaries.sql`) and in the
  classifier types (`src/ingest/tool-error-classifier.ts`), which "never returns, hashes, or
  retains text." A count of a closed label carries no free text and no content-derived hash.
- **Per-class granularity is intentional** (operator-confirmed), not a single lumped total — the
  parity comparison needs to know *which* friction, not just how much.
- **`destructive_op_count` (H1) IS egressed** as a total; operator confirmed the closed
  destructive-op enum (`rm-rf/git-reset-hard/git-clean/sql-drop/truncate`) count is safe to send.
- **Local W-A command/error text slices are NOT egressed.** The retained `errorSlice` /
  command-text columns (W-A retention) stay on-machine; only counts of closed labels enter the
  packet. Egress remains gated to the opt-in prompt arm.
- **Fields are named keys in `METRIC_FIELDS_BY_CODE`** — never dynamic enrichment; `buildSafePacket`
  still refuses any unlisted key. New friction fields require this ADR + a named detector code.

The local-only precondition above is unchanged and remains load-bearing: if AgentWrangler ever
egresses beyond this opt-in parity arm, this amendment re-opens with the body.
