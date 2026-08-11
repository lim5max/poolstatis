import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, PoolstatisClient } from './client';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonResponseWithRequestId(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
  });
}

describe('PoolstatisClient hosted session recovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('silently refreshes once and retries a transient session-not-found response', async () => {
    const getToken = vi.fn()
      .mockResolvedValueOnce('stale-access-token')
      .mockResolvedValueOnce('renewed-access-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({
        error: { code: 'unauthorized', message: 'session not found' },
      }, 401))
      .mockResolvedValueOnce(jsonResponse({ projects: [], scope: 'org' }, 200));
    const client = new PoolstatisClient('https://api.example.test', getToken);

    await expect(client.listProjects()).resolves.toEqual({ projects: [], scope: 'org' });

    expect(getToken).toHaveBeenNthCalledWith(1);
    expect(getToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ authorization: 'Bearer stale-access-token' }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ authorization: 'Bearer renewed-access-token' }),
    });
  });

  it('bounds recovery to one refresh and one request retry', async () => {
    const getToken = vi.fn()
      .mockResolvedValueOnce('stale-access-token')
      .mockResolvedValueOnce('still-stale-access-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      }, 401));
    const client = new PoolstatisClient('https://api.example.test', getToken);

    await expect(client.listProjects()).rejects.toMatchObject({
      code: 'session_recovery_failed',
      status: 401,
      message: 'Your sign-in session could not be restored. Sign in again.',
    });

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a clear reauthentication fallback when silent refresh fails', async () => {
    const getToken = vi.fn()
      .mockResolvedValueOnce('stale-access-token')
      .mockRejectedValueOnce(new Error('refresh session not found'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      error: { code: 'unauthorized', message: 'session not found' },
    }, 401));
    const client = new PoolstatisClient('https://api.example.test', getToken);

    await expect(client.listProjects()).rejects.toMatchObject({
      code: 'session_recovery_failed',
      status: 401,
      message: 'Your sign-in session could not be restored. Sign in again.',
    });

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not refresh for a generic unauthorized response that represents a real logout', async () => {
    const getToken = vi.fn().mockResolvedValue('access-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      error: { code: 'unauthorized', message: 'authentication failed' },
    }, 401));
    const client = new PoolstatisClient('https://api.example.test', getToken);

    await expect(client.listProjects()).rejects.toBeInstanceOf(ApiError);

    expect(getToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not attempt hosted recovery for static API keys', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      error: { code: 'session_not_found', message: 'Session not found' },
    }, 401));
    const client = new PoolstatisClient('https://api.example.test', 'sk_static');

    await expect(client.listProjects()).rejects.toMatchObject({
      code: 'session_not_found',
      status: 401,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves a server request ID in the typed and user-visible error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseWithRequestId({
      error: { code: 'internal_error', message: 'request failed' },
    }, 500, 'req-support-123'));
    const client = new PoolstatisClient('https://api.example.test', 'sk_static');

    await expect(client.listProjects()).rejects.toMatchObject({
      code: 'internal_error',
      requestId: 'req-support-123',
      message: 'request failed (Request ID: req-support-123)',
    });
  });
});
