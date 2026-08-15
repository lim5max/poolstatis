# Release ledger template

Copy this file to a dated release evidence directory before the first mutating
command in a release that spans packages, production or more than one repo.
Update it as facts change; never fill future evidence optimistically.

## Terminal condition

- Requested outcome:
- Explicitly out of scope:
- Completion requires: source / registry / Core production / site production
- Current phase:
- Remaining phases:

## Worktree identity

| Repository | Worktree root | Branch | HEAD | Clean | Shared checkout untouched |
| --- | --- | --- | --- | --- | --- |
| Core |  |  |  |  |  |
| Cloud |  |  |  |  |  |
| Site |  |  |  |  |  |

## Frozen inputs and truth states

Use only `not_started`, `in_progress`, `passed`, `failed`, `blocked` or
`not_applicable`. Every `not_applicable` state requires a scope rationale.

| State | Exact candidate | Status | Evidence |
| --- | --- | --- | --- |
| Core source merged/read back |  |  |  |
| MCP registry artifact |  |  |  |
| SDK registry artifact |  |  |  |
| Cloud source merged/read back |  |  |  |
| Core production deployed/read back |  |  |  |
| Site source merged/read back |  |  |  |
| Site production deployed/read back |  |  |  |

## Production discovery

- Host and deploy root:
- Actual Compose file and rendered config receipt:
- Current release SHA/digest:
- Previous/rollback release SHA/digest:
- Actual migration table and columns:
- Persistent volumes and mount paths:
- Capacity receipt:
- Active release/backup locks:

## Ordered phases

| Phase | Status | Required evidence | Receipt/link |
| --- | --- | --- | --- |
| Scope and worktree identity |  | exact roots, branches, status |  |
| Current origin/main integration |  | fetch, review, merge-tree |  |
| Local/CI gates |  | applicable AGENTS.md gates |  |
| Independent review |  | READY, findings closed |  |
| Package publication |  | exact SHA, version, integrity, clean install |  |
| Production inventory |  | discovered topology, no guessed identifiers |  |
| Backup and isolated restore |  | encrypted artifact, restore/count checks |  |
| Immutable Core deploy |  | digest, migrations, health, rollback |  |
| Post-deploy public truth |  | live claims only after live read-back |  |
| Exact-SHA site build and preflight |  | fresh dist, embedded SHA, desktop/mobile |  |
| Site deploy and live browser QA |  | current pointer, pages, console/overflow |  |
| Cleanup and final read-back |  | manifest empty, exact remote/live state |  |

## Artifact contract

- Build source SHA:
- Explicit build-time release SHA:
- Existing `dist` rejected/removed:
- Embedded-SHA assertion:
- Package tarball absolute path:
- Upload/download/checksum receipt:
- Registry version/integrity read-back:

## Failure log

Record a failure before retrying it. Do not blindly repeat a deterministic or
mutating failure. For a transient read-only probe, record its backoff, attempt
limit and stop condition before a bounded retry.

| Time | Phase | Classification | Command/purpose | Exit/stderr | Root cause | Changed action or bounded retry policy |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | read-only / fail-closed / mutation |  |  |  |  |

## Cleanup manifest

| Resource | Exact target | Created by this release | Stop action | Remove action | Status |
| --- | --- | --- | --- | --- | --- |
| Disposable database |  |  |  |  |  |
| Container/volume |  |  |  |  |  |
| Temporary directory |  |  |  |  |  |
| Temporary worktree/branch |  |  |  |  |  |

## User-facing progress snapshot

- Completed:
- Current:
- Remaining:
- Real blocker, if any:
- Last verified evidence:

## Final read-back

- `origin/main` exact SHAs:
- npm versions/integrities:
- production exact SHA/digest and migrations:
- backup/restore receipt:
- repeated health/external probes:
- authenticated proof for every changed auth-gated surface:
- `not_applicable` rationale when the release changes no auth-gated surface:
- site exact SHA and desktop/mobile result:
- unique approved commits remaining:
- cleanup result:
- accepted risks with owner and expiry:
