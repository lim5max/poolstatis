import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PENDING_ORGANIZATION_MUTATION_EXEMPTIONS,
  requiresOrganizationWriteReadiness,
} from '../src/http/organizationWritePolicy.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function normalizeMcpRoute(raw: string): string {
  return raw
    .replaceAll('${slug}', ':slug')
    .replaceAll('${event_id}', ':eventId')
    .replaceAll('${scope}', ':scope')
    .replace(/\$\{[^}]*key[^}]*\}/g, ':key')
    .replace(/\$\{[^}]*\}/g, ':id');
}

describe('organization write policy inventory', () => {
  it('classifies every mutating HTTP route and keeps only explicit analysis/self-service exemptions', async () => {
    const source = await readFile(resolve(repoDir, 'src/http/server.ts'), 'utf8');
    const allRoutes = Array.from(
      source.matchAll(/app\.(get|post|patch|delete)\('([^']+)'/g),
      (match) => `${match[1]!.toUpperCase()} ${match[2]!}`,
    );
    const routes = Array.from(
      source.matchAll(/app\.(post|patch|delete)\('([^']+)'/g),
      (match) => `${match[1]!.toUpperCase()} ${match[2]!}`,
    );
    expect(allRoutes).toHaveLength(123);
    expect(new Set(allRoutes).size).toBe(allRoutes.length);
    expect(routes).toHaveLength(75);
    expect(routes.every((route) =>
      route.includes(' /api/v1/') || route.includes(' /i/v1/'))).toBe(true);

    const blocked = allRoutes
      .filter((route) => {
        const [method, path] = route.split(' ', 2) as [string, string];
        return requiresOrganizationWriteReadiness(method, path);
      });
    const allowed = allRoutes.filter((route) => !blocked.includes(route));
    expect(blocked).toHaveLength(64);
    expect(allowed).toHaveLength(59);

    const exemptions = routes
      .filter((route) => {
        const [method, path] = route.split(' ', 2) as [string, string];
        return !requiresOrganizationWriteReadiness(method, path);
      })
      .sort();
    expect(exemptions).toEqual(
      [...PENDING_ORGANIZATION_MUTATION_EXEMPTIONS].sort(),
    );
    expect(requiresOrganizationWriteReadiness(
      'POST',
      '/api/v1/projects/:slug/future-customer-write',
    )).toBe(true);
    expect(requiresOrganizationWriteReadiness('GET', '/api/v1/projects')).toBe(false);
  });

  it('keeps MCP on the centralized HTTP boundary and classifies every mutating tool call', async () => {
    const source = await readFile(resolve(repoDir, 'src/mcp/server.ts'), 'utf8');
    expect(source.match(/\bfetch\(/g)).toHaveLength(1);
    expect(Array.from(source.matchAll(/^jsonTool\(/gm))).toHaveLength(104);

    const calls = Array.from(
      source.matchAll(/api\(\s*'(POST|PATCH|DELETE)'\s*,\s*(`[^`]+`|'[^']+')/g),
      (match) => {
        const rawPath = match[2]!.slice(1, -1);
        return {
          method: match[1]!,
          route: normalizeMcpRoute(rawPath),
        };
      },
    );
    expect(calls).toHaveLength(73);
    expect(calls.every(({ route }) => route.startsWith('/api/v1/'))).toBe(true);

    const exemptMcpCalls = calls
      .filter(({ method, route }) =>
        !requiresOrganizationWriteReadiness(method, route))
      .map(({ method, route }) => `${method} ${route}`);
    expect(exemptMcpCalls).toHaveLength(27);
    expect(calls.length - exemptMcpCalls.length).toBe(46);
    expect(new Set(exemptMcpCalls)).toEqual(new Set([
      'POST /api/v1/projects/:slug/onboarding/observe-agent',
      'POST /api/v1/projects/:slug/events/backfill/preview',
      'POST /api/v1/projects/:slug/events/:eventId/revisions/preview',
      'POST /api/v1/projects/:slug/contracts/validate',
      'POST /api/v1/projects/:slug/contracts/diff',
      'POST /api/v1/projects/:slug/contracts/similar',
      'POST /api/v1/projects/:slug/flags/:key/evaluate',
      'POST /api/v1/projects/:slug/measurement/trust',
      'POST /api/v1/projects/:slug/query',
    ]));
    expect(source).toContain("'instrumentation-standard'");
    expect(source).toContain("api('GET', `/api/v1/projects/${String(slug)}/schema`)");
  });
});
