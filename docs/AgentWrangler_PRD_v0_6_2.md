# AgentWrangler — Product Requirements Document v0.6.2

**Status:** Draft — adversarially scoped revision  
**Date:** 2026-08-20  
**Companion document:** `AgentWrangler_Technical_Architecture_v4_4_2.md`  
**Product name:** AgentWrangler  
**Product type:** Open-source, local-first AI-agent control plane  
**Primary MVP principle:** Prove the smallest useful control-and-evidence loop before adding platform breadth or optimization machinery.

---

## 1. Product summary

AgentWrangler is an open-source control plane for AI coding agents. Its initial job is intentionally narrow:

> **Constrain what a coding agent can do, control what governed model requests can cost, independently verify whether the requested task actually succeeded, and make the resulting quality/cost evidence understandable.**

The P0 product sits between a single supported coding agent, its local workspace, a governed model API path, selected external actions, and independent verification evidence.

AgentWrangler must distinguish three different ideas that are easy to conflate:

1. **Decision** — policy says an action should be allowed, denied, or require approval.
2. **Enforcement** — an actual runtime, credential, model-admission, or broker boundary can prevent the action.
3. **Evidence** — AgentWrangler can show what occurred and whether the requested outcome was independently verified.

The UI must never imply that a control is enforced merely because a policy rule, wrapper, dashboard state, or tool hook exists.

### Product principle

> **AI may propose what to do. Deterministic policy decides what is permitted. An enforcement boundary makes that decision real. Independent evidence decides whether the job was done.**

### P0 product promise

> **Run Claude Code on one repository with bounded authority, governed model spend, independent verification, and a clear local dashboard showing whether the work succeeded and what that success cost.**

---

## 2. Why v0.6 is narrower than v0.5

PRD v0.5 correctly made analytics a core part of the product, but it also moved too much of the eventual optimization platform into the first release. P0 had begun to include:

- multiple authentication modes;
- multiple provider families;
- an LLM task classifier;
- a four-class routing system;
- optimization-objective profiles;
- generalized cohort rollups;
- a multi-page analytics product;
- materialized read models;
- delayed durability outcomes;
- calibrated routing predictions;
- recommendations and configuration experiments;
- controlled replay;
- cloud telemetry plumbing.

Most of these features are useful **after** AgentWrangler has accumulated trustworthy task outcomes. They are not required to determine whether the core idea works.

### v0.6 scope rule

A feature belongs in P0 only if it is required to prove one of these five claims:

1. AgentWrangler can place a coding agent inside a truthful, bounded runtime.
2. AgentWrangler can prevent or reauthorize selected consequential actions at a real enforcement boundary.
3. AgentWrangler can govern model selection and spend on a supported BYOK path.
4. AgentWrangler can independently determine whether the task met pre-declared success criteria without allowing the agent to silently weaken the verifier.
5. AgentWrangler can show trustworthy outcome, cost, time, route, and observability evidence in a useful local dashboard.

Everything else is deferred unless implementing it now is cheaper than preserving the extension seam.

---

## 3. Goals

### G-1 — One-tool local onboarding
A technical user can install AgentWrangler and run a protected P0 task without administering Docker, PostgreSQL, Redis, a policy server, a tracing backend, or a separate model gateway product.

### G-2 — Deterministic consequential permissions
Consequential actions are evaluated against normalized structured resources. LLM interpretation may describe intent but cannot authorize privileged actions.

### G-3 — Govern model spend on the supported path
In BYOK mode, AgentWrangler controls the local model-admission path, selected model target, request budget reservation, and reconciliation.

### G-4 — Verify the requested outcome
Agent self-report is never sufficient evidence where independent Git, CI, build, test, artifact, or repository evidence is available.

### G-5 — Protect verifier integrity
A task must not count as trustworthy success merely because the agent changed tests, CI, or verifier configuration to make the check pass.

### G-6 — Keep secrets out of the agent runtime where possible
Provider and GitHub credentials remain in OS-protected storage and are dereferenced only by the smallest trusted component or constrained child tool that needs them.

### G-7 — Make protection claims truthful
The product reports the exact capabilities active for the tested runtime profile. Missing or degraded enforcement is visible.

### G-8 — Minimize approval fatigue
The user reviews a bounded Task Scope before execution and is prompted again only for material scope expansion or a new consequential target.

### G-9 — Produce useful evidence, not an analytics platform
P0 measures a small set of trustworthy task outcomes and economics directly from task records. It does not build generalized recommendation, calibration, experimentation, or data-warehouse machinery before there is evidence to justify it.

---

## 4. Non-goals for P0

P0 will **not** attempt to:

- support more than one reference coding agent;
- support Native Login / subscription-login governance;
- route across provider families;
- support Codex, Cursor, or IDE integrations;
- build or embed a generic cross-provider LLM gateway;
- build a policy language or policy parser;
- build a kernel/OS sandbox;
- build a generic OAuth platform or SaaS credential broker;
- mediate every raw shell command semantically;
- provide universal syscall interception;
- support enterprise SSO/RBAC, central policy, SIEM, or fleet management;
- implement AgentWrangler Cloud;
- implement remote dashboarding or cloud sync;
- train or operate a learned/LLM routing classifier;
- produce calibrated probability-of-success predictions;
- compute counterfactual savings claims;
- implement delayed rework/reopen/revert attribution;
- generate automated optimization recommendations;
- apply and roll back recommendation-driven configuration experiments;
- run alternate-model replay experiments;
- provide a universal agent score;
- build a general tracing/observability backend;
- store source code, complete prompts, or secrets in a remote service;
- claim production-grade sandbox security merely because an upstream sandbox package is installed;
- autonomously approve high-impact external actions.

These are deliberate scope exclusions, not architectural impossibilities.

---

## 5. Primary user

### Persona A — Solo AI-assisted developer

Uses Claude Code heavily on local Git repositories and wants:

- less risk from broad agent authority;
- predictable model spend;
- fewer repetitive approvals;
- proof that the task actually succeeded;
- visibility into whether cheaper-first routing is working;
- a local product that does not require infrastructure administration.

**P0 is designed only for this persona.**

Team lead, platform, and enterprise personas remain roadmap targets and must not drive P0 implementation choices.

---

## 6. P0 reference scenario

The only Full Governance reference path for P0 is:

```text
one developer
+
Claude Code
+
BYOK Anthropic API credential
+
one local Git repository with a GitHub remote
+
one validated Linux-family Scoped Runtime profile
+
GitHub fine-grained credential stored locally
+
repository-native tests/build and/or GitHub Actions verification
+
local AgentWrangler dashboard
```

### Model breadth within P0

P0 may route between **two adapter-certified Anthropic model aliases**:

- `ECONOMY` — cheaper default candidate;
- `CAPABLE` — stronger fallback/high-risk candidate.

The aliases map to tested concrete models in configuration. Exact model names are not product requirements and may change without changing the routing contract.

### Explicitly deferred compatibility paths

- Native Login → P1
- OpenAI models → P1 through a **Codex/OpenAI adapter path**, not by routing Claude Code to unsupported non-Claude models
- additional Anthropic/Bedrock/Vertex Claude deployment paths → P1 after conformance testing
- macOS native protection → P1 unless it passes the same security gate early with negligible extra work
- native Windows sandboxing → later; WSL2 may be used for the reference Linux-family path

---

## 7. Product architecture at a glance

```text
                 AgentWrangler Desktop / Local UI
      Setup · Task Preflight · Approvals · Tasks · Overview
                              │
                              ▼
                    AgentWrangler Local Daemon
      ┌───────────────────────────────────────────────────┐
      │ Workspace facts / Task Coordinator                │
      │ Outcome Contract + Task Scope                     │
      │ Cedar-backed Stage A adapter                      │
      │ Simple Stage B router                             │
      │ ModelAdmission + SQLite budget ledger             │
      │ Secret references / constrained tool launch       │
      │ Evidence + verifier coordinator                   │
      │ Task outcome calculation                          │
      │ Containment                                       │
      └───────────────┬───────────────────────┬───────────┘
                      │                       │
           task-local model endpoint         │ sandbox profile
                      │                       ▼
                      ▼                 Claude Code runtime
             Anthropic API                    │
                                              ├─ local Git/files
                                              └─ constrained child tools

             Independent verifier path
        candidate commit → clean worktree / trusted CI
```

There is no cloud service or generic protocol-gateway sidecar in the P0 critical path.

---

## 8. First-run and task journey

### 8.1 First run

1. Install AgentWrangler.
2. Detect Claude Code.
3. Run sandbox capability/security probes.
4. Connect an Anthropic BYOK credential.
5. Connect one GitHub repository credential.
6. Add one local Git workspace.
7. Discover repository facts and default verifier commands.
8. Run a protected task.

### 8.2 One pre-flight interaction

Before material implementation begins, the user sees one **Task Plan** containing two logically separate but jointly reviewed objects:

- **Outcome Contract** — what observable evidence will count as done;
- **Task Scope** — what bounded authority the agent may use.

Example:

```text
Task: Fix login regression

Success criteria
  ✓ Existing login regression test passes
  ✓ Existing repository test command remains green
  ✓ No verifier-integrity weakening

Approved scope
  Files: src/**, tests/**
  Network: package registry
  GitHub: push feature/** to acme/customer-portal
  Force push: Never
  Protected branch: Never

Model mode
  Auto: ECONOMY first, CAPABLE on configured escalation condition

Budget
  $2.00 hard ceiling where request cost can be bounded

[Run task] [Edit plan] [Cancel]
```

This replaces separate P0 workflows for outcome setup, optimization-profile selection, broad policy configuration, and repetitive per-action approvals.

---

## 9. Workspace facts

P0 keeps the Workspace Manifest intentionally small.

Required facts:

- canonical local workspace path;
- Git repository root;
- remote URL and normalized GitHub repository identity;
- base commit / branch;
- default branch where discoverable;
- configured verifier commands;
- verifier-sensitive paths/configuration;
- active sandbox capability profile;
- approved model aliases;
- connected credential references;
- repository-level policy defaults.

Facts record provenance:

- `authoritative`
- `discovered`
- `declared`

P0 does not require a generalized workspace/resource graph, arbitrary MCP inventory, enterprise identity graph, or cloud-synchronized manifest.

---

## 10. Task Outcome Contract — minimal P0 form

A task cannot produce meaningful performance evidence unless the finish line is known before the agent substantially changes the workspace.

P0 supports a compact versioned Outcome Contract:

```yaml
outcome_contract:
  version: 1
  task_family: bug_fix | feature | maintenance | docs | other
  required_criteria:
    - id: regression
      description: "Login regression no longer reproduces"
      verifier: repo_test:login
      provenance: user | workspace | agentwrangler_proposed
  regression_checks:
    - repo_test:default
  excluded_scope:
    - "Do not redesign authentication"
  user_confirmed: true
```

Rules:

- an LLM or deterministic helper may propose criteria;
- generated/inferred required criteria must be visible to the user in the Task Plan;
- the executing agent cannot silently weaken the required criteria after execution begins;
- any post-start revision requires explicit user action and preserves the previous version;
- success criteria describe observable outcomes, not merely file changes.

### P0 outcome states

- `VERIFIED_SUCCESS`
- `VERIFIED_FAILURE`
- `PARTIALLY_VERIFIED`
- `UNVERIFIED`

P0 does **not** implement durable first-pass outcome windows, human rework attribution, or acceptance-criteria quality analytics.

### Functional requirements

**FR-OUTCOME-001** Create a versioned Outcome Contract before material implementation for supported non-trivial tasks.  
**FR-OUTCOME-002** Required criteria must map to observable evidence or be explicitly marked non-verifiable.  
**FR-OUTCOME-003** Preserve prior contract versions when a post-start change is explicitly approved.  
**FR-OUTCOME-004** The executing agent cannot unilaterally weaken required criteria.  
**FR-OUTCOME-005** Support `VERIFIED_SUCCESS`, `VERIFIED_FAILURE`, `PARTIALLY_VERIFIED`, and `UNVERIFIED`.  
**FR-OUTCOME-006** Record criterion provenance and verifier identity/version.

---

## 11. Task Scope and Stage A authorization

Stage A answers:

> **May this task perform this normalized action against this normalized resource under the current grant?**

### 11.1 User semantics

- **Always** — pre-authorized within the declared resource constraint.
- **Ask** — requires a bounded grant.
- **Never** — prohibited and cannot be overridden by a task grant.

### 11.2 Implementation direction

P0 must **not build a new policy language or evaluator**. AgentWrangler uses an embedded authorization engine behind its `PolicyEngine` abstraction; the preferred P0 engine is Cedar if the selected implementation stack supports its stable validation path.

AgentWrangler owns:

- normalization of actions/resources;
- which actions are promptable;
- mapping user-facing Always/Ask/Never to policy/grant semantics;
- Task Scope generation;
- approval UX;
- grant expiry;
- enforcement-boundary selection;
- evidence correlation.

The policy engine owns:

- policy parsing;
- schema/type validation;
- deterministic authorization evaluation;
- explicit deny precedence;
- diagnostics identifying determining/error policies.

### 11.3 Cedar semantic mapping

For a valid security-critical request:

```text
matching forbid            → NEVER / DENY
matching permit, no forbid → ALLOW
no permit/forbid + promptable action → ASK
no permit/forbid + non-promptable action → DENY
policy evaluation error    → DENY / CONFIG_ERROR
```

A user approval creates a temporary task-bounded permit/grant. Explicit forbids remain effective.

Because Cedar itself uses skip-on-error behavior for erroneous policies, AgentWrangler must inspect evaluation diagnostics and **fail closed** for any security-critical request with a policy-evaluation error.

### Functional requirements

**FR-AUTH-001** Evaluate supported consequential actions against normalized action/resource identities.  
**FR-AUTH-002** `Never` cannot be overridden by user-approved Task Scope or model output.  
**FR-AUTH-003** Approval grants bind `task_id + action + normalized resource + constraints + expiry`.  
**FR-AUTH-004** Re-evaluate when the target repository, branch, remote, path, or consequential action materially changes.  
**FR-AUTH-005** Revalidate authoritative state immediately before a supported external effect.  
**FR-AUTH-006** Canonicalize filesystem paths and resolve symlink/junction traversal before workspace-boundary comparison.  
**FR-AUTH-007** Log policy version, determining policy/grant, normalized target, and decision.  
**FR-AUTH-008** Policy validation/evaluation errors fail closed for supported security-critical actions.  
**FR-AUTH-009** Task grants expire at task termination and cannot be reused by another task.

---

## 12. Runtime protection and constrained tools

AgentWrangler does not build a sandbox.

P0 selects one upstream sandbox provider after a security/compatibility spike. The preferred candidate is **nono** because it combines OS-backed isolation with child-tool sandboxing and credential injection; Anthropic Sandbox Runtime remains a comparator/fallback.

The selected provider is wrapped behind `SandboxProvider` so a future upstream change does not redefine AgentWrangler product semantics.

### User-visible protection capabilities

P0 reports capabilities individually:

- `WORKSPACE_FS_ENFORCED`
- `NETWORK_SCOPE_ENFORCED`
- `HOST_CREDENTIALS_WITHHELD`
- `CHILD_TOOL_ISOLATION_ENFORCED`
- `MODEL_GATEWAY_CONTROLLED`
- `BROKERED_GITHUB_AUTHORITY`

The product may summarize these as `Scoped Runtime`, but the detail view is authoritative.

### Runtime rules

- no provider API key in the Claude Code process environment;
- no GitHub credential in the general agent environment;
- no AgentWrangler admin IPC credential in the agent runtime;
- no host SSH agent socket by default;
- no host credential helper by default;
- network access is explicitly scoped to needed services where the chosen sandbox can enforce it;
- bypassing a PATH shim or command wrapper must not recover credential/network authority.

### Functional requirements

**FR-RUN-001** Full Governance P0 tasks launch only on a validated Scoped Runtime profile.  
**FR-RUN-002** Unsupported/degraded sandbox capabilities are shown before task start.  
**FR-RUN-003** The user can terminate the managed runtime.  
**FR-RUN-004** The managed agent cannot access AgentWrangler operator/admin IPC.  
**FR-RUN-005** The runtime receives only the minimum task-scoped environment/credentials.  
**FR-RUN-006** Security-sensitive sandbox versions are pinned and must pass AgentWrangler regression probes before the profile is enabled.  
**FR-RUN-007** Convenience wrappers are not presented as security boundaries.

---

## 13. GitHub action boundary

P0 does not implement a generic SaaS action broker.

It supports one external authority: **GitHub repository writes for the registered repository**.

Preferred implementation:

- store a repo-scoped/fine-grained GitHub credential in OS-protected storage;
- keep it absent from the normal agent environment;
- after Stage A authorization, inject it only into a constrained child tool or minimal broker operation;
- bind authorization to normalized repository + branch + action;
- preserve provider-side branch protection as a separate defense.

P0 may use existing Git/GitHub CLI/API tooling. It must not build a bespoke Git implementation.

P1 may add OAuth/device-flow connection UX, GitHub App installation tokens, richer SaaS brokers, and MCP tool gateways.

---

## 14. BYOK model path and secrets

### 14.1 P0 auth mode

Only BYOK Anthropic API access is supported for Full Governance P0.

Requirements:

- raw Anthropic credential stored in OS-protected storage;
- Claude Code receives a local task-scoped AgentWrangler credential;
- Claude Code points its Anthropic gateway/base URL at AgentWrangler ModelAdmission;
- AgentWrangler validates the task credential, allowed model alias/target, and budget before forwarding;
- the raw Anthropic credential is dereferenced only by ModelAdmission/upstream HTTP client;
- secrets never enter event payloads or dashboard responses.

### 14.2 Native Login

Native subscription/login compatibility is deferred to P1. This removes the P0 feature-degradation matrix and partial token/cost observability branch.

The architecture still reserves an `auth_mode` field so P1 does not require a schema rewrite.

---

## 15. Stage B — intentionally simple P0 routing

P0 does not attempt to predict a calibrated probability of success.

It answers a smaller question:

> **Should this task start on the ECONOMY or CAPABLE alias under the selected deterministic routing rule, and should it escalate after a structured failure?**

### 15.1 P0 modes

- **Auto** — deterministic economy-first policy with configured high-risk exceptions and escalation conditions.
- **Fixed Economy** — always use ECONOMY.
- **Fixed Capable** — always use CAPABLE; primary benchmark/control mode.

P0 does not expose Balanced / Cost Focused / Quality Focused / Fast Iteration weighted optimization profiles.

### 15.2 Router inputs

P0 may use deterministic signals already available from the Task Plan and workspace, for example:

- task family;
- explicit user `high_risk` / security-sensitive flag;
- declared broad refactor/migration scope;
- repository/verifier requirements;
- prior failure in the current task;
- context-window incompatibility;
- explicit user override.

No remote classifier is required.

### 15.3 Retry vs escalation

P0 separates **transport/provider retry** from **model-capability escalation** so infrastructure failures do not masquerade as routing failures.

- a transient `PROVIDER_SERVICE` failure may trigger bounded retry/backoff on the **same selected alias**;
- same-alias retry does **not** count as a routing escalation and does not by itself make First-Route Success false;
- a provider/service failure alone must not automatically promote ECONOMY → CAPABLE, because changing model capability does not fix a provider outage;
- Auto mode may escalate ECONOMY → CAPABLE after an eligible `MODEL_REASONING` failure, configured verifier failure, explicit **user** override, or context/capability mismatch;
- an agent may *request* escalation as evidence, but that request alone cannot authorize a more expensive alias; the deterministic router must independently match a configured escalation condition and budget/policy must still permit it;
- P0 permits at most one capability escalation unless the task is explicitly restarted under a new Task Plan.

The router does not silently de-escalate within an active task.

### Functional requirements

**FR-ROUTE-001** Route only to adapter-certified Anthropic model targets allowed by policy.  
**FR-ROUTE-002** Record selected alias/model and deterministic reason codes.  
**FR-ROUTE-003** Support Auto, Fixed Economy, and Fixed Capable.  
**FR-ROUTE-004** Preserve route history, retries, and escalations for the task.  
**FR-ROUTE-005** User override cannot select a disallowed/incompatible model.  
**FR-ROUTE-006** Provider/environment failures are not automatically classified as model reasoning failures.  
**FR-ROUTE-007** Learned classifiers, calibrated probabilities, cohort priors, and counterfactual router metrics are P1+.  
**FR-ROUTE-008** Same-alias provider retries are recorded separately from model-capability escalation; provider/service failure alone is not evidence that a more capable model was required.  
**FR-ROUTE-009** An agent self-request for escalation is advisory evidence only and cannot by itself authorize a more expensive model alias.

---

## 16. Model admission and spend controls

AgentWrangler must own the synchronous budget invariant for P0.

Before each governed model request:

1. validate task-local credential;
2. validate the allowed concrete model target;
3. determine whether a conservative maximum request cost can be bounded;
4. atomically reserve that amount against the task budget;
5. dispatch the request;
6. reconcile provider-reported usage/cost;
7. release unused reservation.

### Hard vs best-effort budget

A dollar-denominated limit is labeled **Hard** only if:

- the concrete model price is known/fresh enough under configured policy;
- maximum output/request dimensions are bounded;
- concurrent in-flight reservations are included;
- crash recovery cannot silently reset committed reservations.

Otherwise the UI shows **Best Effort** or `Unavailable` rather than overstating precision.

### P0 controls

- per-task spend ceiling;
- model allow-list;
- request timeout;
- output/request dimensional limits required for hard budget;
- max model attempts/escalations;
- runtime stop.

Daily/team budgets, RPM/TPM administration, anomaly scoring, and generic rate-limit policy are deferred unless trivial to expose from the same ledger.

### Functional requirements

**FR-COST-001** Reserve budget atomically before dispatch.  
**FR-COST-002** Reconcile actual provider usage after completion/stream termination.  
**FR-COST-003** Concurrent requests cannot independently spend the same remaining reservation.  
**FR-COST-004** Unknown/stale pricing downgrades the budget claim unless a conservative configured ceiling is available.  
**FR-COST-005** Budget/session state persists in managed local SQLite.  
**FR-COST-006** Show task spend and reservation status in the task view.

---

## 17. Verification and verifier integrity

Agent self-report is evidence, not ground truth.

### 17.1 P0 verification sources

Use repository-native or provider-native mechanisms instead of building test frameworks:

- Git diff/commit state;
- user/repository-configured build/test/lint commands;
- expected artifact checks;
- GitHub Actions/check status tied to the candidate commit;
- clean `git worktree`/checkout verification where practical.

### 17.2 Trust baseline

Before task execution, record:

- base commit;
- existing test/spec files selected by configured rules;
- CI workflow files;
- test/build/lint configuration;
- package scripts or equivalent verifier entry points;
- AgentWrangler verifier policy stored outside the agent-writable workspace.

Verifier-sensitive changes are classified:

- `CLEAN`
- `AUTHORIZED_CHANGE`
- `NEEDS_REVIEW`

Changing tests is not automatically malicious. A task explicitly allowed to modify tests may do so, but the resulting evidence must not become circular.

### Functional requirements

**FR-VERIFY-001** Distinguish agent claim from verifier result.  
**FR-VERIFY-002** Tie verification to the candidate commit/artifact.  
**FR-VERIFY-003** Capture verifier trust baseline before material agent changes.  
**FR-VERIFY-004** Detect material verifier-sensitive changes.  
**FR-VERIFY-005** Do not count `NEEDS_REVIEW` as trustworthy verified success.  
**FR-VERIFY-006** Prefer a clean worktree or provider-side trusted workflow for final verification.  
**FR-VERIFY-007** Record verifier definition/version, integrity state, criterion results, and evidence references.

---

## 18. Evidence and telemetry

P0 needs trustworthy evidence, not a bespoke observability platform.

### 18.1 AgentWrangler domain evidence

Persist append-oriented domain events only where they express AgentWrangler product semantics, including:

- task lifecycle;
- Task Plan / Outcome Contract version;
- Task Scope/grants;
- policy decisions and approvals;
- route selection/escalation;
- model budget/usage summary;
- GitHub consequential-action request/result;
- agent attestation;
- verifier baseline/result/integrity;
- derived task outcome;
- containment.

### 18.2 OpenTelemetry reuse

For generic model/request/tool/HTTP timing and token telemetry, use OpenTelemetry SDKs and the GenAI semantic conventions where applicable instead of inventing parallel field names.

Content-bearing prompt/output telemetry is disabled by default. P0 only needs metadata required for cost, time, route, and outcome evidence.

### 18.3 Canonical task identity

Every domain event maps to:

```text
task_id
session_id
runtime_id
workspace_id
```

P0 does not require a generalized distributed-trace backend, cloud collector, or event warehouse.

---

## 19. P0 analytics — deliberately small

P0 analytics answer three questions:

1. **Did the task succeed under trustworthy verification?**
2. **What did that trustworthy outcome cost in dollars/tokens/time?**
3. **Did the initial route work, or did AgentWrangler pay for an escalation?**

### 19.1 Required task-level fields

- final verification state;
- verifier-integrity state;
- verification coverage (`FULL`, `PARTIAL`, `UNAVAILABLE`);
- model route sequence;
- first-route success boolean;
- total exact observed model cost where available;
- input/output/cache/reasoning token totals where provided;
- pre-escalation cost/tokens/time where an escalation occurs;
- task start and terminal verification timestamps;
- task family;
- agent/version;
- concrete model/provider;
- cancellation/failure category, using a deterministic taxonomy that separates at minimum model reasoning, provider/service, agent/orchestration, tool, environment, policy, verifier, user cancellation, and unknown causes.

### 19.2 Required aggregate metrics

P0 dashboard computes these from task summaries using SQLite queries:

- **Trustworthy Verified Success Rate**;
- **Verification Coverage**;
- **Cost per Trustworthy Verified Success** where exact cost is observable;
- **Tokens per Trustworthy Verified Success** where token usage is observable;
- **Median Time to Verified Outcome**;
- **First-Route Success Rate**;
- **Observed Pre-Escalation Waste**;
- **Failure Category Breakdown**, with provider/environment/tool/policy/verifier failures kept distinct from model-reasoning failure;
- total observed spend.

### 19.2.1 P0 metric calculation contract

P0 uses explicit denominator/eligibility rules so dashboard numbers cannot drift as implementation evolves. These rules are versioned with `metric_definition_version`.

Define the **trustworthy terminal set** for a selected filter/time window as terminal tasks that:

- reached independent verification;
- have `FULL` verification coverage for required Outcome Contract criteria;
- have verifier integrity `CLEAN` or `AUTHORIZED_CHANGE`; and
- end as `VERIFIED_SUCCESS` or `VERIFIED_FAILURE`.

`PARTIALLY_VERIFIED` and `UNVERIFIED` tasks remain visible and reduce Verification Coverage, but do not silently enter success/economic denominators that require trustworthy outcome classification. Explicit user cancellations remain visible in failure/cancellation reporting and are excluded from model-quality denominators.

| Metric | P0 calculation semantics |
|---|---|
| **Trustworthy Verified Success Rate** | `VERIFIED_SUCCESS / (VERIFIED_SUCCESS + VERIFIED_FAILURE)` within the trustworthy terminal set. |
| **Verification Coverage** | fraction of terminal executed tasks that qualify for the trustworthy terminal set; excluded/partial/unverified counts are shown alongside the rate. |
| **Cost per Trustworthy Verified Success** | total exact observed model cost for all exact-cost tasks in the trustworthy terminal set, including failed tasks and all contributing attempts, divided by `VERIFIED_SUCCESS` count in that same exact-cost cohort. |
| **Tokens per Trustworthy Verified Success** | same eligibility as cost-per-success, using observed token totals and excluding tasks with unavailable token accounting from the exact-token cohort. |
| **Median Time to Verified Outcome** | median `task execution start → terminal independent verification` duration for the trustworthy terminal set. |
| **First-Route Success Rate** | for `AUTO` tasks in the trustworthy terminal set, fraction ending `VERIFIED_SUCCESS` without changing the initially selected model alias. Bounded same-alias provider retries do not invalidate first-route success. |
| **Observed Pre-Escalation Waste** | factual observed cost/tokens/time incurred before the first model-alias escalation on tasks that actually escalated; preserve the escalation-trigger failure category and never label this counterfactual savings/regret. |
| **Failure Category Breakdown** | use the terminal task's `primary_failure_category`; recovered request-level errors remain request evidence and do not become the task's primary failure solely because they occurred last. |

If an implementation changes any eligibility, denominator, timing boundary, or attribution rule above, it must create a new metric-definition version rather than silently recomputing history under the old definition.

### 19.3 Simple segmentation

P0 may filter/group by:

- time range;
- task family;
- model alias/concrete model;
- routing mode;
- outcome.

Because P0 supports one workspace at a time, it does not need a generalized cohort fingerprinting engine.

Comparisons must show sample size and observability. `N/A` is preferred to guessed precision.

### 19.4 Explicitly deferred analytics

P1+:

- Immediate/Durable First-Pass analytics beyond first-route success;
- human rework/reopen/revert attribution;
- model efficiency frontier;
- calibrated predicted success/cost;
- Estimated Avoidable Escalation Tax;
- Router Regret;
- generalized cohort definitions/fingerprints;
- recommendation engine;
- configuration experiments;
- alternate-route replay;
- cross-device/cloud rollups.

### Functional requirements

**FR-ANALYTICS-001** Every aggregate exposes `n`, time range, verification coverage, and observability qualification.  
**FR-ANALYTICS-002** Exact and unavailable/partial cost or token observations are never silently mixed.  
**FR-ANALYTICS-003** Failed/retried attempts remain in task cost when they contributed to the final outcome path.  
**FR-ANALYTICS-004** Observed pre-escalation waste is factual and is not presented as counterfactual savings.  
**FR-ANALYTICS-005** P0 metrics are reproducible from persisted task/evidence records without cloud services.  
**FR-ANALYTICS-006** Provider/service, environment, tool, policy, verifier, agent/orchestration, and model-reasoning failures remain distinct so routing quality is not penalized for unrelated failure causes.  
**FR-ANALYTICS-007** Every P0 aggregate uses a versioned metric definition so later methodology changes do not silently reinterpret historical results.  
**FR-ANALYTICS-008** P0 metric eligibility/denominator rules follow §19.2.1 and expose excluded/partial populations needed to interpret the result.  
**FR-ANALYTICS-009** Task-level failure analysis records one deterministic `primary_failure_category` for terminal attribution while preserving recovered request-level failures separately.

---

## 20. P0 dashboard and UI

The local UI has four primary surfaces. They may be tabs or sections in one desktop shell.

### 20.1 Overview

Answer in approximately 10 seconds:

> **Are protected tasks succeeding, what does success cost, and is cheap-first routing working?**

Required cards:

- Trustworthy Verified Success Rate;
- Cost per Trustworthy Verified Success;
- Median Time to Verified Outcome;
- First-Route Success Rate;
- Verification Coverage;
- total observed spend.

Below the cards:

- simple trend by day/task;
- model alias breakdown;
- recent task table;
- visible observability qualification.

### 20.2 Tasks

Task list fields:

- task/time;
- task family;
- outcome;
- verifier integrity;
- route sequence;
- cost;
- duration.

Task detail:

- Outcome Contract;
- Task Scope/grants;
- active protection capabilities;
- route and usage sequence;
- consequential approvals/actions;
- candidate commit;
- agent claim;
- verifier result/integrity;
- final outcome;
- evidence timeline.

### 20.3 Controls / Governance

Show:

- active sandbox capabilities;
- provider/GitHub connections without secret values;
- task/model budget defaults;
- Always/Ask/Never defaults;
- current supported platform/profile state;
- Stop Agent.

### 20.4 Router

P0 Router view is intentionally evidence-oriented, not predictive:

- Auto vs Fixed mode;
- selected alias/model and reason;
- first-route successes;
- escalations;
- observed pre-escalation waste;
- compact failure-category breakdown that keeps provider/environment/tool/policy/verifier failures separate from model-reasoning failure;
- comparison against Fixed Capable pilot tasks when available.

No probability gauges, calibration charts, recommendation cards, or counterfactual savings appear in P0.

### 20.5 P0 metric → dashboard traceability

Every user-facing P0 metric has an intentional surface. This is a documentation/acceptance contract, not a requirement for additional dashboard pages.

| P0 metric / state | Primary surface | Drill-down |
|---|---|---|
| Trustworthy Verified Success Rate | Overview | Tasks |
| Verification Coverage | Overview | Tasks |
| Cost / Tokens per Trustworthy Verified Success | Overview | Tasks |
| Median Time to Verified Outcome | Overview | Tasks |
| Total observed spend | Overview | Tasks |
| First-Route Success Rate | Overview + Router | Tasks |
| Observed Pre-Escalation Waste | Router | Tasks |
| Failure Category Breakdown | Router | Tasks / evidence |
| Protection capability state | Controls | Tasks |
| Budget state / hard-vs-best-effort qualification | Controls + Overview status | Tasks / model requests |

Metrics intentionally deferred in §19.4 do not require a P0 dashboard surface. Release review must check both directions: every displayed metric has an upstream definition, and every user-facing P0 metric above has a dashboard location.

### UI requirements

**FR-UI-001** Every metric maps to a documented definition and persisted source fields.  
**FR-UI-002** Comparative metrics show sample size and observability/verification qualification.  
**FR-UI-003** Every aggregate can drill into contributing tasks.  
**FR-UI-004** Unsupported data displays `N/A`, `Partial`, or `Unavailable` rather than an invented estimate.  
**FR-UI-005** Protection status uses text labels in addition to color.  
**FR-UI-006** Core controls remain keyboard accessible and usable at narrow desktop widths.  
**FR-UI-007** P0 dashboard works entirely offline/local.  
**FR-UI-008** Release review verifies bidirectional traceability: every displayed metric maps to a persisted definition/source, and every user-facing P0 metric in §20.5 has an intentional dashboard surface.

---

## 21. Security and privacy requirements

**SEC-001** No raw provider/GitHub secrets in logs, domain events, dashboard payloads, or exported telemetry.  
**SEC-002** Raw secrets use OS-protected credential storage.  
**SEC-003** The managed agent cannot read AgentWrangler operator/admin IPC credentials.  
**SEC-004** The local control/evidence database lives outside the agent-writable workspace.  
**SEC-005** Runtime authorization uses canonical resource identities and fails closed for ambiguous supported consequential targets.  
**SEC-006** Verifier trust definitions live outside the agent-writable workspace or are independently integrity checked.  
**SEC-007** Security-sensitive upstream dependencies are version-pinned, integrity-checked, and regression-tested before a protection claim is enabled.  
**SEC-008** Prompt/output content capture is off by default and not required for P0 metrics.  
**SEC-009** A convenience shim or wrapper cannot be the only barrier protecting a secret or external authority.  
**SEC-010** Policy evaluation errors for security-critical actions fail closed at the AgentWrangler adapter layer.

---

## 22. Nonfunctional requirements

### Installation

**NFR-001** P0 requires no Docker, PostgreSQL, Redis, cloud account, or manual policy server.  
**NFR-002** Install-to-first-protected-task target is under 10 minutes for a technical user on the reference platform.  
**NFR-003** Upstream helper binaries are installed/pinned by AgentWrangler, not fetched as mutable `latest` dependencies at task runtime.

### Runtime performance

**NFR-004** Stage A authorization overhead target p95 ≤ 10 ms excluding user approval.  
**NFR-005** ModelAdmission overhead target p95 ≤ 20 ms excluding provider latency.  
**NFR-006** P0 router decision should be sub-millisecond to low-single-digit milliseconds because it is deterministic.

### Reliability

**NFR-007** Budget reservations are crash-consistent enough not to silently reset an active hard ceiling.  
**NFR-008** Sandbox startup failure fails the Full Governance launch rather than silently downgrading to an equivalent-looking state.  
**NFR-009** Dashboard/analytics failure must not disable Stage A, ModelAdmission, or runtime containment.  
**NFR-010** Task outcome calculation is deterministic for a given evidence set + methodology version.

---

## 23. Build vs. reuse strategy

P0 should minimize custom infrastructure aggressively.

| Capability | P0 strategy | Reuse | AgentWrangler owns |
|---|---|---|---|
| Policy evaluation | **Mostly OSS** | Cedar preferred; OPA remains alternative if implementation stack makes Cedar validation impractical | Always/Ask/Never semantics, normalized resources, promptability, grants, UX |
| Runtime confinement | **Mostly OSS** | nono preferred candidate; Anthropic Sandbox Runtime comparator | profile translation, capability truthfulness, regression gate |
| Child-tool isolation / GitHub credential injection | **OSS + thin orchestration** | selected sandbox child-tool/credential features, Git/GitHub tooling | Stage A binding, repository/branch constraints, evidence |
| Provider credential storage | **OS primitive** | Keychain/Keyring/Credential Manager/libsecret or equivalent | secret references and lifecycle UX |
| Model gateway/protocol translation | **Not built in P0** | Claude Code Anthropic gateway interface + standard HTTP client/reverse-proxy libraries | — |
| ModelAdmission / budget ledger | **Custom core** | SQLite + HTTP libraries | task key, target enforcement, reservation/reconciliation invariant |
| Stage B | **Small custom rule set** | RouteLLM architecture/benchmarks as P1 reference, not P0 dependency | evidence-backed routing semantics |
| Generic telemetry | **Mostly OSS** | OpenTelemetry SDK + GenAI semantic conventions | task correlation + product-domain evidence |
| Verification execution | **Reuse repo tooling** | Git, git worktree, GitHub Actions/Checks, repository test/build commands | Outcome Contract mapping, verifier-integrity baseline/result |
| Local storage | **Commodity** | SQLite | schema for AgentWrangler domain records |
| Dashboard | **Custom product UI on standard web libs** | web framework/chart/table libraries | task/governance/economics UX and truthfulness |
| Cloud | **Not built in P0** | future commodity auth/DB/queue components | future privacy/product semantics |

### Architectural ownership rule

AgentWrangler should permanently own the semantic loop, not the low-level primitives:

```text
What counts as done?
        ↓
What bounded authority is approved?
        ↓
Which governed model path is selected?
        ↓
Can the request be admitted within budget?
        ↓
What actually happened?
        ↓
Did trusted verification establish success?
        ↓
What did that success cost?
```

---

## 24. P0 scope table

| Area | P0 | Deferred impact |
|---|---|---|
| Agent | Claude Code only | `AgentAdapter` seam retained for Codex P1 |
| Auth | BYOK Anthropic only | `auth_mode` field retained; Native Login P1 |
| Providers | Anthropic family only | provider adapter seam retained; LiteLLM can enter when cross-provider translation is needed |
| Routing | deterministic two-tier Auto/Fixed | route history is sufficient training/evaluation input for P1 router |
| Policy | Cedar-backed AgentWrangler semantics | policy adapter permits future OPA/AGT without changing Task Scope model |
| Runtime | one validated sandbox/profile | profile capability matrix supports later OS/providers |
| External actions | one GitHub repository | action/broker interface retained, no generic SaaS broker P0 |
| Verification | Git + repo checks + GitHub CI | verifier adapter seam retained |
| Analytics | direct task summaries + simple aggregates | canonical task records preserve fields needed for later cohorts/calibration |
| Dashboard | Overview / Tasks / Controls / Router | separate Performance/Recommendations pages P1 |
| Cloud | none | export/privacy field classification may be designed, but no sync code P0 |

---

## 25. Pilot plan

Run a bounded 2–4 week pilot on the P0 reference path.

### Comparison

Use two routing configurations on comparable tasks:

- **Fixed Capable** control;
- **Auto** AgentWrangler route.

Measure:

- trustworthy verified success;
- total observed model cost;
- cost per trustworthy verified success;
- time to verified outcome;
- first-route success;
- escalation rate;
- observed pre-escalation waste;
- verification coverage;
- failure-category breakdown, with non-model failures separated from model-reasoning failures;
- policy approvals/task-scope expansions;
- **Task Scope reuse count** — subsequent consequential authorization checks satisfied by an already-active bounded Task Scope grant, not counterfactual “approvals avoided”;
- verifier-integrity review rate;
- sandbox/policy/budget bypass test results.

### P0 exit criteria

- Full Governance launch works on one validated Linux-family protection profile;
- managed agent cannot read raw provider/GitHub credentials or admin IPC credentials;
- bypassing wrappers does not restore protected external authority;
- budget concurrency/crash tests remain within the documented hard-bound semantics;
- normalized GitHub repo/branch substitution triggers denial or reauthorization;
- verifier detects material test/CI weakening and does not count it as trustworthy success;
- CI/check evidence is tied to the candidate commit;
- local task timeline/outcome is reconstructable;
- dashboard metrics reconcile to underlying task evidence;
- Auto routing can be compared fairly with Fixed Capable without fabricated counterfactuals;
- installation requires no user-managed infrastructure.

The pilot may show that routing does **not** save money. That is a valid product-learning result and must not be masked by recommendation logic.

---

## 26. Roadmap after P0

Roadmap placement preserves architectural intent; it is **not permission to build ahead** and does not make every listed capability a committed release requirement. A P1+ item is promoted only through an explicit scope/architecture decision after the prerequisite P0 evidence exists.

### P1 — evidence-informed breadth

Only after the core loop works:

- Codex/OpenAI adapter/profile;
- Native Login compatibility with explicit degraded observability;
- provider/protocol translation using LiteLLM or equivalent **only for agent/provider combinations officially compatible with that wire path**; Claude Code must not be routed to unsupported non-Claude models merely because a gateway can translate the API;
- richer model pairs/providers;
- learned/router-classifier benchmark including RouteLLM-style strong/weak routing;
- calibrated routing predictions only after adequate verified outcome data exists;
- generalized cohort definitions and Performance page;
- more task families/verifiers;
- OAuth/device-flow/GitHub App connection UX;
- broader sandbox/platform validation;
- selected MCP/tool integrations.

#### Evidence-gated P1 analytics candidates — not automatic P1 commitments

- **Provider reliability workbench** — promote only if provider/service failures materially distort routing conclusions, support diagnosis, or provider selection decisions beyond what task-level OTel/failure evidence can answer.
- **Token/context efficiency and loop-waste analytics** — promote only if token economics become a material optimization opportunity and a privacy-safe, versioned measurement method is justified.
- **Governance-effectiveness analytics** — promote only if approval friction, Task Scope reuse, budget behavior, or containment reliability require trend-level diagnosis beyond task drill-down.

P0 should retain only the already-required source evidence needed to make a later promotion possible; these candidates do **not** justify dedicated P0 rollups, services, schemas, or dashboard pages.

### P2 — optimization and cloud

- delayed durability/rework attribution;
- evidence-backed recommendations;
- configuration versioning and apply/measure/rollback;
- controlled alternate-route replay / Router Regret;
- opt-in cloud telemetry;
- remote dashboard/history;
- cross-device views;
- shared calibration only if privacy/utility experiments justify it.

### P3 — team / enterprise

- organizations/projects;
- central policy ceilings;
- multi-user approvals;
- SSO/RBAC;
- SIEM/export/retention;
- enterprise federation;
- private telemetry/fleet management.

---

## 27. Open decisions / required spikes

1. **Daemon implementation language.** Rust has the most mature Cedar SDK/validator path; Go has operational simplicity but Cedar Go schema validation remains less mature. Resolve before committing to the policy embedding approach.
2. **Sandbox provider.** Compare a pinned current nono release with Anthropic Sandbox Runtime against the same escape/compatibility corpus. Prefer the provider that satisfies the required child-tool/credential boundary with the least custom code.
3. **Claude Code gateway conformance.** Validate that AgentWrangler can proxy the Anthropic wire protocol, enforce the selected model target, stream responses, and collect usage without needing LiteLLM in P0.
4. **Hard-budget reservation formula.** Define conservative request upper-bound calculation for the selected Anthropic model profiles and stale-pricing behavior.
5. **Verifier defaults.** Define safe initial repository-language detection and verifier-sensitive path defaults without creating a framework matrix.
6. **GitHub credential UX.** Decide whether P0 begins with a fine-grained PAT or another low-complexity repo-scoped credential flow; do not build generalized OAuth unless required for acceptable onboarding.
7. **Auto-route deterministic rule.** Establish the smallest economy-first/high-risk-exception ruleset for the pilot and keep it versioned.

---

## 28. MVP definition of done

A new P0 user can:

1. install AgentWrangler without Docker/PostgreSQL/Redis/cloud setup;
2. detect Claude Code and pass the reference platform protection probe;
3. connect one Anthropic BYOK credential and one GitHub repository credential;
4. add one Git workspace;
5. submit a task and review one Task Plan containing success criteria, scope, route mode, and budget;
6. launch Claude Code inside the validated Scoped Runtime without raw provider/GitHub/admin credentials;
7. see whether each relevant runtime capability is actually enforced;
8. have Stage A authorize/ask/deny a supported consequential GitHub action against the normalized repository/branch;
9. have ModelAdmission enforce the selected model and task budget before dispatch;
10. run Auto or Fixed routing between two certified Anthropic model aliases;
11. create a candidate commit and run independent clean/trusted verification;
12. see verifier integrity as `CLEAN`, `AUTHORIZED_CHANGE`, or `NEEDS_REVIEW`;
13. distinguish agent claim from trustworthy verified outcome;
14. view task route, token/cost/time, approvals/actions, verifier evidence, and chronological timeline;
15. view local Overview metrics for success, cost per verified success, time, first-route success, verification coverage, and observed pre-escalation waste;
16. drill an aggregate into contributing tasks;
17. stop the managed runtime;
18. do all of this without operating the underlying policy engine, sandbox, database, or telemetry library directly.

---

## 29. External research basis — accessed 2026-08-20

The v0.6 changes were informed by current upstream documentation and repositories:

- Anthropic Claude Code LLM gateway documentation: https://docs.anthropic.com/en/docs/claude-code/llm-gateway
- Cedar authorization semantics and validation: https://docs.cedarpolicy.com/auth/authorization.html and https://github.com/cedar-policy/cedar
- nono sandbox/project status: https://github.com/nolabs-ai/nono
- Anthropic Sandbox Runtime: https://github.com/anthropic-experimental/sandbox-runtime
- OpenTelemetry GenAI observability/semantic conventions: https://opentelemetry.io/blog/2026/genai-observability/
- RouteLLM: https://github.com/lm-sys/RouteLLM
- LiteLLM: https://docs.litellm.ai/

Research is used to identify reuse opportunities and architectural constraints; no upstream project's marketing claim is treated as proof of an AgentWrangler protection guarantee.

---

# 30. Decision / change log — PRD v0.5 → v0.6

**Date:** 2026-08-20  
**Review type:** Adversarial scope + build-vs-reuse review

## Scope-removal decisions

1. **Removed Native Login from P0 — ACCEPTED.**  
   **Why:** It adds a second authentication/capability/observability branch while bypassing the core P0 model-admission and hard-spend value.  
   **Upstream impact:** P0 onboarding, secrets, routing, and telemetry only implement BYOK.  
   **Downstream impact:** Native Login remains P1; preserve `auth_mode` in persisted/task interfaces so no schema rewrite is required.

2. **Removed OpenAI/cross-provider routing from P0 — ACCEPTED AND STRENGTHENED BY UPSTREAM SUPPORT BOUNDARY.**  
   **Why:** Cross-provider breadth forces protocol translation and a much larger compatibility matrix before the core loop is proven. More importantly, current Anthropic Claude Code gateway documentation explicitly says Anthropic does not support routing Claude Code to non-Claude models through a gateway. Claude Code + Anthropic can still demonstrate cheaper/stronger model routing across certified Claude model aliases.  
   **Upstream impact:** P0 only certifies Anthropic/Claude model aliases and does not treat gateway protocol translation as permission to violate the agent's supported model contract.  
   **Downstream impact:** OpenAI model support arrives with a compatible Codex/OpenAI adapter path in P1; additional gateways remain subordinate to the active agent's official compatibility boundary.

3. **Removed LiteLLM protocol sidecar from the P0 critical path — ACCEPTED.**  
   **Why:** With a Claude Code + Anthropic-only reference path, AgentWrangler can use Claude Code's documented gateway/base-URL mechanism and a narrow Anthropic-wire ModelAdmission proxy. A generic translation sidecar adds lifecycle, supply-chain, and debugging surface without P0 benefit.  
   **Upstream impact:** Installer/process model is smaller; no LiteLLM process/config in P0.  
   **Downstream impact:** Introduce LiteLLM/equivalent in P1 only when cross-provider translation demonstrably avoids more code than it adds.

4. **Removed P0 LLM/learned task classifier and four-class router — ACCEPTED.**  
   **Why:** P0 lacks its own verified task dataset for calibration, and classifier privacy/latency adds complexity.  
   **Upstream impact:** Stage B becomes deterministic two-tier Auto/Fixed routing.  
   **Downstream impact:** Persist route reason/history so P1 can benchmark RouteLLM-style or learned routers against real verified outcomes.

5. **Removed P0 Optimization Objective profiles — ACCEPTED.**  
   **Why:** Weighted quality/cost/time objectives imply calibrated measurements that P0 does not yet possess.  
   **Upstream impact:** P0 exposes Auto, Fixed Economy, Fixed Capable.  
   **Downstream impact:** P1 may add explicit optimization profiles once metric confidence is sufficient.

6. **Reduced the Task Outcome Contract — ACCEPTED.**  
   **Why:** Criterion provenance, task family, immutable versions, and verifier mapping are core; ambiguity scores, subfamily taxonomies, revision analytics, and delayed acceptance signals are not.  
   **Upstream impact:** Fewer fields/classifiers and a simpler pre-flight card.  
   **Downstream impact:** Version/provenance fields remain extensible for richer P1 analytics.

7. **Combined Outcome Contract + Task Scope into one Task Plan UX — ACCEPTED.**  
   **Why:** They remain separate security/evidence objects but do not require two onboarding interactions.  
   **Upstream impact:** Lower approval/setup friction.  
   **Downstream impact:** Persist separate object IDs/versions so future workflows can evolve independently.

8. **Removed generalized cohort engine/materialized metric rollups from P0 — ACCEPTED.**  
   **Why:** One developer/one workspace with early sample sizes can be served by indexed SQLite task-summary queries.  
   **Upstream impact:** No cohort fingerprint service, rollup worker, rebuild engine, or broad read-model layer in P0.  
   **Downstream impact:** Canonical task fields include task family/model/route/observability so P1 can build cohort rollups without changing evidence capture.

9. **Reduced P0 dashboard from seven logical pages to four surfaces — ACCEPTED.**  
   **Why:** Overview, Tasks, Controls, and Router are sufficient to validate user value. Separate Performance and Recommendations products are premature.  
   **Upstream impact:** Smaller UI/API surface.  
   **Downstream impact:** Drill-down/task semantics remain compatible with later Performance/Recommendations pages.

10. **Removed Immediate/Durable First-Pass, rework/reopen/revert attribution from P0 — ACCEPTED.**  
    **Why:** First-route success is the minimum routing-autonomy metric; durability attribution needs delayed background processing and ambiguous causal inference.  
    **Upstream impact:** No delayed outcome scheduler/processor.  
    **Downstream impact:** P1 can append delayed evidence without rewriting original P0 task outcomes.

11. **Removed P0 calibration, recommendations, config versioning, and replay experiments — ACCEPTED.**  
    **Why:** These consume trustworthy history; they are not prerequisites for generating it.  
    **Upstream impact:** Eliminates calibration store, recommendation engine, config experiment state, replay worker, and counterfactual UI.  
    **Downstream impact:** P0 records route/outcome/cost evidence needed to add these later.

12. **Removed AgentWrangler Cloud implementation from P0 — ACCEPTED.**  
    **Why:** Cloud does not participate in enforcement and does not prove the core solo-developer value.  
    **Upstream impact:** No device registration, cloud outbox, ingestion API, remote dashboard, or cloud database in P0.  
    **Downstream impact:** Keep privacy classifications/export-compatible IDs; build cloud after local utility is demonstrated.

13. **Removed generic OAuth/credential broker from P0 — ACCEPTED.**  
    **Why:** P0 only needs an Anthropic API key and one GitHub repository credential.  
    **Upstream impact:** Use OS vault + constrained injection rather than a generalized token/federation framework.  
    **Downstream impact:** Add OAuth/device flow/GitHub App/federation as integrations require them.

14. **Reduced broad failure/anomaly/loop-waste machinery — ACCEPTED.**  
    **Why:** Hard budget, max attempts, timeouts, deterministic failure categories, and Stop Agent are sufficient P0 runaway controls.  
    **Downstream impact:** Preserve generic error category and request sequence for future anomaly analytics.

## Build-vs-reuse decisions

15. **Replace custom P0 policy evaluator with Cedar-backed evaluation — ACCEPTED WITH SAFETY ADAPTER.**  
    Cedar already supplies a policy language, PARC request model, schema validation, default deny, forbid-overrides-permit semantics, and determining-policy/error diagnostics. AgentWrangler keeps Always/Ask/Never, normalized resources, promptability, grants, and UX. Because Cedar skips erroneous policies during its own decision algorithm, AgentWrangler explicitly fails closed when security-critical evaluation diagnostics contain policy errors.

16. **Increase sandbox reuse rather than writing broker/runtime primitives — ACCEPTED.**  
    Prefer an upstream sandbox that can provide OS isolation plus constrained child tools/credential injection. nono is the leading P0 candidate; Anthropic Sandbox Runtime is a benchmark/fallback. Neither is trusted without pinning and AgentWrangler regression testing.

17. **Use OpenTelemetry GenAI conventions for generic model/tool telemetry — ACCEPTED.**  
    AgentWrangler retains custom domain events for approvals, scopes, policy, verifier integrity, and outcomes, but does not invent a second generic vocabulary for model name, token usage, latency, and HTTP/tool timing or build a tracing backend.

18. **Borrow the strong/weak routing pattern rather than build routing ML in P0 — ACCEPTED.**  
    RouteLLM demonstrates a two-model strong/weak routing/evaluation architecture. Its trained routers and OpenAI/LiteLLM stack are not a clean P0 dependency for Claude Code Anthropic-wire traffic, so P0 borrows the architecture and defers learned routing until AgentWrangler has its own verified-task evidence.

19. **Continue to own ModelAdmission/budget reservation — RETAINED CUSTOM.**  
    This is a differentiating synchronous safety/economic invariant: the agent must not choose an unauthorized model or exceed a declared hard ceiling because a third-party sidecar's accounting state differs from AgentWrangler's task state. SQLite and standard HTTP libraries are reused, but admission/reservation semantics remain AgentWrangler-owned.

20. **Continue to own verifier-integrity and Outcome Contract semantics — RETAINED CUSTOM.**  
    Git/GitHub/test tooling is reused for execution, but deciding what counts as success and whether the verifier was weakened is central product value and not delegated to a generic CI/observability product.

## Resulting P0 thesis

PRD v0.6 intentionally reduces P0 to one evidence-generating vertical slice:

```text
Claude Code + Anthropic BYOK + one repo
        ↓
Task Plan: success criteria + bounded authority
        ↓
Cedar-backed authorization
        ↓
validated upstream sandbox + constrained credentials
        ↓
deterministic two-tier routing
        ↓
AgentWrangler ModelAdmission + hard budget ledger
        ↓
Git/repository/CI verification + verifier integrity
        ↓
small SQLite task/evidence store
        ↓
local Overview / Tasks / Controls / Router dashboard
```

The revision deliberately prioritizes **learning whether AgentWrangler's control-and-evidence loop is valuable** over prematurely building the eventual analytics/cloud platform.
---

# 31. Decision / change log — PRD v0.6 → v0.6.1

**Date:** 2026-08-20  
**Review type:** Merge review of independent metrics-to-dashboard traceability pass

1. **Added bidirectional P0 metric/dashboard traceability — ACCEPTED, SCOPE-NEUTRAL.**  
   The independent review correctly identified that dashboard→requirement traceability alone can leave product metrics orphaned. §20.5 now maps the deliberately small P0 metric set to Overview, Tasks, Controls, or Router without restoring the removed Performance/Recommendations pages.

2. **Added explicit failure taxonomy separation — ACCEPTED IN LEAN FORM.**  
   Provider/service, environment, tool, policy, verifier, and agent/orchestration failures must not be interpreted as model-reasoning failures. This is required for credible first-route/routing analysis and can be computed from existing task/request evidence without a rollup platform.

3. **Added metric-definition versioning to the PRD — ACCEPTED.**  
   The architecture already versioned aggregate definitions; the product requirement now makes that contract explicit so methodology changes cannot silently rewrite historical interpretation.

4. **Added Task Scope reuse to pilot measurements — ACCEPTED AS PILOT EVIDENCE, NOT A P0 DASHBOARD PRODUCT.**  
   This directly tests the low-friction authorization promise. It is defined as observed reuse of an existing bounded grant and is not labeled counterfactual “approvals avoided.”

5. **Provider reliability workbench — DEFERRED.**  
   P0 retains generic provider HTTP/error/latency telemetry through OpenTelemetry and the failure taxonomy, but does not add provider-reliability rollups or a dedicated dashboard surface while P0 has one provider family.

6. **Token/context-efficiency and loop-waste analytics — DEFERRED.**  
   These require non-trivial methodology/fingerprinting and can introduce privacy complexity. P0 retains token totals/request sequences so P1 can add them after the core loop is validated.

7. **Governance-effectiveness dashboard/rollups — DEFERRED.**  
   Approval timing, containment timing, denial rates, budget utilization, and Task Scope reuse may be derivable from P0 evidence, but a dedicated governance analytics product is not required to prove the first vertical slice.

8. **Optimization Objective, calibration, recommendations, replay, durability, and generalized cohort additions — REJECTED FOR P0.**  
   These were useful completeness improvements against the prior broad architecture, but adopting them now would reverse the v0.6 scope reductions. They remain P1+.

9. **No P0 infrastructure subsystem was reintroduced.**  
   The accepted changes use existing SQLite task/evidence records and the existing four-surface dashboard.

---

# 32. Decision / change log — PRD v0.6.1 → v0.6.2

**Date:** 2026-08-20  
**Review type:** Final execution-readiness / phase-boundary consistency pass

1. **Defined exact P0 metric eligibility and denominator semantics — ACCEPTED, SCOPE-NEUTRAL.**  
   Trustworthy success, verification coverage, cost/tokens per success, time, first-route success, pre-escalation waste, and failure attribution now have explicit calculation contracts. This prevents dashboard implementations from choosing incompatible denominators.

2. **Separated provider retry from model-capability escalation — ACCEPTED.**  
   Transient provider/service errors may retry the same alias but do not automatically justify ECONOMY → CAPABLE escalation or count as routing failure. This protects router-quality conclusions from infrastructure noise. Agent self-request is also explicitly advisory and cannot independently authorize the more expensive alias.

3. **Clarified terminal vs request-level failure attribution — ACCEPTED.**  
   A task has one deterministic terminal `primary_failure_category`; recovered request errors remain evidence and cannot become the task's causal failure merely because they occurred most recently.

4. **Made post-P0 roadmap items explicitly evidence-gated — ACCEPTED.**  
   Roadmap placement preserves extension intent but is not permission to build ahead. Future subsystems require explicit promotion after P0 evidence.

5. **Added evidence-gated candidate P1 analytics — ACCEPTED AS NON-COMMITTED FUTURE OPTIONS.**  
   Provider reliability, token/context/loop-waste, and governance-effectiveness analytics remain visible in the roadmap with promotion conditions, while P0 retains no dedicated rollup/service/page for them.

6. **No new P0 infrastructure, process, page, provider, auth mode, or datastore was added.**
