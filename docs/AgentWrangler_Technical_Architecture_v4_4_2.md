# AgentWrangler — Technical Architecture v4.4.2

**Status:** Draft — adversarially scoped architecture  
**Date:** 2026-08-20  
**Companion product document:** `AgentWrangler_PRD_v0_6_2.md`  
**Project:** AgentWrangler  
**Primary deployment:** Local-only P0  
**Architecture objective:** Implement the smallest credible control-and-evidence vertical slice while delegating commodity authorization, sandboxing, storage, telemetry, and provider plumbing wherever practical.

---

# 0. Executive summary

Technical Architecture v4.4.2 preserves the deliberate v4.4 reduction while tightening P0 metric semantics, routing-failure attribution, and evidence-gated phase promotion.

V4.3 correctly described the eventual AgentWrangler platform, but its P0 topology still included too many systems that only become valuable after trustworthy task history exists: generalized cohort rollups, materialized dashboard read models, optimization profiles, calibration state, recommendations, configuration experiments, delayed durability processing, replay workers, cloud telemetry plumbing, multiple auth modes, and cross-provider gateway complexity.

V4.4 narrows P0 to one executable loop:

```text
Claude Code + Anthropic BYOK + one Git repo
        ↓
Task Plan
  Outcome Contract + bounded Task Scope
        ↓
Cedar-backed authorization adapter
        ↓
validated upstream OS sandbox
        ↓
deterministic two-tier model routing
        ↓
AgentWrangler ModelAdmission + SQLite budget ledger
        ↓
constrained GitHub action path
        ↓
clean/trusted verification + verifier-integrity check
        ↓
canonical task evidence + task outcome row
        ↓
local Overview / Tasks / Controls / Router UI
```

The architecture keeps extension seams for additional agents, providers, auth modes, cloud, learned routing, calibration, and recommendations, but **does not implement those seams as standalone P0 subsystems**.

## 0.1 Architectural thesis

AgentWrangler should permanently own the semantics that make the product distinct:

- what task success means;
- what authority the task has;
- how consequential resources are normalized;
- when user approval is required;
- which model a governed task may use;
- the hard-budget admission invariant;
- whether a claimed success is independently trustworthy;
- the task-centric evidence model;
- truthful capability reporting;
- the user experience joining those concepts together.

AgentWrangler should **not** own commodity implementations simply to control them:

- authorization-language parsing/evaluation;
- kernel/OS sandbox primitives;
- generic child-tool isolation where an upstream sandbox already supplies it;
- generic model/token/HTTP telemetry naming;
- database engines;
- provider SDK mechanics;
- generic tracing backends;
- generic OAuth stacks;
- cross-provider protocol translation before cross-provider support exists.

## 0.2 P0 component strategy at a glance

| Capability | P0 strategy | Reuse | AgentWrangler-owned layer |
|---|---|---|---|
| Local desktop/UI | thin custom app | standard desktop/web UI framework | Task Plan, approvals, evidence/task UX |
| Local daemon | custom coordinator | standard runtime/HTTP/IPC libraries | lifecycle, correlation, trust boundaries |
| Workspace facts | small custom mapper | Git CLI/library + filesystem APIs | normalized workspace/resource facts |
| Outcome Contract | custom | Git/repo metadata + test tooling | success criteria/provenance/version semantics |
| Stage A evaluation | **OSS-backed** | **Cedar preferred**; OPA fallback if stack fit is materially better | Always/Ask/Never, promptability, Task Scope grants, normalized resources |
| Runtime confinement | **OSS-backed** | **nono preferred candidate**; Anthropic Sandbox Runtime comparator | profile translation, regression qualification, capability truthfulness |
| Constrained child tools | **reuse first** | upstream sandbox child-tool/credential controls where sufficient | task authorization and normalized external action semantics |
| GitHub effect execution | thin custom orchestration | `git`/`gh` or provider SDK | revalidation, allowed operation schema, evidence |
| Model path | narrow custom admission proxy | standard Anthropic SDK/HTTP libraries | task key, selected-model enforcement, correlation |
| Cross-provider gateway | **not P0** | LiteLLM/equivalent P1 when needed | adapter boundary only |
| Stage B router | small deterministic custom rules | no learned router P0 | Auto/Fixed route policy + reason codes |
| Budget ledger | custom invariant on OSS DB | SQLite | atomic reservation/reconciliation semantics |
| Verification | custom coordinator | Git worktrees, repo-native commands, GitHub Actions where configured | verifier baseline/integrity/outcome mapping |
| Evidence store | custom schema on OSS DB | SQLite WAL | task-centric evidence and lineage |
| Generic telemetry | **reuse** | OpenTelemetry SDK/semantic conventions | correlation + domain events not covered by OTel |
| P0 analytics | SQL over task summaries | SQLite SQL | metric definitions/qualification |
| Materialized cohort engine | **not P0** | SQL/statistics later | P1 methodology |
| Cloud | **not P0** | future standard web/DB stack | future privacy/control semantics |

## 0.3 Key v4.4 cuts

The following are removed from the P0 critical path:

1. Native Login compatibility;
2. OpenAI/Codex and unsupported cross-provider routing;
3. LiteLLM sidecar;
4. learned/LLM routing classifier;
5. four-class routing taxonomy;
6. Optimization Objective weighting/profiles;
7. generalized cohort fingerprints;
8. materialized metric-rollup worker;
9. dedicated Performance and Recommendations products;
10. delayed durability/rework/reopen processing;
11. calibrated routing prediction store/models;
12. recommendation/configuration experiment engine;
13. alternate-model replay worker;
14. cloud outbox/sync/device identity/cloud database;
15. generalized SaaS credential broker.

Those features are postponed, not prohibited. P0 persists only the fields that are cheap and necessary to avoid destructive schema redesign later.

---

# 1. PRD v0.6 traceability

| PRD requirement | Architecture owner |
|---|---|
| G-1 one-tool onboarding | installer + local service lifecycle |
| G-2 deterministic permissions | resource normalizer + Cedar-backed `PolicyEngine` + approval coordinator |
| G-3 governed spend | `ModelAdmission` + SQLite reservation ledger |
| G-4 verify requested outcome | Outcome Contract + `VerifierCoordinator` |
| G-5 verifier integrity | verifier baseline + sensitive-change classifier |
| G-6 secrets minimized | OS vault + sandbox/tool credential injection |
| G-7 truthful protection | `ProtectionProfile` capability probe + regression gate |
| G-8 approval fatigue | joint Task Plan + task-bounded grants |
| G-9 useful evidence, not analytics platform | canonical task/evidence rows + direct SQL aggregates |
| FR-OUTCOME-* | `OutcomeContractManager` + verifier result mapping |
| FR-AUTH-* | `ResourceNormalizer` + `PolicyEngine` + `TaskGrantStore` |
| FR-RUN-* | `SandboxProvider` + profile qualification + IPC isolation |
| FR-ROUTE-* | deterministic `StageBRouter` |
| FR-COST-* | `ModelAdmission` + `BudgetLedger` |
| FR-VERIFY-* | `VerifierCoordinator` + `VerifierIntegrity` |
| FR-ANALYTICS-* | `TaskOutcomeStore` + SQL metric queries |
| FR-UI-* | local query API + desktop UI |

No P0 component exists solely to satisfy a post-P0 requirement.

---

# 2. P0 trust and authority model

P0 distinguishes five authorities even if several run inside one daemon process:

```text
operator authority
  user setup / approval / stop

agent task authority
  bounded filesystem/network/tool capabilities

policy decision authority
  determines allow / prompt / deny for supported actions

model admission authority
  task key / selected model / spend ceiling

external action authority
  narrowly constrained GitHub credential/tool execution
```

The managed agent must never possess operator/admin authority.

## 2.1 Evidence is not enforcement

Every protection claim is tagged as one of:

```text
ENFORCED
OBSERVED
UNAVAILABLE
DEGRADED
```

`ENFORCED` requires a blocking boundary and a passing regression profile.

A wrapper, alias, shell hook, MCP callback, or dashboard toggle does not by itself create enforcement.

## 2.2 Local-only authority

P0 has no cloud dependency.

If the network is unavailable except for explicitly allowed provider/GitHub destinations:

- local policy still evaluates;
- local task grants still work;
- local budget admission still works;
- local runtime can be stopped;
- local evidence remains available;
- local dashboard still renders.

---

# 3. P0 process topology

```text
┌──────────────────────────────────────────────┐
│ AgentWrangler Desktop                       │
│ setup · Task Plan · approvals · dashboard   │
└───────────────────┬──────────────────────────┘
                    │ operator-authenticated IPC
                    ▼
┌──────────────────────────────────────────────┐
│ AgentWrangler Daemon                        │
│                                              │
│ WorkspaceRegistry                           │
│ TaskCoordinator                             │
│ OutcomeContractManager                      │
│ ResourceNormalizer                          │
│ CedarPolicyAdapter                          │
│ StageBRouter                                │
│ ModelAdmission / BudgetLedger               │
│ SandboxCoordinator                          │
│ GitHubActionCoordinator                     │
│ EvidenceStore / TaskOutcomeCalculator       │
│ VerifierCoordinator                         │
│ Containment                                 │
│ LocalQueryAPI                               │
└──────┬──────────────┬──────────────┬─────────┘
       │              │              │
       │              │              └── SQLite + OS credential vault
       │              │
       │              └── clean verifier worktree / configured trusted CI
       │
       └── task-scoped model endpoint
                  │
                  ▼
          managed Claude Code
          inside SandboxProvider
                  │
             constrained tools
```

## 3.1 Desktop

Unprivileged. Responsibilities:

- onboarding;
- Task Plan preview;
- approval prompts;
- task status/timeline;
- Overview/Tasks/Controls/Router dashboard;
- Stop Agent.

The desktop process does not receive raw provider or GitHub credentials.

## 3.2 Daemon

Runs as the user and remains unprivileged unless the selected sandbox requires a separate minimal helper.

The daemon owns:

- task state;
- policy/grant state;
- model admission;
- budget ledger;
- evidence;
- verifier coordination;
- local UI query API.

P0 does **not** create separate analytics, recommendation, calibration, experiment, or cloud-sync workers.

## 3.3 Managed runtime

One task/session runtime.

It receives:

- task ID/session-local identity;
- only allowed workspace paths;
- only allowed network destinations;
- AgentWrangler model endpoint + task model credential;
- no raw Anthropic credential;
- no daemon admin credential;
- no broad GitHub credential;
- no host SSH agent by default;
- no host credential-helper state by default.

## 3.4 Optional privileged helper

Only if the validated sandbox backend requires one.

Requirements:

- narrow fixed command schema;
- no policy authoring;
- no model/provider credentials;
- no database mutation interface;
- unreachable from the managed runtime;
- version/hash verified.

---

# 4. Implementation-language decision boundary

The daemon language remains a required spike because the authorization/sandbox reuse decision should influence the choice rather than follow it.

## 4.1 Rust path

Advantages:

- first-party Cedar Rust implementation and validator;
- nono is Rust-native;
- good fit for local security-sensitive daemon and static distribution.

Costs:

- desktop integration and development velocity may be slower depending on team familiarity.

## 4.2 Go path

Advantages:

- simple service lifecycle/static binary;
- strong local daemon/IPC ergonomics;
- mature OPA embedding if OPA is chosen.

Costs:

- Cedar integration/validation path may be less direct than Rust;
- nono may require FFI/subprocess adapter.

## 4.3 Decision rule

Do not choose a language and then rebuild authorization/sandbox primitives because the selected language makes reuse inconvenient.

Architecture spike must compare:

```text
Rust + Cedar + nono
vs
Go + embedded OPA or Cedar adapter + nono subprocess/FFI
```

Select the stack with the smallest audited custom security surface that passes the reference task and regression corpus.

---

# 5. Stable P0 interfaces

Only interfaces needed to isolate commodity dependencies are required.

```text
AgentAdapter
PolicyEngine
SandboxProvider
CredentialStore
ModelAdmission
VerifierAdapter
EvidenceStore
```

Do not create interface abstractions for systems that do not yet exist.

There is no P0 `CalibrationStore`, `RecommendationEngine`, `ExperimentRunner`, `CloudSyncTransport`, or generic `ToolGateway` service unless the selected sandbox requires a narrow adapter.

## 5.1 AgentAdapter

```text
AgentAdapter
  detect()
  version()
  prepare_task(task_context)
  launch(runtime_context)
  stop(runtime_id)
  compatibility_profile()
```

P0 implementation: Claude Code only.

## 5.2 PolicyEngine

```text
PolicyEngine
  validate(policy_bundle, schema) -> ValidationResult
  evaluate(auth_request, entities, policy_bundle) -> PolicyEvalResult
```

The result exposes:

- allow/deny from upstream evaluator;
- determining policies;
- evaluation errors;
- policy/schema version.

AgentWrangler adds product-level `ASK` outside the upstream binary evaluator.

## 5.3 SandboxProvider

```text
SandboxProvider
  probe() -> CapabilityReport
  compile(task_scope, workspace_facts) -> RuntimeProfile
  launch(runtime_profile, command, env) -> RuntimeHandle
  launch_constrained_tool(tool_profile, command, secret_refs?) -> ToolResult
  terminate(runtime_id)
```

P0 should prefer the upstream provider's own child-tool/credential boundary if it satisfies AgentWrangler tests rather than reimplementing it.

---

# 6. Task lifecycle

Canonical P0 task states:

```text
CREATED
  ↓
DISCOVERING
  ↓
AWAITING_TASK_PLAN
  ↓
AUTHORIZED
  ↓
RUNNING
  ↓
VERIFYING
  ↓
COMPLETED | FAILED | UNVERIFIED | CANCELLED
```

`NEEDS_REVIEW` is a verifier-integrity state, not a separate runtime lifecycle state.

## 6.1 Task start transaction

Before managed execution begins:

1. create `task_id`;
2. snapshot relevant workspace facts/base commit;
3. create Outcome Contract v1;
4. derive proposed Task Scope;
5. select routing mode/initial alias;
6. set task budget;
7. present one Task Plan;
8. persist approved grant(s);
9. compile sandbox profile;
10. issue task model credential;
11. launch runtime.

If any required P0 enforcement capability is unavailable, Full Governance launch fails rather than silently degrading.

---

# 7. Workspace facts and resource normalization

P0 needs a small authoritative fact set, not a generalized resource graph.

```text
workspace_id
workspace_root_realpath
base_commit
current_branch
remote_name
remote_url_normalized
repo_owner
repo_name
verifier_commands
verifier_sensitive_paths
sandbox_capabilities
agent_version
```

Fact provenance:

```text
AUTHORITATIVE
DISCOVERED
USER_DECLARED
```

Only authoritative/discovered state is used to bind supported consequential resources.

## 7.1 Filesystem normalization

Before scope comparison:

- canonicalize workspace root;
- resolve symlinks/junctions where the platform permits;
- normalize path case according to filesystem semantics;
- reject ambiguous/out-of-root paths for security-critical effects;
- re-check target immediately before supported consequential operations when TOCTOU is possible.

## 7.2 GitHub resource identity

Canonical form:

```text
github:<owner>/<repo>#<branch>
```

A grant binds to the canonical repository identity and branch selector, not the local remote nickname.

A changed remote URL or branch invalidates the prior relevant grant.

---

# 8. Task Plan: Outcome Contract + Task Scope

P0 combines the review interaction but preserves two stored objects.

## 8.1 Outcome Contract

Minimal schema:

```json
{
  "contract_id": "oc_...",
  "task_id": "task_...",
  "version": 1,
  "task_family": "BUG_FIX|FEATURE|GENERAL",
  "criteria": [
    {
      "criterion_id": "c1",
      "text": "login regression test passes",
      "required": true,
      "provenance": "USER|REPO_TEMPLATE|AGENTWRANGLER",
      "verifier_id": "repo-test"
    }
  ],
  "created_before_material_execution": true
}
```

Changes after execution starts create a new version and retain the old version.

The executing agent may propose criteria but cannot lower required criteria without operator authorization.

## 8.2 Task Scope

```json
{
  "task_id": "task_...",
  "filesystem": {
    "read": ["workspace/**"],
    "write": ["src/**", "tests/**"]
  },
  "network_groups": ["anthropic", "package_registry"],
  "external_actions": [
    {
      "action": "github.push",
      "resource": "github:acme/repo#feature/**"
    }
  ],
  "expires": "TASK_TERMINAL_STATE"
}
```

Scope is an authorization envelope, not proof that enforcement exists. The SandboxProvider capability report must identify which scope dimensions are actually enforceable.

---

# 9. Stage A authorization — Cedar-backed, AgentWrangler semantics

## 9.1 Why the custom evaluator is removed

P0 does not need to invent:

- a policy parser;
- expression language;
- allow/deny evaluator;
- schema validator;
- policy diagnostics.

Cedar is the preferred P0 evaluator because it is purpose-built for application authorization, uses principal/action/resource/context requests, supports default deny and forbid-overrides-permit, and validates policies against a schema.

OPA remains the fallback if the implementation-stack spike shows materially lower total complexity without weakening validation or local performance.

## 9.2 AgentWrangler retains Always / Ask / Never

Cedar returns binary `Allow`/`Deny`; AgentWrangler's product state is ternary:

```text
NEVER   → explicit product guardrail; must not be promptable
ALWAYS  → pre-authorized permit if resource constraints match
ASK     → no current task grant; user may create a bounded permit grant
```

A simple evaluation flow:

```text
normalize request
    ↓
validate request/resource identity
    ↓
explicit NEVER rule matches?
  yes → DENY
  no
    ↓
compile/evaluate current Cedar policies + task grants
    ↓
Cedar errors present on security-critical evaluation?
  yes → DENY + diagnostic
  no
    ↓
Cedar ALLOW?
  yes → ALLOW
  no
    ↓
product rule promptable?
  yes → ASK
  no  → DENY
```

This preserves user-facing semantics without rebuilding policy evaluation.

## 9.3 Cedar fail-closed adapter rule

Cedar's documented algorithm skips policies that error during evaluation and reports errors in diagnostics. AgentWrangler therefore applies a stricter adapter rule for supported security-critical actions:

> **Any policy-evaluation error relevant to the active security-critical policy bundle converts the AgentWrangler result to DENY.**

Additionally:

- all release/default policies are schema-validated before activation;
- changed policy/schema bundles must revalidate atomically;
- invalid bundles are not activated;
- the active policy/schema version is recorded with every decision.

## 9.4 Conceptual Cedar mapping

```text
principal = AgentTask::<task_id>
action    = Action::"github.push"
resource  = GitHubBranch::"acme/repo#feature/login"
context   = {
  runtime_id,
  workspace_id,
  grant_id,
  protection_profile
}
```

AgentWrangler owns the canonical entity construction.

## 9.5 Grant binding

Task grant key:

```text
task_id
+ action
+ normalized_resource_selector
+ constraints
+ expiry
```

Task grants cannot outlive the task or migrate to another runtime.

---

# 10. Runtime protection — reuse first

## 10.1 P0 provider selection

Preferred spike candidate: **nono**.

Reasons:

- OS-backed isolation;
- documented Linux/macOS/WSL2 support at the CLI/product level;
- child-tool sandboxing;
- separate tool policies;
- credential proxy/injection capabilities;
- library/binding options;
- Apache-2.0 licensing.

Comparator/fallback: **Anthropic Sandbox Runtime**.

The architecture does not assume either upstream's claims are sufficient. AgentWrangler ships only a tested profile/version combination.

## 10.2 Why AgentWrangler should not rebuild a tool sandbox

Current nono capabilities overlap significantly with the v4.3 proposed custom Runtime/Tool Gate and portions of the Credential/Action Broker. P0 should consume those primitives through `SandboxProvider` rather than reproduce:

- filesystem capability enforcement;
- network blocking/filtering primitives;
- subprocess inheritance controls;
- child-tool isolation;
- per-tool credentials;
- low-level path canonicalization already supplied by the sandbox where verified.

AgentWrangler still owns **whether** a tool/action is authorized and the normalized product resource it represents.

## 10.3 Protection profile

A profile is versioned evidence:

```json
{
  "profile_id": "linux-nono-p0",
  "sandbox_provider": "nono",
  "provider_version": "pinned-version",
  "capabilities": {
    "filesystem_scope": "ENFORCED",
    "network_scope": "ENFORCED",
    "child_tool_isolation": "ENFORCED",
    "credential_isolation": "ENFORCED",
    "admin_ipc_isolation": "ENFORCED"
  },
  "regression_suite_version": "sandbox-v3",
  "qualified_at": "..."
}
```

If the selected upstream cannot enforce a required P0 capability, either:

1. select the comparator provider;
2. remove/narrow the product claim; or
3. add the smallest narrowly tested compensating boundary.

Do not silently write a broad custom sandbox layer.

---

# 11. GitHub external-action boundary

P0 supports one consequential external family: a GitHub repository write.

## 11.1 Avoid generalized OAuth/broker infrastructure

P0 needs:

- one repo-scoped GitHub credential;
- push/PR-capable actions only as explicitly supported;
- revocation/test status;
- no generic SaaS connector framework.

Use OS credential storage plus the selected sandbox's constrained credential/tool mechanism where possible.

## 11.2 Execution pattern

Preferred language-agnostic implementation:

```text
agent requests supported GitHub effect
        ↓
AgentWrangler normalizes action/resource
        ↓
Stage A revalidates repo/branch/grant
        ↓
SandboxProvider launches constrained `git`/`gh` child tool
        ↓
credential available only to child tool / approved endpoint
        ↓
result + normalized evidence returned
```

If a provider SDK is materially safer/simpler than `git`/`gh` for a specific operation, it may replace the child command behind the same coordinator.

## 11.3 Raw shell bypass invariant

The raw agent may invoke an alternate `git`, `curl`, Python HTTP client, or absolute binary. That bypass path must **not** possess the protected GitHub credential or equivalent broad outbound authority.

Bypassing the convenience interception path must result in **less authority, not more**.

---

# 12. Secrets

P0 secret classes:

```text
Anthropic BYOK API key
GitHub repo-scoped credential
AgentWrangler operator IPC secret
Task-scoped model credential
```

Raw provider/GitHub credentials live in OS-protected credential storage.

Use established keyring libraries appropriate to the selected implementation language/OS rather than writing encrypted-file storage.

Secrets are referenced by opaque local IDs in SQLite.

The managed agent receives only the task-scoped model credential and any narrowly constrained tool credential injection required by the selected SandboxProvider.

---

# 13. Model path — no generic protocol gateway in P0

## 13.1 Why LiteLLM moves out of P0

V4.3 used LiteLLM as a replaceable protocol sidecar. That is reasonable for cross-provider translation, but P0 v0.6 has only:

```text
Claude Code → Anthropic-compatible AgentWrangler endpoint → Anthropic API
```

A general translation sidecar would add:

- another process lifecycle;
- another configuration surface;
- dependency/version compatibility;
- extra request debugging;
- policy confusion about which layer owns routing/retries.

Therefore P0 first validates a narrow Anthropic-wire ModelAdmission proxy.

If that spike shows the pass-through/streaming implementation is unexpectedly complex, LiteLLM can be reintroduced behind `ProtocolGateway` **only if it reduces total custom code and does not force its database control plane into P0**.

## 13.2 ModelAdmission API

```text
ModelAdmission
  issue_task_key(task_id)
  revoke_task_key(task_id)
  authorize_request(task_key, request_metadata)
  reserve_budget(task_id, bounded_request)
  dispatch(selected_target, normalized_request)
  reconcile(task_id, provider_usage)
```

The agent never chooses an arbitrary provider/model by sending a different model string.

## 13.3 Request validation

Before forwarding:

- authenticate task key;
- confirm task/runtime still active;
- validate selected alias/model against adapter-certified profile;
- reject unauthorized model overrides;
- enforce request token/output dimensions required by budget semantics;
- atomically reserve budget;
- attach task/request correlation;
- dispatch;
- reconcile usage or leave conservative reservation according to crash/error policy.

---

# 14. Stage B — deterministic two-tier router

P0 deliberately avoids training/classifying before trustworthy local data exists.

## 14.1 Aliases

```text
ECONOMY
CAPABLE
```

Each maps to a pinned/tested Anthropic model profile compatible with the Claude Code reference adapter.

## 14.2 User modes

```text
AUTO
FIXED_ECONOMY
FIXED_CAPABLE
```

## 14.3 Auto route

Start with the smallest deterministic rule set that can be audited. Transport retry and capability escalation are separate state transitions.

Example structure:

```text
if explicit high-risk/complexity signal:
    CAPABLE
else:
    ECONOMY

on transient PROVIDER_SERVICE failure:
    bounded retry/backoff on same alias

on eligible MODEL_REASONING failure or configured verifier failure:
    at most one ECONOMY -> CAPABLE escalation
```

A same-alias provider retry is not an escalation and cannot, by itself, justify a more capable model. P0 has one provider family and therefore does not turn provider outage handling into cross-provider failover. An agent-generated escalation request is also advisory input only: `StageBRouter` must independently match a configured escalation condition, and ModelAdmission budget/policy checks remain authoritative.

Possible P0 signals are versioned and intentionally few, such as:

- task explicitly asks for architecture/security-sensitive multi-file change;
- repository diff scope estimate exceeds configured threshold;
- user manually marks high complexity;
- prior economy attempt ended in eligible model-reasoning failure.

The exact rule set is a pilot parameter, not permanent architecture.

## 14.4 Route evidence

Persist:

```text
routing_rule_version
mode
selected_alias
concrete_model_profile
reason_codes
attempt_index
escalated_from
request_failure_category
  # MODEL_REASONING | PROVIDER_SERVICE | AGENT_ORCHESTRATION |
  # TOOL | ENVIRONMENT | POLICY | VERIFIER | USER_CANCEL | UNKNOWN
retry_kind  # NONE | SAME_ALIAS_PROVIDER_RETRY | CAPABILITY_ESCALATION
request cost/tokens/time
```

`task_outcomes` additionally records one deterministic `primary_failure_category` when the terminal task outcome is not successful. Recovered request-level errors remain request evidence; they do not become the terminal category solely because they are the most recent error.

This is sufficient for later learned-router evaluation without building a P0 calibration subsystem.

---

# 15. Budget ledger

This remains custom because it is a synchronous product invariant.

## 15.1 Reservation algorithm

For a request with a trustworthy upper cost bound:

```text
BEGIN IMMEDIATE
read task remaining budget
calculate conservative max request cost
if max request cost > remaining:
    reject
else:
    insert reservation
    decrement available amount / increase reserved amount
COMMIT
```

On provider completion:

```text
BEGIN
record actual provider usage
release unused reservation
charge actual amount
COMMIT
```

## 15.2 Hard vs best-effort

`HARD` only when AgentWrangler can conservatively bound the request before dispatch using:

- selected model pricing snapshot;
- configured max output/request dimensions;
- known pricing unit semantics.

Otherwise:

```text
BEST_EFFORT
```

with the reason recorded.

## 15.3 Crash semantics

If the daemon crashes after reservation but before reconciliation:

- reservation survives in SQLite;
- restart treats unresolved reservation conservatively;
- reconciliation may use provider response/evidence if available;
- P0 never silently restores spent/reserved budget simply because the process restarted.

SQLite WAL and atomic transactions are used; no Redis/PostgreSQL is required locally.

---

# 16. Verification and verifier integrity

Verification is a core custom semantic layer built on existing Git/test/CI tooling.

## 16.1 Trust baseline

Before material agent changes:

```text
base_commit
verifier command/config
existing test directories/files
CI workflow files if used
package/build/test scripts
AgentWrangler verifier policy version
```

The verifier policy itself remains outside the agent-writable workspace.

## 16.2 Final verification path

Preferred order:

1. clean Git worktree/checkout at candidate commit;
2. run repository-native configured checks using baseline verifier definition;
3. optionally consume trusted GitHub Actions evidence tied to the candidate commit;
4. evaluate Outcome Contract criteria.

P0 does not require a generalized CI integration framework. GitHub Actions is used only when configured and trustworthy.

## 16.3 Integrity classification

```text
CLEAN
AUTHORIZED_CHANGE
NEEDS_REVIEW
```

Changing a test file is not automatically malicious.

`NEEDS_REVIEW` examples:

- required test deleted/disabled;
- test command changed to unconditional success;
- required assertion materially weakened outside authorized task intent;
- CI workflow changed so the candidate self-selects weaker verification;
- verifier config changed outside authorized scope.

`NEEDS_REVIEW` cannot produce trustworthy verified success.

## 16.4 Outcome states

```text
VERIFIED_SUCCESS
VERIFIED_FAILURE
PARTIALLY_VERIFIED
UNVERIFIED
```

Task outcome calculation is deterministic for a given:

```text
Outcome Contract version
+ verifier evidence
+ verifier-integrity state
+ methodology version
```

No P0 delayed durability state exists.

---

# 17. Evidence and telemetry

## 17.1 Canonical task evidence

P0 uses task-centric domain records rather than building a generic tracing product.

Base event envelope:

```json
{
  "event_id": "uuid",
  "event_type": "POLICY_DECISION",
  "occurred_at": "...",
  "task_id": "...",
  "session_id": "...",
  "runtime_id": "...",
  "workspace_id": "...",
  "schema_version": 1,
  "payload": {}
}
```

## 17.2 P0 event types

Keep the vocabulary small:

```text
TASK_CREATED
TASK_PLAN_APPROVED
TASK_STARTED
TASK_FINISHED

POLICY_DECISION
APPROVAL_REQUESTED
APPROVAL_GRANTED
APPROVAL_DENIED

MODEL_ROUTE_SELECTED
MODEL_REQUEST_ADMITTED
MODEL_REQUEST_REJECTED
MODEL_USAGE_RECORDED
MODEL_ESCALATED

EXTERNAL_ACTION_REQUESTED
EXTERNAL_ACTION_EXECUTED
EXTERNAL_ACTION_DENIED

VERIFIER_BASELINE_CAPTURED
VERIFICATION_STARTED
VERIFIER_INTEGRITY_RESULT
VERIFICATION_RESULT
AGENT_ATTESTATION

TASK_OUTCOME_DERIVED
CONTAINMENT_STARTED
CONTAINMENT_COMPLETED
```

Do not pre-create P1 recommendation/calibration/experiment/durability event families in the P0 implementation.

Schema versioning permits later addition.

## 17.3 OpenTelemetry reuse

Use OpenTelemetry SDKs and established semantic conventions where applicable for generic telemetry such as:

- model/provider identity;
- token counts;
- request duration;
- HTTP status/error type;
- tool invocation timing;
- daemon internal metrics/traces.

AgentWrangler-specific domain events remain custom where OTel does not express product semantics:

- Task Scope grant;
- Cedar decision/grant linkage, including the matched `grant_id`/decision source required to measure observed Task Scope reuse without claiming counterfactual approvals avoided;
- verifier-integrity classification;
- Outcome Contract criterion result;
- trustworthy task outcome.

P0 does not run an OpenTelemetry Collector by default and does not require an observability backend. OTel is an instrumentation/export vocabulary, not the canonical task database.

## 17.4 Sensitive content

Raw source, complete prompts, complete model responses, and secrets are not required for P0 metrics.

Content logging is off by default.

---

# 18. Local SQLite model

P0 uses one managed SQLite database outside agent-writable workspaces.

## 18.1 Tables

Keep the schema compact:

```text
workspaces
workspace_facts
connections_without_secret_values

policies
policy_versions
tasks
sessions
runtimes
outcome_contracts
outcome_criteria
task_scope_grants
approvals
protection_snapshots

routing_decisions
model_requests
budget_reservations
pricing_snapshots

verifier_baselines
verification_runs
verification_results
task_outcomes

canonical_events
schema_migrations
```

P0 does **not** require:

```text
cohort_definitions
metric_rollups
calibration_models
calibration_observations
cohort_priors
recommendations
configuration_versions
experiment_runs
durability_results
cloud_outbox
```

## 18.2 Storage properties

- WAL mode where supported;
- foreign keys on;
- atomic budget/task/grant transitions;
- event IDs immutable;
- database outside protected workspace;
- managed runtime lacks write access;
- indexed task timestamp/outcome/route/model fields;
- regular SQLite integrity checks.

Append-oriented evidence does not imply tamper-proofness against a compromised user/root/daemon.

---

# 19. P0 analytics without a rollup platform

## 19.1 Why the rollup worker is removed

For one developer, one workspace, and early pilot sample sizes, a background cohort/materialization platform is premature.

P0 calculates aggregate metrics from `tasks`, `task_outcomes`, `routing_decisions`, and `model_requests` using indexed SQL.

Example metrics:

```text
Trustworthy Verified Success Rate
Observed Cost per Trustworthy Verified Success
Median Time to Verified Outcome
First-Route Success Rate
Verification Coverage
Observed Pre-Escalation Waste
Failure Category Breakdown
```

## 19.2 Qualification

Every aggregate response includes:

```text
time_range
sample_size
verification_coverage
cost_observability
source_task_ids or drilldown cursor
metric_definition_version
```

Incomplete cost/token rows do not silently enter exact-cost calculations.

Failure-category aggregation uses the deterministic task/request classification above. Provider/service, environment, tool, policy, verifier, and agent/orchestration failures remain separate from model-reasoning failure so first-route/model comparisons do not learn from unrelated infrastructure failures.

### 19.2.1 Metric eligibility and attribution contract

`LocalQueryAPI` implements the PRD v0.6.2 metric contract directly rather than leaving denominator choices to UI code.

Define `trustworthy_terminal_set` as terminal tasks with `FULL` required-criterion verification, verifier integrity `CLEAN` or `AUTHORIZED_CHANGE`, and outcome `VERIFIED_SUCCESS` or `VERIFIED_FAILURE`. `PARTIALLY_VERIFIED` / `UNVERIFIED` remain queryable but are excluded from metrics that require trustworthy binary outcome classification; their exclusion is surfaced through Verification Coverage.

```text
trustworthy_verified_success_rate =
  verified_success_count / trustworthy_terminal_count

verification_coverage =
  trustworthy_terminal_count / terminal_executed_task_count

cost_per_trustworthy_verified_success =
  sum(exact_model_cost for exact-cost tasks in trustworthy_terminal_set)
  / verified_success_count_in_same_exact_cost_set

first_route_success_rate =
  auto_tasks_verified_success_without_alias_change
  / auto_tasks_in_trustworthy_terminal_set
```

Rules:

- failed tasks in the exact-cost trustworthy set contribute cost to the cost-per-success numerator; otherwise the metric understates the economics of failure;
- same-alias provider retries do not count as model-route escalation and do not make `first_route_success=false`;
- `Observed Pre-Escalation Waste` includes only factual pre-alias-change cost/tokens/time and carries the escalation-trigger category;
- task failure breakdown uses `task_outcomes.primary_failure_category`; request-level errors are separately retained in `model_requests`;
- user cancellations are reported but excluded from model-quality denominators;
- any eligibility/denominator/timing/attribution change increments `metric_definition_version`.

These semantics belong in the query/domain layer, not chart-specific frontend code.

Task Scope reuse is available as **pilot evidence** without a new rollup table: a `POLICY_DECISION` records whether an already-active `grant_id` satisfied a consequential authorization check. The creation check itself is excluded. This may be queried during the pilot but is not a required P0 dashboard metric.

## 19.3 When to add materialized rollups

Move to P1 materialization only after measurement demonstrates one of:

- dashboard query latency is unacceptable;
- dataset volume makes direct aggregation costly;
- cross-workspace/device cohorts require it;
- calibrated router/recommendation workloads need stable cohort snapshots.

Architecture follows measured need rather than anticipation.

---

# 20. Local dashboard/query architecture

P0 surfaces:

```text
Overview
Tasks
Controls
Router
```

There is no dedicated P0 Recommendations page and no full Performance analytics workbench.

## 20.1 Overview

Shows:

- trustworthy verified success;
- cost per trustworthy verified success where exact enough;
- median time to verified outcome;
- first-route success;
- verification coverage;
- observed pre-escalation waste;
- current protection/budget status;
- recent tasks.

## 20.2 Tasks

Task detail shows:

- Outcome Contract;
- Task Scope;
- route sequence;
- model usage/cost;
- approvals/external actions;
- candidate commit;
- agent claim;
- verifier evidence/integrity;
- final outcome;
- chronological event timeline.

## 20.3 Controls

Shows/configures:

- active protection profile and exact capabilities;
- Always/Ask/Never policy defaults;
- current connections without secrets;
- task/default budget settings;
- Stop Agent.

## 20.4 Router

Shows:

- Auto vs Fixed modes;
- two alias/model mappings;
- route reason history;
- first-route success;
- escalation count;
- factual pre-escalation waste;
- failure-category breakdown, separating model-reasoning from provider/service, environment, tool, policy, verifier, and agent/orchestration causes.

No predicted success probability, calibration chart, counterfactual savings, or Router Regret in P0.

## 20.5 Query API

A small stable API is sufficient:

```text
getOverview(filters)
listTasks(filters, cursor)
getTask(task_id)
getTaskEvidence(task_id)
getControls()
getRouterSummary(filters)
```

`getOverview` / `getRouterSummary` return versioned metric fields, including the P0 failure-category breakdown; they do not require a new endpoint or materialized read model. The query contract preserves bidirectional traceability between documented P0 metrics and the four UI surfaces.

The UI must not issue arbitrary SQL.

P0 filters need only:

```text
workspace
time range
route mode
model alias
outcome
```

Task family filtering may be added cheaply if useful, but a generalized cohort language is not P0.

---

# 21. Local IPC security

Logical channels:

```text
operator IPC     Desktop → daemon
model IPC        managed agent → ModelAdmission
sandbox/helper   daemon → optional helper/provider
```

Requirements:

- operator API binds only to user-local IPC/loopback by default;
- random operator credential protected from managed runtime;
- task model credentials cannot call admin API;
- terminated task credentials are rejected;
- browser UI, if used, has CSRF/origin defenses;
- destructive operator actions require explicit confirmation;
- managed runtime cannot read daemon DB or credential-vault handles.

A separate generic broker IPC service is not required if constrained tools are launched by the daemon/SandboxProvider.

---

# 22. Containment

Stop Agent must:

1. mark task/runtime stopping;
2. revoke task model credential;
3. terminate managed runtime/process tree through SandboxProvider;
4. prevent new external constrained-tool launches;
5. preserve existing evidence;
6. record containment result;
7. report partial failures truthfully.

P0 containment does not promise revocation of arbitrary downstream resources outside the supported Anthropic/GitHub path.

---

# 23. Installer and lifecycle

P0 user experience remains one product.

Installer responsibilities:

- install desktop/UI;
- install daemon;
- install/pin selected sandbox runtime/provider if bundled;
- create local service/user startup configuration;
- initialize SQLite outside workspaces;
- initialize OS-vault entries;
- detect Claude Code;
- run protection capability/security probes;
- upgrade schema and pinned dependencies;
- rollback failed application update where practical.

P0 explicitly does **not** install or manage:

- Docker;
- PostgreSQL;
- Redis;
- LiteLLM sidecar;
- OTel Collector;
- cloud agent;
- calibration/recommendation worker.

## 23.1 Supply-chain gate

Security-sensitive upstreams must be:

- version pinned;
- integrity/hash/signature checked where available;
- SBOM-listed;
- dependency/advisory scanned;
- exercised by the AgentWrangler regression suite before promotion;
- independently capability-probed on the user's machine.

An installed upstream package is not sufficient evidence for an `ENFORCED` label.

---

# 24. Degraded/failure behavior

| Failure | P0 behavior |
|---|---|
| Cedar bundle invalid | refuse activation; keep last valid bundle |
| Cedar runtime diagnostics on security-critical request | deny request + surface diagnostic |
| sandbox capability probe fails | Full Governance launch blocked |
| Anthropic unavailable | task request fails/retries only within configured limit; no silent provider switch |
| stale/unknown pricing | budget becomes best-effort or request denied per policy |
| SQLite write failure | fail closed for new grants/model admission that require durable state |
| verifier unavailable | task may finish `UNVERIFIED`; never synthesize success |
| GitHub credential unavailable | external action denied; local task may continue |
| dashboard fails | enforcement continues; raw local evidence remains available via diagnostics/CLI if implemented |

No cloud/offline failure mode exists in P0 because there is no cloud dependency.

---

# 25. Threat model

Primary P0 threats:

1. malicious/compromised coding agent;
2. prompt-induced harmful external action;
3. filesystem escape;
4. network escape;
5. child-tool bypass;
6. credential exfiltration;
7. daemon admin IPC access;
8. Git remote/branch substitution after approval;
9. symlink/junction path substitution;
10. budget race/concurrent overspend;
11. stale pricing causing false hard-budget claim;
12. model string/endpoint bypass;
13. sandbox dependency vulnerability/misconfiguration;
14. verifier/test/CI weakening;
15. candidate commit/verifier commit mismatch;
16. forged/replayed task grant;
17. evidence DB mutation from managed runtime;
18. malicious dependency/update.

P0 does not claim to withstand a fully compromised host administrator/root account.

---

# 26. Security and integration test corpus

## 26.1 Sandbox/runtime

- read outside workspace;
- write outside workspace;
- symlink points outside workspace;
- direct alternate shell binary;
- direct `curl`/Python socket to blocked service;
- host SSH agent access;
- host credential-helper access;
- daemon IPC access;
- SQLite DB access;
- raw provider/GitHub secret discovery;
- child tool attempts to inherit broader parent capability;
- regression cases for relevant upstream advisories.

## 26.2 Policy/resource

- explicit `Never` plus otherwise permitting grant;
- invalid Cedar policy activation;
- Cedar evaluation error on critical request;
- changed Git remote after grant;
- changed branch after grant;
- grant from another task replayed;
- expired grant replayed;
- path normalization/case/symlink edge cases.

## 26.3 Model/budget

- agent changes model string;
- agent changes endpoint/path;
- concurrent requests at budget edge;
- daemon crash after reservation;
- missing provider usage;
- streaming termination;
- stale price;
- output limit omitted/expanded.

## 26.4 Verification

- delete required tests;
- change test command to `exit 0`;
- weaken assertion;
- edit CI workflow to skip check;
- legitimate authorized test modification;
- candidate commit differs from verified commit;
- verifier command missing/broken;
- agent claims pass while independent verifier fails.

## 26.5 Dashboard/evidence

- aggregate reconciles to task rows;
- partial token/cost observability excluded from exact metric;
- drill-down task set matches aggregate numerator/denominator;
- factual pre-escalation waste does not include counterfactual savings.

---

# 27. Performance targets

P0 targets should be measured after the spike rather than drive premature subsystems.

Targets:

```text
local policy evaluation overhead:
  p95 <= 10 ms target

ModelAdmission local overhead:
  p95 <= 20 ms target, excluding provider latency

Task Plan approval persistence:
  interactive / imperceptible relative to user action

local Overview query:
  p95 <= 250 ms at pilot-scale data volume
```

If direct SQLite aggregates meet the dashboard target, no materialized rollup system is justified.

Sandbox launch and clean verifier startup are measured separately and not hidden inside routing/admission latency.

---

# 28. P0 reference topology

```text
AgentWrangler Desktop
        │
        ▼
AgentWrangler Daemon
  ├─ WorkspaceRegistry
  ├─ TaskCoordinator
  ├─ OutcomeContractManager
  ├─ ResourceNormalizer
  ├─ CedarPolicyAdapter
  ├─ StageBRouter
  ├─ ModelAdmission
  │    └─ SQLite BudgetLedger
  ├─ SandboxProvider adapter
  ├─ GitHubActionCoordinator
  ├─ VerifierCoordinator
  ├─ EvidenceStore / TaskOutcomeCalculator
  ├─ LocalQueryAPI
  └─ Containment
        │
        ├──────── OS vault
        ├──────── SQLite
        ├──────── Anthropic API
        └──────── managed Claude Code sandbox
                         │
                         └─ constrained GitHub child action

Separate clean verifier worktree / optional trusted GitHub Actions evidence
```

This topology has no P0 cloud service, gateway sidecar, analytics worker, recommendation worker, or replay worker.

---

# 29. Development sequence

## Phase 0 — architecture spikes

1. Claude Code Anthropic-wire proxy conformance;
2. Cedar embedding/validation in candidate daemon stack;
3. nono vs Anthropic Sandbox Runtime regression comparison;
4. GitHub constrained credential/tool path;
5. SQLite budget reservation crash/concurrency prototype;
6. clean verifier worktree prototype.

A spike should end with a binary architectural decision, not become a permanent parallel implementation.

## Phase 1 — P0 vertical slice

- installer/service lifecycle;
- Claude Code adapter;
- one Anthropic BYOK connection;
- one Git workspace/GitHub remote;
- Task Plan;
- Cedar-backed Stage A;
- selected validated sandbox profile;
- constrained GitHub action;
- deterministic two-tier routing;
- ModelAdmission/hard-budget semantics;
- canonical task evidence;
- clean/trusted verification and integrity classification;
- local Overview/Tasks/Controls/Router.

## Phase 2 — P1 evidence-informed breadth

Roadmap phases are extension boundaries, not authorization to pre-build future subsystems. Any P1+ component requires an explicit promotion decision/ADR tied to observed need or a committed product requirement.

Only after P0 pilot evidence:

- Codex/OpenAI profile;
- Native Login compatibility;
- additional **agent-compatible** provider/model profiles;
- LiteLLM/equivalent only where the active agent/provider wire contract is officially compatible and translation justifies it;
- learned router benchmarking;
- generalized cohort definitions/materialized rollups if needed;
- calibrated predictions after adequate trustworthy sample size;
- Performance page;
- more verifier/task families;
- broader OAuth/integration support;
- broader OS profile validation.

### Evidence-gated P1 analytics candidates

These have preserved source seams but **no reserved P0 worker/table/page**:

- provider reliability workbench — only if task/request evidence shows provider behavior materially affects decisions;
- token/context efficiency and loop-waste — only after a privacy-safe, versioned method is justified by observed spend;
- governance-effectiveness analytics — only if approval/Task Scope/budget/containment evidence shows a recurring decision problem that task drill-down cannot answer.

Promotion requires an ADR that identifies the observed trigger, new persisted/derived state, dashboard decision enabled, privacy impact, and removal/rollback plan if the feature does not produce value.

## Phase 3 — P2 optimization/cloud

- delayed durability/rework attribution;
- recommendations;
- configuration versioning/apply/measure/rollback;
- controlled alternate-route replay;
- Router Regret;
- cloud telemetry/remote history;
- cross-device views;
- shared calibration only after privacy/utility proof.

## Phase 4 — P3 team/enterprise

- organizations/projects;
- central policy ceilings;
- shared approvals;
- SSO/RBAC;
- SIEM/retention;
- federation;
- fleet/private telemetry.

---

# 30. P0 architecture decisions

## AD-001 — Local only

P0 contains no AgentWrangler Cloud implementation.

**Reason:** cloud is not required for enforcement or the solo-developer value proof.

## AD-002 — Claude Code + Anthropic only

P0 certifies one agent and one provider family.

**Reason:** cross-provider breadth is independent of proving policy/budget/verification value, and current Claude Code gateway documentation explicitly states that Anthropic does not support routing Claude Code to non-Claude models through a gateway. Gateway translation capability is therefore not treated as agent compatibility.

## AD-003 — Cedar-backed Stage A

Use Cedar as preferred authorization evaluator, with AgentWrangler preserving product policy/grant semantics and applying stricter fail-closed error handling on security-critical requests.

**Fallback:** OPA if implementation-stack evidence shows materially lower total custom/security complexity.

## AD-004 — Upstream sandbox provider

Do not build a kernel sandbox or generic child-tool sandbox. Select and pin a tested upstream provider behind `SandboxProvider`.

Preferred spike: nono. Comparator: Anthropic Sandbox Runtime.

## AD-005 — No LiteLLM critical-path dependency

Attempt narrow Anthropic-wire ModelAdmission first. Introduce LiteLLM only when translation breadth makes it net simpler.

## AD-006 — Deterministic router

P0 uses Auto/Fixed with two model aliases and no learned classifier/calibrated probability.

## AD-007 — Custom ModelAdmission/budget invariant

AgentWrangler owns task key, allowed target, atomic budget reservation, and reconciliation.

## AD-008 — SQLite only

P0 control/evidence/analytics use managed SQLite. No PostgreSQL/Redis.

## AD-009 — Direct SQL P0 analytics

No generalized cohort/materialized rollup system until measured need.

## AD-010 — OpenTelemetry as generic telemetry vocabulary/export layer

Do not use OTel as the canonical product evidence database; do not invent competing generic model/token/HTTP attribute names unnecessarily.

## AD-011 — No generalized credential broker

P0 uses OS vault + narrowly constrained Anthropic/GitHub paths. Generic OAuth/federation belongs later.

## AD-012 — Clean verification remains custom semantics

Reuse Git/test/CI execution primitives; retain Outcome Contract/verifier-integrity logic in AgentWrangler.

---

# 31. What AgentWrangler should own permanently

1. task identity/lifecycle semantics;
2. Workspace/normalized-resource semantics;
3. Outcome Contract semantics;
4. Task Scope and task grant semantics;
5. Always/Ask/Never UX and promptability rules;
6. mapping those semantics into the selected authorization engine;
7. truthful protection capability model;
8. Stage B route policy/evidence semantics;
9. ModelAdmission/hard-budget invariant;
10. normalized consequential-action authorization;
11. task-centric canonical product evidence;
12. verifier-integrity/trustworthy-outcome semantics;
13. metric definitions and observability qualification;
14. aggregate → task → evidence drill-down;
15. one-tool onboarding and user experience.

---

# 32. What AgentWrangler should avoid rebuilding

Prefer upstream components/libraries for:

- authorization language/parser/evaluator/validator;
- OS/kernel sandbox mechanics;
- generic child-tool sandboxing/credential proxy when sufficient;
- OS credential vault integration libraries;
- Git and GitHub command/API mechanics;
- provider SDK request/stream parsing;
- generic GenAI/HTTP/tool telemetry conventions;
- database engine/transactions;
- generic web/desktop UI components/charts;
- cross-provider model gateway translation once needed;
- generic OAuth/device-flow implementation once multiple SaaS integrations justify it;
- tracing/metrics backend;
- enterprise policy distribution/SIEM/fleet infrastructure.

---

# 33. Definition of architectural success

P0 architecture is successful when this exact chain is demonstrable:

```text
install
  ↓
detect Claude Code
  ↓
qualify protection profile
  ↓
connect Anthropic BYOK + one GitHub repo credential
  ↓
register workspace / snapshot base commit
  ↓
create Task Plan
  Outcome Contract + bounded Task Scope
  ↓
user approves
  ↓
Cedar-backed Stage A validates relevant authority
  ↓
launch managed runtime without raw secrets/admin IPC
  ↓
Auto or Fixed two-tier model route selected
  ↓
ModelAdmission reserves budget before dispatch
  ↓
agent works in bounded runtime
  ↓
GitHub action requires normalized repo/branch revalidation
  ↓
constrained child action receives only required credential
  ↓
candidate commit produced
  ↓
clean/trusted verifier evaluates original criteria
  ↓
verifier-integrity state recorded
  ↓
trustworthy task outcome + cost/time/route recorded
  ↓
local dashboard aggregate reconciles to task evidence
  ↓
Stop Agent revokes model task credential and terminates runtime
```

Security proof points:

- absolute-binary/wrapper bypass does not recover GitHub/provider/admin authority;
- sandbox denies out-of-scope filesystem/network tests on the qualified profile;
- Cedar invalid/evaluation-error cases fail closed for supported critical actions;
- resource substitution invalidates/requires reauthorization;
- concurrent model requests cannot spend the same budget reservation;
- managed runtime cannot alter the evidence database;
- verifier weakening cannot produce trustworthy success;
- no unverified task is rendered as verified success;
- P0 runs without Docker/PostgreSQL/Redis/cloud/LiteLLM/OTel Collector administration.

Product-learning proof points:

- Auto can be compared against Fixed Capable using actual trustworthy outcomes;
- cost per verified success is reproducible from persisted task evidence;
- first-route success and factual pre-escalation waste reconcile to route history;
- the dashboard is useful before a recommendation/calibration platform exists.

---

# 34. External research basis — accessed 2026-08-20

The v4.4 decisions were informed by current upstream documentation/repositories:

- Anthropic Claude Code gateway support boundary and gateway behavior: https://code.claude.com/docs/en/llm-gateway
- Cedar authorization algorithm, diagnostics, default-deny, forbid-overrides-permit, and skip-on-error behavior: https://docs.cedarpolicy.com/auth/authorization.html
- Cedar schema/policy validation: https://docs.cedarpolicy.com/policies/validation.html
- Cedar implementation: https://github.com/cedar-policy/cedar
- Open Policy Agent integration/embedding alternative: https://www.openpolicyagent.org/docs/integration
- nono sandbox and child-tool/credential model: https://github.com/nolabs-ai/nono
- Anthropic Sandbox Runtime comparator: https://github.com/anthropic-experimental/sandbox-runtime
- OpenTelemetry framework and Collector role: https://opentelemetry.io/docs/
- OpenTelemetry GenAI semantic-convention example: https://opentelemetry.io/blog/2026/genai-observability/
- LiteLLM gateway: https://docs.litellm.ai/
- SQLite WAL: https://www.sqlite.org/wal.html

Upstream feature claims are treated as candidates, not AgentWrangler guarantees. A security-sensitive dependency becomes an AgentWrangler-supported protection boundary only after version pinning, local capability probing, and the AgentWrangler regression corpus pass.

---

# 35. Decision / change log — Technical Architecture v4.3 → v4.4

**Date:** 2026-08-20  
**Review type:** Adversarial scope + build-vs-reuse review

## Scope reductions

1. **Removed Native Login from P0 — ACCEPTED.**  
   **Removed:** second auth/capability path, degraded routing/budget behavior, P0 Native Login tests/UI.  
   **Preserved seam:** `auth_mode` may be added/persisted where cheap; AgentAdapter does not assume BYOK forever.  
   **Downstream:** Native Login P1 must explicitly reintroduce partial-observability states rather than reuse Full Governance claims.

2. **Removed cross-provider/OpenAI/Codex P0 breadth — ACCEPTED AND STRENGTHENED.**  
   **Removed:** provider compatibility matrix and cross-provider translation from first release.  
   **P0 replacement:** two certified Anthropic/Claude model aliases through Claude Code.  
   **External constraint:** current Anthropic gateway documentation states that Anthropic does not support routing Claude Code to non-Claude models through a gateway. AgentWrangler therefore treats the agent's supported model contract as a hard compatibility boundary, not something LiteLLM or another translator can bypass.  
   **Downstream:** OpenAI support arrives through a compatible Codex/OpenAI adapter/profile; provider and agent compatibility remain independent dimensions.

3. **Removed LiteLLM sidecar from P0 critical path — ACCEPTED, SPIKE-GATED.**  
   **Why:** a single Anthropic wire path does not justify a general gateway process.  
   **P0:** narrow Anthropic-compatible ModelAdmission endpoint.  
   **Fallback:** reintroduce LiteLLM only if conformance testing shows that using it is less code/operational risk than maintaining the narrow pass-through.

4. **Removed learned/LLM router and four capability classes — ACCEPTED.**  
   **P0:** deterministic `ECONOMY`/`CAPABLE` Auto/Fixed routing.  
   **Downstream:** route/outcome evidence is retained for P1 learned-router benchmarking.

5. **Removed Optimization Objective engine from P0 — ACCEPTED.**  
   **Why:** weighted quality/cost/time objectives require mature measurements.  
   **P0:** explicit Auto/Fixed modes only.

6. **Removed generalized cohort fingerprint/rollup subsystem — ACCEPTED.**  
   **P0:** indexed SQLite task-summary aggregates.  
   **Downstream:** add materialized cohorts only on measured performance/cross-device/calibration need.

7. **Removed Outcome/Analytics background worker from P0 — ACCEPTED.**  
   **P0:** outcome derives synchronously/near-synchronously at terminal verification and simple SQL handles aggregate queries.  
   **Impact:** fewer processes, failure modes, rebuild semantics, and health signals.

8. **Reduced dashboard architecture — ACCEPTED.**  
   **P0:** Overview, Tasks, Controls, Router.  
   **Deferred:** dedicated Performance analytics workbench and Recommendations page.

9. **Removed delayed durability/rework/reopen architecture — ACCEPTED.**  
   **Why:** requires delayed jobs and uncertain causal attribution.  
   **P0:** immutable terminal outcome only.  
   **P1/P2:** append delayed evidence later without rewriting P0 source evidence.

10. **Removed calibration, recommendation, configuration-version, and experiment subsystems from P0 — ACCEPTED.**  
    **Why:** they consume trustworthy history; they do not generate the first trustworthy history.  
    **Impact:** removes multiple stores/workers/APIs and mutation trust surfaces.

11. **Removed AgentWrangler Cloud architecture from P0 implementation — ACCEPTED.**  
    **Impact:** no outbox, device identity, ingestion, cloud DB, remote dashboard, cloud failure path, or telemetry sync code.  
    **Preserved:** opaque IDs/schema versioning/privacy discipline make later export possible.

12. **Removed generalized credential/OAuth broker from P0 — ACCEPTED.**  
    **P0:** OS vault + one Anthropic secret + one repo-scoped GitHub credential + constrained tool injection.  
    **P1+:** add OAuth/device flow/federation when integration breadth justifies it.

13. **Reduced canonical P0 event vocabulary — ACCEPTED.**  
    **Why:** defining future events does not create present value and encourages premature schema/service implementation.  
    **Preserved:** schema versioning and task correlation.

## Reuse / anti-reinvention decisions

14. **Replace custom P0 policy evaluator with Cedar-backed evaluation — ACCEPTED WITH ADAPTER RULE.**  
    Cedar supplies authorization parsing/evaluation, PARC semantics, schema validation, default deny, forbid-overrides-permit, and diagnostics. AgentWrangler retains promptability/Always-Ask-Never/task grants/resource normalization. Because Cedar intentionally skips erroneous policies during its algorithm, AgentWrangler converts relevant evaluation errors to fail-closed `DENY` for supported security-critical actions.

15. **Keep OPA as a real fallback, not a second P0 engine — ACCEPTED.**  
    OPA is mature and embeddable, especially for Go. P0 ships one engine. The architecture spike may choose OPA only if total implementation/security complexity is lower than Cedar in the chosen language.

16. **Delegate sandbox/tool primitives more aggressively to upstream — ACCEPTED.**  
    Current nono functionality substantially overlaps the former custom Runtime/Tool Gate and portions of credential child-tool isolation. AgentWrangler should consume these primitives through `SandboxProvider`, not duplicate them. Anthropic Sandbox Runtime is a comparator/fallback. Both remain subject to pinned-version qualification and regression testing.

17. **Reuse existing Git/GitHub execution surfaces — ACCEPTED.**  
    Prefer constrained `git`/`gh` or provider SDK execution rather than a home-grown transport/auth stack. AgentWrangler owns normalized action/resource authorization and the credential boundary.

18. **Reuse OS keyrings — ACCEPTED.**  
    Do not create encrypted local secret-file storage.

19. **Reuse OpenTelemetry generic semantic conventions — ACCEPTED.**  
    Model/token/latency/HTTP/tool telemetry should reuse standard instrumentation where practical. AgentWrangler retains task-specific evidence semantics and does not require an OTel backend/Collector in P0.

20. **Reuse SQLite transaction/WAL guarantees — ACCEPTED.**  
    Budget/task/grant crash consistency is implemented as AgentWrangler transaction semantics on SQLite rather than building a separate local datastore/queue.

21. **Retain custom ModelAdmission/budget semantics — RETAINED.**  
    This is not commodity observability/accounting: it is the synchronous invariant that an active task cannot use an unapproved model target or double-spend its governed budget.

22. **Retain custom Outcome Contract/verifier-integrity semantics — RETAINED.**  
    Existing Git/test/CI systems execute checks, but they do not define AgentWrangler's task success contract or decide whether the agent weakened its own proof.

23. **Retain task-centric canonical evidence — RETAINED, REDUCED.**  
    OTel/tracing systems are not substitutes for the durable product evidence required to reconstruct approval, route, external effect, verifier integrity, and task outcome. The schema is reduced to the minimum P0 event set.

## Net architecture effect

Compared with v4.3, v4.4 removes five major P0 subsystem families:

```text
cloud sync/cloud services
calibration/recommendation/experiment platform
generalized analytics rollup platform
cross-provider gateway/classifier platform
generalized credential/tool brokerage platform
```

and replaces custom low-level policy/sandbox/telemetry work with upstream components wherever the security spike confirms that they satisfy the required boundary.

The intended result is not merely fewer lines of code. It is fewer independently failing trust boundaries, fewer processes to install, fewer databases/queues, fewer user-visible concepts, and a faster path to learning whether the core AgentWrangler control-and-evidence loop is valuable.
---

# 36. Decision / change log — Technical Architecture v4.4 → v4.4.1

**Date:** 2026-08-20  
**Review type:** Merge review of independent dashboard-metric architecture pass

1. **Failure taxonomy made explicit in routing/outcome evidence — ACCEPTED.**  
   P0 now distinguishes model reasoning from provider/service, environment, tool, policy, verifier, agent/orchestration, user-cancel, and unknown failures. This protects first-route/model analysis from attribution error.

2. **Failure Category Breakdown added to direct-SQL P0 analytics — ACCEPTED WITHOUT A ROLLUP WORKER.**  
   The value is computed from existing indexed task/request evidence and returned through existing Overview/Router query contracts.

3. **Task Scope reuse instrumentation clarified — ACCEPTED AS PILOT-ONLY ANALYTICS.**  
   `POLICY_DECISION` records matched grant identity/source. Reuse can be calculated directly from events; no `governance_effectiveness_rollup` table or dashboard workbench is introduced.

4. **Bidirectional metric/UI traceability clarified — ACCEPTED.**  
   Existing query methods return versioned metrics mapped to the four P0 surfaces. No specialized endpoint family is required.

5. **Provider reliability rollups/endpoints — DEFERRED.**  
   OpenTelemetry already captures provider identity, HTTP status/error type, and request duration. With one P0 provider family, separate `provider_reliability_rollup` storage and UI add little decision value.

6. **Token/context efficiency rollups — DEFERRED.**  
   Token totals remain available. Repeated-context/loop-waste fingerprinting is intentionally postponed because it adds methodology, privacy, and storage complexity.

7. **Governance-effectiveness / budget-utilization / containment-performance rollups — DEFERRED.**  
   Source events retain enough timestamps and results to calculate these later if pilot evidence shows user value; P0 does not materialize them.

8. **No Performance page, Optimization Objective subsystem, calibration store, recommendation/config executor, durability processor, experiment worker, cloud pipeline, or generalized cohort infrastructure was restored.**

9. **Net topology unchanged.**  
   The patch improves measurement validity and traceability while preserving the v4.4 P0 process count, SQLite schema family, four-surface dashboard, and direct-SQL analytics strategy.

---

# 37. Decision / change log — Technical Architecture v4.4.1 → v4.4.2

**Date:** 2026-08-20  
**Review type:** Final execution-readiness / phase-boundary consistency pass

1. **Moved metric denominator logic into the domain/query contract — ACCEPTED.**  
   `LocalQueryAPI` owns versioned eligibility/denominator semantics so UI charts cannot independently reinterpret success/economics.

2. **Separated `SAME_ALIAS_PROVIDER_RETRY` from `CAPABILITY_ESCALATION` — ACCEPTED.**  
   Provider retry/backoff stays on the same alias; only eligible capability/verifier signals may cause the single P0 ECONOMY → CAPABLE escalation. Agent self-request remains advisory and cannot independently authorize the more expensive alias.

3. **Separated request failure evidence from terminal task attribution — ACCEPTED.**  
   `model_requests` retains request-level failure categories while `task_outcomes` records one deterministic `primary_failure_category`.

4. **Added phase-promotion guardrail — ACCEPTED.**  
   P1+ systems require an explicit ADR tied to observed/committed need rather than being pre-built because an interface or roadmap entry exists.

5. **Added evidence-gated P1 analytics candidates without reserving P0 topology — ACCEPTED.**  
   Provider reliability, token/context/loop-waste, and governance-effectiveness analytics have promotion criteria but no P0 worker/table/page allocation.

6. **P0 topology remains unchanged.**  
   Still one local daemon/control plane, one SQLite store, one Anthropic/Claude model path, one validated sandbox profile, one GitHub authority path, one verifier path, and four local dashboard surfaces.
