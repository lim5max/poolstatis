import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverMigrationFiles } from '../src/db.js';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) =>
      rm(fixture, { recursive: true, force: true }),
    ),
  );
});

async function fixtureDirectory(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), 'poolstatis-migrations-'));
  fixtures.push(fixture);
  return fixture;
}

describe('migration discovery', () => {
  it('ignores binary AppleDouble metadata and returns only canonical basenames', async () => {
    const fixture = await fixtureDirectory();
    await Promise.all([
      writeFile(join(fixture, '001_init.sql'), 'SELECT 1;\n'),
      writeFile(join(fixture, '002_add_events.sql'), 'SELECT 2;\n'),
      writeFile(
        join(fixture, '._001_init.sql'),
        Uint8Array.from([
          0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00,
          0x4d, 0x61, 0x63, 0x20, 0x4f, 0x53, 0x20, 0x58,
        ]),
      ),
      writeFile(join(fixture, '.DS_Store'), 'metadata'),
    ]);

    await expect(discoverMigrationFiles(fixture)).resolves.toEqual([
      '001_init.sql',
      '002_add_events.sql',
    ]);
  });

  it('fails closed on non-canonical SQL names and non-files', async () => {
    const invalidName = await fixtureDirectory();
    await writeFile(join(invalidName, 'migration.sql'), 'SELECT 1;\n');
    await expect(discoverMigrationFiles(invalidName)).rejects.toThrow(
      'non-canonical SQL entry',
    );

    const invalidType = await fixtureDirectory();
    await mkdir(join(invalidType, '001_init.sql'));
    await expect(discoverMigrationFiles(invalidType)).rejects.toThrow(
      'non-canonical SQL entry',
    );
  });

  it('accepts every migration currently shipped by Core', async () => {
    const files = await discoverMigrationFiles(
      new URL('../migrations', import.meta.url).pathname,
    );
    expect(files).toHaveLength(42);
    expect(files.at(0)).toBe('001_init.sql');
    expect(files.at(-1)).toBe('040_funnel_investigations.sql');
  });

  it('keeps AppleDouble files out of the Docker build context', async () => {
    const dockerignore = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('../.dockerignore', import.meta.url), 'utf8'),
    );
    expect(dockerignore).toMatch(/^\.?_\*\s*$/m);
    expect(dockerignore).toContain('**/._*');
  });
});
