# Poolstatis Analyze, Navigation and Light Visual System — Program PRD

**Date:** 2026-07-30
**Status:** approved direction, implementation program
**Owner:** product owner
**Program coordinator:** primary Codex thread
**Reference presentation:** `.mobbin/poolstatis-ux-review-20260730/index.html`

## 1. Product decision

Poolstatis will add a curated human analysis surface without becoming a
general-purpose dashboard builder.

The product keeps its agent-native, semantics-first core:

- metrics still require a concrete `purpose`;
- funnels still require a concrete `goal`;
- queries still reference registry keys through the typed Query DSL;
- trust, provenance and decision evidence remain server-owned;
- no client, chart renderer or LLM may issue arbitrary SQL;
- the existing operator and audit capabilities remain available.

The deliberate boundary change is that the web product will no longer expose
only internal system primitives. It will offer a small `Analyze` workspace for
recurring human questions, while preserving `Manage data` as the operator
surface and `Ship & decide` as the auditable product-change loop.

Poolstatis will also move every current customer-facing surface to a light
visual system with larger, consistent radii:

- the Core admin in `/Users/maksimstil/Desktop/poolstatis/web`;
- the landing, public documentation, login and signup surfaces in
  `/Users/maksimstil/Desktop/poolstatis-site`;
- future Cloud UI must consume the same semantic light-theme contract when it
  gains implementation code.

The private `/Users/maksimstil/Desktop/poolstatis-cloud` repository currently
contains design documentation only. No UI implementation is invented there.

## 2. Baselines and repository boundaries

Implementation work must record its exact base before editing.

At PRD creation time:

| Repository | Baseline | Notes |
| --- | --- | --- |
| Core | branch `codex/product-decision-loop-p0-p1`, HEAD `1130477a1d4e19622642b74615a1374656e5fb8c` | local HEAD is ahead of `origin/codex/product-decision-loop-p0-p1`; the main checkout also has unrelated user changes |
| Public site | branch `main`, HEAD `65decfadded494132d2faf9e4cba23526c662f7b` | clean and equal to `origin/main` |
| Cloud | branch `main`, HEAD `00b896730fd672b36d738986bfaf9fb0d22fdd8f` | clean, documentation-only baseline |

Unrelated main-checkout state is not part of this program:

- the user-owned `package.json` package-manager edit;
- `docs/superpowers/specs/2026-07-24-browser-acquisition-attribution-prd.md`;
- `.mobbin/` research artifacts except as read-only product/design evidence.

No task may overwrite, stage or silently absorb those changes.

Repository ownership remains:

- Core owns backend, Query DSL, MCP, SDK, admin SPA, migrations and technical
  self-host documentation;
- public site owns landing, product-facing docs, `/login`, `/signup`, Vercel
  configuration and waitlist code;
- Cloud owns hosted auth/billing/ops/deployment configuration when that code
  exists.

## 3. User outcomes

### 3.1 Product lead or founder

Can open Poolstatis and answer:

- what changed in the product;
- which trusted metrics moved;
- whether activation, retention or a funnel changed;
- what happened on the web surface;
- which users or actors make up the result;
- what evidence is missing;
- what decision or follow-up action needs attention.

The user does not need to understand the distinction between registry storage,
event tables, measurement contracts and internal workers before finding an
answer.

### 3.2 Product engineer

Can:

- move from a chart to its exact metric/funnel definition;
- inspect trust, sample, window, breakdown and actor population;
- reproduce the same result through MCP/API;
- open a user profile or event stream for debugging;
- connect a result to a release, experiment or decision;
- see unavailable or partial states rather than fabricated values.

### 3.3 Coding agent

Can:

- discover the same curated templates and visualization contract;
- execute only typed, registry-backed queries;
- return a deterministic `VisualizationSpec`;
- optionally compose approved UI components through OpenUI;
- never substitute generated labels, inferred events or arbitrary SQL for
  server-computed facts.

### 3.4 Operator

Retains:

- project and environment scope;
- registry and property trust controls;
- source, key and MCP setup;
- ingest warnings and data-health evidence;
- immutable decisions and audit history;
- safe operational status.

## 4. Information architecture

### 4.1 Primary navigation

The desktop navigation contains four task-oriented zones:

1. **Overview**
2. **Analyze**
3. **Ship & decide**
4. **Manage data**

The selected project and environment remain global context, visible in the
top bar and persisted by project scope.

`Projects` moves out of the persistent primary list and remains available from
the project switcher/workspace menu. Project creation and workspace
administration stay reachable.

### 4.2 Analyze

`Analyze` contains:

- Product analytics;
- Web analytics;
- Users;
- Saved views.

`Saved views` may remain hidden until its persistence milestone is shipped.
The route must not lead to a non-functional placeholder.

### 4.3 Ship & decide

Contains:

- Changes;
- Experiments;
- Decisions.

The zone presents one lifecycle:

```text
change/release -> measurement window -> evidence -> proposal -> human decision
```

### 4.4 Manage data

Contains:

- Data;
- Registry;
- Measurement;
- Sources and destinations;
- Keys;
- Setup & MCP.

Existing pages may initially remain separate routes under one collapsed
navigation group. This PRD does not require a risky all-at-once page rewrite.

### 4.5 Mobile

- one menu button opens a full-height navigation drawer;
- the same four zones and project/environment context are present;
- route changes close the drawer without restoring focus to a removed trigger;
- Escape closes overlays and restores the correct trigger;
- all interactive targets are at least 44 CSS pixels where touch interaction
  is expected;
- no page-level horizontal overflow is allowed.

## 5. Overview contract

Overview is a command center, not a generic dashboard.

It contains, when supported by real data:

- active users or actors;
- activation rate;
- a retention summary;
- measurement trust summary;
- releases currently in an evidence window;
- decisions needing attention;
- recent saved/official views;
- quick access to the curated template gallery.

Every block has one semantic action:

- open analysis;
- inspect trust blocker;
- review release evidence;
- review decision;
- open a template.

No decorative KPI may appear without:

- a metric/funnel/template source;
- environment;
- time range;
- aggregation and denominator;
- trust state;
- empty, unavailable and error states.

## 6. Curated analysis templates

V1 ships code-defined, versioned templates rather than a blank canvas:

1. Product health;
2. Web overview;
3. Activation funnel;
4. Retention;
5. Feature adoption;
6. Release impact;
7. Experiment result;
8. Data trust.

A template definition contains:

```ts
interface AnalysisTemplate {
  key: string;
  version: number;
  title: string;
  question: string;
  purpose: string;
  requiredCapabilities: string[];
  slots: AnalysisTemplateSlot[];
  defaultRange: TimeRangePreset;
  allowedBreakdowns: string[];
  allowedActions: VisualizationAction[];
}
```

Template slots reference registry metric keys, funnel keys, releases,
experiments or server-owned trust reports. They never reference raw event names
in a customer-facing saved definition.

Template selection:

- pre-fills a valid query;
- explains missing registry mappings;
- may propose metrics/funnels through the existing proposed -> active flow;
- does not silently activate or trust anything;
- can be previewed without saving;
- remains reproducible through MCP/API.

## 7. Visualization system

### 7.1 Base implementation

The preferred base is the current shadcn Chart component backed by Recharts
v3, integrated into the existing React 19 + Tailwind v4 design system.

The dependency is an implementation detail. Product code imports Poolstatis
components, not arbitrary Recharts primitives.

Required Poolstatis components:

- `MetricValue`;
- `TrendChart`;
- `BreakdownBars`;
- `FunnelChart`;
- `RetentionMatrix`;
- `RetentionCurve`;
- `StickinessHistogram`;
- `LifecycleChart`;
- `ReleaseImpactChart`;
- `ExperimentResultChart`;
- `TrustSummary`;
- `ActorActivityTimeline`.

### 7.2 Typed visualization contract

```ts
type VisualizationKind =
  | 'metric_value'
  | 'trend'
  | 'breakdown'
  | 'funnel'
  | 'retention_matrix'
  | 'retention_curve'
  | 'stickiness'
  | 'lifecycle'
  | 'release_impact'
  | 'experiment_result'
  | 'trust_summary'
  | 'actor_timeline';

interface VisualizationSpec {
  schemaVersion: 1;
  id: string;
  kind: VisualizationKind;
  title: string;
  question: string;
  purpose: string;
  project: string;
  env: string;
  range: { from: string; to: string; timezone: 'UTC' };
  source:
    | { kind: 'metric'; key: string; query: QueryInput }
    | { kind: 'funnel'; key: string; query: QueryInput }
    | { kind: 'release'; id: string }
    | { kind: 'experiment'; key: string }
    | { kind: 'trust_report'; key: string };
  trust: {
    status: 'trusted' | 'partial' | 'blocked' | 'unavailable';
    reason: string;
    blockers: Array<{ code: string; message: string; nextAction?: string }>;
  };
  display: {
    valueFormat?: 'number' | 'percent' | 'duration' | 'currency';
    granularity?: 'hour' | 'day' | 'week' | 'month';
    compare?: 'previous_period' | 'none';
    series: Array<{ key: string; label: string; colorToken: string }>;
  };
  actions: VisualizationAction[];
}
```

The server remains authoritative for query result, trust and evidence
semantics. The renderer may control layout and presentation only.

### 7.3 Required chart context

Every visualization shows or exposes:

- human title and question;
- metric purpose or funnel goal;
- project and environment;
- exact period and UTC semantics;
- aggregation/denominator;
- comparison basis;
- trust state and blockers;
- data/sample coverage where relevant;
- links to the underlying metric/funnel/query;
- compatible drilldowns only.

### 7.4 Interactions

Supported actions are typed:

```ts
type VisualizationAction =
  | { kind: 'open_metric'; key: string }
  | { kind: 'open_funnel'; key: string }
  | { kind: 'open_query'; query: QueryInput }
  | { kind: 'see_actors'; actorQuery: ActorsQueryInput }
  | { kind: 'compare_segment'; allowedProperties: string[] }
  | { kind: 'annotate_release'; releaseId: string }
  | { kind: 'open_decision'; decisionId: string }
  | { kind: 'save_view' };
```

The UI must not expose chart-type switches that are incompatible with the
result shape.

### 7.5 Accessibility and fallback

- charts use stable responsive dimensions;
- colors are not the only series/status signal;
- every chart has a textual/table fallback;
- keyboard focus can reach legends, points or an equivalent data table;
- tooltips are not hover-only;
- reduced-motion preferences disable nonessential transitions;
- high-density charts are horizontally contained rather than clipping page
  controls;
- desktop and mobile visual regression evidence is required.

## 8. Product analytics

V1 Product analytics supports existing typed primitives:

- trend;
- funnel;
- retention;
- lifecycle;
- stickiness.

The page starts from a template/question. Advanced query controls are
progressively disclosed.

Default controls:

- time range;
- granularity when supported;
- compare previous period;
- trusted property filters;
- one compatible breakdown;
- open reproducible query;
- save view when available.

No formula language, arbitrary query builder, ad-hoc SQL or unrestricted chart
picker is introduced.

## 9. Web analytics

### 9.1 Separate navigation and scope

Web analytics is a first-class `Analyze` route. Capture configuration, consent
policy and privacy controls remain in `Manage data`.

The desired overview includes:

- visitors/actors;
- page views;
- measured session coverage;
- engaged rate;
- bounce rate;
- average session duration;
- top safe route keys/pages;
- acquisition sources when the consent-gated attribution contract is present;
- device and country only when the current privacy contract provides trusted,
  non-sensitive values;
- registered conversion goals;
- realtime activity.

### 9.2 Fail-closed measurement

Values are shown only when the underlying implementation can prove them.

- incomplete sessions render `unavailable`, not `not engaged`;
- rates with no eligible denominator render `unavailable`, not `0%`;
- engagement and bounce expose `measured_session_coverage`;
- source attribution is labelled session landing attribution, never causal
  campaign credit;
- geography remains unavailable when the trusted source is not configured;
- raw IP, full URL, query string, DOM, text and full user agent are forbidden;
- Browser Experience activity remains isolated by resolved actor, session,
  route, project and environment.

The implementation may ship an initial subset, but the route must clearly
separate:

- supported now;
- unavailable because instrumentation is missing;
- blocked because trust/privacy gates fail.

It may not fabricate the complete desired overview with mock values.

### 9.3 Data/API boundary

Any new aggregate is implemented through:

- a strict schema branch;
- `QueryService`;
- the `EventStore` seam;
- `PostgresEventStore`;
- MCP exposure;
- REST/API read-back;
- tests.

It must remain implementable on a future ClickHouse store.

## 10. Users and actors

### 10.1 UI language

The navigation label is `Users`, because that is the customer mental model.
The typed backend primitive is `actor`, because anonymous devices, stable
users and linked identities must not be conflated.

### 10.2 Actors query

Add a narrow, read-only Query DSL branch:

```ts
interface ActorsQueryInput {
  kind: 'actors';
  env: string;
  from?: string;
  to?: string;
  limit?: number;       // bounded
  cursor?: string;      // keyset pagination
  order?: 'last_seen_desc' | 'first_seen_desc' | 'events_desc';
  search?: { kind: 'exact_id'; value: string };
  propertyFilters?: PropertyFilter[];
  activityMetric?: string;
}
```

Result:

```ts
interface ActorListItem {
  distinct_id: string;          // resolved stable actor id
  raw_actor_count: number;
  first_seen: string;
  last_seen: string;
  total_events: number;
  active_days: number;
  session_count: number | null;
  top_events: Array<{ event: string; count: number }>;
  pinned_properties: Record<string, unknown>;
  identity_status: 'stable' | 'linked' | 'anonymous' | 'ambiguous' | 'unknown';
}
```

Requirements:

- project + environment isolation;
- actor-link resolution on every event-derived aggregate;
- bounded keyset pagination;
- no unbounded substring scan across IDs or properties;
- property filters require registered, compatible actor properties;
- `linked` requires active actor-link provenance or multiple raw actors
  resolving to the same canonical actor;
- `stable` requires an explicit server-owned stable identity source;
- `anonymous` requires explicit capture provenance and is never inferred from
  an ID prefix or the absence of profile data;
- unresolved identity class is `unknown`; `ambiguous` is reserved for a
  server-detected conflict, not used as a synonym for missing evidence;
- `session_count` remains `null` unless session identity and grouping evidence
  are trusted;
- pinned properties come from one approved deterministic server source and
  are unavailable otherwise;
- no new mutable user table is introduced merely to render the index;
- existing person summary/profile remains the canonical detail base;
- API, MCP and admin return the same semantics.

### 10.3 Users index

Shows:

- actor/stable user identifier;
- key pinned properties;
- identity status;
- first/last seen;
- event and active-day counts;
- last meaningful activity;
- activation/cohort state only when backed by a registered definition.

### 10.4 User profile

Extends the existing profile shell with tabs as capabilities become real:

- Activity;
- Insights;
- Sessions;
- Cohorts;
- Experiments;
- Flags;
- Identity.

No empty tab is shown.

The Activity view supports:

- session grouping when session evidence exists;
- event filters;
- readable and raw property views;
- link to a specific event;
- selecting compatible events to create a funnel/trend;
- explicit identity-link provenance.

PII is not inferred from arbitrary property names. Masking and role policy must
be explicit before sensitive properties are displayed.

## 11. Saved views

Saved views are a separate milestone after the visualization contract is
stable.

The first implementation is additive and project-scoped:

```sql
CREATE TABLE analysis_views (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  env text NOT NULL,
  title text NOT NULL,
  description text,
  template_key text,
  schema_version integer NOT NULL,
  visualization_spec jsonb NOT NULL,
  status text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Final schema may follow local conventions, but must preserve:

- project/environment isolation;
- bounded validated JSON;
- explicit schema version;
- owner/editor provenance;
- active/archived status;
- no raw SQL or secret material;
- deterministic read validation;
- migration and rollback compatibility.

`Official` status is optional for V1. If implemented, only authorized roles
can set it and the audit trail is append-only.

## 12. OpenUI pilot

OpenUI is a gated pilot, not a prerequisite for the core release.

Architecture:

```text
human/agent question
  -> Poolstatis MCP typed tools
  -> server-computed query/trust result
  -> validated VisualizationSpec
  -> OpenUI Lang using an approved Poolstatis component library
  -> React Renderer / Codex or Claude artifact
```

Allowed OpenUI components are wrappers around the stable product primitives:

- MetricValue;
- TrendChart;
- BreakdownBars;
- FunnelChart;
- RetentionMatrix;
- ExperimentResult;
- TrustSummary;
- ActorTable;
- DecisionBrief;
- Stack, Grid, Tabs and text primitives.

Every component has Zod-validated props.

The OpenUI renderer may use MCP as a `toolProvider`, but:

- tool calls remain explicit and authorized;
- server results are not regenerated by the model;
- the model cannot choose an unregistered raw event;
- output cannot persist as a saved view until it validates as a canonical
  `VisualizationSpec`;
- generated content is labelled until explicitly saved/published;
- parse/tool errors fail closed to a textual reproducible result.

Pilot success criteria:

- five representative questions render correctly;
- repeated runs preserve query semantics;
- no unsupported metric/event substitution;
- visual output passes desktop/mobile and accessibility checks;
- generated view can expose the exact MCP calls and query specs;
- latency and token cost are recorded separately from query execution.

## 13. Light visual system

### 13.1 Shared principles

- light background is the default and only customer-facing theme for this
  program;
- preserve each application's existing typography rather than introducing a
  new cross-product font system: Core keeps STIX Two Text for headings, Geist
  for UI copy and Geist Mono for identifiers/data; the public site keeps
  Google Sans Flex for display text and its existing system sans/mono stacks;
- use one bounded semantic type scale across each application, based on the
  whole-pixel steps `12 / 14 / 16 / 18 / 20 / 24 / 30 / 36 / 48 / 60 / 72`;
  map sizes by role (`caption`, `control`, `body`, `lead`, `heading`,
  `display`, `code`, `chart`) and reject new arbitrary or fractional
  `font-size` values with an automated source guard;
- customer-facing UI, help text and code labels must not render below 12 px;
  responsive layout may change the semantic step at an explicit breakpoint,
  but must not continuously scale text from viewport width;
- white and near-white surfaces use contrast, spacing and subtle borders,
  rather than dark panels or heavy shadows;
- the logo's neon lime is the shared active brand color: primary actions,
  selected navigation/control states and the leading chart series use the
  same lime family with black or near-black foreground text; light
  hover/area/heatmap tints derive from that lime instead of a muted
  dirty-green primary;
- the palette is not monochrome: neutral ink plus restrained green, blue,
  amber and coral semantic accents; comparison series and status colors remain
  distinct so lime does not dominate every surface;
- radii increase consistently, not through one-off magic values;
- pills remain reserved for chips, status and compact filters;
- cards are not nested inside cards;
- controls keep stable dimensions;
- focus states remain visible;
- charts use the same semantic color tokens in Core and future Cloud UI.

### 13.2 Radius contract

Targets:

| Element | Target radius |
| --- | ---: |
| small control / icon button | 8 px |
| input / standard button / segmented control | 10 px |
| panel / card / popover | 12 px |
| large dialog / major framed visualization | 14–16 px |
| chip / badge | pill only when semantically appropriate |

Existing components may map through design tokens rather than literal values.
The implementation must scan for isolated radius values and reduce accidental
inconsistency.

### 13.3 Core admin

Core is already primarily light. The workstream must:

- make light mode explicit and remove accidental dark-theme states;
- increase shared radius tokens;
- tune sidebar, top bar, panels, tables, dialogs, inputs and buttons;
- create chart color tokens that are not one-note blue;
- preserve dense operator ergonomics;
- avoid changing API, DB, auth or product semantics;
- visually verify all current routes at desktop and mobile sizes.

### 13.4 Public landing and docs

The public site is currently dark and must be deliberately redesigned, not
inverted mechanically.

Scope:

- landing;
- public docs;
- login;
- signup;
- consent controls;
- search and mobile navigation;
- all shared shadcn primitives used by those surfaces.

Requirements:

- preserve current information architecture and truthful source-available /
  Cloud messaging unless a visual change requires a concise copy adjustment;
- preserve analytics consent and labels;
- preserve assets that remain legible on white;
- replace dark-only illustrations/background treatments where needed;
- no gradient/orb decoration as a substitute for content;
- no regressions in SEO, prerender, route deep links or Vercel rewrites;
- verify screenshots and interaction at `1440x900`, `390x844`, and `360x800`;
- run automated contrast and keyboard/focus checks where available.

### 13.5 Future Cloud UI

The Cloud design specification must record that customer and operator
surfaces consume the light semantic tokens. No Cloud UI code is created in the
documentation-only repository solely to satisfy this theme request.

## 14. Data safety and migration requirements

Protecting real projects and customer data is a release-blocking requirement.

### 14.1 Development isolation

- implementation and tests use Codex worktrees;
- tests use the local Docker Postgres on a disposable test database;
- browser E2E uses seeded/synthetic projects and keys;
- no task receives production DB credentials;
- no test points `DATABASE_URL` at production;
- real project slugs, tokens and payloads are not copied into fixtures;
- destructive purge endpoints are never exercised against production.

### 14.2 Migration policy

Every new migration is:

- additive;
- idempotent through the existing `schema_migrations` runner;
- executed inside the existing per-file transaction;
- protected by the migration advisory lock;
- compatible with the previous application version during rollback;
- tested from an empty database and from a restored pre-release database;
- reviewed for lock duration, table rewrite and index-build risk.

Forbidden without a separately approved data migration:

- `DROP TABLE`;
- `DROP COLUMN`;
- `TRUNCATE`;
- bulk `DELETE`;
- bulk `UPDATE` of customer event facts;
- physical database or credential rename;
- event rewrite to apply actor links;
- changing the physical DB name `poolsatis`.

### 14.3 Backup gate

Before any production mutation:

1. identify the exact live application SHA/image digest and Postgres major
   version;
2. create a timestamped database backup in a format that can be restored;
3. record size, checksum, location and retention;
4. copy the backup off the mutable release directory/host or satisfy the
   current approved off-host backup contract;
5. restore into a clean isolated database using the same major version;
6. run migrations on the restored copy;
7. compare `schema_migrations`, organizations, projects, events, entities,
   registry definitions, API keys and audit-table counts;
8. run read-only smoke queries against representative synthetic/project IDs;
9. record restore duration and result.

A local-only untested backup is not an accepted gate.

### 14.4 Production preflight

The release coordinator must prove:

- candidate branches are clean;
- candidate SHAs are pushed and immutable;
- required branches are based on the actual live lineage;
- Core image/static assets match recorded checksums;
- no unreviewed migrations are present;
- environment files have expected owner and mode without printing secrets;
- disk capacity is sufficient for backup, new artifacts and rollback;
- `/health` and `/ready` pass before traffic switch;
- the previous application artifact remains available.

### 14.5 Atomic deploy and rollback

Core/Cloud:

- deploy immutable image/artifact references;
- prepare the candidate next to the current release;
- run readiness and migration preflight before switching traffic;
- switch traffic atomically;
- keep the prior app release for rollback;
- app rollback must not require destructive schema rollback;
- do not automatically restore an old database over new writes.

Public site:

- build and test an immutable candidate;
- validate preview/deployment output and routes;
- production promotion is one versioned operation;
- retain the prior Vercel production deployment for immediate rollback;
- verify live asset MIME, route rewrites and checksums where available.

### 14.6 Post-deploy invariants

Verify without mutating real customer data:

- organization/project counts are unchanged;
- event/entity counts are non-decreasing within expected live-write behavior;
- sampled existing project reads return the same result contract;
- keys remain masked/listable and authentication still works;
- tenant isolation tests pass with synthetic tenants;
- ingest writes only to a dedicated synthetic smoke project;
- MCP lists/queries only the expected synthetic project scope;
- admin, landing, docs, login and signup return expected status and assets;
- browser console, network and accessibility checks are clean;
- repeated health/live probes pass;
- rollback path remains executable.

## 15. Testing contract

### 15.1 Core mechanical gates

```bash
docker compose up -d
pnpm typecheck
pnpm test
pnpm --dir sdk test
pnpm --dir sdk build
pnpm --dir web test
pnpm --dir web build
docker compose -f docker-compose.selfhost.yml config
```

If `web` has no test script at the implementation base, the workstream must
add or document the authoritative web test command rather than claim it ran.

### 15.2 Core targeted tests

- navigation routes, active states and project/environment persistence;
- template validation and missing-capability states;
- visualization spec validation;
- chart textual fallbacks and accessibility layer;
- actors query isolation, actor-link resolution, pagination and bounds;
- users index/profile drilldown;
- web analytics measured/unavailable/null states;
- REST/MCP/admin parity;
- saved-view tenant isolation and schema validation if shipped;
- migration from pre-feature schema and empty schema.

### 15.3 Public site gates

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

Browser coverage:

- `/`;
- `/docs` and representative deep links;
- `/login`;
- `/signup`;
- consent controls;
- docs search;
- desktop/mobile navigation;
- direct reload of every tested route;
- no horizontal overflow;
- no console/page errors;
- no failed images/fonts/assets;
- visible focus and reduced-motion behavior;
- WCAG AA contrast for normal text and controls.

### 15.4 End-to-end product scenarios

Use a fresh synthetic organization/project:

1. connect with an authorized test key;
2. register/activate test metrics with real purposes;
3. ingest deterministic synthetic events;
4. render Product analytics trend/funnel/retention;
5. render supported Web analytics and explicit unavailable states;
6. list actors and open an actor profile;
7. link anonymous -> stable actor and verify aggregate resolution without
   rewriting stored events;
8. open release impact and decision evidence when the fixture supports it;
9. execute the same query through REST and MCP and compare semantics;
10. save/reload a view if that milestone is included;
11. restart services and verify persistence;
12. delete only the disposable local/test database or synthetic project using
    the test-owned cleanup contract.

## 16. Delivery workstreams and ownership

### Workstream A — data safety and release gate

Read-only first.

Owns:

- migration risk inventory;
- backup/restore contract;
- production lineage discovery;
- release checklist and evidence template;
- disposable restore rehearsal;
- final release veto.

Does not implement UI or deploy before all candidate work is reviewed.

### Workstream B — Core light visual system

Owns:

- `web/src/index.css`;
- shared shadcn primitives;
- shared `Panel`, table, dialog and toolbar visual treatment;
- route-by-route visual verification.

Does not change navigation semantics, backend, DB or API.

### Workstream C — public-site light visual system

Owns the `poolstatis-site` landing/docs/auth visual refresh and its tests.

Does not change Core, Cloud backend, waitlist behavior, analytics consent or
production until release approval.

### Workstream D — Core Analyze foundation

Starts from the accepted Workstream B Core SHA.

Owns:

- primary navigation IA;
- Overview;
- template definitions;
- VisualizationSpec;
- chart primitives;
- Product analytics;
- tests and browser evidence.

### Workstream E — Web analytics and Users

Starts from the accepted Workstream D SHA.

Owns:

- Web analytics typed aggregates and route;
- actors Query DSL branch, REST, MCP and UI;
- users index/profile extension;
- fail-closed coverage;
- backend/web/E2E tests.

Implementation uses the evidence in
`2026-07-30-web-analytics-reuse-audit.md`:

- do not merge or cherry-pick the audited Web analytics/engagement refs
  wholesale;
- reimplement the corrected Query DSL/EventStore/MCP/SDK semantics and atomic
  setup behavior on the accepted Workstream D base;
- do not port hosted/Cloud migrations `017_cloud` through `031`;
- add no migration unless a measured restored-data query plan proves that an
  additive actor-list index is required;
- keep country unavailable until a separately reviewed proxy/MMDB lifecycle
  proves a trusted client-IP boundary;
- repair canonical person summary/activity/entity parity before linking the
  Users index to the profile.

### Workstream F — Saved views

Starts only after VisualizationSpec is stable.

Owns additive migration, REST/MCP/admin parity and tenant-isolation tests.

### Workstream G — OpenUI pilot

Starts only after the manual renderer and E2E tests are accepted.

Owns constrained component library, renderer integration and five proof
questions. It cannot redefine analytics semantics.

### Workstream H — independent review and release

Owns:

- requirement-by-requirement review;
- security/tenant/data-safety review;
- full clean-checkout gates;
- candidate integration;
- immutable release artifacts;
- atomic deployments and post-deploy verification.

The implementers do not approve their own production release.

## 17. Review protocol

Every implementation workstream must:

1. read its repository `AGENTS.md`;
2. inspect the exact base and dirty state;
3. use relevant installed skills;
4. run `npx skills find` for its domain and record which skill was selected or
   why the existing workflow was stronger;
5. use TDD for new backend/data behavior;
6. use Playwright/browser evidence for user-facing changes;
7. request an independent code review before handoff;
8. fix all Critical/Important findings;
9. commit only owned files;
10. push a dedicated `codex/` branch;
11. report exact base SHA, head SHA, tests, screenshots and remaining risk.

No thread may:

- merge to another branch;
- deploy;
- mutate production data;
- read or print secrets;
- revert unrelated changes;
- claim live behavior from local tests.

Those actions are reserved for the integration/release coordinator after
explicit gate evidence.

## 18. Program acceptance criteria

The program is complete only when all applicable items are proven:

1. Primary navigation uses Overview / Analyze / Ship & decide / Manage data.
2. Project/environment scope remains visible and correctly persisted.
3. Product analytics renders real typed query results through approved chart
   components.
4. Web analytics is a separate route with honest supported/unavailable states.
5. Users is a separate route backed by the bounded actors query.
6. Actor-link resolution is consistent across list, profile and analysis.
7. Eight curated templates validate against real capabilities.
8. Every chart exposes purpose/goal, period, aggregation, trust and a
   reproducible query/action.
9. Charts have responsive, accessible and tabular fallback behavior.
10. Saved views persist validated VisualizationSpec only if the saved-view
    milestone is included in the release.
11. OpenUI, if included, composes only approved components from server facts.
12. Core, landing, docs, login and signup use the accepted light visual system.
13. Radius tokens are consistent with the visual contract.
14. Existing product copy, consent, auth and route semantics remain truthful.
15. Core typecheck/tests/SDK/web builds pass from a clean integrated checkout.
16. Site tests/build and route E2E pass from a clean integrated checkout.
17. Tenant isolation and cross-project tests pass.
18. New migrations are additive and pass empty + restored-database rehearsal.
19. A verified off-release backup and clean restore drill succeed before
    production mutation.
20. Exact live lineage, candidate artifacts, checksums and rollback are
    recorded.
21. Core/Cloud and site deployments are atomic/versioned.
22. Post-deploy counts, reads, auth, ingest, MCP, admin and public routes pass.
23. No real project data is deleted, rewritten, relabelled or made
    inaccessible.
24. Final independent review has no unresolved Critical or Important findings.

## 19. Stop conditions

Pause integration or release immediately when:

- live lineage differs from the assumed base;
- the candidate contains unreviewed or destructive migration behavior;
- backup cannot be copied/verified/restored;
- restored counts or schema history differ unexpectedly;
- a previous app version cannot run against the additive schema;
- tenant-isolation, auth or key tests fail;
- any test points at production DB;
- real project counts drop;
- web/session metrics turn missing evidence into zero/false;
- renderer and MCP/API disagree about query semantics;
- public routes/assets fail after promotion;
- rollback evidence is missing.

The stop is a release-safety result, not a reason to bypass the gate.

## 20. Required program evidence

The coordinator keeps one evidence ledger containing:

- PRD version and accepted scope;
- thread/task IDs and owners;
- base/head SHAs for every candidate;
- independent review findings and fixes;
- commands and exact pass/fail counts;
- desktop/mobile screenshot locations;
- migration inventory and rehearsal results;
- backup checksum, restore evidence and count comparison;
- live preflight and post-deploy probes;
- release IDs/digests/URLs;
- rollback artifact and test;
- explicit list of unshipped/deferred capabilities.

Local implementation, pushed branches, integrated candidates and live
deployment are separate gates and must be reported separately.
