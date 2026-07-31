# Analyze/UX: release and data-safety plan

**Date:** 2026-07-30
**Owner:** Workstream A — data safety and release gate
**Source PRD:** `2026-07-30-analyze-navigation-visual-system-prd.md`
**Status:** executable gate plan; production release is **not approved**

## 1. Decision

Analyze/UX may reach production only after one integrated candidate satisfies
every gate in this document. A pushed branch, a locally passing build, an image
digest, a created backup, and a deployed release are separate states.

The release is vetoed while any of these conditions is true:

- actual live Core/Cloud/site lineage has not been read back immediately before
  the release;
- a candidate migration is not additive and compatible with the previous
  application;
- the pre-migration backup is not encrypted, copied off-host, read back,
  checksummed, fresh, and restored successfully;
- candidate migrations have not run on the isolated restored pre-release
  database;
- required table counts or tenant-isolation checks differ unexpectedly;
- the previous application has not passed a compatibility smoke against the
  migrated restored database;
- the candidate can receive public traffic before the restore/migration drill
  passes;
- there is no verified previous application artifact or no tested application
  rollback;
- post-deploy probes are not repeatedly successful.

No destructive database rollback is part of the normal release or application
rollback. The physical production database name remains `poolsatis`.

## 2. Scope and hard safety boundaries

This workstream owns the migration inventory, backup/restore contract, lineage
evidence, release checklist, disposable rehearsal, and release veto. It does
not merge, migrate, deploy, or mutate production.

All implementation and test work must use:

- isolated Codex worktrees;
- local Docker Postgres and synthetic organizations/projects;
- a database URL whose database name is explicitly allowlisted as disposable;
- synthetic keys and payloads only.

The following are forbidden:

- production credentials in unit, integration, browser, restore, or migration
  tests;
- real project slugs, tokens, payloads, or raw identifiers in fixtures/evidence;
- `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, bulk event `DELETE`/`UPDATE`, physical
  database rename, credential rename, or event rewriting in an Analyze release;
- printing release environment files, connection strings, key hashes, token
  values, auth secrets, or backup identities;
- restoring an old database over a live database that may contain newer writes.

Production SQL in this plan is read-only unless it is run by the separately
authorized release coordinator at the named mutation phase. Every read-only
session begins with `BEGIN TRANSACTION READ ONLY` and a bounded statement
timeout.

## 3. Verified current lineage and mechanisms

These facts were rechecked locally on 2026-07-30 after fetching both remotes.
They do not assert current production state.

### 3.1 Core

| Fact | Verified value |
| --- | --- |
| Worktree | `/Users/maksimstil/.codex/worktrees/b5b1/poolstatis` |
| Required base branch | `codex/product-decision-loop-p0-p1` |
| Base/worktree SHA before this document | `1130477a1d4e19622642b74615a1374656e5fb8c` |
| Base tree | `5f34c00753ec2bc0518502fe2719ff282b636545` |
| Remote tracking SHA | `16f78c5902259459d4d6f74075a98b6495de4d57` |
| Ahead/behind remote | ahead 2, behind 0 |
| Baseline migrations | `001_init.sql` through `022_webhook_outbox.sql` |
| Baseline migration tree | `c5e96def9347852b33e5b17ef4d36b4a5299b9d0` |
| Aggregate SHA-256 of sorted migration checksums | `8f0166e7720eeb62ef51d427c1774e3fb6b926e2bb2944f2d1bd7726a1275a48` |

The unrelated user-owned `package.json` package-manager edit was already
present. It is outside this workstream and must not be staged.

Core `src/db.ts` currently:

- takes a session advisory lock named `poolstatis:schema-migrations`;
- sorts `.sql` files lexicographically;
- applies each pending file in its own transaction;
- records the filename in `schema_migrations`;
- rolls back a failed file and releases the advisory lock.

Core records names, not migration checksums. Therefore an applied file edited
in place is not detectable from the database alone. The release gate must
reject edits, renames, or insertions among migrations already present on the
live prefix by comparing Git/file checksums in the evidence manifest.

### 3.2 Cloud

| Fact | Verified value |
| --- | --- |
| Documentation-only `main` | `00b896730fd672b36d738986bfaf9fb0d22fdd8f` |
| Latest inspected release-contract branch | `origin/codex/event-backfill-release` |
| Release-contract SHA | `f4485afe231687393885691b4faeb955289ce46f` |
| Parent recorded as previously observed live lineage | `479c6fe05ac91be3f1738705e7db7b76262022d2` |
| Candidate Core pin | `a22c6c595d90dc875e3da223027f6b8f5ddc7cc8` |
| Candidate immutable Core image | `ghcr.io/lim5max/poolstatis@sha256:9a85f482ebd744e726661be07f3b3572c9d5aadb38487bd4fe8325d6c749ceaf` |
| Candidate schema contract | Core migrations `001-032` |

`f4485af` is a pushed release candidate descended directly from the previously
observed Cloud SHA `479c6fe`; it is not evidence that either SHA is currently
live. The candidate release was previously recorded as not deployed.

The inspected Cloud contract provides:

- digest-pinned Core/private images and OCI revision checks;
- fixed, mode-checked secret files without printing their contents;
- migration-only credentials separated from runtime credentials;
- a raw pre-migration backup and a continuity backup;
- `age` encryption, `rclone` off-host upload/readback, SHA-256 evidence, and
  retention;
- an isolated network and pinned Postgres 17 image for a restore drill;
- Cloud migration checksums and an exact-prefix drift check;
- `current.env`/`previous.env`, provenance checks, rollback-on-error, smoke,
  and runtime-health scripts.

### 3.3 Current release-contract gaps

The current scripts are useful building blocks but do not yet satisfy this PRD:

1. `scripts/preflight.sh` permits a time-bounded
   `local-accepted-risk` backup override. Analyze/UX requires a real off-host
   backup; this override is a release veto, even while Cloud accepts it.
2. Preflight checks memory and file ownership but does not prove free disk
   capacity for backup, restore scratch space, candidate layers, and rollback.
3. `deploy.sh` creates the raw backup before migrations, but
   `restore-drill.sh` restores the later continuity backup after migrations.
   It does not run candidate migrations on the restored raw pre-release backup.
4. The restore drill checks schema/roles/auth/artifacts, but does not compare
   the PRD-required counts for organizations, projects, events, entities,
   registry, keys, and audit tables.
5. `deploy.sh` starts candidate Caddy/application services and runs a public
   smoke before the continuity backup and restore drill. A restore failure can
   roll the app back, but the candidate may already have received traffic.
6. Compose replacement plus later `current.env` rotation is fail-closed
   orchestration, not a demonstrated side-by-side atomic traffic switch.
7. The previous app is retained, but compatibility of that previous app with
   the newly migrated schema is not rehearsed.
8. `smoke.sh` retries until the first success. It does not require repeated
   consecutive successes after the switch.
9. `preflight.sh` is not read-only: it writes no-swap evidence and can write
   backup-risk evidence. It cannot be called from the read-only discovery
   phase without a separately tested `--check-only` mode.
10. Raw backup metadata does not currently bind the object to live source/image
    lineage, Postgres major, count snapshot, size, retention, start time, or
    duration. The existing successful JSON alone is insufficient for this
    program's evidence ledger.

These gaps are blockers to release, not permission to bypass the checks.

### 3.4 Production facts deliberately not claimed

Workstream A did not connect to production and did not read any credential.
The release coordinator must still prove:

- exact live private SHA, Core source SHA, and every live image digest;
- exact current release and rollback artifact;
- Postgres major version and live migration prefixes/checksums;
- current counts and database/artifact sizes;
- current off-host backup namespace, retention, latest successful readback,
  and restore-drill status;
- release/state/backup filesystem capacity;
- current `/health`, `/ready`, admin, auth, MCP, landing, docs, login, and
  signup behavior;
- the actual public-site production mechanism and rollback target.

Any mismatch with the assumed lineage stops the release and requires a new
candidate based on the live revision.

## 4. Skill and workflow choice

The installed `poolstatis-maintain` workflow was selected for data-health,
registered-event, warning, and reversible-registry semantics. Its MCP mutation
steps are not used by this read-only workstream.

The installed `requesting-code-review` workflow is used for the independent
final review.

The required searches were run:

```text
npx -y skills find "data safety"
npx -y skills find "PostgreSQL restore"
npx -y skills find "atomic deploy"
```

Results were generic safety, Azure/generic backup, PostgreSQL operations,
Django migration, and unrelated atomic-design/recovery skills. None was
installed: the repository-specific Core/Cloud contracts are more precise and
already test fail-closed behavior.

## 5. Migration policy and inventory

### 5.1 Expected Analyze/UX migration surface

| Workstream | Expected database effect | Classification |
| --- | --- | --- |
| B — Core visual system | none | no migration allowed |
| C — public-site visual system | none | no migration allowed |
| D — Analyze foundation/templates/visualization | none for code-defined templates | no migration expected |
| E — Web analytics and actors query | existing event/actor-link reads through `EventStore` | no migration expected unless a separately reviewed index is required |
| F — Saved views | new project/env-scoped table and indexes only | additive/backward-compatible |
| G — OpenUI pilot | none | no migration allowed |

An unexpected migration in a “none” row is a stop condition until its owning
workstream supplies a schema need, lock analysis, compatibility proof, and
tests.

### 5.2 Allowed migration classes

**A — metadata/additive, normally safe**

- new nullable column with no table rewrite;
- new table with project/environment foreign keys;
- new constraint on a new table;
- new index on a new, empty table;
- new function or view that does not change stored facts.

**B — additive but operationally risky**

- index on populated `events`, `entities`, registry, key, or audit tables;
- `NOT NULL` or non-null default on a populated table;
- constraint validation over existing rows;
- enum/check expansion coupled to rolling app versions.

Class B requires measured lock duration and query plan on a production-sized
synthetic/restored copy. A regular `CREATE INDEX` executed inside the Core
per-file transaction can block writes; it must not be waved through because it
is syntactically additive. If `CREATE INDEX CONCURRENTLY` is required, the
existing transactional runner cannot execute it and a separately designed,
idempotent operational-index path is required.

**C — data migration**

- bounded backfill of derived metadata;
- transformation of existing customer rows;
- ownership or permission rewrites beyond additive grants.

Class C is excluded from this release unless separately approved with preview,
idempotency, batch bounds, audit evidence, and an independent rollback plan.
Immutable events are never rewritten to apply actor links.

**D — forbidden**

- drop, truncate, rename of `poolsatis`, destructive column/type change;
- bulk deletion/update of event facts;
- rebuilding tenant ownership from inferred data;
- changing or reordering an already-applied migration.

### 5.3 Candidate migration review commands

Run from a clean integrated Core checkout. `AUTHORING_BASE_SHA` explains the
program diff; `LIVE_CORE_SHA` is the freshly read live source commit and is the
actual release/migration safety baseline:

```bash
AUTHORING_BASE_SHA=1130477a1d4e19622642b74615a1374656e5fb8c
LIVE_CORE_SHA='<read-only live Core source SHA>'
CANDIDATE_SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor "$LIVE_CORE_SHA" "$CANDIDATE_SHA"
git diff --name-status "$AUTHORING_BASE_SHA..$CANDIDATE_SHA" -- migrations
git diff --name-status "$LIVE_CORE_SHA..$CANDIDATE_SHA" -- migrations
git diff --check "$LIVE_CORE_SHA..$CANDIDATE_SHA"
git diff "$LIVE_CORE_SHA..$CANDIDATE_SHA" -- migrations
find migrations -maxdepth 1 -type f -name '*.sql' -print0 \
  | sort -z | xargs -0 shasum -a 256
rg -n -i \
  '\b(drop table|drop column|truncate|delete from|update [a-z_]+|alter table|create index|rename)\b' \
  migrations
```

Evidence must contain the authoring diff, the live exact prefix, new files,
per-file checksum, class, owner, expected locks, estimated rows/bytes touched,
previous-app compatibility, and reviewer decision. Every migration in the
live prefix must match the manifest generated from the exact live Core
artifact byte-for-byte; comparing only filenames in `schema_migrations` is not
enough.

## 6. Release procedure

The release coordinator executes phases in order. Each phase writes immutable,
timestamped evidence. Failure stops the sequence; the next phase never tries
to “repair” a failed gate in production.

### Phase 0 — candidate freeze

1. Integrate reviewed workstreams in a clean release worktree based on the
   freshly read live lineage.
2. Record Core, Cloud, and site repository SHAs and prove they are pushed.
3. Run all PRD mechanical, targeted, browser, tenant-isolation, and independent
   review gates.
4. Build immutable artifacts once. Record repository, source SHA, image
   digest/static checksum, architecture, build timestamp, and test evidence.
5. Pin the exact Core commit/image/schema contract in Cloud.
6. Record the previous live artifacts and verify they are locally/registry
   retrievable without using mutable tags.
7. Freeze the candidate. Any byte or SHA change restarts review and rehearsal.

Required evidence:

```text
candidate/core-sha.txt
candidate/cloud-sha.txt
candidate/site-sha.txt
candidate/images.json
candidate/migrations.sha256
candidate/tests.json
candidate/reviews.json
candidate/previous-release.json
```

### Phase 1 — read-only production preflight

Run immediately before backup:

1. Read whitelisted release fields only from the protected current release
   file: private SHA, Core SHA, and image digests. Never print the whole file.
2. Verify candidate ancestry from the actual live private revision.
3. Inspect only whitelisted secret-file metadata by numeric owner/group:

   ```bash
   for name in \
     postgres_password core_database_url cloud_database_url auth_database_url \
     migration_database_url bootstrap_database_url core_auth_config \
     control_auth_config control_hmac_keys better_auth_secret resend_api_key
   do
     stat -c '%n %u:%g %a' "/etc/poolstatis-cloud/secrets/$name"
   done
   ```

   On the inspected `f4485af` contract every listed file is root-owned, mode
   `0640`; `postgres_password` uses numeric group `70` and the other files use
   numeric group `1000`. The coordinator must use the values from the actual
   live release contract if they differ; a mismatch is a stop condition, not
   an instruction to `chown` during discovery.
4. Do **not** run the current `scripts/preflight.sh` in this phase: it writes
   operational state. A future `--check-only` validator may replace the
   individual read-only checks only after a test proves no filesystem,
   database, container, or network state changes.
5. Record Postgres version and database size in a read-only transaction. First
   inventory table presence, then run counts only for tables that exist:

   ```sql
   BEGIN TRANSACTION READ ONLY;
   SET LOCAL statement_timeout = '30s';
   SELECT current_setting('server_version'),
          current_database(),
          pg_database_size(current_database());
   WITH expected(name, qualified_name) AS (
     VALUES
       ('schema_migrations', 'public.schema_migrations'),
       ('cloud.schema_migrations', 'cloud.schema_migrations'),
       ('organizations', 'public.organizations'),
       ('projects', 'public.projects'),
       ('events', 'public.events'),
       ('entities', 'public.entities'),
       ('metrics', 'public.metrics'),
       ('funnels', 'public.funnels'),
       ('property_definitions', 'public.property_definitions'),
       ('api_keys', 'public.api_keys'),
       ('actor_links', 'public.actor_links'),
       ('actor_link_audit', 'public.actor_link_audit'),
       ('measurement_contract_revisions', 'public.measurement_contract_revisions'),
       ('release_revisions', 'public.release_revisions'),
       ('evidence_sets', 'public.evidence_sets'),
       ('decision_revisions', 'public.decision_revisions'),
       ('decision_action_audit', 'public.decision_action_audit'),
       ('analysis_views', 'public.analysis_views')
   )
   SELECT name,
          CASE WHEN to_regclass(qualified_name) IS NULL
               THEN 'not_applicable' ELSE 'present' END AS state
     FROM expected ORDER BY name;
   ROLLBACK;
   ```

   Use a reviewed `psql` inventory file that generates fixed `SELECT count(*)`
   statements only where `to_regclass(...) IS NOT NULL` (for example with
   `\gexec`). It must emit `not_applicable` for missing tables and then commit
   no state. Capture migration rows only when their table is present:
   `public.schema_migrations(name, applied_at)` and
   `cloud.schema_migrations(name, checksum, applied_at)`.
6. Record aggregate and scoped counts using the real table grain:

   - `events`, `entities`, `actor_links`, and `analysis_views` (when present):
     `project_id, env`;
   - `metrics`, `funnels`, and property definitions: `project_id`;
   - `api_keys`: `org_id, project_id, env, kind, (revoked_at IS NOT NULL)`;
   - append-only audits: their stored project/environment columns, where
     present.

   Evidence must not contain tokens, hashes, emails, properties, event names,
   actor IDs, or raw payloads.
7. Record `df -Pk` for release, Docker, Postgres, backup, and temporary restore
   filesystems plus `docker system df`. Required free bytes are:

   ```text
   3 * live_database_bytes
   + 2 * artifact_volume_bytes
   + candidate_image_layer_bytes
   + max(2 GiB, 20% of the target filesystem)
   ```

   Use the largest requirement for any filesystem that shares storage. No
   pruning occurs during release preflight.
8. Require current `/health` and `/ready`, Cloud readiness, runtime-health,
   public routes, and asset checks to pass before mutation.
9. Confirm no migration/deploy/backup lock is active and retain the previous
   release file/artifacts.

### Phase 2 — off-host pre-migration backup

The existing raw backup path may be used only after a reviewed/tested wrapper
or script extension adds the missing evidence fields. This call by itself is
not a passing gate:

```bash
POOLSTATIS_BACKUP_MODE=raw \
POOLSTATIS_RELEASE_ENV=/absolute/path/to/candidate.env \
scripts/backup.sh
```

Gate requirements:

- exact Postgres major version and source release are in evidence;
- Core is quiesced as required by the existing snapshot contract;
- custom database dump, globals, and artifact archive are encrypted with the
  fixed `age` recipient;
- the encrypted object is uploaded outside the VPS/release directory;
- a fresh off-host readback has the same SHA-256;
- object size, remote object key, retention, start/end UTC, and duration are
  recorded;
- `storage` is exactly `off-site`;
- completion age is at most 60 minutes when migrations begin;
- the snapshot predates the first production mutation;
- one consistent read-only count manifest is bound to the backup object,
  whitelisted live source/image lineage, and snapshot completion time.

A local-only copy, an expired accepted-risk override, an upload without
readback, or a checksum without restore is not a passing backup gate.

Only after off-host readback succeeds and release mutation is explicitly
authorized may the coordinator run the existing state-writing
`scripts/preflight.sh`. Its writes must be limited to reviewed operational
evidence paths and captured in the ledger. `local-accepted-risk` remains a veto.
No database migration starts until that operational preflight passes.

### Phase 3 — isolated restore and migration rehearsal

The current `restore-drill.sh` must be extended or accompanied by a reviewed
release-rehearsal script that consumes the **raw pre-migration object**. It
must not share a network, volume, database name, or credentials with
production.

Required sequence:

1. Pull the exact encrypted off-host object and verify its recorded checksum.
2. Decrypt into a mode-`0700` temporary directory and verify every manifest
   member/checksum.
3. Start the exact production Postgres major image on an internal Docker
   network with no published port.
4. Restore globals into fixed non-superuser roles and restore the database as
   `poolsatis_restore` (the production database remains `poolsatis`).
5. Capture pre-migration restored counts using the Phase 1 query and compare
   them exactly with the snapshot counts.
6. Run candidate commands in production order:

   ```text
   role-bootstrap
   core-schema-migrate
   core-migrate
   cloud-migrate
   oauth-client-bootstrap
   ```

7. Re-run migrations and require a no-op.
8. Capture post-migration counts. Existing customer-fact/tenant tables must be
   equal to restored pre-migration counts. New additive tables must match
   their declared initialization contract, normally zero.
9. Verify all migrations form the reviewed prefix and Cloud checksums match.
10. Run integrity checks for orphaned project/org references.
11. Start the candidate app against only this isolated database; run
    `/health`, `/ready`, typed REST/MCP reads, auth/key masking, and synthetic
    tenant-isolation tests.
12. Stop the candidate and start the exact previous app artifacts against the
    migrated restored database with background jobs and external delivery
    disabled. Using only fresh synthetic credentials/tenants, require
    readiness plus representative reads, event ingest, entity upsert,
    registry/control-plane write-read, key lifecycle, and cross-tenant negative
    checks. Confirm writes affect only the synthetic tenant.
13. On an isolated full stack, rehearse the actual release orchestration:
    previous -> candidate -> previous. Exercise the same atomic ingress switch,
    verify `current.env`/`previous.env` preservation, and require repeated
    readiness/smoke checks after both switches. This is the mandatory rollback
    test; app compatibility alone is insufficient.
14. Record restore/migration/previous-app/rollback durations and remove the isolated
    containers/network/temporary plaintext through the reviewed cleanup trap.

Required count rules:

| Table class | Restore comparison | Live post-deploy comparison |
| --- | --- | --- |
| organizations/projects | exact equality | exact equality |
| events | exact equality | non-decreasing |
| entities | exact equality | non-decreasing |
| metrics/funnels/property definitions | exact equality | exact equality unless release explicitly creates none |
| api_keys | exact equality by kind/revoked state | exact equality |
| actor links and append-only audits | exact equality | non-decreasing |
| release/decision/evidence audits | exact equality | non-decreasing |
| new saved views | declared value, normally zero | non-decreasing |

Tenant checks use two synthetic organizations:

- an org/project A credential can list/query only A;
- an org/project B credential can list/query only B;
- actor-link resolution in A cannot affect B;
- saved views, Web analytics, Users/actors, releases, decisions, and MCP
  discovery preserve project plus environment scope;
- negative cross-project API/MCP requests return the expected refusal/not-found
  contract without revealing existence.

No real production credential is mounted into either app test. Database roles,
auth material, keys, and tenant fixtures used by the isolated applications are
fresh and local to the restore network; external egress and delivery remain
disabled.

### Phase 4 — atomic application deployment

The release coordinator must first close the current public-exposure gap.
Candidate app services may start for isolated readiness, but public ingress
must continue routing to the previous release until Phases 1–3 pass.

The approved deploy implementation must:

1. acquire the deployment lock;
2. retain verified `current.env` and previous immutable artifacts;
3. apply only the rehearsed migration checksums;
4. start the candidate on an isolated/non-public upstream;
5. pass candidate readiness;
6. atomically switch the ingress upstream/version pointer;
7. persist the new current/previous release metadata with `fsync`/atomic rename;
8. leave the previous app immediately startable against the additive schema.

If the existing Compose replacement remains the chosen mechanism, Workstream H
must provide an explicit reviewed change proving that Caddy/public traffic
cannot reach the candidate before the restore gate and that the ingress switch
is one atomic operation. An approved maintenance window does not waive backup,
restore, compatibility, or rollback requirements.

Application rollback:

1. atomically route traffic back to the retained previous app;
2. run previous-app readiness, repeated probes, and the dedicated synthetic
   write-read smoke whose behavior passed the Phase 3 rehearsal;
3. leave additive database objects in place;
4. record the reason, timestamps, releases, and probe evidence.

Never automatically restore the old database during application rollback. A
database restore is a separately approved disaster-recovery event requiring a
write freeze and reconciliation of all writes since the backup.

### Phase 5 — post-deploy evidence

After the switch:

1. run the complete smoke once;
2. require **10 consecutive** successful probes, two seconds apart, for Core
   `/health`, Core `/ready`, Cloud readiness, admin/app, landing/docs/auth
   routes, expected asset checksums/MIME, and runtime health;
3. run five additional probe sets, one minute apart;
4. fail and roll the application back on any failed probe, OOM, restart-count
   increase, unexpected 5xx, asset mismatch, or degraded runtime-health;
5. repeat the Phase 1 count query.

Expected live behavior:

- organizations, projects, registry definitions, and key counts are unchanged;
- events/entities/audit rows are non-decreasing only;
- no project/env count drops;
- existing read contracts remain stable;
- keys remain masked/listable and auth works;
- dedicated synthetic smoke ingest affects only its synthetic project;
- MCP lists/queries only that synthetic scope;
- browser console/network/accessibility checks have no release regression.

Keep the synthetic smoke project explicitly tagged and remove it only through
the separately reviewed test-owned cleanup contract, never through a broad
production purge.

## 7. Evidence ledger

One release ledger is complete only when it contains:

```json
{
  "prd": "2026-07-30-analyze-navigation-visual-system-prd.md",
  "release_status": "blocked|approved|deployed|rolled_back",
  "live_before": {
    "core_source_sha": "",
    "cloud_source_sha": "",
    "site_source_sha": "",
    "images": [],
    "postgres_major": "",
    "migration_prefixes": {},
    "counts_evidence": "",
    "read_at": ""
  },
  "candidate": {
    "source_shas": {},
    "images": [],
    "migration_manifest": "",
    "reviews": [],
    "tests": []
  },
  "backup": {
    "storage": "off-site",
    "live_source_shas": {},
    "postgres_major": "",
    "remote_object": "",
    "size_bytes": 0,
    "sha256": "",
    "started_at": "",
    "completed_at": "",
    "duration_seconds": 0,
    "retention_days": 0,
    "count_manifest": "",
    "readback_verified": false
  },
  "restore": {
    "source_sha256": "",
    "postgres_major": "",
    "pre_counts_match": false,
    "candidate_migrations_passed": false,
    "post_counts_match": false,
    "tenant_isolation_passed": false,
    "previous_app_compatible": false,
    "previous_app_write_compatible": false,
    "rollback_rehearsed": false,
    "duration_seconds": 0
  },
  "deploy": {
    "traffic_switch": "",
    "previous_release": "",
    "rollback_tested": false,
    "switched_at": ""
  },
  "post_deploy": {
    "immediate_consecutive_passes": 0,
    "delayed_passes": 0,
    "counts_evidence": "",
    "synthetic_smoke_scope": ""
  },
  "blockers": []
}
```

The ledger stores references to protected evidence, not secrets or plaintext
database content.

## 8. Local/disposable execution summary

No production connection or mutation occurred.

The values below are observations from this task's command transcript, not a
durable release-evidence bundle. No timestamped output manifest was committed,
so Workstream H must rerun these commands from the frozen candidate and store
command, UTC timestamp, exit code, tool versions, output digest, and candidate
SHA in the release ledger. This summary cannot approve production.

| Check | Result |
| --- | --- |
| Core lineage/fetch/ancestry | base `1130477…`; remote base `16f78c5…`; ahead 2/behind 0 |
| Core empty-schema migration | 22 files applied, `001` through `022` |
| Core second migration run | `schema up to date` |
| Core concurrent runners | one applied all 22; the other waited and returned no-op; final prefix 22 |
| Synthetic custom dump | 140,219 bytes; SHA-256 `c0e19803111b409158c0c4094397966acf8a2c26925367519986f53f2bc038c5` |
| Synthetic isolated restore | passed; restored counts exactly matched source |
| Synthetic counts | 2 organizations, 2 projects, 3 events, 2 entities, 2 metrics, 2 API keys, 1 actor link, 1 actor-link audit, 22 migrations |
| Synthetic tenant checks | project A saw 2/A-only events; B saw 1/B-only event; B did not resolve A’s actor link; 0 orphan project references |
| Disposable cleanup | all three `poolsatis_analyze_safety_*` databases removed; zero remained |
| Core typecheck | passed |
| Core tenant/auth targeted tests | 2 files, 42 tests passed |
| Self-host Compose config | passed |
| Cloud exact-ref archive | `f4485af`; no `.env` or production credential read |
| Cloud release-script tests | 5 suites, 13 tests passed |
| Cloud typecheck | passed |
| Cloud Core-pin verification | returned the expected immutable digest |
| Cloud shell syntax | 9 release/backup/restore/smoke scripts passed `bash -n` |

The synthetic dump existed only as a streamed local test artifact and was
restored successfully. This proves the local Core runner/dump/restore method,
not the existence, freshness, off-host location, restorability, row counts, or
current state of any production backup.

## 9. Handoff blockers

Before Workstream H can approve production, it must resolve and independently
review:

1. read back the actual live lineage and rebuild/rebase if it differs;
2. remove the local-backup accepted-risk path from this release decision;
3. implement a tested read-only/check-only preflight and separate the current
   state-writing operational preflight;
4. add disk-capacity evidence;
5. extend raw backup evidence with lineage, Postgres major, size, retention,
   timing, duration, and a consistent count manifest;
6. restore the raw pre-migration off-host backup and run candidate migrations
   on that isolated copy;
7. add version-aware count and tenant-isolation comparisons;
8. prove previous-app read/write compatibility with the migrated schema;
9. rehearse the exact previous -> candidate -> previous switch and evidence-file
   preservation;
10. prevent public candidate traffic before the restore gate;
11. prove one atomic/versioned traffic switch;
12. require repeated consecutive post-deploy probes;
13. establish the actual public-site release and rollback mechanism.

Until every item has passing evidence, the release status is **blocked**.
