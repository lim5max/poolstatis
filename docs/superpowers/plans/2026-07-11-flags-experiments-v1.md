# Flags and Experiments v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic feature flags and measurable A/B experiments to Poolstatis through the SDK, REST API, MCP server and admin UI.

**Architecture:** Flag/experiment definitions are project metadata. SDK evaluation calls a write-safe ingest endpoint and appends a registered `$feature_flag_called` event through `EventStore`; experiment analysis extends that storage seam with one narrow post-exposure conversion query. The UI only manages and inspects these typed objects.

**Tech Stack:** TypeScript, Fastify, Zod, PostgreSQL, Vitest, React 19, shadcn/ui, Tailwind v4.

## Global Constraints

- Flag `purpose` and experiment `hypothesis` must be non-empty semantic sentences with a minimum length of 10.
- Flag percentages use stable SHA-256 bucketing, never `Math.random()`.
- v1 accepts stable `distinct_id` values and active `count`/`unique_actors` registry metrics only.
- System exposures are `$feature_flag_called` events appended through `EventStore` with `registered=true`.
- New platform metadata ships through REST, MCP and the headless admin UI in the same change.
- Do not add DOM capture, raw SQL, cohorts or an analytics dashboard in this feature.

---

### Task 1: Add validated metadata schemas and the migration

**Files:**
- Create: `migrations/009_flags_experiments.sql`
- Modify: `src/schemas.ts`
- Create: `test/flags-experiments.test.ts`

**Interfaces:**
- Produces `featureFlagSchema`, `createExperimentSchema`, `updateExperimentSchema`, and typed inputs consumed by services/routes.
- Produces `feature_flags` and `experiments` tables consumed by `FlagsService` and `ExperimentsService`.

- [ ] **Step 1: Write failing schema tests**

```ts
import { featureFlagSchema } from '../src/schemas.js';

it('rejects duplicate variants and allocation above 100 percent', () => {
  const result = featureFlagSchema.safeParse({
    key: 'checkout_copy', name: 'Checkout copy',
    purpose: 'Safely roll out a new checkout call to action.',
    variants: [
      { key: 'control', rollout_percentage: 60 },
      { key: 'control', rollout_percentage: 60 },
    ],
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test test/flags-experiments.test.ts`

Expected: FAIL because `featureFlagSchema` does not exist.

- [ ] **Step 3: Add migration and Zod contracts**

Implement the two tables and Zod schemas described in the design. Require a
unique snake-case key per variant, validate aggregate allocation in
`superRefine`, and make experiment metric references snake-case keys.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test test/flags-experiments.test.ts`

Expected: schema validation test passes.

- [ ] **Step 5: Commit the isolated schema slice**

```bash
git add migrations/009_flags_experiments.sql src/schemas.ts test/flags-experiments.test.ts
git commit -m "feat: add flags and experiments schema"
```

### Task 2: Implement flag lifecycle and deterministic evaluation

**Files:**
- Create: `src/services/flags.ts`
- Modify: `src/http/context.ts`
- Modify: `src/http/server.ts`
- Modify: `src/stores/eventStore.ts`
- Modify: `src/stores/postgresEventStore.ts`
- Modify: `src/stores/bufferedEventStore.ts`
- Modify: `test/flags-experiments.test.ts`

**Interfaces:**
- Consumes `CreateFeatureFlagInput`, `UpdateFeatureFlagInput`, project id and `EventStore`.
- Produces `createFeatureFlag`, `listFeatureFlags`, `updateFeatureFlag`, `archiveFeatureFlag`, and `evaluateFeatureFlag`.
- Produces `POST /i/v1/flags/evaluate` returning `{ key, variant: { key, payload } | null }`.

- [ ] **Step 1: Write failing lifecycle/evaluation tests**

```ts
it('returns the same allocated variant for an actor and records registered exposures', async () => {
  await createActiveFlag('checkout_copy', [
    { key: 'control', rollout_percentage: 50 },
    { key: 'test', rollout_percentage: 50, payload: { label: 'Pay now' } },
  ]);
  const first = await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate',
    { key: 'checkout_copy', distinct_id: 'actor-42' });
  const second = await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate',
    { key: 'checkout_copy', distinct_id: 'actor-42' });
  expect(second.body.variant).toEqual(first.body.variant);
  const events = await api(env, env.secretToken, 'GET', `${P()}/events/sample?limit=10`);
  expect(events.body.events.filter((e: any) => e.event === '$feature_flag_called')).toHaveLength(2);
  expect(events.body.events.every((e: any) => e.registered)).toBe(true);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm test test/flags-experiments.test.ts`

Expected: FAIL because `createActiveFlag` and the endpoints do not exist.

- [ ] **Step 3: Implement service, routes and append seam**

Use `crypto.createHash('sha256')` over `${salt}:${distinctId}`, take the first
8 hex characters modulo 10,000, and compare to cumulative allocation times
100. Append the system event through `EventStore.append`, never raw SQL. Give
secret/personal tokens metadata routes and only ingest keys the evaluation
route. Reject archiving a flag referenced by a running experiment.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm test test/flags-experiments.test.ts`

Expected: lifecycle, auth, allocation and exposure tests pass.

- [ ] **Step 5: Commit the flag vertical**

```bash
git add src/services/flags.ts src/http/context.ts src/http/server.ts src/stores/eventStore.ts src/stores/postgresEventStore.ts src/stores/bufferedEventStore.ts test/flags-experiments.test.ts
git commit -m "feat: add deterministic feature flags"
```

### Task 3: Add experiment lifecycle and results through EventStore

**Files:**
- Create: `src/services/experiments.ts`
- Create: `src/services/experimentStats.ts`
- Modify: `src/http/context.ts`
- Modify: `src/http/server.ts`
- Modify: `src/stores/eventStore.ts`
- Modify: `src/stores/postgresEventStore.ts`
- Modify: `src/stores/bufferedEventStore.ts`
- Modify: `test/flags-experiments.test.ts`

**Interfaces:**
- Consumes `ExperimentResultsQuery { projectId, env, flagKey, metricEvent, metricFilters, from, to }`.
- Produces `EventStore.experimentResults()` returning `Array<{ variant: string; exposed: number; converted: number }>`.
- Produces experiment start/conclude/results REST operations.

- [ ] **Step 1: Write failing experiment tests**

```ts
it('counts only outcomes after each actor first saw the running experiment', async () => {
  await activeMetric(env, { key: 'checkout_completed', source: { event: 'checkout.completed' } });
  await createRunningExperiment('checkout_copy_test', 'checkout_copy', 'checkout_completed');
  await ingest('checkout.completed', 'before-exposure');
  await evaluate('checkout_copy', 'before-exposure');
  await evaluate('checkout_copy', 'converted-after-exposure');
  await ingest('checkout.completed', 'converted-after-exposure');
  const result = await api(env, env.secretToken, 'GET', `${P()}/experiments/checkout_copy_test/results?env=prod`);
  expect(result.body.variants.reduce((n: number, v: any) => n + v.converted, 0)).toBe(1);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm test test/flags-experiments.test.ts`

Expected: FAIL because experiment operations/results do not exist.

- [ ] **Step 3: Implement lifecycle, store query and Bayesian stats**

On start, ensure the flag is active and allocations total exactly 100 and each
referenced metric is active/type `count` or `unique_actors`. Implement a
parameterized exposure/outcome CTE in `PostgresEventStore`. Compute per-variant
Beta(1+converted, 1+exposed-converted) credible intervals and chance-to-win
with a seeded 10,000-draw gamma sampler in `experimentStats.ts`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm test test/flags-experiments.test.ts`

Expected: lifecycle guards, environment scope, post-exposure timing and stable
statistics tests pass.

- [ ] **Step 5: Commit the experiment vertical**

```bash
git add src/services/experiments.ts src/services/experimentStats.ts src/http/context.ts src/http/server.ts src/stores/eventStore.ts src/stores/postgresEventStore.ts src/stores/bufferedEventStore.ts test/flags-experiments.test.ts
git commit -m "feat: measure feature flag experiments"
```

### Task 4: Expose flags and experiments to agents and the SDK

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/standard.ts`
- Modify: `src/cli/mcpSmoke.ts`
- Modify: `sdk/src/index.ts`
- Modify: `sdk/test/client.test.ts`
- Modify: `sdk/README.md`

**Interfaces:**
- Produces SDK methods `getFeatureFlag(key, distinctId, options?)` and `getFeatureFlags(distinctId, options?)`.
- Produces MCP tools `create_feature_flag`, `list_feature_flags`, `update_feature_flag`, `archive_feature_flag`, `evaluate_feature_flag`, `create_experiment`, `list_experiments`, `start_experiment`, `conclude_experiment`, and `get_experiment_results`.

- [ ] **Step 1: Write failing SDK and MCP smoke assertions**

```ts
it('caches a flag evaluation for the same actor and key', async () => {
  const { fn, calls } = fakeFetch();
  const client = createClient({ url: 'http://x', ingestKey: 'pk_test', fetch: fn });
  await client.getFeatureFlag('checkout_copy', 'u1');
  await client.getFeatureFlag('checkout_copy', 'u1');
  expect(calls.filter((c) => c.path === '/i/v1/flags/evaluate')).toHaveLength(1);
});
```

- [ ] **Step 2: Run focused SDK/MCP tests and verify RED**

Run: `pnpm --dir sdk test && pnpm mcp:smoke`

Expected: SDK test fails because the method is absent; adapt the smoke command
to assert new tool registration without requiring a hosted token.

- [ ] **Step 3: Implement SDK, tools and agent documentation**

Add only transport-level mocking in SDK tests. MCP evaluation calls the service
with `emitExposure: false`, avoiding a read-side mutation. Update the standard
with the explicit stable-identity and exposure semantics.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --dir sdk test && pnpm mcp:smoke`

Expected: SDK unit tests and local MCP registration smoke pass.

- [ ] **Step 5: Commit the agent-facing integration**

```bash
git add src/mcp/server.ts src/mcp/standard.ts src/cli/mcpSmoke.ts sdk/src/index.ts sdk/test/client.test.ts sdk/README.md
git commit -m "feat: expose flags to sdk and mcp"
```

### Task 5: Add headless admin management and browser E2E

**Files:**
- Create: `web/src/screens/Experiments.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Create: `web/e2e/experiments.spec.ts`
- Create: `web/playwright.config.ts`

**Interfaces:**
- Consumes the typed flag and experiment REST endpoints.
- Produces `/experiments` admin route with flag/experiment management and
  results inspection.
- Produces an end-to-end test that creates a flag, starts an experiment and
  reads its result view through a live local server.

- [ ] **Step 1: Write the failing browser E2E**

```ts
test('creates an active flag and a running experiment', async ({ page }) => {
  await page.goto('/experiments');
  await page.getByRole('button', { name: 'New flag' }).click();
  await page.getByLabel('Key').fill('checkout_copy');
  await page.getByRole('button', { name: 'Create flag' }).click();
  await expect(page.getByText('checkout_copy')).toBeVisible();
});
```

- [ ] **Step 2: Run E2E and verify RED**

Run: `pnpm --dir web exec playwright test e2e/experiments.spec.ts`

Expected: FAIL because the route and controls do not exist.

- [ ] **Step 3: Implement API client, UI and E2E runtime script**

Install `@playwright/test` as a web dev dependency and include the matching
lockfile update. Use `Panel`, `Toolbar`, `Confirm`, `Hint` and scale-only Tailwind classes from
`web/src/components/ui.tsx`. Preserve the headless-admin positioning: tables
and forms only, no synthetic charts. Configure Playwright to start backend and
Vite; seed the test project through the existing REST endpoint before the
browser opens it.

- [ ] **Step 4: Run E2E and verify GREEN**

Run: `pnpm --dir web exec playwright test e2e/experiments.spec.ts`

Expected: one browser test passes against the real API and database.

- [ ] **Step 5: Commit the admin vertical**

```bash
git add web/src/screens/Experiments.tsx web/src/App.tsx web/src/api/client.ts web/src/api/types.ts web/package.json web/pnpm-lock.yaml web/e2e/experiments.spec.ts web/playwright.config.ts
git commit -m "feat: manage experiments in admin"
```

### Task 6: Document and verify the complete release

**Files:**
- Modify: `docs/03-mcp-server.md`
- Modify: `docs/04-http-api.md`
- Modify: `docs/05-gap-analysis.md`
- Modify: `docs/06-instrumenting-a-product.md`
- Modify: `README.md`
- Modify: `web/src/screens/Setup.tsx`

**Interfaces:**
- Documents every REST/MCP/SDK method and the next Browser Experience/Replay
  module boundary.

- [ ] **Step 1: Write the missing documentation acceptance snippets**

```ts
expect(readFileSync('docs/04-http-api.md', 'utf8')).toContain('/i/v1/flags/evaluate');
expect(readFileSync('docs/03-mcp-server.md', 'utf8')).toContain('get_experiment_results');
```

- [ ] **Step 2: Run the documentation assertion and verify RED**

Run: `pnpm test test/flags-experiments.test.ts`

Expected: FAIL until documentation is updated.

- [ ] **Step 3: Update docs and Setup tool inventory**

Show a complete SDK usage example with a stable user id and explain that
evaluation records exposure. Update the gap analysis to rank completed Flags +
Experiments and to keep Browser Experience/Replay as separate, privacy-gated
modules.

- [ ] **Step 4: Run full verification**

Run: `pnpm typecheck && pnpm test && pnpm --dir sdk test && pnpm --dir web build && pnpm --dir web exec playwright test e2e/experiments.spec.ts`

Expected: exit 0 for all type, unit, API, SDK, web-build and browser-E2E checks.

- [ ] **Step 5: Request code review, fix findings, then commit**

Dispatch a read-only reviewer over the feature branch versus the base SHA.
Fix all Critical and Important findings, repeat the full verification, then:

```bash
git add docs README.md web/src/screens/Setup.tsx
git commit -m "docs: document flags and experiments"
```
