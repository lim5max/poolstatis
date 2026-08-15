# MCP 0.7.0 privacy-safe Session Replay metadata

`@poolstatis/mcp@0.7.0` adds two backwards-compatible, read-only tools:

- `list_session_replays` searches at most 100 project-scoped manifests by
  environment, surface and lifecycle status;
- `get_session_replay` returns one bounded manifest and its admin viewer path.

Neither tool returns rrweb events, reconstructed DOM, page text, cursor
samples, upload tokens or object-store keys. Recording still requires the
separate SDK replay entrypoint, affirmative versioned consent and an exact-host
policy. Playback remains server-sanitized and scriptless-sandboxed.

The three funnel-investigation tools remain source/local only and are excluded
from the `0.7.0` package profile. The release is complete only after the exact
main artifact passes `publish-mcp.yml`, npm reports version and integrity, and
a fresh registry-backed client initializes, lists exactly 142 tools and sees
the replay tools without seeing funnel-investigation tools.
