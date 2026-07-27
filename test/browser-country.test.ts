import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLocalMmdbCountryResolver,
  createLocalMmdbCountryResolverFromReader,
  createTrustedProxyCountryResolver,
  DB_IP_ATTRIBUTION,
} from '../src/services/country.js';
import { api, createTestEnv, type TestEnv } from './helpers.js';

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
    expect(resolver.resolve({ remoteAddress: '10.2.3.4', headers: { 'cf-ipcountry': 'ZZ' } })).toBe('unknown');
    expect(resolver.resolve({ remoteAddress: '10.2.3.4', headers: { 'cf-ipcountry': 'AA' } })).toBe('unknown');
    expect(resolver.resolve({ remoteAddress: '10.2.3.4', headers: { 'cf-ipcountry': 'XX' } })).toBe('unknown');
    expect(resolver.resolve({ remoteAddress: '10.2.3.4', headers: { 'x-forwarded-for': '198.51.100.2' } })).toBe('unknown');
  });
});

describe('local MMDB country enrichment', () => {
  it('looks up one public client IP only behind the configured direct proxy', () => {
    const lookups: string[] = [];
    const resolver = createLocalMmdbCountryResolverFromReader({
      databasePath: '/run/geoip/country.mmdb',
      clientIpHeader: 'x-poolstatis-client-ip',
      trustedProxyCidrs: ['172.30.0.0/24'],
    }, {
      metadata: { databaseType: 'DBIP-Country-Lite' },
      get(address) {
        lookups.push(address);
        return { country: { iso_code: 'DE' } };
      },
    });

    expect(resolver.attribution).toEqual(DB_IP_ATTRIBUTION);
    expect(resolver.resolve({
      remoteAddress: '172.30.0.8',
      headers: { 'x-poolstatis-client-ip': '1.1.1.1', 'x-edge-country': 'US' },
    })).toBe('DE');
    expect(lookups).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('fails closed before lookup for spoofed peers, chains, private IPs, and malformed values', () => {
    let lookups = 0;
    const resolver = createLocalMmdbCountryResolverFromReader({
      databasePath: '/run/geoip/country.mmdb',
      clientIpHeader: 'x-poolstatis-client-ip',
      trustedProxyCidrs: ['172.30.0.0/24'],
    }, {
      metadata: { databaseType: 'DBIP-Country-Lite' },
      get() {
        lookups += 1;
        return { country: { iso_code: 'US' } };
      },
    });
    lookups = 0;
    const resolve = (remoteAddress: string, value: string | string[]) => resolver.resolve({
      remoteAddress,
      headers: { 'x-poolstatis-client-ip': value, 'cf-ipcountry': 'US' },
    });

    expect(resolve('203.0.113.4', '1.1.1.1')).toBe('unknown');
    expect(resolve('172.30.0.8', '1.1.1.1, 2.2.2.2')).toBe('unknown');
    expect(resolve('172.30.0.8', ['1.1.1.1'])).toBe('unknown');
    expect(resolve('172.30.0.8', '127.0.0.1')).toBe('unknown');
    expect(resolve('172.30.0.8', '10.0.0.1')).toBe('unknown');
    expect(resolve('172.30.0.8', 'not-an-ip')).toBe('unknown');
    expect(lookups).toBe(0);
  });

  it('returns unknown for MMDB misses, failures, and invalid country codes', () => {
    const options = {
      databasePath: '/run/geoip/country.mmdb',
      clientIpHeader: 'x-poolstatis-client-ip',
      trustedProxyCidrs: ['172.30.0.0/24'],
    };
    const request = {
      remoteAddress: '172.30.0.8',
      headers: { 'x-poolstatis-client-ip': '1.1.1.1' },
    };
    const reader = (value: unknown) => {
      let first = true;
      return {
        metadata: { databaseType: 'DBIP-Country-Lite' },
        get() {
          if (first) {
            first = false;
            return { country: { iso_code: 'US' } };
          }
          if (value instanceof Error) throw value;
          return value;
        },
      };
    };
    expect(createLocalMmdbCountryResolverFromReader(options, reader(null)).resolve(request)).toBe('unknown');
    expect(createLocalMmdbCountryResolverFromReader(
      options,
      reader({ country: { iso_code: 'USA' } }),
    ).resolve(request)).toBe('unknown');
    expect(createLocalMmdbCountryResolverFromReader(
      options,
      reader(new Error('corrupt lookup')),
    ).resolve(request)).toBe('unknown');
  });

  it('rejects wrong-type and openable-but-invalid databases at startup', () => {
    const options = {
      databasePath: '/run/geoip/country.mmdb',
      clientIpHeader: 'x-poolstatis-client-ip',
      trustedProxyCidrs: ['172.30.0.0/24'],
    };
    expect(() => createLocalMmdbCountryResolverFromReader(options, {
      metadata: { databaseType: 'GeoLite2-ASN' },
      get: () => ({ country: { iso_code: 'US' } }),
    })).toThrow('must have database type DBIP-Country-Lite');
    expect(() => createLocalMmdbCountryResolverFromReader(options, {
      metadata: { databaseType: 'DBIP-Country-Lite' },
      get() {
        throw new Error('openable but corrupt tree');
      },
    })).toThrow('country MMDB smoke lookup failed');
    expect(() => createLocalMmdbCountryResolverFromReader(options, {
      metadata: { databaseType: 'DBIP-Country-Lite' },
      get: () => ({ country: { iso_code: 'USA' } }),
    })).toThrow('country MMDB smoke lookup failed');
  });

  it('fails startup when the configured MMDB cannot be opened', async () => {
    await expect(createLocalMmdbCountryResolver({
      databasePath: '/definitely-missing/poolstatis-country.mmdb',
      clientIpHeader: 'x-poolstatis-client-ip',
      trustedProxyCidrs: ['172.30.0.0/24'],
    })).rejects.toThrow('country MMDB could not be opened');
  });
});

describe('browser country ingest privacy', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({
      countryResolver: createLocalMmdbCountryResolverFromReader({
        databasePath: '/run/geoip/country.mmdb',
        clientIpHeader: 'x-poolstatis-client-ip',
        trustedProxyCidrs: ['127.0.0.0/8', '::1/128'],
      }, {
        metadata: { databaseType: 'DBIP-Country-Lite' },
        get: () => ({ country: { iso_code: 'NL' } }),
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
        'x-poolstatis-client-ip': '1.1.1.1',
        'x-edge-country': 'US',
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
    expect(JSON.stringify(row.rows[0])).not.toContain('1.1.1.1');
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

  it('rejects PII-shaped languages and malformed timezones before storage', async () => {
    const browserProperties = {
      $browser_context: '1', $page_path: '/', $device_class: 'desktop',
      $browser_family: 'other', $os_family: 'other',
      $viewport_bucket: 'lg', $screen_bucket: 'lg',
    };
    const response = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: { authorization: `Bearer ${env.ingestToken}` },
      payload: {
        events: [
          {
            event: 'page.viewed', distinct_id: 'visitor:pii-language', session_id: 'session:pii-language',
            properties: { ...browserProperties, $language: 'person@example.com', $timezone: 'UTC' },
          },
          {
            event: 'page.viewed', distinct_id: 'visitor:invalid-timezone', session_id: 'session:invalid-timezone',
            properties: { ...browserProperties, $language: 'en', $timezone: 'Internal/CustomerSecret' },
          },
        ],
      },
    });
    expect(response.statusCode).toBe(207);
    expect(response.json().errors).toHaveLength(2);
    const stored = await env.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM events
       WHERE project_id = $1 AND distinct_id = ANY($2::text[])`,
      [env.projectId, ['visitor:pii-language', 'visitor:invalid-timezone']],
    );
    expect(stored.rows[0]?.count).toBe('0');
  });
});

describe('country enrichment disabled by default', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(() => env.close());

  it('stores unknown when an untrusted client supplies an edge-looking header', async () => {
    const response = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        authorization: `Bearer ${env.ingestToken}`,
        'cf-ipcountry': 'US',
        'x-forwarded-for': '203.0.113.10',
      },
      payload: {
        events: [{
          event: 'page.viewed',
          distinct_id: 'visitor:untrusted-edge',
          session_id: 'session:untrusted-edge',
          properties: {
            $browser_context: '1',
            $page_path: '/',
            $device_class: 'desktop',
            $browser_family: 'other',
            $os_family: 'other',
            $language: 'en',
            $timezone: 'UTC',
            $viewport_bucket: 'lg',
            $screen_bucket: 'lg',
          },
        }],
      },
    });
    expect(response.statusCode).toBe(200);

    const sample = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/events/sample?event=page.viewed&env=prod&limit=1`,
    );
    expect(sample.status).toBe(200);
    expect(sample.body.events).toHaveLength(1);
    expect(sample.body.events[0]?.properties.$country).toBe('unknown');
    expect(JSON.stringify(sample.body)).not.toContain('203.0.113.10');
  });
});
