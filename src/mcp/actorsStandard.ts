export const ACTORS_STANDARD = `# Poolstatis actors and person contract

Actors are query-time canonical identities derived from immutable events and
active server-owned actor links. There is no mutable users table.

- Use \`list_actors\` with an optional registered metric key in
  \`activityMetric\`; never pass a raw event name.
- Search is exact ID only. Pagination cursors are opaque keyset cursors and
  must be replayed unchanged with the same query. They freeze the ingest
  cutoff, bind the resolved metric/session capability and carry a server-side
  HMAC; actor-link changes invalidate an outstanding cursor.
- \`interesting_desc\` is the default queue order. Its score and reasons use
  only first seen, last seen, active days and accepted event volume inside the
  exact query window. They never infer risk, intent, demographics or segment
  changes from hidden properties.
- \`linked\` requires active link provenance or multiple raw IDs.
  Unlinked actors are \`unknown\` unless the server detects a conflict.
  Email, name and ID spelling never determine identity status.
- Actor property filters and pinned properties fail closed until a
  deterministic trusted canonical source exists.
- \`session_count\` is nullable and only counts canonical Browser sessions
  when strict project and actor/window evidence exists.
- \`top_events\` and Person activity expose registered event names only.
  Person activity properties stay masked until an explicit allowlist and
  masking policy exists.
- \`get_person\` returns canonical ID, bounded raw IDs, active link
  provenance and keyset-paginated activity for the full resolved population.
- Person purge remains a separate destructive exact-raw-ID action. It never
  expands to the canonical actor or linked raw IDs.
- Browser Experience session IDs are not actor identity. Reused IDs require
  \`actor_id\`; ambiguous or non-matching actor/session reads fail with typed
  errors and never synthesize provenance from request input.
`;
