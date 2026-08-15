# Gaze Attention v1 Implementation Plan

> **Plan only — not a shipped capability.** Gaze, cursor attention maps,
> replay-side aggregates, replay schemas, and the referenced
> `017_session_replay.sql` prerequisite are absent from Core `origin/main` as
> verified on 2026-08-15. Do not treat the tasks or expected migration state
> below as current implementation evidence. Current Browser Experience ships
> only labelled clicks, scroll/section signals, coarse error types, bounded
> interaction maps, and a per-session timeline without DOM or cursor replay.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add calibrated on-device webcam gaze estimation plus click/cursor/gaze attention maps without uploading camera frames or slowing normal analytics.

**Architecture:** The optional gaze SDK loads MediaPipe in a Web Worker only after independent consent and browser camera permission. A pure calibration layer maps iris/head-pose features to normalized viewport coordinates and exposes an injectable provider for deterministic tests. Cursor and accepted gaze samples are folded client-side into fixed 64x64 dwell cells, stored as small replay-side aggregates and queried through a typed `attention_map` EventStore branch, REST, MCP and admin UI.

**Tech Stack:** TypeScript 5.8, `@mediapipe/tasks-vision` 0.10.35, Web Worker, Web MediaDevices API, PostgreSQL, Fastify, React 19, Vitest, Playwright with deterministic/fake media fixtures.

## Global Constraints

- This plan begins only after Session Replay Tasks 1–6 provide replay manifests, scoped tokens and isolated replay HTTP service.
- Gaze has consent separate from Browser Experience and Session Replay; camera access requires a user gesture and HTTPS/localhost secure context.
- Camera frames, face landmarks, biometric templates and video never leave the browser and never enter replay chunks.
- A session is labelled gaze-tracked only when nine-point calibration median normalized holdout error is at most `0.10`.
- Accepted gaze samples are capped at 10 Hz; cursor samples at 20 Hz; hidden-tab, low-confidence, missing-face and out-of-bounds samples are discarded.
- Attention cells use a fixed 64x64 source grid and store only count and dwell milliseconds.
- Normal event ingest/query p95 degradation under saturated attention/replay traffic must be at most 5%.
- Preserve unrelated dirty-worktree changes and commit only current-task files.

---

### Task 1: Attention-cell persistence and EventStore query contract

**Files:**
- Modify: `src/replay/types.ts`
- Modify: `src/schemas.ts`
- Modify: `src/stores/eventStore.ts`
- Modify: `src/stores/bufferedEventStore.ts`
- Modify: `src/stores/postgresEventStore.ts`
- Modify: `src/services/query.ts`
- Test: `test/attentionMap.test.ts`

**Interfaces:**
- Produces: `AttentionSource`, `AttentionDelta`, `AttentionMapQuery`, `AttentionMapResult`, `EventStore.attentionMap()` and Query DSL kind `attention_map`.
- Consumes: replay session/project/env/surface identity from the replay plan.

- [ ] **Step 1: Write failing storage/query tests**

Insert cursor/gaze cells for two projects, environments, routes, sessions and
actors. Query 8x8 and assert correct folding from 64x64, summed count/dwell,
unique sessions/actors, source filtering and zero cross-project/env leakage.

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- test/attentionMap.test.ts`

Expected: FAIL because `attention_map` is not a Query DSL branch.

- [ ] **Step 3: Verify the immutable migration prerequisite**

Read the already-applied `017_session_replay.sql` from Session Replay Task 1
and assert `experience_attention_cells`, `replay_attention_batches` and
`replay_sessions.gaze_calibration_error` exist. Do not edit an applied
migration; if any prerequisite is missing, stop and fix Session Replay Task 1
before this task starts.

- [ ] **Step 4: Define the narrow EventStore interface**

```ts
export type AttentionSource = 'click' | 'cursor' | 'gaze';

export interface AttentionMapQuery {
  projectId: string;
  env: string;
  surface: string;
  source: AttentionSource | 'combined';
  from: Date;
  to: Date;
  grid: number;
}

export interface AttentionMapResult {
  grid: number;
  source: AttentionSource | 'combined';
  cells: Array<{ x: number; y: number; count: number; dwell_ms: number; sessions: number; actors: number }>;
  gaze_quality: { sessions: number; median_error: number | null };
}
```

Delegate through `BufferedEventStore`; implement one grouped PostgreSQL query
that folds `cell_x * grid / 64` and uses canonical project/env/surface/time
predicates.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test -- test/attentionMap.test.ts && pnpm typecheck`

Expected: query tests/typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add src/replay/types.ts src/schemas.ts src/stores/eventStore.ts src/stores/bufferedEventStore.ts src/stores/postgresEventStore.ts src/services/query.ts test/attentionMap.test.ts
git commit -m "feat: добавить attention map query"
```

### Task 2: Bounded browser attention accumulator

**Files:**
- Create: `sdk/src/attention.ts`
- Modify: `sdk/src/replay.ts`
- Test: `sdk/test/attention.test.ts`

**Interfaces:**
- Produces: `AttentionAccumulator.add(source, sample)`, `drain()` and `clear()`.
- Consumes: shared replay/session identity and replay attention endpoint.

- [ ] **Step 1: Write RED aggregation tests**

Use a fake clock and points at viewport edges. Assert clamping to cells 0/63,
same-cell coalescing, dwell from inter-sample time capped at 250 ms, separate
route/source buckets, hidden/invalid sample rejection, deterministic drain and
bounded 4,096-cell memory.

- [ ] **Step 2: Verify RED**

Run: `pnpm --dir sdk test -- attention`

Expected: FAIL because `AttentionAccumulator` does not exist.

- [ ] **Step 3: Implement the accumulator**

```ts
export interface AttentionSample {
  timestamp: number;
  x: number;
  y: number;
  confidence?: number;
  route: string;
}

export interface AttentionCellDelta {
  source: 'click' | 'cursor' | 'gaze';
  route: string;
  x: number;
  y: number;
  count: number;
  dwell_ms: number;
  first_timestamp: number;
  last_timestamp: number;
}
```

Use a Map keyed by source/route/x/y. Drop oldest route/source groups when the
cap is reached rather than allocating unbounded samples. Drain returns sorted
cells and resets only after acknowledged upload; retry preserves exact deltas.

- [ ] **Step 4: Wire cursor movement without duplicating rrweb listeners**

Use rrweb's emitted mouse-move data as the cursor source and add clicks from
the existing Browser Experience label observer. Do not add a second 20 Hz
global listener when rrweb recording is active.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --dir sdk test -- attention replay && pnpm --dir sdk typecheck`

Expected: accumulator/replay tests and SDK typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add sdk/src/attention.ts sdk/src/replay.ts sdk/test/attention.test.ts sdk/test/replay.test.ts
git commit -m "feat: агрегировать cursor attention"
```

### Task 3: Pure nine-point gaze calibration

**Files:**
- Create: `sdk/src/gazeCalibration.ts`
- Test: `sdk/test/gazeCalibration.test.ts`

**Interfaces:**
- Produces: `fitGazeCalibration`, `predictGaze`, `evaluateCalibration`, `GazeCalibrationModel`.
- Consumes: normalized iris/head-pose feature vectors and known calibration targets.

- [ ] **Step 1: Write RED math tests**

Generate a deterministic linear feature/target fixture with noise and outliers.
Assert robust outlier removal, stable coefficients, holdout median error below
0.03, rejection with fewer than nine distinct targets, rejection above 0.10,
and finite clamped predictions.

- [ ] **Step 2: Verify RED**

Run: `pnpm --dir sdk test -- gazeCalibration`

Expected: FAIL because calibration functions do not exist.

- [ ] **Step 3: Implement regularized regression without a runtime math dependency**

```ts
export interface GazeFeatureSample {
  features: readonly number[];
  targetX: number;
  targetY: number;
}

export interface GazeCalibrationModel {
  featureCount: number;
  xWeights: number[];
  yWeights: number[];
  medianError: number;
  calibratedAt: number;
}
```

Normalize features, add an intercept, solve the small ridge system with
Gaussian elimination and partial pivoting, remove samples above three median
absolute deviations, refit, and evaluate leave-one-target-out error.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --dir sdk test -- gazeCalibration && pnpm --dir sdk typecheck`

Expected: math tests/typecheck PASS deterministically.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/gazeCalibration.ts sdk/test/gazeCalibration.test.ts
git commit -m "feat: добавить gaze calibration"
```

### Task 4: MediaPipe worker provider

**Files:**
- Create: `sdk/src/gazeProvider.ts`
- Create: `sdk/src/gazeWorker.ts`
- Modify: `sdk/package.json`
- Test: `sdk/test/gazeProvider.test.ts`

**Interfaces:**
- Produces: `GazeProvider`, `MediaPipeGazeProvider`, feature extraction from Face Landmarker results.
- Consumes: injected `modelAssetUrl`, WASM root and browser media/worker factories.

- [ ] **Step 1: Write RED provider lifecycle tests**

With fake media/worker factories assert no camera before explicit start,
`video: true` and `audio: false`, one track/worker across duplicate start,
feature messages only (no frame bytes), worker errors surface a typed status,
stop terminates worker and every track, and hidden tab pauses inference.

- [ ] **Step 2: Verify RED**

Run: `pnpm --dir sdk test -- gazeProvider`

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Implement the provider contract**

```ts
export interface GazeProvider {
  start(onFeatures: (sample: { timestamp: number; features: number[]; confidence: number }) => void): Promise<void>;
  stop(): Promise<void>;
}
```

The production class calls `getUserMedia({video:{facingMode:'user'},audio:false})`
only inside `start`, creates and transfers one `ImageBitmap` to a worker at a
bounded rate, and closes every transferred bitmap. The worker dynamically imports
MediaPipe, initializes one-face VIDEO mode, extracts iris-relative and head-pose
features, returns numeric vectors, and retains no frame.

- [ ] **Step 4: Pin dependency/model and verify worker build**

Add exact `@mediapipe/tasks-vision` version `0.10.35`. Download the official
Face Landmarker float16 model from
`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
verify SHA-256
`64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`,
and require the application to host that verified 3,758,596-byte file on its
own HTTPS origin. Do not load `latest` at runtime or execute code from a
third-party CDN.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm --dir sdk test -- gazeProvider && pnpm --dir sdk build`

Expected: tests/build PASS; core `dist/index.js` and replay entry contain no
static MediaPipe import.

- [ ] **Step 6: Commit**

```bash
git add sdk/src/gazeProvider.ts sdk/src/gazeWorker.ts sdk/package.json sdk/pnpm-lock.yaml sdk/test/gazeProvider.test.ts
git commit -m "feat: добавить mediapipe gaze provider"
```

### Task 5: Consent-gated GazeTracker and calibration UI contract

**Files:**
- Create: `sdk/src/gaze.ts`
- Modify: `sdk/package.json`
- Test: `sdk/test/gaze.test.ts`

**Interfaces:**
- Produces: `GazeTracker`, `GazeTrackerStatus`, `GazeCalibrationPoint`, `./gaze` package export.
- Consumes: `GazeProvider`, calibration functions, `AttentionAccumulator`.

- [ ] **Step 1: Write RED state-machine tests**

Cover `idle -> requesting_permission -> calibrating -> tracking`, permission
denial, insufficient calibration, successful nine points, 10 Hz cap, EMA
smoothing, low-confidence/no-face/out-of-bounds/hidden rejection, independent
consent withdrawal, abort during calibration and complete camera cleanup.

- [ ] **Step 2: Verify RED**

Run: `pnpm --dir sdk test -- gaze.test.ts`

Expected: FAIL because `GazeTracker` does not exist.

- [ ] **Step 3: Implement the explicit controller**

```ts
export type GazeTrackerStatus =
  | 'idle' | 'requesting_permission' | 'calibrating'
  | 'tracking' | 'needs_calibration' | 'denied' | 'stopped';

export interface GazeCalibrationPoint { x: number; y: number; index: number }

export class GazeTracker {
  startFromUserGesture(): Promise<void>;
  calibrationPoints(): readonly GazeCalibrationPoint[];
  collectCalibrationPoint(index: number): Promise<void>;
  stop(options?: { withdraw?: boolean }): Promise<void>;
}
```

The class never creates its own DOM overlay. It exposes points/status so Basic
Project and future products render accessible UI. When quality passes, predicted
samples enter `AttentionAccumulator` only; frame/features/model are discarded.

- [ ] **Step 4: Verify GREEN and optional bundle isolation**

Run: `pnpm --dir sdk test && pnpm --dir sdk build && ! grep -q mediapipe sdk/dist/index.js`

Expected: all SDK tests/build PASS and core bundle stays independent.

- [ ] **Step 5: Commit**

```bash
git add sdk/src/gaze.ts sdk/package.json sdk/test/gaze.test.ts
git commit -m "feat: добавить consent-gated gaze tracker"
```

### Task 6: Attention ingest, REST, MCP and admin map

**Files:**
- Modify: `src/services/replay.ts`
- Modify: `src/http/replayServer.ts`
- Modify: `src/mcp/server.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/api/types.ts`
- Create: `web/src/screens/experience/AttentionMap.tsx`
- Modify: `web/src/screens/Experience.tsx`
- Test: `test/attentionHttp.test.ts`
- Test: `test/mcp-attention.test.ts`

**Interfaces:**
- Produces: replay-side attention delta upload and MCP `query_attention_map`.
- Consumes: attention schemas/EventStore branch and scoped replay token.

- [ ] **Step 1: Write RED ingest/auth/query tests**

Assert scoped token, active manifest, 64x64 bounds, bounded cells/request,
idempotent delta id, cross-project isolation, click/cursor/gaze/combined map,
gaze quality, MCP structured output and no raw biometric/frame values.

- [ ] **Step 2: Verify RED**

Run: `pnpm test -- test/attentionHttp.test.ts test/mcp-attention.test.ts`

Expected: FAIL because upload/tool/UI are absent.

- [ ] **Step 3: Implement transactional delta upsert**

Validate each cell and upsert count/dwell/first/last using a stable delta id
claim so retries cannot double totals. Reject attention for deleted, expired or
unsampled replay sessions. Store calibration median error in `replay_sessions`
only after a passing model.

- [ ] **Step 4: Add MCP and admin UI**

MCP accepts surface/source/date/grid/env and returns cells plus purpose and
quality. Admin renders source toggle, count/dwell toggle, calibration warning,
legend and responsive CSS-grid heatmap. Copy says gaze is webcam-estimated,
calibrated and not medical-grade.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test -- test/attentionHttp.test.ts test/mcp-attention.test.ts && pnpm --dir web build`

Expected: backend/MCP tests and web build PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/replay.ts src/http/replayServer.ts src/mcp/server.ts web/src/api/client.ts web/src/api/types.ts web/src/screens/experience/AttentionMap.tsx web/src/screens/Experience.tsx test/attentionHttp.test.ts test/mcp-attention.test.ts
git commit -m "feat: добавить gaze attention map"
```

### Task 7: Basic Project real consent/calibration and browser E2E

**Files:**
- Modify: `/Users/maksimstil/Documents/Basic Project/src/analytics.js`
- Modify: `/Users/maksimstil/Documents/Basic Project/src/analytics.test.js`
- Create: `/Users/maksimstil/Documents/Basic Project/src/GazeConsent.jsx`
- Create: `/Users/maksimstil/Documents/Basic Project/src/GazeCalibration.jsx`
- Modify: `/Users/maksimstil/Documents/Basic Project/src/App.jsx`
- Modify: `/Users/maksimstil/Documents/Basic Project/src/styles.css`
- Create: `/Users/maksimstil/Documents/Basic Project/e2e/gaze.spec.js`

**Interfaces:**
- Produces: accessible camera disclosure, calibration overlay and verified gaze map.
- Consumes: `@poolstatis/sdk/gaze`, shared session and replay service.

- [ ] **Step 1: Write RED UI/state tests**

Assert gaze default deny, replay consent does not imply gaze, camera request
only after click, denial message, nine keyboard-accessible calibration targets,
quality failure retry, withdrawal and one tracker across StrictMode remount.

- [ ] **Step 2: Implement consent and calibration components**

Show exactly what leaves the device: normalized gaze points and quality only.
Expose camera-active indicator and Stop control. Ensure every target has visible
focus and can be activated without pointer input.

- [ ] **Step 3: Add deterministic provider browser E2E**

Inject a test-only provider before app boot, feed known feature vectors for all
nine targets and a path across three viewport areas, assert status tracking,
complete attention upload, query MCP/REST and verify expected gaze cells/dwell.
Then withdraw and assert tracker stopped, session unreadable and no further
attention requests.

- [ ] **Step 4: Add a fake-camera smoke for production provider lifecycle**

Launch Chromium with a deterministic fake video device, grant camera permission,
start the real provider and assert a feature stream or a typed unsupported/model
error, never silent success. The release gate requires track cleanup even when
the model cannot calibrate in headless mode; gaze-map accuracy remains covered
by deterministic provider/calibration tests.

- [ ] **Step 5: Verify GREEN**

Run in Basic Project: `npm test && npm run build && npm run e2e -- gaze.spec.js`

Expected: unit/build/E2E PASS, verified gaze cells are visible in admin and MCP.

- [ ] **Step 6: Commit Basic Project files in its repository**

```bash
git add src/analytics.js src/analytics.test.js src/GazeConsent.jsx src/GazeCalibration.jsx src/App.jsx src/styles.css e2e/gaze.spec.js package.json package-lock.json
git commit -m "feat: проверить gaze attention"
```

### Task 8: Performance, privacy and independent review gates

**Files:**
- Create: `test/attention-isolation.e2e.ts`
- Modify: `sdk/README.md`
- Modify: `docs/04-http-api.md`
- Modify: `docs/05-gap-analysis.md`

**Interfaces:**
- Produces: final gaze/attention proof and operator documentation.
- Consumes: all completed gaze and replay tasks.

- [ ] **Step 1: Run the isolation benchmark**

Measure analytics baseline, then run cursor at 20 Hz and gaze at 10 Hz across
concurrent sessions while replay uploads are saturated. Assert analytics p95
degradation at most 5%, zero additional analytics 5xx, bounded browser/worker
RSS and bounded attention rows due cell aggregation.

- [ ] **Step 2: Inspect raw data for biometric leakage**

Search decompressed replay objects, PostgreSQL rows, API responses, MCP output
and logs for known fake frame bytes, landmark vectors and model features. The
only gaze payload allowed is timestamp/x/y/confidence before client aggregation
and cell/count/dwell/quality after aggregation.

- [ ] **Step 3: Run full gates**

```bash
pnpm typecheck
pnpm test
pnpm --dir sdk test
pnpm --dir sdk build
pnpm --dir web build
npm test --prefix '/Users/maksimstil/Documents/Basic Project'
npm run build --prefix '/Users/maksimstil/Documents/Basic Project'
```

Expected: every command exits zero; capture exact test counts and benchmark values.

- [ ] **Step 4: Request three independent reviews**

Reviewers independently inspect camera/privacy lifecycle, calibration/math/SDK
correctness, and backend attention isolation/query accuracy. Fix every Critical
and Important finding, then rerun targeted and full gates.

- [ ] **Step 5: Commit**

```bash
git add test/attention-isolation.e2e.ts sdk/README.md docs/04-http-api.md docs/05-gap-analysis.md
git commit -m "test: доказать gaze attention"
```
