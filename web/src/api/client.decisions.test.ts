import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolstatisClient } from './client';

describe('PoolstatisClient decisions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the selected environment with the optional decision filters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ decisions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PoolstatisClient('https://core.example', 'sk_test');

    await client.decisions('alpha', { env: 'dev', status: 'proposed', release_id: 'release-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://core.example/api/v1/projects/alpha/decisions?env=dev&status=proposed&release_id=release-1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('keeps the unfiltered request backward compatible', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ decisions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PoolstatisClient('https://core.example', 'sk_test');

    await client.decisions('alpha');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://core.example/api/v1/projects/alpha/decisions',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('registers immutable deployed release provenance through the Platform API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'release-1', idempotent: false,
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PoolstatisClient('https://core.example', 'sk_test');
    const body = {
      idempotency_key: 'activation:prod:abcdef1',
      contract_key: 'activation',
      env: 'prod',
      repository: 'acme/product',
      commit_sha: 'abcdef1',
      deployed_at: '2026-08-11T10:00:00.000Z',
      status: 'deployed' as const,
    };

    await client.registerRelease('alpha', body);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://core.example/api/v1/projects/alpha/releases',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  });
});
