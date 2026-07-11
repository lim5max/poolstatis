import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(() => env.close());

describe('flags and experiments schema', () => {
  it('creates project-scoped flags and experiments tables', async () => {
    const { rows } = await env.pool.query<{ flags: string | null; experiments: string | null }>(
      "SELECT to_regclass('feature_flags') AS flags, to_regclass('experiments') AS experiments",
    );
    expect(rows[0]).toEqual({ flags: 'feature_flags', experiments: 'experiments' });
  });

  it('rejects duplicate variants and allocation above one hundred percent', async () => {
    const schemas = await import('../src/schemas.js') as Record<string, unknown>;
    const featureFlagSchema = schemas.featureFlagSchema as { safeParse: (value: unknown) => { success: boolean } } | undefined;
    expect(featureFlagSchema).toBeDefined();

    const result = featureFlagSchema!.safeParse({
      key: 'checkout_copy',
      name: 'Checkout copy',
      purpose: 'Safely roll out a new checkout call to action.',
      variants: [
        { key: 'control', rollout_percentage: 60 },
        { key: 'control', rollout_percentage: 60 },
      ],
    });

    expect(result.success).toBe(false);
  });
});
