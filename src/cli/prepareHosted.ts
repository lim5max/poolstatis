import { createPool, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { assertHostedDatabaseRoleSeparation } from '../services/accounts.js';
import { ensureRetentionIndexes } from '../services/retentionIndexes.js';
import {
  ensureRollingEventPartitions,
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
      'SELECT poolstatis_apply_hosted_policy_role_hardening()',
    );
    await ensureRollingEventPartitions(migrationPool, new Date(), 12);
    if (!await rollingEventPartitionsReady(migrationPool, new Date(), 12)) {
      throw new Error('rolling event partitions are not ready');
    }
    const indexes = await ensureRetentionIndexes(migrationPool);
    if (!indexes.ready) throw new Error('operational indexes are not ready');
    await assertHostedDatabaseRoleSeparation(migrationPool, runtimePool, true);
    console.log(JSON.stringify({
      prepared: true,
      migrations_applied: applied,
      partition_months_ahead: 12,
      indexes_ready: true,
    }));
  } finally {
    await Promise.allSettled([migrationPool.end(), runtimePool.end()]);
  }
}
