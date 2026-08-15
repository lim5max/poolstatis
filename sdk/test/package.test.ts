import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const sdkRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(sdkRoot, '..');

interface PackResult {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  files: Array<{ path: string; mode: number }>;
}

const prior030Exports = {
  '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  './experience': { types: './dist/experience.d.ts', import: './dist/experience.js' },
  './attribution': { types: './dist/attribution.d.ts', import: './dist/attribution.js' },
  './browser': { types: './dist/browser.d.ts', import: './dist/browser.js' },
} as const;

let consumerDir: string;
let generatedPackDir: string | undefined;
let tarball: string;

beforeAll(async () => {
  consumerDir = await mkdtemp(join(tmpdir(), 'poolstatis-sdk-consumer-'));
  let packOutput: string;
  const suppliedTarball = process.env.POOLSTATIS_SDK_TARBALL;
  const suppliedPackOutput = process.env.POOLSTATIS_SDK_PACK_OUTPUT;
  if (suppliedTarball || suppliedPackOutput) {
    if (!suppliedTarball || !suppliedPackOutput) {
      throw new Error('POOLSTATIS_SDK_TARBALL and POOLSTATIS_SDK_PACK_OUTPUT must be set together');
    }
    tarball = resolve(suppliedTarball);
    packOutput = await readFile(resolve(suppliedPackOutput), 'utf8');
  } else {
    generatedPackDir = await mkdtemp(join(tmpdir(), 'poolstatis-sdk-pack-'));
    const packed = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', generatedPackDir, '.'],
      { cwd: sdkRoot, maxBuffer: 1024 * 1024 },
    );
    packOutput = packed.stdout;
  }

  const jsonStart = packOutput.lastIndexOf('\n[\n  {');
  const json = jsonStart === -1 ? packOutput : packOutput.slice(jsonStart + 1);
  const [pack] = JSON.parse(json) as PackResult[];
  expect(`${pack.name}@${pack.version}`).toBe('@poolstatis/sdk@0.4.0');
  if (!tarball) {
    if (!generatedPackDir) throw new Error('generated SDK pack directory is unavailable');
    tarball = join(generatedPackDir, pack.filename);
  }

  const expectedFiles = [
    'LICENSE',
    'MIGRATION.md',
    'README.md',
    'dist/attribution.d.ts',
    'dist/attribution.js',
    'dist/browser.d.ts',
    'dist/browser.js',
    'dist/experience.d.ts',
    'dist/experience.js',
    'dist/index.d.ts',
    'dist/index.js',
    'dist/replay.d.ts',
    'dist/replay.js',
    'dist/replayPrivacy.d.ts',
    'dist/replayPrivacy.js',
    'package.json',
  ];
  expect(pack.files.map((file) => file.path).sort()).toEqual(expectedFiles.sort());
  expect(pack.size).toBeLessThan(42_000);
  expect(pack.unpackedSize).toBeLessThan(145_000);

  const extractedDir = await mkdtemp(join(tmpdir(), 'poolstatis-sdk-scan-'));
  try {
    const listed = await execFileAsync('tar', ['-tzf', tarball], { maxBuffer: 1024 * 1024 });
    const archiveEntries = listed.stdout.split('\n').filter(Boolean);
    const expectedArchiveEntries = expectedFiles.map((path) => `package/${path}`);
    expect(new Set(archiveEntries).size).toBe(archiveEntries.length);
    expect(archiveEntries.every((entry) => (
      entry.startsWith('package/')
      && !entry.includes('\\')
      && !entry.split('/').includes('..')
    ))).toBe(true);
    expect(archiveEntries.sort()).toEqual(expectedArchiveEntries.sort());
    await execFileAsync('tar', ['-xzf', tarball, '-C', extractedDir]);
    for (const path of expectedFiles) {
      const info = await lstat(join(extractedDir, 'package', path));
      expect(info.isFile()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
    }
    const packedText = (await Promise.all(expectedFiles.map((path) => (
      readFile(join(extractedDir, 'package', path), 'utf8')
    )))).join('\n');
    expect(packedText).not.toMatch(/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/);
    expect(packedText).not.toMatch(/\b(?:pt|sk|pk)_[a-f0-9]{24,}\b/i);
    expect(packedText).not.toMatch(/\bnpm_[a-z0-9]{36,}\b/i);
  } finally {
    await rm(extractedDir, { recursive: true, force: true });
  }

  await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
    name: 'poolstatis-sdk-clean-consumer',
    version: '1.0.0',
    private: true,
    type: 'module',
  }));
  await execFileAsync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', tarball],
    { cwd: consumerDir, maxBuffer: 1024 * 1024 },
  );
}, 120_000);

afterAll(async () => {
  if (consumerDir) await rm(consumerDir, { recursive: true, force: true });
  if (generatedPackDir) await rm(generatedPackDir, { recursive: true, force: true });
});

describe('@poolstatis/sdk 0.4.0 release artifact', () => {
  it('publishes only an explicitly reviewed main SHA through Trusted Publishing', async () => {
    const workflow = await readFile(
      join(repositoryRoot, '.github', 'workflows', 'publish-sdk.yml'),
      'utf8',
    );
    expect(workflow).toContain('expected_sha:');
    expect(workflow).toContain('test "$ACTUAL_SHA" = "$EXPECTED_SHA"');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('npm publish "$SDK_TARBALL" --access public --provenance');
    expect(workflow).toContain('@cyclonedx/cyclonedx-npm@6.0.1');
    expect(workflow).toContain('tar -xzf "$SDK_TARBALL" -C "$SDK_SBOM_ROOT" --strip-components=1');
    expect(workflow).toContain('path: release');
    expect(workflow).not.toContain('.release/');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });

  it('preserves every published 0.3 export and adds only the opt-in replay entrypoint', async () => {
    const installedRoot = join(consumerDir, 'node_modules', '@poolstatis', 'sdk');
    const packageJson = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')) as {
      version: string;
      license: string;
      engines: { node: string };
      publishConfig: { access: string };
      exports: Record<string, { types: string; import: string }>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional: boolean }>;
    };
    expect(packageJson.version).toBe('0.4.0');
    expect(packageJson.license).toBe('SEE LICENSE IN LICENSE');
    expect(packageJson.engines).toEqual({ node: '>=18' });
    expect(packageJson.publishConfig).toEqual({ access: 'public' });
    for (const [subpath, contract] of Object.entries(prior030Exports)) {
      expect(packageJson.exports[subpath]).toEqual(contract);
    }
    expect(packageJson.exports['./replay']).toEqual({
      types: './dist/replay.d.ts',
      import: './dist/replay.js',
    });
    expect(Object.keys(packageJson.exports)).toHaveLength(5);
    expect(packageJson.peerDependencies['@rrweb/record']).toBe('2.1.1');
    expect(packageJson.peerDependenciesMeta['@rrweb/record']).toEqual({ optional: true });

    const load = (file: string) => import(pathToFileURL(join(installedRoot, 'dist', file)).href);
    expect((await load('index.js')).createClient).toBeTypeOf('function');
    expect((await load('experience.js')).BrowserExperience).toBeTypeOf('function');
    expect((await load('attribution.js')).createAttributionClient).toBeTypeOf('function');
    expect((await load('browser.js')).createBrowserAnalytics).toBeTypeOf('function');
    expect((await load('replay.js')).ReplayRecorder).toBeTypeOf('function');
    expect(await stat(join(installedRoot, 'dist', 'replay.d.ts'))).toBeTruthy();
    expect(await readFile(join(installedRoot, 'LICENSE'), 'utf8')).toContain('PolyForm Shield License 1.0.0');
  });

  it('has no production dependency vulnerabilities in a clean installed consumer', async () => {
    const audited = await execFileAsync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: consumerDir,
      maxBuffer: 1024 * 1024,
    });
    const report = JSON.parse(audited.stdout) as { metadata: { vulnerabilities: { total: number } } };
    expect(report.metadata.vulnerabilities.total).toBe(0);
  });
});
