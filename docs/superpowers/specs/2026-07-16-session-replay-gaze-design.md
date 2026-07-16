# Session Replay and Gaze Attention v1 — Design

## Decision

Poolstatis will add two optional, consent-separated browser modules on top of
the existing Browser Experience timeline:

1. **Session Replay** records rrweb full snapshots, DOM mutations, scroll,
   cursor movement, clicks and explicitly permitted text/input values, then
   replays the page as a time-based DOM session in a sandboxed viewer.
2. **Gaze Attention** uses the webcam only inside the browser, estimates gaze
   with MediaPipe Face Landmarker plus a Poolstatis calibration model, and
   uploads normalized gaze samples. Camera frames are never uploaded or
   persisted.

The existing labelled click map and privacy-safe session timeline remain
independent. Products may enable them without enabling replay or gaze.

"Video replay" in v1 means rrweb's time-based reconstruction of the rendered
DOM. Poolstatis does not record an MP4, screen-share stream, microphone audio,
or webcam video.

The public source repository ships a local-filesystem object-store adapter for
development and self-hosting. The storage interface is intentionally
S3-compatible in shape so the private Cloud data plane can use encrypted object
storage without changing SDK, REST, MCP, or viewer contracts. DOM chunks never
enter the immutable `events` table.

## Goals

- Capture full DOM snapshots and incremental mutations required to reconstruct
  a session.
- Record scroll, click and sampled cursor paths with rrweb timing.
- Support visible text and input-value capture only under an explicit privacy
  policy; always suppress passwords and payment/auth secrets.
- Play a complete session in the admin with pause, seek, speed and cursor tail.
- Build click, cursor and real webcam-derived gaze heatmaps with dwell time.
- Preserve one opaque session id across Browser Experience, replay and gaze.
- Expose replay metadata, attention maps and deletion through REST and MCP.
- Make denial and consent withdrawal fail closed and immediately effective.
- Keep replay upload/storage pressure isolated from normal analytics ingest and
  Query DSL latency.
- Verify the complete workflow against Basic Project and, after adding a real
  consent UI, the Poolstatis landing page.

## Non-goals

- Uploading camera frames, webcam video, microphone audio or a pixel-level
  screen recording.
- Network request bodies, console logs, JavaScript stacks, cookies, local
  storage, authorization headers or arbitrary raw URLs.
- Cross-origin iframe, canvas or WebGL replay in v1.
- Pretending gaze estimates are medical- or research-grade eye tracking. The
  API reports calibration error and refuses to label a session as gaze-tracked
  when quality is below the configured threshold.
- Storing DOM replay payloads in PostgreSQL or ClickHouse.
- Serving raw replay chunks through MCP.

## User-facing consent contract

Browser Experience, Session Replay and Gaze Attention have three separate
consent decisions. Enabling the lightweight click timeline does not imply
replay consent, and enabling replay does not request camera access.

`ReplayRecorder.start()` and `GazeTracker.start()` require affirmative consent
at call time. Gaze additionally requires a user gesture and the browser's
camera permission. Both modules expose `stop({ withdraw: true })`; withdrawal:

- detaches observers and stops camera tracks immediately;
- aborts in-flight requests and clears bounded memory queues;
- tombstones the server session so it is unreadable immediately;
- schedules physical deletion of chunks, derived cells and indexes;
- rejects late or retried uploads for the tombstoned session.

The SDK is deny-by-default. rrweb, MediaPipe, the model and workers are loaded
with dynamic imports only after the relevant consent and sampling decision.
Unsampled sessions do not download replay/gaze code or create a manifest.

## Privacy policy

Replay configuration is explicit and versioned:

```ts
interface ReplayPrivacyPolicy {
  version: string;
  text: 'masked' | 'visible';
  inputs: 'masked' | 'allowlisted';
  allowInputSelectors?: string[];
  maskSelectors: string[];
  blockSelectors: string[];
}
```

Defaults are `text: 'masked'` and `inputs: 'masked'`. A product may choose
`text: 'visible'` to preserve ordinary rendered copy and may allowlist specific
non-sensitive input selectors. The following remain blocked regardless of
configuration:

- password, hidden, email, tel and payment-oriented inputs;
- autocomplete values containing `password`, `cc-`, `one-time-code` or auth
  tokens;
- elements marked `.rr-block`, `.rr-mask`, `data-poolstatis-block` or
  `data-poolstatis-mask`;
- query strings, fragments, `javascript:` URLs, signed URLs, data URLs,
  inline event handlers and secret-looking URL parameters;
- canvas pixels, cross-origin iframe contents, fonts, inline images and
  console/network plugins.

The SDK applies the policy before an rrweb event enters its queue. The replay
ingest validates and sanitizes again before persistence. Invalid or absent
policy data prevents recording rather than falling back to rrweb defaults.
Remote configuration may tighten a policy but cannot enable broader text/input
capture than the application-supplied policy.

## Browser packages

### Shared session identity

`createExperienceSession()` returns one opaque session id and consent-aware
controller. The id is passed to `BrowserExperience`, `ReplayRecorder` and
`GazeTracker`. Existing constructors continue to accept an explicit
`sessionId`, so the change is backward compatible.

### `@poolstatis/sdk/replay`

The optional export wraps `@rrweb/record`. It configures periodic checkout
snapshots, sampled pointer movement, bounded chunks, privacy transforms and
upload retry. It never becomes part of the core SDK bundle.

Recorder defaults:

- a new full checkout at least every 60 seconds or 10,000 emitted events;
- cursor samples no faster than every 50 ms;
- a chunk every 10 seconds, 500 events or 512 KiB compressed;
- at most 5 MiB queued in memory per tab;
- `recordCanvas=false`, `recordCrossOriginIframes=false`,
  `inlineImages=false`, `collectFonts=false` and no plugins;
- `CompressionStream('gzip')` when available, with an injectable compressor
  fallback for supported older environments.

Each chunk contains a schema version, replay id, sequence, first/last rrweb
timestamp, event count, uncompressed byte size, SHA-256 checksum and whether it
contains a full checkout snapshot. Uploads are idempotent by
`(replay_id, sequence, checksum)`. A different checksum for the same sequence
is a conflict.

### `@poolstatis/sdk/gaze`

The optional export uses a `GazeProvider` interface. The production provider
loads `@mediapipe/tasks-vision` and a pinned Face Landmarker model in a Web
Worker after consent. This avoids WebGazer, whose official maintenance ended
in February 2026.

Gaze requires a nine-point calibration overlay. The provider extracts iris
position relative to eye corners plus head-pose features and fits a small
regularized regression from those features to normalized viewport
coordinates. Calibration captures multiple samples per point, rejects
outliers, and reports median holdout error. Recording starts only when the
median normalized error is at most `0.10`; otherwise the UI reports
`needs_calibration`.

Accepted gaze samples are capped at 10 Hz, exponentially smoothed, clamped to
the viewport and discarded when confidence is low, the tab is hidden or no
face is present. Camera frames stay in the worker/browser. Only
`{timestamp, x, y, confidence}` is passed to the recorder.

The provider and model path are injectable so unit and browser E2E tests can
use deterministic synthetic landmarks without a real person's camera.

## Attention aggregation

High-frequency cursor and gaze samples do not become analytics events. The
browser aggregates them into fixed 64x64 viewport cells per route and source
(`click`, `cursor`, `gaze`) with sample count and dwell milliseconds, then
uploads bounded deltas alongside replay metadata.

Migration `017_session_replay.sql` introduces:

- `replay_sessions`: authoritative project/env/surface/session manifest,
  consent and policy versions, sampling decision, status, quality metrics,
  byte/chunk counts, timestamps, retention and deletion state;
- `replay_chunks`: object key, ordered sequence, checksum, sizes, event/time
  range and checkout marker; no payload bytes;
- `experience_attention_cells`: project/env/surface/session/route/source/cell
  aggregates with count and dwell time;
- `replay_audit_log`: append-only viewer, export and deletion access records;
- deletion retry fields and indexes required for retention workers.

`attention_map` is a new Query DSL branch. It accepts a registered Experience
surface, source (`click`, `cursor`, `gaze`, or `combined`), time range, grid size
and environment. The service folds 64x64 stored cells into the requested grid
and returns counts, dwell time, sessions, actors and calibration-quality
summary. `interaction_map` remains backward compatible for click-only callers.

## Replay storage and services

Replay payloads use a new `ReplayObjectStore` seam with `put`, `get`, `delete`
and `listMultipart`/cleanup operations. The self-host adapter writes beneath a
configured root using server-generated UUID paths and atomic rename. Paths from
the browser are never used as filesystem or object keys.

Replay uploads run in a separate optional process (`pnpm replay:serve`) with a
separate port, body limits, rate-limit lane, connection pool and storage
volume. Saturating it cannot consume the normal API's body parser, buffer,
worker pool or analytics rate-limit budget.

Public ingest flow:

1. Create a session with an ingest key, surface, opaque session id, consent and
   privacy-policy hashes. The service returns a replay id and short-lived,
   session-scoped upload/delete token.
2. Upload ordered gzip chunks and attention deltas. The service verifies token
   scope, compressed and decompressed sizes, checksum, schema and sanitizer.
3. Complete the manifest. A replay becomes `playable` only when sequence and
   timestamp ranges are contiguous and at least one full snapshot anchors each
   playback window.
4. Incomplete sessions remain searchable as `incomplete` but are never
   partially replayed as though complete.

Hard limits cover compressed bytes/chunk, decompressed bytes/chunk,
decompression ratio, events/chunk, bytes/minute, bytes/session, session
duration and sessions/project/day. A storage outage applies bounded retry/drop
policy to replay only; normal event ingest continues.

PostgreSQL is authoritative for manifests and tombstones. Object storage is
the payload source; ClickHouse, when added by Cloud, may contain only a
rebuildable search/attention index. A tombstone blocks reads before physical
deletion begins. Retention retries until the manifest, chunks, derived cells
and orphan multipart uploads are gone.

## REST and MCP

Replay ingest uses the isolated replay service:

- `POST /r/v1/sessions`
- `PUT /r/v1/sessions/:id/chunks/:sequence`
- `POST /r/v1/sessions/:id/attention`
- `POST /r/v1/sessions/:id/complete`
- `DELETE /r/v1/sessions/:id`

Platform endpoints use secret/personal tokens:

- `GET /api/v1/projects/:slug/replays`
- `GET /api/v1/projects/:slug/replays/:id`
- `GET /api/v1/projects/:slug/replays/:id/events`
- `DELETE /api/v1/projects/:slug/replays/:id`
- `POST /api/v1/projects/:slug/query` with `kind: 'attention_map'`

The events endpoint is reserved for the admin viewer, returns a bounded
validated stream and never returns storage credentials. Every view/delete is
audited.

MCP adds `list_session_replays`, `get_session_replay`,
`delete_session_replay` and `query_attention_map`. Replay tools return
metadata, completeness, quality, consent/policy version and an admin viewer
reference. They never return DOM chunks, captured text or input values.

## Sandboxed player

The Experience admin gains Session Replays and Attention Map panels. Replays
are discoverable by surface, route, time, status and session id; the user no
longer needs to know a session id in advance.

Playback runs inside an iframe with `sandbox="allow-scripts"` and no
`allow-same-origin`, forms, popups, navigation or downloads. Its CSP uses
`default-src 'none'`, `connect-src 'none'`, local scripts/styles only and
`img-src data: blob:`. The parent supplies already validated events through a
one-time `postMessage` channel. The player uses `@rrweb/replay` with
`UNSAFE_replayCanvas=false`, shows cursor tail, and supports seek, pause and
speed. Serialized scripts and handlers never execute.

The same view overlays optional gaze/cursor trails and links to the existing
labelled interaction timeline. Project and environment checks occur before
every metadata, payload and delete operation; matching session ids in another
tenant confer no access.

## Basic Project and landing integration

Basic Project replaces the build-time Experience flag with visible independent
controls for lightweight analytics, Session Replay and Gaze Attention. Replay
starts only after allow; gaze additionally shows the camera permission and
calibration flow. React StrictMode remounts must still create exactly one
recorder and one camera stream.

The demo marks client names, notes, composer secrets and auth/payment fixtures
as masked/blocked. A deliberately non-sensitive allowlisted input proves that
input capture works. Creating/editing a brief proves DOM mutation replay;
scroll and cursor movement prove the time-based path; a deterministic gaze
provider proves map integration in automated E2E.

The Poolstatis landing is instrumented only after it has a visible
allow/deny/withdraw control and disclosure. Its waitlist form is fully blocked,
including email, company and free-text use-case fields. Gaze is not enabled on
the landing because it provides no justified product value there.

## Failure handling and security

- No consent, invalid policy, missing replay storage or failed sampling means
  no recorder, observer, camera, model download or request.
- Withdrawal aborts and tombstones; late chunks receive `410 Gone`.
- Duplicate chunks with the same checksum are accepted idempotently; a changed
  chunk at the same sequence returns `409`.
- Missing/reordered/truncated chunks keep the manifest `incomplete`.
- Malformed rrweb events, executable URLs/handlers, cross-project ids,
  decompression bombs and oversized sessions are rejected before persistence.
- The viewer cannot execute scripts, submit forms, navigate, access parent
  credentials or make network requests.
- Storage deletion failures remain retryable and readable state stays denied.
- Replay overload never shares queues or quotas with `/i/v1/events`.

## Verification and release gates

Development follows TDD. The minimum release evidence is:

1. **SDK unit tests:** deny-by-default, dynamic imports, privacy modes,
   password/payment invariants, chunk boundaries, checksums, retry,
   withdrawal, StrictMode-safe lifecycle, cursor sampling, gaze calibration,
   low-confidence rejection and camera-track cleanup.
2. **Backend integration tests:** real PostgreSQL manifests, idempotent chunk
   writes, cross-project isolation, sanitizer, gzip/decompression limits,
   contiguous completeness, attention folding, tombstones, retention and
   object-store retry.
3. **MCP tests:** tool discovery and structured metadata/map responses; prove
   raw DOM never appears in MCP output.
4. **Viewer security tests:** scripts, `onerror`, `javascript:` URLs, external
   assets and malicious forms cannot execute or make requests in playback.
5. **Basic Project browser E2E:** allow, record snapshot/mutations/text and an
   allowlisted input, mask sensitive fixtures, capture cursor/gaze, complete,
   discover, replay, withdraw and delete. Inspect decompressed raw chunks to
   prove allowed content exists and forbidden content does not.
6. **Landing E2E:** deny-by-default, explicit allow/withdraw, waitlist fields
   absent from chunks and deletion completed.
7. **Performance/failure E2E:** compare analytics ingest/query p95 with replay
   off and saturated; degradation must be at most 5%, with no extra analytics
   5xx. Kill replay service/storage during upload and prove analytics remains
   healthy and SDK memory stays bounded.
8. **Independent review:** separate privacy/security, SDK correctness and
   backend/storage reviewers; resolve every Critical and Important finding.

Before handoff run root typecheck/tests, SDK tests/build, web build, Basic
Project tests/build, landing tests/build and both browser E2E suites. No feature
is called shipped until the admin player visibly reproduces a recorded Basic
Project mutation and the attention map contains verified cursor and gaze data.

## Delivery order

1. Storage seam, schema, manifest lifecycle and isolated replay service.
2. Replay SDK with privacy sanitizer and chunk protocol.
3. Attention aggregates and Query DSL/MCP tools.
4. Sandboxed admin player and replay discovery.
5. MediaPipe gaze provider, calibration and overlays.
6. Basic Project consent/instrumentation and complete E2E.
7. Landing consent/replay integration without gaze.
8. Failure/performance tests and independent reviews.

## Technology references

- [rrweb record/replay and privacy options](https://github.com/rrweb-io/rrweb/blob/master/guide.md)
- [MediaPipe Face Landmarker for Web](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js)
- [Browser camera permission and secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [WebGazer maintenance status](https://github.com/brownhci/WebGazer/blob/master/README.md)
