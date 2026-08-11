# Semantic definitions, comparison and account mode — implementation plan

**Base:** `1a92166` on exact Core `origin/main` `47059fd`

**Scope:** the remaining Human Control Tower P2 semantic-definition history and
cross-project comparison contract, plus the compact deployment/role-aware account
surface. Migration `036` is reserved for monitors/feed and `037` for saved answers;
this slice owns `038_metric_definition_revisions.sql`.

## Contract

1. A metric semantic definition is the canonical tuple `key`, `purpose`, `type`,
   derived aggregation and validated source. Cosmetic name/tags/category/status do
   not change its semantic fingerprint.
2. Definition revisions are append-only. Semantic writes retain the legacy PATCH
   endpoint, but every real purpose/source change records a revision. The explicit
   flow is preview -> dependency impact -> confirmation -> optimistic apply.
3. Cross-project comparison accepts one metric key, two to eight organization
   projects, one explicit environment and one explicit UTC window. It computes
   values only when every project has the same active key/purpose/type/aggregation/
   fingerprint. Any mismatch returns `unavailable` with bounded reasons and no
   values.
4. Organization comparison is available only to an organization-wide personal
   credential or hosted owner/admin. A project secret remains exact-project and
   receives `insufficient_scope`.
5. Account mode is server-derived from deployment configuration and authenticated
   scope. Profile remains an account-menu surface; self-host sessions receive local
   guidance and never a fake hosted profile.

## TDD sequence

1. Add failing migration/service/REST tests for revision creation, immutable
   history, dependency impact, required confirmation and stale-revision conflict.
2. Add failing comparison/auth tests for matching values, semantic mismatch,
   explicit scope and secret-key denial.
3. Add failing MCP parity tests for history/preview/comparison/account mode.
4. Add failing web tests for the definition review flow, honest comparison state,
   compact self-host/hosted account mode and role-aware navigation.
5. Implement the migration, services, schemas and routes; then wire MCP and the
   existing Registry/Projects/Profile surfaces using existing Poolstatis UI tokens.
6. Document REST/MCP behavior, rollback posture and privacy boundaries.

## Verification

- Focused backend, MCP and web suites during implementation.
- `pnpm typecheck`, `pnpm test`, `pnpm --dir web test`,
  `pnpm --dir web build`, `pnpm --dir sdk test`, `pnpm --dir sdk typecheck`,
  `pnpm --dir sdk build`, MCP/SDK pack checks and self-host Compose config.
- `git diff --check`, migration rollback notes, privacy/auth review and a final
  comparison against exact `47059fd` with no Hugeicons ancestry.
