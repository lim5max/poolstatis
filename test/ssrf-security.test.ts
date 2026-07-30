import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OutboundPolicyError, requestOutbound, resolveOutboundTarget, sanitizedOutboundError } from '../src/security/outbound.js';

const resolver = async (host: string): Promise<Array<{ address: string; family: 4 | 6 }>> => {
  const answers: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
    'safe.example.test': [{ address: '93.184.216.34', family: 4 }],
    'mixed.example.test': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    'empty.example.test': [],
    'expanded.example.test': [{ address: '2001:0000:0000:0000:0000:0000:0000:0001', family: 6 }],
  };
  return answers[host] ?? [];
};

describe('central outbound URL policy', () => {
  it('rejects unsafe URL forms and every unsafe DNS answer before any connector transport', async () => {
    for (const value of [
      'https://user:secret@safe.example.test/hook',
      'https://safe.example.test/hook#fragment',
      'http://safe.example.test/hook',
      'https://127.0.0.1/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://192.0.0.8/',
      'https://192.88.99.2/',
      'https://[64:ff9b:1::1]/',
      'https://[100::1]/',
      'https://[100:0:0:1::1]/',
      'https://[2001:2::1]/',
      'https://[2002::1]/',
      'https://[3fff::1]/',
      'https://[5f00::1]/',
      'https://mixed.example.test/hook',
      'https://empty.example.test/hook',
      'https://expanded.example.test/hook',
    ]) {
      await expect(resolveOutboundTarget(value, { resolver })).rejects.toBeInstanceOf(OutboundPolicyError);
    }
  });

  it('fails closed when the resolver exceeds the outbound wall-clock budget', async () => {
    const hanging = () => new Promise<Array<{ address: string; family: 4 | 6 }>>(() => {});
    await expect(resolveOutboundTarget('https://safe.example.test/', { resolver: hanging, timeoutMs: 10 }))
      .rejects.toMatchObject({ code: 'outbound_timeout' });
  });

  it('permits only explicit controlled local HTTP and pins the validated address', async () => {
    await expect(resolveOutboundTarget('http://127.0.0.1:43123/test', { resolver }))
      .rejects.toMatchObject({ code: 'outbound_http_disabled' });

    await expect(resolveOutboundTarget('http://127.0.0.1:43123/test', {
      allowLocalHttp: true,
      resolver,
    })).resolves.toMatchObject({ url: 'http://127.0.0.1:43123/test', address: '127.0.0.1', family: 4 });
  });

  it('never persists or logs credential-bearing fetch errors verbatim', () => {
    const error = new Error('request to https://user:token@safe.example.test/hook?api_key=secret failed');
    const sanitized = sanitizedOutboundError(error);
    expect(sanitized).toBe('outbound_request_failed');
    expect(sanitized).not.toContain('token');
    expect(sanitized).not.toContain('safe.example.test');
  });

  it('uses the just-validated resolver answer, rejects redirects before reading bodies, and cancels streamed overflow', async () => {
    let reached = 0;
    let hostHeader = '';
    const server = createServer((req, res) => {
      reached += 1;
      hostHeader = String(req.headers.host ?? '');
      if (req.url === '/redirect') { res.writeHead(302, { location: '/large' }); res.end('must-not-follow'); return; }
      if (req.url === '/slow') { res.writeHead(200); res.write('a'); setTimeout(() => res.end('b'), 250); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.alloc(40 * 1024));
      res.end(Buffer.alloc(40 * 1024));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    const localResolver = async (): Promise<Array<{ address: string; family: 4 | 6 }>> => [{ address: '127.0.0.1', family: 4 }];
    try {
      await expect(requestOutbound(`http://localhost:${port}/redirect`, {
        resolver: localResolver, allowLocalHttp: true, method: 'GET', timeoutMs: 1_000, maxResponseBytes: 64 * 1024,
      })).rejects.toMatchObject({ code: 'outbound_redirect_disallowed' });
      await expect(requestOutbound(`http://localhost:${port}/large`, {
        resolver: localResolver, allowLocalHttp: true, method: 'GET', timeoutMs: 1_000, maxResponseBytes: 64 * 1024,
      })).rejects.toMatchObject({ code: 'outbound_response_too_large' });
      await expect(requestOutbound(`http://localhost:${port}/slow`, {
        resolver: localResolver, allowLocalHttp: true, method: 'GET', headers: { host: 'attacker.example' }, timeoutMs: 50, maxResponseBytes: 64 * 1024,
      })).rejects.toMatchObject({ code: 'outbound_timeout' });
      expect(hostHeader).toBe(`localhost:${port}`);
      expect(reached).toBe(3);
    } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
  });
});
