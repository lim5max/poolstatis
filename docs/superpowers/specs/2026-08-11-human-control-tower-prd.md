# Poolstatis Human Control Tower — Master PRD

- **Date:** 2026-08-11
- **Status:** approved design contract with implementation read-back
- **Product owner:** Poolstatis product owner
- **Scope:** Core customer admin plus a separately released private Cloud operator surface
- **Source audit:** `/Users/maksimstil/.codex/visualizations/2026/08/11/019ff13d-7eb1-7f01-b83e-ca9f8a80120d/poolstatis-system-audit/index.html`
**Supersedes for this program:** the navigation and human-control recommendations in `2026-07-30-analyze-navigation-visual-system-prd.md`; existing data, Query DSL, safety and release contracts remain in force

## 0. Approved design direction and read-back policy

The product owner approved the audit direction in full: the restrained visual language,
decision-first hierarchy, proposed screen anatomy and the P0-P2 solution set are the product
baseline. This document is therefore both the PRD and the acceptance ledger for the program.

Implementation status is never inferred from a screenshot, a merged branch name or an item
being listed in this PRD. Every requirement keeps one of four explicit states:

- `verified` — current source, focused tests and the relevant rendered/runtime surface prove it;
- `partial` — useful behavior exists but a named part of the requirement is still missing;
- `planned` — accepted design, not yet implemented;
- `excluded` — explicitly removed by the product owner with a recorded reason.

The authoritative implementation read-back is appended in section 25. Until a row is
`verified`, the corresponding target text in sections 7-19 remains a requirement rather than
a claim about the current product.

## 1. Product decision

Poolstatis will not become a general-purpose dashboard builder. Its human UI will become a
decision control tower built around one repeatable sequence:

```text
Attention -> Answer -> Evidence -> Action
```

The human chooses and approves. The coding agent investigates and prepares work. The
registry guarantees metric and funnel semantics. Server-owned evidence prevents either the
UI or an agent from inventing certainty.

The first useful screen must answer, within ten seconds:

1. what changed or needs attention;
2. why it matters;
3. how trustworthy and fresh the evidence is;
4. what one safe next action is available.

Charts remain evidence for an answer, not the answer itself. Administrative tables remain
available for audit and repair, but they are not the primary customer journey.

## 2. Verified baseline and evidence limits

### 2.1 Repositories and inspected revisions

| Surface | Inspected revision | Verified current state | Evidence limit |
| --- | --- | --- | --- |
| Core runtime integration baseline | fresh `origin/main` at `47059fd17ab07e6104948ef4512d97ee7812f43b` | The only approved base for implementation and integration | Current code/docs and remote source inspected; no production claim |
| Private Cloud | `main` / `origin/main` at `44683cb1b71a743cf3ef3739192fef92890103f1` | Operator overview, customer drilldown, observability and audited mutations exist in code | Authenticated internal operator UI was not opened in this task |
| Live operator entry | `https://app.poolstatis.xyz/operator/` | Restricted sign-in boundary was the only live surface established by the audit | No claim about authenticated live data or deployed parity |

The local Hugeicons commit `1c629d09bfb7d197cf18fe6f037191d8f6202c3c` is not approved because
its Pro/self-host licensing boundary is unresolved. It is excluded from the runtime baseline,
requirements, implementation ancestry and dependency assumptions of this PRD.

The audit used a local Core build with synthetic data and reports 24 inspected screens and
5,021 synthetic events. Those values describe the audit fixture, not production usage.
Historical Web cold/warm latency observations are directional evidence only, not a current
performance benchmark.

### 2.2 Current Core behavior that must be preserved

The current source already has:

- project-mode navigation for `Home`, `Web`, `Product`, `Funnels`, `People`, `Ship` and
  `Setup`, with `Definitions`, `Events`, `Registry`, `Experience`, `Experiments`,
  `Decisions`, `Keys`, `Usage` and `Profile` under secondary navigation;
- a Home surface with outcomes, funnel snapshot, activity, trust text and one computed next
  action;
- curated Product/Funnel templates backed by the typed Query DSL;
- honest Web dimension availability and canonical-session semantics;
- a server-derived eight-gate onboarding state with `next_blocker`;
- organization usage, usage activity and monthly-range APIs backed by the usage ledger;
- release, experiment, decision, action, registry, data-quality and ingest-warning surfaces;
- privacy-safe actor list defaults and explicit unavailable actor-property semantics;
- typed allowlisted product telemetry that strips prompts, credentials, URLs, DOM and custom
  text;
- shared `Panel`, `EmptyState`, `Loading`, `RecoverableError`, `WarningNote`, `TableScroll`
  and tooltip primitives;
- visible focus styles, a skip link, a mobile drawer and reduced-motion-aware chart/UI
  behavior.

This PRD extends those contracts. It does not relabel target behavior as already shipped.

### 2.3 Current Cloud behavior and known gaps

Private Cloud currently has code for:

- `/operator/v1/overview`, organization list/detail, operations and founder-only economics;
- service and backup health;
- customer status, trial capacity, accepted-event usage and data health;
- project event activity, analytics inventory, key audit, usage ledger and immutable operator
  mutations;
- founder/non-founder economics redaction.

The current operator client still computes part of the attention priority in
`services/operator-web/src/App.tsx`, while the server separately selects and orders attention
candidates in `services/control-api/src/operator.ts`. That duplicate rule ownership is a
baseline defect, not a target pattern.

The current organization-detail response also contains warning `event` and `detail` strings.
The target privacy contract below requires a bounded signature and remediation category
instead of exposing token-like event names or raw warning detail to the operator UI.

## 3. Repository and product boundaries

### 3.1 Core owns

- typed analytics semantics, Query DSL, `EventStore`, registry, funnels and trust;
- customer-facing REST and MCP contracts;
- organization usage ledger reads for self-host and hosted customer sessions;
- the customer admin SPA and common Answer/Attention/Evidence/Action components;
- self-host behavior, including truthful `not_configured` and hosted-only states;
- additive Core migrations required by saved/official answers or later monitors.

### 3.2 Private Cloud owns

- hosted trial, plan, billing semantics and operator-only customer controls;
- platform/service/backup health;
- owner/operator authorization and founder-only economics;
- operator attention prioritization, customer drilldown and immutable mutation journal;
- Cloud deployment, Core image pinning and production rollback.

Private Cloud source remains `/Users/maksimstil/Desktop/poolstatis-cloud`. Cloud changes are a
separate PR and release gate from Core changes.

### 3.3 Public site owns

Landing, public docs UI, `/login`, `/signup`, waitlist and public acquisition copy remain in
`/Users/maksimstil/Desktop/poolstatis-site`. They are out of scope for this PRD.

### 3.4 Non-negotiable boundaries

- Core admin remains an agent-native headless platform admin, not a blank-canvas dashboard.
- No client or agent receives arbitrary SQL access.
- Analytics query branches continue to reference registered metric keys.
- Event facts remain immutable except through the existing audited revision/backfill
  contracts.
- Customer REST/MCP never gains Cloud operator mutations.
- Operator data never includes event payloads, raw properties, actor IDs, secrets, full
  tokens or unbounded warning detail.
- `pk_` remains write-only; `sk_` remains project-scoped; `pt_` remains organization-wide.
- `/i/v1/*`, the published SDK and known production consumers remain one compatibility
  contract.

## 4. Goals, success measures and non-goals

### 4.1 Goals

1. Make Home, Product, Funnel and Usage understandable in ten seconds.
2. Put all actionable product/data/usage/change signals into an explainable attention layer.
3. Give every useful answer a consistent trust and evidence disclosure.
4. Give every state exactly one visually primary next action.
5. Turn empty sections into a guided route to the first real artifact.
6. Preserve self-host, hosted customer and private operator semantics without pretending they
   are the same product surface.
7. Make implementation splittable across owners without duplicating semantics.

### 4.2 Product success measures

- median time from Home render to the first primary-action click;
- share of Home sessions in which the primary attention item is opened;
- share of Funnel views that open `Investigate this step`;
- share of Usage views in which users can identify cap state and projected cycle volume;
- completion rate from each guided empty state to its first real artifact;
- reduction in repeated Setup connection actions after `first_event_observed`;
- percentage of rendered answers with complete evidence metadata;
- count of client/server priority disagreements, which must remain zero;
- task success in moderated ten-second comprehension tests;
- no increase in unauthorized, cross-tenant or privacy-policy failures.

These are hypotheses until measured. The PRD does not invent a current baseline value.

### 4.3 Non-goals

- customizable dashboard grids or arbitrary chart builders;
- autonomous metric activation, experiment launch, traffic pause, rollback or deployment;
- CRM-style people profiling;
- raw session replay, DOM capture or Hotjar/PostHog-style surveillance in Experience;
- causal claims not computed by existing experiment/release evidence;
- billing-ledger claims from estimated economics;
- cross-project comparison between metrics that are only name-similar;
- replacing MCP with an embedded generic AI chat;
- changing the public ingest or published SDK request contract in this program.

## 5. Users and jobs

### 5.1 Product lead or founder

- “Tell me what changed and what I should decide today.”
- “Show the largest loss in this funnel and why it matters.”
- “Will we hit a usage threshold this cycle, and which project contributes most?”
- “Give me enough evidence to approve, reject or ask the agent to investigate.”

### 5.2 Product engineer

- “Show the exact metric/funnel definition, scope, sample, warnings and comparison.”
- “Tell me which measurement gap makes this answer unavailable.”
- “Give my coding agent a bounded task and let me verify read-back after the fix.”
- “Do not hide partial or stale evidence behind a clean-looking zero.”

### 5.3 Coding agent

- discover the same server-owned attention, answer and evidence contracts through MCP;
- run only typed registry-backed queries;
- prepare a reproducible investigation or implementation task;
- report assumptions and evidence gaps;
- never mutate protected definitions, traffic or production without human approval.

### 5.4 Customer workspace owner/admin

- understand workspace usage, cap semantics and contributors;
- see project portfolio health without opening every project;
- rotate/revoke credentials with explicit impact;
- distinguish hosted account capability from self-host unavailability.

### 5.5 Private Cloud operator/founder

- see the highest platform/customer risk first;
- understand the exact rule, affected projects, freshness and safe owner action;
- review customer data flow, trial/plan and commercial state without raw customer data;
- execute bounded idempotent actions with an immutable before/after journal;
- keep economics estimates restricted to founders and distinct from payments/invoices.

## 6. System principles

1. **Answer before chart.** A human-readable takeaway, comparison and impact precede the
   visualization.
2. **One primary action.** The primary action follows from the top signal; secondary links do
   not compete visually.
3. **Attention is a server-owned layer.** Data quality, usage, trial, experiment integrity,
   release regression and platform risk share one explainable shape.
4. **Evidence is progressive.** Freshness and trust remain visible; provenance, sample and
   reproducible query expand on demand.
5. **A limit is time plus cause.** Show plan/cap, pace, projection, contributors, thresholds
   and exact consequence.
6. **Empty is a plan.** Explain future value, current prerequisites, one primary action and
   one bounded agent task.
7. **Unavailable is not zero.** `empty`, `unavailable`, `not_configured`, `stale` and `error`
   are distinct states.
8. **The agent proposes; the human controls.** Traffic and irreversible actions retain
   explicit confirmation and audit.

## 7. Target information architecture

### 7.1 Persistent customer work zones

The desktop and mobile shell expose five work zones:

1. **Home / Attention** — current priority, outcomes and recent context;
2. **Analyze** — Web, Product, Funnels, People and later Saved answers;
3. **Ship** — releases, experiments and decision review as one lifecycle;
4. **Usage** — plan/cap, pace, projection, contributors and thresholds;
5. **Setup** — connection, measurement readiness and the path to the first protected
   decision.

`Definitions`, `Events`, `Registry`, `Experience`, `Keys` and account/project management live
under one predictable **Data & settings** disclosure. `Profile` moves to the account menu.

Stable routes remain unchanged in P0. Navigation labels and grouping may change, but existing
deep links must continue to resolve.

### 7.2 Shell signals

- Home shows an attention count only when actionable items exist.
- Usage shows `N this cycle` when there is no cap and a percentage only when a real cap is
  configured.
- Amber begins at an actual 75% threshold; red is reserved for an actual blocking/unsafe
  state, not an account or credential type.
- Mobile exposes Home/Attention and Usage before the long Data & settings list.
- Project and environment remain visible global context on project-scoped routes.

### 7.3 Private operator IA

Top level:

- **Overview** — owner queue and platform/customer health;
- **Customers** — searchable portfolio;
- **Activity** — immutable operator journal;
- **Economics** — founder-only estimates and assumptions.

Customer detail consolidates seven current tabs into:

- **Overview** — current decision, risk, usage pace, data flow and commercial state;
- **Data** — projects, event activity, analytics inventory and bounded warning signatures;
- **Commercial** — trial, entitlements, credits, plan and founder-redacted estimates;
- **Activity** — mutations and internal notes.

Projects remain inside Data. Raw keys/ledger rows are progressive audit detail, not the first
screen.

### 7.4 Approved visual system and screen anatomy

The audit's visual direction is approved as a system, not as a collection of screenshots.
All customer and operator work surfaces use the same reading order:

```text
Page context -> primary signal -> one action -> visual evidence -> detail/provenance
```

The first viewport should normally contain:

1. a compact header with one `h1`, a one-sentence job description and only the scope chips
   needed to interpret the answer;
2. one primary Answer or Attention block with takeaway, comparison, trust/freshness and one
   visually dominant action;
3. a chart, funnel, lifecycle rail or compact table only when it materially proves that
   answer;
4. secondary breakdowns, definitions, audit records and raw identifiers behind progressive
   disclosure.

Layout rules:

- Keep the existing light neutral shell, STIX Two Text headings, Geist body, Geist Mono
  identifiers and the Poolstatis green as the single product accent.
- Use green for trusted/confirmed product state, amber from a real attention threshold and
  red only for blocking, rejected, revoked or unsafe state. Type, account kind and
  `not_configured` are neutral.
- Prefer one composed panel or aligned table over several equal decorative cards. A border or
  surface exists only when it communicates grouping, selection or elevation.
- Use tabular numerals for measured values. Purpose, goal and takeaway are prose; keys,
  source names and fingerprints are monospace.
- Body copy stays concise and readable; full provenance never competes with the takeaway.
- Desktop content uses a constrained working canvas. At mobile widths, answer and primary
  action precede charts/tables, tables collapse to essential columns or become labelled rows,
  and no primary workflow requires horizontal page scrolling.

State anatomy:

- Loading uses shape-matched skeletons and preserves the shell.
- Empty explains future value, live prerequisites and the shortest route to one real
  artifact; it never renders fake zero KPIs.
- Partial preserves the valid answer and names only the missing evidence.
- Unavailable and error retain the exact affected scope, reason, request/evidence ID and
  repair/retry path.
- Every disclosure and modal restores focus, every interactive target has a visible focus
  ring, and reduced motion removes nonessential chart, rail and shimmer animation.

Surface-specific block order:

| Surface | Approved first-level blocks |
| --- | --- |
| Home | 1-3 Attention items -> key outcomes -> funnel snapshot -> recent activity -> evidence/system context |
| Web | readiness or Web-health answer -> KPI/trend -> one selected breakdown -> secondary dimension tabs -> evidence |
| Product | template/question -> current answer -> chart -> follow-up/save action -> Evidence disclosure |
| Funnels | biggest loss answer -> funnel visualization -> named investigate action -> immutable investigation artifact -> explicit Ship handoff -> Evidence |
| People | data-health limitation or interesting-entity queue -> bounded reasons/windows -> exact lookup -> privacy/provenance |
| Ship | current lifecycle/blocker -> one next action -> release/experiment/decision rail -> technical audit |
| Setup | next server gate -> proof/freshness -> one action -> completed gates -> advanced connection/settings |
| Usage | plan/cap and accepted total -> pace/projection -> contributors -> thresholds/action -> history/evidence |
| Data/Registry | health summary -> improvements or review queue -> affected answers/consumers -> definitions/raw audit |
| Operator | owner queue -> customer/platform facts -> selected customer decision -> Data/Commercial/Activity audit |

Mobbin and competitor references in section 22 constrain interaction hierarchy only. They do
not authorize copying their branding, decorative card density or dashboard-builder model.

## 8. Common Answer/Attention/Evidence/Action contract

### 8.1 Canonical response shape

Core REST, MCP structured content and private operator reads use the same semantic shape even
when their authorization and fields differ:

```ts
type ControlTowerState =
  | 'ready'
  | 'partial'
  | 'empty'
  | 'unavailable'
  | 'not_configured'
  | 'stale'
  | 'error';

type TrustState = 'trusted' | 'partial' | 'blocked' | 'unavailable';
type AttentionSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface ControlTowerScope {
  organization_id?: string;       // operator/org APIs only; never telemetry
  project_slug?: string;
  environment?: string;
  window: {
    from: string;
    to: string;
    timezone: 'UTC';
  };
  comparison?: {
    from: string;
    to: string;
    basis: 'previous_period' | 'previous_cycle' | 'none';
  };
}

interface AnswerBlock {
  state: ControlTowerState;
  headline: string;
  takeaway: string;
  primary_value?: {
    value: number | string | null;
    unit: 'count' | 'percent' | 'percentage_point' | 'duration_ms' | 'date' | 'text';
    formatted: string;
  };
  delta?: {
    value: number | null;
    unit: 'count' | 'percent' | 'percentage_point';
    direction: 'up' | 'down' | 'flat' | 'unknown';
    comparison_label: string;
  };
  why_it_matters: string;
}

interface EvidenceBlock {
  state: TrustState;
  as_of: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  source_refs: Array<
    | { kind: 'metric'; key: string; purpose: string }
    | { kind: 'funnel'; key: string; goal: string }
    | { kind: 'release'; id: string }
    | { kind: 'experiment'; key: string }
    | { kind: 'usage_ledger'; meter: 'events_stored' }
    | { kind: 'operator_rule'; rule_id: string; rule_version: number }
  >;
  aggregation?: string;
  denominator?: { label: string; value: number | null };
  sample?: { eligible: number | null; observed: number | null; coverage: number | null };
  warnings: Array<{ code: string; message: string; remediation_action_id?: string }>;
  unavailable_reasons: Array<{ code: string; message: string; prerequisite_action_id?: string }>;
  reproducible_query?: Record<string, unknown>; // validated Query DSL only, never SQL
}

type ControlTowerAction =
  | { id: string; kind: 'navigate'; label: string; href: string }
  | { id: string; kind: 'run_typed_query'; label: string; query: Record<string, unknown> }
  | { id: string; kind: 'copy_agent_task'; label: string; task: string }
  | { id: string; kind: 'open_confirmation'; label: string; mutation: string; impact: string }
  | { id: string; kind: 'retry'; label: string };

interface AttentionItem {
  id: string;
  rule_id: string;
  rule_version: number;
  severity: AttentionSeverity;
  state: 'open' | 'acknowledged' | 'resolved' | 'unavailable';
  title: string;
  reason: string;
  impact: string;
  affected: Array<{ kind: 'answer' | 'metric' | 'funnel' | 'project' | 'customer'; ref: string }>;
  evidence: EvidenceBlock;
  primary_action: ControlTowerAction;
}

interface ControlTowerResult {
  schema_version: 1;
  request_id: string;
  generated_at: string;
  scope: ControlTowerScope;
  answer: AnswerBlock;
  attention: AttentionItem[];
  evidence: EvidenceBlock;
  primary_action: ControlTowerAction;
  secondary_actions: ControlTowerAction[];
}
```

### 8.2 Contract rules

- Server/services own state, rule, severity, answer arithmetic and evidence semantics.
- Web renders the contract and may choose responsive layout only.
- A screen may show at most one primary action per state.
- `copy_agent_task` is deterministic, project/environment scoped and contains no token,
  session credential, raw prompt, source code, URL query string, payload or actor ID.
- A mutation action only opens an existing confirmation flow. It never executes from a card.
- An unavailable answer has a reason and prerequisite action; it has no fabricated value or
  delta.
- `request_id` plus UI generation guards prevent a slow previous scope from replacing a
  newer project/environment/window response.
- A client must ignore unknown additive fields and render unknown enum values as unavailable,
  not as success.

### 8.3 Attention ordering

Within one scope, sort by:

1. blocking consequence now;
2. forecasted breach/regression time;
3. severity;
4. estimated affected scope;
5. evidence freshness;
6. stable `rule_id` and item ID for deterministic ties.

Only the server can resolve collisions. The UI must not run a second priority algorithm.
Home renders the first three open items; the full queue can be expanded. Operator Overview
renders all items returned by its bounded server page.

## 9. Cross-cutting state contract

| State | Meaning | Required presentation | Forbidden presentation | Primary action |
| --- | --- | --- | --- | --- |
| `loading` | Current scope has no response yet | Skeleton matching final layout; `aria-busy=true`; retain global scope | Stale values without a stale label; full-page spinner after shell is ready | None |
| `ready` | Evidence supports the answer | Takeaway, comparison, trust, chart/table and evidence disclosure | Chart without takeaway | Derived action |
| `partial` | Useful answer exists with named coverage gap | Available answer plus explicit limitation | Treating missing part as zero | Repair or inspect limitation |
| `empty` | Query ran and measured zero real artifacts/observations | “No matching observations” plus scope and first-artifact path | Unqualified `0` KPI tiles | Create/open first artifact |
| `unavailable` | Required capability/evidence cannot be read or does not exist | Reason, affected answer and prerequisite | `—`, grey zero or “healthy” | Repair prerequisite or retry |
| `not_configured` | Optional cap/source/hosted capability is intentionally absent | Neutral state and semantic consequence | Full green rail | Configure if supported, otherwise learn more |
| `stale` | Last good evidence exists but is older than its freshness contract | Last value, exact `as_of`, stale badge and refresh/repair path | Presenting it as current | Refresh or investigate pipeline |
| `error` | Request or computation failed | Scoped error, request ID, preserved shell and retry | Replacing all adjacent successful cards | Retry |

Additional rules:

- `unknown`, `not assessed` and `unavailable` must not be three unprioritized badges in one
  table. Group the missing prerequisite as a data-health issue.
- Empty states include value description, live prerequisite checklist, one primary action,
  one copyable agent task and a documentation illustration/reference—not fake customer data.
- Errors in secondary breakdowns do not hide an already successful headline answer.
- A loading secondary tab must not block the first useful answer.

## 10. Surface requirements and priorities

### 10.1 Home / Attention — P0

**Current:** outcome-first structure, funnel snapshot, recent activity, evidence text and a
computed next action exist. Current answer and next action can compete; system metadata such
as legacy project mode is too prominent.

**Target:**

- `HC-HOME-01` Render one to three server-owned attention items above outcomes.
- `HC-HOME-02` Each item includes change/reason, impact, freshness and one primary action.
- `HC-HOME-03` Keep key outcomes, funnel snapshot and short activity context below the queue.
- `HC-HOME-04` Move legacy/system metadata into evidence or settings context.
- `HC-HOME-05` Do not add a customizable chart grid.
- `HC-HOME-06` When there is no attention, show confirmed guardrails that were evaluated,
  not a generic “all good”.

### 10.2 Web — P0/P1

**Current:** canonical page/session semantics and dimension-specific unavailable reasons are
strong; setup/repair and analysis can dominate one another.

**Target:**

- `HC-WEB-01` P0 shows ordered readiness: canonical page/session events -> trusted
  acquisition properties -> selected outcome.
- `HC-WEB-02` Once ready, lead with a Web health answer, delta and trust.
- `HC-WEB-03` Source, page/route and campaign breakdowns load lazily and fail independently.
- `HC-WEB-04` Partial availability keeps valid headline traffic visible.
- `HC-WEB-05` P1 adds affected-answer links from any missing definition/property.

### 10.3 Product / Answer card — P0 foundation, P1 saved answers

**Current:** curated questions, typed charts, metric purpose, trust and provenance make this
the strongest current surface.

**Target:**

- `HC-ANSWER-01` Standardize the Product card as the canonical answer renderer.
- `HC-ANSWER-02` Put plain-language takeaway, delta/comparison and one-line trust before the
  chart.
- `HC-ANSWER-03` Keep purpose visible; move aggregation, sample and full provenance into
  Evidence disclosure.
- `HC-ANSWER-04` Include one recommended follow-up agent task.
- `HC-ANSWER-05` P1 persists validated saved answers and permits authorized users to mark an
  answer official with append-only audit.

### 10.4 Funnels / Biggest loss — P0/P1

**Current:** funnel chart and saved-funnel goal exist; the human must calculate the key loss.

**Target:**

- `HC-FUNNEL-01` Server returns overall conversion, comparison, largest absolute loss,
  largest percentage loss and lost actors.
- `HC-FUNNEL-02` The answer names the affected step and funnel goal.
- `HC-FUNNEL-03` Primary action `Investigate <step A> -> <step B>` opens a bounded typed
  breakdown/agent task; it does not modify the funnel.
- `HC-FUNNEL-04` P1 persists an immutable project/environment-scoped investigation with
  saved-funnel snapshot, exact query/result/evidence lineage, creator and timestamp. A later
  Ship flow must cite that artifact and explicitly select the relevant change; time/metric
  overlap never creates a compatibility claim or Decisions proposal.
- `HC-FUNNEL-05` Ties use stable step order and explain both equal losses in Evidence.

### 10.5 People — P1

**Current:** privacy-safe actor table, exact search and canonical actor profile exist. Missing
identity/property capability produces noisy unknown/unavailable states.

**Target:**

- `HC-PEOPLE-01` Rank only server-computable interesting entities: recently activated,
  stalled, at risk or changed segment.
- `HC-PEOPLE-02` Every row shows a bounded rank reason and evidence window.
- `HC-PEOPLE-03` Missing identity/property capability becomes one data-health block.
- `HC-PEOPLE-04` Preserve redaction, exact-ID lookup and aggregate-first defaults; do not add
  inferred demographics or hidden profiling.

### 10.6 Ship — P0/P1

**Current:** a six-stage lifecycle and real release/experiment cards exist. The zero state has
limited guidance.

**Target:**

- `HC-SHIP-01` Empty state explains the release -> exposure -> readout -> proposal -> human
  decision lifecycle.
- `HC-SHIP-02` One primary action is selected from `Register release` or `Create experiment`
  using current project readiness.
- `HC-SHIP-03` Show a real prerequisite checklist and a documentation preview, not zero KPI
  tiles.
- `HC-SHIP-04` P1 active work shows blocker, owner and expected decision date.

### 10.7 Setup — P0/P1

**Current:** eight server-derived gates, first blocker, agent connection and advanced tooling
exist. Connection guidance can remain visually prominent after the first event.

**Target:**

- `HC-SETUP-01` The sole primary action follows the existing gate order and changes after
  `first_event_observed`: registry review -> key metric -> funnel/outcome -> first query ->
  saved decision.
- `HC-SETUP-02` Completed connection content collapses into evidence; it does not remain the
  main journey.
- `HC-SETUP-03` Keep all current MCP, key, standard, webhook, HTTP and danger-zone details
  reachable.
- `HC-SETUP-04` P1 shows read-back timestamp, latency/freshness and exact evidence per gate.
- `HC-SETUP-05` Copied config never counts as connection proof.

### 10.8 Definitions — P1

**Current:** Tracking plan, Properties, Identity and Data sources are clear groups but summary
rows do not express severity or downstream impact.

**Target:**

- `HC-DEF-01` Each group shows healthy/incomplete counts and highest severity.
- `HC-DEF-02` Each gap lists affected Home/Web/Product/Funnel answers.
- `HC-DEF-03` `Fix next` is server-ranked and opens the exact definition/source action.
- `HC-DEF-04` Existing trust, bounded source capability and append-only identity audit remain
  available.

### 10.9 Events / Data health — P1

**Current:** samples, warnings and data-quality audit are strong but emphasize current rows
over change and repair priority.

**Target:**

- `HC-EVENTS-01` Show accepted/rejected trend for 24h and 7d, new bounded issue signatures
  and affected answers.
- `HC-EVENTS-02` Separate `Improvements` from `Doing well`.
- `HC-EVENTS-03` Every fix path supports verify-after-fix read-back against a warning
  watermark/signature.
- `HC-EVENTS-04` Customer Core may expose project-scoped registered event names under current
  authorization; private operator may not.

### 10.10 Registry — P1/P2

**Current:** metric purpose, taxonomy, status and funnel/entity registry exist. Purpose can be
truncated and edit/review is hidden in overflow actions.

**Target:**

- `HC-REG-01` Show proposed, incomplete, deprecated/unused and healthy counts.
- `HC-REG-02` Show a useful purpose preview and explicit Review action.
- `HC-REG-03` Show `used by` answers/releases/experiments before edit/deprecate.
- `HC-REG-04` P2 adds version history and impact preview before semantic changes.

### 10.11 Experience — P0 empty state, P1 product value

**Current:** privacy positioning and bounded aggregate/click/session evidence exist, but
unconfigured surfaces can look empty rather than valuable.

**Target:**

- `HC-EXP-01` P0 empty state explains aggregate friction value, privacy boundary,
  prerequisites and one copyable agent task.
- `HC-EXP-02` Reference preview comes from docs and is labelled illustrative.
- `HC-EXP-03` P1 leads with an aggregate friction answer and readiness evidence.
- `HC-EXP-04` No raw DOM, keystrokes, free text, screen recording or hidden replay capture is
  introduced.

### 10.12 Experiments & flags — P0 empty state, P1 readiness, P2 monitoring

**Current:** intent-first safe rollout/A-B/config jobs, server readiness and decision flows
exist.

**Target:**

- `HC-EXPERIMENT-01` Empty state explains safe rollout, experiment and remote config outcomes
  and selects one action from current intent.
- `HC-EXPERIMENT-02` Readiness visibly includes primary metric, guardrail, exposure event,
  rollout unit/environment and existing stable-identity confirmation.
- `HC-EXPERIMENT-03` Link experiments into Ship and Decisions without duplicating lifecycle
  state.
- `HC-EXPERIMENT-04` P2 supports monitoring thresholds and an automatic-pause proposal; only
  a human-approved existing mutation may change traffic.

### 10.13 Decisions — P0 empty state, P1 review queue

**Current:** immutable evidence, agent proposal, human revision, reproducible query and
approval-gated actions exist. Empty state does not fully explain eligibility.

**Target:**

- `HC-DECISION-01` Empty state shows eligible release -> readout -> proposal -> human
  decision and links to the nearest eligible release.
- `HC-DECISION-02` Queue order is evidence readiness, risk and age—not arbitrary creation
  time alone.
- `HC-DECISION-03` Assumptions, evidence gaps, reversible action/undo and exact mutation
  impact remain visible before approval.
- `HC-DECISION-04` The UI never calls a proposal executed or deployed until the audited action
  reports success.

### 10.14 Keys — P1

**Current:** masked one-time secrets, kind, environment and revoke exist. Project-key list
does not currently return `last_used_at`, although the database/auth path maintains it.

**Target:**

- `HC-KEYS-01` Show masked token, environment, permissions/kind, age, last used and revoke
  state.
- `HC-KEYS-02` Compute a bounded rotation recommendation from policy, not from color.
- `HC-KEYS-03` Revoke confirmation states exact scope and immediate impact.
- `HC-KEYS-04` Red is reserved for revoked, leaked or unsafe; secret-key type is neutral.

### 10.15 Usage — P0

**Current:** activity, month history, current quota rail, thresholds and project/environment
breakdown exist. They repeat the same quantity, and an uncapped rail can appear fully green.

**Target:**

- `HC-USAGE-01` One vertical narrative: plan/cap -> pace -> forecast -> contributors ->
  thresholds -> action.
- `HC-USAGE-02` Hero identifies `events_stored`, cycle, accepted quantity, cap semantics and
  remaining when finite.
- `HC-USAGE-03` Show events/day, seven-day moving average, projected end-of-cycle volume and
  projected dates for 75/90/100% when finite.
- `HC-USAGE-04` When no cap exists, project volume only; never show “date exhausted” or a
  full green rail.
- `HC-USAGE-05` Contributors show project, environment, accepted quantity, share, seven-day
  change and last ingest.
- `HC-USAGE-06` Threshold semantics are 50% information, 75% attention, 90% action
  recommended and 100% exact consequence; each includes notification state and audit source.
- `HC-USAGE-07` Actions vary by boundary: self-host `Configure cap`/`Review contributors`;
  hosted customer `Review plan`/`Set alert`; operator `Adjust limit`/`Grant credit` through
  existing impact confirmation and immutable journal.

Forecast rules:

- use accepted ledger events by ingest time;
- use the configured cycle boundary in UTC;
- seven-day pace requires at least two distinct observed days and otherwise returns partial;
- projection is `current quantity + pace * remaining cycle days`;
- threshold date is unavailable when pace is zero, evidence is insufficient or cap is absent;
- label projections as estimates and expose sample days and `as_of`.

### 10.16 Projects — P1/P2

**Current:** organization/project list has name, slug, timezone, active metrics, funnels and
30-day events; create form is permanently visible.

**Target:**

- `HC-PROJECTS-01` Portfolio rows show last event, data health, current usage, key outcome
  availability and attention count.
- `HC-PROJECTS-02` Project creation becomes an explicit action/dialog.
- `HC-PROJECTS-03` Health is server-owned and explains its evaluated guardrails.
- `HC-PROJECTS-04` P2 cross-project comparison requires the same active semantic metric key,
  compatible purpose/type/aggregation and explicit environment/window; otherwise it is
  unavailable.

### 10.17 Profile — P2

**Current:** hosted profile and personal tokens exist; self-host truthfully shows unavailable.

**Target:**

- `HC-PROFILE-01` Keep Profile as a compact account-menu surface, not work navigation.
- `HC-PROFILE-02` Show deployment mode and hosted-only capability explanation.
- `HC-PROFILE-03` Link to the correct hosted auth/account surface; keep self-host token/admin
  guidance local.

### 10.18 Private Cloud operator — P0/P1

**Current:** owner overview, customer health, data health, usage, billing, economics,
projects and activity exist. Attention semantics are duplicated between server and client.

**Target:**

- `HC-OP-01` P0 server returns the canonical ordered attention items with rule/version,
  reason, impact, affected projects, freshness and action.
- `HC-OP-02` Remove client-owned priority calculation after compatibility coverage proves
  parity.
- `HC-OP-03` Preserve highest-risk-first, founder-only economics and immutable mutations.
- `HC-OP-04` Replace warning event/detail with bounded signature code, category, count,
  timestamps and remediation; no actor/payload/property/token-like value leaves the server.
- `HC-OP-05` P1 adds forecasted trial/cap breach date and last operator-action status.
- `HC-OP-06` P1 consolidates customer tabs into Overview/Data/Commercial/Activity.
- `HC-OP-07` “Normal” is allowed only when named guardrails were evaluated and are fresh.
- `HC-OP-08` Economics keeps observed facts, assumptions and calculated scenarios separate;
  all estimates retain `is_billing_ledger: false`.

## 11. Data, API and MCP requirements

### 11.1 Core P0 reads

Add read-only, additive endpoints:

```http
GET /api/v1/projects/:slug/control-tower?env=prod&range=30d
GET /api/v1/me/usage/control?period=YYYY-MM
```

`control-tower` composes existing onboarding, registry, query, releases, decisions,
data-quality and warnings services. It may not issue raw event SQL outside `EventStore`.

`usage/control` is organization-scoped and keeps the existing owner/admin or unscoped `pt_`
authorization boundary. It returns:

```ts
interface UsageControlResult extends ControlTowerResult {
  meter: 'events_stored';
  cycle: { from: string; to: string; timezone: 'UTC' };
  cap: {
    state: 'finite' | 'not_configured';
    value: number | null;
    remaining: number | null;
    consequence_at_100_percent: string | null;
  };
  pace: {
    observed_days: number;
    events_per_day_7d: number | null;
    projected_cycle_end: number | null;
    confidence: 'sufficient' | 'insufficient';
  };
  threshold_forecasts: Array<{
    percent: 50 | 75 | 90 | 100;
    state: 'reached' | 'projected' | 'not_projected' | 'not_applicable';
    reached_or_projected_at: string | null;
  }>;
  contributors: Array<{
    project_slug: string;
    project_name: string;
    environment: string;
    accepted_events: number;
    share: number | null;
    change_7d: number | null;
    last_ingest_at: string | null;
  }>;
}
```

Existing `/api/v1/me/usage`, `/range` and `/activity` stay supported. P0 UI switches to the
new control read only after contract tests pass.

### 11.2 Query answer additions

For `trend` and `funnel`, add optional `answer` and `evidence` fields to the existing query
result. Existing result series/steps remain byte-compatible in meaning.

Funnel summary arithmetic is server-owned:

```ts
interface FunnelAnswerSummary {
  overall_conversion: number | null;
  previous_overall_conversion: number | null;
  delta_percentage_points: number | null;
  biggest_absolute_loss: {
    from_step: number;
    to_step: number;
    lost_actors: number;
    drop_rate: number | null;
  } | null;
  biggest_percentage_loss: {
    from_step: number;
    to_step: number;
    lost_actors: number;
    drop_rate: number | null;
  } | null;
}
```

No new Query DSL branch is required for this deterministic summary. If implementation needs
new raw aggregation, it must add an `EventStore` method rather than direct SQL in the route.

### 11.3 Core P1 reads and persistence

Add:

```http
GET /api/v1/projects/:slug/readiness?env=prod
GET /api/v1/projects/portfolio?env=prod
```

`readiness` returns definition groups, severity, affected answer IDs and ranked repair action.
`portfolio` is organization-scoped and unavailable to a project-pinned `sk_` beyond its own
project.

Extend project key rows additively with `last_used_at`. The value already maintained by auth
must be selected for project keys; plaintext remains one-time only.

Saved/official answers reuse the `analysis_views` design from the earlier Analyze PRD rather
than creating a second persistence model. The provisional Core migration is
`036_analysis_views.sql`; the integration owner must renumber it if current main already uses
`036`.

Required persistence:

- project and environment scope;
- validated versioned `VisualizationSpec` plus `AnswerBlock` evidence snapshot;
- `active`/`archived` lifecycle;
- optional official status set only by authorized owner/admin;
- append-only create/archive/official audit;
- no SQL, prompt, credential, raw actor ID or raw event payload.

### 11.4 MCP parity

Add read-only MCP tools with the same structured content:

- `get_control_tower(project, env, range)`;
- `get_usage_control(period)` for organization-wide credentials;
- `get_measurement_readiness(project, env)` in P1.

Existing `query` returns additive answer/evidence metadata. Tool text may summarize, but
structured content is authoritative. Tool authorization and tenant isolation mirror REST.
Cloud operator controls do not become customer MCP tools.

### 11.5 Private Cloud API

Extend `/operator/v1/overview` additively with:

```ts
interface OperatorAttentionResponse {
  attention: AttentionItem[];
  ruleset: { version: number; generated_at: string };
}
```

The server owns selection and ordering. During one compatibility release the existing
`organizations` and `facts.attention_items` fields remain. Operator web uses `attention` when
present and may retain old rendering only as an explicitly tested compatibility fallback.
The fallback is deleted after the deployed server/client pair and rollback artifact both
support the new field.

Organization detail replaces operator warning fields:

```ts
interface OperatorWarningSignature {
  signature_id: string; // opaque stable digest, not the raw event/detail
  category: 'rejected' | 'unregistered' | 'clock_skew';
  remediation: 'fix_schema' | 'register_definition' | 'fix_clock' | 'inspect_core';
  project_id: string;
  project_slug: string;
  environment: string;
  count: number;
  first_seen: string;
  last_seen: string;
}
```

Current mutation endpoints, rate limits, idempotency and audit remain unchanged. Forecast and
action status are additive reads over current Cloud data.

### 11.6 Caching and freshness

- Home/answer data cache key includes project, environment, window, comparison and registry
  revision.
- Usage cache key includes organization, cycle and entitlement version.
- Operator attention cache key includes ruleset version and current health generation.
- Mutations invalidate affected reads only after commit.
- P0 first answer target: server p95 <= 1.5 s on the supported synthetic fixture and warm
  browser answer <= 2 s; these are launch targets, not current claims.
- Secondary breakdowns and evidence detail load after the headline and have independent error
  boundaries.
- Every response includes `generated_at`; freshness policy is visible and domain-specific.

## 12. Responsive, accessibility and performance requirements

### 12.1 Responsive

- Verify at `1440x900`, `1024x768`, `390x844` and `360x800`.
- No page-level horizontal overflow.
- Wide evidence/admin tables use `TableScroll`; the primary action never requires horizontal
  scrolling.
- Mobile Home/Usage show answer and primary action before charts/tables.
- Mobile navigation has 44px touch targets, full-height scrolling and direct Home/Usage
  access.
- Menus, dialogs, tooltips and table actions are not clipped by `Card` overflow.

### 12.2 Accessibility

- One `h1` per screen and ordered headings in cards/disclosures.
- Answer takeaway is text, not color or chart-only information.
- Status uses label/icon plus color; green never means merely “configured type”.
- Charts have a textual/table fallback and keyboard-accessible equivalent.
- `aria-live=polite` announces scoped loading/completion; errors use `role=alert`.
- Focus returns to the invoking control after dialogs/drawers; route navigation moves focus to
  main heading.
- Tooltips are not the only way to read meaning.
- All controls meet WCAG 2.2 AA contrast and visible-focus requirements.
- Reduced motion disables nonessential chart/rail transitions and loading shimmer.

### 12.3 Performance

- Render the shell and current scope immediately.
- Do not block answer text on provenance, screenshots or secondary tabs.
- Abort or generation-guard stale requests on scope changes.
- Lazy-load Web breakdowns, Experience details and operator deep tables.
- Record first-answer latency separately from full-screen settled latency.
- No polling faster than the current domain freshness requirement; background refresh pauses
  when the tab is hidden.

## 13. Product analytics and telemetry

### 13.1 Existing privacy boundary

Extend `web/src/productTelemetry.ts`; do not introduce an untyped analytics client. New event
properties use finite enums/count buckets only. Never send:

- raw prompts or copied agent tasks;
- source code, DOM, free text or URLs/paths;
- project/org UUIDs, actor IDs or customer names;
- metric purpose, funnel goal, warning detail or operator notes;
- tokens, token fragments or session credentials;
- exact monetary/economics values.

### 13.2 Event taxonomy

| Event | Required allowlisted properties |
| --- | --- |
| `control_tower.answer_viewed` | `surface`, `state`, `trust`, `latency_bucket` |
| `control_tower.attention_opened` | `surface`, `rule_code`, `severity`, `age_bucket` |
| `control_tower.primary_action_clicked` | `surface`, `action_code`, `state` |
| `control_tower.evidence_opened` | `surface`, `trust`, `warning_count_bucket` |
| `control_tower.empty_task_copied` | `surface`, `task_code`, `method` |
| `usage.forecast_viewed` | `cap_state`, `forecast_state`, `threshold_state` |
| `usage.contributor_opened` | `rank_bucket`, `share_bucket` |
| `funnel.biggest_loss_opened` | `loss_kind`, `step_count_bucket`, `trust` |
| `setup.next_gate_opened` | `gate_key`, `state` |
| `saved_answer.created` | `template_code`, `official=false` |
| `saved_answer.official_changed` | `template_code`, `next_state` |

Operator telemetry stays in private Cloud and uses only rule codes, status enums, latency
buckets and action outcomes. It must not emit customer identifiers or economics.

### 13.3 Measurement rules

- A physical action emits one event even if it triggers navigation and task copy.
- View events dedupe by session plus surface/scope-state hash.
- Latency uses the existing finite latency buckets.
- Successful click telemetry is not proof that the downstream action completed.
- Product success reports separate viewed, clicked, server-accepted and verified read-back.

## 14. Privacy, security and authorization

- Core responses remain tenant/project/environment scoped by existing auth.
- Organization usage and portfolio require owner/admin user or organization-wide `pt_`;
  project `sk_` cannot widen scope.
- Operator endpoints require the current operator client/scope/subject allowlist; economics
  additionally requires founder allowlist.
- Attention/action payloads contain stable bounded codes, not raw customer facts.
- Agent tasks are generated from allowlisted templates and exact project/environment labels;
  secret/session material is prohibited and covered by serialization tests.
- Operator warning signatures are salted or keyed so an external observer cannot reverse a
  token-like event name by rainbow table.
- Mutation previews show current -> next, consequence, scope and idempotency key behavior.
- Actions with traffic, status, cap, credit, revoke or billing impact retain explicit
  confirmation and immutable audit.
- No raw operator response is cached in shared browser storage.
- Export/screenshot evidence must redact customer names/IDs unless it is stored in the
  authorized private release record.

## 15. Migration and compatibility

### 15.1 P0 migration posture

P0 Core can be implemented from current rows and services without a database migration.
P0 Cloud attention should also derive from current read models. If query-plan evidence proves
an index is required, it must be additive and separately reviewed.

### 15.2 P1/P2 additive data

- `analysis_views` and its audit are additive and nullable/backwards-compatible where
  applicable.
- Definition version history and monitors require separate additive migrations in P2.
- Never rename the physical `poolsatis` database or credentials.
- No event rewrite, destructive column/table operation or cross-tenant backfill is allowed.
- Migration numbering is allocated against freshly fetched main in each repository.

### 15.3 API compatibility

- Existing endpoints and response fields keep current meaning.
- New fields/endpoints/tools are additive.
- Old operator client fallback is bounded to one compatibility release.
- Unknown enum handling fails closed to unavailable.
- Saved answer schema is versioned and validated on both write and read.
- REST/MCP structured content parity is tested.

### 15.4 Public ingest/SDK compatibility

This program does not change `/i/v1/*` request validation or SDK emission. Every Core release
still runs:

- previous published-SDK contract fixture;
- current SDK tests/build/pack checks;
- consumer inventory review;
- synthetic live ingest HTTP 200/read-back and unchanged rejection-warning watermark before
  production completion.

If any implementation accidentally requires an ingest/schema change, it leaves this program
and follows the compatible Core -> verified SDK publication -> consumer migration -> measured
deprecation sequence.

## 16. Delivery roadmap

Time ranges are planning hypotheses and begin only after technical decomposition.

### 16.1 P0 — understand and act, estimated 2–3 weeks

1. Common contract and shared state primitives.
2. Core `control-tower` and `usage/control` reads plus MCP parity.
3. Home attention queue.
4. Funnel biggest-loss summary and action.
5. Usage consolidation and truthful uncapped state.
6. Setup next-gate hierarchy.
7. Guided empty states for Ship, Experience, Experiments and Decisions.
8. Web readiness order and lazy secondary breakdowns.
9. Cloud server-owned attention contract and privacy-safe warning signatures.

Recommended first vertical slice: Home Attention + Usage + Funnel biggest loss on one shared
contract, not three unrelated redesigns.

### 16.2 P1 — explain and verify, estimated 3–6 weeks

1. Canonical answer card everywhere.
2. Saved/official answers with audit.
3. Measurement readiness and affected-answer graph.
4. Events improvements/doing-well and verify-after-fix.
5. Registry health/used-by impact.
6. People interesting-entity ranking.
7. Project portfolio health.
8. Credential health and project-key `last_used_at`.
9. Ship blocker/owner/expected decision date.
10. Experiment readiness integration and Decisions ordering.
11. Cloud forecast, last-action status and consolidated detail IA.

### 16.3 P2 — scale the loop, estimated 6–10 weeks

1. Scheduled agent insight feed.
2. Semantic cross-project comparison.
3. Versioned definition impact preview.
4. Configurable monitors and notification routing.
5. Human-approved automatic pause/rollback proposals.
6. Role-aware navigation and portfolio views.
7. Compact deployment-aware Profile/account surface.

No P2 automation may bypass current human approval or immutable action audit.

## 17. Parallel implementation owners and file map

Each owner has exclusive write ownership during its workstream. Workers are not alone in the
codebase; they preserve other changes and rebase/merge through the integration owner.

| Owner | Responsibility | Core files/modules | Private Cloud files/modules | Does not own |
| --- | --- | --- | --- | --- |
| `CT-00 Integration` | Contract freeze, migration allocation, shared-file sequencing, final gates | `src/schemas.ts`, `src/http/server.ts`, `src/mcp/server.ts`, `web/src/api/types.ts`, `web/src/api/client.ts` after owner patches | `services/control-api/src/server.ts` final integration | Feature UI implementation |
| `CT-01 Contract kernel` | Common types, deterministic state/action validators, shared UI primitives | Create `src/services/controlTower.ts`, `web/src/analysis/controlTower.ts`, `web/src/components/control-tower.tsx`; modify `web/src/components/ui.tsx` | None | Screen-specific copy/layout |
| `CT-02 Shell and states` | IA, shell badges, mobile order, focus and common state rendering | `web/src/analysis/navigation.ts`, `web/src/App.tsx`, `web/src/index.css`, shell/accessibility tests | None | Backend arithmetic |
| `CT-03 Home` | Core attention composition and Home rendering | Create `src/services/homeAttention.ts`; `web/src/screens/Overview.tsx`, `web/src/screens/Overview.test.tsx`, new backend tests | None | Usage/funnel arithmetic |
| `CT-04 Answers and Funnel` | Answer metadata, biggest loss, Product/Funnel cards | `src/services/query.ts`, `src/stores/eventStore.ts` only if required, `src/stores/postgresEventStore.ts` only if required, `web/src/screens/ProductAnalytics.tsx`, `web/src/analysis/*`, query/UI tests | None | Saved persistence |
| `CT-05 Usage` | Pace/forecast/contributors and Usage UI | `src/services/usage.ts`, `src/services/usageWarnings.ts`, `web/src/screens/Usage.tsx`, usage tests | None | Cloud trial mutations |
| `CT-06 Guided first value` | Setup gate hierarchy and Ship/Experience/Experiment/Decision empty states | `web/src/screens/Setup.tsx`, `Changes.tsx`, `Experience.tsx`, `Experiments.tsx`, `Decisions.tsx`, focused UI tests | None | Lifecycle backend semantics |
| `CT-07 Readiness/data health` | Definitions, Events, Registry impact/readiness | Create `src/services/measurementReadiness.ts`; `src/services/dataQuality.ts`, `src/services/metricUsage.ts`, `web/src/screens/Measurement.tsx`, `Data.tsx`, `Registry.tsx` | None | Query renderer |
| `CT-08 People/projects/keys` | Interesting entities, portfolio, credential health | `src/services/projects.ts`, actor/person services only where required, `web/src/screens/Users.tsx`, `Projects.tsx`, `Keys.tsx`, related tests | None | Identity model redesign |
| `CT-09 Saved answers` | P1 persistence, REST/MCP/admin and audit | Provisional `migrations/036_analysis_views.sql`, create saved-answer service/tests/screen; use existing VisualizationSpec | None | General dashboard builder |
| `CT-10 Telemetry/privacy` | Typed telemetry allowlist and serialization/privacy regression tests | `web/src/productTelemetry.ts`, `web/src/productTelemetry.test.ts`, cross-surface privacy tests | Private operator telemetry test files | Product arithmetic |
| `CT-11 Cloud operator` | Server rules, warning signatures, forecast and operator IA | None | `services/control-api/src/operator.ts`, `services/control-api/src/server.ts`, migration/view only if proven, `services/operator-web/src/App.tsx`, operator tests | Core/customer admin |
| `CT-12 Release review` | Independent contract/security/accessibility/release verification | Test/evidence only | Test/evidence only | Feature implementation approval |

`CT-00` is the only owner that applies final edits to the shared API/schema entrypoints after
domain patches are ready.

## 18. Semantic conflict map

| Shared surface | Conflicting owners | Conflict | Resolution order and invariant |
| --- | --- | --- | --- |
| `src/http/server.ts` | CT-03/04/05/07/08/09 | Multiple new routes/imports | Domain owners provide isolated service + route patch; CT-00 applies routes in P0 then P1 order and preserves auth scopes |
| `src/schemas.ts` | CT-01/04/05/07/09 | Shared discriminated unions and validators | CT-01 freezes common schema names first; domain schemas remain additive; CT-00 rejects duplicate state enums |
| `src/mcp/server.ts` | CT-03/05/07/09 | Tool registration and structured output | CT-00 integrates after REST contract tests; every tool reuses service and REST authorization semantics |
| `web/src/api/types.ts` / `client.ts` | All web domains | Type/client merge hotspot | CT-01 adds common types, then domain owners submit minimal method patches; CT-00 composes and runs type parity tests |
| `web/src/components/ui.tsx` | CT-01/02/06 | Generic vs control-tower states | CT-01 owns new primitives; CT-06 consumes without local reimplementation; CT-02 owns shell only |
| `web/src/App.tsx` / navigation | CT-02/03/05/08 | Badges/routes/menu ownership | CT-02 owns shell and accepts typed counts from store/client; domain owners do not edit navigation |
| `web/src/screens/ProductAnalytics.tsx` | CT-04/09 | Answer card vs Save official action | CT-04 lands stable AnswerCard first; CT-09 adds persistence action through its public props/API |
| `web/src/screens/Setup.tsx` | CT-06/07 | Gate hierarchy vs readiness details | CT-06 owns primary state machine; CT-07 provides typed readiness component consumed below it |
| `web/src/screens/Experiments.tsx` / `Decisions.tsx` | CT-06/09 | Empty state, saved answers, decision queue | CT-06 lands P0 states; CT-09 does not change experiment/decision lifecycle; P1 integration uses existing APIs |
| `src/services/projects.ts` | CT-05/08 | Usage contributors vs portfolio/key fields | CT-05 reads usage service only; CT-08 owns project/key list shape; no duplicate portfolio SQL |
| Core migration number | CT-09/other concurrent work | `036` collision | CT-00 fetches main and assigns the next free number immediately before integration |
| Cloud `operator.ts` and web `App.tsx` | CT-11 only | Duplicate attention rules | Server contract lands first; client uses returned rules; compatibility fallback is isolated and later deleted |
| Status color semantics | CT-01/02/all screens | Green/amber/red drift | Shared token/state mapping is authoritative; screen-local status color maps are prohibited |

Semantic conflict resolution never chooses an entire file side. Reviewers reconcile both
contracts field by field and preserve unrelated work.

## 19. Acceptance criteria

### 19.1 Common control tower

- Every target surface renders the canonical state, answer, evidence and action semantics.
- Server and MCP return identical structured meaning for the same scope.
- The UI never calculates a second attention priority.
- One primary action is visually dominant in every state.
- Unknown/unavailable/not-configured/stale/error are distinguishable in text and code.
- Evidence exposes purpose/goal, window, environment, sample/freshness and warnings.

### 19.2 Ten-second comprehension

In moderated tests on Home, Product, Funnel and Usage, a user can state the main signal,
direction/trust and next action within ten seconds. Passing requires at least 8 of 10 users on
each surface; this threshold is a launch criterion, not a current result.

### 19.3 Usage

- A finite cap shows used, remaining, pace, projected cycle end and threshold consequences.
- No-cap state is neutral and never renders a full progress rail or exhaustion date.
- Contributor totals reconcile to organization usage or expose bounded unattributed quantity.
- Forecast exposes inputs, `as_of` and insufficient-evidence state.

### 19.4 Empty/loading/error/unavailable

- Ship, Experience, Experiments and Decisions provide a first-artifact route without fake
  data.
- Secondary failures leave the successful headline answer visible.
- Stale requests cannot replace a newer scope.
- Screen readers receive loading and error announcements without duplicate focus jumps.

### 19.5 Privacy and authorization

- Core tenant/environment isolation tests pass for all new reads/tools.
- Project `sk_` cannot read organization usage or another-project portfolio.
- Operator warning output contains no raw event/detail, actor, payload, property or token-like
  value.
- Founder economics remain unavailable to non-founders.
- Telemetry serialization contains only the exact allowlist.

### 19.6 Responsive/accessibility/performance

- Required desktop/mobile widths have no page overflow, clipped actions or inaccessible Data
  & settings navigation.
- Keyboard, focus return, skip link, chart fallback and reduced-motion checks pass.
- First-answer latency is measured separately and meets the P0 target on the release fixture.

### 19.7 Compatibility and release

- Current REST/MCP consumers pass unchanged.
- Previous published SDK fixture and SDK tests pass.
- No `/i/v1/*` rejection behavior changes.
- Core and Cloud deploy from separately reviewed immutable artifacts.
- Migration/backup/restore and rollback gates are complete before production mutation.

## 20. Requirement-to-test matrix

| Requirement(s) | Test level | Required test/evidence |
| --- | --- | --- |
| HC-HOME-01..06 | Backend + web + browser | `test/control-tower.test.ts`; `web/src/screens/Overview.control-tower.test.tsx`; desktop/mobile screenshot and ten-second script |
| HC-WEB-01..05 | Web + API integration | Extend `web/src/screens/WebAnalytics.test.tsx`; prove lazy requests, partial headline and independent tab errors |
| HC-ANSWER-01..04 | Unit + UI | `web/src/components/control-tower.test.tsx`; extend Product analytics UI tests for takeaway-before-chart and Evidence disclosure |
| HC-ANSWER-05 | DB + REST + MCP + auth | `test/analysis-views.test.ts`, tenant isolation, audit immutability, official-role authorization and schema-version rejection |
| HC-FUNNEL-01..05 | Service + query + UI | Extend `test/query.test.ts`; biggest-loss tie/zero-denominator/comparison cases; ProductAnalytics Funnel UI action test |
| HC-PEOPLE-01..04 | EventStore/service + UI + privacy | Actor ranking fixtures, project/env isolation, redaction snapshot and Users UI reason test |
| HC-SHIP-01..04 | UI + lifecycle integration | Extend `web/src/components/ship-lifecycle.test.tsx`; zero fixture, eligible release and active blocker fixture |
| HC-SETUP-01..05 | Service-contract + UI | Existing onboarding tests plus Setup gate-transition test proving connection collapses after first event and copied config is not proof |
| HC-DEF-01..04 | Service + UI | `test/measurement-readiness.test.ts`; Measurement group severity/affected-answer/repair-action UI tests |
| HC-EVENTS-01..04 | Service + UI + privacy | Warning signature trend fixtures, verify-after-fix watermark test, Core/operator field-boundary serialization tests |
| HC-REG-01..04 | Service + UI + migration | Metric usage impact tests, Registry health summary UI, P2 definition-version audit/impact preview tests |
| HC-EXP-01..04 | UI + privacy | Experience empty/readiness/aggregate fixtures; prohibited-field serialization and no-DOM-capture regression |
| HC-EXPERIMENT-01..04 | Backend + UI | Existing readiness/launch/decision suites plus empty-state routing and human-approval-only pause proposal test |
| HC-DECISION-01..04 | Backend + UI | Existing decision/action audit tests plus eligible-release empty state, ordering and no-false-executed copy test |
| HC-KEYS-01..04 | DB + API + UI + security | Extend project key tests for `last_used_at`, one-time reveal, rotation state, exact revoke scope and neutral type color |
| HC-USAGE-01..07 | DB/service + REST + UI | `test/usage-control.test.ts`; no-cap, zero-pace, insufficient-days, threshold-date, attribution reconciliation and authorization cases; Usage responsive test |
| HC-PROJECTS-01..04 | Service + auth + UI | Portfolio tenant/scope tests, health explanation, create dialog and semantic-comparison rejection cases |
| HC-PROFILE-01..03 | UI + mode boundary | Self-host vs hosted snapshot tests; profile absent from work navigation and present in account menu |
| HC-OP-01..08 | Cloud service + API + UI + auth | Extend operator 54-test suite: server ordering, ruleset version, compatibility fallback, warning redaction, founder deny, forecast and tab consolidation |
| State contract section 9 | Shared UI + accessibility | State matrix parameterized tests; axe/keyboard checks; slow request generation-guard test |
| Telemetry section 13 | Serialization/unit | Extend `web/src/productTelemetry.test.ts`; exact event/property snapshot, physical-action dedupe and prohibited-string corpus |
| Authorization section 14 | Integration/security | New REST/MCP tenant matrix for user owner/admin/member, `pt_`, `sk_`, wrong project/env and Cloud operator/founder |
| Compatibility section 15 | Contract/build | Previous SDK fixture, MCP pack contract, REST response compatibility snapshots and operator old/new pair tests |
| Responsive section 12 | Browser | Playwright at 1440x900, 1024x768, 390x844, 360x800; overflow, focus, menus, charts and primary action visibility |
| Performance section 11.6/12.3 | Load/browser timing | Server p95 fixture, first-answer timing, lazy breakdown request trace and hidden-tab polling test |

## 21. Verification and release gates

### 21.1 Core mechanical gates

```bash
pnpm typecheck
pnpm test
pnpm --dir web test
pnpm --dir web build
pnpm --dir sdk test
pnpm --dir sdk typecheck
pnpm --dir sdk build
release_tmp=$(mktemp -d)
pnpm --dir sdk pack --pack-destination "$release_tmp"
MCP_VERSION=$(node -p "require('./packages/mcp/package.json').version")
MCP_TARBALL="$release_tmp/poolstatis-mcp-$MCP_VERSION.tgz"
npm pack --json --pack-destination "$release_tmp" ./packages/mcp > "$release_tmp/pack-output.txt"
POOLSTATIS_MCP_TARBALL="$MCP_TARBALL" \
POOLSTATIS_MCP_PACK_OUTPUT="$release_tmp/pack-output.txt" \
  pnpm mcp:package:test
docker compose -f docker-compose.selfhost.yml config
```

Database tests use an isolated disposable Postgres, never a live/shared customer database.

### 21.2 Cloud gates

- full private Cloud tests and typecheck;
- operator web tests/build;
- exact pinned-Core integration tests;
- founder/non-founder authorization tests;
- warning redaction corpus;
- immutable mutation/idempotency tests;
- operator desktop/mobile browser smoke.

### 21.3 Release sequence

1. Integrate Core P0 on freshly fetched `origin/main` through a reviewed PR.
2. Prove migrations are absent or additive and restore-compatible.
3. Build immutable Core artifact and run full gates.
4. Integrate private Cloud against the exact accepted Core artifact through a separate PR.
5. Before production: record live SHAs/digests, backup and restore-test, protected counts,
   health and warning watermark.
6. Deploy compatible server reads before clients that require them.
7. Switch atomically, retain rollback artifacts and run repeated external/live probes.
8. Browser-smoke customer and authenticated operator surfaces with authorized disposable
   fixtures.
9. Confirm live read-back, not only a successful deployment command.

Merge and production release remain separate gates.

## 22. Pattern references and explicit adaptations

The audit references patterns, not a visual style to copy:

- **Plausible:** compact Web answer and breakdown density;
- **Amplitude:** curated/official answers and visible shared context, not its unlimited chart
  builder;
- **Remote:** used/left resource clarity;
- **StackAI:** one consistent resource-row format;
- **Obvious:** trend and contributor attribution without duplicating totals;
- **Resend:** separate improvements from confirmed health;
- **Rox:** recommendation -> evidence -> assumption -> action;
- **Linktree:** contextual agent prompt beside the current answer, not a detached AI chat;
- **Vercel:** projection, thresholds and project contribution;
- **Stripe Workbench:** actionable integration diagnostics;
- **Sentry Stats:** accepted/dropped health breakdown;
- **PostHog:** starter questions and refresh patterns only where they preserve Poolstatis
  semantics/privacy.

Poolstatis retains its STIX headings, Geist body, Geist Mono identifiers, semantic registry,
privacy posture and restrained visual language.

## 23. Open product risks requiring owner decisions

1. **Hosted plan source:** Core currently knows current entitlements, while authoritative
   hosted plan/billing semantics belong to Cloud. The customer Usage action must use a
   Cloud-provided capability/link without copying billing logic into Core.
2. **Attention acknowledgement:** P0 can recompute open items, but durable acknowledge/snooze
   semantics require an audited data model. Until P2 monitors, only resolve-by-evidence is
   guaranteed; a cosmetic client-only snooze is prohibited.
3. **Official answer authorization:** owner/admin is the proposed boundary. Whether members
   may create non-official saved answers is a product choice before P1 migration freeze.
4. **Interesting people semantics:** “stalled” and “at risk” require purpose-backed metric or
   funnel definitions. A generic heuristic would be misleading and remains unavailable.
5. **Expected decision date ownership:** releases currently have evidence-window state, but a
   human owner identity/date contract may need additive fields rather than inference.
6. **Notification delivery:** Usage thresholds have recorded warning state, but hosted email,
   webhook and in-product routing ownership is not unified. P0 shows current state; P2 owns
   configurable routing.
7. **Operator warning migration:** replacing raw `event/detail` in the browser response may
   reduce current debugging detail. The owner must approve whether privileged deep debugging
   moves to a separate audited server-side workflow or is removed entirely from web.
8. **Forecast confidence:** the specified deterministic projection is intentionally simple.
   Seasonal forecasting is out of scope until enough history and a separately reviewed model
   justify it.
9. **Cross-project metric identity:** matching by key is necessary but may not be sufficient
   after definition revisions. P2 must compare versioned semantic fingerprints, not labels.
10. **Ten-second study recruitment:** the launch threshold requires real representative users;
    internal implementers alone cannot satisfy it.

## 24. Definition of done

The program is done only when:

- every requirement in section 20 has passing evidence or an explicitly owner-accepted
  exclusion;
- Core and Cloud changes are separately reviewed, merged and read back from their remote
  mains;
- complete mechanical, browser, privacy, compatibility and restore gates pass on the exact
  release candidates;
- production, if authorized, runs immutable accepted artifacts and passes repeated live
  probes;
- no approved branch retains unique required commits;
- the current product behavior, target behavior and any unresolved product risk remain
  truthfully distinguished in the release record.

## 25. Implementation read-back

### 25.1 Read-back snapshot — 2026-08-12

This snapshot was produced from Core `origin/main` at `4fbfdf8` and private Cloud
`origin/main` at `d20d628`. It is a requirement-by-requirement source/test audit, not a
replacement for final browser, release and production evidence. The HTML audit's status
summary must not be treated as independent proof because it is the source specification.

| Requirement area | Status | Proven now | Residual required work |
| --- | --- | --- | --- |
| HC-HOME-01..06 | partial | Server-ranked top-three Attention, impact/freshness/action, outcomes, funnel and activity | Add per-item change/delta and complete moderated ten-second proof |
| HC-WEB-01..05 | partial | Ordered readiness, traffic health/delta, lazy independent breakdowns and partial headline | Compute the selected outcome/conversion answer instead of only declaring outcome readiness; expose complete answer evidence |
| HC-ANSWER-01..05 | partial | Canonical takeaway/trust/purpose, chart, follow-up task and validated saved/official answer backend | Remove duplicate always-open provenance, avoid blocking the first answer on comparison/trust, and offer an authorized direct Save as official path |
| HC-FUNNEL-01..05 | verified | Overall/comparison/biggest losses/lost actors/goal, exact named transition, immutable investigation lineage and environment-safe explicit Ship handoff | Do not infer releases/experiments or causality; publish the pending MCP tools only in a separately versioned package after registry read-back |
| HC-PEOPLE-01..04 | partial | Privacy-safe factual order, bounded reason/window, exact lookup and one data-health block | Implement purpose-backed recently activated/stalled/at-risk/changed-segment ranking; do not substitute a heuristic |
| HC-SHIP-01..04 | partial | Guided empty state, real prerequisites/action and release blocker/owner/decision date | Add real experiment owner/expected-decision facts or keep them explicitly unavailable |
| HC-SETUP-01..05 | partial | Server next gate, collapsed completed connection, proof timestamps and read-back | Record per-gate latency/freshness and distinguish a saved decision from a generic saved insight |
| HC-DEF-01..04 | partial | Four group counts/severity, server-ranked fix and affected saved answers | Extend the dependency graph to built-in Home/Web/Product/Funnel answers |
| HC-EVENTS-01..04 | partial | 24h/7d trends, improvements vs doing-well, affected answers and watermark verification | Add bounded novelty semantics so a signature can truthfully be called new |
| HC-REG-01..04 | partial | Health counts, purpose/review, used-by impact and immutable revision API | Render revision history and define `unused` consistently with built-in answer consumers |
| HC-EXP-01..04 | verified | Guided privacy-first setup, illustrative preview, aggregate friction answer/readiness and prohibited raw-capture boundary | Re-check in the final browser matrix |
| HC-EXPERIMENT-01..04 | partial | Readiness, atomic prepare, lifecycle links, versioned monitors and immutable pause proposal | Expose proposal target/thresholds contextually in Experiment UI; human identity must remain the only mutation reviewer |
| HC-DECISION-01..04 | partial | Eligible-release empty flow, server queue order, assumptions/gaps/reversibility and truthful action status | Enforce human owner/admin on classic decision and follow-up approvals; current MCP mutation path contradicts the human-control promise |
| HC-KEYS-01..04 | verified | Masked scope/env/age/last use, server rotation policy, exact revoke impact and neutral type color | Re-check focus and mobile table presentation in final browser matrix |
| HC-USAGE-01..07 | partial | Compact plan/pace/forecast/contributors/no-cap narrative, threshold evidence and responsive layout | Link contributors to project health, wire real notification ownership/audit and make Configure cap/Set alert actions reach real capabilities |
| HC-PROJECTS-01..04 | partial | Env-scoped portfolio, last event, health, usage, attention, create dialog and semantic comparison fail-closed behavior | Replace configured-contract proxy with current queryable outcome availability |
| HC-PROFILE-01..03 | verified | Profile is account-only and truthfully separates hosted/self-host mode and action | Re-check hosted authenticated route in final release smoke |
| HC-OP-01..08 | partial | Canonical server queue, bounded warning signatures, affected projects, four detail tabs, immutable actions, privacy/economics separation | Put forecast/last action in queue and Customers, fail closed on incomplete list contracts, prove positive cap-breach path and full-list filtering |
| Shared state / shell | partial | Home/Usage signals, truthful finite/no-cap color, mobile drawer, focus/reduced-motion primitives | Make uncapped usage compact and accessible instead of `aria-hidden`; finish full state/browser matrix |
| P2 program | partial | Scheduled semantic feed, semantic comparison, versioned metric impact, monitors/notifications and human-reviewed pause proposals exist | Complete contextual UI, notification routing ownership and role-aware presentation without relaxing approval gates |

### 25.2 Current verification notes

- Core typecheck passes on this snapshot.
- A fresh full web run exposed one asynchronous assertion in the Decision handoff test: the
  row became selected before the detail request assertion was awaited. The product code
  already issued the request; the test now waits for the observable request and passes in
  repeated focused runs. The full suite must be rerun after integration.
- Independent focused Core UI audit passed 58 relevant tests. Independent Cloud audit passed
  38 API/control-tower tests, 71 operator-web tests and five browser checks on `d20d628`.
- The compact Usage release has already passed local desktop/mobile rendering and production
  lineage/health checks, but the broader program remains incomplete while any row above is
  `partial`.

### 25.3 Integration rule for subsequent slices

Each implementation slice must update the corresponding row from `partial` to `verified`
only after its exact contract, authorization, focused tests and rendered state pass. A visual
polish commit cannot close a backend semantic gap; an API field cannot close a presentation
requirement until the user can read it in the intended hierarchy.
