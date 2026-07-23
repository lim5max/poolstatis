import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import ipaddr from 'ipaddr.js';

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type OutboundResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export class OutboundPolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'OutboundPolicyError';
  }
}

export interface OutboundPolicyOptions {
  allowLocalHttp?: boolean;
  resolver?: OutboundResolver;
  /** Absolute budget including DNS resolution; connectors use their request timeout. */
  timeoutMs?: number;
}

export interface ResolvedOutboundTarget {
  url: string;
  hostname: string;
  address: string;
  family: 4 | 6;
}

const systemResolver: OutboundResolver = async (hostname) => {
  const { lookup } = await import('node:dns/promises');
  return lookup(hostname, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>;
};
const MAX_CONCURRENT_RESOLUTIONS = 64;
let activeResolutions = 0;

function boundedResolve(resolver: OutboundResolver, hostname: string): Promise<ResolvedAddress[]> {
  if (activeResolutions >= MAX_CONCURRENT_RESOLUTIONS) return Promise.reject(new OutboundPolicyError('outbound_dns_busy'));
  activeResolutions += 1;
  return resolver(hostname).finally(() => { activeResolutions -= 1; });
}

/**
 * Parse and resolve an outbound endpoint at the point of delivery.  The first
 * validated answer is later installed as the socket lookup result, preventing
 * a second unconstrained DNS lookup from changing the connection target.
 */
export async function resolveOutboundTarget(
  raw: string,
  options: OutboundPolicyOptions = {},
): Promise<ResolvedOutboundTarget> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OutboundPolicyError('outbound_url_invalid'); }
  if (url.username || url.password) throw new OutboundPolicyError('outbound_url_credentials');
  if (url.hash) throw new OutboundPolicyError('outbound_url_fragment');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutboundPolicyError('outbound_protocol_invalid');
  const local = isLoopbackHost(url.hostname);
  if (url.protocol === 'http:' && (!options.allowLocalHttp || !local)) {
    throw new OutboundPolicyError('outbound_http_disabled');
  }
  if (local && !options.allowLocalHttp) throw new OutboundPolicyError('outbound_address_unsafe');

  const literalFamily = isIP(stripBrackets(url.hostname));
  const answers = literalFamily
    ? [{ address: stripBrackets(url.hostname), family: literalFamily as 4 | 6 }]
    : await withDeadline(boundedResolve(options.resolver ?? systemResolver, url.hostname), options.timeoutMs ?? 10_000);
  if (!answers.length || answers.some((answer) => !validAddress(answer)
    || (isUnsafeAddress(answer.address) && !(options.allowLocalHttp && local && isLoopbackAddress(answer.address))))) {
    throw new OutboundPolicyError('outbound_address_unsafe');
  }
  // Local loopback is deliberately a controlled test/self-host exception only.
  if (!options.allowLocalHttp && answers.some((answer) => isLoopbackAddress(answer.address))) {
    throw new OutboundPolicyError('outbound_address_unsafe');
  }
  const pinned = answers[0]!;
  return { url: url.toString(), hostname: url.hostname, address: pinned.address, family: pinned.family };
}

export interface OutboundRequestOptions extends OutboundPolicyOptions {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface OutboundResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Actual DNS-pinned Node transport. Redirects are treated as errors, never followed. */
export async function requestOutbound(raw: string, options: OutboundRequestOptions): Promise<OutboundResponse> {
  const startedAt = Date.now();
  const target = await resolveOutboundTarget(raw, options);
  const remainingMs = options.timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw new OutboundPolicyError('outbound_timeout');
  const url = new URL(target.url);
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<OutboundResponse>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(error);
    };
    const resolveOnce = (response: OutboundResponse) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(response);
    };
    const req = request({
      protocol: url.protocol,
      // Connect to the verified address, while preserving HTTP Host and TLS SNI
      // for virtual-host routing/certificate validation.
      hostname: target.address,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: { ...options.headers, host: url.host },
      servername: url.protocol === 'https:' ? stripBrackets(url.hostname) : undefined,
    }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        rejectOnce(new OutboundPolicyError('outbound_redirect_disallowed'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxResponseBytes) {
          response.destroy(new OutboundPolicyError('outbound_response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', rejectOnce);
      response.once('end', () => {
        resolveOnce({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    deadline = setTimeout(() => req.destroy(new OutboundPolicyError('outbound_timeout')), remainingMs);
    req.once('error', rejectOnce);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Errors persisted in connector records must be stable codes, never transport text. */
export function sanitizedOutboundError(error: unknown): string {
  if (error instanceof OutboundPolicyError) return error.code;
  return 'outbound_request_failed';
}

function stripBrackets(value: string): string { return value.replace(/^\[|\]$/g, ''); }
function validAddress(value: ResolvedAddress): boolean {
  try { return ipaddr.parse(value.address).kind() === (value.family === 4 ? 'ipv4' : 'ipv6'); } catch { return false; }
}
function isLoopbackHost(host: string): boolean { return host.toLowerCase() === 'localhost' || isLoopbackAddress(stripBrackets(host)); }
function isLoopbackAddress(value: string): boolean {
  try { return ipaddr.parse(value).range() === 'loopback'; } catch { return false; }
}

function isUnsafeAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try { parsed = ipaddr.parse(address); } catch { return true; }
  if (parsed.kind() === 'ipv4') return parsed.range() !== 'unicast';
  const ipv6 = parsed as ipaddr.IPv6;
  if (ipv6.isIPv4MappedAddress()) return true;
  if (ipv6.range() !== 'unicast') return true;
  const blocked = [
    ipaddr.parseCIDR('2001::/23'),
    ipaddr.parseCIDR('2002::/16'),
    ipaddr.parseCIDR('3fff::/20'),
  ];
  return !ipv6.match(ipaddr.parseCIDR('2000::/3')) || blocked.some((range) => ipv6.match(range));
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new OutboundPolicyError('outbound_timeout')), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
