# Magic agent onboarding and intent-first experiments

**Status:** implementation contract  
**Date:** 2026-08-01  
**Repository:** Poolstatis Core  
**Target release:** backwards-compatible Core/admin update

## 1. Problem

Poolstatis already has the hard parts required for trustworthy agent-native analytics: a purpose-backed registry, typed queries, MCP, proof-gated onboarding, immutable events, stable feature-flag assignment, exposure-based experiment results, and human-approved activation. The current admin, however, exposes those primitives as a sequence of setup concepts and forms.

A new user still has to translate a product question into all of these separate tasks:

1. choose and configure an MCP client;
2. install three skills;
3. understand tokens and project scope;
4. register and activate metrics;
5. instrument a real product path;
6. verify accepted observations and warnings;
7. run a first typed query;
8. save a decision;
9. separately understand whether they need a flag, an experiment, or a payload.

This feels like configuring analytics infrastructure. The desired experience is closer to an AI builder: the owner states what they want to learn or change, gives the request to their existing coding agent, reviews a small plan, and sees server evidence that the loop works.

## 2. Product promise

> Tell your coding agent what you want to learn. Poolstatis guides it from repository scan to one verified answer, while the owner retains control over metric activation and traffic changes.

“Magic” means hiding avoidable translation work. It does not mean inventing metrics, claiming that copied configuration proves connectivity, auto-activating proposed definitions, sending synthetic production events, or starting traffic allocation without explicit approval.

## 3. Users and jobs

### Product builder adding analytics

- “Show me where users drop before the value moment.”
- “Tell me whether activation improved after this release.”
- “Add privacy-safe web analytics to this site.”

They want one agent request, a small diff, and a verified first answer. They do not want to learn the registry or Query DSL before seeing value.

### Builder shipping a controlled change

- “Roll this feature out safely.”
- “Compare control and treatment on activation.”
- “Change a remote payload without running an A/B test.”

They need the system to select the right primitive, show readiness blockers, and keep traffic-changing actions explicit.

### Operator maintaining evidence quality

- “What is blocking a trustworthy answer?”
- “Which definitions or events drifted?”

They need the full underlying state, but it should remain behind progressive disclosure rather than dominate the first-run experience.

## 4. Current verified foundation

The release builds on existing contracts rather than replacing them:

- `get_onboarding_status` records an MCP-marked request and returns eight evidence gates;
- a copied MCP config is explicitly not treated as connection proof;
- agent-created metrics and property definitions remain proposed until review;
- all query branches continue to reference registered metric keys;
- flags retain `draft`, `active`, and `archived` lifecycle semantics;
- experiments retain `draft`, `running`, and `concluded` lifecycle semantics;
- experiment outcomes remain post-exposure and require a stable actor identifier;
- `/i/v1/*`, existing SDK payloads, project IDs, keys, registry rows, experiments, and historical observations remain unchanged.

## 5. Scope

### 5.1 One request as the primary setup path

Replace the four-step setup page’s primary hierarchy with an intent-first composer:

1. choose a job:
   - understand activation;
   - find funnel drop-off;
   - add web analytics;
   - measure a release;
2. optionally describe the product-specific outcome in one short field;
3. choose the existing coding agent;
4. copy one complete agent request.

The generated request must include the selected project and environment and instruct the agent to:

- inspect the product repository before proposing metrics;
- use the installed Poolstatis instrumentation workflow and live MCP standard/schema;
- reuse existing definitions where possible;
- propose the smallest purpose-backed plan before editing;
- keep new definitions proposed until owner approval;
- implement one shared capture path with only a `pk_` runtime key;
- exercise a real path and verify accepted evidence, warnings, a typed query, and the next onboarding blocker;
- report exact files, grain, identity strategy, evidence, and remaining approvals.

The prompt must never contain a saved secret or claim that it installed, connected, or verified anything.

### 5.2 One visible next action

The server remains the source of truth for progress. The setup page should show:

- a compact completion count;
- the first incomplete gate as the single primary next action;
- concise evidence for completed gates;
- the full eight-gate detail only when expanded.

The UI may translate server gate keys into plain language, but it must not alter completion semantics.

### 5.3 Connection and skills as prerequisites, not the journey

Keep all existing MCP client templates, pinned package behavior, token explanations, manual config, install commands, verification command, HTTP examples, standard, tool reference, webhooks, and deletion controls.

Change their hierarchy:

- show a compact “Agent connection” prerequisite card near the intent composer;
- expose one copyable skills install command for the selected agent;
- keep detailed client steps, raw config, token roles, HTTP, tools, webhooks, standard, and deletion inside explicit detail/advanced sections;
- preserve the local-runner fallback whenever the published-package contract is not verified by deployment configuration.

No browser code may read or embed the current admin session token in generated MCP configuration.

### 5.4 Intent-first feature delivery

Replace “create feature flag” versus “create experiment” as the first decision with three job choices:

1. **Safe rollout** — a flag that can move traffic gradually;
2. **A/B experiment** — a flag plus a measured hypothesis;
3. **Remote config** — a flag whose payload changes product behavior without an experiment.

Existing low-level flag and experiment APIs remain supported. The intent-first flow uses additive high-level operations so a partially failed wizard cannot leave an orphan flag or an experiment with a mutable historical definition:

- `prepare_experiment` creates a dedicated environment-scoped draft flag and draft experiment in one transaction;
- `check_experiment_readiness` explains blockers without mutating traffic;
- `launch_experiment` atomically activates the draft flag, freezes the analysis definition, and starts the observation window;
- `apply_experiment_decision` atomically records the conclusion and, only when explicitly requested, moves delivery to one named variant.

The old create/start/conclude endpoints and MCP tools remain available for compatibility. The UI must not label a recorded `ship` outcome as a deployed winner unless the rollout mutation also succeeded.

For every job, the UI explains only:

- what changes in product traffic;
- what evidence will be recorded;
- what the owner must do next.

Technical definitions such as stable assignment, exposure events, allocation totals, and metric eligibility remain visible at the point where they affect readiness.

### 5.5 Readiness before mutation

Before the owner starts an experiment, the UI must show an explicit readiness checklist computed from current server data:

- selected flag is active;
- allocation totals exactly 100%;
- control and treatment variants exist;
- primary metric is active and eligible;
- guarded product code and stable actor identity still require operator confirmation.

The safe launch path additionally rejects a one-variant experiment, more than one running experiment on the same flag, a primary metric repeated as a secondary metric, and an environment mismatch. These stricter rules apply to the new high-level operation; legacy low-level calls retain their existing request contract.

The final confirmation must state that starting freezes the observation window and begins post-exposure measurement. Existing server validation remains authoritative.

### 5.6 Decision-first results

Experiment rows become task cards grouped by lifecycle/attention. A result view leads with:

- current evidence state: no exposure, collecting, or ready to review;
- exposed and converted actors per variant;
- conversion rate, uplift, interval, and probability-best with their existing semantics;
- one explicit owner action: keep collecting or conclude as ship, iterate, stop, or inconclusive.

The UI must not invent a winner threshold or make a causal recommendation that the server did not compute. Conclusion remains an explicit owner action with rationale. “Record decision” changes experiment state only. “Ship variant” names the exact variant and states that it changes the live flag allocation to 100% in the experiment environment.

### 5.7 Frozen experiment interpretation

At launch, persist an immutable analysis snapshot containing:

- environment;
- flag variant keys, payloads, allocation, and explicit control key;
- primary metric key, name, purpose, type, source, and filters;
- secondary metric definitions;
- snapshot origin and capture time.

Results must query and render from this snapshot even after the live flag is archived or its rollout changes and even after a metric is edited or deprecated. Existing started experiments are backfilled from their current referenced definitions during migration and marked `backfilled_current`; newly launched experiments are marked `frozen_at_start`. Draft or otherwise unresolved legacy rows remain `legacy_unfrozen`. All remain readable. The API exposes integrity metadata so clients never mistake a best-effort legacy freeze for original-at-start evidence.

### 5.8 Environment scope

New intent-first flags and experiments are explicitly scoped to the selected environment. Evaluation of a scoped flag from another environment returns no variant and emits no exposure. Existing flags with a null environment retain their historical project-wide behavior in every environment. Keys remain project-unique in this release; environment scope does not create duplicate key namespaces.

## 6. Information architecture and copy rules

- Keep the existing top-level navigation in this release; broad navigation redesign is a separate change.
- Rename the setup page’s visible task framing from configuration to “Add analytics with your agent”; the stable `/setup` route remains unchanged.
- Keep the stable `/experiments` route and API names unchanged.
- Default pages show the job, current state, and next action. Reference material is secondary.
- Use short sentences and user outcomes. API names, keys, event names, and exact status values remain available in monospace detail.
- Never say “connected” when evidence only proves a last MCP-marked request.
- Never render `0` where evidence is unavailable.

## 7. Compatibility and data safety

This implementation uses one additive, backwards-compatible migration to freeze experiment interpretation and scope new high-level workflows.

- New columns are nullable or backfilled from current references; no existing row is deleted or re-keyed.
- Existing flags retain null environment, which means legacy all-environment behavior.
- Existing experiments receive a best-effort `legacy_snapshot` before future edits can change their interpretation.
- No event, key, metric, funnel, query, decision, project, or credential row is rewritten. Existing started experiment rows receive only additive snapshot metadata derived from their current referenced flag and metrics.
- Existing REST and MCP request/response shapes remain unchanged.
- New response fields and new endpoints/tools are additive.
- Existing SDK and `/i/v1/*` fixtures must pass unchanged.
- Archived flags and concluded experiment history remain readable.
- Existing direct creation workflows remain available through the same APIs and MCP tools.
- The release must not turn package availability on unless the exact pinned MCP package is registry-verified.

## 8. Product telemetry and success criteria

Do not add client-side telemetry that includes raw prompts, source code, URLs, DOM, text, tokens, or credential values.

Use existing server evidence to evaluate the first release:

- median time from project creation to `agent_connected`;
- median time to `first_event_observed`;
- median time to `first_query_produced`;
- share of projects reaching `first_decision_saved`;
- setup gate most frequently blocking completion;
- experiment drafts that reach running;
- running experiments that receive a conclusion.

Target hypotheses:

1. A single job-based request reduces visible setup decisions without reducing proof completeness.
2. One server-backed next action reduces stalled setup sessions.
3. Intent selection reduces confusion between flags, experiments, and remote config.
4. Readiness checks reduce failed experiment starts without weakening server enforcement.

## 9. Acceptance criteria

### Setup

- A user can select one analytics job and copy one project/environment-scoped request.
- Changing the coding agent changes the matching config and skill-install instructions.
- Generated text contains no token or session credential.
- The first incomplete server gate is the only primary progress action.
- All eight gates remain inspectable with unchanged completion values.
- Pinned public MCP and local-runner fallback behavior remain covered by tests.
- Existing advanced HTTP, webhooks, standard, tool list, and deletion controls remain reachable.

### Feature delivery

- The first creation choice is safe rollout, A/B experiment, or remote config.
- A safe rollout or remote config can create a draft flag through the existing API.
- An A/B flow atomically prepares a dedicated draft flag and experiment.
- Starting an experiment shows readiness and explicit confirmation, then atomically activates and freezes it.
- Existing draft/active/archive and draft/running/concluded mutations still work.
- Mutating a concluded flag or metric cannot change its frozen experiment result.
- A recorded ship decision never claims that delivery changed; shipping a variant requires and applies an explicit named rollout action.
- New scoped flags emit no exposure outside their environment; legacy null-scoped flags preserve all-environment behavior.
- Result evidence retains exact server values and unknown/unavailable states.
- Mobile layouts avoid clipped controls and horizontal page overflow.

### Engineering gates

- Targeted UI tests cover generated prompts, proof translation, intent routing, readiness, confirmation, and exact decision copy.
- Backend tests cover atomic prepare/launch/decision rollback, frozen results, legacy snapshot backfill, environment isolation, concurrent launch, and high-level readiness guards.
- `pnpm typecheck` passes.
- `pnpm test` passes against disposable/local Postgres only.
- `pnpm --dir web build` passes.
- `pnpm --dir sdk test` passes unchanged.
- `docker compose -f docker-compose.selfhost.yml config` passes.
- Browser acceptance covers desktop and mobile setup/experiment paths with no failed assets or console errors caused by the change.

## 10. Release and rollback

1. Integrate from a clean branch based on current `origin/main`; preserve unrelated dirty worktrees.
2. Review the diff specifically for migrations, `/i/v1/*`, SDK, auth, key handling, and production configuration changes.
3. Build and verify one immutable Core image from the final merged main SHA.
4. Record current production SHA/image digests, service health, schema history, warning watermark, project counts, and artifact storage state.
5. Produce an encrypted off-host pre-release database/artifact backup, read it back, and prove restore plus candidate migration in an isolated environment using the same Postgres major version before production mutation.
6. Deploy through the private Cloud release mechanism with the exact Core image digest; do not deploy by an unrecorded moving checkout.
7. Verify all runtime services, `/health`, `/ready`, hosted auth/admin, MCP initialize/tools/read, existing project visibility, accepted ingest/readback, and unchanged warning watermark.
8. Browser-smoke the setup and experiments screens against an existing project and a disposable test project.

Rollback switches traffic back to the previous immutable application images. The additive columns must remain compatible with the previous application, so application rollback does not require schema rollback. It must not restore an old database over new production writes.

## 11. Explicit non-goals

- no autonomous metric activation;
- no automatic production deployment from the agent setup flow;
- no broad admin navigation redesign;
- no new experiment statistics or winner heuristic;
- no audience-targeting or segment builder;
- no replacement of MCP with a hosted agent runtime;
- no new SDK or ingest contract;
- no synthetic production events to satisfy onboarding gates;
- no deletion, re-keying, or semantic fabrication of existing customer data; the only backfill freezes current experiment references and labels its weaker provenance.
