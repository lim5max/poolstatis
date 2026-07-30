import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { TEST_DB_URL } from './urls.js';

const migrationUrl = new URL('../migrations/017_cloud_identity_profile.sql', import.meta.url);

describe('cloud identity migration compatibility', () => {
  it('upgrades a populated pre-017 schema without losing the user workspace or old conflict target', async () => {
    const pool = createPool(TEST_DB_URL);
    const schema = `cloud_upgrade_${Date.now()}`;
    const migration = await readFile(fileURLToPath(migrationUrl), 'utf8');
    const userId = '11111111-1111-4111-8111-111111111111';
    const orgId = '22222222-2222-4222-8222-222222222222';
    const projectId = '33333333-3333-4333-8333-333333333333';
    try {
      await pool.query('BEGIN');
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`SET LOCAL search_path TO ${schema}`);
      await pool.query(`
        CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL);
        CREATE TABLE projects (
          id uuid PRIMARY KEY,
          org_id uuid NOT NULL REFERENCES organizations(id),
          slug text NOT NULL,
          name text NOT NULL,
          UNIQUE (org_id, slug)
        );
        CREATE TABLE auth_users (
          id uuid PRIMARY KEY,
          subject text NOT NULL UNIQUE,
          email text,
          name text,
          picture_url text
        );
        CREATE TABLE organization_members (
          org_id uuid NOT NULL REFERENCES organizations(id),
          user_id uuid NOT NULL REFERENCES auth_users(id),
          role text NOT NULL,
          PRIMARY KEY (org_id, user_id)
        );
      `);
      await pool.query(
        'INSERT INTO organizations (id, name) VALUES ($1, $2)',
        [orgId, 'Pre-017 workspace'],
      );
      await pool.query(
        'INSERT INTO projects (id, org_id, slug, name) VALUES ($1, $2, $3, $4)',
        [projectId, orgId, 'pre-017-project', 'Pre-017 project'],
      );
      await pool.query(
        'INSERT INTO auth_users (id, subject, email, name) VALUES ($1, $2, $3, $4)',
        [userId, 'auth0|pre-017-user', 'before@example.com', 'Before Migration'],
      );
      await pool.query(
        'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
        [orgId, userId, 'owner'],
      );

      await pool.query(migration);

      const upgraded = await pool.query(
        `SELECT au.id, au.identity_issuer, au.display_name, om.org_id, p.id AS project_id
         FROM auth_users au
         JOIN organization_members om ON om.user_id = au.id
         JOIN projects p ON p.org_id = om.org_id
         WHERE au.subject = $1`,
        ['auth0|pre-017-user'],
      );
      expect(upgraded.rows).toEqual([{
        id: userId,
        identity_issuer: null,
        display_name: 'Before Migration',
        org_id: orgId,
        project_id: projectId,
      }]);

      const oldBinary = await pool.query(
        `INSERT INTO auth_users (id, subject, email, name)
         VALUES ('44444444-4444-4444-8444-444444444444', $1, $2, $3)
         ON CONFLICT (subject) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, email`,
        ['auth0|pre-017-user', 'after@example.com', 'Ignored by old binary'],
      );
      expect(oldBinary.rows).toEqual([{ id: userId, email: 'after@example.com' }]);
    } finally {
      await pool.query('ROLLBACK');
      await pool.end();
    }
  });
});
