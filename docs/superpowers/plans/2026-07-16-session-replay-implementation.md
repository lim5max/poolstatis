# Session Replay v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship consent-gated rrweb recording, isolated durable chunk storage, replay discovery, MCP metadata and a sandboxed admin player, proven end-to-end on Basic Project and the Poolstatis landing.

**Architecture:** A separate replay HTTP process authenticates ingest keys, stores authoritative manifests in PostgreSQL and payload chunks behind `ReplayObjectStore`; self-host uses an atomic filesystem adapter. The optional SDK entrypoint sanitizes and chunks rrweb events. The Platform API exposes metadata and a bounded viewer stream, while the admin renders it inside an opaque-origin sandbox.

**Tech Stack:** TypeScript 5.8, Fastify 5, PostgreSQL, rrweb 2.1.0 (`@rrweb/record`, `@rrweb/replay`, `@rrweb/packer`), React 19, Vite 6/8, Vitest 3, Node test runner, Playwright browser E2E.

## Global Constraints

- DOM replay payload bytes never enter `events`, `replay_sessions`, `replay_chunks` or ClickHouse metadata tables.
- Default privacy is `text: 'masked'`, `inputs: 'masked'`; password, hidden, email, tel, payment, auth-token and one-time-code values are never recordable.
- `recordCanvas=false`, `recordCrossOriginIframes=false`, `inlineImages=false`, `collectFonts=false`, `UNSAFE_replayCanvas=false` and no console/network plugins.
- A chunk is emitted every 10 seconds, 500 rrweb events or 512 KiB compressed; one tab may queue at most 5 MiB.
- A full checkout occurs at least every 60 seconds or 10,000 events.
- Replay upload runs on a separate process, body parser, database pool, quota lane and port from `/i/v1/events`.
- Viewer iframe uses `sandbox="allow-scripts"` without `allow-same-origin`, forms, navigation, popups or downloads; `connect-src 'none'`.
- Withdrawal tombstones immediately and returns `410 Gone` for late chunks.
- Preserve all unrelated dirty-worktree changes; stage and commit only files named by the current task.

---

### Task 1: Replay schema and shared contracts

**Files:**
- Create: `migrations/017_session_replay.sql`
- Create: `src/replay/types.ts`
- Modify: `src/schemas.ts`
- Test: `test/replay-schema.test.ts`

**Interfaces:**
- Produces: `ReplaySessionStatus`, `ReplayPrivacyPolicy`, `ReplayChunkDescriptor`, `ReplaySession`, `createReplaySessionSchema`, `completeReplaySessionSchema`.
- Consumes: existing project, environment and Experience surface ids.

- [ ] **Step 1: Write the failing migration/schema tests**

```ts
import { describe, expect, it } from 'vitest';
import { createReplaySessionSchema } from '../src/schemas.js';

describe('replay schemas', () => {
  it('rejects a policy that attempts to record password inputs', () => {
    expect(() => createReplaySessionSchema.parse({
      surface: 'briefdesk_workspace',
      session_id: 'session-1',
      distinct_id: 'actor-1',
      consent_version: 'replay-v1',
      policy: {
        version: 'policy-v1', text: 'visible', inputs: 'allowlisted',
        allowInputSelectors: ['input[type=password]'], maskSelectors: [], blockSelectors: [],
      },
      sample_probability: 1,
    })).toThrow();
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- test/replay-schema.test.ts`

Expected: FAIL because `createReplaySessionSchema` and replay tables do not exist.

- [ ] **Step 3: Add the authoritative metadata tables**

Create `migrations/017_session_replay.sql` with project foreign keys, unique
`(project_id, env, replay_id)`, unique `(replay_id, sequence)`, status CHECK,
positive byte/count CHECKs, `deleted_at`, `delete_attempts`, `delete_after`, and
indexes for project/time/status and retention. Include these tables:

```sql
CREATE TABLE replay_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  surface_id uuid NOT NULL REFERENCES experience_surfaces(id) ON DELETE RESTRICT,
  env text NOT NULL,
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  distinct_id text NOT NULL CHECK (length(distinct_id) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'recording'
    CHECK (status IN ('recording','complete','incomplete','deleting','deleted')),
  consent_version text NOT NULL,
  policy_version text NOT NULL,
  policy_hash text NOT NULL,
  sample_probability double precision NOT NULL CHECK (sample_probability BETWEEN 0 AND 1),
  upload_token_hash text NOT NULL,
  upload_token_expires_at timestamptz NOT NULL,
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  compressed_bytes bigint NOT NULL DEFAULT 0 CHECK (compressed_bytes >= 0),
  uncompressed_bytes bigint NOT NULL DEFAULT 0 CHECK (uncompressed_bytes >= 0),
  gaze_calibration_error double precision
    CHECK (gaze_calibration_error IS NULL OR gaze_calibration_error BETWEEN 0 AND 1),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  delete_after timestamptz NOT NULL,
  deleted_at timestamptz,
  delete_attempts integer NOT NULL DEFAULT 0,
  last_delete_error text
);

CREATE TABLE replay_chunks (
  replay_id uuid NOT NULL REFERENCES replay_sessions(replay_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  object_key text NOT NULL UNIQUE,
  checksum text NOT NULL,
  compressed_bytes integer NOT NULL CHECK (compressed_bytes > 0),
  uncompressed_bytes integer NOT NULL CHECK (uncompressed_bytes > 0),
  event_count integer NOT NULL CHECK (event_count > 0),
  first_timestamp bigint NOT NULL,
  last_timestamp bigint NOT NULL,
  has_checkout boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replay_id, sequence)
);

CREATE TABLE replay_audit_log (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  replay_id uuid NOT NULL,
  actor_key_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('view','delete','export')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE experience_attention_cells (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  replay_id uuid NOT NULL REFERENCES replay_sessions(replay_id) ON DELETE CASCADE,
  env text NOT NULL,
  surface_id uuid NOT NULL REFERENCES experience_surfaces(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  distinct_id text NOT NULL,
  route text NOT NULL,
  source text NOT NULL CHECK (source IN ('click','cursor','gaze')),
  cell_x smallint NOT NULL CHECK (cell_x BETWEEN 0 AND 63),
  cell_y smallint NOT NULL CHECK (cell_y BETWEEN 0 AND 63),
  sample_count integer NOT NULL CHECK (sample_count > 0),
  dwell_ms bigint NOT NULL CHECK (dwell_ms >= 0),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (replay_id, route, source, cell_x, cell_y)
);

CREATE TABLE replay_attention_batches (
  replay_id uuid NOT NULL REFERENCES replay_sessions(replay_id) ON DELETE CASCADE,
  batch_id text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replay_id, batch_id)
);

CREATE INDEX replay_sessions_project_started_idx
  ON replay_sessions (project_id, env, started_at DESC);
CREATE INDEX replay_sessions_retention_idx
  ON replay_sessions (status, delete_after);
CREATE INDEX experience_attention_query_idx
  ON experience_attention_cells
  (project_id, env, surface_id, source, last_seen_at);
CREATE INDEX replay_audit_project_time_idx
  ON replay_audit_log (project_id, created_at DESC);
```

- [ ] **Step 4: Add exact TypeScript contracts and Zod guards**

Define the policy union and reject forbidden allowlist selectors before any
service call. `ReplayChunkDescriptor` contains `sequence`, `checksum`,
`compressed_bytes`, `uncompressed_bytes`, `event_count`, `first_timestamp`,
`last_timestamp`, and `has_checkout`.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test -- test/replay-schema.test.ts && pnpm typecheck`

Expected: focused tests and typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/017_session_replay.sql src/replay/types.ts src/schemas.ts test/replay-schema.test.ts
git commit -m "feat: добавить схему session replay"
```

### Task 2: Atomic replay object-store seam

**Files:**
- Create: `src/replay/objectStore.ts`
- Create: `src/replay/filesystemObjectStore.ts`
- Test: `test/replayObjectStore.test.ts`

**Interfaces:**
- Produces: `ReplayObjectStore`, `FilesystemReplayObjectStore`.
- Consumes: server-generated object keys only.

- [ ] **Step 1: Write failing traversal, atomicity and delete tests**

```ts
it('rejects traversal and atomically round-trips one chunk', async () => {
  const store = new FilesystemReplayObjectStore(root);
  await expect(store.put('../escape', bytes)).rejects.toThrow('invalid replay object key');
  await store.put('ab/replay/chunk-0.gz', bytes);
  expect(await store.get('ab/replay/chunk-0.gz')).toEqual(bytes);
  await store.delete('ab/replay/chunk-0.gz');
  await expect(store.get('ab/replay/chunk-0.gz')).rejects.toMatchObject({ code: 'ENOENT' });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- test/replayObjectStore.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the focused interface**

```ts
export interface ReplayObjectStore {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}
```

The filesystem adapter must validate `^[a-f0-9-]+/[a-f0-9-]+/[0-9]+\.json\.gz$`,
create parent directories, write to a sibling random temporary file with
`flag: 'wx'`, fsync, rename atomically and remove stale temporary files on
startup. `get` rejects symlinks and verifies the resolved path remains below
the configured root.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test -- test/replayObjectStore.test.ts`

Expected: all object-store tests PASS and no file appears outside the temp root.

- [ ] **Step 5: Commit**

```bash
git add src/replay/objectStore.ts src/replay/filesystemObjectStore.ts test/replayObjectStore.test.ts
git commit -m "feat: добавить replay object store"
```

### Task 3: Fail-closed rrweb payload sanitizer

**Files:**
- Create: `src/replay/sanitizeReplay.ts`
- Test: `test/replaySanitizer.test.ts`

**Interfaces:**
- Produces: `sanitizeReplayEvents(input: unknown, limits: ReplayPayloadLimits): SanitizedReplayPayload`.
- Consumes: decompressed JSON only after byte/ratio checks.

- [ ] **Step 1: Write a malicious fixture test**

The fixture must contain visible allowed text plus password/email/hidden values,
`onerror`, `javascript:`, signed `src`, CSS `url()`, a data URL and an external
image. Assert allowed text remains and every forbidden literal is absent from
`JSON.stringify(result)`.

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- test/replaySanitizer.test.ts`

Expected: FAIL because the sanitizer is missing.

- [ ] **Step 3: Implement a strict recursive sanitizer**

Reject non-arrays, excessive depth/nodes/strings and malformed rrweb event
envelopes. Strip keys beginning with `on`, network-bearing attributes and CSS
URLs; convert forbidden URL values to `about:blank`; enforce password/payment
masking even if a client claims a broader policy. Return frozen plain data,
never class instances or prototypes from input.

- [ ] **Step 4: Verify GREEN and fuzz malformed objects**

Run: `pnpm test -- test/replaySanitizer.test.ts`

Expected: PASS for valid rrweb events; circular/prototype-polluting/oversized
fixtures are rejected.

- [ ] **Step 5: Commit**

```bash
git add src/replay/sanitizeReplay.ts test/replaySanitizer.test.ts
git commit -m "feat: защитить replay payload"
```

### Task 4: Manifest service and isolated replay HTTP process

**Files:**
- Create: `src/services/replay.ts`
- Create: `src/http/replayServer.ts`
- Create: `src/cli/replayServe.ts`
- Modify: `src/config.ts`
- Modify: `src/http/auth.ts`
- Modify: `src/http/context.ts`
- Modify: `package.json`
- Modify: `.env.selfhost.example`
- Modify: `docker-compose.selfhost.yml`
- Test: `test/replayHttp.test.ts`

**Interfaces:**
- Produces: `createReplayServer`, `ReplayService.createSession`, `putChunk`, `complete`, `withdraw`, `deleteExpired`.
- Consumes: ingest auth resolution, `ReplayObjectStore`, replay Zod schemas.

- [ ] **Step 1: Write HTTP tests for the full manifest lifecycle**

Use two real projects and assert: create returns a scoped token; chunk 0 stores;
same checksum is idempotent; changed checksum is 409; missing sequence keeps
status incomplete; contiguous completion is playable; another project receives
403; withdrawal makes reads/uploads 410 and deletes the object.

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- test/replayHttp.test.ts`

Expected: FAIL because `/r/v1/*` does not exist.

- [ ] **Step 3: Implement transactional manifest claims**

`putChunk` must lock the replay row, validate active token and status, check
compressed size before gunzip, enforce decompression ratio and uncompressed
size while streaming, sanitize, recompress canonical JSON, store under a
server-generated key, insert metadata, and update counts in one database
transaction. If metadata commit fails, delete the newly written object.

- [ ] **Step 4: Implement completion and withdrawal**

Completion queries ordered descriptors and requires sequences `0..N-1`,
monotonic timestamps and an initial checkout. Withdrawal changes status to
`deleting` before object deletion; every read/upload checks that status. The
retention worker retries physical deletion and finishes with `deleted`.
Cap a session at 30 minutes and issue its scoped upload/delete token for 35
minutes, so v1 needs no refresh endpoint and a token cannot outlive its session
by more than five minutes.

- [ ] **Step 5: Wire the separate CLI and self-host volume**

Add `"replay:serve": "tsx src/cli/replayServe.ts"`,
`POOLSTATIS_REPLAY_PORT=3301`, `POOLSTATIS_REPLAY_ROOT`, independent pool-size
settings and a self-host service/volume. Do not mount the replay root into the
normal API container as writable.

- [ ] **Step 6: Verify GREEN**

Run: `pnpm test -- test/replayHttp.test.ts && pnpm typecheck`

Expected: all lifecycle, tenant, limit and tombstone tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/replay.ts src/http/replayServer.ts src/cli/replayServe.ts src/config.ts src/http/auth.ts src/http/context.ts package.json .env.selfhost.example docker-compose.selfhost.yml test/replayHttp.test.ts
git commit -m "feat: добавить isolated replay service"
```

### Task 5: Optional rrweb recorder SDK

**Files:**
- Create: `sdk/src/replayPrivacy.ts`
- Create: `sdk/src/replayChunker.ts`
- Create: `sdk/src/replay.ts`
- Modify: `sdk/src/index.ts`
- Modify: `sdk/package.json`
- Test: `sdk/test/replayPrivacy.test.ts`
- Test: `sdk/test/replayChunker.test.ts`
- Test: `sdk/test/replay.test.ts`

**Interfaces:**
- Produces: `createExperienceSession`, `ReplayRecorder`, `ReplayRecorderOptions`, `ReplayPrivacyPolicy`.
- Consumes: `@rrweb/record`, replay service URL and ingest key.

- [ ] **Step 1: Write RED privacy and lifecycle tests**

Test no dynamic import/observer/network before consent, mask-all defaults,
visible-text mode, allowlisted text input, unconditional password/payment
masking, bounded 5 MiB queue, 500-event/10-second boundaries, stable retry
sequence, StrictMode double start, withdrawal abort and queue clearing.

- [ ] **Step 2: Verify RED**

Run: `pnpm --dir sdk test -- replay`

Expected: FAIL because the replay export is absent.

- [ ] **Step 3: Implement privacy compilation**

```ts
export interface ReplayPrivacyPolicy {
  version: string;
  text: 'masked' | 'visible';
  inputs: 'masked' | 'allowlisted';
  allowInputSelectors?: string[];
  maskSelectors: string[];
  blockSelectors: string[];
}

export function assertReplayPrivacyPolicy(policy: ReplayPrivacyPolicy): void;
export function sanitizeRecordedEvent(event: unknown, policy: ReplayPrivacyPolicy): unknown;
```

The function compiles rrweb options and post-sanitizes each emission. It must
throw before importing rrweb when policy is invalid.

- [ ] **Step 4: Implement deterministic chunking and transport**

`ReplayChunker` accepts sanitized events, tracks uncompressed bytes, creates a
SHA-256 checksum, gzip body and descriptor, and preserves `(replayId, sequence,
checksum)` across retry. `ReplayRecorder` creates one manifest, starts rrweb
with checkout and mousemove sampling options, flushes on thresholds/pagehide,
completes on normal stop, and withdraws on consent loss.
Compute the checksum over canonical UTF-8 JSON after privacy sanitization and
before gzip. The server repeats sanitization/canonical serialization and
verifies that checksum before writing canonical gzip bytes, so gzip metadata
cannot change chunk identity.

- [ ] **Step 5: Keep dependencies out of the core bundle**

Add `./replay` export and exact rrweb `2.1.0` dependencies to the SDK package. `index.ts`
may expose only transport/session types; it must not statically import rrweb.
Use a build assertion that `dist/index.js` contains no `rrweb` string.

- [ ] **Step 6: Verify GREEN**

Run: `pnpm --dir sdk test && pnpm --dir sdk build && ! grep -q rrweb sdk/dist/index.js`

Expected: SDK tests/build PASS and the core bundle assertion exits zero.

- [ ] **Step 7: Commit**

```bash
git add sdk/src/replayPrivacy.ts sdk/src/replayChunker.ts sdk/src/replay.ts sdk/src/index.ts sdk/package.json sdk/pnpm-lock.yaml sdk/test/replayPrivacy.test.ts sdk/test/replayChunker.test.ts sdk/test/replay.test.ts
git commit -m "feat: добавить replay recorder sdk"
```

### Task 6: Platform replay metadata and MCP tools

**Files:**
- Modify: `src/http/server.ts`
- Modify: `src/mcp/server.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/api/types.ts`
- Test: `test/replayPlatform.test.ts`
- Test: `test/mcp-replay.test.ts`

**Interfaces:**
- Produces: list/detail/events/delete Platform endpoints and MCP tools `list_session_replays`, `get_session_replay`, `delete_session_replay`.
- Consumes: `ReplayService` metadata and audit methods.

- [ ] **Step 1: Write RED REST and MCP tests**

Assert project/env filters, pagination, complete/incomplete state, audit rows,
cross-project 404, delete tombstone, bounded ordered event stream, and that no
MCP result contains rrweb nodes, captured text, input values or object keys.

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- test/replayPlatform.test.ts test/mcp-replay.test.ts`

Expected: FAIL because routes/tools are absent.

- [ ] **Step 3: Implement Platform endpoints**

List returns manifest summaries only. Detail returns completeness, policy and
consent versions, timestamps, byte/event counts and quality fields. Events
streams descriptors in sequence, reads each object, revalidates checksum and
sanitizer, enforces a response cap, and writes one `view` audit row.

- [ ] **Step 4: Implement metadata-only MCP tools**

Tool descriptions must say DOM is intentionally omitted and direct the agent
to `viewer_path`. `delete_session_replay` requires exact replay id and returns
the tombstone state.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test -- test/replayPlatform.test.ts test/mcp-replay.test.ts && pnpm typecheck`

Expected: REST/MCP tests and typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http/server.ts src/mcp/server.ts web/src/api/client.ts web/src/api/types.ts test/replayPlatform.test.ts test/mcp-replay.test.ts
git commit -m "feat: открыть replay metadata через api и mcp"
```

### Task 7: Sandboxed admin replay player

**Files:**
- Create: `web/replay-viewer.html`
- Create: `web/src/replay-viewer.ts`
- Create: `web/src/screens/experience/ReplayList.tsx`
- Create: `web/src/screens/experience/ReplayPlayer.tsx`
- Modify: `web/src/screens/Experience.tsx`
- Modify: `web/vite.config.ts`
- Modify: `web/package.json`
- Create: `playwright.config.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Test: `e2e/replay-viewer.spec.ts`

**Interfaces:**
- Produces: searchable replay list and opaque-origin rrweb player.
- Consumes: Platform replay metadata/events endpoints.

- [ ] **Step 1: Write RED browser security test**

Install the test runner with `pnpm add -D @playwright/test` and
`pnpm exec playwright install chromium`. Configure `playwright.config.ts` with
separate API, replay, admin and trap-server web processes; reuse no existing
developer server.

Use a malicious stored replay containing script, handler, external image,
form and `javascript:` link. Open the admin player and assert no request reaches
the trap server, no top navigation occurs, no form submits, no parent token is
visible, and the iframe origin is opaque.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec playwright test e2e/replay-viewer.spec.ts`

Expected: FAIL because the player does not exist.

- [ ] **Step 3: Implement the isolated viewer entry**

Serve a dedicated Vite entry with strict meta/HTTP CSP. It accepts one message
containing `{channel, events}`, validates the random channel, constructs
`Replayer(events, { mouseTail: true, UNSAFE_replayCanvas: false })`, and exposes
only play/pause/seek/speed messages. It never fetches data itself.

- [ ] **Step 4: Implement parent discovery and controls**

`ReplayList` filters by surface, route, time and status. `ReplayPlayer` fetches
validated events in the authenticated parent, creates
`<iframe sandbox="allow-scripts">`, transfers data once after a ready message,
and revokes local references on close.

- [ ] **Step 5: Verify GREEN and responsive UI**

Run: `pnpm --dir web build && pnpm exec playwright test e2e/replay-viewer.spec.ts`

Expected: build and security E2E PASS at desktop and mobile viewport sizes.

- [ ] **Step 6: Commit**

```bash
git add web/replay-viewer.html web/src/replay-viewer.ts web/src/screens/experience/ReplayList.tsx web/src/screens/experience/ReplayPlayer.tsx web/src/screens/Experience.tsx web/vite.config.ts web/package.json web/pnpm-lock.yaml playwright.config.ts package.json pnpm-lock.yaml e2e/replay-viewer.spec.ts
git commit -m "feat: добавить sandboxed replay player"
```

### Task 8: Basic Project replay proof

**Files:**
- Modify: `/Users/maksimstil/Documents/Basic Project/src/analytics.js`
- Modify: `/Users/maksimstil/Documents/Basic Project/src/analytics.test.js`
- Modify: `/Users/maksimstil/Documents/Basic Project/src/App.jsx`
- Modify: `/Users/maksimstil/Documents/Basic Project/src/styles.css`
- Create: `/Users/maksimstil/Documents/Basic Project/.env.example`
- Create: `/Users/maksimstil/Documents/Basic Project/e2e/replay.spec.js`
- Create: `/Users/maksimstil/Documents/Basic Project/playwright.config.js`
- Modify: `/Users/maksimstil/Documents/Basic Project/package.json`
- Modify: `/Users/maksimstil/Documents/Basic Project/package-lock.json`

**Interfaces:**
- Produces: real allow/deny/withdraw UI, shared session id and a reproducible replay fixture.
- Consumes: `@poolstatis/sdk/replay` and local replay service.

- [ ] **Step 1: Write RED consent tests**

Assert default deny, replay consent independent from Browser Experience,
withdrawal persistence, no build-time consent flag, and one recorder across a
StrictMode mount/unmount/mount sequence.

- [ ] **Step 2: Replace the environment switch with visible controls**

Persist consent in local storage only after user action. Mark client names,
notes, composer, auth and payment fixtures with `data-poolstatis-mask` or
`data-poolstatis-block`. Mark the non-sensitive search input with
`data-poolstatis-record-input` and use policy `text: 'visible'`,
`inputs: 'allowlisted'` for that selector only.

- [ ] **Step 3: Add the browser E2E**

Install `@playwright/test` as a dev dependency, add
`"e2e": "playwright test"`, and configure API/replay/admin/Basic web servers
in `playwright.config.js` with fixed non-conflicting ports.

Allow replay, type `safe-search-term`, place `never-upload-secret` in a masked
fixture, create and edit a brief, move the pointer, scroll, complete the
session, discover it in admin and play through the mutation. Decompress the
stored chunks and assert the safe term and changed brief exist while the secret
does not.

- [ ] **Step 4: Verify GREEN**

Run in Basic Project: `npm test && npm run build && npm run e2e -- replay.spec.js`

Expected: unit/build/E2E PASS and admin playback visibly reconstructs the DOM mutation.

- [ ] **Step 5: Commit only Basic Project files in its repository if it is a Git worktree**

```bash
git add src/analytics.js src/analytics.test.js src/App.jsx src/styles.css .env.example e2e/replay.spec.js playwright.config.js package.json package-lock.json
git commit -m "feat: проверить session replay"
```

### Task 9: Landing consent and replay proof

**Files:**
- Read first: `/Users/maksimstil/Desktop/poolstatis-site/AGENTS.md`
- Create: `/Users/maksimstil/Desktop/poolstatis-site/src/components/ReplayConsent.tsx`
- Create: `/Users/maksimstil/Desktop/poolstatis-site/src/lib/replay.ts`
- Modify: `/Users/maksimstil/Desktop/poolstatis-site/src/App.tsx`
- Modify: `/Users/maksimstil/Desktop/poolstatis-site/src/components/landing/CloudWaitlist.tsx`
- Modify: `/Users/maksimstil/Desktop/poolstatis-site/package.json`
- Modify: `/Users/maksimstil/Desktop/poolstatis-site/pnpm-lock.yaml`
- Create: `/Users/maksimstil/Desktop/poolstatis-site/playwright.config.ts`
- Create: `/Users/maksimstil/Desktop/poolstatis-site/e2e/replay-consent.spec.ts`

**Interfaces:**
- Produces: landing allow/deny/withdraw disclosure; replay never includes waitlist values.
- Consumes: replay SDK; gaze is not enabled on the landing.

- [ ] **Step 1: Write RED deny/withdraw/privacy E2E**

Install `@playwright/test`, add an `e2e` package script and configure fixed
landing/API/replay ports in `playwright.config.ts`.

Before allow, assert no replay code/network. After allow, interact outside the
waitlist and assert a manifest appears. Enter unique email/company/use-case
secrets and assert raw chunks omit all three. Withdraw and assert immediate
unreadability plus physical deletion completion.

- [ ] **Step 2: Implement the narrow consent UI**

Use explicit buttons and plain disclosure. Wrap the full waitlist form in
`data-poolstatis-block`; do not depend only on individual input types.

- [ ] **Step 3: Verify GREEN**

Run in `poolstatis-site`: `pnpm build && pnpm exec playwright test e2e/replay-consent.spec.ts`

Expected: build/E2E PASS, deny has zero capture, allow records only non-form DOM, withdrawal deletes.

- [ ] **Step 4: Commit only landing files in its repository**

```bash
git add src/components/ReplayConsent.tsx src/lib/replay.ts src/App.tsx src/components/landing/CloudWaitlist.tsx package.json pnpm-lock.yaml playwright.config.ts e2e/replay-consent.spec.ts
git commit -m "feat: добавить consent для replay"
```

### Task 10: Replay performance, failure verification and documentation

**Files:**
- Create: `test/replay-isolation.e2e.ts`
- Modify: `docs/04-http-api.md`
- Modify: `docs/05-gap-analysis.md`
- Modify: `docs/10-self-host.md`
- Modify: `sdk/README.md`

**Interfaces:**
- Produces: measured replay isolation and operator documentation.
- Consumes: completed Tasks 1–9.

- [ ] **Step 1: Add replay-isolation failure test**

Run the existing analytics load smoke baseline, then saturate replay uploads
while killing replay service and making object storage unavailable. Assert SDK
replay queue stays within 5 MiB, normal analytics returns no additional 5xx and
ingest/query p95 degradation is at most 5%.

- [ ] **Step 2: Verify all repository gates**

Run:

```bash
pnpm typecheck
pnpm test
pnpm --dir sdk test
pnpm --dir sdk build
pnpm --dir web build
npm test --prefix '/Users/maksimstil/Documents/Basic Project'
npm run build --prefix '/Users/maksimstil/Documents/Basic Project'
pnpm --dir '/Users/maksimstil/Desktop/poolstatis-site' build
```

Expected: every command exits zero; record exact counts instead of saying
"passed" from intent.

- [ ] **Step 3: Update docs with exact limits and privacy behavior**

Document replay service configuration, separate consent, policies, limits,
retention/deletion, REST/MCP tools and the fact that playback is DOM-based, not
MP4/webcam video.

- [ ] **Step 4: Request independent reviews**

Run three read-only reviews: privacy/viewer security, SDK lifecycle/chunking,
and backend storage/retention. Fix every Critical and Important finding and
rerun the affected tests plus the full gates.

- [ ] **Step 5: Commit**

```bash
git add test/replay-isolation.e2e.ts docs/04-http-api.md docs/05-gap-analysis.md docs/10-self-host.md sdk/README.md
git commit -m "test: доказать изоляцию session replay"
```
