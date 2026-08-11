import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolstatisClient } from './client';

describe('PoolstatisClient project portfolio', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requests the selected environment without widening the server-owned scope', async () => {
    const response = {
      schema_version: 1,
      generated_at: '2026-08-12T00:00:00.000Z',
      scope: {
        credential: 'organization', environment: 'release_candidate',
        usage_cycle: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z', timezone: 'UTC', basis: 'ingest_time' },
      },
      projects: [],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PoolstatisClient('https://api.example.test', 'pt_test');

    await expect(client.projectPortfolio('release_candidate')).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/projects/portfolio?env=release_candidate',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer pt_test' }),
      }),
    );
  });
});
