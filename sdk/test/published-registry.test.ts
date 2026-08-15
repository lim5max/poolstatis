import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const verifyPublishedSdk = process.env.POOLSTATIS_VERIFY_PUBLISHED_SDK === 'true';
const suite = verifyPublishedSdk ? describe : describe.skip;

suite('@poolstatis/sdk published registry contract', () => {
  let consumerDir: string;

  beforeAll(async () => {
    consumerDir = await mkdtemp(join(tmpdir(), 'poolstatis-sdk-registry-'));
    await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
      name: 'poolstatis-sdk-registry-consumer',
      version: '1.0.0',
      private: true,
      type: 'module',
    }));
    await execFileAsync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '@poolstatis/sdk@0.4.0'],
      { cwd: consumerDir, maxBuffer: 1024 * 1024 },
    );
  }, 120_000);

  afterAll(async () => {
    if (consumerDir) await rm(consumerDir, { recursive: true, force: true });
  });

  it('reads version, integrity and all five exports from a fresh registry install', async () => {
    const viewed = await execFileAsync(
      'npm',
      ['view', '@poolstatis/sdk@0.4.0', 'version', 'dist.integrity', '--json'],
      { maxBuffer: 1024 * 1024 },
    );
    const metadata = JSON.parse(viewed.stdout) as { version: string; 'dist.integrity': string };
    expect(metadata.version).toBe('0.4.0');
    expect(metadata['dist.integrity']).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);

    const smoke = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', [
        "import { createClient } from '@poolstatis/sdk';",
        "import { BrowserExperience } from '@poolstatis/sdk/experience';",
        "import { createAttributionClient } from '@poolstatis/sdk/attribution';",
        "import { createBrowserAnalytics } from '@poolstatis/sdk/browser';",
        "import { ReplayRecorder } from '@poolstatis/sdk/replay';",
        'if ([createClient, BrowserExperience, createAttributionClient, createBrowserAnalytics, ReplayRecorder].some((value) => typeof value !== "function")) process.exit(1);',
      ].join('\n')],
      { cwd: consumerDir, maxBuffer: 1024 * 1024 },
    );
    expect(smoke.stderr).toBe('');
  });
});
