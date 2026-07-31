# SDK 0.2 migration

`@poolstatis/sdk` 0.2.0 makes browser acquisition attribution fail closed.
It is a breaking change for integrations that used the 0.1.0
`landing_path` snapshot.

## Why the contract changed

Raw pathnames can contain account IDs, document IDs, slugs or other
customer-controlled values. The SDK and Core now share one bounded contract:

- the product maps the current location to a finite, stable route key;
- the key must match `^[a-z][a-z0-9_.:-]{0,99}$`;
- the same key must be present in the trusted browser `route_keys` vocabulary;
- capture sends `landing_route`, never `landing_path`;
- Core rejects `landing_path` instead of translating or storing it.

## Browser analytics 0.1 to 0.2

`mapPagePath` is now required. Version 0.1 could emit a bounded raw pathname as
`$page_path`; version 0.2 only emits the product-owned `$route_key`.

Before:

```ts
const analytics = createBrowserAnalytics({
  client,
  distinctId,
  consentPolicy: 'opt-out',
});
// page.viewed properties included $page_path
```

After:

```ts
const mapRoute = (pathname: string) => {
  if (pathname === '/') return 'home';
  if (pathname === '/pricing') return 'pricing';
  if (pathname.startsWith('/docs/')) return 'docs.article';
  return 'other';
};

const analytics = createBrowserAnalytics({
  client,
  distinctId,
  consentPolicy: 'opt-out',
  mapPagePath: mapRoute,
});
// page.viewed properties include $route_key and never $page_path
```

The mapper must return a key from the finite vocabulary configured in Core.
Mapper exceptions fall back to `other`. An unsafe returned value fails closed
instead of sending the pathname.

Update metrics, filters, and downstream queries that reference `$page_path` to
use `$route_key`. There is no raw-path compatibility field in 0.2.

## Attribution snapshot 0.1 to 0.2

Before:

```ts
const snapshot = snapshotFromBrowser(browser, sessionId);
// snapshot.landing_path
```

After:

```ts
const routeKey = mapRoute(router.currentPathname());
const snapshot = snapshotFromBrowser(browser, sessionId, routeKey);
// snapshot.landing_route
```

The attribution client also requires a route provider:

```ts
const attribution = createAttributionClient({
  client,
  distinctId,
  hasConsent,
  subscribeConsent,
  route: () => mapRoute(router.currentPathname()),
});
```

`mapRoute` is product-owned. It must return a key such as `home`,
`pricing` or `docs.article`, not a URL or pathname.

## Setup change

Register the finite vocabulary before capture:

```json
{
  "route_keys": ["docs.article", "home", "other", "pricing"]
}
```

Use `propose_browser_analytics` through MCP or
`POST /api/v1/projects/:slug/properties/browser-analytics`. Review the proposed
definitions, then trust the route property through the existing measurement
workflow.

## Rollout

1. Inventory every `createBrowserAnalytics` and `snapshotFromBrowser` call,
   attribution `route` provider, and query or metric that uses `$page_path`.
2. Add and test the product-owned pathname-to-route-key mapping.
3. Propose and trust the complete finite route vocabulary, including `other`.
4. Update queries and metrics from `$page_path` to `$route_key`.
5. Upgrade to SDK 0.2.0.
6. Verify that captured events contain `$route_key` and `landing_route`, and
   no `$page_path`, `landing_path`, full URL, query string or user-controlled
   identifier.

There is no legacy `landing_path` compatibility mode. Keeping one would
preserve the privacy defect that this version removes.
