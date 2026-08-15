# MCP 0.7.0 Session Replay metadata and funnel investigations

`@poolstatis/mcp@0.7.0` adds two backwards-compatible, read-only tools:

- `list_session_replays` searches at most 100 project-scoped manifests by
  environment, surface and lifecycle status;
- `get_session_replay` returns one bounded manifest and its admin viewer path.

Neither tool returns rrweb events, reconstructed DOM, page text, cursor
samples, upload tokens or object-store keys. Recording still requires the
separate SDK replay entrypoint, affirmative versioned consent and an exact-host
policy. Playback remains server-sanitized and scriptless-sandboxed.

The same release publishes `create_funnel_investigation`,
`list_funnel_investigations` and `get_funnel_investigation`. They use bounded
project-scoped REST parity, immutable lineage and integrity fingerprints; their
evidence is descriptive, not causal. The release is complete only after the
exact main artifact passes `publish-mcp.yml`, npm reports version and integrity,
and a fresh registry-backed client initializes and lists exactly 145 tools,
including both replay metadata and all three funnel-investigation tools.
