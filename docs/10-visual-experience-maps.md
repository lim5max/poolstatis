# Visual Experience Maps v1

Visual Experience Maps overlays aggregate interaction evidence on an immutable
PNG/WebP capture of the exact page/app release. It is **not** video, DOM session
replay, gaze tracking or cursor recording.

## Evidence model

The tuple is:

`project + env + surface + route + version + device + period`

- A **surface** has a stable key and a decision-oriented `purpose`.
- A **route** has a developer key and canonical path pattern. Patterns never
  contain query strings or hashes.
- A **snapshot** is an immutable deploy/capture artifact with release hash,
  viewport, dimensions and capture timestamp.
- `desktop` and `mobile` are separate evidence cohorts.
- Accepted experience events remain stored-event billing units. Image bytes are
  artifacts and are not inserted into `events`.

The map returns click bins and developer labels, scroll reach at 10% increments,
and named-section reach/drop-off with counts and percentages. Comparisons are
descriptive. They do not prove why a person stopped or that a release caused a
difference.

## Safe SDK capture

```ts
import { BrowserExperience } from '@poolstatis/sdk/experience';

const experience = new BrowserExperience({
  client: poolstatis,
  surface: 'marketing',
  route: () => location.pathname.startsWith('/docs/') ? 'docs' : 'home',
  version: import.meta.env.VITE_RELEASE_SHA,
  distinctId: () => authenticatedUserId,
  hasConsent: () => consent.analytics === true,
});

await experience.start();
// On consent withdrawal:
experience.stop();
```

Only stable developer labels are read:

```html
<section data-poolstatis-section="hero">
  <a data-poolstatis-label="hero.get_started">Get started</a>
</section>
```

The SDK sends normalized document and viewport click coordinates, viewport and
document dimensions, max-depth milestones, and one exposure per named section.
It never reads or sends DOM snapshots, text, raw paths/URLs, query strings, form
values, pointer paths, error messages or stacks. Capture is consent-gated,
batched in chunks of 25, memory-bounded and limited to 120 accepted signals per
minute by default.

## Snapshot upload

Snapshots are uploaded as raw bytes; the server never fetches a supplied URL.
The route accepts only PNG or WebP, validates container headers, dimensions and a
5 MiB maximum.

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $POOLSTATIS_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @home-desktop.png \
  "$POOLSTATIS_URL/api/v1/projects/$PROJECT/experience/snapshots?surface=marketing&route=home&version=$RELEASE_SHA&device=desktop&env=prod&release_hash=$RELEASE_SHA&viewport_width=1440&viewport_height=900&document_width=1440&document_height=3200&captured_at=$CAPTURED_AT&retention_days=90"
```

Do not print tokens in CI logs. Capture the deployed release at deterministic
viewport and font readiness, then upload from the trusted deploy job. Record
CSS-pixel `document_width`/`document_height` separately from physical PNG/WebP
pixel dimensions: this keeps normalized event coordinates on the exact layout
even when the capture browser uses a device-pixel ratio above 1.

## Storage, backup and retention

Self-host uses the pluggable `ArtifactStore` seam with `LocalArtifactStore`.
Configure:

```text
POOLSTATIS_EXPERIENCE_ARTIFACT_DIR=/var/lib/poolstatis/experience-artifacts
```

`docker-compose.selfhost.yml` mounts the named `poolstatis_artifacts` volume.
Back up PostgreSQL and this volume in the same backup window. Restoring only one
side leaves either missing images or orphan files.

Each snapshot has `expires_at` (90 days by default). The retention worker
deletes expired metadata and local artifacts in bounded batches.
`DELETE /api/v1/projects/{slug}/experience/snapshots/{id}` performs an explicit
project-scoped purge. Artifact reads always resolve the project from the
authenticated route; another tenant receives `404`.
The existing danger-zone purge with `scope=all` also removes snapshot metadata
and image artifacts for the selected environment; `scope=events` remains
event-only.

Customer UX Core owns migration `029_experience_surface_recency.sql`. Visual
Experience Maps must be applied next as `030_visual_experience_maps.sql`; do not
rename or replace either migration on an existing database. Hosted upgrades
must run the normal privileged `prepare:hosted` job after migration 030. It
grants the curated Core runtime role access to the two new ordinary application
tables; the startup role-separation gate fails closed until those grants exist.

## MCP workflow

Agents use:

- `register_experience_route`
- `list_visual_experience_versions`
- `get_visual_experience_map`
- `compare_visual_experience`

Version discovery is bounded to 500 routes and 500 snapshot metadata rows per
project-scoped request. MCP never returns image bytes; `evidence_ref` is an
opaque reference for a later authenticated metadata/image request.

Outputs are structured and bounded. Each map includes an `agent_context` with
the purpose-tagged surface/route/version/device scope, sample sizes, explicit
section order, the five largest adjacent-section drop-offs, safe-label click
share, scroll reach, snapshot freshness/coverage, evidence references,
data-quality caveats and two deterministic next actions. Comparison adds
baseline/comparison sample sizes, count deltas, the five largest absolute
section percentage-point changes and exact map follow-ups for both cohorts.

The semantic summary is derived only from the returned aggregates. It never
generates a cause or returns DOM, page text, form values, image bytes or PII.
Every map and comparison repeats an explicit non-causal caveat; consent,
rate-guard, missing-label, missing-section and missing/stale-snapshot limits are
reported instead of silently treated as complete data. The exact same
project-scoped REST queries power MCP and the admin UI.

## `poolstatis.xyz` landing handoff

This repository does not own or deploy landing files. The landing task should:

1. Create/reuse surface `marketing` with purpose
   `Find which public-page sections lose qualified visitors before setup.`
2. Register routes:
   - `home` → `/`
   - `docs` → `/docs/*`
3. Add stable sections:
   - home: `hero`, `proof`, `workflow`, `sdk`, `mcp`, `self_host`, `final_cta`
   - docs: `docs_intro`, `install`, `instrument`, `query`, `next_steps`
4. Add stable click labels:
   - home: `hero.get_started`, `hero.open_docs`, `workflow.open_mcp`,
     `sdk.copy_install`, `final_cta.start`
   - docs: `docs.copy_install`, `docs.open_sdk`, `docs.open_mcp`,
     `docs.next_step`
5. Pass the deployed git SHA as `version`; never derive it from a URL.
6. After production deploy and consent, capture and upload four artifacts:
   `home/desktop`, `home/mobile`, `docs/desktop`, `docs/mobile`.
   Use 1440×900 and 390×844 viewports, wait for fonts/images, and capture the
   full page. Upload only after the live asset checksum matches the release.
7. Verify one consented page view, labelled click, scroll depth and section
   exposure through REST and MCP. Revoke consent and verify no later capture.

Landing acceptance evidence must include release SHA, snapshot ids, actual
viewport sizes, event read-back and MCP tool output. A successful page response
or a local screenshot alone is not proof.
