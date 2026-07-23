import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false });
  await env.pool.query(`
    CREATE TABLE test_database_policies (
      org_id uuid PRIMARY KEY,
      policy text NOT NULL
    );

    CREATE OR REPLACE FUNCTION test_usage_policy() RETURNS trigger AS $$
    DECLARE configured text;
    BEGIN
      SELECT policy INTO configured FROM test_database_policies WHERE org_id = NEW.org_id;
      IF configured = 'event_quota' THEN
        RAISE EXCEPTION 'hostile quota detail token=secret'
          USING ERRCODE = 'PSQ01', DETAIL = 'must never reach HTTP';
      ELSIF configured = 'organization_disabled' THEN
        RAISE EXCEPTION 'hostile disabled detail token=secret'
          USING ERRCODE = 'PSO01', DETAIL = 'must never reach HTTP';
      ELSIF configured = 'unrelated' THEN
        RAISE EXCEPTION 'hostile unrelated detail token=secret'
          USING ERRCODE = 'P0001', DETAIL = 'must never reach HTTP';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER test_usage_policy_trigger
      BEFORE INSERT ON usage_ledger
      FOR EACH ROW EXECUTE FUNCTION test_usage_policy();

    CREATE OR REPLACE FUNCTION test_project_policy() RETURNS trigger AS $$
    DECLARE configured text;
    DECLARE current_count bigint;
    BEGIN
      SELECT policy INTO configured FROM test_database_policies WHERE org_id = NEW.org_id;
      IF configured = 'project_quota' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('test-project:' || NEW.org_id::text, 0));
        SELECT count(*) INTO current_count FROM projects WHERE org_id = NEW.org_id;
        IF current_count >= 2 THEN
          RAISE EXCEPTION 'hostile project detail token=secret'
            USING ERRCODE = 'PSP01', DETAIL = 'must never reach HTTP';
        END IF;
      ELSIF configured = 'organization_disabled' THEN
        RAISE EXCEPTION 'hostile disabled detail token=secret'
          USING ERRCODE = 'PSO01', DETAIL = 'must never reach HTTP';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER test_project_policy_trigger
      BEFORE INSERT ON projects
      FOR EACH ROW EXECUTE FUNCTION test_project_policy();
  `);
});

afterAll(async () => {
  await env.pool.query(`
    DROP TRIGGER IF EXISTS test_usage_policy_trigger ON usage_ledger;
    DROP TRIGGER IF EXISTS test_project_policy_trigger ON projects;
    DROP FUNCTION IF EXISTS test_usage_policy();
    DROP FUNCTION IF EXISTS test_project_policy();
    DROP TABLE IF EXISTS test_database_policies;
  `).catch(() => undefined);
  await env.close();
});

async function orgId(): Promise<string> {
  const result = await env.pool.query<{ org_id: string }>(
    'SELECT org_id::text FROM projects WHERE id = $1',
    [env.projectId],
  );
  return result.rows[0]!.org_id;
}

async function setPolicy(policy: string | null): Promise<void> {
  const organizationId = await orgId();
  await env.pool.query('DELETE FROM test_database_policies WHERE org_id = $1', [organizationId]);
  if (policy) {
    await env.pool.query(
      'INSERT INTO test_database_policies (org_id, policy) VALUES ($1, $2)',
      [organizationId, policy],
    );
  }
}

describe('allowlisted database policy errors', () => {
  it('maps an event-storage policy to neutral 402 after rolling back event and usage writes', async () => {
    await setPolicy('event_quota');
    const response = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'database-event-quota',
      events: [{ event: 'database.policy.event', distinct_id: 'actor' }],
    });
    expect(response).toEqual({
      status: 402,
      body: {
        error: {
          code: 'billing_limit_reached',
          message: 'the accepted event batch would exceed an organization storage policy',
          hint: 'reduce the batch or ask an organization operator to change the storage policy',
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
    const stored = await env.pool.query<{ events: number; ledger: number; usage: number }>(
      `SELECT
         (SELECT count(*)::int FROM events WHERE project_id = $1 AND event = 'database.policy.event') AS events,
         (SELECT count(*)::int FROM usage_ledger WHERE project_id = $1 AND source_batch LIKE '%database-event-quota%') AS ledger,
         (SELECT count(*)::int FROM organization_usage
          WHERE org_id = (SELECT org_id FROM projects WHERE id = $1)) AS usage`,
      [env.projectId],
    );
    expect(stored.rows[0]).toEqual({ events: 0, ledger: 0, usage: 0 });
  });

  it('maps a project-count policy and serializes ten HTTP creates to exactly one success', async () => {
    await setPolicy('project_quota');
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api(env, env.personalToken, 'POST', '/api/v1/projects', {
          slug: `policy-project-${index}`,
          name: `Policy project ${index}`,
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 201)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 402)).toHaveLength(9);
    for (const attempt of attempts.filter((candidate) => candidate.status === 402)) {
      expect(attempt.body).toEqual({
        error: {
          code: 'project_limit_reached',
          message: 'the organization project policy does not allow another project',
          hint: 'reuse an existing project or ask an organization operator to change the project policy',
        },
      });
      expect(JSON.stringify(attempt.body)).not.toContain('secret');
    }
    const count = await env.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM projects WHERE org_id = $1',
      [await orgId()],
    );
    expect(count.rows[0]!.count).toBe(2);
  });

  it('maps an organization write-disable policy without exposing database details', async () => {
    await setPolicy('organization_disabled');
    const response = await api(env, env.personalToken, 'POST', '/api/v1/projects', {
      slug: 'disabled-write',
      name: 'Disabled write',
    });
    expect(response).toEqual({
      status: 402,
      body: {
        error: {
          code: 'organization_write_disabled',
          message: 'writes are disabled for this organization',
          hint: 'read access remains available; ask an organization operator to restore writes',
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('keeps unrelated database exceptions as neutral 500 errors', async () => {
    await setPolicy('unrelated');
    const response = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'database-unrelated',
      events: [{ event: 'database.policy.unrelated', distinct_id: 'actor' }],
    });
    expect(response).toEqual({
      status: 500,
      body: { error: { code: 'internal', message: 'internal error' } },
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('leaves self-host organizations without a policy unlimited', async () => {
    await setPolicy(null);
    for (let index = 0; index < 4; index += 1) {
      const created = await api(env, env.personalToken, 'POST', '/api/v1/projects', {
        slug: `self-host-unlimited-${index}`,
        name: `Self-host unlimited ${index}`,
      });
      expect(created.status).toBe(201);
    }
    const ingest = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'self-host-unlimited',
      events: [{ event: 'database.policy.selfhost', distinct_id: 'actor' }],
    });
    expect(ingest.status).toBe(200);
  });
});
