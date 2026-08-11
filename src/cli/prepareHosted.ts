import { createPool, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { assertHostedDatabaseRoleSeparation } from '../services/accounts.js';
import { ensureRetentionIndexes } from '../services/retentionIndexes.js';
import {
  ensureRollingEventPartitions,
  ensureHistoricalEventPartitions,
  historicalEventPartitionsReady,
  rollingEventPartitionsReady,
} from '../stores/postgresEventStore.js';

if (process.argv.includes('--help')) {
  console.log('Usage: node dist/cli/prepareHosted.js');
} else {
  const config = loadConfig();
  if (config.auth?.requireOrganizationPolicy !== true) {
    throw new Error('prepare-hosted requires HOSTED_POLICY_REQUIRED=true');
  }
  if (config.migrationDatabaseUrl === null) {
    throw new Error('MIGRATION_DATABASE_URL is required for prepare-hosted');
  }
  const migrationPool = createPool(config.migrationDatabaseUrl, {
    max: config.databasePoolMax,
  });
  const runtimePool = createPool(config.databaseUrl, { max: 1 });
  try {
    const applied = await migrate(migrationPool);
    await migrationPool.query(
      'SELECT poolstatis_prepare_hosted_policy_role_hardening()',
    );
    await migrationPool.query(
      'SELECT poolstatis_prepare_visual_experience_role_grants()',
    );
    await migrationPool.query(
      'SELECT poolstatis_prepare_metric_taxonomy_role_grants()',
    );
    await migrationPool.query(
      'SELECT poolstatis_prepare_event_management_role_grants()',
    );
    await migrationPool.query(
      'SELECT poolstatis_prepare_project_intent_role_grants()',
    );
    await migrationPool.query(
      'SELECT poolstatis_prepare_analysis_views_role_grants()',
    );
    await migrationPool.query(
      'SELECT poolstatis_prepare_control_tower_automation_role_grants()',
    );
    await migrationPool.query(
      'SELECT poolstatis_prepare_metric_definition_role_grants()',
    );
    const now = new Date();
    const retention = await migrationPool.query<{ months: number }>(
      'SELECT COALESCE(max(retention_months), 12)::int AS months FROM projects',
    );
    const retentionMonths = Number(retention.rows[0]?.months ?? 12);
    await ensureRollingEventPartitions(migrationPool, now, 12);
    await ensureHistoricalEventPartitions(migrationPool, now, retentionMonths);
    if (!await rollingEventPartitionsReady(migrationPool, now, 12)
        || !await historicalEventPartitionsReady(migrationPool, now, retentionMonths)) {
      throw new Error('rolling event partitions are not ready');
    }
    const indexes = await ensureRetentionIndexes(migrationPool);
    if (!indexes.ready) throw new Error('operational indexes are not ready');
    await assertHostedDatabaseRoleSeparation(migrationPool, runtimePool, true);
    console.log(JSON.stringify({
      prepared: true,
      migrations_applied: applied,
      partition_months_ahead: 12,
      partition_months_behind: retentionMonths,
      indexes_ready: true,
    }));
  } finally {
    await Promise.allSettled([migrationPool.end(), runtimePool.end()]);
  }
}
