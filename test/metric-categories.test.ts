import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';

const SYSTEM_KEYS = [
  'acquisition',
  'activation',
  'adoption',
  'engagement',
  'retention',
  'referral',
  'satisfaction',
  'revenue',
  'cost',
  'efficiency',
  'quality',
  'reliability',
  'performance',
  'delivery',
  'security',
  'data_quality',
] as const;

let alpha: TestEnv;
let beta: TestEnv;

beforeAll(async () => {
  alpha = await createTestEnv();
  beta = await createTestEnv();
});

afterAll(async () => {
  await Promise.all([alpha.close(), beta.close()]);
});

const categoriesPath = (env: TestEnv) =>
  `/api/v1/projects/${env.projectSlug}/metric-categories`;

describe('project metric categories', () => {
  it('seeds the exact system library into every new project with definitions', async () => {
    const response = await api(alpha, alpha.secretToken, 'GET', categoriesPath(alpha));

    expect(response.status).toBe(200);
    expect(response.body.categories.map((category: { key: string }) => category.key).sort())
      .toEqual([...SYSTEM_KEYS].sort());
    expect(response.body.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'engagement',
        name: 'Engagement',
        domain: 'product',
        is_system: true,
        metric_count: 0,
      }),
      expect.objectContaining({
        key: 'cost',
        domain: 'business',
        is_system: true,
      }),
      expect.objectContaining({
        key: 'data_quality',
        domain: 'technical',
        is_system: true,
      }),
    ]));
    for (const category of response.body.categories) {
      expect(category.description.length).toBeGreaterThanOrEqual(10);
      expect(category.color).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('creates, updates, lists, and deletes a project-local custom category', async () => {
    const created = await api(alpha, alpha.secretToken, 'POST', categoriesPath(alpha), {
      key: 'governance',
      name: 'Governance',
      description: 'Measures policy outcomes that do not fit the stable system library.',
      domain: 'custom',
      color: '#6D5BD0',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      key: 'governance',
      name: 'Governance',
      domain: 'custom',
      color: '#6D5BD0',
      is_system: false,
      metric_count: 0,
    });

    const updated = await api(alpha, alpha.secretToken, 'PATCH', `${categoriesPath(alpha)}/governance`, {
      name: 'Product governance',
      description: 'Measures explicit policy and governance outcomes outside the system library.',
      color: '#2457C5',
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      key: 'governance',
      name: 'Product governance',
      color: '#2457C5',
    });

    const listed = await api(alpha, alpha.secretToken, 'GET', categoriesPath(alpha));
    expect(listed.body.categories).toContainEqual(expect.objectContaining({
      key: 'governance',
      domain: 'custom',
    }));

    const deleted = await api(alpha, alpha.secretToken, 'DELETE', `${categoriesPath(alpha)}/governance`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, key: 'governance' });
  });

  it('returns stable conflicts for duplicate and system category writes', async () => {
    const duplicate = await api(alpha, alpha.secretToken, 'POST', categoriesPath(alpha), {
      key: 'quality',
      name: 'Different quality',
      description: 'Attempts to replace a built-in semantic definition.',
      domain: 'custom',
      color: '#123456',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('metric_category_taken');

    const update = await api(alpha, alpha.secretToken, 'PATCH', `${categoriesPath(alpha)}/quality`, {
      name: 'Changed quality',
    });
    expect(update.status).toBe(409);
    expect(update.body.error.code).toBe('system_metric_category');

    const remove = await api(alpha, alpha.secretToken, 'DELETE', `${categoriesPath(alpha)}/quality`);
    expect(remove.status).toBe(409);
    expect(remove.body.error.code).toBe('system_metric_category');
  });

  it('keeps custom category objects isolated even when projects reuse the same key', async () => {
    const alphaCreated = await api(alpha, alpha.secretToken, 'POST', categoriesPath(alpha), {
      key: 'governance',
      name: 'Alpha governance',
      description: 'Alpha project governance outcomes and policy decisions.',
      domain: 'custom',
      color: '#112233',
    });
    const betaCreated = await api(beta, beta.secretToken, 'POST', categoriesPath(beta), {
      key: 'governance',
      name: 'Beta governance',
      description: 'Beta project governance outcomes and policy decisions.',
      domain: 'custom',
      color: '#445566',
    });
    expect(alphaCreated.status).toBe(201);
    expect(betaCreated.status).toBe(201);

    const alphaList = await api(alpha, alpha.secretToken, 'GET', categoriesPath(alpha));
    const betaList = await api(beta, beta.secretToken, 'GET', categoriesPath(beta));
    expect(alphaList.body.categories.find((category: { key: string }) => category.key === 'governance'))
      .toMatchObject({ name: 'Alpha governance', color: '#112233' });
    expect(betaList.body.categories.find((category: { key: string }) => category.key === 'governance'))
      .toMatchObject({ name: 'Beta governance', color: '#445566' });

    const crossProject = await api(
      alpha,
      alpha.secretToken,
      'PATCH',
      `/api/v1/projects/${beta.projectSlug}/metric-categories/governance`,
      { name: 'Cross-project write' },
    );
    expect(crossProject.status).toBe(404);
  });

  it('validates metric categories in the same project and preserves uncategorized metrics', async () => {
    const uncategorized = await api(alpha, alpha.secretToken, 'POST', `/api/v1/projects/${alpha.projectSlug}/metrics`, {
      key: 'taxonomy_uncategorized',
      name: 'Uncategorized compatibility',
      purpose: 'Preserves existing metrics that do not yet have a reconciled purpose category.',
      type: 'count',
      source: { event: 'taxonomy.uncategorized' },
    });
    expect(uncategorized.status).toBe(201);
    expect(uncategorized.body.category).toBeNull();

    const custom = await api(alpha, alpha.secretToken, 'POST', `/api/v1/projects/${alpha.projectSlug}/metrics`, {
      key: 'taxonomy_governance',
      name: 'Governance outcome',
      purpose: 'Measures project governance outcomes using the project-local semantic category.',
      category: 'governance',
      tags: ['surface:admin', 'feature:policy'],
      type: 'count',
      source: { event: 'policy.reviewed' },
    });
    expect(custom.status).toBe(201);
    expect(custom.body.category).toBe('governance');
    expect(custom.body.tags).toEqual(['surface:admin', 'feature:policy']);

    const unknown = await api(alpha, alpha.secretToken, 'POST', `/api/v1/projects/${alpha.projectSlug}/metrics`, {
      key: 'taxonomy_unknown',
      name: 'Unknown category',
      purpose: 'Must be rejected because the category does not exist in this project.',
      category: 'another_projects_category',
      type: 'count',
      source: { event: 'taxonomy.unknown' },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('unknown_metric_category');
    expect(unknown.body.error.hint).toContain('list_metric_categories');

    const unknownUpdate = await api(alpha, alpha.secretToken, 'PATCH',
      `/api/v1/projects/${alpha.projectSlug}/metrics/taxonomy_uncategorized`,
      { category: 'another_projects_category' });
    expect(unknownUpdate.status).toBe(400);
    expect(unknownUpdate.body.error.code).toBe('unknown_metric_category');
  });

  it('blocks deletion while referenced and reports the metric count', async () => {
    const remove = await api(alpha, alpha.secretToken, 'DELETE', `${categoriesPath(alpha)}/governance`);
    expect(remove.status).toBe(409);
    expect(remove.body.error.code).toBe('metric_category_in_use');
    expect(remove.body.error.details).toEqual({ metric_count: 1 });

    const list = await api(alpha, alpha.secretToken, 'GET', categoriesPath(alpha));
    expect(list.body.categories.find((category: { key: string }) => category.key === 'governance'))
      .toMatchObject({ metric_count: 1 });
  });
});
