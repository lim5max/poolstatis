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
- The deprecated `rrweb` convenience package is not used.
- The SDK recorder is an explicit `@poolstatis/sdk/replay` export, so the core
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
| Recording without user intent | `ReplayRecorder.start()` requires affirmative consent with a non-empty consent version and an exact host-policy match. Denial fails before the rrweb import, observers, manifest or network request. |
| Host enables replay on the wrong domain | SDK requires an explicit allow-list of exact hostnames. The server compares a supplied browser `Origin`, when present, with the declared hostname. No wildcard or raw URL policy is accepted. |
| Password/payment/form/contenteditable disclosure | Password, payment/auth/autocomplete targets are blocked. All inputs and textareas are masked in v1. Contenteditable is always masked. Server sanitization removes input values again. |
| PII, tokens or secrets in visible DOM text | All text is masked by default. `text: visible` is explicit, but server redaction still masks secret/token/JWT/email/payment-looking strings. Hosts can tighten with `data-poolstatis-mask`, `.rr-mask` and configured mask selectors. |
| Sensitive component subtree | `data-poolstatis-block`, `.rr-block` and configured block selectors produce geometry-only placeholders. Payment/auth selectors are always included. |
| Raw URL/query/hash or signed asset leak | The SDK replaces navigation URLs with a synthetic origin plus a developer-provided finite route key. The server removes query/hash, credentials, `javascript:`, `data:`, `blob:`, external URLs, CSS imports/URLs/content, inline handlers, `srcdoc` and network-bearing attributes. ID/class/custom-property values become deterministic structural tokens; the bounded CSS allowlist rewrites selectors to the same idempotent mapping. |
| Script or request execution in viewer | Payload is revalidated on read. The official rrweb iframe has `allow-same-origin` only and no script capability; unsafe rrweb modes and user interaction are disabled. Malicious scripts, handlers, forms and URLs are removed before storage and again before delivery. Runtime rejects any unexpected sandbox attribute. |
| Tenant/object-key traversal | Every manifest read is project + environment scoped. Object keys are server-generated UUID paths and the filesystem adapter rejects traversal and symlinks. MCP never returns payload/object keys. |
| Replay flood/decompression bomb | Bounded JSON body, events/chunk, bytes/chunk, chunks/session, session bytes, duration, pointer sampling, memory queue and retry attempts. V1 accepts uncompressed JSON only, so compressed bombs never reach storage. |
| Duplicate/reordered retry corruption | Chunks are idempotent by `(replay_id, sequence, checksum)`. Same checksum is accepted; a different checksum is `409`. Completion requires contiguous sequences, monotonic timestamps and an initial full snapshot. |
| Consent withdrawal or expired retention remains readable | Withdrawal tombstones first, then deletes objects. Tombstoned sessions return `410` before physical cleanup. Retention uses a bounded retryable worker and server-owned `delete_after`. |
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
- Transport attempts: at most four per chunk with bounded exponential delay;
  the stable sequence and checksum are reused.
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

- Unit and integration tests for policy gates, redaction, malicious payloads,
  limits, idempotency, tenant isolation, completion, withdrawal and retention.
- Published-SDK compatibility fixture still passes.
- Browser E2E records a full snapshot, layout CSS, DOM mutation, scroll and
  pointer motion, then visibly reconstructs scrollable layout, mutation,
  cursor and scroll in the scriptless sandbox on desktop and mobile without
  application console/network escape.
- Full repository gates and an independent read-only security/code review with
  every Critical and Important finding resolved.
