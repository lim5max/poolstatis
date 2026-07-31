export const BROWSER_ANALYTICS_STANDARD = `# Poolstatis Browser Analytics Standard (v1)

Browser Analytics starts collection immediately and remains privacy-bounded.

## Identity and grain

- A visitor is a query-time resolved actor.
- A session is the pair \`(resolved actor, non-empty session_id)\`.
- Page and engagement joins additionally require the same canonical \`$page_view_id\`.
- Reused session or page identifiers across actors are ambiguous; detail reads fail closed.

## Canonical events

- \`page.viewed\` carries \`$browser_context = "1"\`, a host-mapped \`$route_key\`,
  and an opaque \`$page_view_id\`.
- \`page.engagement\` carries the same identity plus cumulative sequence,
  monotonic foreground time, elapsed time, coarse scroll/interaction counts and
  one supported lifecycle reason.
- The highest sequence wins. Engagement starts at exactly 10,000 foreground
  milliseconds, two page views, or a selected active native key metric.
- Incomplete negative sessions remain unknown. Rates without a denominator are null.

Legacy/manual \`page.viewed\` events remain stored but do not acquire Browser
Analytics semantics.

## Privacy

Customer-facing route analysis and canonical capture require a trusted
canonical enum \`$route_key\` definition. Atomic setup receives the complete
finite non-sensitive vocabulary; the host mapper must return one of those
values, never a URL or dynamic path.

Never send or return raw IP, full URL, query, hash, full user agent, DOM, text,
or secret-bearing dynamic route data. Country is available only when the
reviewed local MMDB resolver is active. Custom product events use
the neutral base SDK path and must not carry \`$browser_context\`. UTM values
are bounded labels; URL-, path- and query-shaped values are not accepted.
\`landing_route\` must belong to the same trusted finite vocabulary as
\`$route_key\`.

## Collection and lifecycle

The browser module starts immediately when the host calls \`start()\`. Legacy
host callbacks remain compatible as an optional pause control, but Poolstatis
does not require a consent state or inspect Global Privacy Control. Logout or
account switch rotates visitor and session identity. Hidden/pagehide/freeze
terminal snapshots use keepalive transport.

## Setup and analysis

Use \`propose_browser_analytics(project, route_keys)\` once per project. Setup is one serialized
SERIALIZABLE transaction with full preflight and bounded retry; definitions
remain proposed until an owner reviews them. Activate \`web_page_views\` and
trust \`$route_key\` before querying.

Use only the typed Web tools. There is no raw SQL or raw event-name escape hatch.
`;
