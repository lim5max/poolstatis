import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type { RegisterReleaseInput, TransitionReleaseInput } from '../schemas.js';
import {
  getContract, toContractSnapshot, validateDeclaration,
  type MeasurementContract,
} from './contracts.js';

type Queryable = pg.Pool | pg.PoolClient;

export interface Release {
  id: string;
  contract_id: string;
  contract_key: string;
  contract_revision: number;
  contract_snapshot: ReturnType<typeof toContractSnapshot>;
  env: string;
  repository: string;
  branch: string | null;
  commit_sha: string;
  pr_url: string | null;
  deployed_at: string | null;
  flag_key: string | null;
  experiment_key: string | null;
  variant: string | null;
  originating_decision_id: string | null;
  status: 'planned' | 'deployed' | 'observing' | 'decided' | 'cancelled';
  idempotency_key: string;
  evaluation_attempts: number;
  next_evaluation_at: string | null;
  retry_state: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ReleaseRevision {
  id: string;
  action: 'registered' | 'transitioned';
  from_status: Release['status'] | null;
  to_status: Release['status'];
  snapshot: Release;
  actor: string;
  created_at: string;
}

const RELEASE_COLS = `id, contract_id, contract_key, contract_revision, contract_snapshot, env, repository, branch,
  commit_sha, pr_url, deployed_at, flag_key, experiment_key, variant,
  originating_decision_id, status,
  idempotency_key, evaluation_attempts, next_evaluation_at, retry_state,
  created_by, created_at, updated_at`;

export async function registerRelease(
  pool: pg.Pool,
  projectId: string,
  input: RegisterReleaseInput,
  actor: string,
  now: Date = new Date(),
): Promise<Release & { idempotent: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `release:${projectId}:${input.env}:${input.idempotency_key}`,
    ]);
    const existing = await client.query<Record<string, any>>(
      `SELECT ${RELEASE_COLS} FROM releases
       WHERE project_id = $1 AND env = $2 AND idempotency_key = $3`,
      [projectId, input.env, input.idempotency_key],
    );
    if (existing.rows[0]) {
      const release = rowToRelease(existing.rows[0]);
      const registered = await client.query<{ snapshot: Release }>(
        `SELECT snapshot FROM release_revisions
         WHERE project_id = $1 AND release_id = $2 AND action = 'registered'
         ORDER BY created_at, id LIMIT 1`,
        [projectId, release.id],
      );
      if (!sameRegistration(input, registered.rows[0]?.snapshot ?? release)) {
        throw new ApiError(
          409,
          'release_idempotency_conflict',
          'this project/environment idempotency key was already used with different release provenance',
          'retry the exact payload, or use a new idempotency_key for a redeploy/rollback fact',
        );
      }
      await client.query('COMMIT');
      return { ...release, idempotent: true };
    }

    const contract = (await getContract(client, projectId, input.contract_key)).contract;
    if (input.originating_decision_id) {
      const origin = await client.query(
        'SELECT 1 FROM decisions WHERE project_id = $1 AND id = $2',
        [projectId, input.originating_decision_id],
      );
      if (!origin.rows[0]) throw notFound('originating_decision');
    }
    const deployedAt = input.status === 'deployed'
      ? input.deployed_at ?? now.toISOString()
      : null;
    const inserted = await client.query<Record<string, any>>(
      `INSERT INTO releases (
         project_id, contract_id, contract_key, contract_revision, contract_snapshot,
         env, repository, branch,
         commit_sha, pr_url, deployed_at, flag_key, experiment_key, variant,
         originating_decision_id,
         status, idempotency_key, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING ${RELEASE_COLS}`,
      [
        projectId, contract.id, contract.key, contract.revision,
        JSON.stringify(toContractSnapshot(contract)), input.env, input.repository,
        input.branch ?? null, input.commit_sha.toLowerCase(), input.pr_url ?? null,
        deployedAt, input.flag_key ?? contract.flag_key ?? null,
        input.experiment_key ?? contract.experiment_key ?? null,
        input.variant ?? null, input.originating_decision_id ?? null,
        input.status, input.idempotency_key, actor,
      ],
    );
    const release = rowToRelease(inserted.rows[0]!);
    await appendRevision(client, projectId, release, 'registered', null, actor);
    await client.query('COMMIT');
    return { ...release, idempotent: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listReleases(
  pool: Queryable,
  projectId: string,
  filter: { env?: string; status?: string; contractKey?: string; experimentKey?: string; originatingDecisionId?: string } = {},
): Promise<Release[]> {
  const params: unknown[] = [projectId];
  let sql = `SELECT ${RELEASE_COLS} FROM releases WHERE project_id = $1`;
  if (filter.env) {
    params.push(filter.env);
    sql += ` AND env = $${params.length}`;
  }
  if (filter.status) {
    params.push(filter.status);
    sql += ` AND status = $${params.length}`;
  }
  if (filter.contractKey) { params.push(filter.contractKey); sql += ` AND contract_key = $${params.length}`; }
  if (filter.experimentKey) { params.push(filter.experimentKey); sql += ` AND experiment_key = $${params.length}`; }
  if (filter.originatingDecisionId) { params.push(filter.originatingDecisionId); sql += ` AND originating_decision_id = $${params.length}`; }
  const { rows } = await pool.query<Record<string, any>>(`${sql} ORDER BY created_at DESC, id`, params);
  return rows.map(rowToRelease);
}

export async function getRelease(
  pool: Queryable,
  projectId: string,
  id: string,
): Promise<{ release: Release; revisions: ReleaseRevision[] }> {
  const { rows } = await pool.query<Record<string, any>>(
    `SELECT ${RELEASE_COLS} FROM releases WHERE project_id = $1 AND id = $2`,
    [projectId, id],
  );
  if (!rows[0]) throw notFound('release');
  const release = rowToRelease(rows[0]);
  const revisions = await pool.query<ReleaseRevision>(
    `SELECT id, action, from_status, to_status, snapshot, actor, created_at
     FROM release_revisions
     WHERE project_id = $1 AND release_id = $2
     ORDER BY created_at, id`,
    [projectId, id],
  );
  return { release, revisions: revisions.rows };
}

export async function transitionRelease(
  pool: pg.Pool,
  projectId: string,
  id: string,
  input: TransitionReleaseInput,
  actor: string,
  now: Date = new Date(),
): Promise<Release> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<Record<string, any>>(
      `SELECT ${RELEASE_COLS} FROM releases
       WHERE project_id = $1 AND id = $2 FOR UPDATE`,
      [projectId, id],
    );
    if (!selected.rows[0]) throw notFound('release');
    const release = rowToRelease(selected.rows[0]);
    if (!allowedTransition(release.status, input.status)) {
      throw new ApiError(
        409,
        'invalid_release_transition',
        `release cannot move from ${release.status} to ${input.status}`,
        'use planned -> deployed -> observing -> decided, or cancel a non-final release',
      );
    }
    if (input.status === 'observing') {
      await assertContractValid(client, projectId, release.contract_snapshot);
    }
    const deployedAt = input.status === 'deployed'
      ? input.deployed_at ?? now.toISOString()
      : release.deployed_at;
    const updated = await client.query<Record<string, any>>(
      `UPDATE releases SET status = $3, deployed_at = $4, updated_at = now()
       WHERE project_id = $1 AND id = $2
       RETURNING ${RELEASE_COLS}`,
      [projectId, id, input.status, deployedAt],
    );
    const next = rowToRelease(updated.rows[0]!);
    await appendRevision(client, projectId, next, 'transitioned', release.status, actor);
    await client.query('COMMIT');
    return next;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function assertContractValid(
  client: pg.PoolClient,
  projectId: string,
  contractSnapshot: ReturnType<typeof toContractSnapshot>,
): Promise<void> {
  if (contractSnapshot.status !== 'active') {
    throw new ApiError(409, 'release_contract_invalid', `contract "${contractSnapshot.key}" has status=${contractSnapshot.status}`, 'activate a valid measurement contract before observing');
  }
  const validation = await validateDeclaration(client, projectId, {
    version: 1,
    contracts: [contractSnapshot],
  });
  if (!validation.valid) {
    throw new ApiError(
      409,
      'release_contract_invalid',
      validation.issues.map((item) => item.message).join('; '),
      'fix the metric/property references, then retry the observing transition',
    );
  }
}

function allowedTransition(from: Release['status'], to: TransitionReleaseInput['status']): boolean {
  if (to === 'cancelled') return from === 'planned' || from === 'deployed' || from === 'observing';
  return (from === 'planned' && to === 'deployed')
    || (from === 'deployed' && to === 'observing')
    || (from === 'observing' && to === 'decided');
}

async function appendRevision(
  client: pg.PoolClient,
  projectId: string,
  release: Release,
  action: ReleaseRevision['action'],
  fromStatus: Release['status'] | null,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO release_revisions (
       release_id, project_id, action, from_status, to_status, snapshot, actor
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [release.id, projectId, action, fromStatus, release.status, JSON.stringify(release), actor],
  );
}

function sameRegistration(input: RegisterReleaseInput, snapshot: Release): boolean {
  return input.contract_key === snapshot.contract_key
    && input.env === snapshot.env
    && input.repository === snapshot.repository
    && (input.branch ?? null) === snapshot.branch
    && input.commit_sha.toLowerCase() === snapshot.commit_sha
    && (input.pr_url ?? null) === snapshot.pr_url
    && (input.flag_key ?? null) === snapshot.flag_key
    && (input.experiment_key ?? null) === snapshot.experiment_key
    && (input.variant ?? null) === snapshot.variant
    && (input.originating_decision_id ?? null) === snapshot.originating_decision_id
    && input.status === snapshot.status
    && (input.deployed_at === undefined || input.deployed_at === snapshot.deployed_at);
}

function rowToRelease(row: Record<string, any>): Release {
  return {
    id: row.id,
    contract_id: row.contract_id,
    contract_key: row.contract_key,
    contract_revision: row.contract_revision,
    contract_snapshot: row.contract_snapshot,
    env: row.env,
    repository: row.repository,
    branch: row.branch,
    commit_sha: row.commit_sha,
    pr_url: row.pr_url,
    deployed_at: row.deployed_at instanceof Date ? row.deployed_at.toISOString() : row.deployed_at,
    flag_key: row.flag_key,
    experiment_key: row.experiment_key,
    variant: row.variant,
    originating_decision_id: row.originating_decision_id,
    status: row.status,
    idempotency_key: row.idempotency_key,
    evaluation_attempts: row.evaluation_attempts,
    next_evaluation_at: row.next_evaluation_at instanceof Date
      ? row.next_evaluation_at.toISOString()
      : row.next_evaluation_at,
    retry_state: row.retry_state,
    created_by: row.created_by,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}
