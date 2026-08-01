# MCP 0.6.0 magic onboarding and safe experiments

`@poolstatis/mcp@0.6.0` adds high-level, backwards-compatible experiment operations while retaining every 0.5.0 tool and request shape.

## Additive tools

- `prepare_experiment` atomically creates one environment-scoped draft flag and experiment.
- `check_experiment_readiness` returns explicit allocation, control, metric, environment, and concurrency checks without mutating traffic.
- `launch_experiment` atomically activates the dedicated flag, freezes its definitions, and starts the post-exposure window.
- `apply_experiment_decision` records a conclusion and changes delivery only when an explicit shipped variant is supplied.

Existing `create_experiment`, `start_experiment`, and `conclude_experiment` remain supported. A conclusion without `ship_variant_key` never claims or performs a rollout change.

## Integrity and compatibility

- Existing project-wide flags keep `env = null` and evaluate in every environment.
- New scoped flags return no variant and emit no exposure outside their environment.
- Existing started experiments receive a best-effort `backfilled_current` snapshot.
- New starts use `frozen_at_start` snapshots, so later flag or metric edits cannot rewrite historical results.
- The browser ingest API and SDK payload contracts are unchanged.

The package is release-ready only after the repository gates, packed-tarball allowlist, fresh pinned `pnpm dlx`, MCP initialize, 104-tool list, and one safe project read all pass for the exact registry version.
