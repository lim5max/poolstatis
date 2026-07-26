# Cloud UX and accessibility audit — 2026-07-26

## Scope and method

Target: Poolstatis Cloud customer admin, auth portal, onboarding, project-scoped
administration, setup/MCP, usage, and the private operator console.

- WCAG target: 2.2 AA.
- Core baseline: `5184a9330712da75350565774880d2430ad08f9b`.
- Private Cloud operator baseline (read-only): current
  `/Users/maksimstil/Desktop/poolstatis-cloud/.worktrees/cloud-beta`, including
  its uncommitted launch changes.
- Browser journey: local Vite UI at `http://127.0.0.1:5273` backed by the real
  local API and Postgres seed `ux-audit-0726`.
- Auth flows: code inspection plus
  `pnpm --dir web exec vitest run src/auth-portal.test.tsx`.
- Mobbin: `search_screens` was not exposed by the current tool runtime, so no
  Mobbin references were used.
- Live Cloud signup/reset smoke was not run: no test live URL or disposable
  account was provided, and the audit must not create accounts or touch prod.

Pre-change screenshots:

- `/Users/maksimstil/.codex/visualizations/2026/07/26/019f9eae-c037-7693-8977-9778f2a53282/before-projects-desktop.png`
- `/Users/maksimstil/.codex/visualizations/2026/07/26/019f9eae-c037-7693-8977-9778f2a53282/before-registry-desktop.png`
- `/Users/maksimstil/.codex/visualizations/2026/07/26/019f9eae-c037-7693-8977-9778f2a53282/before-registry-mobile.png`
- `/Users/maksimstil/.codex/visualizations/2026/07/26/019f9eae-c037-7693-8977-9778f2a53282/before-mobile-navigation.png`

## Findings

### P0

1. **Core admin has Level A navigation and naming failures.**
   `web/src/App.tsx` renders the route surface as generic `div` elements: there
   is no main landmark or bypass link, and all twelve checked admin routes had
   zero `h1` elements. Registry and Keys row action menus render icon-only
   buttons without accessible names through `Overflow`; Registry had five
   unnamed visible buttons. The connect token field has a visual `Label`
   without `htmlFor`, so the browser exposes the placeholder rather than
   “Token” as its name. WCAG 1.3.1, 2.4.1, 2.4.6, 3.3.2, 4.1.2.

   Reproduce:

   ```bash
   pnpm serve
   pnpm --dir web dev --host 127.0.0.1
   ```

   Open `/`, connect locally, then inspect `/registry` and `/keys` with the
   accessibility tree. Before remediation `/registry` reported
   `main=0`, `h1=0`, `unlabeledButtons=5`.

2. **Registry sorting is pointer-only.**
   Sort handlers are attached directly to `TableHead` cells in
   `web/src/screens/Registry.tsx`. They cannot receive keyboard focus and do
   not expose `aria-sort`. WCAG 2.1.1, 4.1.2.

3. **Private operator mobile flow has no route back to the tenant list.**
   At `max-width: 56rem`,
   `services/operator-web/src/styles.css` hides
   `.tenant-pane.has-selection`. `selectedId` is set in
   `services/operator-web/src/App.tsx`, but the detail view exposes no control
   that clears it. After opening one tenant, an operator on mobile cannot
   select another without reloading. This is a read-only finding against the
   parallel Cloud launch worktree; it is intentionally not fixed in Core.

### P1

1. **Selected project is lost on reload and can silently change data scope.**
   `web/src/store.tsx` always selects `list[0]` on connection/hydration. Browser
   reproduction: create/select `ux-empty-0726`, reload `/`, and the switcher
   returns to `ux-audit-0726`. This is especially risky on Registry, Data, Keys,
   Changes, and Decisions because the page remains valid while its project
   context changes.

2. **Registry subsection is not represented in the URL.**
   `Registry` uses `defaultValue="metrics"`. Browser reproduction: select
   “Funnels”, observe the URL remains `/registry`, navigate away and Back;
   “Metrics” is selected. The current subsection cannot be bookmarked or
   restored.

3. **Admin pages do not have unique document titles.**
   All twelve checked routes retained `Poolstatis — Instrument`. WCAG 2.4.2.

4. **Private operator dialogs do not manage keyboard focus.**
   The custom dialog has `role="dialog"` and `aria-modal`, but no initial focus,
   focus containment, Escape handler, or focus restoration. This is a
   read-only finding for the private Cloud worktree. WCAG 2.4.3, 2.4.7.

### P2

1. `Loading`, `ErrorNote`, and warning states in the shared Core helpers do not
   consistently expose live/status semantics. Async failures can appear
   visually without being announced. WCAG 4.1.3.
2. Registry status filters and segmented key/experiment controls visually
   expose selection but omit `aria-pressed`.
3. Route and connection motion do not honor `prefers-reduced-motion`.
4. Several filter removal and disclosure icon targets are visually smaller
   than 24 CSS px. WCAG 2.5.8.

## Positive evidence

- The Core mobile drawer uses Radix Dialog semantics, closes with Escape, and
  exposes labelled open/close controls.
- Core tables are horizontally contained; no page-level horizontal overflow
  was observed on the tested desktop and narrow layouts.
- Auth forms use native forms, persistent labels, password-manager compatible
  autocomplete values, neutral forgot-password responses, and do not disable
  paste.
- Auth, profile, project, usage, and onboarding unit tests passed at baseline:
  25/25 across four files.
- Customer Usage remains an account/ledger surface rather than an analytics
  dashboard, preserving the product boundary.

## Implemented remediation and verification

This Core branch addresses P0 findings 1–2, P1 findings 1–3, and the Core P2
findings. The private operator findings remain read-only launch gates.

- Added one bypass link, `main` landmark, route-specific `h1`, and unique title
  on every checked customer-admin route.
- Persisted project and environment context, while validating stored values
  against the projects/environments currently available to the account.
- Moved Registry and Data subsections into the URL so reload and browser Back
  restore the selected subsection.
- Replaced pointer-only Registry sorting with named native buttons and
  `aria-sort`; labelled searches, selectors, row actions, copy/disclosure
  controls, and exposed toggle state with `aria-pressed`.
- Added live-region semantics to loading/error/warning feedback, progressbar
  semantics to meters, reduced-motion support, and minimum targets to affected
  icon/disclosure controls.
- Wrapped wide Keys data in the existing horizontal table container and kept
  all checked narrow routes free of page-level horizontal overflow.

Post-change browser evidence:

- `/Users/maksimstil/.codex/visualizations/2026/07/26/019f9eae-c037-7693-8977-9778f2a53282/after-registry-desktop.png`
- `/Users/maksimstil/.codex/visualizations/2026/07/26/019f9eae-c037-7693-8977-9778f2a53282/after-registry-mobile.png`
- `/Users/maksimstil/.codex/visualizations/2026/07/26/019f9eae-c037-7693-8977-9778f2a53282/after-mobile-navigation.png`

The repeated mobile semantic scan of all thirteen routes (including
Onboarding) reported one `main`,
one `h1`, a unique route title, zero unnamed visible controls, and no
page-level horizontal overflow on each route. Browser checks also confirmed:

- `ux-empty-0726` remains selected after reload;
- `/registry?tab=funnels` survives leave/Back;
- `/data?tab=events` represents the selected Data subsection;
- the mobile navigation closes with Escape and restores focus to
  “Open navigation”.

A computed-color check sampled 81 visible direct-text elements on the populated
Registry route and found no text below the WCAG AA 4.5:1 / 3:1 thresholds.
This complements, but does not replace, the staging VoiceOver/axe gate below.

Verification commands:

```bash
pnpm --dir web test
pnpm --dir web build
pnpm typecheck
pnpm test
git diff --check
```

Final command results are recorded in the branch handoff; browser checks used
the local API/Postgres seed only.

## Formal code review

The final diff was reviewed against the Core baseline for correctness,
accessibility regressions, responsive behavior, tenant/project context,
existing design-system reuse, and the headless-admin product boundary. No
blocking P0/P1/P2 finding remained in the Core diff. The review retained the
private operator mobile navigation and dialog-focus findings as external
launch gates instead of changing the parallel private worktree.

## Live gates

- Run real signup → verification → login → forgot/reset → login on a disposable
  staging account.
- Run hosted owner/admin/member role journeys against staging OIDC claims.
- Verify the private operator P0 and dialog focus behavior after the launch
  worktree is stable enough for a dedicated fix.
- Validate with VoiceOver and at least one external automated engine (axe,
  Lighthouse, or equivalent) against staging; local semantic checks do not
  establish WCAG conformance.
