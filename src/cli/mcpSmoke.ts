/**
 * Real MCP smoke test: starts the local stdio server and calls tools/resources
 * through the MCP client SDK. Requires a running Platform API and POOLSTATIS_TOKEN.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const project = readArg('--project') ?? readArg('-p');
const env = readArg('--env') ?? 'prod';
const baseUrl = readArg('--url') ?? process.env.POOLSTATIS_URL ?? 'http://127.0.0.1:3300';
const token = readArg('--token') ?? process.env.POOLSTATIS_TOKEN;
const repoDir = readArg('--dir') ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');

if (!project) {
  console.error('Usage: pnpm mcp:smoke --project <slug> [--env prod] [--url http://127.0.0.1:3300]');
  process.exit(1);
}
if (!token) {
  console.error('POOLSTATIS_TOKEN is required. Use a pt_ personal token or sk_ project secret key.');
  process.exit(1);
}

const inheritedEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) inheritedEnv[key] = value;
}
inheritedEnv.POOLSTATIS_URL = baseUrl;
inheritedEnv.POOLSTATIS_TOKEN = token;

const client = new Client({ name: 'poolstatis-mcp-smoke', version: '0.1.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: 'pnpm',
  args: ['--silent', '--dir', repoDir, 'mcp'],
  env: inheritedEnv,
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const resources = await client.listResources();
  const templates = await client.listResourceTemplates();

  await client.readResource({ uri: 'poolstatis://standard/instrumentation' });
  await client.readResource({ uri: `poolstatis://${project}/schema` });

  const projects = await callTool('list_projects', {});
  const schema = await callTool('get_project_schema', { project, env });
  const funnels = await callTool('list_funnels', { project });
  const flags = await callTool('list_feature_flags', { project });
  const experiments = await callTool('list_experiments', { project });
  const sample = await callTool('sample_events', { project, env, limit: 100 });
  const warnings = await callTool('list_ingest_warnings', { project, env });
  const quality = await callTool('list_data_quality_issues', { project, env, limit: 50 });

  const firstMetric = firstArrayItem(schema.metrics);
  const firstMetricKey = typeof firstMetric?.key === 'string' ? firstMetric.key : null;
  const metricUsage = firstMetricKey
    ? await callTool('explain_metric_usage', { project, key: firstMetricKey, env, since_days: 30 })
    : null;
  const firstFunnel = firstArrayItem(funnels.funnels);
  const firstFunnelKey = typeof firstFunnel?.key === 'string' ? firstFunnel.key : null;
  const funnelResult = firstFunnelKey
    ? await callTool('query_funnel', { project, query: { funnel: firstFunnelKey, date_from: '-30d', env } })
    : null;

  const activeMetrics = asArray(schema.metrics).filter((m) => (m as { status?: unknown }).status === 'active');
  const sampleEvents = asArray(sample.events);
  const warningRows = asArray(warnings.warnings);
  const qualityIssues = asArray(quality.issues);
  const observedEvents = asArray(schema.observed_events_30d);
  const summary = {
    ok: true,
    project,
    env,
    mcp: {
      tools: tools.tools.length,
      structured_tools: tools.tools.filter((t) => Boolean(t.outputSchema)).length,
      resources: resources.resources.map((r) => r.uri),
      resource_templates: templates.resourceTemplates.map((t) => t.uriTemplate),
    },
    projects_visible: asArray(projects.projects).length,
    active_metrics: activeMetrics.length,
    funnels: asArray(schema.funnels).length,
    feature_flags: asArray(flags.flags).length,
    experiments: asArray(experiments.experiments).length,
    observed_events_30d: observedEvents.reduce((sum: number, row: unknown) => sum + Number((row as { count?: unknown }).count ?? 0), 0),
    sample_events: {
      total: sampleEvents.length,
      registered: sampleEvents.filter((e) => (e as { registered?: unknown }).registered === true).length,
    },
    warnings: warningRows.length,
    data_quality_issues: qualityIssues.length,
    first_metric_usage: metricUsage
      ? {
          key: firstMetricKey,
          source_events: asArray(metricUsage.source_events).length,
          funnels: asArray((metricUsage.used_by as { funnels?: unknown } | undefined)?.funnels).length,
          insights: asArray((metricUsage.used_by as { insights?: unknown } | undefined)?.insights).length,
        }
      : null,
    first_funnel: funnelResult
      ? {
          key: firstFunnelKey,
          actors: asArray(funnelResult.steps).map((step) => (step as { actors?: unknown }).actors),
        }
      : null,
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.close();
}

async function callTool(name: string, toolArgs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: toolArgs }) as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: unknown;
  };
  const content = asArray(result.content) as Array<{ type?: unknown; text?: unknown }>;
  if (result.isError) {
    const text = content.find((c) => c.type === 'text')?.text ?? 'tool failed';
    throw new Error(`${name}: ${text}`);
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = content.find((c) => c.type === 'text')?.text;
  if (!text) return {};
  return JSON.parse(String(text)) as Record<string, unknown>;
}

function readArg(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('-') ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstArrayItem(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) && value[0] && typeof value[0] === 'object'
    ? value[0] as Record<string, unknown>
    : null;
}
