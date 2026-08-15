# Poolstatis Product Decision Loop — P0/P1 PRD

Date: 2026-07-18
Status: implemented
Product owner: TBD
Implementation completed: 2026-07-20

## 1. Product decision

Poolstatis should not compete as another analytics dashboard or as an MCP wrapper
around charts. It should help product teams answer one recurring business question:

> Which product change worked, why, and what should we do next?

The coding agent is the operating mechanism, not the primary marketing promise. It
sets up measurement, checks data quality, runs analysis and prepares the next action.
The value is delivered to a founder, product manager, growth lead or engineering lead
as a trustworthy product decision.

The P0/P1 product loop is:

```text
define expected outcome
  -> ship a change
  -> verify real measurement
  -> observe the outcome
  -> explain the movement
  -> keep, fix or roll back
```

## 2. Target customer

### Initial ICP

- B2B SaaS or AI-native product company;
- 5–30 employees and 2–15 engineers;
- ships several product changes per week;
- uses Codex, Claude Code, Cursor or another coding agent regularly;
- has no dedicated product analyst, or analytics capacity is a bottleneck;
- uses Poolstatis ingest or already has PostHog data;
- founder, product lead or engineering lead personally decides what to build next.

### Primary jobs to be done

1. After shipping onboarding, pricing, activation or retention work, tell me whether it
   improved the intended business outcome.
2. Warn me when a product change hurts an important metric or guardrail.
3. Explain where the movement came from without making me build a dashboard or write a
   query.
4. Preserve the evidence and decision so the next person or agent does not repeat the
   same investigation.

### Primary user roles

- **Decision owner:** founder, PM, growth lead or engineering lead.
- **Operator:** coding agent working through MCP/API/CI.
- **Auditor:** human reviewing metric definitions, evidence and proposed action.

## 3. Product principles

1. **Business outcome first.** Present activation, conversion, retention, revenue,
   reliability and the next decision before exposing tool calls or implementation detail.
2. **No answer without proof.** A result must reference active metric definitions, a
   reproducible query, an observed data window and data-quality state.
3. **Agent-operated, human-auditable.** The agent may prepare analysis and actions, but
   destructive or customer-facing actions require explicit approval.
4. **Use existing data where possible.** A team should not have to migrate its event store
   before testing Poolstatis value.
5. **Admin is an audit console.** It manages setup, semantics, evidence and decisions; it
   does not become a general dashboard builder.
6. **Every object ships whole.** New behavior includes REST, MCP, admin read-back, docs and
   tests in the same delivery.

## 4. Success definition

### North-star metric

`weekly_projects_with_verified_decision`

A project counts when, during the week, it records at least one change whose outcome has:

- an active primary metric;
- a real observation window;
- a reproducible query;
- a completed decision of `keep`, `fix`, `rollback` or `inconclusive`;
- supporting evidence visible to a human.

### Activation funnel

```text
workspace created
  -> data source connected
  -> first real event/metric verified
  -> first change registered
  -> first outcome evaluated
  -> first decision recorded
```

### Initial product targets

These are validation targets, not claims for the public landing:

- median time from signup to first verified metric: under 15 minutes;
- median time from connected data to first decision: under 30 minutes when historical
  data already exists;
- at least 50% of connected design-partner projects reach a first recorded decision;
- at least 40% of activated projects record another decision within four weeks;
- 100% of decisions include reproducible evidence and data-quality state;
- zero automatic rollbacks or code changes without explicit approval.

## 5. P0 — first trustworthy product decision

P0 is complete when a new or existing product can connect data, define what a change is
expected to improve, verify measurement and receive one evidence-backed decision.

### P0.1 Proof-gated onboarding

#### User outcome

The user sees that Poolstatis is connected to real product data and can answer one useful
question. Progress is driven by server evidence, not by clicking “done”.

#### Requirements

- Support two entry paths:
  - native Poolstatis SDK/ingest;
  - existing PostHog project through the scoped adapter in P0.5.
- Onboarding state must include:
  - workspace/project created;
  - MCP or agent connection observed;
  - data source connected;
  - first real event observed;
  - proposed metrics reviewed and activated;
  - data-quality check passed or explicitly acknowledged;
  - first query result produced;
  - first insight/decision saved.
- Every failed gate explains the exact blocker and recommended next step.
- Tokens remain one-time view and are never included in analytics payloads or logs.
- No sample chart or fake success state may satisfy a gate.

#### Acceptance criteria

- Reloading the admin preserves onboarding state.
- A copied config without a real MCP call remains incomplete.
- An SDK install without a received event remains incomplete.
- An unregistered event is visible but does not count as a verified active metric.
- The final screen shows a result from real data, its metric purpose, query window and one
  next action.

### P0.2 Measurement contract

#### User outcome

Before or during a product change, the team records what it expects to improve and what
must not regress. The contract becomes the basis for later evaluation.

#### Required contract fields

- stable key and human-readable name;
- business hypothesis;
- decision owner;
- primary metric key;
- zero or more guardrail metric keys;
- optional target segment/filter;
- baseline window;
- observation window or minimum sample requirement;
- expected direction: `increase`, `decrease` or `stay_within_range`;
- optional minimum meaningful effect;
- linked flag/experiment when applicable;
- optional external references: issue, PR, commit and deploy.

The contract must be representable through REST and MCP and exportable as a small
repository-owned file such as `poolstatis.yml`. The database remains the runtime source of
truth; the repository file is a versioned declaration and must support deterministic
validate/diff/apply behavior.

#### Acceptance criteria

- The server rejects unknown, inactive or incompatible metric references.
- An agent can validate the repository declaration without mutating the project.
- An apply operation presents a diff and requires explicit confirmation for changes to an
  existing active contract.
- The admin shows the hypothesis, primary outcome, guardrails, owner and current state in
  plain product language.

### P0.3 Change and release provenance

#### User outcome

Poolstatis knows which product change is being evaluated and when exposure began, instead
of guessing from a date selected after the fact.

#### Requirements

- Add a project-scoped change/release record with:
  - contract key;
  - environment;
  - source/repository;
  - branch, commit SHA and optional PR URL;
  - deploy timestamp;
  - linked flag/experiment and variant when present;
  - status: `planned`, `deployed`, `observing`, `decided`, `cancelled`.
- The first integration may be CI/MCP/API-driven. A full GitHub App is not required for P0.
- Repeated CI calls for the same project/environment/commit are idempotent.
- Evaluation begins from explicit deployment or experiment exposure time, never from the
  PR creation time.

#### Acceptance criteria

- A coding agent can register a deployed change in one tool call.
- The resulting record is readable through MCP and the admin.
- A change cannot move to `observing` until its measurement contract and primary metric are
  valid.
- A redeploy or rollback is represented as a new immutable release fact, not an overwrite
  of history.

### P0.4 Data trust: identity and property semantics

#### User outcome

The product team can trust that retention, segment and experiment conclusions refer to the
same actors and understood properties.

#### Requirements

- Ship explicit, audited actor links for anonymous-to-identified identity resolution.
- Resolve identity at query time without destructively rewriting immutable events.
- Support reversible links and reject contradictory link cycles.
- Ship the approved metric-category and structured-tag design.
- Add a project property registry for properties used in measurement contracts and
  decision filters. Each property records its scope, type, purpose and trust status.
- Surface stability/coverage warnings for `distinct_id`, primary metrics and filter
  properties before evaluating a change.

#### Acceptance criteria

- Anonymous pre-signup activity can join the authenticated actor after an explicit link.
- Removing or correcting a link changes subsequent query results while preserving the
  audit history.
- A decision cannot be labelled `keep`, `fix` or `rollback` when the primary metric or
  target property is untrusted; it becomes `inconclusive` with a concrete reason.
- API, MCP and admin read-back show the same category, tags, property meaning and identity
  status.

### P0.5 Existing PostHog data path

#### User outcome

A PostHog user can try Poolstatis without replacing its SDK or duplicating the entire
analytics stack.

#### Scope

- One read-only PostHog adapter, not a general connector marketplace.
- Project token/configuration with least-privilege guidance.
- Schema discovery for events and properties.
- Mapping from a Poolstatis registry metric to its PostHog source definition.
- Support only the query shapes required for the first decision:
  - trend;
  - funnel;
  - basic retention when identity requirements are met;
  - sample/verification reads.
- Poolstatis stores semantic definitions, contracts, release facts and decisions; it does
  not claim ownership of externally stored raw events.

#### Acceptance criteria

- The adapter never writes to PostHog.
- Credentials are encrypted at rest in hosted mode and never returned after creation.
- The same measurement contract can reference native or PostHog-backed metrics.
- Unsupported PostHog definitions fail with an explicit capability message instead of
  producing an approximate result.
- One real design-partner project completes the full activation funnel through this path.

### P0.6 First decision

#### User outcome

The user receives a concise conclusion:

```text
Decision: Keep the shorter onboarding.
Activation increased from 38.4% to 47.1%.
The invite-step guardrail did not regress.
Evidence: 1,284 exposed actors, 14-day window, trusted identity coverage 96%.
Next: investigate the remaining drop before first project creation.
```

#### Requirements

- Evaluate baseline versus observed result from the measurement contract.
- Return one of `keep`, `fix`, `rollback` or `inconclusive`.
- Separate measured facts from agent interpretation.
- Include sample size, time window, metric purpose, guardrails, data-quality state and
  reproducible Query DSL/source query.
- Allow the human to approve, edit or reject the proposed decision and rationale.
- Persist the decision as an immutable revision; later changes append new revisions.

#### Acceptance criteria

- The system never converts insufficient evidence into a directional recommendation.
- A rejected agent recommendation remains in the audit log with the human correction.
- The saved decision is discoverable from the metric, contract, release and experiment.

## 6. P1 — continuous observe, explain and act loop

P1 is complete when Poolstatis can monitor deployed changes, detect meaningful movement,
explain likely drivers and prepare a safe next action without waiting for a manual query.

### P1.1 Release monitor and guardrails

#### Requirements

- Add a bounded background worker for observing active releases.
- Evaluate only contracts whose sample/time requirements are ready.
- Detect primary-outcome movement and guardrail regression.
- Track evaluation attempts, next evaluation time and retry state.
- Deduplicate repeated findings for the same release/evidence window.
- Provide fixed-threshold and relative-to-baseline rules.

#### Acceptance criteria

- A ready release produces one evaluation and one persisted evidence set.
- A non-ready release reports why it is waiting.
- Worker restarts do not duplicate decisions or notifications.
- A guardrail regression can override a positive primary metric and propose `fix` or
  `rollback` according to the contract.

### P1.2 Funnel correlation and root-cause candidates

#### Requirements

- Compare the changed funnel/primary metric against candidate registered metrics and
  trusted properties.
- Candidate selection is constrained by metric purpose, category, tags, time order and
  minimum sample size.
- Return ranked correlations/segments as hypotheses, never as proven causality.
- Explain why every candidate was considered and provide the exact supporting query.
- Avoid scanning raw unregistered event names as an unrestricted search space.

#### Acceptance criteria

- The result distinguishes measured movement, correlation and interpretation.
- Low-evidence candidates are omitted or explicitly labelled weak.
- Re-running the same evidence window produces a reproducible ranking within defined
  tolerances.
- The user can open the supporting segment/funnel evidence from the decision record.

### P1.3 Action preparation

#### Requirements

- A decision may prepare one or more actions:
  - create issue;
  - draft implementation prompt;
  - open a draft PR through an external coding agent;
  - prepare feature-flag rollback;
  - schedule another observation window;
  - mark the result inconclusive and request more data.
- Every action contains evidence, target, expected effect and rollback/undo information.
- External writes and rollback execution require explicit approval.
- Record action status and its relationship to the originating decision.

#### Acceptance criteria

- No external action occurs from a read-only analysis call.
- Approval identifies the human/token and exact action payload.
- Failed actions are retryable without duplicating a successful issue, PR or flag change.
- A follow-up change automatically links back to the decision that created it.

### P1.4 Notifications and decision inbox

#### Requirements

- Add a compact decision inbox to the admin: `needs attention`, `waiting for data`,
  `approved`, `rejected`, `resolved`.
- Support one generic outbound webhook destination first.
- Notification content leads with product impact, not internal tool status.
- The webhook worker uses an outbox with bounded retries and idempotency.

#### Acceptance criteria

- A recipient can understand the metric movement, business risk and requested decision
  without opening a dashboard.
- Webhook delivery state and retries are visible to an operator.
- Secrets and raw personal event payloads are never included in notifications.

### P1.5 Decision memory

#### Requirements

- Make past contracts, releases, evidence, decisions and follow-up actions searchable by
  metric, feature tag, owner and time.
- When a new contract resembles a past change, return relevant previous outcomes with
  their evidence quality.
- Preserve disagreements between agent proposals and human decisions.
- Do not train or infer cross-customer recommendations in P1.

#### Acceptance criteria

- A coding agent can answer “have we tried something like this before?” from stored,
  project-scoped evidence.
- Historical recommendations are not presented as current facts when metric definitions or
  product context changed.

## 7. Required user surfaces

### MCP/API

Exact names may change during implementation planning, but the capability set must include:

- onboarding/setup status and next blocker;
- validate/diff/apply measurement contract;
- register/list/get release;
- evaluate release outcome;
- list/get/approve/reject decisions;
- explain outcome/root-cause candidates;
- prepare/approve action;
- search decision history;
- PostHog source configure/verify/schema read.

### Human analysis and admin workspace

Add product-oriented audit surfaces, not a dashboard builder:

- **Setup:** proof gates and blockers;
- **Measurement:** contracts and metric trust;
- **Changes:** releases and observation state;
- **Decisions:** evidence, recommendation, approval and action status;
- existing Registry/Data/Experiments remain the semantic and raw-evidence audit surfaces.

The primary summary on a change is:

1. what outcome was expected;
2. what happened;
3. how trustworthy the evidence is;
4. what decision is requested;
5. what happens after approval.

## 8. Explicit non-goals for P0/P1

- General-purpose dashboard or chart builder.
- Full session replay.
- Webcam gaze tracking.
- Broad DOM autocapture.
- Raw SQL/HogQL exposed to agents or customers.
- Connector marketplace beyond the scoped PostHog path.
- Cross-customer benchmark network.
- Fully autonomous code merge, production rollout or rollback.
- Replacing PostHog/Amplitude feature-for-feature.
- Claims of causal inference from correlation alone.

The existing lightweight Browser Experience module may contribute supporting evidence, but
it is not required for P0 completion.

## 9. Delivery order

### Milestone A — trustworthy setup

- P0.1 proof-gated onboarding;
- P0.4 identity/property trust foundation;
- P0.5 scoped PostHog path;
- one real first query from native ingest and one from PostHog.

### Milestone B — first product decision

- P0.2 measurement contract;
- P0.3 release provenance;
- P0.6 first decision;
- admin/MCP evidence and approval loop.

### Milestone C — continuous product loop

- P1.1 monitoring and guardrails;
- P1.2 funnel correlation;
- P1.4 decision inbox/webhook;
- P1.3 approved actions;
- P1.5 decision memory.

Each milestone requires a separate implementation plan before code changes begin. The agent
must audit current implementation status because flags, experiments and Browser Experience
already exist while several older roadmap items are stale.

## 10. Verification and release gates

### Automated checks

Before any P0/P1 milestone is declared complete:

```bash
pnpm typecheck
pnpm test
pnpm --dir sdk test
pnpm --dir sdk build
pnpm --dir web build
```

Add targeted tests for:

- project/org authorization and environment isolation;
- idempotency and worker retries;
- identity-link correctness and reversibility;
- PostHog adapter capability/error handling;
- contract validation and safe diff/apply;
- insufficient-evidence decisions;
- approval boundaries for external actions;
- decision-history auditability.

### End-to-end proof

Milestone B is not complete until both paths produce a real decision:

1. A demo product using native Poolstatis ingest ships a measured change and records a
   decision.
2. A design-partner or controlled project using existing PostHog data completes the same
   loop without migrating its raw event store.

The handoff evidence must include the contract, release, source events, query, decision and
approval read back through MCP/API and visible in the browser admin.

### Independent review

Request a read-only code review after each milestone and resolve every Critical or Important
finding before claiming completion.

## 11. Landing-page direction — separate marketing workstream

The public landing lives in `/Users/maksimstil/Desktop/poolstatis-site`. This section is a
copy/content brief; implementation belongs in that repository.

### Marketing decision

Keep the agent angle, but move it from the product benefit to the mechanism:

- **Hero/customer:** founder, product manager, growth or engineering lead;
- **problem:** the team ships faster than it learns;
- **desired outcome:** know what improved, where users drop and what to change next;
- **mechanism:** a coding agent handles instrumentation and analysis;
- **trust:** Poolstatis verifies metric meaning, real data and evidence.

Do not lead with MCP, Query DSL, semantic registry or “headless”. Those are proof points for
the technical buyer lower on the page.

### Recommended hero

Framework: StoryBrand.

**Eyebrow**

Product decisions, backed by real behavior

**Headline**

Know which product changes actually work.

**Subheadline**

Poolstatis shows what lifted activation, where users drop off, and what to improve next.
Your coding agent handles measurement and analysis in the background.

**Primary CTA**

Join Cloud preview

**Secondary CTA**

See the product loop

**Factual trust line**

Source available · Self-hostable · Works with Codex, Claude and Cursor

### Hero visual

Replace the MCP tool-call log as the dominant hero artifact with one business decision card:

```text
Onboarding activation increased
38.4% -> 47.1%        +8.7 pp

What changed
More users reached first value after the shorter setup.

Decision
Keep the shorter setup. Fix the invite drop-off next.

Evidence
1,284 users · 14 days · identity coverage 96%
```

MCP/agent activity can appear as a small secondary line: “Measured automatically by your
coding agent.”

### Page narrative

#### 1. Problem: shipping is faster; learning is still slow

Suggested headline:

> Your team ships every day. Product answers still take weeks.

Support with three concrete pains:

- nobody knows whether the last release improved activation;
- dashboards show movement but do not produce a decision;
- tracking breaks silently as agents change the product.

#### 2. Outcome: a decision, not another dashboard

Suggested headline:

> See what moved, why it matters, and what to do next.

Show three outcomes:

- **Measure the change:** connect a release to activation, retention, revenue or quality.
- **Find the drop:** explain the funnel step or segment behind the movement.
- **Choose the next move:** keep, fix, roll back or wait for more evidence.

#### 3. How it works

Use business language:

1. **Connect your product.** Use existing PostHog data or Poolstatis tracking.
2. **Define what success means.** Choose the outcome and guardrails for a change.
3. **Get a verified decision.** Poolstatis monitors real behavior and recommends the next
   move with evidence.

Mention the coding agent in supporting copy, not in every step title.

#### 4. Who it is for

Add three role cards:

- **Product teams:** know whether onboarding, activation and feature changes worked.
- **Founders:** get a clear growth decision without hiring an analytics team first.
- **Engineering teams:** let coding agents instrument and verify what they ship.

#### 5. Trust and technical proof

Move the existing differentiators here:

- every metric states the decision it supports;
- every conclusion links to real data and a reproducible query;
- proposed tracking is reviewed before activation;
- self-hosted data can stay in the customer's Postgres;
- typed MCP/API prevents unrestricted query guessing.

#### 6. Final CTA

Suggested headline:

> Ship faster without learning slower.

Supporting copy:

> Join the Cloud preview and verify the next product change with real user behavior.

Button:

> Join Cloud preview

### Claims to remove or delay

- Remove `Cohorts` from the landing until static cohorts are shipped and verified.
- Do not imply that current example numbers are customer results. Label them explicitly as
  a product example until a real case study exists.
- Do not claim automatic root-cause analysis, release monitoring or rollback before P1 is
  live.
- Avoid positioning the admin itself as the analytics dashboard; decisions may be shown in
  product-oriented cards, while the admin remains the audit surface.

### Content and proof needed before a major launch

- one real before/after product-change case study;
- measured time from connection to first useful answer;
- one native-ingest example and one existing-PostHog example;
- a short video showing `change -> evidence -> decision`, not a generic dashboard tour;
- public explanation of what the agent may do automatically and what needs human approval.

### A/B tests after truthful proof exists

1. `Know which product changes actually work.` versus
   `Turn every product release into a clear next decision.`
2. `Join Cloud preview` versus `Verify my next product change` only when the latter CTA
   leads to a real usable flow.
3. Business decision card versus a release timeline as the hero visual.

## 12. Open product decisions

These decisions should be resolved before the implementation plan for the affected
milestone:

1. Is the repository measurement declaration named `poolstatis.yml`,
   `.poolstatis/measurement.yml`, or generated from another manifest?
2. Which PostHog query capabilities can be supported faithfully without importing raw
   events?
3. What minimum sample/evidence policy is the safe default for non-experiment changes?
4. Which external action is first in P1: generic webhook, GitHub issue or draft PR?
5. Is Cloud preview ready to accept a usable onboarding flow, or must the landing CTA remain
   an explicitly labelled waitlist?
