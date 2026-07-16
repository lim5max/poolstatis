# Browser Experience Consumer E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the optional Browser Experience SDK works from a real consumer through ingest, Postgres, REST, MCP, and admin UI using Basic Project, without misrepresenting interaction maps as gaze or full DOM replay.

**Architecture:** Keep `@poolstatis/sdk/experience` as an optional entrypoint. Wire it into Basic Project with explicit test consent, stable route/surface/actor ids, and developer-labelled controls. Use the landing only after a real consent control exists; never silently enable browser capture for public visitors.

**Tech Stack:** React 19, Vite, local `@poolstatis/sdk`, Poolstatis REST/MCP, in-app browser E2E.

## Global Constraints

- Capture only labelled clicks, normalized coordinates, scroll milestones, page views, and coarse error types.
- Never capture DOM, text/input values, CSS selectors, raw URLs, query strings, stacks, or error messages.
- Full session replay is out of scope and must be reported as not implemented.
- Preserve existing uncommitted work in Basic Project and `poolstatis-site`.
- No git commit or push unless the user explicitly requests it.

---

### Task 1: Make the SDK consumable from the current repo path

**Files:**
- Modify: `sdk/package.json`
- Modify: `/Users/maksimstil/Documents/Basic Project/package.json`
- Modify: `/Users/maksimstil/Documents/Basic Project/package-lock.json`

**Interfaces:**
- Produces: resolvable imports for `@poolstatis/sdk` and `@poolstatis/sdk/experience`.

- [ ] **Step 1: Preserve the observed RED evidence**

Run: `npm test && npm run build` in Basic Project.

Expected current failure: `ERR_MODULE_NOT_FOUND` / unresolved `@poolstatis/sdk` because the dependency points at the obsolete `Desktop/poolsatis/sdk` path and the built package lacks `dist/experience.*`.

- [ ] **Step 2: Correct the local dependency and package build lifecycle**

Point Basic Project at `file:../../Desktop/poolstatis/sdk`, build the SDK, refresh the lockfile, and add a package lifecycle hook that produces both exported entrypoints before packing.

- [ ] **Step 3: Verify package resolution GREEN**

Run: `pnpm --dir sdk build && npm install && npm test && npm run build`.

Expected: core and experience entrypoints resolve and the consumer tests/build pass.

### Task 2: Wire Browser Experience into Basic Project

**Files:**
- Modify: `/Users/maksimstil/Documents/Basic Project/src/analytics.js`
- Modify: `/Users/maksimstil/Documents/Basic Project/src/analytics.test.js`
- Modify: `/Users/maksimstil/Documents/Basic Project/src/App.jsx`
- Modify: `/Users/maksimstil/Documents/Basic Project/.env.local`

**Interfaces:**
- Produces: surface `briefdesk_workspace`, route `workspace`, actor `briefdesk-demo-mira`, and stable labels for meaningful controls.

- [ ] **Step 1: Write failing consent/config tests**

```js
test('enables Browser Experience only after explicit demo consent', () => {
  assert.equal(hasExperienceConsent({ VITE_POOLSTATIS_EXPERIENCE_CONSENT: 'true' }), true)
  assert.equal(hasExperienceConsent({}), false)
})
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test`.

Expected: FAIL because the consent helper and Experience factory do not exist.

- [ ] **Step 3: Implement optional observer lifecycle**

Create one observer from the existing client, start it in the app effect, stop and flush it during cleanup, and leave it a no-op when endpoint/key/consent are absent.

- [ ] **Step 4: Label only meaningful controls**

Add `data-poolstatis-label` to create brief, high-priority filter, compact toggle, draft updates, send note, brief select, checklist, and status controls. Do not label raw decorative containers.

- [ ] **Step 5: Verify unit/build GREEN**

Run: `npm test && npm run build`.

### Task 3: End-to-end read-back through REST, MCP, and admin

**Files:**
- No production file required; store only non-secret evidence in the final report.

**Interfaces:**
- Consumes: Basic Project UI and Poolstatis local API/MCP/admin.
- Produces: matching click-map cells/labels and a known session timeline.

- [ ] **Step 1: Ensure the purpose-tagged surface exists**

Create `briefdesk_workspace` through Poolstatis Platform API/MCP with purpose: `Find interaction friction in the BriefDesk workspace workflow.`

- [ ] **Step 2: Run real browser interactions**

Open Basic Project, click labelled controls at desktop and mobile widths, cross scroll milestones, and confirm the browser console has no errors.

- [ ] **Step 3: Read back via API and MCP**

Use `query_interaction_map` and `get_experience_session`; independently compare them with REST query results and sampled trusted `event_source='experience'` data.

- [ ] **Step 4: Verify admin UI**

Open Browser Experience, select the surface, verify label counts/cells, open the captured session timeline, and confirm no DOM/text/raw URL leaked.

- [ ] **Step 5: Decide whether to instrument the public landing**

Only proceed if a visible opt-in/withdrawal flow is added. Otherwise report the landing as intentionally not wired rather than using implicit consent.
