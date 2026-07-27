import ipaddr from 'ipaddr.js';

export interface CountryRequest {
  remoteAddress?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface CountryResolver {
  resolve(request: CountryRequest): string;
}

export interface TrustedProxyCountryOptions {
  header: string;
  trustedProxyCidrs: string[];
}

export function createTrustedProxyCountryResolver(options: TrustedProxyCountryOptions): CountryResolver {
  const header = options.header.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(header)) throw new Error('country header must be a valid HTTP header name');
  const ranges = options.trustedProxyCidrs.map((value) => ipaddr.parseCIDR(value));
  if (ranges.length === 0) throw new Error('at least one trusted proxy CIDR is required for country enrichment');
  return {
    resolve(request) {
      if (!request.remoteAddress) return 'unknown';
      let peer: ipaddr.IPv4 | ipaddr.IPv6;
      try {
        peer = ipaddr.process(request.remoteAddress);
      } catch {
        return 'unknown';
      }
      const trusted = ranges.some(([range, prefix]) => peer.kind() === range.kind() && peer.match(range, prefix));
      if (!trusted) return 'unknown';
      const raw = request.headers[header];
      const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
      return value && /^[A-Z]{2}$/.test(value) && value !== 'XX' ? value : 'unknown';
    },
  };
}

export const UNKNOWN_COUNTRY_RESOLVER: CountryResolver = {
  resolve: () => 'unknown',
};
