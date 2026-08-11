# Control tower automation

This Core surface provides project-scoped monitors, scheduled semantic answers,
notification routing and human-reviewed automatic proposals. It does not change
feature-flag traffic or deploy state on its own.

## Safety contract

- Monitor and schedule definitions use stable heads plus append-only revisions.
- Runs use PostgreSQL leases, bounded exponential retry and deterministic
  deduplication keys. Restarting a worker cannot create a second finding,
  proposal, insight snapshot or delivery for the same run.
- A breached monitor may create a frozen `pause` or `rollback` proposal. The
  proposal records the exact target, requested allocation, current undo state
  and SHA-256 confirmation fingerprint. Only an authenticated workspace owner
  or admin user session may approve or reject it. `sk_`/`pt_` credentials and
  MCP can read the frozen proposal but cannot record a human review. Approval
  returns `requires_existing_human_approved_mutation`; it does not call the flag
  or release mutation service.
- A proposal-producing monitor is accepted only when the policy, release or
  experiment target, and feature flag use the same explicit environment. The
  worker rechecks the flag environment before freezing a proposal, so a legacy
  or drifted `dev` policy cannot propose a `prod` traffic mutation.
- Scheduled feeds resolve IANA timezone cadence in Core. Spring DST gaps move to
  the first valid local minute; repeated fall minutes run once using the local
  date idempotency key.
- Findings and feed snapshots contain semantic aggregates and definition
  fingerprints, never raw events, raw properties, event actors, credentials or
  token-like values. Delivery envelopes enforce the same exclusion at runtime.

## Truthful destinations

`in_product` writes an immutable project inbox row. `outbox` stops at
`ready_for_extension` and is the typed adapter seam for a future provider.
Capabilities report external providers as `not_configured`; Core does not imply
email, Slack, webhook or another provider exists.

## Runtime configuration

| Variable | Default | Meaning |
| --- | ---: | --- |
| `CONTROL_TOWER_AUTOMATION_ENABLED` | `true` | Run monitor, feed and delivery workers |
| `CONTROL_TOWER_AUTOMATION_INTERVAL_MS` | `60000` | Worker tick interval |
| `CONTROL_TOWER_AUTOMATION_BATCH_SIZE` | `25` | Maximum claims per worker and tick |
| `CONTROL_TOWER_AUTOMATION_MAX_ATTEMPTS` | `8` | Terminal retry limit |
| `CONTROL_TOWER_AUTOMATION_BASE_RETRY_MS` | `60000` | First retry delay |
| `CONTROL_TOWER_AUTOMATION_MAX_RETRY_MS` | `3600000` | Exponential backoff cap |
| `CONTROL_TOWER_AUTOMATION_LEASE_MS` | `300000` | Crash-safe claim lease |

REST resources live below `/api/v1/projects/:slug/monitors`,
`/insight-feed/*` and `/automation/*`. MCP exposes proposal reads but deliberately
omits proposal approve/reject tools. The admin shows review controls only for a
signed-in workspace owner/admin and keeps API-key sessions read-only.
