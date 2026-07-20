import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';
import * as schemas from '../src/schemas.js';

describe('decision-loop trust persistence', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(async () => {
    await env.close();
  });

  test('installs the audited identity, property, source and onboarding tables', async () => {
    const expected = [
      'actor_links',
      'actor_link_audit',
      'property_definitions',
      'source_connections',
      'query_runs',
      'onboarding_acknowledgements',
      'agent_observations',
    ];
    const { rows } = await env.pool.query<{ name: string | null }>(
      'SELECT to_regclass(name)::text AS name FROM unnest($1::text[]) AS names(name)',
      [expected],
    );

    expect(rows.map((row) => row.name)).toEqual(expected);
  });

  test('validates semantic property definitions and safe PostHog hosts', () => {
    const propertySchema = (schemas as Record<string, any>).propertyDefinitionSchema;
    const posthogSchema = (schemas as Record<string, any>).posthogConnectionSchema;
    const actorLinkSchema = (schemas as Record<string, any>).actorLinkSchema;

    expect(propertySchema).toBeDefined();
    expect(posthogSchema).toBeDefined();
    expect(actorLinkSchema).toBeDefined();
    expect(propertySchema.safeParse({
      key: 'plan',
      scope: 'event',
      value_type: 'string',
      purpose: 'too short',
    }).success).toBe(false);
    expect(posthogSchema.safeParse({
      name: 'primary',
      host: 'http://posthog.example.com',
      project_id: '42',
      personal_api_key: 'phx_test',
    }).success).toBe(false);
    expect(posthogSchema.safeParse({
      name: 'controlled',
      host: 'http://127.0.0.1:8123',
      project_id: '42',
      personal_api_key: 'phx_test',
    }).success).toBe(true);
    expect(actorLinkSchema.safeParse({
      source_distinct_id: 'same',
      target_distinct_id: 'same',
      env: 'prod',
    }).success).toBe(false);
  });
});
