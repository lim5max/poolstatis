/**
 * Seed a demo project with a realistic ~12-week dataset so every query type
 * (trend, funnel, retention, lifecycle, stickiness) has something to show.
 *
 * Usage: pnpm seed [slug]   (default slug: demo)
 * Idempotent-ish: re-running creates a fresh org/project each time.
 */
import { createPool, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createApiKey, createOrganization, createProject } from '../services/projects.js';
import { registerMetric, updateMetric, defineFunnel, registerEntityType } from '../services/registry.js';
import { upsertEntities } from '../services/entities.js';
import { createContext } from '../http/context.js';
import type { IngestEnvelope } from '../schemas.js';

const slug = process.argv[2] ?? 'demo';
const DAY = 86_400_000;
const PLANS = ['free', 'free', 'free', 'pro', 'pro', 'team'] as const;

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

const pool = createPool(loadConfig().databaseUrl);
const ctx = createContext(pool);

try {
  await migrate(pool);
  const org = await createOrganization(pool, `Acme (${slug})`);
  const project = await createProject(pool, org.id, slug, 'Acme App');
  const pid = project.id;
  const ingest = await createApiKey(pool, { orgId: org.id, projectId: pid, kind: 'ingest', env: 'prod' });
  const secret = await createApiKey(pool, { orgId: org.id, projectId: pid, kind: 'secret' });
  const personal = await createApiKey(pool, { orgId: org.id, projectId: null, kind: 'personal', legacySelfHost: true });

  // ---- registry ----
  const metrics: Array<Parameters<typeof registerMetric>[2]> = [
    { key: 'signup', name: 'Signups', purpose: 'Counts completed signups to size top-of-funnel acquisition.', category: 'acquisition', type: 'count', source: { event: 'signup.completed', filters: [] } },
    { key: 'activation_export', name: 'First export', purpose: 'Counts document exports, the activation aha-moment we drive new users toward.', category: 'activation', type: 'count', source: { event: 'doc.exported', filters: [] } },
    { key: 'daily_active', name: 'Active users', purpose: 'Unique users opening the app, the heartbeat metric for retention and lifecycle.', category: 'retention', type: 'unique_actors', source: { event: 'app.opened', filters: [] } },
    { key: 'revenue', name: 'Revenue', purpose: 'Sum of checkout amounts to track the money the product makes.', category: 'revenue', type: 'value', source: { event: 'checkout.completed', value_property: 'amount', agg: 'sum' } },
    { key: 'checkout', name: 'Checkouts', purpose: 'Counts completed purchases, the bottom of the revenue funnel.', category: 'revenue', type: 'count', source: { event: 'checkout.completed', filters: [] } },
  ];
  for (const m of metrics) {
    await registerMetric(pool, pid, m, 'seed');
    await updateMetric(pool, pid, m.key, { status: 'active' });
  }
  await defineFunnel(pool, pid, {
    key: 'activation', name: 'Activation funnel', goal: 'Take a new signup to their first export and then a paid checkout.',
    steps: [
      { metric_key: 'signup', label: 'Signed up' },
      { metric_key: 'activation_export', label: 'Exported a doc' },
      { metric_key: 'checkout', label: 'Purchased' },
    ],
    window_seconds: 14 * 86400,
  });
  await registerEntityType(pool, pid, { name: 'account', description: 'A customer account with plan and seat count, used for state metrics and breakdowns.' });

  // ---- events: 260 users over 84 days ----
  const now = Date.now();
  const start = now - 84 * DAY;
  const events: IngestEnvelope['events'] = [];
  const accounts: Array<{ entity_type: string; entity_id: string; properties: Record<string, unknown> }> = [];

  for (let u = 0; u < 260; u++) {
    const id = `u_${u}`;
    const plan = pick(PLANS);
    const signupAt = start + Math.random() * 80 * DAY;
    events.push({ event: 'signup.completed', distinct_id: id, timestamp: new Date(signupAt).toISOString(), properties: { plan } });
    accounts.push({ entity_type: 'account', entity_id: id, properties: { plan, seats: plan === 'team' ? 5 + Math.floor(Math.random() * 20) : 1 } });

    // engagement: returns with decaying probability — produces a retention curve
    const engagement = 0.3 + Math.random() * 0.6;
    for (let d = 0; d < 84; d++) {
      const dayTs = signupAt + d * DAY;
      if (dayTs > now) break;
      const p = engagement * Math.exp(-d / (10 + engagement * 30));
      if (Math.random() < p) {
        events.push({ event: 'app.opened', distinct_id: id, timestamp: new Date(dayTs + 3600_000).toISOString(), properties: { plan } });
        if (Math.random() < 0.4) events.push({ event: 'doc.exported', distinct_id: id, timestamp: new Date(dayTs + 7200_000).toISOString(), properties: { plan } });
        if (plan !== 'free' && Math.random() < 0.05) {
          events.push({ event: 'checkout.completed', distinct_id: id, timestamp: new Date(dayTs + 9000_000).toISOString(), properties: { plan, amount: plan === 'team' ? 99 : 29 } });
        }
      }
    }
  }

  await upsertEntities(pool, pid, 'prod', { entities: accounts });
  // ingest in batches of 500
  let accepted = 0;
  for (let i = 0; i < events.length; i += 500) {
    const r = await ctx.ingest.processBatch({ id: pid, retention_months: 12 }, 'prod', { events: events.slice(i, i + 500) });
    accepted += r.accepted;
  }

  console.log(`seeded project "${slug}": ${accounts.length} accounts, ${accepted} events, ${metrics.length} metrics, 1 funnel`);
  console.log('');
  console.log('Tokens (save now):');
  console.log(`  ingest:   ${ingest.token}`);
  console.log(`  secret:   ${secret.token}`);
  console.log(`  personal: ${personal.token}`);
} finally {
  await pool.end();
}
