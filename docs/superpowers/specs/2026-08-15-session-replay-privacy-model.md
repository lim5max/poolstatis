# Session Replay v1 — Threat and Privacy Model

**Status:** implementation contract for the first functional vertical slice.
**Scope:** real DOM/time replay only. Browser Experience aggregate maps remain
separate. Gaze, webcam, audio, canvas pixels, network/console capture and a
screen-video format are out of scope.

## Recorder and player contract

- Recorder: `@rrweb/record@2.1.1`.
- Player: `@rrweb/replay@2.1.1`.
- Shared types: `@rrweb/types@2.1.1`.
- License: MIT.
- The legacy `rrweb` convenience package is not used; recorder and player are
  imported from their direct supported packages.
- The source release candidate is `@poolstatis/sdk@0.4.0`; its opt-in export is
  `@poolstatis/sdk/replay`. Published `0.3.0` does not have that export and must not be documented as installable
  until exact registry read-back. The explicit subpath means the core
  SDK and the existing `/i/v1/*` event contracts do not import or download
  rrweb.
- Recorded events remain untrusted after server validation. Playback uses
  rrweb-snapshot's official scriptless iframe (`sandbox="allow-same-origin"`
  without `allow-scripts`) and never enables `UNSAFE_replayCanvas` or
  `UNSAFE_allowUnprotectedRebuild`. Forms, navigation targets, executable DOM
  and network-bearing attributes/CSS are removed, and player interaction is
  disabled.
- An additional outer opaque-origin iframe is not compatible with the current
  supported rrweb API: its nested sandbox inherits an opaque origin, so
  `createSandboxedIframe()` cannot access `contentDocument` and reconstruction
  fails. V1 therefore verifies the exact upstream scriptless sandbox at
  runtime rather than claiming an unsupported opaque wrapper.

The version decision is based on the rrweb 2.1.1 release and the current
official record/replay guide checked on 2026-08-15. The prior 2.1.0 planning
document is historical and is not the package contract for this implementation.

Official sources checked on 2026-08-15:

- [rrweb 2.1.1 releases](https://github.com/rrweb-io/rrweb/releases)
- [record/replay guide](https://github.com/rrweb-io/rrweb/blob/main/guide.md)
- [`rrweb-snapshot` sandbox contract](https://www.npmjs.com/package/rrweb-snapshot)
- [MIT license](https://github.com/rrweb-io/rrweb/blob/main/LICENSE)

## Protected assets and trust boundaries

Protected assets are customer DOM structure, rendered text, input values,
identity, secrets, tenant isolation, API credentials, replay object bytes and
the admin origin. The trust boundaries are:

1. Host application policy and explicit end-user replay consent.
2. rrweb output and the browser upload queue.
3. Public write-only replay ingest authenticated by `pk_`.
4. PostgreSQL manifest metadata and the `ReplayObjectStore` payload seam.
5. Secret/personal-token read API and metadata-only MCP tools.
6. The sandboxed admin player.

rrweb output, stored objects and database metadata are treated as attacker
controlled. A write-only ingest key never grants replay read access.

## Threats and mandatory controls

| Threat | Control |
| --- | --- |
| Recording without user intent | `ReplayRecorder.start()` requires affirmative consent with a non-empty consent version and an exact host-policy match. Denial fails before the rrweb import, observers, manifest or network request. Withdrawal racing with initialization prevents rrweb startup, retains the manifest/upload token across bounded transport failure and lets a repeated `withdraw()` finish deletion. |
| Host enables replay on the wrong domain | SDK requires an explicit allow-list of exact hostnames. The server compares a supplied browser `Origin`, when present, with the declared hostname. No wildcard or raw URL policy is accepted. |
| Password/payment/form/contenteditable disclosure | Password, payment/auth/autocomplete targets are blocked. All inputs, source-5 input mutations and contenteditable values (including boolean attributes) are masked independently by SDK and server. |
| PII, tokens or secrets in visible DOM text | Default `text: masked` fail-closes every non-structural string field, including unknown future rrweb fields. `text: visible` is explicit, but server redaction still masks secret/token/JWT/email/payment-looking strings and all input-like data. Hosts can tighten with `data-poolstatis-mask`, `.rr-mask` and configured mask selectors. |
| Sensitive component subtree | `data-poolstatis-block`, `.rr-block` and configured simple tag/class/id/attribute block selectors produce geometry-only placeholders. The normalized selector policy is stored with the manifest so the server independently repeats it; payment/auth selectors are always included. Crafted case-fold duplicate attributes block the whole node before selector/text evaluation, preventing normalization-order bypasses. |
| Raw URL/query/hash or signed asset leak | The SDK replaces navigation URLs with a synthetic origin plus a developer-provided finite route key. The server removes query/hash, credentials, `javascript:`, `data:`, `blob:`, external URLs, CSS imports/URLs/content, inline handlers, `srcdoc` and network-bearing attributes. `<style>` text, `isStyle` text and rrweb stylesheet/declaration mutations all use the bounded CSS parser. ID/class/custom-property values become deterministic structural tokens; CSS selectors use the same idempotent mapping. |
| Script or request execution in viewer | Payload is revalidated on read. The official rrweb iframe has `allow-same-origin` only and no script capability; unsafe rrweb modes and user interaction are disabled. Malicious scripts, handlers, forms and URLs are removed before storage and again before delivery. Runtime rejects any unexpected sandbox attribute. |
| Tenant/object-key traversal | Every manifest read is project + environment scoped. Object keys are server-generated UUID paths and the filesystem adapter rejects traversal and symlinks. MCP never returns payload/object keys. |
| Replay flood/decompression bomb | Bounded JSON body, events/chunk, bytes/chunk, chunks/session, session bytes, duration, pointer sampling, memory queue and retry attempts. Files are size-checked through a no-follow handle before bounded allocation. V1 accepts uncompressed JSON only, so compressed bombs never reach storage. |
| Duplicate/reordered retry corruption | Chunks are idempotent by `(replay_id, sequence, checksum)`. Same checksum is accepted; a different checksum is `409`. Completion requires contiguous sequences, monotonic timestamps and an initial full snapshot. |
| Consent withdrawal or expired retention remains readable | Reads reject an elapsed `delete_after` immediately. One absolute deadline starts before DB connection acquisition and object loading; playback holds a shared manifest lock through object validation, append-only view audit and only the remaining HTTP response lease. Abort/deadline rolls back that audit and closes the response. Withdrawal takes the conflicting lock, so its completion is a read barrier without allowing stalled readers or an exhausted pool to retain a connection indefinitely. A retry can authenticate a `deleting` tombstone, while SDK `404/410` after an ambiguous delete is terminal success. Claimed retry jobs with backoff remove committed chunks, crash-orphans and temporary files without poison rows starving later retention. Consent-tombstone recovery remains active even when scheduled retention is disabled. Finalization also scrubs session/distinct/host/token/privacy identifiers from the idempotency tombstone. The original deletion actor is retained only in immutable audit across worker completion. |
| Project deletion leaves replay objects or accepts late writes | Before any external side effect, project deletion atomically raises the replay write barrier, persists a durable no-FK cleanup job and copies snapshot artifact keys into a non-cascading queue. The snapshot trigger first takes a project-row share lock, serializing committed metadata against that barrier: the key is either queued or the insert is rejected. The job checkpoints artifact deletion, EventStore purge, replay purge, project metadata cascade and final replay-prefix sweep, so the always-on privacy recovery loop resumes from every crash window. Manifest creation, upload and completion take a shared project lock and reject once the barrier is raised. Append-only deletion-request/completion audit deliberately keeps the immutable project UUID and actor after that cascade; hosted runtime has only `SELECT/INSERT` on it. |
| Final upload or completion response is lost | Chunks keep stable sequence/checksum idempotency. `stop()` detaches recording separately from finalization, retries transient chunk/complete failures and can be called again after all bounded attempts fail; client totals stop before server chunk/event/byte limits. |
| Data-subject deletion omits DOM-derived data | Exact raw `distinct_id` event purge invokes the same replay prefix purge for that environment and reports `identity_scope: exact_raw_distinct_id`; no unreviewed alias expansion is implied. |
| Existing analytics regression | Replay uses new opt-in routes and SDK entrypoint. Existing `/i/v1/events`, `/i/v1/experience/events`, published SDK fixtures and `207` semantics are unchanged. Replay `4xx` is non-retryable; `408/429/5xx` is retryable under a bounded stable chunk id. |

## v1 limits

- Session duration: 30 minutes.
- Retention: 7 days by default, configurable per recording from 1 to 30 days.
- Normal chunk: at most 500 rrweb events and 512 KiB uncompressed JSON.
- Pagehide: at most one complete request ≤60 KiB with `keepalive`; oversized
  data remains pending/incomplete and is never reported as delivered.
- Upload body: at most 600 KiB JSON.
- Session: at most 120 chunks, 50,000 events and 20 MiB payload.
- Browser memory: at most 5 MiB of queued serialized chunks; oldest unsent
  replay data is dropped and the manifest completes as incomplete.
- Flush cadence: 10 seconds; full checkout every 60 seconds or 10,000 events.
- Pointer samples: at most 20 Hz (`mousemove: 50`).
- Transport attempts: at most four 10-second attempts per chunk, completion or withdrawal
  call with bounded exponential delay; the stable sequence/checksum and final
  sequence are reused, and a later `stop()` can resume finalization.
- List API: at most 100 manifests. Viewer payload: at most 20 MiB and 50,000
  events. MCP returns metadata for at most 100 replays and no DOM payload.

## Privacy posture

This feature necessarily stores a DOM-derived representation and is therefore
more sensitive than Browser Experience. “Privacy-safe” here means deny-by-
default, data minimisation, deterministic masking/blocking, double validation,
bounded retention, auditable privileged reads and isolated playback. It does
not mean that arbitrary visible page text is anonymous. Products must keep the
default text masking unless they have a reviewed purpose and lawful consent for
visible copy.

## Required evidence before merge

- Unit and integration tests for policy gates, generic-string redaction,
  malicious style/input payloads, limits, idempotency, tenant isolation,
  completion retry, concurrent withdrawal/read, subject purge, orphan cleanup,
  append-only audit and retention read barriers.
- Published-SDK compatibility fixture still passes.
- Browser E2E records a full snapshot, layout CSS, DOM mutation, scroll and
  pointer motion, then visibly reconstructs scrollable layout, mutation,
  cursor and scroll in the scriptless sandbox on desktop and mobile without
  application console/network escape.
- Full repository gates and an independent read-only security/code review with
  every Critical and Important finding resolved.
