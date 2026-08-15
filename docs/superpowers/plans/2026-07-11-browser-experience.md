# Browser Experience Implementation Plan

> **Historical implementation plan — not the current runtime contract.** The
> shipped observer starts immediately when the host calls `start()`; legacy
> `hasConsent` callbacks remain only as an optional host-owned pause control.
> Use the current [SDK guide](../../../sdk/README.md) and
> [Browser Analytics docs](../../13-browser-analytics.md) for product truth.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an optional privacy-safe browser interaction module with session timelines and click heatmaps.

**Architecture:** Surface metadata supplies the required purpose and gates ingest. A dedicated typed ingest route converts whitelisted interaction payloads to immutable events. Two Query DSL branches aggregate only those events. The optional SDK subpath owns browser observation and sends typed batches.

**Tech Stack:** TypeScript, Fastify, Postgres EventStore, Zod, Vitest, React 19, SDK with DOM lib.

## Global Constraints

- No DOM snapshots, text values, CSS selectors, URLs/paths, error messages/stacks, or pointer paths.
- Capture requires a `hasConsent` callback and only works for active surfaces.
- Every new query branch follows schema → QueryService → EventStore → MCP → admin → test.
- All manual edits use `apply_patch`; run typecheck, backend tests, SDK tests and web build before handoff.

---

### Task 1: Surface registry and typed experience ingest

**Files:**
- Create: `migrations/011_experience_surfaces.sql`, `src/services/experience.ts`, `test/experience.test.ts`
- Modify: `src/schemas.ts`, `src/http/server.ts`, `src/stores/eventStore.ts`, `src/stores/postgresEventStore.ts`, `src/stores/bufferedEventStore.ts`

**Interfaces:**
- Produces `createExperienceSurface`, `listExperienceSurfaces`, `archiveExperienceSurface`, `captureExperienceEvents`.
- Produces `POST /i/v1/experience/events` and Platform surface CRUD.

- [ ] Write failing integration tests for surface lifecycle and rejected/whitelisted capture.
- [ ] Run `pnpm vitest run test/experience.test.ts` and verify the missing-route failure.
- [ ] Add schema, migration, services and routes; store only normalized events/properties.
- [ ] Re-run focused test and commit `feat: add browser experience ingest`.

### Task 2: Interaction-map and session-timeline Query DSL

**Files:**
- Modify: `src/schemas.ts`, `src/services/query.ts`, `src/stores/eventStore.ts`, `src/stores/postgresEventStore.ts`, `src/stores/bufferedEventStore.ts`, `src/mcp/server.ts`, `test/experience.test.ts`

**Interfaces:**
- Produces query kinds `interaction_map` and `experience_session`.
- Produces MCP tools `query_interaction_map` and `get_experience_session`.

- [ ] Write failing map-bin and timeline-ordering tests.
- [ ] Run the focused test and verify it fails because the query kinds are absent.
- [ ] Add the narrow schemas, store methods, service cases and MCP tools.
- [ ] Re-run focused test and commit `feat: query browser experience signals`.

### Task 3: Optional browser SDK module

**Files:**
- Create: `sdk/src/experience.ts`, `sdk/test/experience.test.ts`
- Modify: `sdk/package.json`, `sdk/README.md`

**Interfaces:**
- Exports `BrowserExperience` and `BrowserExperienceOptions` from `@poolstatis/sdk/experience`.
- Calls `POST /i/v1/experience/events` with an opaque session id.

- [ ] Write failing SDK tests for consent, labelled click capture, route-key isolation, scroll milestones and teardown.
- [ ] Run `pnpm --dir sdk vitest run test/experience.test.ts` and verify the missing module failure.
- [ ] Implement browser-only module without importing it from the core SDK entrypoint.
- [ ] Re-run SDK tests and commit `feat: add browser experience sdk module`.

### Task 4: Admin, docs and end-to-end verification

**Files:**
- Create: `web/src/screens/Experience.tsx`, `test/mcp-experience.test.ts`
- Modify: `web/src/App.tsx`, `web/src/api/client.ts`, `web/src/api/types.ts`, `docs/03-mcp-server.md`, `docs/04-http-api.md`, `docs/05-gap-analysis.md`

**Interfaces:**
- Admin can create/archive a surface and query a map/session.
- MCP stdio test creates a surface, captures events and reads the map/timeline.

- [ ] Write failing MCP integration test and run it.
- [ ] Add typed client/admin/docs and verify no fake data is presented.
- [ ] Run `pnpm typecheck && pnpm test && pnpm --dir sdk typecheck && pnpm --dir sdk test && pnpm --dir web build`.
- [ ] Request code review, resolve findings, then commit `feat: ship browser experience module`.
