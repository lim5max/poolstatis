import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { buildServer } from '../http/server.js';
import { startRetentionWorker } from '../services/retention.js';
import { ensureRetentionIndexes } from '../services/retentionIndexes.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, { max: config.databasePoolMax });
await migrate(pool);
// Index builds and retention never borrow a request-serving connection.
const maintenanceApplicationName = `poolstatis-maintenance-${randomUUID()}`;
const maintenancePool = createPool(config.databaseUrl, {
  max: 1,
  applicationName: maintenanceApplicationName,
});

const app = buildServer(pool, {
  auth: config.auth,
  publicUrl: config.publicUrl,
  mcpRunner: config.mcpRunner,
  ingestBuffer: config.ingestBuffer,
  queryCache: config.queryCache,
  rateLimit: config.rateLimit,
});
await app.listen({ port: config.port, host: config.host });
console.log(`poolstatis listening on http://${config.host}:${config.port}`);

let stopping = false;
let retentionWorker: ReturnType<typeof startRetentionWorker> | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let maintenanceTask: Promise<void> | null = null;

const prepareMaintenance = async (): Promise<void> => {
  if (stopping) return;
  try {
    const indexes = await ensureRetentionIndexes(maintenancePool);
    if (indexes.partitionsIndexed > 0 || indexes.metadataIndexed) {
      console.log(JSON.stringify({ maintenance: 'operational_indexes', ...indexes }));
    }
    if (!indexes.ready) {
      maintenanceTimer = setTimeout(() => { maintenanceTask = prepareMaintenance(); }, 5_000);
      maintenanceTimer.unref();
      return;
    }
    if (config.retentionWorker.enabled && !retentionWorker && !stopping) {
      retentionWorker = startRetentionWorker(maintenancePool, {
      intervalMs: config.retentionWorker.intervalMs,
      continuationDelayMs: config.retentionWorker.continuationDelayMs,
      maxConsecutiveContinuations: config.retentionWorker.maxConsecutiveContinuations,
      maxRunMs: config.retentionWorker.maxRunMs,
      maxRowsPerRun: config.retentionWorker.maxRowsPerRun,
      batchSize: config.retentionWorker.batchSize,
      maxBatchesPerRun: config.retentionWorker.maxBatchesPerRun,
      onResult: (result) => {
        if (result.eventsDeleted + result.ingestBatchesDeleted + result.experienceBatchesDeleted
          + result.warningsDeleted + result.projectErrors > 0) {
          console.log(JSON.stringify({ maintenance: 'retention', ...result }));
        }
      },
      onError: (error) => console.error('retention worker failed', error),
      });
    }
  } catch (error) {
    console.error('operational index preparation failed', error);
    if (!stopping) {
      maintenanceTimer = setTimeout(() => { maintenanceTask = prepareMaintenance(); }, 30_000);
      maintenanceTimer.unref();
    }
  }
};
maintenanceTask = prepareMaintenance();


for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    if (maintenanceTimer) clearTimeout(maintenanceTimer);
    await app.close();
    // Cancel a long CREATE INDEX/retention statement so shutdown does not wait
    // for the maintenance pool beyond the orchestrator's grace period.
    await pool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE application_name = $1 AND pid <> pg_backend_pid()`,
      [maintenanceApplicationName],
    ).catch((error) => console.error('failed to cancel maintenance backend', error));
    await maintenanceTask;
    await retentionWorker?.stop();
    await maintenancePool.end();
    await pool.end();
    process.exit(0);
  });
}
