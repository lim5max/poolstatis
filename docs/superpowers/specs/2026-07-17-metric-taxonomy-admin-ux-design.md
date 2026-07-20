# Metric taxonomy and admin UX design

Date: 2026-07-17
Status: approved design, awaiting written-spec review

## Outcome

Poolstatis must organize a large registry without turning every product feature into a category. A metric answers three independent questions:

1. `category` — why the metric exists;
2. structured `tags` — where and what it measures;
3. funnel membership — which journey it helps evaluate.

The same change also resolves the reviewed admin UX issues: serif branding, a quieter sidebar, a documentation link, an integrated entity-type selector, and clickable entity records with a real detail view.

## Taxonomy model

### Categories: the stable semantic axis

Categories are project-scoped objects with these fields:

- `key`: immutable lowercase snake-case identifier;
- `name`: display name;
- `description`: guidance explaining when an agent should use the category;
- `domain`: `product`, `business`, `technical`, or `custom`;
- `color`: validated `#RRGGBB` display color;
- `is_system`: distinguishes built-in semantics from project-created categories.

Each metric has zero or one category key. Existing metrics with no category remain valid and appear as `uncategorized`; the UI and agent guidance treat that state as work to reconcile. This preserves compatibility while making category selection the expected path for every new agent-authored metric.

The initial system library is deliberately broad but finite:

- product: `acquisition`, `activation`, `adoption`, `engagement`, `retention`, `referral`, `satisfaction`;
- business: `revenue`, `cost`, `efficiency`;
- technical: `quality`, `reliability`, `performance`, `delivery`, `security`, `data_quality`.

System categories are seeded into every existing project by a migration and into every new project during creation. Their keys and semantics are immutable. Project-created categories are full objects and may be created, edited, or deleted. Deletion returns `409` while any metric references the category.

The library is informed by Google HEART for user-centred outcomes, Google SRE's latency/traffic/errors/saturation model, DORA delivery performance, and FinOps unit economics. Those frameworks guide semantics; Poolstatis does not copy their metric lists into one flat taxonomy.

### Structured tags: the flexible feature axis

The existing multi-value `tags` field remains lightweight. Agents should prefer namespaced tags:

- `surface:bot`, `surface:mini_app`, `surface:web`;
- `feature:messaging`, `feature:skills`, `feature:navigation`;
- `channel:telegram`, `provider:openai`, `journey:onboarding`.

Tags stay strings rather than managed database objects. Existing plain tags such as `north-star` remain valid. Poolstatis documents the namespaced convention and exposes tags as a filter/grouping facet. This avoids a second CRUD registry while still supporting thousands of feature-level metrics.

Agents must not create a category merely because a new button, screen, skill, or bot command was added. A custom category is appropriate only when the metric's purpose cannot be expressed by the system library.

### Funnels: the journey axis

Funnels continue to reference registry metrics and carry a mandatory `goal`. A bot, mini-app, or skill journey is represented by a funnel, not by inventing a journey-specific category.

Example classification:

| Metric | Category | Tags |
| --- | --- | --- |
| `message_sent` | `engagement` | `surface:bot`, `feature:messaging` |
| `skill_enabled` | `activation` | `surface:bot`, `feature:skills` |
| `mini_app_button_clicked` | `engagement` | `surface:mini_app`, `feature:navigation` |
| `bot_response_failed` | `reliability` | `surface:bot`, `feature:messaging` |
| `response_latency` | `performance` | `surface:bot` |
| `llm_cost_per_answer` | `cost` | `surface:bot`, `provider:openai` |

## Storage and API

A migration adds `metric_categories` with a project-scoped unique key and seeds system rows. The existing `metrics.category` text column is retained and receives a composite foreign key to `(project_id, key)` after the seed is complete.

Platform API additions:

- `GET /api/v1/projects/:slug/metric-categories`;
- `POST /api/v1/projects/:slug/metric-categories`;
- `PATCH /api/v1/projects/:slug/metric-categories/:key`;
- `DELETE /api/v1/projects/:slug/metric-categories/:key`;
- `GET /api/v1/projects/:slug/entities/:entityType/:entityId?env=prod`.

MCP additions:

- `list_metric_categories`;
- `create_metric_category`;
- `update_metric_category`;
- `delete_metric_category`;
- `get_entity`.

Metric registration and updates validate that a non-null category exists in the same project. Schema resources include category definitions so an agent can choose before registering a metric.

The exact entity endpoint returns one entity by project, environment, type, and id. It does not guess that every account or organization id is also a person `distinct_id`.

## Admin UX

### Branding and navigation

- `.brand-wordmark` uses the same STIX serif family as headings on connect, desktop, mobile, and drawer surfaces.
- The `Headless analytics admin` subtitle is removed from desktop and mobile sidebars.
- System navigation gains `Documentation ↗` as an external link.
- The documentation URL comes from `VITE_POOLSTATIS_DOCS_URL`; the source-available GitHub docs are the self-host fallback until the public docs domain is configured.

### Registry categories

Registry gains a `Categories` tab. It groups objects by domain and shows name, key, description, color, origin, and metric usage count. Custom categories have edit/delete actions; system categories explain why they are locked. Category filters and chips are driven by API definitions rather than a hard-coded TypeScript union or CSS variable name.

### Entity browsing

- The entity-type selector moves into the `Entities` panel header instead of occupying a detached full-width toolbar.
- Every entity id is a link to `/data/entity/:entityType/:entityId`.
- The detail page shows the exact type/id, environment, update time, and a readable property table/JSON fallback.
- Event-stream actor links continue to use the existing person page; entity links never pretend a non-user entity is a person.

## Error handling and compatibility

- Duplicate category keys return `409 metric_category_taken`.
- Unknown metric categories return `400 unknown_metric_category` with guidance to list or create categories.
- System category modification/deletion returns `409 system_metric_category`.
- Category deletion while referenced returns `409 metric_category_in_use` with the referencing metric count.
- Existing category filters, API responses, and metrics remain readable after migration.
- Existing free-form tags remain valid; structured tags are a convention, not a breaking validation change.

## Verification

Implementation follows TDD. Backend tests cover migration seeding, new-project seeding, CRUD authorization/isolation, reference protection, metric validation, exact entity lookup, and MCP tools. Frontend verification covers category CRUD/filtering, custom colors, locked system categories, entity navigation, sidebar typography, subtitle removal, and the documentation link.

Required repository checks:

```bash
pnpm typecheck
pnpm test
pnpm --dir sdk test
pnpm --dir sdk build
pnpm --dir web build
```

Browser E2E runs against the local demo project at desktop and mobile widths and exercises all six reviewed UI points.

### Agent-hub acceptance loop

Use the existing read-only PostHog access for `/Users/maksimstil/Desktop/agent-hub` and sample representative bot, mini-app, skill, messaging, onboarding, payment, performance, error, and cost events/metrics. Produce a classification table and verify:

- each sampled metric has one understandable purpose category;
- feature/surface distinctions are expressible with one to three structured tags;
- funnels represent journeys without journey-specific categories;
- technical metrics fit reliability, performance, delivery, security, quality, data quality, cost, or a justified custom category;
- Registry grouping remains understandable without reading raw event names;
- ambiguous cases and any required new category are reported rather than silently forced.

The loop is complete only after API/MCP read-back and browser verification show the same category/tag semantics, an independent reviewer reports no unresolved Critical or Important findings, and the full test/build suite passes.

## Non-goals

- No arbitrary nested category tree.
- No managed tag CRUD system.
- No automatic category assignment without an explainable recommendation and explicit registry write.
- No attempt to turn the headless admin into a customer analytics dashboard.
