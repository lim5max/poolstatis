import { describe, expect, it } from 'vitest';
import { createApiKey } from '../src/services/projects.js';

describe('API key ownership boundary', () => {
  it('rejects owner fields for non-personal keys rather than creating cross-kind ownership', async () => {
    const pool = { query: async () => ({ rows: [{ id: 'unexpected' }] }) } as any;
    await expect(createApiKey(pool, {
      orgId: '00000000-0000-0000-0000-000000000001',
      projectId: '00000000-0000-0000-0000-000000000002',
      kind: 'secret',
      issuedByUserId: '00000000-0000-0000-0000-000000000003',
    } as any)).rejects.toThrow('issuedByUserId is only valid for personal keys');
  });
});
