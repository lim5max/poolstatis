# Customer admin UX release candidate

Date: 2026-07-27

Release branch: `codex/customer-admin-ux-rc-20260727`

Deployment: prohibited in this task

## Immutable inputs

- Reviewed Core session/onboarding base: `7ed9958fa0caa534e01a84c12b6678dbc7996c66`
- Reviewed Core image digest supplied by the Cloud release task:
  `sha256:9cfc21937bc002b8500e604d553e0e6a6eaf0f8dc1d92b76885eba1c6790771b`
- Reviewed Customer UX patch source: `6076b8721295f0f968114f5cf1a5ecd06a01a809`
- Earlier customer image digest supplied for traceability only:
  `sha256:0596334755f87974417eebea015000ac6b61e3c4462d64f147f6fb1e351506df`
- Current deployed private baseline, not modified or included:
  `ddba4df222cb1f241d6590faef006391cb833138`
  (contains accepted operator baseline `b6eaf526944fbfa9e68323ef91aadfa41bf34b1c`
  plus the reviewed deploy/rollback environment-authority fix).

The RC is source-only. This task does not build, publish, deploy, or claim a new
container digest.

## Integration method

The Customer UX commit was cherry-picked onto the exact reviewed Core base.
The original Customer UX branch was not rewritten.

Conflict map:

- Direct file overlap: none.
- Core base owns account/session recovery, AuthPortal, Connect, Onboarding, and
  store persistence.
- Customer UX owns the customer admin shell, Setup & MCP flow, customer-screen
  copy/recovery states, and persisted onboarding evidence presentation.
- Compatibility seam requiring regression verification: hosted session recovery
  and first-project persistence flowing through `store`/`Onboarding` into the
  customer shell and project-scoped Setup header.

## Included scope

- Collapsible and responsive customer navigation with persisted state.
- Task-oriented customer information architecture.
- Progressive Setup & MCP flow.
- Honest server-evidence labels for project, key, event/source, query, and
  MCP-marked last-use evidence.
- Customer-facing loading, empty, error, retry, live-region, keyboard, focus,
  and mobile behavior.
- Customer admin copy reductions across existing Core functions.

## Explicitly excluded

- Deployment or merge to production.
- Private operator UI, operator economics, and operator routes.
- Landing instrumentation or CORS changes.
- MCP package publishing or runner availability changes.
- New analytics-dashboard capabilities.

## Release gates

- Full Core tests: passed, 62 files / 315 tests with
  `pnpm exec vitest run --hookTimeout=60000 --testTimeout=60000`.
- Full web tests: passed, 7 files / 59 tests.
- Core typecheck: passed.
- Production web build: passed.
- Desktop/mobile browser smoke: passed.
- Formal review: passed after the manifest consistency fix.
- Clean worktree: passed before review and required again after this manifest
  commit.
- Remote RC source SHA: intentionally reported alongside this manifest after
  push; a Git commit cannot embed its own SHA.

The first default-timeout Core runs coincided with other Vitest suites on the
same host and exceeded the 10-second `beforeAll` budget in the two stdio MCP
suites before their assertions ran. The complete rerun above used a 60-second
hook/test budget without changing test or production source; all 315 tests
passed, including both MCP suites.

RC browser smoke verified:

- later session hydration restored project `ux-audit` without creating another
  workspace;
- project and `prod` environment remained visible on Setup after reload;
- desktop collapse state persisted after reload;
- mobile layout had no horizontal overflow;
- the mobile drawer closed with Escape and restored focus to the open control;
- server-evidence wording remained explicit about MCP-marked last use;
- browser console errors: zero (React Router future-flag warnings remain).

The main Cloud task separately supplied real-browser evidence for the deployed
base: existing organization, exactly one existing project, no “Create workspace”
path, desktop/mobile reload and new-tab recovery, and zero console errors. That
evidence validates the input base. The separate RC compatibility/browser smoke
is recorded above and also passed.

The production integrator must use the final remote RC SHA reported with this
manifest and must retain all independent production P0 stop gates.
