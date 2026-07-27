import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import { LocalArtifactStore } from '../src/stores/artifactStore.js';
import { purgeExpiredExperienceSnapshots } from '../src/services/experienceArtifactRetention.js';
import { deleteExperienceSnapshot } from '../src/services/experience.js';

let env: TestEnv;
let other: TestEnv;
let artifactDir: string;

beforeAll(async () => {
  artifactDir = await mkdtemp(join(tmpdir(), 'poolstatis-visual-maps-'));
  env = await createTestEnv({ artifactDir });
  other = await createTestEnv({ artifactDir });
});

afterAll(async () => {
  await env.close();
  await other.close();
  await rm(artifactDir, { recursive: true, force: true });
});

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe('visual experience maps', () => {
  const P = () => `/api/v1/projects/${env.projectSlug}`;

  it('keeps immutable snapshot bytes project-scoped and returns bounded aggregate evidence', async () => {
    const surface = await api(env, env.secretToken, 'POST', `${P()}/experience/surfaces`, {
      key: 'marketing',
      name: 'Marketing site',
      purpose: 'Find which landing sections lose qualified visitors.',
      route_pattern: '/',
    });
    expect(surface.status).toBe(201);
    const docsRoute = await api(env, env.secretToken, 'POST', `${P()}/experience/surfaces/marketing/routes`, {
      key: 'docs',
      name: 'Docs',
      path_pattern: '/docs/*',
    });
    expect(docsRoute.status).toBe(201);

    const image = pngHeader(1440, 3200);
    const snapshot = await env.app.inject({
      method: 'POST',
      url: `${P()}/experience/snapshots?surface=marketing&route=marketing&version=release-a&device=desktop&env=prod&release_hash=abc123&viewport_width=1440&viewport_height=900&document_width=1440&document_height=3200&captured_at=2026-07-26T20%3A00%3A00.000Z&retention_days=90`,
      headers: { authorization: `Bearer ${env.secretToken}`, 'content-type': 'image/png' },
      payload: image,
    });
    expect(snapshot.statusCode).toBe(201);
    const snapshotBody = snapshot.json();
    expect(snapshotBody).toMatchObject({
      surface_key: 'marketing',
      route_key: 'marketing',
      version: 'release-a',
      device: 'desktop',
      width: 1440,
      height: 3200,
      document_width: 1440,
      document_height: 3200,
    });

    const ownImage = await env.app.inject({
      method: 'GET',
      url: `${P()}/experience/snapshots/${snapshotBody.id}/image`,
      headers: { authorization: `Bearer ${env.secretToken}` },
    });
    expect(ownImage.statusCode).toBe(200);
    expect(ownImage.rawPayload.equals(image)).toBe(true);

    const crossTenant = await other.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${other.projectSlug}/experience/snapshots/${snapshotBody.id}/image`,
      headers: { authorization: `Bearer ${other.secretToken}` },
    });
    expect(crossTenant.statusCode).toBe(404);

    const common = {
      distinct_id: 'actor-1',
      session_id: 'session-1',
      route: 'marketing',
      version: 'release-a',
      device: 'desktop',
      viewport_width: 1440,
      viewport_height: 900,
      document_width: 1440,
      document_height: 3200,
    } as const;
    const captured = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
      surface: 'marketing',
      batch_id: 'visual-map-batch-1',
      events: [
        { kind: 'page_viewed', ...common, sequence: 1 },
        {
          kind: 'element_clicked', ...common, sequence: 2, label: 'hero.get_started',
          x: 0.5, y: 0.125, viewport_x: 0.5, viewport_y: 0.45,
        },
        { kind: 'scroll_depth', ...common, sequence: 3, depth: 80 },
        { kind: 'section_exposed', ...common, sequence: 4, section: 'hero', top: 0 },
        { kind: 'section_exposed', ...common, sequence: 5, section: 'features', top: 0.35 },
        {
          kind: 'page_viewed',
          ...common,
          distinct_id: 'actor-2',
          session_id: 'session-2',
          sequence: 1,
        },
        {
          kind: 'section_exposed',
          ...common,
          distinct_id: 'actor-2',
          session_id: 'session-2',
          sequence: 2,
          section: 'hero',
          top: 0,
        },
        {
          kind: 'page_viewed',
          ...common,
          session_id: 'session-other-viewport',
          viewport_width: 1024,
          document_width: 1024,
          sequence: 1,
        },
        {
          kind: 'element_clicked',
          ...common,
          session_id: 'session-other-viewport',
          viewport_width: 1024,
          document_width: 1024,
          sequence: 2,
          label: 'wrong.layout',
          x: 0.9,
          y: 0.9,
        },
        {
          kind: 'scroll_depth',
          ...common,
          session_id: 'session-without-page-view',
          sequence: 1,
          depth: 100,
        },
        {
          kind: 'section_exposed',
          ...common,
          session_id: 'session-without-page-view',
          sequence: 2,
          section: 'orphan',
          top: 0.9,
        },
        {
          kind: 'page_viewed',
          ...common,
          session_id: 'session-other-document',
          document_height: 2800,
          sequence: 1,
        },
        {
          kind: 'element_clicked',
          ...common,
          session_id: 'session-other-document',
          document_height: 2800,
          sequence: 2,
          label: 'wrong.document',
          x: 0.75,
          y: 0.75,
        },
      ],
    });
    expect(captured).toMatchObject({ status: 200, body: { accepted: 13 } });

    const map = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'visual_experience',
      surface: 'marketing',
      route: 'marketing',
      version: 'release-a',
      device: 'desktop',
      date_from: '-7d',
      env: 'prod',
      grid: 8,
    });
    expect(map.status, JSON.stringify(map.body)).toBe(200);
    expect(map.body).toMatchObject({
      kind: 'visual_experience',
      snapshot: { id: snapshotBody.id, release_hash: 'abc123' },
      summary: { page_views: 2, sessions: 2, actors: 2, clicks: 1 },
      click_cells: [{ x: 4, y: 1, count: 1, actors: 1 }],
      click_labels: [{ label: 'hero.get_started', count: 1, actors: 1 }],
      sections: [
        { section: 'hero', sessions: 2, percentage: 100, dropoff_percentage: 0 },
        { section: 'features', sessions: 1, percentage: 50, dropoff_percentage: 50 },
      ],
      agent_context: {
        scope: {
          surface: 'marketing',
          route: 'marketing',
          version: 'release-a',
          device: 'desktop',
          purpose: 'Find which landing sections lose qualified visitors.',
        },
        sample_size: { events: 7, page_views: 2, sessions: 2, actors: 2, clicks: 1 },
        section_order: ['hero', 'features'],
        largest_section_reach_decreases: [{
          from_section: 'hero',
          to_section: 'features',
          from_sessions: 2,
          to_sessions: 1,
          session_count_decrease: 1,
          percentage_point_decrease: 50,
        }],
        click_concentration: [{
          label: 'hero.get_started',
          count: 1,
          actors: 1,
          percentage_of_all_clicks: 100,
        }],
        output_coverage: {
          click_labels_returned: 1,
          click_labels_truncated: false,
          sections_returned: 2,
          sections_truncated: false,
        },
        snapshot_coverage: {
          status: 'fresh',
          exact_viewport_match: true,
          evidence_ref: `poolstatis://experience/snapshots/${snapshotBody.id}`,
        },
        evidence_refs: [{
          type: 'experience_snapshot',
          id: snapshotBody.id,
          evidence_ref: `poolstatis://experience/snapshots/${snapshotBody.id}`,
        }],
        data_quality: {
          status: 'ok',
          caveats: expect.arrayContaining([
            expect.stringContaining('consent'),
            expect.stringContaining('descriptive'),
          ]),
        },
        suggested_next_actions: [
          expect.objectContaining({ action: 'list_versions', tool: 'list_visual_experience_versions' }),
          expect.objectContaining({ action: 'compare_explicit_cohorts', tool: 'compare_visual_experience' }),
        ],
      },
    });
    expect(map.body.scroll_coverage).toEqual(expect.arrayContaining([
      { depth: 80, sessions: 1, actors: 1, percentage: 50 },
      { depth: 90, sessions: 0, actors: 0, percentage: 0 },
    ]));
    expect(map.body.causality).toContain('does not prove');
    expect(map.body.agent_context.suggested_next_actions[1].known_parameters.baseline).toMatchObject({
      date_from: expect.stringMatching(/Z$/),
      date_to: expect.stringMatching(/Z$/),
    });
    expect(map.body.agent_context.suggested_next_actions[1].known_parameters.baseline.date_from).not.toBe('-7d');

    const comparisonCaptured = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
      surface: 'marketing',
      batch_id: 'visual-map-release-b',
      events: [
        {
          kind: 'page_viewed',
          ...common,
          version: 'release-b',
          distinct_id: 'actor-b',
          session_id: 'session-b',
          sequence: 1,
        },
        {
          kind: 'section_exposed',
          ...common,
          version: 'release-b',
          distinct_id: 'actor-b',
          session_id: 'session-b',
          sequence: 2,
          section: 'hero_v2',
          top: 0,
        },
      ],
    });
    expect(comparisonCaptured).toMatchObject({ status: 200, body: { accepted: 2 } });
    const compared = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'visual_experience_compare',
      surface: 'marketing',
      route: 'marketing',
      baseline: { version: 'release-a', device: 'desktop', date_from: '-7d' },
      comparison: { version: 'release-b', device: 'desktop', date_from: '-7d' },
      env: 'prod',
      grid: 8,
    });
    expect(compared.status, JSON.stringify(compared.body)).toBe(200);
    expect(compared.body).toMatchObject({
      delta: {
        events: -5,
        page_views: -1,
        sections: expect.arrayContaining([
          {
            section: 'hero_v2',
            baseline_present: false,
            comparison_present: true,
            percentage_points: null,
          },
        ]),
      },
      agent_context: {
        largest_section_changes: [],
        section_taxonomy_mismatches: expect.arrayContaining([
          { section: 'hero', baseline_present: true, comparison_present: false },
          { section: 'features', baseline_present: true, comparison_present: false },
          { section: 'hero_v2', baseline_present: false, comparison_present: true },
        ]),
        data_quality: {
          status: 'limited',
          caveats: expect.arrayContaining([expect.stringContaining('taxonomy mismatches')]),
        },
      },
    });
    expect(compared.body.agent_context.suggested_next_actions[0].query.date_from).toMatch(/Z$/);
    expect(compared.body.agent_context.suggested_next_actions[0].query.date_from).not.toBe('-7d');
  });

  it('reports top-label and section truncation instead of misclassifying omitted aggregates', async () => {
    const common = {
      distinct_id: 'actor-bounded',
      session_id: 'session-bounded',
      route: 'marketing',
      version: 'release-bounded',
      device: 'desktop',
      viewport_width: 1440,
      viewport_height: 900,
      document_width: 1440,
      document_height: 3200,
    } as const;
    const events = [
      { kind: 'page_viewed' as const, ...common, sequence: 1 },
      ...Array.from({ length: 101 }, (_, index) => ({
        kind: 'element_clicked' as const,
        ...common,
        sequence: index + 2,
        label: `click_${String(index).padStart(3, '0')}`,
        x: 0.5,
        y: 0.5,
      })),
      ...Array.from({ length: 201 }, (_, index) => ({
        kind: 'section_exposed' as const,
        ...common,
        sequence: index + 103,
        section: `section_${String(index).padStart(3, '0')}`,
        top: index / 200,
      })),
    ];
    for (let offset = 0; offset < events.length; offset += 100) {
      const captured = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
        surface: 'marketing',
        batch_id: `visual-map-bounded-${offset / 100}`,
        events: events.slice(offset, offset + 100),
      });
      expect(captured.status, JSON.stringify(captured.body)).toBe(200);
    }
    const map = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'visual_experience',
      surface: 'marketing',
      route: 'marketing',
      version: 'release-bounded',
      device: 'desktop',
      date_from: '-7d',
      env: 'prod',
      grid: 8,
    });
    expect(map.body).toMatchObject({
      summary: { page_views: 1, sessions: 1, clicks: 101 },
      click_labels_truncated: true,
      sections_truncated: true,
      agent_context: {
        output_coverage: {
          click_labels_returned: 100,
          click_labels_truncated: true,
          sections_returned: 200,
          sections_truncated: true,
        },
        data_quality: {
          status: 'limited',
          caveats: expect.arrayContaining([
            expect.stringContaining('top-100 bound'),
            expect.stringContaining('200-label bound'),
          ]),
        },
      },
    });
    expect(map.body.click_labels).toHaveLength(100);
    expect(map.body.sections).toHaveLength(200);
    expect(map.body.agent_context.data_quality.caveats).not.toEqual(
      expect.arrayContaining([expect.stringContaining('lacked a safe stable label')]),
    );
  });

  it('rejects unregistered routes, unsafe metadata and non-image bytes', async () => {
    const unsafeRoute = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
      surface: 'marketing',
      batch_id: 'unknown-route',
      events: [{
        kind: 'page_viewed',
        distinct_id: 'actor-2',
        session_id: 'session-2',
        route: 'unknown',
        sequence: 1,
      }],
    });
    expect(unsafeRoute.status).toBe(400);
    expect(unsafeRoute.body.error.code).toBe('experience_route_not_registered');

    const badImage = await env.app.inject({
      method: 'POST',
      url: `${P()}/experience/snapshots?surface=marketing&route=marketing&version=release-b&device=mobile&env=prod&release_hash=def456&viewport_width=390&viewport_height=844&document_width=390&document_height=1600&captured_at=2026-07-26T20%3A00%3A00.000Z`,
      headers: { authorization: `Bearer ${env.secretToken}`, 'content-type': 'image/png' },
      payload: Buffer.from('not an image'),
    });
    expect(badImage.statusCode).toBe(400);
    expect(badImage.json().error.code).toBe('snapshot_content_invalid');

    const futureSnapshot = await env.app.inject({
      method: 'POST',
      url: `${P()}/experience/snapshots?surface=marketing&route=marketing&version=future-clock&device=desktop&env=dev&release_hash=future123&viewport_width=1440&viewport_height=900&document_width=1440&document_height=3200&captured_at=2099-01-01T00%3A00%3A00.000Z`,
      headers: { authorization: `Bearer ${env.secretToken}`, 'content-type': 'image/png' },
      payload: pngHeader(1440, 3200),
    });
    expect(futureSnapshot.statusCode).toBe(201);
    const futureMap = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'visual_experience',
      surface: 'marketing',
      route: 'marketing',
      version: 'future-clock',
      device: 'desktop',
      date_from: '-7d',
      env: 'dev',
      grid: 8,
    });
    expect(futureMap.body.agent_context).toMatchObject({
      snapshot_coverage: {
        status: 'future',
        exact_viewport_match: true,
        age_seconds: expect.any(Number),
      },
      data_quality: {
        status: 'empty',
        caveats: expect.arrayContaining([expect.stringContaining('clock skew')]),
      },
    });
    expect(futureMap.body.agent_context.snapshot_coverage.age_seconds).toBeLessThan(0);

    const mismatchedLayout = await env.app.inject({
      method: 'POST',
      url: `${P()}/experience/snapshots?surface=marketing&route=marketing&version=release-layout-mismatch&device=mobile&env=prod&release_hash=layout123&viewport_width=390&viewport_height=844&document_width=390&document_height=1500&captured_at=2026-07-26T20%3A00%3A00.000Z`,
      headers: { authorization: `Bearer ${env.secretToken}`, 'content-type': 'image/png' },
      payload: pngHeader(390, 1600),
    });
    expect(mismatchedLayout.statusCode).toBe(400);
    expect(mismatchedLayout.json().error.code).toBe('snapshot_layout_invalid');

    const oversizedImage = Buffer.alloc((5 * 1024 * 1024) + 1);
    pngHeader(390, 1600).copy(oversizedImage);
    const oversized = await env.app.inject({
      method: 'POST',
      url: `${P()}/experience/snapshots?surface=marketing&route=marketing&version=release-c&device=mobile&env=prod&release_hash=ghi789&viewport_width=390&viewport_height=844&document_width=390&document_height=1600&captured_at=2026-07-26T20%3A00%3A00.000Z`,
      headers: { authorization: `Bearer ${env.secretToken}`, 'content-type': 'image/png' },
      payload: oversizedImage,
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe('snapshot_size_invalid');
  });

  it('isolates visual aggregates by ingest environment', async () => {
    const common = {
      distinct_id: 'actor-dev',
      session_id: 'session-dev',
      route: 'marketing',
      version: 'release-a',
      device: 'desktop',
      viewport_width: 1440,
      viewport_height: 900,
      document_width: 1440,
      document_height: 3200,
    } as const;
    const captured = await api(env, env.ingestDevToken, 'POST', '/i/v1/experience/events', {
      surface: 'marketing',
      batch_id: 'visual-map-dev-batch',
      events: [{ kind: 'page_viewed', ...common, sequence: 1 }],
    });
    expect(captured).toMatchObject({ status: 200, body: { accepted: 1 } });

    const devMap = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'visual_experience',
      surface: 'marketing',
      route: 'marketing',
      version: 'release-a',
      device: 'desktop',
      date_from: '-7d',
      env: 'dev',
      grid: 8,
    });
    const prodMap = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'visual_experience',
      surface: 'marketing',
      route: 'marketing',
      version: 'release-a',
      device: 'desktop',
      date_from: '-7d',
      env: 'prod',
      grid: 8,
    });
    expect(devMap.body.summary.page_views).toBe(1);
    expect(prodMap.body.summary.page_views).toBe(2);
    expect(devMap.body.snapshot).toBeNull();
    expect(prodMap.body.snapshot).not.toBeNull();
  });

  it('keeps metadata retryable on artifact failure and includes snapshots in scope=all purge', async () => {
    const snapshots = await api(
      env,
      env.secretToken,
      'GET',
      `${P()}/experience/snapshots?env=prod`,
    );
    expect(snapshots.status).toBe(200);
    const id = snapshots.body.snapshots[0].id as string;

    await expect(deleteExperienceSnapshot(
      env.pool,
      {
        put: async () => {},
        get: async () => Buffer.alloc(0),
        delete: async () => { throw new Error('artifact store unavailable'); },
      },
      env.projectId,
      id,
    )).rejects.toThrow('artifact store unavailable');
    const retained = await env.pool.query(
      'SELECT 1 FROM experience_snapshots WHERE project_id = $1 AND id = $2',
      [env.projectId, id],
    );
    expect(retained.rowCount).toBe(1);

    const purged = await api(env, env.secretToken, 'POST', `${P()}/data/purge`, {
      env: 'prod',
      scope: 'all',
      confirm_slug: env.projectSlug,
    });
    expect(purged).toMatchObject({
      status: 200,
      body: { events_deleted: 318, snapshots_deleted: 1, env: 'prod' },
    });
    const missing = await env.app.inject({
      method: 'GET',
      url: `${P()}/experience/snapshots/${id}/image`,
      headers: { authorization: `Bearer ${env.secretToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('purges expired snapshot metadata and local artifacts together', async () => {
    const image = pngHeader(390, 1600);
    const expired = await env.app.inject({
      method: 'POST',
      url: `${P()}/experience/snapshots?surface=marketing&route=marketing&version=expired-a&device=mobile&env=prod&release_hash=old123&viewport_width=390&viewport_height=844&document_width=390&document_height=1600&captured_at=2020-01-01T00%3A00%3A00.000Z&retention_days=1`,
      headers: { authorization: `Bearer ${env.secretToken}`, 'content-type': 'image/png' },
      payload: image,
    });
    expect(expired.statusCode).toBe(201);
    const id = expired.json().id as string;

    const result = await purgeExpiredExperienceSnapshots(
      env.pool,
      new LocalArtifactStore(artifactDir),
      10,
      new Date('2026-07-27T00:00:00.000Z'),
    );
    expect(result).toEqual({ snapshotsDeleted: 1, artifactErrors: 0 });

    const missing = await env.app.inject({
      method: 'GET',
      url: `${P()}/experience/snapshots/${id}/image`,
      headers: { authorization: `Bearer ${env.secretToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});
