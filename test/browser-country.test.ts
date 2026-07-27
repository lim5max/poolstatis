import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTrustedProxyCountryResolver } from '../src/services/country.js';
import { createTestEnv, type TestEnv } from './helpers.js';

describe('trusted proxy country enrichment', () => {
  const resolver = createTrustedProxyCountryResolver({
    header: 'cf-ipcountry',
    trustedProxyCidrs: ['10.0.0.0/8', '2001:db8::/32'],
  });

  it('accepts an ISO country only from a configured direct proxy peer', () => {
    expect(resolver.resolve({ remoteAddress: '10.2.3.4', headers: { 'cf-ipcountry': 'DE' } })).toBe('DE');
    expect(resolver.resolve({ remoteAddress: '2001:db8::7', headers: { 'cf-ipcountry': 'br' } })).toBe('BR');
  });

  it('fails closed for spoofed, malformed, or unavailable headers', () => {
    expect(resolver.resolve({ remoteAddress: '203.0.113.10', headers: { 'cf-ipcountry': 'US' } })).toBe('unknown');
    expect(resolver.resolve({ remoteAddress: '10.2.3.4', headers: { 'cf-ipcountry': 'USA' } })).toBe('unknown');
    expect(resolver.resolve({ remoteAddress: '10.2.3.4', headers: { 'x-forwarded-for': '198.51.100.2' } })).toBe('unknown');
  });
});

describe('browser country ingest privacy', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({
      countryResolver: createTrustedProxyCountryResolver({
        header: 'x-edge-country',
        trustedProxyCidrs: ['127.0.0.0/8', '::1/128'],
      }),
    });
  });
  afterAll(() => env.close());

  it('enriches a browser event without persisting the peer IP', async () => {
    const response = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        authorization: `Bearer ${env.ingestToken}`,
        'x-edge-country': 'NL',
      },
      payload: {
        events: [{
          event: 'page.viewed',
          distinct_id: 'visitor:one',
          session_id: 'session:one',
          properties: {
            $browser_context: '1',
            $page_path: '/pricing',
            $device_class: 'desktop',
            $browser_family: 'firefox',
            $os_family: 'linux',
            $language: 'en',
            $timezone: 'Europe/Amsterdam',
            $viewport_bucket: 'lg',
            $screen_bucket: 'xl',
          },
        }],
      },
    });
    expect(response.statusCode).toBe(200);
    const row = await env.pool.query<{ properties: Record<string, unknown> }>(
      `SELECT properties FROM events WHERE project_id = $1 AND event = 'page.viewed' AND distinct_id = 'visitor:one'`,
      [env.projectId],
    );
    expect(row.rows[0]?.properties.$country).toBe('NL');
    expect(JSON.stringify(row.rows[0])).not.toContain('127.0.0.1');
  });

  it('rejects a client-supplied country collision', async () => {
    const response = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: { authorization: `Bearer ${env.ingestToken}` },
      payload: {
        events: [{
          event: 'page.viewed', distinct_id: 'visitor:spoof', session_id: 'session:spoof',
          properties: {
            $browser_context: '1', $page_path: '/', $device_class: 'desktop',
            $browser_family: 'other', $os_family: 'other', $language: 'en',
            $timezone: 'UTC', $viewport_bucket: 'lg', $screen_bucket: 'lg', $country: 'US',
          },
        }],
      },
    });
    expect(response.statusCode).toBe(207);
    expect(response.json().errors[0].message).toContain('server-derived');
  });
});
