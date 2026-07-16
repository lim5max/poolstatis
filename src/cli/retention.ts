import { createPool, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { runRetentionOnce } from '../services/retention.js';
import { ensureRetentionIndexes } from '../services/retentionIndexes.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, { max: config.databasePoolMax });
try {
  await migrate(pool);
  const indexes = await ensureRetentionIndexes(pool);
  if (!indexes.ready) throw new Error('operational indexes are still being built; retry retention later');
  const result = await runRetentionOnce(pool, {
    batchSize: config.retentionWorker.batchSize,
    maxBatchesPerRun: config.retentionWorker.maxBatchesPerRun,
    maxRowsPerRun: config.retentionWorker.maxRowsPerRun,
    maxRunMs: config.retentionWorker.maxRunMs,
  });
  console.log(JSON.stringify({ indexes, retention: result }, null, 2));
} finally {
  await pool.end();
}
