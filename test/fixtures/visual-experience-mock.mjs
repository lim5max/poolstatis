import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const desktopSnapshot = '/tmp/poolstatis-visual-desktop.png';
const mobileSnapshot = '/tmp/poolstatis-visual-mobile.png';

const surface = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'marketing',
  name: 'Marketing site',
  purpose: 'Find which public-page sections lose qualified visitors before setup.',
  status: 'active',
  created_at: '2026-07-27T00:00:00.000Z',
  updated_at: '2026-07-27T00:00:00.000Z',
};

const route = {
  id: '22222222-2222-4222-8222-222222222222',
  surface_key: 'marketing',
  key: 'home',
  name: 'Home',
  path_pattern: '/',
  created_at: '2026-07-27T00:00:00.000Z',
  updated_at: '2026-07-27T00:00:00.000Z',
};

const snapshot = (device) => ({
  id: device === 'desktop'
    ? '33333333-3333-4333-8333-333333333333'
    : '44444444-4444-4444-8444-444444444444',
  surface_key: 'marketing',
  route_key: 'home',
  env: 'prod',
  version: 'release-a',
  device,
  release_hash: 'abc123',
  mime_type: 'image/png',
  byte_size: 300262,
  width: device === 'desktop' ? 2880 : 1164,
  height: device === 'desktop' ? 5760 : 4882,
  viewport_width: device === 'desktop' ? 1440 : 390,
  viewport_height: device === 'desktop' ? 900 : 844,
  document_width: device === 'desktop' ? 1440 : 390,
  document_height: device === 'desktop' ? 2880 : 2441,
  captured_at: '2026-07-27T00:00:00.000Z',
  expires_at: '2026-10-25T00:00:00.000Z',
  created_at: '2026-07-27T00:00:00.000Z',
  evidence_ref: `poolstatis://experience/snapshots/${device}`,
  stale: false,
});

const visual = (device) => ({
  kind: 'visual_experience',
  surface,
  route: 'home',
  version: 'release-a',
  device,
  grid: 24,
  snapshot: snapshot(device),
  summary: {
    events: device === 'desktop' ? 486 : 302,
    page_views: device === 'desktop' ? 128 : 84,
    sessions: device === 'desktop' ? 118 : 79,
    actors: device === 'desktop' ? 104 : 72,
    clicks: device === 'desktop' ? 186 : 96,
    max_document_width: device === 'desktop' ? 1440 : 390,
    max_document_height: device === 'desktop' ? 2880 : 2441,
  },
  click_cells: [
    { x: 5, y: 3, count: 42, actors: 35 },
    { x: 8, y: 14, count: 27, actors: 24 },
    { x: 4, y: 22, count: 18, actors: 16 },
  ],
  click_labels: [
    { label: 'hero.get_started', count: 42, actors: 35 },
    { label: 'workflow.open_mcp', count: 27, actors: 24 },
    { label: 'final_cta.start', count: 18, actors: 16 },
  ],
  scroll_coverage: [10,20,30,40,50,60,70,80,90,100].map((depth, index) => ({
    depth,
    sessions: Math.max(19, 118 - index * 10),
    actors: Math.max(17, 104 - index * 9),
    percentage: Number((Math.max(19, 118 - index * 10) / 118 * 100).toFixed(2)),
  })),
  sections: [
    { section: 'hero', top: 0, sessions: 118, actors: 104, percentage: 100, dropoff_percentage: 0 },
    { section: 'proof', top: 0.25, sessions: 91, actors: 84, percentage: 77.12, dropoff_percentage: 22.88 },
    { section: 'workflow', top: 0.5, sessions: 63, actors: 58, percentage: 53.39, dropoff_percentage: 46.61 },
    { section: 'final_cta', top: 0.75, sessions: 37, actors: 34, percentage: 31.36, dropoff_percentage: 68.64 },
  ],
  causality: 'Aggregated interaction evidence shows where observed sessions clicked or reached; it does not prove why users stopped or that a page change caused a difference.',
  meta: {
    computed_at: '2026-07-27T00:00:00.000Z',
    date_range: { from: '2026-06-27T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' },
  },
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:3300');
  const send = (status, body, contentType = 'application/json') => {
    response.writeHead(status, { 'content-type': contentType });
    response.end(contentType === 'application/json' ? JSON.stringify(body) : body);
  };
  if (request.method === 'GET' && url.pathname === '/api/v1/projects') {
    return send(200, {
      projects: [{ slug: 'visual-fixture', name: 'Visual fixture', timezone: 'UTC', active_metrics: 0 }],
      scope: 'project',
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/projects/visual-fixture/keys') {
    return send(200, { keys: [{ id: 'fixture', kind: 'secret', env: 'prod', revoked_at: null }] });
  }
  if (request.method === 'GET' && url.pathname.endsWith('/experience/surfaces')) {
    return send(200, { surfaces: [surface] });
  }
  if (request.method === 'GET' && url.pathname.endsWith('/experience/routes')) {
    return send(200, { routes: [route] });
  }
  if (request.method === 'GET' && url.pathname.endsWith('/experience/snapshots')) {
    return send(200, { snapshots: [snapshot('desktop'), snapshot('mobile')] });
  }
  if (request.method === 'GET' && url.pathname.includes('/experience/snapshots/')) {
    const bytes = await readFile(url.pathname.includes('44444444') ? mobileSnapshot : desktopSnapshot);
    return send(200, bytes, 'image/png');
  }
  if (request.method === 'POST' && url.pathname.endsWith('/query')) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.kind === 'visual_experience_compare') {
      return send(200, {
        kind: 'visual_experience_compare',
        baseline: visual(body.baseline.device),
        comparison: visual(body.comparison.device),
        delta: {
          sessions: -39,
          clicks: -90,
          actors: -32,
          sections: [
            { section: 'hero', percentage_points: 0 },
            { section: 'final_cta', percentage_points: -8.47 },
          ],
        },
        causality: 'This is a descriptive comparison across selected cohorts.',
      });
    }
    if (body.kind === 'experience_session') {
      return send(200, { kind: 'experience_session', surface, session_id: body.session_id, events: [], summary: { page_views: 0, clicks: 0, max_scroll_depth: 0, client_errors: 0 } });
    }
    return send(200, visual(body.device));
  }
  send(404, { error: { code: 'not_found', message: 'fixture endpoint not found' } });
});

server.listen(3300, '127.0.0.1');
