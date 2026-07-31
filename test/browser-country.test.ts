import { describe, expect, it } from 'vitest';
import {
  createLocalMmdbCountryResolver,
  createLocalMmdbCountryResolverFromReader,
  createTrustedProxyCountryResolver,
  DB_IP_ATTRIBUTION,
} from '../src/services/country.js';

describe('trusted proxy country resolver remains available for a separately reviewed rollout', () => {
  const resolver = createTrustedProxyCountryResolver({
    header: 'cf-ipcountry',
    trustedProxyCidrs: ['10.0.0.0/8', '2001:db8::/32'],
  });

  it('accepts an ISO country only from a configured direct proxy peer', () => {
    expect(resolver.resolve({
      remoteAddress: '10.2.3.4',
      headers: { 'cf-ipcountry': 'DE' },
    })).toBe('DE');
    expect(resolver.resolve({
      remoteAddress: '2001:db8::7',
      headers: { 'cf-ipcountry': 'br' },
    })).toBe('BR');
  });

  it('fails closed for spoofed, malformed, or unavailable headers', () => {
    expect(resolver.resolve({
      remoteAddress: '203.0.113.10',
      headers: { 'cf-ipcountry': 'US' },
    })).toBe('unknown');
    expect(resolver.resolve({
      remoteAddress: '10.2.3.4',
      headers: { 'cf-ipcountry': 'USA' },
    })).toBe('unknown');
    expect(resolver.resolve({
      remoteAddress: '10.2.3.4',
      headers: { 'cf-ipcountry': 'ZZ' },
    })).toBe('unknown');
    expect(resolver.resolve({
      remoteAddress: '10.2.3.4',
      headers: { 'x-forwarded-for': '198.51.100.2' },
    })).toBe('unknown');
  });
});

describe('local MMDB country resolver remains fail-closed', () => {
  const options = {
    databasePath: '/run/geoip/country.mmdb',
    clientIpHeader: 'x-poolstatis-client-ip',
    trustedProxyCidrs: ['172.30.0.0/24'],
  };

  it('looks up one public client IP only behind the configured direct proxy', () => {
    const lookups: string[] = [];
    const resolver = createLocalMmdbCountryResolverFromReader(options, {
      metadata: { databaseType: 'DBIP-Country-Lite' },
      get(address) {
        lookups.push(address);
        return { country: { iso_code: 'DE' } };
      },
    });
    lookups.length = 0;

    expect(resolver.attribution).toEqual(DB_IP_ATTRIBUTION);
    expect(resolver.resolve({
      remoteAddress: '172.30.0.8',
      headers: { 'x-poolstatis-client-ip': '1.1.1.1', 'x-edge-country': 'US' },
    })).toBe('DE');
    expect(lookups).toEqual(['1.1.1.1']);
  });

  it('rejects spoofed peers, chains, private IPs, malformed values, and lookup failures', () => {
    let lookups = 0;
    const resolver = createLocalMmdbCountryResolverFromReader(options, {
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

  it('rejects wrong-type, corrupt, and missing databases at startup', async () => {
    expect(() => createLocalMmdbCountryResolverFromReader(options, {
      metadata: { databaseType: 'GeoLite2-ASN' },
      get: () => ({ country: { iso_code: 'US' } }),
    })).toThrow('must have database type DBIP-Country-Lite');
    expect(() => createLocalMmdbCountryResolverFromReader(options, {
      metadata: { databaseType: 'DBIP-Country-Lite' },
      get() {
        throw new Error('corrupt lookup');
      },
    })).toThrow('country MMDB smoke lookup failed');
    await expect(createLocalMmdbCountryResolver({
      ...options,
      databasePath: '/definitely-missing/poolstatis-country.mmdb',
    })).rejects.toThrow('country MMDB could not be opened');
  });
});
