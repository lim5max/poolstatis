import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '../db.js';
import { assertHostedApiCredentialBoundary, loadConfig } from '../config.js';
import { buildServer } from '../http/server.js';
import { startRetentionWorker } from '../services/retention.js';
import {
  ensureRetentionIndexes,
  retentionIndexesReady,
} from '../services/retentionIndexes.js';
import {
  PostgresEventStore,
  rollingEventPartitionsReady,
} from '../stores/postgresEventStore.js';
import { createContext } from '../http/context.js';
import { ReleaseMonitor, startReleaseMonitor } from '../services/releaseMonitor.js';
import { WebhookOutbox, startWebhookOutbox } from '../services/webhooks.js';
import {
  assertHostedRuntimeDatabaseRole,
  prepareHostedOrganizationPolicies,
} from '../services/accounts.js';
import { LocalArtifactStore } from '../stores/artifactStore.js';
import { LocalReplayObjectStore } from '../replay/objectStore.js';
import { ReplayService } from '../services/replay.js';
import { startReplayRetention } from '../services/replayRetention.js';
import { startExperienceArtifactRetention } from '../services/experienceArtifactRetention.js';
import {
  createLocalMmdbCountryResolver,
  createTrustedProxyCountryResolver,
} from '../services/country.js';
import { OpenRouterSetupTaskProvider } from '../services/setupTaskProvider.js';
import { ControlTowerAutomation, startControlTowerAutomation } from '../services/controlTowerAutomation.js';

const config = loadConfig();
const hostedPolicyRequired = config.auth?.requireOrganizationPolicy === true;
assertHostedApiCredentialBoundary(config);
const pool = createPool(config.databaseUrl, { max: config.databasePoolMax });
if (hostedPolicyRequired) {
  await assertHostedRuntimeDatabaseRole(pool, true);
  if (!await rollingEventPartitionsReady(pool, new Date(), 12)) {
    throw new Error(
      'hosted rolling event partitions are not ready; run the privileged prepare-hosted job',
    );
  }
  if (!await retentionIndexesReady(pool)) {
    throw new Error(
      'hosted runtime is not prepared; run the privileged prepare-hosted job before serve',
    );
  }
} else {
  await migrate(pool);
}
await prepareHostedOrganizationPolicies(
  pool,
  hostedPolicyRequired,
);
// Index builds and retention never borrow a request-serving connection.
const maintenanceApplicationName = `poolstatis-maintenance-${randomUUID()}`;
const maintenancePool = createPool(config.databaseUrl, {
  max: 1,
  applicationName: maintenanceApplicationName,
});

const countryResolver = config.browserCountry?.mode === 'local_mmdb'
  ? await createLocalMmdbCountryResolver(config.browserCountry)
  : config.browserCountry?.mode === 'trusted_header'
    ? createTrustedProxyCountryResolver(config.browserCountry)
    : undefined;

const app = buildServer(pool, {
  auth: config.auth,
  publicUrl: config.publicUrl,
  mcpRunner: config.mcpRunner,
  ...(config.setupTaskComposer.apiKey
    ? {
        setupTaskProvider: new OpenRouterSetupTaskProvider({
          apiKey: config.setupTaskComposer.apiKey,
          apiUrl: config.setupTaskComposer.apiUrl,
          model: config.setupTaskComposer.model,
          timeoutMs: config.setupTaskComposer.timeoutMs,
          maxOutputTokens: config.setupTaskComposer.maxOutputTokens,
        }),
      }
    : {}),
  ingestBuffer: config.ingestBuffer,
  queryCache: config.queryCache,
  rateLimit: config.rateLimit,
  corsOrigins: config.corsOrigins,
  outboundPolicy: config.outboundPolicy,
  manageEventPartitions: !hostedPolicyRequired,
  artifactDir: config.experienceArtifactDir,
  replayDir: config.replayArtifactDir,
  ...(countryResolver ? { countryResolver } : {}),
  ...(config.connectorEncryptionKey
    ? { connectorEncryptionKey: config.connectorEncryptionKey }
    : {}),
  ...(config.cursorSigningSecret
    ? { cursorSigningSecret: config.cursorSigningSecret }
    : {}),
});
await app.listen({ port: config.port, host: config.host });
console.log(`poolstatis listening on http://${config.host}:${config.port}`);

let stopping = false;
let retentionWorker: ReturnType<typeof startRetentionWorker> | null = null;
let releaseMonitorWorker: ReturnType<typeof startReleaseMonitor> | null = null;
let webhookOutboxWorker: ReturnType<typeof startWebhookOutbox> | null = null;
let experienceArtifactRetention: ReturnType<typeof startExperienceArtifactRetention> | null = null;
let replayRetention: ReturnType<typeof startReplayRetention> | null = null;
let controlTowerAutomationWorker: ReturnType<typeof startControlTowerAutomation> | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let maintenanceTask: Promise<void> | null = null;

const prepareMaintenance = async (): Promise<void> => {
  if (stopping) return;
  try {
    const indexes = hostedPolicyRequired
      ? {
          lockAcquired: false,
          ready: await retentionIndexesReady(maintenancePool),
          partitionsIndexed: 0,
          metadataIndexed: false,
        }
      : await ensureRetentionIndexes(maintenancePool);
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
      experienceArtifactRetention = startExperienceArtifactRetention(
        maintenancePool,
        new LocalArtifactStore(config.experienceArtifactDir),
        {
          intervalMs: config.retentionWorker.intervalMs,
          batchSize: Math.min(config.retentionWorker.batchSize, 500),
          onResult: (result) => {
            if (result.snapshotsDeleted > 0 || result.artifactErrors > 0) {
              console.log(JSON.stringify({ maintenance: 'experience-artifacts', ...result }));
            }
          },
          onError: (error) => console.error('experience artifact retention failed', error),
        },
      );
      replayRetention = startReplayRetention(
        new ReplayService(
          maintenancePool,
          new LocalReplayObjectStore(config.replayArtifactDir),
          {
            artifacts: new LocalArtifactStore(config.experienceArtifactDir),
            eventStore: new PostgresEventStore(maintenancePool, { managePartitions: false }),
          },
        ),
        maintenancePool,
        {
          intervalMs: config.retentionWorker.intervalMs,
          batchSize: Math.min(config.retentionWorker.batchSize, 100),
          onResult: (result) => {
            if (result.deleted > 0 || result.errors > 0) {
              console.log(JSON.stringify({ maintenance: 'session-replays', ...result }));
            }
          },
          onError: (error) => console.error('session replay retention failed', error),
        },
      );
    }
    if (config.releaseMonitor.enabled && !releaseMonitorWorker && !stopping) {
      const monitorContext = createContext(maintenancePool, {
        ingestBuffer: false,
        queryCache: false,
        ...(config.connectorEncryptionKey ? { connectorEncryptionKey: config.connectorEncryptionKey } : {}),
      });
      const monitor = new ReleaseMonitor(maintenancePool, monitorContext.query, {
        batchSize: config.releaseMonitor.batchSize,
        maxAttempts: config.releaseMonitor.maxAttempts,
        baseRetryMs: config.releaseMonitor.baseRetryMs,
        maxRetryMs: config.releaseMonitor.maxRetryMs,
        leaseMs: config.releaseMonitor.leaseMs,
        actor: 'worker:release-monitor',
      });
      releaseMonitorWorker = startReleaseMonitor(monitor, {
        intervalMs: config.releaseMonitor.intervalMs,
        onResult: (result) => {
          if (result.claimed > 0) console.log(JSON.stringify({ maintenance: 'release-monitor', ...result }));
        },
        onError: (error) => console.error('release monitor failed', error),
      });
    }
    if (config.controlTowerAutomation.enabled && !controlTowerAutomationWorker && !stopping) {
      const automationContext = createContext(maintenancePool, { ingestBuffer: false, queryCache: false,
        ...(config.connectorEncryptionKey ? { connectorEncryptionKey: config.connectorEncryptionKey } : {}) });
      const automation = new ControlTowerAutomation(maintenancePool, automationContext.query, {
        batchSize: config.controlTowerAutomation.batchSize,
        maxAttempts: config.controlTowerAutomation.maxAttempts,
        baseRetryMs: config.controlTowerAutomation.baseRetryMs,
        maxRetryMs: config.controlTowerAutomation.maxRetryMs,
        leaseMs: config.controlTowerAutomation.leaseMs,
        actor: 'worker:control-tower-automation',
      });
      controlTowerAutomationWorker = startControlTowerAutomation(automation, {
        intervalMs: config.controlTowerAutomation.intervalMs,
        onResult: (result) => {
          const claimed = result.monitors.claimed + result.feeds.claimed + result.notifications.claimed;
          if (claimed > 0) console.log(JSON.stringify({ maintenance: 'control-tower-automation', ...result }));
        },
        onError: (error) => console.error('control tower automation failed', error),
      });
    }
    if (config.webhookOutbox.enabled && config.connectorEncryptionKey && !webhookOutboxWorker && !stopping) {
      const outbox = new WebhookOutbox(maintenancePool, config.connectorEncryptionKey, {
        batchSize: config.webhookOutbox.batchSize,
        maxAttempts: config.webhookOutbox.maxAttempts,
        baseRetryMs: config.webhookOutbox.baseRetryMs,
        maxRetryMs: config.webhookOutbox.maxRetryMs,
        leaseMs: config.webhookOutbox.leaseMs,
        requestTimeoutMs: config.webhookOutbox.requestTimeoutMs,
      }, config.outboundPolicy);
      webhookOutboxWorker = startWebhookOutbox(outbox, {
        intervalMs: config.webhookOutbox.intervalMs,
        onResult: (result) => {
          if (result.claimed > 0) console.log(JSON.stringify({ maintenance: 'webhook-outbox', ...result }));
        },
        onError: (error) => console.error('webhook outbox failed', error),
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
    await releaseMonitorWorker?.stop();
    await webhookOutboxWorker?.stop();
    await controlTowerAutomationWorker?.stop();
    await experienceArtifactRetention?.stop();
    await replayRetention?.stop();
    await maintenancePool.end();
    await pool.end();
    process.exit(0);
  });
}
