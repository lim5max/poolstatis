import type pg from 'pg';
import { createApiKey } from '../src/services/projects.js';

declare const pool: pg.Pool;

void createApiKey(pool, {
  orgId: 'org', projectId: null, kind: 'personal', issuedByUserId: 'user',
});
void createApiKey(pool, {
  orgId: 'org', projectId: null, kind: 'personal', legacySelfHost: true,
});

// @ts-expect-error hosted personal tokens must have an explicit owner.
void createApiKey(pool, { orgId: 'org', projectId: null, kind: 'personal' });
// @ts-expect-error secret/ingest keys never accept a personal-token owner.
void createApiKey(pool, { orgId: 'org', projectId: 'project', kind: 'secret', issuedByUserId: 'user' });
