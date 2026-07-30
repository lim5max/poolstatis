/**
 * One-shot setup: create an organization, a project, and the three key kinds.
 * Tokens are printed once and never recoverable — only hashes are stored.
 *
 * Usage: pnpm bootstrap "My Org" my-project "My Project"
 */
import { createPool, migrate } from '../db.js';
import { loadConfig } from '../config.js';
import { createApiKey, createOrganization, createProject } from '../services/projects.js';

const [orgName = 'Default Org', slug = 'default', projectName = slug] = process.argv.slice(2);

const pool = createPool(loadConfig().databaseUrl);
try {
  await migrate(pool);
  const org = await createOrganization(pool, orgName);
  const project = await createProject(pool, org.id, slug, projectName);
  const ingestProd = await createApiKey(pool, {
    orgId: org.id, projectId: project.id, kind: 'ingest', env: 'prod', label: 'bootstrap prod',
  });
  const ingestDev = await createApiKey(pool, {
    orgId: org.id, projectId: project.id, kind: 'ingest', env: 'dev', label: 'bootstrap dev',
  });
  const secret = await createApiKey(pool, {
    orgId: org.id, projectId: project.id, kind: 'secret', label: 'bootstrap',
  });
  const personal = await createApiKey(pool, {
    orgId: org.id, projectId: null, kind: 'personal', label: 'bootstrap', legacySelfHost: true,
  });

  console.log(`org:        ${orgName} (${org.id})`);
  console.log(`project:    ${slug} (${project.id})`);
  console.log('');
  console.log('Save these tokens now — they are not stored anywhere:');
  console.log(`  ingest prod:    ${ingestProd.token}`);
  console.log(`  ingest dev:     ${ingestDev.token}`);
  console.log(`  secret:         ${secret.token}`);
  console.log(`  personal (MCP): ${personal.token}`);
} finally {
  await pool.end();
}
