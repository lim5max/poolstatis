# Task 5 implementer report

## Formal-review correction (`16c57d2` follow-up)

The first implementer commit was **not approval-ready** despite its green suite: the formal reviewer found five P1 gaps (textual IPv6 classification, incomplete Cloud MCP process assertions, missing workspace lock importer, destructive migration cleanup without operator protocol, and global mutable MCP credentials). The claims below are superseded where they conflict with this correction.

The follow-up replaces address string matching with `ipaddr.js` numeric parsing/CIDR controls (including conservative `2001::/23` rejection), adds a same-slug/same-registry/different-data packed-process E2E with exact trend/funnel/isolation/revoke/meter assertions, regenerates the lockfile and verifies frozen offline install, changes migration 023 to abort until a versioned acknowledged preflight cleanup is run, and makes each MCP server a fresh immutable-config instance. The package public export is side-effect-free and ships the actual generated root declaration; CLI remains a separate bin entry. DNS work has a 64-resolution circuit cap because Node's system lookup cannot be cancelled after dispatch.

## RED then GREEN

- RED: `pnpm test test/ssrf-security.test.ts test/api-key-ownership.test.ts test/mcp-cli-config.test.ts` failed as expected: missing `src/security/outbound.ts`, MCP import exited because it read env at module load, and secret key creation accepted `issuedByUserId`.
- RED: `pnpm test test/migration-023-upgrade.test.ts` failed with `api_keys_issued_owner_personal_check` on populated legacy secret/ingest ownership rows.
- GREEN targeted: `pnpm test test/migration-023-upgrade.test.ts test/ssrf-security.test.ts test/posthog-adapter.test.ts test/webhook-outbox.test.ts test/mcp-decision-loop-a.test.ts test/decisions.test.ts test/e2e/decision-loop-a.test.ts test/e2e/decision-loop-b.test.ts test/e2e/decision-loop-c.test.ts` — 21 tests passed.

## Delivered

- `packages/mcp` is a packable `@poolstatis/mcp` CLI. It imports the compiled root MCP runner; it does not maintain a second tool registry. Tarball allowlist also includes the generated root `server.d.ts`; no handwritten signature stub remains. No publication was performed; server package status remains `publish_pending` unless the explicit existing operator switch is set.
- `validateMcpConfig` checks `pt_`/`sk_`, clean HTTPS or loopback HTTP origin and rejects userinfo, query, fragment and non-root paths before stdio opens. Root and package use `runMcpServer`.
- `src/security/outbound.ts` centralizes URL parsing, address classification, per-attempt resolution, all-answer rejection, direct validated-address transport with original Host/SNI, immediate 3xx destruction, bounded streamed bodies and absolute deadline that includes DNS.
- Webhook outbox and PostHog now have no raw-fetch bypass. HTTP context and maintenance outbox receive the exact same `OUTBOUND_ALLOW_LOCAL_HTTP` default-false setting. Controlled local tests opt in explicitly.
- Migration 023 clears non-personal legacy owner annotations before the personal-only constraint and retains same-org personal owners. `CreateApiKeyInput` is discriminated: hosted personal requires `issuedByUserId`; ownerless personal needs explicit `legacySelfHost: true`.

## Security validation rubric (SSRF and package candidate)

- [x] Source: tenant connector URLs and stored encrypted legacy destinations; sink: WebhookOutbox/PostHog outbound transport. Both call `requestOutbound` on every delivery/query.
- [x] URL/address controls: credentials/fragments/HTTP policy, private/special-use IPv4, non-global/special-use IPv6, empty/mixed DNS results and mapped addresses fail closed. Targeted deterministic resolver tests cover malicious forms and IANA special-use examples.
- [x] Connection control: all resolved answers are checked, connection uses the selected validated address, while Host and TLS `servername` retain the original hostname. Caller Host override is overwritten.
- [x] Response/error controls: 3xx rejects at headers and destroys response; body limits destroy streamed overflow; deadline includes resolver and response time; persisted connector errors are stable sanitized codes without URLs/secrets.
- [x] Package provenance: packed tarball content was listed and a child stdio process completed MCP initialize/list-tools using the package artifact. It contains no source maps, repository files, or credentials.

Static source/control/sink assessment: attacker-controlled configured URL crosses tenant-to-server-network boundary through `WebhookService.configure`/stored destination and `PostHogAdapter.configure`/stored host. The shared transport is the only production sink for both paths; legacy values are revalidated immediately before each connection. Remaining operational proof gap: production DNS/TLS deployment policy is environment-specific, but local transport and deterministic resolver behavior are dynamically covered.

## Completion commands

- `pnpm typecheck` passed (also runs compile-level API-key negative tests).
- `pnpm test` passed (full root suite; exit 0).
- `pnpm --dir web test --run` passed: 17 tests.
- `pnpm --dir web build` passed.
- `pnpm --dir sdk test` passed: 20 tests.
- `pnpm install --frozen-lockfile --offline` passed with the `packages/mcp` importer present.
- `pnpm --dir packages/mcp build && pnpm --dir packages/mcp pack --pack-destination /tmp` passed. Tarball listing contained only the runtime/docs/package artifacts plus generated declaration. A packed child process executes tenant discovery/query/revoke assertions in the root suite.
- `docker compose -f docker-compose.selfhost.yml config >/dev/null` passed.
- `git diff --check` passed.

## Limitations

- No npm publication or external deployment was attempted.
- Task 3 P2s remain tracked outside this task: future event-row suppression must derive ledger quantity from actual inserts; the month-rollover test remains structural.
