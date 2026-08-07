import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolstatisClient } from './client';

describe('PoolstatisClient usage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the legacy month request and sends encoded inclusive month-range bounds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PoolstatisClient('https://core.example', 'pt_test');

    await client.usage('2026-08');
    await client.usageRange('2026-03', '2026-08');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://core.example/api/v1/me/usage?period=2026-08',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://core.example/api/v1/me/usage/range?from=2026-03&to=2026-08',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
