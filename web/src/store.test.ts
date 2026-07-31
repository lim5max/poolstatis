import { describe, expect, it } from 'vitest';
import { loadProjectEnvironments, normalizeProjectEnv } from './store';

describe('project environment normalization', () => {
  it('keeps a valid project env and otherwise fails closed to prod or the first available env', () => {
    expect(normalizeProjectEnv('staging', ['prod', 'staging'])).toBe('staging');
    expect(normalizeProjectEnv('staging', ['prod'])).toBe('prod');
    expect(normalizeProjectEnv('prod', ['development'])).toBe('development');
    expect(normalizeProjectEnv('staging', [])).toBe('prod');
  });

  it('does not invent prod when environment validation fails', async () => {
    await expect(loadProjectEnvironments(async () => {
      throw new Error('request failed');
    })).rejects.toThrow('request failed');
    await expect(loadProjectEnvironments(async () => [])).resolves.toEqual(['prod']);
  });
});
