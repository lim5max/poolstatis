import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';
import { MonitorWorker } from '../src/services/monitorWorker.js';
import { InsightFeedWorker } from '../src/services/insightFeedWorker.js';
import { NotificationWorker } from '../src/services/notificationWorker.js';

describe('control tower automation workers', () => {
  let env: TestEnv;
  let privateKey: CryptoKey | Uint8Array;
  let ownerToken: string;
  let memberToken: string;
  let ownerUserId: string;
  const issuer = 'https://automation-review.poolstatis.test/';
  const audience = 'https://automation-review-api.poolstatis.test/';

  async function jwt(subject: string): Promise<string> {
    return new SignJWT({ email: `${subject}@example.test`, email_verified: true, name: subject })
      .setProtectedHeader({ alg: 'RS256', kid: 'automation-review-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
  }

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    const jwks: { keys: JWK[] } = { keys: [{ ...publicJwk, kid: 'automation-review-key', alg: 'RS256', use: 'sig' }] };
    env = await createTestEnv({ auth: { issuer, audience, jwks: async () => jwks } });
    const project = await env.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [env.projectId]);
    for (const role of ['owner', 'member'] as const) {
      const subject = `automation-${role}-${Date.now()}`;
      const user = await env.pool.query<{ id: string }>(
        `INSERT INTO auth_users (identity_issuer, subject, email, email_verified, display_name, name)
         VALUES ($1, $2, $3, true, $4, $4) RETURNING id`,
        [issuer, subject, `${subject}@example.test`, role],
      );
      await env.pool.query(
        'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
        [project.rows[0]!.org_id, user.rows[0]!.id, role],
      );
      const token = await jwt(subject);
      if (role === 'owner') {
        ownerToken = token;
        ownerUserId = user.rows[0]!.id;
      } else memberToken = token;
    }
    await activeMetric(env, {
      key: 'activation_completed',
      source: { event: 'activation.completed', filters: [] },
      purpose: 'Measures whether a product actor reaches the activation outcome.',
    });
  });
  afterAll(async () => env.close());

  test('leases once, freezes a pause proposal and never changes traffic before review', async () => {
    const destination = await api(env, env.secretToken, 'POST', path('/automation/destinations'), {
      key: 'operator_inbox', name: 'Operator inbox', kind: 'in_product',
    });
    await api(env, env.secretToken, 'POST', path('/flags'), {
      key: 'activation_rollout', name: 'Activation rollout',
      purpose: 'Controls the measured activation rollout for a guarded release.', status: 'active', env: 'prod',
      variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }],
    });
    const policy = await api(env, env.secretToken, 'POST', path('/monitors'), {
      policy_key: 'activation_drop_worker', name: 'Activation drop worker', env: 'prod',
      target_kind: 'project', target_id: null, metric_key: 'activation_completed',
      comparison_rule: 'change_down_percent', threshold: 20, minimum_sample: 10,
      window_minutes: 60, cadence_minutes: 60, cooldown_seconds: 3600,
      owner: 'growth-team', destination_ids: [destination.body.id], proposal_kind: 'pause',
      proposal_target: {
        flag_key: 'activation_rollout',
        variants: [{ key: 'control', rollout_percentage: 100 }, { key: 'test', rollout_percentage: 0 }],
      },
    });
    expect(policy.status).toBe(201);
    await env.pool.query('UPDATE monitor_policies SET next_evaluation_at = $2 WHERE project_id = $1 AND id = $3',
      [env.projectId, new Date('2026-08-11T12:00:00.000Z'), policy.body.id]);
    const evaluate = vi.fn(async () => ({
      current: { value: 40, events: 40 }, previous: { value: 100, events: 100 },
      definitionFingerprint: 'metric-definition-v1',
    }));
    const options = workerOptions();
    const first = new MonitorWorker(env.pool, {} as never, options, evaluate);
    const second = new MonitorWorker(env.pool, {} as never, options, evaluate);
    const now = new Date('2026-08-11T12:00:00.000Z');
    const results = await Promise.all([first.runOnce(now), second.runOnce(now)]);
    expect(results.reduce((sum, result) => sum + result.succeeded, 0)).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(1);

    const { rows } = await env.pool.query<{
      proposal: Record<string, unknown>; undo: Record<string, unknown>; fingerprint: string;
    }>(`SELECT p.payload AS proposal, p.undo, p.confirmation_fingerprint AS fingerprint
        FROM automation_proposals p WHERE p.project_id = $1`, [env.projectId]);
    expect(rows[0]).toMatchObject({
      proposal: { variants: [{ key: 'control', rollout_percentage: 100 }, { key: 'test', rollout_percentage: 0 }] },
      undo: { status: 'active', variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] },
    });
    expect(rows[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await expect(env.pool.query(
      `UPDATE automation_proposals SET payload = '{"variants":[]}'::jsonb WHERE project_id = $1`, [env.projectId],
    )).rejects.toMatchObject({ code: '55000' });
    const proposals = await api(env, env.secretToken, 'GET', path('/automation/proposals'));
    expect(proposals.body.proposals[0]).toMatchObject({ status: 'proposed', confirmation_fingerprint: rows[0]!.fingerprint });
    const reviewBody = {
      confirmation_fingerprint: rows[0]!.fingerprint,
      rationale: 'Operator reviewed the frozen evidence and approves handoff to the existing mutation path.',
    };
    const secretDenied = await api(env, env.secretToken, 'POST',
      path(`/automation/proposals/${proposals.body.proposals[0].id}/approve`), {
        ...reviewBody,
      });
    expect(secretDenied.status).toBe(403);
    expect(secretDenied.body.error.code).toBe('human_user_required');

    const personal = await api(env, ownerToken, 'POST', '/api/v1/me/tokens', { label: 'Automation read-only MCP' });
    expect(personal.status).toBe(201);
    const personalDenied = await api(env, personal.body.token, 'POST',
      path(`/automation/proposals/${proposals.body.proposals[0].id}/reject`), reviewBody);
    expect(personalDenied.status).toBe(403);
    expect(personalDenied.body.error.code).toBe('human_user_required');

    const memberDenied = await api(env, memberToken, 'POST',
      path(`/automation/proposals/${proposals.body.proposals[0].id}/reject`), reviewBody);
    expect(memberDenied.status).toBe(403);
    expect(memberDenied.body.error.code).toBe('insufficient_role');

    const stillProposed = await api(env, env.secretToken, 'GET', path(`/automation/proposals/${proposals.body.proposals[0].id}`));
    expect(stillProposed.body.status).toBe('proposed');

    const approved = await api(env, ownerToken, 'POST',
      path(`/automation/proposals/${proposals.body.proposals[0].id}/approve`), reviewBody);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      proposal: { status: 'approved', reviewed_by: `user:${ownerUserId}` },
      review: { actor: `user:${ownerUserId}`, role: 'owner' },
      execution: { state: 'requires_existing_human_approved_mutation' },
    });
    const audit = await env.pool.query<{ event: string; actor: string; snapshot: Record<string, unknown> }>(
      `SELECT event, actor, snapshot FROM automation_proposal_audit
       WHERE project_id = $1 AND proposal_id = $2 ORDER BY created_at, id`,
      [env.projectId, proposals.body.proposals[0].id],
    );
    expect(audit.rows.map(({ event, actor }) => ({ event, actor }))).toEqual([
      { event: 'proposed', actor: 'worker:test-control-tower' },
      { event: 'approved', actor: `user:${ownerUserId}` },
    ]);
    expect(audit.rows[1]!.snapshot).toMatchObject({
      review: { actor: `user:${ownerUserId}`, role: 'owner', identity: 'authenticated_user' },
      proposal: { status: 'approved' },
    });
    const flag = await api(env, env.secretToken, 'GET', path('/flags'));
    expect(flag.body.flags.find((item: { key: string }) => item.key === 'activation_rollout').variants)
      .toEqual([{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }]);

    const delivery = new NotificationWorker(env.pool, workerOptions());
    const deliveryNow = new Date('2026-08-12T00:00:00.000Z');
    await env.pool.query(
      `UPDATE notification_deliveries SET next_attempt_at = $2
       WHERE project_id = $1 AND status IN ('pending', 'failed')`,
      [env.projectId, deliveryNow],
    );
    await Promise.all([delivery.runOnce(deliveryNow), delivery.runOnce(deliveryNow)]);
    const inbox = await env.pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM notification_inbox WHERE project_id = $1', [env.projectId],
    );
    expect(inbox.rowCount).toBe(1);
    expect(JSON.stringify(inbox.rows[0]!.payload)).not.toMatch(/actor|distinct|properties|credential|token|pk_|sk_|pt_/i);
  });

  test('fails a drifted policy without freezing a cross-environment proposal', async () => {
    await api(env, env.secretToken, 'POST', path('/flags'), {
      key: 'drifted_rollout', name: 'Drifted rollout',
      purpose: 'Proves the worker fails closed after an environment drift.',
      status: 'active', env: 'prod',
      variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }],
    });
    const policy = await api(env, env.secretToken, 'POST', path('/monitors'), {
      policy_key: 'drifted_rollout_policy', name: 'Drifted rollout policy', env: 'prod',
      target_kind: 'project', target_id: null, metric_key: 'activation_completed',
      comparison_rule: 'change_down_percent', threshold: 20, minimum_sample: 10,
      window_minutes: 60, cadence_minutes: 60, cooldown_seconds: 3600,
      owner: 'growth-team', destination_ids: [], proposal_kind: 'rollback',
      proposal_target: {
        flag_key: 'drifted_rollout',
        variants: [{ key: 'control', rollout_percentage: 100 }, { key: 'test', rollout_percentage: 0 }],
      },
    });
    expect(policy.status).toBe(201);
    await env.pool.query(
      "UPDATE feature_flags SET env = 'dev' WHERE project_id = $1 AND key = 'drifted_rollout'",
      [env.projectId],
    );
    const due = new Date('2026-08-11T12:30:00.000Z');
    await env.pool.query(
      'UPDATE monitor_policies SET next_evaluation_at = $3 WHERE project_id = $1 AND id = $2',
      [env.projectId, policy.body.id, due],
    );
    const worker = new MonitorWorker(env.pool, {} as never, workerOptions(), async () => ({
      current: { value: 40, events: 40 }, previous: { value: 100, events: 100 },
      definitionFingerprint: 'metric-definition-drifted',
    }));
    expect(await worker.runOnce(due)).toMatchObject({ claimed: 1, failed: 1, succeeded: 0 });
    const proposalCount = await env.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM automation_proposals WHERE project_id = $1 AND policy_id = $2',
      [env.projectId, policy.body.id],
    );
    expect(proposalCount.rows[0]!.count).toBe(0);
    const run = await env.pool.query<{ status: string; error_code: string }>(
      'SELECT status, error_code FROM monitor_runs WHERE project_id = $1 AND policy_id = $2',
      [env.projectId, policy.body.id],
    );
    expect(run.rows[0]).toMatchObject({ status: 'failed', error_code: 'monitor_environment_mismatch' });
  });

  test('persists retry state and produces one immutable scheduled feed snapshot', async () => {
    const destination = await api(env, env.secretToken, 'POST', path('/automation/destinations'), {
      key: 'feed_outbox', name: 'Feed outbox', kind: 'outbox',
    });
    const schedule = await api(env, env.secretToken, 'POST', path('/insight-feed/schedules'), {
      schedule_key: 'daily_worker_feed', name: 'Daily worker feed', env: 'prod',
      metric_key: 'activation_completed', template_kind: 'metric_trend', window_days: 7,
      timezone: 'America/New_York', frequency: 'daily', local_time: '09:15', weekday: null,
      destination_ids: [destination.body.id], owner: 'growth-team',
    });
    const due = new Date('2026-08-11T13:15:00.000Z');
    await env.pool.query('UPDATE insight_feed_schedules SET next_run_at = $2 WHERE project_id = $1 AND id = $3',
      [env.projectId, due, schedule.body.id]);
    const evaluate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('temporary'), { code: 'temporary_source_failure' }))
      .mockResolvedValue({ value: 77, events: 80, definitionFingerprint: 'metric-definition-v1' });
    const worker = new InsightFeedWorker(env.pool, {} as never, {
      ...workerOptions(), baseRetryMs: 1, maxRetryMs: 1,
    }, evaluate);
    const failed = await worker.runOnce(due);
    expect(failed.failed).toBe(1);
    const retried = await worker.runOnce(new Date(due.getTime() + 2));
    expect(retried.succeeded).toBe(1);
    await worker.runOnce(new Date(due.getTime() + 3));
    const snapshots = await env.pool.query('SELECT * FROM insight_feed_snapshots WHERE project_id = $1', [env.projectId]);
    expect(snapshots.rowCount).toBe(1);
    expect(snapshots.rows[0]).toMatchObject({ definition_fingerprint: 'metric-definition-v1' });
    const attempts = await env.pool.query('SELECT attempt_count, status FROM insight_feed_runs WHERE schedule_id = $1', [schedule.body.id]);
    expect(attempts.rows[0]).toMatchObject({ attempt_count: 2, status: 'succeeded' });

    const adapter = {
      kind: 'outbox' as const,
      deliver: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('extension temporarily unavailable'), { code: 'extension_unavailable' }))
        .mockResolvedValue('ready_for_extension' as const),
    };
    const notificationOptions = { ...workerOptions(), baseRetryMs: 1, maxRetryMs: 1 };
    const notifications = new NotificationWorker(env.pool, notificationOptions, [adapter]);
    const deliveryDue = new Date('2026-08-12T00:00:00.000Z');
    await env.pool.query(
      `UPDATE notification_deliveries SET next_attempt_at = $2
       WHERE project_id = $1 AND status IN ('pending', 'failed')`,
      [env.projectId, deliveryDue],
    );
    const notificationFailed = await notifications.runOnce(deliveryDue);
    expect(notificationFailed.failed).toBe(1);
    const delivered = await notifications.runOnce(new Date(deliveryDue.getTime() + 2));
    expect(delivered.readyForExtension).toBe(1);
    const deliveryAttempts = await env.pool.query(
      `SELECT a.status, a.error_code FROM notification_delivery_attempts a
       JOIN notification_deliveries d ON d.id = a.delivery_id
       JOIN insight_feed_runs f ON f.id = d.feed_run_id
       WHERE a.project_id = $1 AND f.schedule_id = $2 ORDER BY a.attempt`, [env.projectId, schedule.body.id],
    );
    expect(deliveryAttempts.rows).toEqual([
      { status: 'failed', error_code: 'extension_unavailable' },
      { status: 'ready_for_extension', error_code: null },
    ]);
  });

  function path(suffix: string) { return `/api/v1/projects/${env.projectSlug}${suffix}`; }
  function workerOptions() {
    return {
      batchSize: 10, maxAttempts: 3, baseRetryMs: 10, maxRetryMs: 100,
      leaseMs: 10_000, actor: 'worker:test-control-tower', projectId: env.projectId,
    };
  }
});
