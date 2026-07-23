# Migration 023 pre-deploy runbook

Before private Cloud runs generic migrations:

1. Stop API, ingest, maintenance workers, and every direct/non-public database writer. The database cutover
   below enforces the boundary, but maintenance mode avoids lock waits and failed writes during deployment.
2. Verify a restorable backup out of band and record the operator attestation reference. Core validates only
   the reference format; it does not inspect or restore the backup artifact.
3. From the exact pinned Core runtime image, run
   `node dist/cli/preflightMigration023.js --report`. Review exact totals, at most 100 sample IDs per
   category, and the digest of the full stable set. Plaintext keys are never queried. Do not substitute a
   moving checkout, `tsx`, or development dependencies for this image.
4. If affected rows are expected, run
   `node dist/cli/preflightMigration023.js --apply --ack <digest> --backup <backup-reference>` in that same
   image.

The apply transaction takes the `organization_members` writer lock before the exclusive `api_keys` lock,
rescans and rejects a stale digest, performs the acknowledged cleanup, verifies zero affected rows, and
installs both migration 023 constraints before releasing either table. A writer already in flight is either
included in the locked rescan or completes after commit under the new constraints; it cannot add a row that
is silently deleted outside the acknowledged set.

Store the emitted `migration-023/v2` `constraints_installed` JSON receipt in the private deployment change
record. Then run `node dist/cli/migrate.js` from the same image: migration 023 is idempotent, so the generic
runner records it in `schema_migrations` and continues without reopening the writer window. The package alias
points to this same compiled file. Verify the migration record and both constraints before restarting writers.

Migration 023 aborts with an actionable error when this protocol was skipped.
