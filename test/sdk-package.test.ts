import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

interface PackResult {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  files: Array<{ path: string; mode: number }>;
}

let consumerDir: string;
let generatedPackDir: string | undefined;
let tarball: string;

function parsePackResult(output: string): PackResult {
  const jsonStart = output.lastIndexOf('\n[\n  {');
  const json = jsonStart === -1 ? output : output.slice(jsonStart + 1);
  const [pack] = JSON.parse(json) as PackResult[];
  if (!pack) throw new Error('npm pack returned no artifact');
  return pack;
}

beforeAll(async () => {
  consumerDir = await mkdtemp(join(tmpdir(), 'poolstatis-sdk-consumer-'));
  const suppliedTarball = process.env.POOLSTATIS_SDK_TARBALL;
  const suppliedPackOutput = process.env.POOLSTATIS_SDK_PACK_OUTPUT;
  let output: string;

  if (suppliedTarball || suppliedPackOutput) {
    if (!suppliedTarball || !suppliedPackOutput) {
      throw new Error('POOLSTATIS_SDK_TARBALL and POOLSTATIS_SDK_PACK_OUTPUT must be set together');
    }
    tarball = resolve(suppliedTarball);
    output = await readFile(resolve(suppliedPackOutput), 'utf8');
  } else {
    generatedPackDir = await mkdtemp(join(tmpdir(), 'poolstatis-sdk-pack-'));
    const packed = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', generatedPackDir, './sdk'],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    output = packed.stdout;
  }

  const pack = parsePackResult(output);
  if (!tarball) {
    if (!generatedPackDir) throw new Error('generated pack directory is unavailable');
    tarball = join(generatedPackDir, pack.filename);
  }

  expect(`${pack.name}@${pack.version}`).toBe('@poolstatis/sdk@0.1.0');
  expect(pack.files.map((file) => file.path).sort()).toEqual([
    'LICENSE',
    'README.md',
    'dist/attribution.d.ts',
    'dist/attribution.js',
    'dist/browser.d.ts',
    'dist/browser.js',
    'dist/experience.d.ts',
    'dist/experience.js',
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]);
  expect(pack.size).toBeLessThan(100_000);
  expect(pack.unpackedSize).toBeLessThan(400_000);

  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'poolstatis-sdk-clean-consumer',
    version: '1.0.0',
    private: true,
    type: 'module',
  }));
  await execFileAsync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: consumerDir, maxBuffer: 1024 * 1024 },
  );
}, 120_000);

afterAll(async () => {
  if (consumerDir) await rm(consumerDir, { recursive: true, force: true });
  if (generatedPackDir) await rm(generatedPackDir, { recursive: true, force: true });
});

describe('@poolstatis/sdk release artifact', () => {
  it('ships release-grade metadata, exact exports, and the source-available license', async () => {
    const packageRoot = join(consumerDir, 'node_modules', '@poolstatis', 'sdk');
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      version: string;
      license: string;
      repository: { type: string; url: string; directory: string };
      publishConfig: { access: string; registry: string };
      exports: Record<string, { types: string; import: string }>;
      files: string[];
    };
    expect(packageJson).toMatchObject({
      version: '0.1.0',
      license: 'PolyForm-Shield-1.0.0',
      repository: {
        type: 'git',
        url: 'git+https://github.com/lim5max/poolstatis.git',
        directory: 'sdk',
      },
      publishConfig: {
        access: 'public',
        registry: 'https://registry.npmjs.org/',
      },
      files: ['dist', 'README.md', 'LICENSE'],
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './experience': { types: './dist/experience.d.ts', import: './dist/experience.js' },
        './attribution': { types: './dist/attribution.d.ts', import: './dist/attribution.js' },
        './browser': { types: './dist/browser.d.ts', import: './dist/browser.js' },
      },
    });
    expect(await readFile(join(packageRoot, 'LICENSE'), 'utf8')).toContain(
      'PolyForm Shield License 1.0.0',
    );
    expect((await stat(tarball)).size).toBeGreaterThan(0);
  });

  it('imports the base and browser entrypoints in SSR without resolving browser globals', async () => {
    await expect(execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "const sdk = await import('@poolstatis/sdk');",
          "const browser = await import('@poolstatis/sdk/browser');",
          "if (typeof sdk.createClient !== 'function') throw new Error('missing createClient');",
          "if (typeof browser.createBrowserAnalytics !== 'function') throw new Error('missing createBrowserAnalytics');",
        ].join(''),
      ],
      { cwd: consumerDir, maxBuffer: 1024 * 1024 },
    )).resolves.toMatchObject({ stderr: '' });
  });

  it('typechecks a clean browser consumer against the packed public subpath', async () => {
    await writeFile(join(consumerDir, 'browser-consumer.ts'), [
      "import { createClient } from '@poolstatis/sdk';",
      "import { createBrowserAnalytics } from '@poolstatis/sdk/browser';",
      "const client = createClient({ url: 'https://analytics.example', ingestKey: 'pk_example' });",
      "createBrowserAnalytics({ client, consentPolicy: 'opt-out' });",
    ].join('\n'));

    await expect(execFileAsync(
      process.execPath,
      [
        join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--noEmit',
        '--strict',
        '--target', 'ES2022',
        '--module', 'ESNext',
        '--moduleResolution', 'Bundler',
        '--lib', 'ES2022,DOM',
        join(consumerDir, 'browser-consumer.ts'),
      ],
      { cwd: consumerDir, maxBuffer: 1024 * 1024 },
    )).resolves.toMatchObject({ stderr: '' });
  });
});
