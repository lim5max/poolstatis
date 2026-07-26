import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_PACKAGE_SPEC as CORE_MCP_PACKAGE_SPEC } from '../src/config.js';
import { MCP_PACKAGE_SPEC as WEB_MCP_PACKAGE_SPEC } from '../web/src/mcpClients.js';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const safeToken = 'sk_0123456789abcdef';

interface PackResult {
  name: string;
  version: string;
  filename: string;
  size: number;
  unpackedSize: number;
  files: Array<{ path: string; mode: number }>;
}

let tempProject: string;
let tarball: string;
let executable: string;
let cliModule: string;
let fixture: Server;
let fixtureUrl: string;
let generatedPackDir: string | undefined;
const requests: Array<{ method: string; url: string; authorization?: string; client?: string }> = [];

async function connect(command: string, args: string[] = []) {
  const stderr: Buffer[] = [];
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: tempProject,
    env: {
      PATH: process.env.PATH ?? '',
      POOLSTATIS_URL: fixtureUrl,
      POOLSTATIS_TOKEN: safeToken,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const client = new Client({ name: 'poolstatis-package-smoke', version: '1.0.0' });
  await client.connect(transport, { timeout: 15_000 });
  return { client, transport, stderr };
}

beforeAll(async () => {
  tempProject = await mkdtemp(join(tmpdir(), 'poolstatis-mcp-consumer-'));
  let stdout: string;
  const suppliedTarball = process.env.POOLSTATIS_MCP_TARBALL;
  const suppliedPackOutput = process.env.POOLSTATIS_MCP_PACK_OUTPUT;
  if (suppliedTarball || suppliedPackOutput) {
    if (!suppliedTarball || !suppliedPackOutput) {
      throw new Error('POOLSTATIS_MCP_TARBALL and POOLSTATIS_MCP_PACK_OUTPUT must be set together');
    }
    tarball = resolve(suppliedTarball);
    stdout = await readFile(resolve(suppliedPackOutput), 'utf8');
  } else {
    generatedPackDir = await mkdtemp(join(tmpdir(), 'poolstatis-mcp-pack-'));
    const packed = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', generatedPackDir, './packages/mcp'],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    stdout = packed.stdout;
  }
  const jsonStart = stdout.lastIndexOf('\n[\n  {');
  if (jsonStart === -1) throw new Error(`npm pack did not return JSON: ${stdout.slice(-200)}`);
  const [pack] = JSON.parse(stdout.slice(jsonStart + 1)) as PackResult[];
  if (!tarball) {
    if (!generatedPackDir) throw new Error('generated pack directory is unavailable');
    tarball = join(generatedPackDir, pack.filename);
  }
  expect(`${pack.name}@${pack.version}`).toBe(CORE_MCP_PACKAGE_SPEC);
  expect(`${pack.name}@${pack.version}`).toBe(WEB_MCP_PACKAGE_SPEC);

  const expectedFiles = [
    'LICENSE',
    'README.md',
    'dist/cli.js',
    'dist/core/mcp/server.d.ts',
    'dist/core/mcp/server.js',
    'dist/core/mcp/standard.js',
    'dist/core/schemas.js',
    'package.json',
  ];
  expect(pack.files.map((file) => file.path).sort()).toEqual(expectedFiles.sort());
  expect(pack.files.find((file) => file.path === 'dist/cli.js')?.mode).toBe(0o755);
  expect(pack.size).toBeLessThan(50_000);
  expect(pack.unpackedSize).toBeLessThan(150_000);

  await writeFile(join(tempProject, 'package.json'), JSON.stringify({
    name: 'poolstatis-mcp-clean-consumer',
    version: '1.0.0',
    private: true,
  }));
  await execFileAsync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: tempProject, maxBuffer: 1024 * 1024 },
  );
  executable = join(tempProject, 'node_modules', '.bin', 'poolstatis-mcp');
  cliModule = join(
    tempProject,
    'node_modules',
    '@poolstatis',
    'mcp',
    'dist',
    'cli.js',
  );
  fixture = createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
      client: typeof req.headers['x-poolstatis-client'] === 'string'
        ? req.headers['x-poolstatis-client']
        : undefined,
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/v1/projects') {
      res.end(JSON.stringify({ projects: [{ slug: 'safe-fixture', name: 'Safe Fixture' }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/projects/safe-fixture/schema?env=prod') {
      res.end(JSON.stringify({
        project: { slug: 'safe-fixture', name: 'Safe Fixture' },
        metrics: [],
        funnels: [],
        entity_types: [],
        observed_events_30d: [],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'fixture route not found' } }));
  });
  await new Promise<void>((resolveListen) => {
    fixture.listen(0, '127.0.0.1', resolveListen);
  });
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  fixtureUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  if (fixture) await new Promise<void>((resolveClose) => fixture.close(() => resolveClose()));
  if (tempProject) await rm(tempProject, { recursive: true, force: true });
  if (generatedPackDir) await rm(generatedPackDir, { recursive: true, force: true });
});

describe('@poolstatis/mcp release artifact', () => {
  it('installs into an empty project as an executable ESM bin with the expected license', async () => {
    const packageJson = JSON.parse(await readFile(
      join(tempProject, 'node_modules', '@poolstatis', 'mcp', 'package.json'),
      'utf8',
    )) as {
      type: string;
      engines: { node: string };
      bin: Record<string, string>;
      license: string;
      publishConfig: { access: string; registry: string };
    };
    expect(packageJson).toMatchObject({
      type: 'module',
      engines: { node: '>=22 <25' },
      bin: { 'poolstatis-mcp': './dist/cli.js' },
      license: 'PolyForm-Shield-1.0.0',
      publishConfig: {
        access: 'public',
        registry: 'https://registry.npmjs.org/',
      },
    });
    expect((await stat(executable)).mode & 0o111).not.toBe(0);
    expect(await readFile(join(
      tempProject,
      'node_modules',
      '@poolstatis',
      'mcp',
      'LICENSE',
    ), 'utf8')).toContain('PolyForm Shield License 1.0.0');
  });

  it('initializes, lists tools, and performs a project-scoped read against a safe fixture', async () => {
    const { client, stderr } = await connect(process.execPath, [cliModule]);
    try {
      const tools = await client.listTools(undefined, { timeout: 15_000 });
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'list_projects',
        'get_project_schema',
      ]));
      const result = await client.callTool({
        name: 'get_project_schema',
        arguments: { project: 'safe-fixture', env: 'prod' },
      }, undefined, { timeout: 15_000 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        project: { slug: 'safe-fixture', name: 'Safe Fixture' },
      });
    } finally {
      await client.close();
    }
    expect(Buffer.concat(stderr).toString('utf8')).toBe('');
    expect(requests).toContainEqual({
      method: 'GET',
      url: '/api/v1/projects/safe-fixture/schema?env=prod',
      authorization: `Bearer ${safeToken}`,
      client: 'mcp',
    });
  });

  it('runs through a tarball-backed pnpm dlx equivalent without stdio noise', async () => {
    const { client, stderr } = await connect('pnpm', [
      '--silent',
      '--package',
      `file:${tarball}`,
      'dlx',
      'poolstatis-mcp',
    ]);
    try {
      const tools = await client.listTools(undefined, { timeout: 30_000 });
      expect(tools.tools.length).toBeGreaterThan(20);
    } finally {
      await client.close();
    }
    expect(Buffer.concat(stderr).toString('utf8')).toBe('');
  }, 60_000);

  it('terminates cleanly on SIGTERM without writing non-protocol output', async () => {
    const child = spawn(process.execPath, [cliModule], {
      cwd: tempProject,
      env: {
        PATH: process.env.PATH ?? '',
        POOLSTATIS_URL: fixtureUrl,
        POOLSTATIS_TOKEN: safeToken,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    await new Promise((resolveReady) => setTimeout(resolveReady, 150));
    child.kill('SIGTERM');
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
      },
    );
    expect(outcome).toEqual({ code: null, signal: 'SIGTERM' });
    expect(Buffer.concat(stdout).toString('utf8')).toBe('');
    expect(Buffer.concat(stderr).toString('utf8')).toBe('');
  });
});
