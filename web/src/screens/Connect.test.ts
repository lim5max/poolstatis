import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { hostedConnectionError } from './Connect';

describe('hosted connection errors', () => {
  it('turns a readable authentication denial into an actionable verification message', () => {
    expect(hostedConnectionError(
      new ApiError('authentication_failed', 'authentication failed', undefined, 401),
    )).toBe(
      'Your sign-in session is unavailable or expired. Verify your email, then sign in again.',
    );
  });

  it('does not mislabel a real network failure as an email verification denial', () => {
    expect(hostedConnectionError(
      new ApiError('network', 'cannot reach the server'),
    )).toBe('cannot reach the server');
  });
});
