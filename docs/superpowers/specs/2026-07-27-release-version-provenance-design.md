# Release Version Provenance for Browser Experience — Design

## Decision

Poolstatis will keep **page rendering identity** separate from **product change
provenance**:

- the canonical `version` field identifies the exact frontend build that
  produced Browser Experience evidence and screenshots;
- a `release` explains what changed, when it was deployed, what outcome was
  expected, and which metrics should be evaluated.

The minimum integration is a build-provided version in the Browser SDK or a
public HTML meta tag. An agent can enrich that version through MCP after a
successful deployment. GitHub, GitLab, a specific CI vendor, and SSH access to
the customer's host are not required.

This design deliberately avoids pretending that Poolstatis can infer an exact
deployment from traffic dates or from the currently reachable page.

## User outcome

A customer can host a site on any VPS or platform and still:

- see click and scroll evidence on the exact desktop or mobile page version;
- retain immutable history across redeploys and rollbacks;
- tell Poolstatis what changed through an agent, API, or manual admin flow;
- evaluate the change against a primary metric and guardrails;
- receive recommendations whose confidence matches the available evidence.

## Approaches considered

### 1. Require a GitHub App or vendor-specific CI action

Rejected as the default. It can import useful repository and pull-request
metadata, but it excludes customers using GitLab, Bitbucket, local Git,
custom deployment scripts, or no hosted forge.

### 2. Infer releases from deploy dates or the currently reachable page

Rejected. A crawler cannot know when a rollout began, distinguish a rollback,
or safely attach old browser events to a page fetched after another deploy.
Hashed asset URLs also miss HTML-only and runtime configuration changes.

### 3. Explicit page version plus optional MCP release context

Selected. The browser carries an opaque build identity. A privileged agent or
human can later attach change meaning and measurement intent to that identity.
This is deterministic, vendor-neutral, and small enough for a first release.

## Concepts and boundaries

### Page version

The canonical wire and storage field is the existing `version`. In this
document, **page version** means that same field; no parallel `page_version`
storage contract is introduced. It is public and must not contain an email
address, full URL, query string, customer input, or other personal data.

Recommended values are:

- a Git commit SHA;
- a Docker image digest or shortened digest;
- a CI/build identifier;
- a monotonically unique deploy label such as `2026-07-27.3`.

A page version is scoped by project and environment. Exact visual evidence is
further scoped by:

- Browser Experience surface;
- safe route key;
- page version;
- device profile;
- optional bounded presentation variant such as locale or theme, when a
  project explicitly declares it.

The same page version can therefore have separate `/`, `/docs`, desktop, and
mobile artifacts without being treated as separate releases.

The public origin, route-key-to-path mapping, and allowed device profiles are
declared once as a version-independent **capture target**. A newly observed page
version can then be published for fresh artifacts without making the customer
repeat route configuration for every deployment.

### Release

A release is an immutable product-change fact. It can reference an
`experience_version`, which resolves to the existing Browser Experience
`version`, but it is not required for basic Browser Experience capture.
It retains:

- deployment environment and timestamp;
- source kind and source version;
- optional repository, branch, commit, and pull-request references;
- concise change summary and bounded changed areas;
- frozen measurement contract, primary metric, guardrails, and hypothesis;
- optional flag, experiment, and variant;
- append-only state transitions and evaluation evidence.

Existing Git-backed release records migrate to `source_kind=git` and use their
commit SHA as `source_version`. Non-Git releases use `source_kind=build` or
`manual` and do not fake a commit SHA.

### Evidence strength

Poolstatis must distinguish three levels in UI, API, and MCP output:

1. **Observed after release:** the metric changed after `deployed_at`; this is
   temporal association, not proof of causality.
2. **Controlled comparison:** a valid experiment or equivalent comparison
   supports a causal product conclusion.
3. **Insufficient evidence:** sample size, observation window, identity,
   guardrails, or version attribution is incomplete.

Recommendations may propose an investigation, follow-up experiment, fix, or
rollback, but must not claim root cause merely because a metric moved after a
release.

Evidence strength is computed by the server and returned as:

```ts
type EvidenceStrength =
  | { kind: "temporal_association"; reason: string; blockers: string[] }
  | { kind: "controlled_comparison"; reason: string; blockers: string[] }
  | { kind: "insufficient_evidence"; reason: string; blockers: string[] };
```

The admin and MCP render this value; they do not infer causality from a trusted
metric, a ready screenshot, or a chronological chart.

## Browser SDK contract

`BrowserExperienceOptions` keeps the existing optional `version` value or
provider and adds meta-tag fallback:

```ts
interface BrowserExperienceOptions {
  // existing fields
  version?: string | (() => string);
}
```

Resolution order is deterministic:

1. explicit `version`;
2. `<meta name="poolstatis-release" content="…">`;
3. no version.

The SDK resolves the value once when the Browser Experience session starts.
The current Browser Experience wire v1 remains unchanged: `version`, route,
device, viewport, and document geometry stay on each interaction event. The
SDK writes the same cached version to every event in the session, and stable
retries retain the exact original payload.

This design does not introduce a new batch envelope or require a synchronized
server/SDK cutover. Existing SDKs and servers remain mutually compatible during
rolling upgrades. A future versioned wire v2 may deduplicate stable context,
but it is outside this scope and cannot replace v1 without an explicit major
migration.

The core `PoolstatisEvent` contract remains unchanged. Normal product events do
not gain a release field.

If no version is available, capture still works. Evidence is marked
`unversioned`, remains available in aggregate interaction queries, and cannot
be drawn over an exact screenshot.

The SDK does not:

- inspect Git;
- send DOM, text, selectors, query strings, or asset lists;
- invent a version from the current date;
- perform privileged release registration from a public ingest key.

## Page-version and snapshot flow

After the first accepted Browser Experience batch for a new version:

1. the ingest service stores the accepted events and records that an exact
   snapshot is missing;
2. the admin and MCP expose `snapshot_pending` rather than an empty or guessed
   map;
3. no compute job is created from a public ingest request;
4. a privileged `publish_experience_version` call checks the verified target,
   entitlement, caps, and idempotency before queuing artifacts;
5. the capture worker visits only the project's verified public origin and
   declared safe routes;
6. desktop and mobile artifacts are stored with the exact page-version key;
7. overlays become available only when version, surface, route, and device
   match.

Event ingestion is never rejected because screenshot capture failed. A capture
failure degrades visual evidence and exposes a retryable status.

If the same page-version key produces conflicting layout signatures for the
same route and device, Poolstatis marks the version `ambiguous` and refuses to
overlay evidence until a new version is published. It never silently replaces
an immutable artifact.

Layout identity is immutable:

- the same exact tuple and layout signature confirms the existing artifact
  idempotently;
- a different layout signature for the same tuple marks it `ambiguous`;
- lookup never resolves ambiguity with newest-by-time selection;
- a customer publishes a new page version to recover.

## Release registration

The existing project-scoped `register_release` MCP and REST operation remains
the canonical product-change registration path. Its input becomes
vendor-neutral:

```ts
interface RegisterReleaseInput {
  idempotency_key: string;
  contract_key: string;
  env: string;
  source_kind?: "git" | "build" | "manual";
  source_version?: string;
  experience_version?: string;
  repository?: string;
  branch?: string;
  commit_sha?: string;
  pr_url?: string;
  deployed_at?: string;
  change_summary?: string;
  changed_areas?: string[];
  flag_key?: string;
  experiment_key?: string;
  variant?: string;
  originating_decision_id?: string;
  status?: "planned" | "deployed";
}
```

Rules:

- legacy payloads with `repository` and `commit_sha`, but no source fields, are
  accepted and normalized to `source_kind=git` and
  `source_version=lower(commit_sha)`;
- existing immutable revision snapshots are normalized when read or compared
  for idempotency and are never rewritten in place;
- new Git registrations require repository and commit SHA, and
  `source_version` must equal the lowercase commit SHA;
- build and manual registrations require `source_version` and do not fabricate
  Git values;
- `change_summary`, when present, is concise semantic text rather than a raw
  diff;
- `source_version` and `experience_version` are 1–200 characters and match
  `^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$`;
- `change_summary` is 10–1,000 trimmed characters;
- `changed_areas` contains at most 20 unique normalized keys of 1–80
  characters, sorted before the idempotency fingerprint;
- repository references are at most 500 characters; PR URLs reject userinfo,
  fragments, and credential-like query parameters;
- repeated registration with the same project, environment, and idempotency
  key returns the same release only when the full immutable payload matches;
- canonical registration first resolves legacy source fields and inherited
  contract flag/experiment values, then computes one immutable payload hash;
  exact retries compare that canonical hash so omitted inherited fields cannot
  conflict with their persisted values;
- existing response fields and `originating_decision_id` remain available to
  old REST and MCP consumers throughout the additive migration;
- a redeploy or rollback creates a new release fact;
- `experience_version`, when supplied, links release evaluation to exact Browser
  Experience artifacts.

MCP descriptions instruct an agent with local repository access to summarize
the relevant diff and deployment intent. The agent does not need GitHub: local
Git, a build manifest, or operator-provided context is sufficient.

## Publishing visual versions

The privileged `configure_experience_capture` operation declares
version-independent capture targets:

```ts
interface ConfigureExperienceCaptureInput {
  env: string;
  verified_origin_ref: string;
  route_ids: string[];
  device_profiles?: Array<"desktop" | "mobile">;
  idempotency_key: string;
}
```

Each route ID refers to an existing project-scoped Browser Experience route and
its `path_pattern`; the operation does not create a second route/path source of
truth. Core stores only the tenant-scoped capture intent and opaque verified
origin reference. Raw origin verification and outbound HTTP are Cloud or
self-hosted-runner responsibilities.

The privileged `publish_experience_version` operation explicitly announces a
version when an agent wants capture to begin before the first real browser
event:

```ts
interface PublishExperienceVersionInput {
  env: string;
  version: string;
  release_id?: string;
  idempotency_key: string;
}
```

Both operations can be called through MCP, REST, a generic script, or a manual
admin form. A future GitHub or GitLab integration may call the same operations
but does not own a separate data model.

Publishing a version uses the persistent capture targets and returns bounded
status per requested artifact:

- `pending`;
- `capturing`;
- `ready`;
- `failed`;
- `ambiguous`.

It validates that any `release_id` belongs to the same project and environment
and links the same `experience_version`. Publication enforces bounded active
versions, routes, devices, queued jobs, and retries. Observing an arbitrary
version through a public ingest key can never consume capture compute.

Hosted publication receives a fail-closed entitlement:

```ts
interface CaptureEntitlement {
  max_targets: number;
  max_devices_per_target: number;
  max_publishes_per_day: number;
  max_queued_jobs: number;
  max_retries_per_artifact: number;
}
```

Missing or expired hosted entitlement forbids new jobs without affecting event
ingestion or existing evidence. Values are plan configuration, not SDK
constants, but Core enforces finite global safety ceilings of 100 targets,
4 devices per target, 1,000 publishes per day, 1,000 queued jobs, and 5 retries
per artifact. Private Cloud can provide lower plan limits. Failed attempts and
retries are not billed; one successfully persisted capture artifact produces
one idempotent capture-compute add-on unit.

Observed-version status materialization is also bounded. When a public client
exceeds the configured distinct-version window, events remain accepted and
billable, but excess values do not create capture status or jobs; the project
receives a cardinality warning.

The existing `list_visual_experience_versions` contract remains unchanged for
ready snapshot metadata. A new `list_experience_version_statuses` tool exposes
observed and published lifecycle state. A separate idempotent
`retry_experience_capture` mutation accepts only project-scoped status or
artifact identifiers; read-only status calls never retry work.

The same server-owned read model is available to the admin through REST. For
each observed or published version it contains:

- `version`, `first_seen`, and `last_seen`;
- accepted event and distinct session counts;
- optional linked release summary;
- artifact status per exact surface, route, and device;
- a safe failure category and retryability;
- a server-generated next action.

The collection response also includes unversioned event count and share. There
is no single guessed `current` version: mixed rollout traffic returns multiple
versions ordered by `last_seen`, and the user selects the exact version to
inspect.

Status collections use strict schemas and default to 50 rows with a hard
maximum of 200. Responses contain `next_cursor`, `truncated`, returned count,
and available total when it can be computed within the same bounded query.
Safe failure categories are enums rather than passthrough worker messages.

## Customer workflows

### Agent-managed deployment

1. The agent chooses or reads a build version.
2. The build injects it through SDK configuration or the meta tag.
3. The customer deploys through any existing mechanism.
4. After the customer's healthcheck succeeds, the agent calls
   `register_release`.
5. The agent calls `publish_experience_version`; persistent capture targets
   supply the public routes and devices.
6. Poolstatis captures the artifacts and reports readiness through MCP.

### Deployment without an agent

The customer declares capture targets once, injects a version during each
build, and uses the admin:

1. **Experience → Capture targets:** verify the public origin and select safe
   routes and devices;
2. **Experience → Publish version:** enter the version and publish it for
   capture;
3. optionally use **Changes → Register deployment** with an existing valid
   measurement contract and deployment context;
4. watch snapshot status.

A visual version does not require a measurement contract. A product release
does, because Poolstatis cannot evaluate a change without a declared primary
metric, hypothesis, and guardrails.

### Site without Git or hosted forge

The customer uses a build label as `source_version` and the meta tag as
the Browser Experience `version`. Product measurement and visual maps still
work. Only
repository-level links and automated diff context are unavailable.

### Private or authenticated page

Poolstatis Cloud cannot crawl it with user cookies. The customer runs a
compatible snapshot runner inside its own environment and uploads only the
declared artifact plus bounded metadata. Authenticated capture, DOM replay, and
credential storage are outside this design.

## Admin experience

The existing **Changes** area presents release records around owner questions:

- what changed;
- what outcome was expected;
- what requires attention;
- what evidence exists;
- what action is safe next.

Browser **Experience** adds a compact version status:

- observed page versions ordered by `last_seen`, without guessing one current
  version during a mixed rollout;
- linked release, when present;
- persistent origin/route/device capture targets;
- desktop/mobile snapshot readiness;
- events waiting for a matching artifact;
- ambiguous-version warning;
- explicit aggregate-grid fallback when no exact artifact exists.

The UI must never label the normalized 16×16 fallback as a page heatmap. It is
named **Aggregate coordinate grid** and explains that no page background is
available.

An overlay and the phrase **Exact version + layout** are allowed only when the
server reports `ready` for the exact environment, surface, route,
`version`, and device tuple. The state machine is explicit:

- `pending` or `capturing`: show progress and a refresh action;
- `failed`: show a safe reason, retryability, and retry action;
- `ambiguous`: prohibit overlays and require a new page version;
- `unversioned`: show aggregate evidence and setup guidance only;
- `ready` with zero matching events: show an honest no-data state, not failure.

Status changes use a polite live region; failures use an alert; registration
and retry preserve or deliberately move focus. Long versions wrap and retain
their full accessible name. Successful manual actions report **Deployment
registered** and **Snapshot capture pending/ready** separately. Idempotency
conflicts preserve the entered values and provide a recovery action.

## Security and privacy

- Public ingest keys can submit events but cannot register releases, origins,
  routes, or artifacts.
- Release registration, capture-target configuration, and version publication
  require project management authorization.
- Capture origins must be verified for the project.
- The Cloud worker rejects loopback, link-local, private, metadata-service, and
  rebinding targets; redirects must remain on the verified origin.
- Routes are bounded, queries and fragments are stripped, credentials are not
  attached, and response size/time limits are enforced.
- Version and change metadata is validated for length and secrets/PII patterns.
- Snapshot artifacts and database references are project-scoped, retained, and
  backed up together.
- Artifact failure never exposes another tenant's version, screenshot, route,
  or event totals.

## Failure handling

- **Missing page version:** accept events; expose aggregate evidence and an
  actionable setup state.
- **Unknown page version:** accept events; mark exact artifact pending.
- **Capture failure:** retain events; show a safe error category and retry.
- **No capture target:** retain events; show the exact missing origin/route
  declaration rather than guessing a URL from browser data.
- **Version collision:** mark ambiguous; do not guess or overwrite.
- **MCP retry:** idempotent result for identical payload; conflict for changed
  payload under the same idempotency key.
- **Release without enough evidence:** remain observing or inconclusive; do not
  manufacture a recommendation.
- **Rollback:** create a new immutable release fact. Reuse an old Browser
  Experience version only when the deployed bytes and layout identity are
  actually the same; the new release still has its own deployment time and
  evaluation window.

## Repository boundaries

- SDK batch metadata, ingest validation, release provenance, APIs, MCP tools,
  storage seams, source-available admin, and technical docs belong in the
  Poolstatis core repository.
- Hosted capture execution, artifact storage configuration, origin verification
  operations, limits, and billing enforcement belong in private Poolstatis
  Cloud.
- Public integration guides and framework examples belong in
  `poolstatis-site`.

Core never performs arbitrary outbound capture. It stores project-scoped
intent and status. Private Cloud verifies origins, performs SSRF-safe capture,
checks hosted entitlements and caps, meters successful capture compute as a
separate idempotent add-on, and updates Core through a narrow service
capability. Capture attempts and artifacts do not increment the
`events_stored` billing unit. A self-hosted runner implements the same bounded
capability locally.

## Verification

Implementation follows TDD and requires:

### SDK

- explicit option takes precedence over the meta tag;
- meta tag is resolved once;
- SSR and missing metadata remain safe;
- one resolved version is repeated consistently across the existing event wire
  and survives retries;
- invalid or oversized versions are rejected before network submission;
- no DOM/text/URL/query/asset data is added.

### API, storage, and MCP

- page-version tenant and environment isolation;
- backward-compatible migration of existing Git releases;
- Git, build, and manual source validation;
- idempotent release and visual-version publication;
- idempotent capture-target configuration;
- exact conflict behavior;
- unknown-version ingestion and snapshot state;
- release-to-experience-version linking;
- bounded MCP outputs and REST parity;
- server-owned evidence-strength and experience-version status read models;
- regression coverage for canonical idempotency when flag or experiment values
  are inherited from the measurement contract.

### Capture security

- verified-origin enforcement;
- private-network, redirect, DNS-rebinding, timeout, and size-limit tests;
- route and device caps;
- artifact/database isolation and deletion consistency.

### Admin

- desktop and mobile responsive states for ready, pending, failed, ambiguous,
  unversioned, and no-data cases;
- no overlay when any exact key differs;
- no exact-evidence label until the server reports the exact tuple ready;
- aggregate fallback is clearly distinguished from a screenshot map;
- Changes shows summary, expected outcome, evidence strength, and next action
  without requiring repository links.

### End to end

A fixture site is deployed without GitHub integration:

1. version A is injected and deployed;
2. capture targets are configured once, then an agent registers the release
   and publishes its version through MCP;
3. browser events produce exact snapshot-backed evidence;
4. version B changes only HTML and receives a new explicit version;
5. old and new evidence remain separate;
6. a measurement evaluation reports association rather than causality;
7. an experiment-backed release reports controlled evidence;
8. a rollback creates a new immutable release and can restore the old visual
   layout without overwriting history.

Fresh typecheck, backend tests, SDK tests, admin build, MCP stdio E2E, capture
security suite, and live browser verification are required before deployment.

The public MCP package is cut only from one reviewed integration SHA containing
the accepted Visual Maps, release provenance, and package-distribution
histories. Its release gate includes Node 22 and 24, old and new
`register_release` payloads, publish/status/retry tools, strict output schemas,
pack allowlist, audit, SBOM/provenance/secret scan, registry-version absence,
single tarball publication, registry integrity comparison, and fresh
version-pinned `pnpm dlx` initialize/list-tools/status read. Setup UI and public
docs update their exact pin only after that registry smoke passes.

## Rollout

1. Add meta-tag fallback and session-stable version resolution without changing
   the existing per-event Browser Experience wire v1.
2. Extend release provenance with nullable vendor-neutral source and change
   columns, backfill current Git rows, normalize old append-only snapshots at
   read time, add constraints, and update API/MCP/admin consumers atomically
   before Git columns become nullable. Use the next available migration number
   after all already accepted migrations; never rename an applied migration.
3. Add persistent capture targets plus MCP/REST version publication and status.
4. Integrate automatic exact version/device snapshot capture.
5. Add admin workflows and public vendor-neutral documentation.
6. Offer GitHub/GitLab/Vercel adapters later as thin clients over the same APIs.

Implementation branches do not publish independently. A designated integrator
combines the reviewed Core provenance, Visual, private Cloud, site, and MCP
handoffs, proves ancestry and overlap, runs fresh combined gates, then deploys
or publishes the immutable reviewed outputs.

Existing unversioned Browser Experience events remain queryable through the
aggregate coordinate grid. No existing release or event is rewritten.
