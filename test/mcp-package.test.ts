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
let dlxProject: string;
let tarball: string;
let executable: string;
let cliModule: string;
let fixture: Server;
let fixtureUrl: string;
let generatedPackDir: string | undefined;
const requests: Array<{ method: string; url: string; authorization?: string; client?: string }> = [];

async function connect(
  command: string,
  args: string[] = [],
  cwd = tempProject,
  extraEnv: Record<string, string> = {},
) {
  const stderr: Buffer[] = [];
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      POOLSTATIS_URL: fixtureUrl,
      POOLSTATIS_TOKEN: safeToken,
      ...extraEnv,
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
  dlxProject = await mkdtemp(join(tmpdir(), 'poolstatis-mcp-dlx-'));
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
    'dist/core/mcp/actorsStandard.d.ts',
    'dist/core/mcp/actorsStandard.js',
    'dist/core/mcp/browserStandard.d.ts',
    'dist/core/mcp/browserStandard.js',
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
  fixture = createServer(async (req, res) => {
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
    if (req.method === 'GET' && req.url === '/api/v1/projects/safe-fixture/keys') {
      res.end(JSON.stringify({
        keys: [{
          id: 'key-safe', kind: 'secret', env: 'prod', label: 'Agent',
          masked_token: 'sk_...cafe', created_at: '2026-08-01T00:00:00.000Z',
          last_used_at: '2026-08-11T00:00:00.000Z', revoked_at: null,
        }],
      }));
      return;
    }
    if (req.method === 'GET'
        && req.url === '/api/v1/projects/safe-fixture/experience/routes?surface=checkout') {
      res.end(JSON.stringify({
        routes: [{ surface_key: 'checkout', key: 'checkout', path_pattern: '/checkout' }],
      }));
      return;
    }
    if (req.method === 'GET'
        && req.url === '/api/v1/projects/safe-fixture/experience/snapshots?env=prod&surface=checkout&route=checkout') {
      res.end(JSON.stringify({
        snapshots: [{
          surface_key: 'checkout',
          route_key: 'checkout',
          version: 'v2',
          device: 'desktop',
          storage_key: 'safe-fixture/checkout/v2/desktop.snapshot',
        }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/projects/safe-fixture/query') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { kind?: string };
      if (body.kind === 'visual_experience') {
        res.end(JSON.stringify({
          kind: 'visual_experience',
          project: 'safe-fixture',
          surface: 'checkout',
          route: 'checkout',
          version: 'v2',
          device: 'desktop',
          summary: { sessions: 3, actors: 3, page_views: 3, clicks: 2 },
          click_bins: [{ x: 2, y: 1, count: 2, percentage: 100 }],
          sections: [{ section: 'checkout_form', sessions: 3, percentage: 100 }],
          snapshot: { storage_key: 'safe-fixture/checkout/v2/desktop.snapshot' },
          agent_context: {
            scope: {
              surface: 'checkout',
              route: 'checkout',
              version: 'v2',
              device: 'desktop',
              purpose: 'Find checkout friction without collecting page content.',
            },
            sample_size: { events: 8, sessions: 3, actors: 3, page_views: 3, clicks: 2 },
            section_order: ['checkout_form'],
            largest_section_reach_decreases: [],
            click_concentration: [{ label: 'checkout.pay', count: 2, actors: 2, percentage_of_all_clicks: 100 }],
            scroll_reach: [{ depth: 100, sessions: 2, actors: 2, percentage: 66.67 }],
            snapshot_coverage: {
              status: 'fresh',
              exact_viewport_match: true,
              snapshot_id: 'snapshot-v2',
              evidence_ref: 'poolstatis://experience/snapshots/snapshot-v2',
            },
            evidence_refs: [{
              type: 'experience_snapshot',
              id: 'snapshot-v2',
              evidence_ref: 'poolstatis://experience/snapshots/snapshot-v2',
            }],
            data_quality: {
              status: 'ok',
              caveats: ['This evidence is descriptive and non-causal.'],
            },
            suggested_next_actions: [
              { action: 'list_versions', tool: 'list_visual_experience_versions' },
              { action: 'compare_explicit_cohorts', tool: 'compare_visual_experience' },
            ],
          },
          causality: 'Descriptive aggregate evidence; not causal proof.',
        }));
        return;
      }
      if (body.kind === 'visual_experience_compare') {
        res.end(JSON.stringify({
          kind: 'visual_experience_compare',
          project: 'safe-fixture',
          surface: 'checkout',
          route: 'checkout',
          baseline: { version: 'v1', device: 'desktop', summary: { sessions: 2, actors: 2, page_views: 2, clicks: 1 } },
          comparison: { version: 'v2', device: 'desktop', summary: { sessions: 3, actors: 3, page_views: 3, clicks: 2 } },
          delta: { sessions: 1, actors: 1, page_views: 1, clicks: 1 },
          agent_context: {
            sample_sizes: {
              baseline: { events: 5, sessions: 2, actors: 2, page_views: 2, clicks: 1 },
              comparison: { events: 8, sessions: 3, actors: 3, page_views: 3, clicks: 2 },
            },
            largest_section_changes: [{
              section: 'checkout_form',
              baseline_percentage: 100,
              comparison_percentage: 100,
              percentage_points: 0,
            }],
            evidence_refs: [{
              type: 'experience_snapshot',
              id: 'snapshot-v2',
              evidence_ref: 'poolstatis://experience/snapshots/snapshot-v2',
            }],
            data_quality: {
              status: 'ok',
              caveats: ['Descriptive cohort comparison; not causal proof.'],
            },
            suggested_next_actions: [
              { action: 'inspect_baseline_map', tool: 'get_visual_experience_map' },
              { action: 'inspect_comparison_map', tool: 'get_visual_experience_map' },
            ],
          },
          causality: 'Descriptive cohort comparison; not causal proof.',
        }));
        return;
      }
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
  if (dlxProject) await rm(dlxProject, { recursive: true, force: true });
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
      expect(client.getServerVersion()).toEqual({ name: 'poolstatis', version: '0.6.0' });
      const tools = await client.listTools(undefined, { timeout: 15_000 });
      expect(tools.tools).toHaveLength(105);
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'list_projects',
        'list_project_keys',
        'get_project_schema',
        'get_web_overview',
        'list_web_sessions',
        'get_web_session',
        'get_session_engagement',
        'get_page_engagement',
        'list_visual_experience_versions',
        'get_visual_experience_map',
        'compare_visual_experience',
        'preview_event_backfill',
        'import_historical_events',
        'list_event_backfills',
        'preview_event_revision',
        'revise_event',
        'get_event_history',
      ]));
      const browserStandard = await client.readResource({
        uri: 'poolstatis://standard/browser-analytics',
      });
      const browserStandardText = browserStandard.contents
        .map((content) => ('text' in content ? content.text : ''))
        .join('\n');
      expect(browserStandardText).toContain('starts collection immediately');
      expect(browserStandardText).toContain('does not require a consent state');
      expect(browserStandardText).toContain('reviewed local MMDB resolver');
      expect(browserStandardText).toContain('`landing_route`');
      expect(browserStandardText).not.toContain('does nothing before explicit consent');
      const result = await client.callTool({
        name: 'get_project_schema',
        arguments: { project: 'safe-fixture', env: 'prod' },
      }, undefined, { timeout: 15_000 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        project: { slug: 'safe-fixture', name: 'Safe Fixture' },
      });

      const keys = await client.callTool({
        name: 'list_project_keys',
        arguments: { project: 'safe-fixture' },
      }, undefined, { timeout: 15_000 });
      expect(keys.isError).not.toBe(true);
      expect(keys.structuredContent).toMatchObject({
        keys: [{ masked_token: 'sk_...cafe', last_used_at: '2026-08-11T00:00:00.000Z' }],
      });
      expect(JSON.stringify(keys.structuredContent)).not.toContain(safeToken);

      const versions = await client.callTool({
        name: 'list_visual_experience_versions',
        arguments: {
          project: 'safe-fixture',
          surface: 'checkout',
          route: 'checkout',
          env: 'prod',
        },
      }, undefined, { timeout: 15_000 });
      expect(versions.isError).not.toBe(true);
      expect(versions.structuredContent).toMatchObject({
        routes: [{ surface_key: 'checkout', key: 'checkout' }],
        snapshots: [{ version: 'v2', device: 'desktop' }],
      });

      const visual = await client.callTool({
        name: 'get_visual_experience_map',
        arguments: {
          project: 'safe-fixture',
          query: {
            surface: 'checkout',
            route: 'checkout',
            version: 'v2',
            device: 'desktop',
            date_from: '-7d',
            env: 'prod',
          },
        },
      }, undefined, { timeout: 15_000 });
      expect(visual.isError).not.toBe(true);
      expect(visual.structuredContent).toMatchObject({
        kind: 'visual_experience',
        summary: { sessions: 3, clicks: 2 },
        agent_context: {
          scope: {
            surface: 'checkout',
            route: 'checkout',
            version: 'v2',
            device: 'desktop',
            purpose: 'Find checkout friction without collecting page content.',
          },
          sample_size: { sessions: 3, actors: 3, page_views: 3, clicks: 2 },
          section_order: ['checkout_form'],
          click_concentration: [{ label: 'checkout.pay', percentage_of_all_clicks: 100 }],
          scroll_reach: [{ depth: 100, percentage: 66.67 }],
          snapshot_coverage: { status: 'fresh', exact_viewport_match: true },
          evidence_refs: [{ type: 'experience_snapshot', id: 'snapshot-v2' }],
          data_quality: { status: 'ok' },
          suggested_next_actions: [
            { action: 'list_versions', tool: 'list_visual_experience_versions' },
            { action: 'compare_explicit_cohorts', tool: 'compare_visual_experience' },
          ],
        },
      });

      const compared = await client.callTool({
        name: 'compare_visual_experience',
        arguments: {
          project: 'safe-fixture',
          query: {
            surface: 'checkout',
            route: 'checkout',
            env: 'prod',
            baseline: { version: 'v1', device: 'desktop', date_from: '-14d', date_to: '-8d' },
            comparison: { version: 'v2', device: 'desktop', date_from: '-7d' },
          },
        },
      }, undefined, { timeout: 15_000 });
      expect(compared.isError).not.toBe(true);
      expect(compared.structuredContent).toMatchObject({
        kind: 'visual_experience_compare',
        delta: { page_views: 1, sessions: 1, clicks: 1 },
        agent_context: {
          sample_sizes: {
            baseline: { sessions: 2, actors: 2, page_views: 2, clicks: 1 },
            comparison: { sessions: 3, actors: 3, page_views: 3, clicks: 2 },
          },
          largest_section_changes: [{ section: 'checkout_form', percentage_points: 0 }],
          evidence_refs: [{ id: 'snapshot-v2' }],
          data_quality: { status: 'ok' },
          suggested_next_actions: [
            { action: 'inspect_baseline_map', tool: 'get_visual_experience_map' },
            { action: 'inspect_comparison_map', tool: 'get_visual_experience_map' },
          ],
        },
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
    ], dlxProject, {
      // Node 24 reports DEP0169 from pnpm's own dlx wrapper. The direct
      // executable test above still enforces zero stderr from the MCP package.
      NODE_OPTIONS: '--no-deprecation',
    });
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
