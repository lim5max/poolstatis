# Privacy-safe Session Replay

Session Replay is a separate, explicit browser module. It records real rrweb
full snapshots, DOM mutations, viewport/navigation metadata, scroll, click and
pointer movement. Browser Experience remains the lower-sensitivity labelled
event timeline and must not be presented as replay.

## Supported recorder and player

- `@rrweb/record@2.1.1`
- `@rrweb/replay@2.1.1`
- `@rrweb/types@2.1.1`
- MIT license

The legacy `rrweb` convenience package is not used. Versions are exact so the
snapshot/player contract changes only through a reviewed dependency update.

Sources checked on 2026-08-15: [2.1.1 releases](https://github.com/rrweb-io/rrweb/releases),
[official guide](https://github.com/rrweb-io/rrweb/blob/main/guide.md),
[`rrweb-snapshot` sandbox warning](https://www.npmjs.com/package/rrweb-snapshot)
and the [MIT license](https://github.com/rrweb-io/rrweb/blob/main/LICENSE).

The source release candidate is `@poolstatis/sdk@0.4.0`; the currently
published `0.3.0` does not contain `./replay`. After `npm view` confirms the
new exact version, install replay separately from the dependency-free base SDK:

```bash
pnpm add @poolstatis/sdk@0.4.0 @rrweb/record@2.1.1
```

```ts
import { ReplayRecorder } from '@poolstatis/sdk/replay';

const replay = new ReplayRecorder({
  url: 'https://analytics.example.com',
  ingestKey: 'pk_…',
  surface: 'workspace',
  route: 'workspace', // finite registered key; never location.href/path/query/hash
  distinctId: () => currentUser.id,
  version: RELEASE_SHA,
  consent: { granted: consent.replay === true, version: 'replay-consent-v1' },
  allowedHosts: ['app.example.com'], // exact hostnames, no wildcard
  policy: {
    version: 'replay-privacy-v1',
    text: 'masked',
    maskSelectors: ['[data-customer-copy]'],
    blockSelectors: ['[data-payment-widget]'],
  },
  retentionDays: 7,
});

await replay.start();
// On a deliberate end-of-flow/unmount, wait for normal delivery:
await replay.stop();
// On consent withdrawal instead:
await replay.withdraw();
```

`start()` fails before importing rrweb or making a request unless affirmative
versioned consent and the exact current hostname both pass. A denied or
unsampled session does not load recorder code and does not create a manifest.
Withdrawal racing with initialization prevents rrweb from starting. If its
bounded delete attempts fail, the recorder retains the manifest/upload token;
a repeated `withdraw()` retries the same tombstone instead of losing it. A
tenant-scoped `404`/`410` after an ambiguous response is terminal success:
the manifest is already absent or unreadable.

## Privacy contract

Secure defaults block password, payment, auth-token, hidden and one-time-code
targets. All inputs, textareas and contenteditable content are masked. Default
`text: "masked"` masks visible text. Human-readable attributes (`aria-*`,
`title`, `alt`, `name`, `placeholder`) are masked; `data-*`, handlers, forms,
scripts, nested iframes, embeds and network-bearing attributes are removed.
Explicit `[data-poolstatis-block]` / `.rr-block` and
`[data-poolstatis-mask]` / `.rr-mask` are always honored in addition to the
bounded configured simple tag, class, id or attribute selectors. Their
normalized policy is stored with the manifest so server validation repeats it.
Crafted attribute names that collide case-insensitively (for example
`class`/`CLASS`) block the entire node before selector or visible-text policy
evaluation, so normalization cannot change which privacy rule wins.

Default masked mode also masks unknown/non-structural string fields, not only
known `textContent`/`value` keys. `<style>` text, rrweb `isStyle` text and
stylesheet/declaration mutations always pass through the CSS sanitizer even
when visible copy was explicitly allowed.

IDs/classes are replaced before upload with deterministic structural tokens.
The bounded CSS sanitizer rewrites selectors to the same tokens, retains a
layout-only property allowlist and removes imports, URLs, image/font loads,
`content`, executable CSS and secret-looking values. The server repeats the
same idempotent validation before object storage and again before playback.
Raw URL, path, query and hash are never part of the contract; navigation uses
the registered route key.

## Delivery, completion and retention

- Normal JSON chunks: at most 500 events / 512 KiB.
- Session: at most 120 chunks, 50,000 events, 20 MiB and 30 minutes.
- Browser queue: 5 MiB; dropped chunks retain their sequence gap, so the server
  marks the manifest `incomplete`, never playable.
- Stable sequence + checksum retries: at most four 10-second attempts. Final
  completion uses the same bounded retry and a failed `stop()` can be called
  again without restarting capture or losing queued chunks.
- `pagehide` attempts one request only when the complete request is at most
  60 KiB and uses `keepalive`. Larger or interrupted final chunks remain
  pending/incomplete; navigation-time delivery is never reported as complete.
- Retention defaults to seven days (allowed range 1–30). Withdrawal and expiry
  tombstone first, making reads return `410`, then retry physical deletion and
  scrub session/distinct/host/token/privacy identifiers from the final
  idempotency row.
  A playback read starts one absolute bounded deadline before object loading,
  holds a shared manifest lock through validation, audit and the remaining
  HTTP response lease;
  withdrawal waits for that read, so no playback can complete after withdrawal
  itself has completed. Stalled/aborted responses roll back the view audit and
  cannot retain a database connection indefinitely. Retention uses atomic
  claims plus backoff so poison objects do not starve later expired sessions.

Project deletion persists its database write barrier and durable job before
any external deletion. Snapshot artifact keys are copied to a non-cascading
work table, then the job checkpoints `artifacts → events → replays → metadata
→ objects`. Creation, chunk upload and completion reject late replay writes;
the retention worker can resume any phase after a crash or store outage,
including the window before the first artifact/EventStore purge.

Payload bytes live behind `ReplayObjectStore`; PostgreSQL contains manifests,
chunk checksums/metadata and append-only privileged view, deletion-request and
deletion-completion audit records. Replay deletion audit is intentionally not
foreign-keyed to `projects`: its immutable project UUID and original actor
survive project deletion as proof of the two-phase removal, and hosted runtime
can only select/insert those rows. Replay-prefix deletion also removes deterministic
crash-orphans that have no committed chunk row. Self-host
Compose persists objects in `poolstatis_replays` separately from Postgres.

## Read surfaces and player isolation

Platform endpoints require `sk_` / `pt_` / authenticated user access:

```text
GET    /api/v1/projects/{slug}/replays?env=prod&surface=workspace&status=playable&limit=50
GET    /api/v1/projects/{slug}/replays/{id}?env=prod
GET    /api/v1/projects/{slug}/replays/{id}/events?env=prod
DELETE /api/v1/projects/{slug}/replays/{id}
```

MCP `list_session_replays` and `get_session_replay` return bounded metadata and
the admin viewer path only. MCP never returns DOM/event bytes or object keys.

Recorded data stays untrusted after validation. `@rrweb/replay` reconstructs it
only in rrweb-snapshot's official scriptless iframe (`sandbox="allow-same-origin"`
without `allow-scripts`). `UNSAFE_replayCanvas` and unprotected rebuild modes
are disabled, interactions are disabled and executable/network DOM is removed.
The upstream player requires access to that iframe's `contentDocument`; an
additional outer opaque-origin iframe makes the nested official sandbox
inaccessible and fails reconstruction. This is why v1 uses the supported
scriptless sandbox instead of claiming an unsupported opaque wrapper.

The full threat model and test evidence contract are in
[`docs/superpowers/specs/2026-08-15-session-replay-privacy-model.md`](superpowers/specs/2026-08-15-session-replay-privacy-model.md).
