import { createHash } from 'node:crypto';
import type pg from 'pg';
import { stringify as stringifyYaml } from 'yaml';
import { ApiError, notFound } from '../errors.js';
import {
  measurementDeclarationSchema,
  type MeasurementContractInput,
  type MeasurementDeclaration,
  type PropertyFilter,
} from '../schemas.js';

type Queryable = pg.Pool | pg.PoolClient;

export interface ContractIssue {
  code: string;
  contract_key: string;
  field: string;
  message: string;
  next_action: string;
}

export interface MeasurementContract extends MeasurementContractInput {
  id: string;
  revision: number;
  declaration_hash: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ContractRevision {
  id: string;
  revision: number;
  action: 'created' | 'updated' | 'archived';
  declaration_hash: string;
  snapshot: MeasurementContractInput;
  actor: string;
  created_at: string;
}

export interface ValidationResult {
  valid: boolean;
  declaration: MeasurementDeclaration;
  issues: ContractIssue[];
}

export interface ContractChange {
  key: string;
  operation: 'create' | 'update' | 'noop';
  before: MeasurementContractInput | null;
  after: MeasurementContractInput;
}

export interface ContractDiff {
  valid: boolean;
  declaration: MeasurementDeclaration;
  issues: ContractIssue[];
  expected_revision: string;
  changes: ContractChange[];
  has_existing_changes: boolean;
}

const CONTRACT_COLS = `id, key, name, business_hypothesis, decision_owner,
  primary_metric_key, guardrail_metric_keys, target_filters,
  baseline_window_days, observation_window_days, minimum_sample_size,
  expected_direction, minimum_meaningful_effect, flag_key, experiment_key,
  external_references, status, revision, declaration_hash,
  created_by, created_at, updated_at`;

export async function validateDeclaration(
  pool: Queryable,
  projectId: string,
  input: MeasurementDeclaration,
): Promise<ValidationResult> {
  const declaration = canonicalDeclaration(measurementDeclarationSchema.parse(input));
  const issues = await semanticIssues(pool, projectId, declaration);
  return { valid: issues.length === 0, declaration, issues };
}

export async function diffDeclaration(
  pool: Queryable,
  projectId: string,
  input: MeasurementDeclaration,
): Promise<ContractDiff> {
  const validation = await validateDeclaration(pool, projectId, input);
  const current = await listContracts(pool, projectId);
  const byKey = new Map(current.map((contract) => [contract.key, contract]));
  const changes = validation.declaration.contracts.map((contract): ContractChange => {
    const before = byKey.get(contract.key);
    if (!before) return { key: contract.key, operation: 'create', before: null, after: contract };
    const previous = toContractSnapshot(before);
    return {
      key: contract.key,
      operation: declarationHash(previous) === declarationHash(contract) ? 'noop' : 'update',
      before: previous,
      after: contract,
    };
  });
  return {
    ...validation,
    expected_revision: currentRevision(current),
    changes,
    has_existing_changes: changes.some((change) => change.operation === 'update'),
  };
}

export async function applyDeclaration(
  pool: pg.Pool,
  projectId: string,
  input: MeasurementDeclaration,
  options: {
    confirmExistingChanges: boolean;
    expectedRevision?: string;
    actor: string;
  },
): Promise<{
  applied: true;
  previous_revision: string;
  revision: string;
  changes: ContractChange[];
  contracts: MeasurementContract[];
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `measurement-contracts:${projectId}`,
    ]);
    const diff = await diffDeclaration(client, projectId, input);
    if (!diff.valid) {
      throw new ApiError(
        400,
        'contract_validation_failed',
        diff.issues.map((issue) => `${issue.contract_key}.${issue.field}: ${issue.message}`).join('; '),
        'fix every validation issue and run contracts/validate again',
      );
    }
    if (options.expectedRevision && options.expectedRevision !== diff.expected_revision) {
      throw new ApiError(
        409,
        'contract_revision_conflict',
        'measurement contracts changed after this diff was produced',
        'run contracts/diff again and apply with its new expected_revision',
      );
    }
    if (diff.has_existing_changes && !options.confirmExistingChanges) {
      throw new ApiError(
        409,
        'contract_confirmation_required',
        'this declaration changes an existing measurement contract',
        'review the diff, then set confirm_existing_changes=true with its expected_revision',
      );
    }

    for (const change of diff.changes) {
      if (change.operation === 'noop') continue;
      if (change.operation === 'create') {
        await insertContract(client, projectId, change.after, options.actor);
      } else {
        await updateContract(client, projectId, change.after, options.actor);
      }
    }
    const contracts = await listContracts(client, projectId);
    const revision = currentRevision(contracts);
    await client.query('COMMIT');
    return {
      applied: true,
      previous_revision: diff.expected_revision,
      revision,
      changes: diff.changes.filter((change) => change.operation !== 'noop'),
      contracts,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listContracts(
  pool: Queryable,
  projectId: string,
): Promise<MeasurementContract[]> {
  const { rows } = await pool.query(
    `SELECT ${CONTRACT_COLS} FROM measurement_contracts
     WHERE project_id = $1 ORDER BY key`,
    [projectId],
  );
  return rows.map(rowToContract);
}

export async function getContract(
  pool: Queryable,
  projectId: string,
  key: string,
): Promise<{ contract: MeasurementContract; revisions: ContractRevision[] }> {
  const { rows } = await pool.query(
    `SELECT ${CONTRACT_COLS} FROM measurement_contracts
     WHERE project_id = $1 AND key = $2`,
    [projectId, key],
  );
  if (!rows[0]) throw notFound('measurement_contract');
  const contract = rowToContract(rows[0]);
  const revisions = await pool.query<ContractRevision>(
    `SELECT id, revision, action, declaration_hash, snapshot, actor, created_at
     FROM measurement_contract_revisions
     WHERE project_id = $1 AND contract_id = $2
     ORDER BY revision`,
    [projectId, contract.id],
  );
  return { contract, revisions: revisions.rows };
}

export async function exportDeclaration(
  pool: Queryable,
  projectId: string,
): Promise<string> {
  const contracts = await listContracts(pool, projectId);
  const declaration = canonicalDeclaration({
    version: 1,
    contracts: contracts.map(toContractSnapshot),
  });
  return stringifyYaml(declaration, { lineWidth: 0 });
}

export function canonicalDeclaration(input: MeasurementDeclaration): MeasurementDeclaration {
  return {
    version: 1,
    contracts: input.contracts
      .map((contract) => canonicalContract(contract))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

async function semanticIssues(
  pool: Queryable,
  projectId: string,
  declaration: MeasurementDeclaration,
): Promise<ContractIssue[]> {
  // Apply runs this through one transaction client; keep queries sequential so
  // pg never receives concurrent commands on the same connection.
  const metricsResult = await pool.query<{
      key: string; type: string; status: string; source: Record<string, unknown>;
    }>('SELECT key, type, status, source FROM metrics WHERE project_id = $1', [projectId]);
  const propertiesResult = await pool.query<{ key: string; status: string }>(
    'SELECT key, status FROM property_definitions WHERE project_id = $1', [projectId],
  );
  const flagsResult = await pool.query<{ key: string }>(
    'SELECT key FROM feature_flags WHERE project_id = $1', [projectId],
  );
  const experimentsResult = await pool.query<{ key: string }>(
    'SELECT key FROM experiments WHERE project_id = $1', [projectId],
  );
  const metrics = new Map(metricsResult.rows.map((metric) => [metric.key, metric]));
  const properties = new Map(propertiesResult.rows.map((property) => [property.key, property]));
  const flags = new Set(flagsResult.rows.map((flag) => flag.key));
  const experiments = new Set(experimentsResult.rows.map((experiment) => experiment.key));
  const issues: ContractIssue[] = [];
  for (const contract of declaration.contracts) {
    checkMetric(contract.primary_metric_key, 'primary_metric_key', true, contract, metrics, issues);
    for (const key of contract.guardrail_metric_keys) {
      checkMetric(key, 'guardrail_metric_keys', false, contract, metrics, issues);
    }
    for (const filter of contract.target_filters) {
      const property = properties.get(filter.property);
      if (!property) {
        issues.push(issue(
          'unknown_target_property', contract.key, 'target_filters',
          `property "${filter.property}" is not registered`,
          'register its scope, type and purpose before applying this contract',
        ));
      } else if (property.status !== 'trusted') {
        issues.push(issue(
          'untrusted_target_property', contract.key, 'target_filters',
          `property "${filter.property}" has status=${property.status}`,
          'review the property meaning and mark it trusted, or remove the segment',
        ));
      }
    }
    if (contract.flag_key && !flags.has(contract.flag_key)) {
      issues.push(issue('unknown_flag', contract.key, 'flag_key', `flag "${contract.flag_key}" does not exist`, 'create the flag or remove the link'));
    }
    if (contract.experiment_key && !experiments.has(contract.experiment_key)) {
      issues.push(issue('unknown_experiment', contract.key, 'experiment_key', `experiment "${contract.experiment_key}" does not exist`, 'create the experiment or remove the link'));
    }
  }
  return issues;
}

function checkMetric(
  key: string,
  field: string,
  primary: boolean,
  contract: MeasurementContractInput,
  metrics: Map<string, { key: string; type: string; status: string; source: Record<string, unknown> }>,
  issues: ContractIssue[],
): void {
  const metric = metrics.get(key);
  const prefix = primary ? 'primary' : 'guardrail';
  if (!metric) {
    issues.push(issue(`unknown_${prefix}_metric`, contract.key, field, `metric "${key}" is not registered`, 'register and activate the metric first'));
    return;
  }
  if (metric.status !== 'active') {
    issues.push(issue(`inactive_${prefix}_metric`, contract.key, field, `metric "${key}" has status=${metric.status}`, 'review and activate the metric first'));
  }
  if (!['count', 'unique_actors', 'value'].includes(metric.type)) {
    issues.push(issue(`incompatible_${prefix}_metric`, contract.key, field, `metric "${key}" has incompatible type=${metric.type}`, 'use an active count, unique_actors or value metric'));
  }
  if (metric.type === 'value' && metric.source.data_source === 'posthog') {
    issues.push(issue(`unsupported_${prefix}_metric_source`, contract.key, field, `PostHog value metric "${key}" is not supported by the bounded adapter`, 'use a supported count/unique metric or native ingest'));
  }
}

async function insertContract(
  client: pg.PoolClient,
  projectId: string,
  contract: MeasurementContractInput,
  actor: string,
): Promise<void> {
  const hash = declarationHash(contract);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO measurement_contracts (
       project_id, key, name, business_hypothesis, decision_owner,
       primary_metric_key, guardrail_metric_keys, target_filters,
       baseline_window_days, observation_window_days, minimum_sample_size,
       expected_direction, minimum_meaningful_effect, flag_key, experiment_key,
       external_references, status, declaration_hash, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
     ) RETURNING id`,
    contractValues(projectId, contract, hash, actor),
  );
  await appendRevision(client, projectId, inserted.rows[0]!.id, 1, 'created', contract, hash, actor);
}

async function updateContract(
  client: pg.PoolClient,
  projectId: string,
  contract: MeasurementContractInput,
  actor: string,
): Promise<void> {
  const existing = await getContract(client, projectId, contract.key);
  const revision = existing.contract.revision + 1;
  const hash = declarationHash(contract);
  const { rowCount } = await client.query(
    `UPDATE measurement_contracts SET
       name = $3, business_hypothesis = $4, decision_owner = $5,
       primary_metric_key = $6, guardrail_metric_keys = $7, target_filters = $8,
       baseline_window_days = $9, observation_window_days = $10,
       minimum_sample_size = $11, expected_direction = $12,
       minimum_meaningful_effect = $13, flag_key = $14, experiment_key = $15,
       external_references = $16, status = $17, declaration_hash = $18,
       revision = $19, updated_at = now()
     WHERE project_id = $1 AND key = $2 AND revision = $20`,
    [...contractValues(projectId, contract, hash, actor).slice(0, -1), revision, existing.contract.revision],
  );
  if (!rowCount) {
    throw new ApiError(409, 'contract_revision_conflict', 'measurement contract changed during apply');
  }
  await appendRevision(
    client, projectId, existing.contract.id, revision,
    contract.status === 'archived' ? 'archived' : 'updated', contract, hash, actor,
  );
}

function contractValues(
  projectId: string,
  contract: MeasurementContractInput,
  hash: string,
  actor: string,
): unknown[] {
  return [
    projectId, contract.key, contract.name, contract.business_hypothesis,
    contract.decision_owner, contract.primary_metric_key,
    JSON.stringify(contract.guardrail_metric_keys), JSON.stringify(contract.target_filters),
    contract.baseline_window_days, contract.observation_window_days,
    contract.minimum_sample_size, contract.expected_direction,
    contract.minimum_meaningful_effect ?? null, contract.flag_key ?? null,
    contract.experiment_key ?? null, JSON.stringify(contract.references),
    contract.status, hash, actor,
  ];
}

async function appendRevision(
  client: pg.PoolClient,
  projectId: string,
  contractId: string,
  revision: number,
  action: ContractRevision['action'],
  snapshot: MeasurementContractInput,
  hash: string,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO measurement_contract_revisions (
       contract_id, project_id, revision, action, declaration_hash, snapshot, actor
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [contractId, projectId, revision, action, hash, JSON.stringify(snapshot), actor],
  );
}

function rowToContract(row: Record<string, any>): MeasurementContract {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    business_hypothesis: row.business_hypothesis,
    decision_owner: row.decision_owner,
    primary_metric_key: row.primary_metric_key,
    guardrail_metric_keys: row.guardrail_metric_keys,
    target_filters: row.target_filters,
    baseline_window_days: row.baseline_window_days,
    observation_window_days: row.observation_window_days,
    minimum_sample_size: row.minimum_sample_size,
    expected_direction: row.expected_direction,
    ...(row.minimum_meaningful_effect === null ? {} : { minimum_meaningful_effect: row.minimum_meaningful_effect }),
    ...(row.flag_key === null ? {} : { flag_key: row.flag_key }),
    ...(row.experiment_key === null ? {} : { experiment_key: row.experiment_key }),
    references: row.external_references,
    status: row.status,
    revision: row.revision,
    declaration_hash: row.declaration_hash,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toContractSnapshot(contract: MeasurementContract): MeasurementContractInput {
  return canonicalContract({
    key: contract.key,
    name: contract.name,
    business_hypothesis: contract.business_hypothesis,
    decision_owner: contract.decision_owner,
    primary_metric_key: contract.primary_metric_key,
    guardrail_metric_keys: contract.guardrail_metric_keys,
    target_filters: contract.target_filters,
    baseline_window_days: contract.baseline_window_days,
    observation_window_days: contract.observation_window_days,
    minimum_sample_size: contract.minimum_sample_size,
    expected_direction: contract.expected_direction,
    ...(contract.minimum_meaningful_effect === undefined ? {} : { minimum_meaningful_effect: contract.minimum_meaningful_effect }),
    ...(contract.flag_key === undefined ? {} : { flag_key: contract.flag_key }),
    ...(contract.experiment_key === undefined ? {} : { experiment_key: contract.experiment_key }),
    references: contract.references,
    status: contract.status,
  });
}

function canonicalContract(contract: MeasurementContractInput): MeasurementContractInput {
  return {
    key: contract.key,
    name: contract.name,
    business_hypothesis: contract.business_hypothesis,
    decision_owner: contract.decision_owner,
    primary_metric_key: contract.primary_metric_key,
    guardrail_metric_keys: [...contract.guardrail_metric_keys].sort(),
    target_filters: [...contract.target_filters]
      .map(canonicalFilter)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    baseline_window_days: contract.baseline_window_days,
    observation_window_days: contract.observation_window_days,
    minimum_sample_size: contract.minimum_sample_size,
    expected_direction: contract.expected_direction,
    ...(contract.minimum_meaningful_effect === undefined ? {} : { minimum_meaningful_effect: contract.minimum_meaningful_effect }),
    ...(contract.flag_key === undefined ? {} : { flag_key: contract.flag_key }),
    ...(contract.experiment_key === undefined ? {} : { experiment_key: contract.experiment_key }),
    references: {
      ...(contract.references.issue_url ? { issue_url: contract.references.issue_url } : {}),
      ...(contract.references.pr_url ? { pr_url: contract.references.pr_url } : {}),
      ...(contract.references.commit_sha ? { commit_sha: contract.references.commit_sha.toLowerCase() } : {}),
      ...(contract.references.deploy_url ? { deploy_url: contract.references.deploy_url } : {}),
    },
    status: contract.status,
  };
}

function canonicalFilter(filter: PropertyFilter): PropertyFilter {
  if (Array.isArray(filter.value)) {
    return { ...filter, value: [...filter.value].sort((a, b) => String(a).localeCompare(String(b))) };
  }
  return { ...filter };
}

function currentRevision(contracts: MeasurementContract[]): string {
  return declarationHash(canonicalDeclaration({ version: 1, contracts: contracts.map(toContractSnapshot) }));
}

function declarationHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function issue(
  code: string,
  contractKey: string,
  field: string,
  message: string,
  nextAction: string,
): ContractIssue {
  return { code, contract_key: contractKey, field, message, next_action: nextAction };
}
