# Migration 023 pre-deploy runbook

Before private Cloud runs generic migrations, an operator must attest that a restorable backup exists.
Then run `pnpm preflight:migration-023 --report` and review exact totals, at most 100 sample IDs per category,
and the digest of the full stable set (plaintext keys are never queried). If affected rows are expected,
run `pnpm preflight:migration-023 --apply --ack <digest> --backup <backup-reference>`.
`--backup` records only the operator attestation; it does not verify or restore the backup. The apply path locks, rescans, rejects a stale digest, cleans in one transaction,
and performs a zero-affected post-check. Only then run `pnpm migrate`.
Store the emitted `migration-023/v1` JSON receipt in the private deployment change record; Core does not claim that it verifies the referenced backup artifact.

Migration 023 aborts with an actionable error when this protocol was skipped.
