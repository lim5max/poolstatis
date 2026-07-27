import ipaddr from 'ipaddr.js';

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
      return value && isIsoAlpha2Country(value) ? value : 'unknown';
    },
  };
}

export const UNKNOWN_COUNTRY_RESOLVER: CountryResolver = {
  resolve: () => 'unknown',
};
