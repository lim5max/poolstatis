# Web analytics + Users reuse audit

**Date:** 2026-07-30

**Status:** read-only preflight for future Workstream E; no integration or release approval

**Audit branch:** `codex/analyze-reuse-audit`

**Exact base:** `codex/core-light-visual-system` at
`2ffde36c23e2ddcc2e007c4996f1c467ba445619`

**Program contract:** `2026-07-30-analyze-navigation-visual-system-prd.md`

## Executive verdict

Do not merge or cherry-pick any audited branch wholesale.

All five requested remote refs diverge from the current base at
`618013babf810ee09ee86288013bf7ed1d6d3a53`. The current base has two commits
that none of those refs contains, while the refs carry 56–78 commits that the
current base does not contain. Those commits include hosted auth, Cloud policy,
usage metering, package release, Visual Experience and metric-taxonomy work
that is not owned by Workstream E.

The reusable boundary is narrower:

1. Reimplement the corrected Web analytics contracts and SQL concepts from
   `3c73342b54c6aae8bb0ec32af22b16808c4ff1af`, while closing the custom-event
   privacy and deterministic session-order gaps recorded below.
2. Reimplement the atomic registry setup contract and its concurrency tests
   from `5b237a89e9c68179d8c409c6f1164a14b7431849`.
3. Reuse the current base's `actor_links`,
   `poolstatis_resolve_actor(...)`, person summary and registry APIs, but add a
   new bounded `actors` branch and repair detail/list parity.
4. Build new `Analyze > Web analytics` and `Analyze > Users` screens on the
   accepted Workstream D visual/navigation base. Do not port the old
   `Measurement.tsx` composition.
5. Keep country unavailable/`unknown` until a separately reviewed Cloud
   release proves a trusted client-IP boundary and MMDB lifecycle. The local
   MMDB branch is an infrastructure option, not a Core prerequisite.
6. Do not port any audited migration. Web analytics/session aggregation itself
   requires no new table. Add a new migration only if a measured actor-list
   query plan proves that a new additive index is necessary.

No audited ref contains the required `kind: "actors"` Query DSL branch or a
Users index.

## Audit method and limits

The audit used:

- repository `AGENTS.md`;
- the complete Program PRD, especially sections 9, 10, 14, 15, 16.E, 17 and
  19;
- the installed `poolstatis-analyze` skill to preserve registry-backed typed
  query semantics;
- the installed review workflow for an independent claim review;
- `npx -y skills find "read only git branch reuse audit code review"` as
  research only. It returned external review skills, but none was installed;
  the repository-specific local workflow is stronger for this audit.

Evidence was collected with read-only `git rev-parse`, `git merge-base`,
`git rev-list`, `git cherry`, stable patch IDs, `git show`, `git diff`,
`git grep`, `git ls-tree`, `git worktree list` and direct source/test
inspection.

This audit did not:

- run application or database tests;
- start or mutate PostgreSQL;
- read credentials or environment secrets;
- call production APIs;
- verify current npm registry state;
- merge, cherry-pick, rebase, deploy or publish.

Therefore test coverage below means inspected test code, not a fresh passing
test run. Historical live evidence is labelled separately and is not treated
as current production state.

## Refs, worktrees and ancestry

Every requested worktree was present, clean, on the expected local branch,
equal to its named remote ref and at the requested SHA.

| Ref | SHA | Merge-base with `2ffde36c` | `base-only / ref-only` commits | Direct lineage between requested refs |
| --- | --- | --- | ---: | --- |
| `origin/codex/web-analytics-live-diagnostic` | `42584fd8e363f4b421b24e854ce49070ae1045c4` | `618013b` | `2 / 56` | parent of local-MMDB only |
| `origin/codex/web-analytics-local-mmdb` | `d76febe457d152a59a5ff23f84c699d5a1192d37` | `618013b` | `2 / 57` | one commit after `42584fd` |
| `origin/codex/web-analytics-migration-ui-p1` | `5b237a89e9c68179d8c409c6f1164a14b7431849` | `618013b` | `2 / 78` | five commits after `3c73342` |
| `origin/codex/web-engagement-p1-corrections-integration` | `3c73342b54c6aae8bb0ec32af22b16808c4ff1af` | `618013b` | `2 / 73` | parent of migration/UI P1 and release |
| `origin/codex/web-engagement-release` | `8ffeb887e788c738361a9d668ee99416978247ed` | `618013b` | `2 / 74` | one commit after `3c73342` |

The two current-base-only commits are:

- `1130477a1d4e19622642b74615a1374656e5fb8c` — release-version design;
- `2ffde36c23e2ddcc2e007c4996f1c467ba445619` — Core light visual system.

The corresponding requested worktrees were:

- `.worktrees/web-analytics-live-diagnostic`;
- `.worktrees/web-analytics-local-mmdb`;
- `.worktrees/web-analytics-migration-ui-p1`;
- `.worktrees/web-engagement-p1-corrections-integration`;
- `.worktrees/web-engagement-release`.

Related worktrees also inspected:

- `.worktrees/web-engagement-session-v1` and
  `.worktrees/web-engagement-session-v1-fixes`, both at
  `03c13ad8508733e884eace78ae71633d6c2a2f6f`;
- detached review worktree `/private/tmp/poolstatis-engagement-review-03c13ad`
  at the same SHA;
- `/private/tmp/poolstatis-engagement-release` at `c8f5ef3`, which currently
  has uncommitted package/release-document changes and is not release evidence.

### Patch-equivalent forks

The branch graph alone hides two cherry-picked equivalents:

- `42584fd` and `492c059` have the same stable patch ID
  `a7b5c17edcfe36294814bebd5fb0e663056e1dcf`;
- `d76febe` and `296f470` have the same stable patch ID
  `45b4ab58ebb9de40bd9a73fe12fbb8e5c9d5b482`.

Thus the corrections line already contains the diagnostic and local-MMDB
changes under different commit IDs. Porting both versions would duplicate
work.

## Feature commit inventory

The commits below are the relevant feature deltas. The many earlier
Cloud/hosted/Visual commits in each ref are intentionally excluded from the
reuse set even though they are unique relative to the current base.

### Browser acquisition and basic Web analytics

| Commit | Role | Reuse verdict |
| --- | --- | --- |
| `aa2dd59` | consent-bounded acquisition attribution, SDK/API/MCP/UI/tests | concepts and selected files only |
| `0127b07` | initial browser SDK, `web_analytics` branch, EventStore, MCP, admin and tests | superseded by later corrections |
| `af2a0ce` | browser session/composition corrections | superseded by corrected tip |
| `786e187` | query, EventStore, HTTP and UI review corrections | superseded by corrected tip |
| `e2cd3e7` | identity reset hardening | reuse through final SDK behavior |
| `e8c8548` | no identity restoration without consent | reuse through final SDK behavior |
| `79e46df` | bounded browser dimensions and country validation | reuse through final SDK/server validation |
| `fffbef9` | bounded breakdown explorer | UI implementation is obsolete; retain truncation concept |
| `42584fd` / `492c059` | sanitized live diagnostic and regressions | evidence/tests only |
| `d76febe` / `296f470` | local read-only MMDB resolver option | defer to Cloud release gate |

### Metric taxonomy and consent branch

| Commit | Role | Reuse verdict |
| --- | --- | --- |
| `732598d`, `5230654` | project-scoped metric taxonomy and migration `031` | out of Workstream E; do not port |
| `ad2bfbd` | explicit `opt-in`, `opt-out`, `external` consent policies | reuse behavior and tests |
| `6296b18` | bounded pathname handling | keep bounds, strengthen to trusted safe route keys |
| `6cf2728` | host can narrow coarse context | reuse behavior and tests |
| `fbde7ca` | clear disabled browser identity | reuse behavior and tests |

### Session engagement and corrections

| Commit | Role | Reuse verdict |
| --- | --- | --- |
| `03c13ad` | first measured engagement candidate | rejected as a reuse source; known semantic blockers |
| `2ecf617` | alternate session implementation with terminal keepalive fixes | superseded by corrections tip |
| `edeb0f8` | lifecycle/SDK boundary corrections | reuse through corrected tip |
| `7309f70`, `c862c65`, `6f3f073`, `c0b9d6a`, `b8c7a31` | onboarding/package/skill documentation | do not couple to Workstream E |
| `28bfe29` | tri-state, actor isolation, exact 10-second threshold, strict canonical page-event validation | primary backend/SDK test source; custom-event privacy remains open |
| `de70642` | preserve legacy/manual page events without giving them browser semantics | primary regression source |
| `3c73342` | expose session inspection states in admin UI | semantic reference; UI itself is obsolete |

The original `03c13ad` candidate is one commit after `fbde7ca`, while the
corrected line is ten commits after the same base. `03c13ad` is not
patch-equivalent to `2ecf617`; it lacks later SDK terminal flush behavior and
retains the issues corrected by `28bfe29`.

### Setup/CORS/UI P1

The exact delta from `3c73342` to `5b237a8` is:

1. `0cafaa1` — public browser ingest CORS for canonical HTTPS origins;
2. `05bc7e1` — setup preflight and Measurement UI corrections;
3. `c7f75f2` — make setup conflicts atomic;
4. `5c2f905` — serializable atomic setup and registry helper changes;
5. `5b237a8` — serialize concurrent setup with an advisory lock.

The final route:

- takes a project-scoped advisory lock;
- starts `SERIALIZABLE`;
- preflights browser, attribution and reserved metrics before writes;
- commits one bundle;
- retries SQLSTATE `40001`/`40P01` three times;
- returns a controlled `503` with `retryable: true`;
- invalidates registry/query caches only after success.

This is a good contract to reimplement against the future base. The commit
cannot be cherry-picked safely because it rewrites a Cloud-era
`src/http/server.ts` and registry services.

`0cafaa1` must remain a separate security decision. It allows canonical HTTPS
origins to POST only to three browser-write routes with a `pk_` bearer token,
forbids cookies and bounds headers/methods. Do not silently include this policy
while porting analytics.

### Package release

`8ffeb887e788c738361a9d668ee99416978247ed` changes package metadata,
release docs and package tests. It declares:

- `@poolstatis/sdk` version `0.1.0` with `./browser`, `./attribution` and
  `./experience`;
- `@poolstatis/mcp` version `0.3.0`;
- PolyForm-Shield metadata and public npm `publishConfig`.

It adds no Web analytics behavior beyond `3c73342`, does not include the later
atomic setup/CORS branch, and is not proof that either package was actually
published. Publication, a pushed release branch and a Cloud deployment are
separate gates.

## Ref-by-ref coverage

Legend: “present” means verified in source at that ref; it does not mean
freshly tested or deployed.

| Ref | REST / Query DSL | EventStore / Postgres | MCP | SDK | Admin UI | Inspected tests |
| --- | --- | --- | --- | --- | --- | --- |
| `42584fd` | setup route and `kind: web_analytics` | headline visitors/sessions/views and bounded breakdowns | `propose_browser_analytics`, `query_web_analytics`, browser standard | attribution + browser capture | traffic summary inside `Measurement` | browser country, web analytics, property registry, MCP, SDK |
| `d76febe` | same plus resolver attribution metadata | same aggregates | same; no package publication | same | same plus country attribution | adds config/MMDB/country fallback cases |
| `3c73342` | adds `web_sessions`, `web_session`, `page_engagement`; REST uses shared `/query` | tri-state session/page CTEs, actor-resolved joins, bounded reads | adds `get_web_overview`, `list_web_sessions`, `get_web_session`, `get_session_engagement`, `get_page_engagement` | engagement snapshots, lifecycle flush, consent modes, bounds | overview and session inspector inside `Measurement` | dedicated web-engagement, web-analytics, MCP, SDK and UI tests |
| `5b237a8` | same, plus atomic setup and separate public-ingest CORS policy | same query implementation | same | same | country-name/unknown explanations and setup states in `Measurement` | adds rollback, conflict preflight, concurrency/retry, CORS and UI cases |
| `8ffeb88` | same as `3c73342` | same as `3c73342` | same tools plus package contract changes | package metadata/exports | same as `3c73342` | adds SDK/MCP package manifest and runner contract tests |

None of the refs provides:

- `kind: actors`;
- cursor/keyset actor pagination;
- exact-ID actor search through the Query DSL;
- a Users index route;
- actor-property-filter enforcement for an actor list;
- a users/profile PII masking/role policy.

## Web analytics semantics worth reusing

### Strong reusable contracts

The corrected `3c73342` implementation has the right core ideas:

- visitors are unique query-time resolved actors;
- sessions are distinct `(resolved actor, non-empty session_id)` pairs;
- page views are accepted canonical `page.viewed` events;
- browser-owned events are separated by `$browser_context = "1"`, so
  legacy/manual page events do not silently acquire browser semantics;
- session and page joins include project, environment, resolved actor, session
  and page-view ID;
- cumulative engagement uses only the highest sequence per actor/page;
- engagement is positive at `foreground_ms >= 10000`, at two page views or at
  an active selected key metric;
- incomplete negative sessions remain `engaged: null`, `bounce: null`;
- `measured_session_coverage`, `engaged_rate`, `bounce_rate` and timed-page
  coverage return `null` when their denominator is absent;
- session/page detail fails closed on actor ambiguity;
- dimensions and filters are bounded; breakdowns fetch 51, return 50 and
  report truncation;
- canonical marked page events and Web query output exclude raw IP, full URL,
  query string, DOM/page text and full user agent;
- country is server-derived only and fails closed to `unknown`;
- accepted event accounting is explicit: snapshots remain billable stored
  events; aggregation creates no synthetic event.

The SDK contract also contains useful safeguards:

- default opt-in plus explicit opt-out/external modes;
- Global Privacy Control disables every mode;
- no browser storage read before opt-in/external consent;
- withdrawal removes listeners, queued events and stored identifiers;
- logout/account switch rotates visitor/session identity;
- coarse typed browser/device values only;
- optional finite pathname mapper and bounded acquisition composition;
- heartbeat lower/upper bounds, monotonic foreground time and seven-day page
  rollover;
- SSR import safety.

### Conflicting or stale parts

These parts must not be copied unchanged:

1. `docs/13-browser-analytics.md` at `3c73342` first defines sessions as
   distinct `session_id` values, while the query metadata and SQL correctly use
   `(resolved actor, session_id)`. The latter is authoritative.
2. The same document says browser setup is non-transactional. That is true at
   `3c73342` but stale at `5b237a8`, where setup is atomic and serialized.
3. The old admin places customer Web analytics in `Measurement`. The Program
   PRD explicitly separates analysis from capture/consent/privacy setup.
4. The old UI predates the accepted light visual system and Workstream D
   navigation/chart contracts.
5. A default bounded pathname can still contain account, invitation or object
   identifiers. Workstream E should require trusted safe route keys for
   customer-facing breakdowns, or render route analysis unavailable; length
   bounds alone are not semantic privacy.
6. `8ffeb88` mixes package-version decisions with feature code lineage.
   Package publication must be performed only from a later accepted integrated
   SHA.
7. `0cafaa1` is a public-origin ingest policy, not an analytics-query change.
   It needs independent auth/CORS abuse review on the future base.
8. The corrected server allowlist is strict for canonical marked
   `page.viewed` and `page.engagement`, not for every event emitted through
   `browser.track()`. The SDK composes caller-supplied custom properties with
   `$browser_context`, and those properties can still reach storage. Therefore
   the audited code does not prove the PRD's forbidden-data contract for all
   browser-context events. Workstream E must either:
   - reject custom browser properties by default and allow only an explicit
     registered event/property contract with bounded primitive values; or
   - send custom product events through the neutral base SDK without marking
     them as Browser analytics context.
   Key-name heuristics are not an acceptable substitute for an allowlist.
9. `webSessions()` orders its bounded result by
   `started_at DESC, session_id` only. Because session grain also includes
   resolved actor, identical start times and a reused `session_id` across
   actors have no stable final order. Reimplementation must add `actor_id` as
   the final tie breaker before applying `LIMIT`.

## Migration inventory and risk

### Current base

The current base has migrations `001` through `022`. Relevant existing
migration:

- `017_decision_loop_trust_sources.sql` creates project/environment-scoped
  `actor_links`, append-only `actor_link_audit`, the stable recursive
  `poolstatis_resolve_actor(...)` function and trusted property definitions.

The current migration runner:

- sorts full filenames lexicographically;
- tracks the full filename in `schema_migrations`;
- runs each file in its own transaction;
- holds the migration advisory lock.

### Audited lines

| Migration | Present in refs | Purpose | Workstream E risk |
| --- | --- | --- | --- |
| `017_cloud_identity_profile.sql` | all requested refs | hosted identity profile | duplicate numeric prefix with current actor migration; unrelated |
| `018_personal_token_lifecycle.sql` | all requested refs | hosted token lifecycle | duplicate numeric prefix with current release migration; unrelated |
| `023`–`028` | all requested refs | personal-token ownership, usage ledger/concurrency, hosted policy | Cloud release-line dependency; do not port |
| `029_experience_surface_recency.sql` | all requested refs | Browser Experience surface index | unrelated to Web analytics/Users |
| `030_visual_experience_maps.sql` | all requested refs | routes/snapshots and hosted role grant helper | unrelated schema and Cloud role dependency |
| `031_metric_taxonomy.sql` | `3c73342`, `5b237a8`, `8ffeb88` | metric-category tables, backfill, FK and hosted role helper | high integration/lock/rollback surface; not required for Web analytics |

Browser acquisition, Web analytics, session engagement, local MMDB and the
atomic registry setup add no database migration.

Directly porting migration `031` is specifically rejected because it:

- drops and replaces the existing category CHECK;
- adds and seeds a project-scoped table;
- adds a cross-table FK to `metrics`;
- installs triggers/functions;
- assumes a hosted runtime role contract absent from the current lineage;
- is not needed to assign the already-supported `acquisition` category.

If an actors query needs an index, allocate the next accepted migration number
on the future Workstream D lineage and review the exact query plan, lock
duration, previous-app compatibility, empty DB and restored pre-release DB.

## Production, local and release evidence

### What is known

`42584fd` contains sanitized historical live read evidence for one project and
environment:

- visitors `1`;
- sessions `1`;
- page views `1`;
- one `unknown` country group;
- no active actor links;
- `dev` returned zeros.

It also records 208 accepted registered `page.viewed` events, of which only one
in a bounded latest-100 sample carried the canonical browser-context marker.
That evidence explains why the canonical Web analytics metric intentionally
excluded legacy events.

The same document is explicit that it was a diagnostic only and did not deploy
country enrichment.

`d76febe` is local implementation/design evidence only. It requires:

- a read-only, checksum-pinned DB-IP Lite Country MMDB outside Git/images;
- an exact trusted proxy CIDR;
- a single authoritative public client-IP header;
- startup type/smoke validation;
- transient in-memory IP handling only;
- a separate Cloud mount/env/restart release.

It states that the then-current shared Jino proxy path was not eligible and
that production should remain `country = unknown`.

### What is not proven here

- the historical diagnostic values are not current;
- the feature refs are not proven to be the live Core lineage;
- `8ffeb88` does not prove npm publication;
- no ref proves a Cloud MMDB mount or trusted proxy contract;
- no ref proves a production deployment of corrected session engagement;
- local/source test code does not prove production behavior.

### Cloud release-line dependency

The relevant browser commits sit on a branch that also contains hosted auth,
token, metering, policy and Visual Experience work. That dependency is
historical, not architectural.

Core Web analytics can be reimplemented without those Cloud migrations.
Cloud is required only for:

- trusted reverse-proxy/client-IP provenance;
- MMDB file acquisition, checksum, mount, ownership/mode and lifecycle;
- immutable Core/admin artifact deployment;
- backup/restore and live migration gates;
- production SDK/MCP rollout and package availability proof.

## Current-base capability audit

### Already present and reusable

1. Audited actor links:
   - project + environment isolation;
   - one active target per source;
   - cycle rejection;
   - create/revoke audit history;
   - recursive query-time resolution without rewriting events.
2. Actor-link resolution is already used by trend, funnel, retention,
   lifecycle, stickiness, measurement coverage and `actorSummary`.
3. Canonical person detail exists:
   - REST `GET /api/v1/projects/:slug/persons/:distinctId`;
   - MCP `get_person`;
   - admin `Person` screen;
   - event-derived first/last seen, totals, active days, sessions, registered
     share and top events;
   - optional identity entity.
4. Browser Experience has:
   - `interaction_map`;
   - `experience_session`;
   - REST `/query`, MCP and admin reads;
   - bounded map/session limits.
5. Property definitions already support `event`, `actor` and `entity` scopes
   with proposed/trusted/untrusted status.

### Web analytics/session gaps

The current base has no:

- `sdk/src/browser.ts` or `sdk/src/attribution.ts`;
- browser analytics setup/service/country resolver;
- `web_analytics`, `web_sessions`, `web_session` or `page_engagement` schema
  branch;
- corresponding EventStore methods;
- Web analytics MCP tools;
- Web analytics admin route.

The existing Browser Experience `experience_session` query is not a substitute:
its Postgres predicate scopes project, environment, `session_id`, surface and
time, but not resolved actor. Its result also omits actor identity. Reused
session IDs across actors can therefore combine timelines. Workstream E must
not build Users or Web session drilldown on this behavior.

### Actors/Users gaps

The current base has no `actors` branch or actor index. It lacks:

- bounded keyset pagination and cursors;
- deterministic ordering/tie breakers;
- exact-ID search in the typed Query DSL;
- registry resolution for the optional activity metric;
- registered actor-property filter validation;
- `raw_actor_count`;
- list-level first/last seen, total events, active days and bounded top events;
- nullable/trust-qualified session count;
- deterministic `identity_status`;
- pinned-property selection;
- REST/MCP/admin list parity.

### Person-detail inconsistencies to fix

The current person shell is useful, but not semantically ready for Users:

1. `actorSummary` resolves actor links, while the Activity feed calls the raw
   event sample endpoint with `distinct_id = exact input`. Linked anonymous
   source events appear in summary totals but disappear from the feed.
2. `getIdentityEntity` also uses exact `entity_id`, not the resolved canonical
   actor. Calling a profile by an old anonymous ID can therefore return a
   resolved summary with no target entity.
3. The response does not return canonical actor ID, raw IDs or link
   provenance.
4. The activity feed is latest-100 by ingest order, not cursor-paginated actor
   activity.
5. The UI infers `Identified`/contactability from arbitrary `email` or `name`
   keys and renders arbitrary entity properties. This conflicts with the PRD's
   explicit PII/masking/role requirement.
6. The current event purge action deletes exact raw `distinct_id` events, while
   the visible summary may represent several linked IDs. This ambiguity must
   be resolved before moving the destructive control into a canonical profile.

### Semantics that current storage cannot prove

`identity_status: stable | linked | anonymous | ambiguous` cannot be derived
truthfully from ID spelling alone.

- Active actor links can prove `linked`.
- Multiple raw IDs resolving to one canonical actor can support the linked
  state and `raw_actor_count`.
- No current field proves that an unlinked ID is an anonymous device versus a
  stable authenticated user.
- The current link invariants prevent simple source conflicts/cycles, but do
  not define when the customer-facing result should be `ambiguous`.

Workstream E must approve a deterministic server-owned identity-status
contract before exposing the column. It must not infer anonymous/stable from
prefixes such as `visitor:` or from arbitrary profile properties.

Actor property semantics also need a decision. The registry can declare
`scope = actor`, but the current native store has no materialized actor table.
The implementation must define whether pinned/filterable values come from a
canonical identity entity, a deterministic latest trusted event property, or
another existing source. A UI-only merge of arbitrary properties is rejected.

## Exact integration recommendation

Future Workstream E starts only from the accepted Workstream D SHA, not
automatically from `2ffde36c`.

### 0. Recheck lineage and ownership

Before editing:

1. record accepted Workstream D local/remote SHA and clean status;
2. verify it descends from the accepted Workstream B/Core visual SHA;
3. compare its Query DSL, navigation and shared chart components with this
   report;
4. reserve owned files with the coordinator;
5. keep Web analytics capture/privacy setup in `Manage data`, and analysis in
   `Analyze`.

### 1. Lock server contracts with failing tests

Write tests first for:

- the Web analytics result shapes from corrected `3c73342`;
- actor/session/page isolation and tri-state nulls;
- the new `actors` schema/result;
- actor-link-resolved list/detail parity;
- REST/MCP/admin semantic parity.

Do not start with UI or package metadata.

### 2. Reimplement browser capture and setup on the future base

Port behavior, not commits, from:

- `sdk/src/attribution.ts`;
- `sdk/src/browser.ts`;
- `src/services/acquisitionAttribution.ts`;
- `src/services/browserAnalytics.ts` at `5b237a8`;
- the strict canonical page-event validation in the corrected line.

Use the future base's current SDK exports, errors, auth, registry helpers and
light-system conventions. Keep country resolver mode `unknown` initially.

Before enabling `browser.track()` custom properties, add the explicit
registered event/property allowlist described in the privacy finding above,
or keep custom events on the neutral SDK path without `$browser_context`.

Reimplement the `5b237a8` setup transaction/advisory-lock contract. Do not
bring `0cafaa1` public-origin CORS unless a separate auth/CORS review approves
it.

### 3. Reimplement typed Web queries through the storage seam

Add, in this order:

1. strict schema branches:
   - `web_analytics`;
   - `web_sessions`;
   - `web_session`;
   - `page_engagement`;
2. EventStore request/result types;
3. Postgres implementation based on the corrected `webEngagementCtes`;
4. buffered-store delegation;
5. QueryService cases with registry/trusted-property validation;
6. REST read-back through the shared `/query`;
7. MCP tools;
8. API/web types.

Preserve:

- `(project, env, resolved actor, session, page)` grain;
- `>= 10000` threshold;
- highest cumulative sequence;
- actor ambiguity fail-closed behavior;
- explicit null denominators and coverage;
- top-50 + truncation bounds;
- canonical browser-context metric filter;
- active native key-metric requirement.

Change session-list ordering to
`started_at DESC, session_id, actor_id` so bounded results are deterministic at
the actor/session grain.

### 4. Implement `actors` independently on the current identity seam

Add:

1. `actorsQuerySchema` with:
   - limit default `50`, maximum `100`;
   - opaque validated cursor;
   - exact-ID search only;
   - the three approved orders;
   - an optional active native event-based activity metric key;
   - bounded trusted property filters;
2. `ActorsQuery`/result types in `EventStore`;
3. a Postgres query that:
   - resolves every event actor at read time;
   - groups by canonical actor;
   - counts distinct raw IDs;
   - uses deterministic order plus canonical ID tie breaker;
   - uses keyset predicates, never offset;
   - bounds top events;
   - returns a next cursor only when more data exists;
4. QueryService validation for registered compatible actor properties;
5. REST `/query`, MCP and web parity.

Do not add a mutable users table merely for the list.

Recommended window semantics are a server-owned default of trailing 30 days to
`now` when `from`/`to` are omitted. `first_seen`, `last_seen`, counts and top
events are then explicitly window-scoped. `activity_metric`, when present, is
an actor-membership predicate: include only actors who matched that active
event-based metric in the same window; it does not silently redefine the
general event counters. If product requires lifetime first/last seen instead,
pause and approve a separate result contract/query plan before implementation.

Before choosing pinned properties or identity status, approve their
server-owned semantics as described above. Until then return an explicit
unavailable/partial capability rather than guessed values.

### 5. Repair person detail before linking from Users

The profile must:

- resolve and return the canonical actor ID;
- return bounded raw-ID/link provenance;
- use the same resolved actor population for summary and activity;
- fetch the canonical identity entity under an approved rule;
- make session grouping conditional on trusted session evidence;
- remove arbitrary `email`/`name` identification inference;
- display only approved/masked properties under an explicit role policy;
- keep destructive exact-ID purge outside the canonical profile until its
  linked-ID blast radius is explicit.

### 6. Build the new Workstream D-native UI

Create separate routes:

- `Analyze > Web analytics`;
- `Analyze > Users`;
- canonical user profile drilldown.

Use Workstream D templates, `VisualizationSpec`, chart/table fallback and
shared light visual tokens. Reuse no old `Measurement.tsx` layout. That screen
should retain only capture configuration, consent/privacy state and registry
setup.

Every Web block must distinguish:

- supported with real evidence;
- unavailable because instrumentation is missing;
- blocked by trust/privacy;
- incomplete measurement.

### 7. Defer distribution and Cloud wiring

Only after Core integration passes independent review:

- decide SDK/MCP next free versions;
- build/pack and smoke exact exports/tools from the integrated SHA;
- verify public registry availability separately;
- wire Cloud country only after proxy/MMDB gates;
- perform backup/restore, migration and atomic deployment under the release
  workstream.

Do not reuse `8ffeb88` as a release commit and do not assume version `0.1.0` or
`0.3.0` is still free/current.

## Required tests for the future branch

### Web analytics backend

- project and environment isolation;
- anonymous actors remain separate before an explicit link;
- linked actors deduplicate after link and separate again after revoke;
- reused session/page IDs across actors never join;
- exact 10,000 ms is engaged;
- 9,999 ms complete is a known negative;
- crash/incomplete remains null, never false/zero;
- positive evidence remains true even with another incomplete page;
- heartbeat-only page remains incomplete;
- latest sequence wins over duplicate/out-of-order snapshots;
- malformed/overflow engagement properties reject before storage;
- canonical marked page events reject unknown fields, oversized values, full
  URLs, query strings and text/DOM-like payloads;
- custom browser events reject properties outside an explicit registered
  event/property allowlist, or remain neutral SDK events without
  `$browser_context`;
- legacy/manual `page.viewed` remains stored but outside canonical Web
  semantics;
- no denominator returns null rates;
- top-50 breakdown and truncation flag;
- web-session `LIMIT` is deterministic for equal timestamps/reused session IDs
  through the actor-ID tie breaker;
- inactive/proposed/deprecated key metrics reject;
- session/page detail bounds and ambiguity errors;
- safe route-key enforcement;
- unknown-country fail-closed path and optional attribution metadata.

### Browser SDK

- default opt-in, explicit opt-out/external;
- GPC in every mode;
- no storage read before consent;
- withdrawal clears queue/listeners/IDs;
- account reset and stale-storage failure;
- route mapping and bounded acquisition composition;
- context narrowing cannot expand the allowlist;
- heartbeat min/max and duration rollover;
- lifecycle terminal keepalive;
- hidden/frozen time exclusion;
- SSR imports for all exports;
- exact package files/exports only during the later distribution gate.

### Actors query

- schema defaults and hard bounds;
- exact-ID only; reject substring/property scans;
- opaque/tamper-resistant cursor validation;
- every order with equal-value ID tie breakers;
- no duplicate/missing rows across pages;
- default 30-day window, explicit-window boundaries and cursor/window binding;
- activity-metric population membership without counter redefinition;
- project/environment isolation;
- actor-link chains, multiple raw IDs and revocation;
- `raw_actor_count`, first/last seen, total events and active days;
- bounded deterministic top events;
- trusted compatible actor-property filters only;
- reject missing/proposed/untrusted/wrong-scope filters;
- session count null/unavailable contract;
- approved identity-status cases;
- approved pinned-property source and masking;
- empty result and no-next-cursor behavior;
- query-plan/latency evidence on a large synthetic fixture.

### Person and parity

- list item and profile use the same canonical actor;
- linked source events appear in activity;
- canonical entity/provenance behavior;
- no arbitrary PII inference/display;
- REST, MCP and admin compare equal semantics;
- Browser Experience and Web session actor isolation;
- no empty profile tabs;
- keyboard/mobile/table fallback and no overflow.

### Migration/release only if applicable

- empty database;
- restored pre-feature database;
- migration advisory lock and per-file rollback;
- previous app version against additive schema;
- no table rewrite/destructive SQL;
- production URL guard for all test databases.

## Explicit stop conditions

Stop implementation or integration when any of these is true:

1. the accepted Workstream D SHA/remote equality is unknown;
2. a proposed change requires wholesale cherry-pick/merge of an audited ref;
3. migration `031` or hosted migrations appear in the Workstream E diff;
4. actor list uses offset, unbounded scan or substring search;
5. identity status or pinned-property source is still inferred rather than
   approved;
6. actor property filters are not registry-backed and trusted;
7. list, person summary, activity and entity resolve different actor
   populations;
8. any session/page join omits resolved actor;
9. incomplete evidence becomes false, zero engagement or bounce;
10. route labels can expose unreviewed dynamic identifiers;
11. custom `$browser_context` events can store properties outside an explicit
    registered allowlist;
12. bounded web-session ordering omits the resolved actor tie breaker;
13. PII masking/role policy is absent while arbitrary properties are rendered;
14. MMDB/client-IP trust boundary, checksum or read-only mount is missing;
15. CORS policy broadens browser writes without separate security review;
16. REST, MCP and admin disagree;
17. a test points at a real/production database;
18. an SDK/MCP package is promised before exact registry/consumer smoke proof;
19. migration or release backup/restore/rollback gates fail.

## Review findings and disposition

### P0

No P0 issue remains in this report. The report authorizes no production or
data mutation.

### P1

- **Resolved in recommendation:** direct integration of divergent
  Cloud-bearing refs is rejected.
- **Resolved in recommendation:** migration `031` and duplicate-numbered
  hosted migrations are excluded.
- **Resolved in recommendation:** current Browser Experience session reads
  cannot substitute for actor-isolated Web sessions.
- **Resolved in recommendation:** current person summary/activity/entity
  split-brain must be repaired before Users.
- **Resolved in recommendation:** identity status, actor properties and PII
  cannot be inferred.
- **Resolved in recommendation:** country remains fail-closed until Cloud
  trust evidence exists.
- **Resolved in recommendation:** corrected canonical page validation is not
  overstated as protection for arbitrary `browser.track()` properties; an
  explicit registered custom-event allowlist or neutral SDK path is required.

### P2

- **Recorded:** stable patch-equivalent commits prevent duplicate porting.
- **Recorded:** `docs/13-browser-analytics.md` has stale session/setup wording.
- **Recorded:** release commit/package metadata is not publication evidence.
- **Recorded:** old `Measurement` UI and pre-light visual treatment are not
  reusable UI.
- **Resolved in recommendation:** bounded web-session reads add `actor_id` as
  the final deterministic tie breaker.

## Concrete reusable boundary

Reusable as behavior/test specifications:

- corrected Web query shapes and EventStore types from `3c73342`;
- `webEngagementCtes` grain, tri-state and bounds from `28bfe29` through
  `3c73342`;
- legacy event isolation from `de70642`;
- consent/identity/path/context SDK tests from `ad2bfbd` through `fbde7ca`;
- strict canonical page payload tests from `28bfe29`, extended with a new
  custom-event property allowlist;
- atomic setup/concurrency tests from `5b237a8`;
- current-base actor links, resolver, registry and person-summary foundations.

Reusable only behind a separate gate:

- local MMDB resolver design from `d76febe`/`296f470`;
- public browser-write CORS policy from `0cafaa1`;
- package manifests/tests from `8ffeb88`.

Not reusable:

- any whole audited commit/branch;
- hosted/Cloud migrations `017_cloud` through `028`;
- migrations `029`, `030`, `031`;
- old `Measurement.tsx` Web analytics UI;
- original `03c13ad` session candidate;
- package versions or publication claims;
- current exact-ID person Activity feed as canonical actor activity;
- inferred identity/PII traits.
