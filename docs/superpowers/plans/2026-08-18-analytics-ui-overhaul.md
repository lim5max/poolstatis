# Analytics UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Poolstatis customer analytics UI around a visible shared period, automatic answers, dominant charts, compact tables, pill controls, large rounded surfaces, readable type, and concise secondary evidence.

**Architecture:** Add one pure analytics-range module and one shared date-range control, then route every time-scoped screen through that contract. Apply visual rules through existing Tailwind v4 tokens and shadcn primitives, while simplifying screen composition without changing backend truth semantics. Protect the behavior with component tests first and a real-browser disposable-database E2E suite.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, shadcn/radix-ui, Recharts, Vitest/Testing Library, Playwright, Fastify, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-08-18-analytics-ui-overhaul.md`

**Execution status (2026-08-18):** Tasks 1–8 and Task 9 steps 1–3 are complete in the integration worktree. The remaining steps are fresh-origin integration, PR/merge, and the separate production release gate.

## Global Constraints

- Existing Geist/STIX Two Text/Geist Mono roles remain unchanged.
- Visible text is at least 15px; body and controls default to 16px.
- Buttons are full pills; controls are pills; containing cards use at least a 24px radius.
- `Today`, `Yesterday`, `7 days`, `30 days`, `90 days`, and `Custom` are available on every time-scoped analytics screen.
- Query windows are truthful half-open UTC intervals; no fabricated comparison delta is allowed.
- Safety, privacy, destructive-action, and server-owned evidence cannot be deleted; duplicated prose moves to one concise disclosure.
- `/i/v1/*`, SDK, MCP, database, auth, and hosted policy contracts remain compatible.
- No production deployment claim without immutable SHA, backup/rollback evidence, repeated live probes, and read-back.

---

### Task 1: Shared range contract and control

**Files:**
- Create: `web/src/analysis/ranges.ts`
- Create: `web/src/analysis/ranges.test.ts`
- Create: `web/src/analysis/useAnalyticsRange.ts`
- Create: `web/src/components/AnalyticsDateRange.tsx`
- Create: `web/src/components/AnalyticsDateRange.test.tsx`

**Interfaces:**
- Produces: `AnalyticsRangePreset`, `AnalyticsRangeSelection`, `ResolvedAnalyticsRange`, `resolveAnalyticsRange(selection, now, timeZone)`, `previousAnalyticsRange(range)`, `rangeSearchParams(selection)`, `rangeFromSearchParams(search)`.
- Produces: `<AnalyticsDateRange value onChange compare onCompareChange />` with accessible presets and custom date inputs.
- Consumers: Home, Web, Product, Funnels, People, Person, and browser E2E.

- [ ] **Step 1: Write failing pure range tests**

```ts
expect(resolveAnalyticsRange({ kind: 'preset', preset: 'today' }, new Date('2026-08-18T11:00:00Z'), 'UTC'))
  .toMatchObject({ from: '2026-08-18T00:00:00.000Z', to: '2026-08-18T11:00:00.000Z' });
expect(resolveAnalyticsRange({ kind: 'custom', from: '2026-08-01', to: '2026-08-03' }, now, 'UTC'))
  .toMatchObject({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z' });
```

- [ ] **Step 2: Run `pnpm --dir web test --run src/analysis/ranges.test.ts` and confirm missing-module failure**
- [ ] **Step 3: Implement the pure date helpers with invalid/reversed custom-range rejection**
- [ ] **Step 4: Run the range test and confirm it passes**
- [ ] **Step 5: Write a failing component test for Today, Custom, Apply, Cancel, and accessible labels**
- [ ] **Step 6: Run `pnpm --dir web test --run src/components/AnalyticsDateRange.test.tsx` and confirm the control is missing**
- [ ] **Step 7: Implement the shared segmented preset rail and popover/dialog custom calendar form using existing Button/Input primitives**
- [ ] **Step 8: Run both new test files and commit `Добавить единый период аналитики`**

### Task 2: Visual foundation

**Files:**
- Modify: `web/src/index.css`
- Modify: `web/src/components/ui/button.tsx`
- Modify: `web/src/components/ui/input.tsx`
- Modify: `web/src/components/ui/select.tsx`
- Modify: `web/src/components/ui/badge.tsx`
- Modify: `web/src/components/ui/card.tsx`
- Modify: `web/src/components/ui.tsx`
- Modify: `web/src/lightVisualSystem.test.ts`
- Modify: `web/src/components/ui.test.tsx`

**Interfaces:**
- Produces: pill controls, `--radius-control: 9999px`, `--radius-panel: 1.5rem`, `--text-xs: 0.9375rem`, `--text-sm: 1rem`, compact `KpiRail`, `DataDetails`, and a larger `PageHeading` action row.
- Consumers: every route.

- [ ] **Step 1: Change visual-system tests to require 15px minimum text, 16px controls, pill buttons, and 24px panels**
- [ ] **Step 2: Run `pnpm --dir web test --run src/lightVisualSystem.test.ts src/components/ui.test.tsx` and confirm current tokens/components fail**
- [ ] **Step 3: Update Tailwind tokens and shadcn primitives; retain 44px coarse-pointer targets and visible focus rings**
- [ ] **Step 4: Replace repeated Stat cards with one divided KPI rail and add one compact DataDetails disclosure primitive**
- [ ] **Step 5: Simplify sidebar footer/status copy and make navigation rows pill-shaped without changing route availability**
- [ ] **Step 6: Run visual-system/component/accessibility tests and commit `Обновить визуальную систему аналитики`**

### Task 3: Home answer-first dashboard

**Files:**
- Modify: `web/src/screens/Overview.tsx`
- Modify: `web/src/screens/Overview.test.tsx`

**Interfaces:**
- Consumes: `AnalyticsRangeSelection`, `AnalyticsDateRange`, `KpiRail`, current control-tower and query APIs.
- Produces: period-aware Home queries, one primary answer surface, compact attention rows, and URL-preserved range.

- [ ] **Step 1: Add failing tests that select Today/custom and assert Home query payloads use the resolved exact interval**
- [ ] **Step 2: Add a failing layout test that KPI/chart content precedes attention copy in document order**
- [ ] **Step 3: Run `pnpm --dir web test --run src/screens/Overview.test.tsx` and confirm both behaviors fail**
- [ ] **Step 4: Move the date control into PageHeading, replace hard-coded `-30d`, render KPI rail/chart first, and turn attention cards into rows**
- [ ] **Step 5: Remove duplicated observed/trust prose from the first viewport and keep it once in DataDetails**
- [ ] **Step 6: Run Overview and analytics component tests and commit `Сделать Home ответом, а не сводкой`**

### Task 4: Product and Funnels autorun

**Files:**
- Modify: `web/src/screens/ProductAnalytics.tsx`
- Modify: `web/src/screens/ProductAnalytics.ui.test.tsx`
- Modify: `web/src/screens/ProductAnalytics.test.ts`

**Interfaces:**
- Consumes: range contract and current template/query clients.
- Produces: automatic execution keyed by project/env/template/resource/range/breakdown, compact template segments, stable loading canvas, chart-first answer.

- [ ] **Step 1: Add a failing test proving a ready Product answer executes on mount and reruns after period/template changes without `Run answer`**
- [ ] **Step 2: Add a failing Funnel test proving the selected funnel loads automatically and the conversion graphic is above technical details**
- [ ] **Step 3: Run targeted Product tests and confirm manual-run expectations fail**
- [ ] **Step 4: Replace manual execute state with scope-keyed automatic effects that ignore stale responses**
- [ ] **Step 5: Convert template cards to a compact horizontal segmented control and keep disabled capabilities out of the primary rail**
- [ ] **Step 6: Put result/KPI/chart before save and evidence actions; keep manual typed query in advanced details only**
- [ ] **Step 7: Run Product tests and commit `Автоматизировать Product и Funnels`**

### Task 5: Web chart-first overview

**Files:**
- Modify: `web/src/screens/WebAnalytics.tsx`
- Modify: `web/src/screens/WebAnalytics.test.tsx`
- Modify: `web/src/live-screen-ux.test.tsx`

**Interfaces:**
- Consumes: range contract and current operational/trend APIs.
- Produces: automatic overview and breakdown, period-aware comparison, compact tabbed breakdown under a dominant chart.

- [ ] **Step 1: Add failing tests for Today/custom exact queries and automatic first breakdown loading**
- [ ] **Step 2: Add a failing test that no `Load traffic breakdown` action is required for the default tab**
- [ ] **Step 3: Run targeted Web tests and confirm failures**
- [ ] **Step 4: Resolve all overview/session/trend queries from the shared range and load the selected breakdown automatically**
- [ ] **Step 5: Collapse accounting/privacy/methodology into DataDetails and keep unavailable dimensions as concise tab empty states**
- [ ] **Step 6: Run Web/live-screen tests and commit `Упростить Web analytics`**

### Task 6: People and person workspace

**Files:**
- Modify: `web/src/screens/Users.tsx`
- Modify: `web/src/screens/Users.test.tsx`
- Modify: `web/src/screens/Person.tsx`
- Create: `web/src/screens/Person.test.tsx`

**Interfaces:**
- Consumes: range contract and actors/person APIs.
- Produces: compact toolbar, exact ranges, table without repeated order-evidence column, concise global ordering context, one DataDetails disclosure.

- [ ] **Step 1: Add failing tests for custom actor `from`/`to`, removal of the Order evidence header, and a single ordering context**
- [ ] **Step 2: Run Users tests and confirm the old table fails the new contract**
- [ ] **Step 3: Replace the five-column filter card with a wrapping toolbar and shared date control**
- [ ] **Step 4: Remove repeated evidence window/badge from each row; preserve activation metric evidence only when selected**
- [ ] **Step 5: Replace the large Data limits cards and long resolution footnote with one concise DataDetails disclosure**
- [ ] **Step 6: Apply the same date/readability rules to Person and run tests**
- [ ] **Step 7: Commit `Собрать People вокруг таблицы`**

### Task 7: System-wide secondary surfaces

**Files:**
- Modify: `web/src/screens/SavedAnswers.tsx`
- Modify: `web/src/screens/Measurement.tsx`
- Modify: `web/src/screens/Data.tsx`
- Modify: `web/src/screens/Experience.tsx`
- Modify: related existing test files

**Interfaces:**
- Consumes: global primitives and DataDetails.
- Produces: consistent pill actions, large rounded surfaces, readable labels, fewer repeated descriptions, table/list-first layouts.

- [ ] **Step 1: Add failing assertions in existing screen tests for concise primary copy and collapsed secondary evidence**
- [ ] **Step 2: Run affected tests and confirm failures are caused by current repeated/expanded copy**
- [ ] **Step 3: Replace one-off small labels and tight radii with shared primitives; remove repeated sentences already represented by headings/status**
- [ ] **Step 4: Keep privacy/destructive/server-truth messages next to their actions and move technical provenance into DataDetails**
- [ ] **Step 5: Run all Web tests and commit `Привести админку к единой системе`**

### Task 8: Real browser E2E and responsive QA

**Files:**
- Create: `e2e/analytics-ui.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `test/globalSetup.ts`, `test/helpers.ts`, real Fastify/Vite, disposable PostgreSQL environment variables.
- Produces: `pnpm test:e2e:analytics` and CI browser coverage for desktop/mobile analytics flows.

- [ ] **Step 1: Write the E2E suite before final UI fixes; seed a project, registry metrics, funnel, events, and a saved answer; exercise truthful empty/live contracts on Ship, Usage, and Setup**
- [ ] **Step 2: Run with disposable DB variables and confirm it catches at least one current visual/behavioral contract violation**
- [ ] **Step 3: Cover Home, Web, Product, Funnels, People, Saved, Ship, Usage, Setup at 1440x900 and 390x844**
- [ ] **Step 4: Assert visible Today/Custom, no Run answer, computed pill/24px radii, computed font size >=15px, no overflow, and no console/page errors**
- [ ] **Step 5: Fix every failing screen without weakening assertions**
- [ ] **Step 6: Run the E2E suite twice and commit `Добавить E2E редизайна аналитики`**

### Task 9: Full verification, integration, and deployment

**Files:**
- Modify only if verification exposes a real defect.

**Interfaces:**
- Produces: reviewed integration candidate based on freshly fetched `origin/main`, pushed PR, merged SHA, deployed immutable artifact, and live read-back.

- [ ] **Step 1: Start disposable PostgreSQL and run `pnpm typecheck`, `pnpm test`, `pnpm --dir web test --run`, `pnpm --dir web build`, `pnpm --dir sdk test`, SDK/MCP build/pack checks, analytics E2E, and self-host Compose config/build**
- [ ] **Step 2: Run desktop/mobile browser review for overflow, typography, interactions, charts, loading, empty/error states, and console errors**
- [ ] **Step 3: Review the full diff against this spec; verify every requirement with file/test/browser evidence**
- [ ] **Step 4: Fetch `origin`, rebase/merge semantically onto the exact current `origin/main`, run `git merge-tree`, and rerun full gates**
- [ ] **Step 5: Commit only relevant files with a short Russian commit message, push the named branch, and open a PR with the repository template**
- [ ] **Step 6: After required checks and review pass, merge through the PR and read back that `origin/main` contains the integrated SHA**
- [ ] **Step 7: Before deployment, verify production lineage, create and restore-test the required backup, compare protected counts, retain rollback, deploy atomically, and probe `/health`, authenticated app routes, desktop/mobile analytics, and ingest warnings repeatedly**

## Self-review

- Spec coverage: all explicit requirements map to Tasks 1–9.
- Placeholder scan: no implementation step delegates unspecified error handling or testing.
- Type consistency: every time-scoped consumer uses `AnalyticsRangeSelection` and `ResolvedAnalyticsRange`; the shared control owns custom calendar inputs but not query execution.
- Verification state: Docker-backed disposable-database gates, Web/SDK/MCP tests and builds, analytics E2E, self-host builds, and desktop/mobile browser review are green. Production release remains gated on the repository's deployment, backup, rollback, and live read-back procedure.
