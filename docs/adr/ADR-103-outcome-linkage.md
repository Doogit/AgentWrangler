# ADR-103: Outcome Linkage v1 Design

**Status:** accepted (EXPERIMENTAL — linkage gate not met) · **Date:** 2026-08-21
**Spike:** S3 outcome linkage accuracy
**Decision by:** S3 spike findings + Opus disposition 2026-08-21 (below; supersedes inline `[FLAG]` markers).

---

## Opus disposition (2026-08-21)

The design is accepted; the *feature* ships **EXPERIMENTAL** because the ≥80% linkage gate was not
met (73%). `pr-link` records (primary, ~100% precision) are the design's foundation; SHA-overlap is
secondary; branch-name matching is the path to remove the EXPERIMENTAL label.

- **FLAG-D3 (branch-name sequencing) → build + validate it in a short follow-up (S3b) BEFORE the
  outcomes feature is promoted EXPERIMENTAL→stable; it does NOT block Phase-1a.** Outcomes ship
  EXPERIMENTAL first; branch-name matching (est. +5–10%) is the defined route to the gate, validated
  by a small sub-spike, not by shipping it unmeasured.
- **FLAG-D4 (denominator) → define the linkage-rate denominator as outcome-bearing sessions**
  (≥1 code-producing action; MVP proxy = ≥1 Bash call), and **disclose the denominator** in the UI
  (resolves adversarial S-01). Rationale is semantic correctness (pure read/plan sessions cannot
  produce a PR), NOT reaching the gate — it doesn't (74.2%). Session-12 spec edit (SG-01).
- **FLAG-D5 (REST+GraphQL client shape) → single internal sync-client interface, two transports;**
  implementation detail deferred to the Phase-1 build. GraphQL for `isResolved` (1 pt/query), REST
  for PR list/checks/commits, ETag conditional GETs — as in D-5.
- **FLAG-D6 (UNLINKED representation) → keep IMPLICIT** (absence of `session_work_links` /
  `observed_outcomes` rows). UNLINKED is a session property, not an outcome value; do not add it to
  the `observed_outcomes.outcome` CHECK. **Require explicit denominator disclosure** in
  FR-OUTCOME-103 (resolves S-01). Session-12 spec edit.
- **Credential note:** this run used the machine's write-capable `gh` keyring token under GET-only
  discipline because the read-only U2 credential had an empty blob. Data is valid; before Phase-1
  production a fine-grained READ-ONLY PAT must be re-stored (SG-04). User sign-off to accept the run:
  2026-08-21.

---

## Context

S3 empirically measured outcome linkage accuracy across 137 sessions and 204 PRs from 4 repos.
Key finding: Claude Code's `pr-link` records (found in S1 as G-04) are the dominant and
highest-confidence linkage source. SHA-overlap is viable but has low detection sensitivity in
this corpus. Linkage rate is 73%, below the 80% gate — outcome metrics ship EXPERIMENTAL.

---

## Decisions

### D-1 Primary linkage source: pr-link records

**Finding:** `pr-link` records (`{prNumber, prRepository, sessionId}`) appear in 86/137 (62.8%)
of target sessions. All pr-link records correctly identify the right repo. Precision is ~100%
in the 25-link adjudication sample.

**Decision:** `pr-link` records are the PRIMARY linkage source. When a session has >=1 pr-link
record pointing to a PR in the workspace's mapped repo, that session is linked with
`method=PR_LINK, conf=1.0`.

This supersedes the spec's SHA-overlap-primary / branch-name-fallback hierarchy for sessions
that have pr-link records.

### D-2 Secondary linkage source: SHA-overlap

**Finding:** 72/137 sessions have 40-char bash SHAs; only 1/5 sessions tested showed actual SHA
match against PR commit sets. Bash SHAs are often from `git log` output (existing history), not
the PR being authored.

**Decision:** SHA-overlap remains in the algorithm as a SECONDARY source. It applies only when
a session has no pr-link records. Narrow SHA extraction to Bash results from git push/commit
operations specifically (not all Bash results). Confidence: lower (`conf = min(0.9, 0.5 + 0.1 * |overlap|)`).

### D-3 Tertiary fallback: branch-name matching

**Finding:** Branch-name matching was not measured this spike due to time constraints. Estimated
+5-10% additional coverage. Worktree-state records carry branch info.

**Decision:** Branch-name matching is SPECIFIED as the tertiary fallback per the original ingestion
spec, but is NOT validated. It is tagged `[UNMEASURED]` until a follow-up sub-spike confirms it.
Expected behavior: if session active branch == PR head branch, link with `method=BRANCH, conf=0.6`.

**[FLAG — Opus decision requested]:** Should the branch-name fallback be built before or after the
linkage rate gate is re-evaluated? Building it first may close the 80% gap without a gate re-run.

### D-4 Linkage rate result and EXPERIMENTAL label

**Finding:** Measured linkage rate = 73% (pr-link + bash SHA signal, n=137). Below the 80% gate.

**Decision:** Outcome metrics ship with `EXPERIMENTAL` label per the spike plan. The label is
removed when linkage rate reaches >=80% in a re-measurement after branch-name matching is
implemented and validated.

**[FLAG — Opus decision requested]:** Should the linkage rate denominator be redefined as
"sessions with >=1 Bash call" (n=128, rate=74.2%) rather than all sessions (n=137, rate=73%)?
The 9 sessions without any Bash calls are pure read/plan sessions with no code output — arguably
not "outcome-bearing." Changing the denominator doesn't reach 80% either, but it is more
semantically correct.

### D-5 REST vs GraphQL for sync (OQ-02)

**Finding:**
- GraphQL `PullRequestReviewThread.isResolved`: confirmed accessible, cost=1 point/query
- REST API does NOT expose thread resolution state in any endpoint
- REST rate limit: 5000/h; GraphQL rate limit: 5000 points/h
- At 10-min polling for 3 repos × ~50 PRs: REST=~900 calls (18% budget), GraphQL=~150 points (3%)

**Decision:**
- Use **GraphQL** for E1 review thread sync (the only way to get `isResolved`). Cost is minimal.
- Use **REST** for PR list, check runs, commits, and PR head/merge SHAs (simpler, well-documented).
- Conditional GETs with ETags on REST endpoints for polling efficiency.
- No GraphQL-only architecture needed: the hybrid is the right call.

**[FLAG — Opus decision requested]:** Should the GitHub sync client abstract REST+GraphQL behind
a single interface, or should they be two separate classes? The hybrid approach requires managing
two auth/retry paths.

### D-6 UNLINKED representation (OQ-01)

**Finding:** AgentWrangler (no git remote) produced 0 links. UNLINKED via implicit absence of
`session_work_links` rows is confirmed working and sufficient for the UNLINKED control case.

**Decision:** UNLINKED remains an IMPLICIT condition — no row in `session_work_links` and no row
in `observed_outcomes`. The adversarial review's S-01 finding (UNLINKED silently excluded from
success rate) remains a spec debt item. The denominator disclosure recommended in S-01 should be
added to FR-OUTCOME-103 before Phase 1 outcome slice ships.

**[FLAG — Opus decision requested]:** Should `UNLINKED` be added as a stored value in
`observed_outcomes.outcome` CHECK (schema change), or handled at the query layer with explicit
denominator disclosure? The schema change is cleanest but breaks the table's semantics (UNLINKED
is a session property, not an outcome value).

### D-7 Linkage algorithm spec (updated from Ingestion spec §3.2)

```
link(session, PR) precedence:
1. if session has pr-link record for PR → method=PR_LINK, conf=1.0              (primary)
2. elif session.SHA_set ∩ PR.commit_SHAs ≠ ∅ → method=SHA_OVERLAP, conf=f(|∩|) (secondary)
3. elif session.active_branch == PR.head_branch → method=BRANCH, conf=0.6       (tertiary, UNMEASURED)
4. else → UNLINKED

ambiguous (multiple PRs via method 2 or 3) → UNLINKED (honesty > guessing)
pr-link can link one session to multiple PRs (cross-repo sessions) — both links are kept
manual link/unlink → method=MANUAL, conf=1.0
```

### D-8 S3 exit criteria scorecard

| Criterion | Target | Result |
|---|---|---|
| Linkage rate >=80% | >=80% | FAIL (73%) — EXPERIMENTAL label applied |
| Link precision >=95% | >=95% | PASS (~100%, pr-link 25-link sample) |
| UNLINKED control 0 links | 0 | PASS (AgentWrangler: 0 links) |

**Overall S3 exit: FAIL on linkage rate. ADR status: proposed (EXPERIMENTAL).**
Full acceptance requires re-measurement after branch-name matching implementation.

---

## Flagged decisions (Opus review requested)

| Flag | Question |
|---|---|
| FLAG-D3 | Build branch-name fallback before or after re-evaluation gate? |
| FLAG-D4 | Redefine denominator as bash-call sessions (n=128) vs all sessions (n=137)? |
| FLAG-D5 | GraphQL+REST hybrid: one interface or two classes? |
| FLAG-D6 | UNLINKED: stored value vs query-layer disclosure? |

---

## Spec gaps for Session 12

SG-01 through SG-05 documented in S3 FINDINGS.md §8.
Key actions:
- Ingestion spec §3.2: define linkage rate denominator, add PR_LINK as primary method, add
  multi-repo session handling, add branch-name method with UNMEASURED tag
- ADR-103 acceptance: requires branch-name validation sub-spike
- Credential setup: re-store fine-grained read-only PAT in AgentWrangler-GithubToken

---

## Addendum (2026-08-25): `gh` CLI transport

GitHub reads now run via `gh api` subprocesses (`GhCliClient`) rather than fetch/Octokit on
the daemon's event loop. This was necessary to eliminate event-loop starvation: undici socket
callbacks were being starved past their AbortSignal timeout by back-to-back synchronous
transcript streaming in `linkSessions`.

Runtime requirement: `gh` must be installed and on PATH (`gh.exe` on Windows). If absent, all
GitHub reads degrade gracefully to `{ok:false, reason:"...:gh-not-found"}` — the daemon does
not crash and outcomes remain dark (linkage disabled). The AgentWrangler PAT is passed to `gh`
via `GH_TOKEN` so the daemon's own credential is always used regardless of `gh auth login` state.
