import ipaddr from 'ipaddr.js';
import { open, type CountryResponse, type Reader } from 'maxmind';

const ISO_ALPHA_2_COUNTRIES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/),
);

export function isIsoAlpha2Country(value: string): boolean {
  return ISO_ALPHA_2_COUNTRIES.has(value);
}

export interface CountryRequest {
  remoteAddress?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface CountryResolver {
  resolve(request: CountryRequest): string;
  attribution?: {
    label: string;
    url: string;
  };
}

export interface TrustedProxyCountryOptions {
  header: string;
  trustedProxyCidrs: string[];
}

export interface LocalMmdbCountryOptions {
  databasePath: string;
  clientIpHeader: string;
  trustedProxyCidrs: string[];
}

type CountryReader = Pick<Reader<CountryResponse>, 'get'> & {
  metadata: Pick<Reader<CountryResponse>['metadata'], 'databaseType'>;
};

export const DB_IP_ATTRIBUTION = {
  label: 'IP Geolocation by DB-IP',
  url: 'https://db-ip.com',
} as const;

const DB_IP_DATABASE_TYPE = 'DBIP-Country-Lite';
const DATABASE_SMOKE_ADDRESS = '8.8.8.8';

function parseTrustedRanges(cidrs: string[]): ReturnType<typeof ipaddr.parseCIDR>[] {
  const ranges = cidrs.map((value) => ipaddr.parseCIDR(value));
  if (ranges.length === 0) throw new Error('at least one trusted proxy CIDR is required for country enrichment');
  return ranges;
}

function isTrustedPeer(
  remoteAddress: string | undefined,
  ranges: ReturnType<typeof ipaddr.parseCIDR>[],
): boolean {
  if (!remoteAddress) return false;
  try {
    const peer = ipaddr.process(remoteAddress);
    return ranges.some(([range, prefix]) => peer.kind() === range.kind() && peer.match(range, prefix));
  } catch {
    return false;
  }
}

function validHeaderName(value: string, label: string): string {
  const header = value.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(header)) throw new Error(`${label} must be a valid HTTP header name`);
  return header;
}

export function createTrustedProxyCountryResolver(options: TrustedProxyCountryOptions): CountryResolver {
  const header = validHeaderName(options.header, 'country header');
  const ranges = parseTrustedRanges(options.trustedProxyCidrs);
  return {
    resolve(request) {
      if (!isTrustedPeer(request.remoteAddress, ranges)) return 'unknown';
      const raw = request.headers[header];
      const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
      return value && isIsoAlpha2Country(value) ? value : 'unknown';
    },
  };
}

export function createLocalMmdbCountryResolverFromReader(
  options: LocalMmdbCountryOptions,
  reader: CountryReader,
): CountryResolver {
  if (reader.metadata.databaseType !== DB_IP_DATABASE_TYPE) {
    throw new Error(`country MMDB must have database type ${DB_IP_DATABASE_TYPE}`);
  }
  try {
    const smokeCountry = reader.get(DATABASE_SMOKE_ADDRESS)?.country?.iso_code?.trim().toUpperCase();
    if (!smokeCountry || !isIsoAlpha2Country(smokeCountry)) {
      throw new Error('country MMDB smoke lookup returned an invalid record');
    }
  } catch (cause) {
    throw new Error('country MMDB smoke lookup failed', { cause });
  }
  const header = validHeaderName(options.clientIpHeader, 'client IP header');
  const ranges = parseTrustedRanges(options.trustedProxyCidrs);
  return {
    attribution: DB_IP_ATTRIBUTION,
    resolve(request) {
      if (!isTrustedPeer(request.remoteAddress, ranges)) return 'unknown';
      const raw = request.headers[header];
      if (Array.isArray(raw) || typeof raw !== 'string' || raw.includes(',')) return 'unknown';
      let address: ipaddr.IPv4 | ipaddr.IPv6;
      try {
        address = ipaddr.process(raw.trim());
      } catch {
        return 'unknown';
      }
      // Only public client addresses may reach the local lookup. Private, reserved,
      // loopback, link-local and proxy-chain values fail closed.
      if (address.range() !== 'unicast') return 'unknown';
      try {
        const value = reader.get(address.toString())?.country?.iso_code?.trim().toUpperCase();
        return value && isIsoAlpha2Country(value) ? value : 'unknown';
      } catch {
        return 'unknown';
      }
    },
  };
}

export async function createLocalMmdbCountryResolver(
  options: LocalMmdbCountryOptions,
): Promise<CountryResolver> {
  let reader: Reader<CountryResponse>;
  try {
    reader = await open<CountryResponse>(options.databasePath, { cache: { max: 10_000 } });
  } catch (cause) {
    throw new Error('country MMDB could not be opened', { cause });
  }
  return createLocalMmdbCountryResolverFromReader(options, reader);
}

export const UNKNOWN_COUNTRY_RESOLVER: CountryResolver = {
  resolve: () => 'unknown',
};
