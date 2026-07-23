import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('immutable runtime operations CLI contract', () => {
  it('runs migration and migration-023 preflight from compiled production entrypoints', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.migrate).toBe('node dist/cli/migrate.js');
    expect(packageJson.scripts['prepare:hosted']).toBe(
      'node dist/cli/prepareHosted.js',
    );
    expect(packageJson.scripts['preflight:migration-023']).toBe(
      'node dist/cli/preflightMigration023.js',
    );
    expect(packageJson.scripts.migrate).not.toContain('tsx');
    expect(packageJson.scripts['prepare:hosted']).not.toContain('tsx');
    expect(packageJson.scripts['preflight:migration-023']).not.toContain('tsx');
  });

  it('copies compiled CLIs and migrations into the pruned runtime image', async () => {
    const dockerfile = await readFile('Dockerfile', 'utf8');

    expect(dockerfile).toContain('COPY --from=build /app/dist ./dist');
    expect(dockerfile).toContain('COPY --from=build /app/migrations ./migrations');
    expect(dockerfile).toContain('RUN pnpm prune --prod');
  });

  it('keeps self-host startup non-blocking while hosted startup stays read-only', async () => {
    const serve = await readFile('src/cli/serve.ts', 'utf8');

    expect(serve).toContain('} else {\n  await migrate(pool);\n}');
    expect(serve).toContain('manageEventPartitions: !hostedPolicyRequired');
    expect(serve).toContain('hostedPolicyRequired\n      ? {');
    expect(serve).toContain(': await ensureRetentionIndexes(maintenancePool)');
    expect(serve).not.toContain('await ensureRollingEventPartitions(pool');
    expect(serve.indexOf('await app.listen')).toBeLessThan(
      serve.indexOf(': await ensureRetentionIndexes(maintenancePool)'),
    );
  });
});
