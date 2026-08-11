import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolstatisClient } from './client';

describe('PoolstatisClient saved answers and readiness', () => {
  afterEach(() => vi.restoreAllMocks());

  it('encodes project, environment and server-owned list filters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ views: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PoolstatisClient('https://core.example', 'sk_test');

    await client.analysisViews('project/alpha', { env: 'prod eu', status: 'active', official: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://core.example/api/v1/projects/project%2Falpha/analysis-views?env=prod+eu&status=active&official=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses audited mutation routes and the typed readiness read', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      view: {}, schema_version: 1, groups: [], fix_next: null,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PoolstatisClient('https://core.example', 'pt_test');

    await client.setAnalysisViewOfficial('alpha', 'view/id', true);
    await client.archiveAnalysisView('alpha', 'view/id');
    await client.measurementReadiness('alpha', 'dev eu');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://core.example/api/v1/projects/alpha/analysis-views/view%2Fid/official',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ official: true }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://core.example/api/v1/projects/alpha/analysis-views/view%2Fid/archive',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://core.example/api/v1/projects/alpha/readiness?env=dev%20eu',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
