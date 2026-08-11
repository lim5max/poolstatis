import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';

describe('control tower automation persistence', () => {
  let env: TestEnv;

  beforeAll(async () => { env = await createTestEnv(); });
  afterAll(async () => { await env.close(); });

  test('installs versioned resources, durable jobs and immutable semantic records', async () => {
    const expected = [
      'notification_destinations',
      'notification_destination_audit',
      'monitor_policies',
      'monitor_policy_revisions',
      'monitor_policy_audit',
      'monitor_runs',
      'monitor_findings',
      'automation_proposals',
      'automation_proposal_audit',
      'insight_feed_schedules',
      'insight_feed_schedule_revisions',
      'insight_feed_schedule_audit',
      'insight_feed_runs',
      'insight_feed_snapshots',
      'notification_deliveries',
      'notification_delivery_attempts',
      'notification_inbox',
    ];
    const tables = await env.pool.query<{ name: string | null }>(
      'SELECT to_regclass(name)::text AS name FROM unnest($1::text[]) names(name)',
      [expected],
    );
    expect(tables.rows.map((row) => row.name)).toEqual(expected);

    const indexes = await env.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename IN ('monitor_policies', 'monitor_policy_revisions', 'monitor_runs',
           'insight_feed_schedules', 'insight_feed_runs', 'notification_deliveries')`,
    );
    const definitions = indexes.rows.map((row) => row.indexdef).join('\n');
    expect(definitions).toContain('(project_id, policy_key)');
    expect(definitions).toContain('(policy_id, version)');
    expect(definitions).toContain('(project_id, deduplication_key)');
    expect(definitions).toContain('(project_id, schedule_key)');
    expect(definitions).toContain('(schedule_id, local_run_key)');
    expect(definitions).toContain('(project_id, idempotency_key)');
  });

  test('protects findings, snapshots, inbox, audit and attempt history from mutation', async () => {
    const protectedTables = [
      'monitor_policy_revisions', 'monitor_policy_audit', 'monitor_findings',
      'automation_proposal_audit', 'insight_feed_schedule_revisions',
      'insight_feed_schedule_audit', 'insight_feed_snapshots',
      'notification_delivery_attempts', 'notification_inbox', 'notification_destination_audit',
    ];
    const triggers = await env.pool.query<{ table_name: string }>(
      `SELECT event_object_table AS table_name
       FROM information_schema.triggers
       WHERE trigger_schema = current_schema()
         AND action_statement LIKE '%poolstatis_reject_immutable_mutation%'
         AND event_object_table = ANY($1::text[])
       GROUP BY event_object_table`,
      [protectedTables],
    );
    expect(triggers.rows.map((row) => row.table_name).sort()).toEqual([...protectedTables].sort());
  });
});
