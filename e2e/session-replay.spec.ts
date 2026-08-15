import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, chromium, type Browser } from '@playwright/test';
import setupDatabase from '../test/globalSetup.js';
import { api, createTestEnv, type TestEnv } from '../test/helpers.js';

let env: TestEnv;
let replayDir: string;
let vite: ChildProcess;
let browser: Browser;
let webUrl: string;
let releaseDatabase: void | (() => Promise<void>);

test.beforeAll(async () => {
  if (process.env.POOLSTATIS_E2E_DISPOSABLE_DB !== 'true'
      || !process.env.TEST_ADMIN_DATABASE_URL
      || !process.env.TEST_DATABASE_URL) {
    throw new Error('browser replay E2E requires explicitly marked disposable PostgreSQL URLs');
  }
  releaseDatabase = await setupDatabase();
  replayDir = await mkdtemp(join(tmpdir(), 'poolstatis-replay-browser-'));
  env = await createTestEnv({ replayDir });
  await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/experience/surfaces`, {
    key: 'workspace', name: 'Workspace', purpose: 'Reproduce consented browser failures end to end.',
  });
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const apiAddress = env.app.server.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('API server did not bind');
  const webPort = await freePort();
  webUrl = `http://127.0.0.1:${webPort}`;
  vite = spawn('pnpm', ['--dir', 'web', 'dev', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, POOLSTATIS_URL: `http://127.0.0.1:${apiAddress.port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHttp(`${webUrl}/replay-fixture.html`, vite);
  browser = await chromium.launch();
});

test.afterAll(async () => {
  await browser?.close();
  if (vite && !vite.killed) {
    vite.kill('SIGTERM');
    await new Promise<void>((resolveExit) => vite.once('exit', () => resolveExit()));
  }
  await env?.close();
  if (replayDir) await rm(replayDir, { recursive: true, force: true });
  if (releaseDatabase) await releaseDatabase();
});

for (const device of [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
] as const) {
  test(`records and actually replays DOM, click, scroll and cursor on ${device.name}`, async () => {
    const context = await browser.newContext({ viewport: device.viewport });
    await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
      status: 200, contentType: 'text/css', body: '',
    }));
    const unexpectedNetwork: string[] = [];
    const expectedOrigin = new URL(webUrl).origin;
    context.on('request', (request) => {
      const url = new URL(request.url());
      if ((url.protocol === 'http:' || url.protocol === 'https:')
          && url.origin !== expectedOrigin
          && url.hostname !== 'fonts.googleapis.com') {
        unexpectedNetwork.push(request.url());
      }
    });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      const expectedSandboxBlock = message.text().startsWith('Blocked script execution in ')
        && message.text().includes("the 'allow-scripts' permission is not set");
      if (message.type() === 'error' && !message.location().url.includes('/@vite/client') && !expectedSandboxBlock) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    await page.goto(`${webUrl}/replay-fixture.html`);
    await page.evaluate(({ ingestToken, adminToken, projectSlug }) => {
      localStorage.setItem('poolstatis.replay.e2e-key', ingestToken);
      localStorage.setItem('poolstatis.conn', JSON.stringify({ baseUrl: '', token: adminToken }));
      localStorage.setItem('poolstatis.project', projectSlug);
      localStorage.setItem(`poolstatis.env.${projectSlug}`, 'prod');
    }, { ingestToken: env.ingestToken, adminToken: env.personalToken, projectSlug: env.projectSlug });
    await page.getByRole('button', { name: 'Start consented recording' }).click();
    await expect(page.locator('#status')).toHaveText(/recording:/);
    await page.locator('#password').fill('4111 1111 1111 1111');
    await page.locator('#account-name').fill('Alice alice@example.test');
    await page.locator('#account-name').dispatchEvent('change');
    await page.locator('#editable').fill('alice@example.test secret editable value');
    await page.mouse.move(40, 260);
    await page.mouse.move(device.viewport.width - 40, 420, { steps: 8 });
    await page.getByRole('button', { name: 'Apply DOM change' }).click();
    await page.locator('#scroller').evaluate((element) => {
      element.scrollTop = 600;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Stop and complete' }).click();
    await expect(page.locator('#status')).toHaveText(/complete:/);
    const replayId = (await page.locator('#status').textContent())!.replace('complete:', '');

    const response = await page.request.get(
      `${webUrl}/api/v1/projects/${env.projectSlug}/replays/${replayId}/events?env=prod`,
      { headers: { authorization: `Bearer ${env.secretToken}` } },
    );
    expect(response.status()).toBe(200);
    const payload = await response.json() as { events: Array<{ type: number; data?: { source?: number } }> };
    const sources = payload.events.filter((event) => event.type === 3).map((event) => event.data?.source);
    expect(sources).toEqual(expect.arrayContaining([0, 1, 2, 3, 5]));
    expect(payload.events.some((event) => event.type === 4)).toBe(true);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('alice@example.test');
    expect(serialized).not.toContain('4111 1111 1111 1111');
    expect(serialized).not.toContain('secret-token-value');
    expect(serialized).not.toMatch(/"tagName":"(?:script|iframe|object|embed|form|base|meta)"/i);

    await page.goto(`${webUrl}/experience?replay=${replayId}`);
    await expect(page.getByText('Session replays', { exact: true })).toBeVisible();
    const frameElement = page.locator(`iframe[title="Session replay content ${replayId}"]`);
    await expect(frameElement).toHaveAttribute('sandbox', 'allow-same-origin');
    await expect(frameElement).not.toHaveAttribute('sandbox', /allow-scripts/);
    await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled();
    const replayDocument = page.frameLocator(`iframe[title="Session replay content ${replayId}"]`);
    await expect.poll(() => replayDocument.locator('aside').evaluate((element) => (
      element.scrollHeight > element.clientHeight
    ))).toBe(true);
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(replayDocument.locator('output')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('.replayer-mouse')).toBeVisible();
    await expect.poll(() => replayDocument.locator('aside').evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(browserErrors).toEqual([]);
    expect(unexpectedNetwork).toEqual([]);
    await context.close();
  });
}

test('does not let malicious visible style replay escape over the network', async () => {
  const policy = { version: 'browser-e2e-visible-v1', text: 'visible' as const, maskSelectors: [], blockSelectors: [] };
  const created = await api(env, env.ingestToken, 'POST', '/i/v1/replays', {
    surface: 'workspace', route: 'workspace', session_id: `malicious-style-${Date.now()}`,
    distinct_id: 'browser-e2e-adversary', host: '127.0.0.1', version: 'browser-e2e-v1', device: 'desktop',
    consent_version: 'browser-e2e-consent-v1', policy,
    policy_hash: createHash('sha256').update(JSON.stringify(policy)).digest('hex'), retention_days: 1,
  });
  expect(created.status).toBe(201);
  const replayId = created.body.replay.id as string;
  const uploadToken = created.body.upload_token as string;
  const timestamp = Date.now();
  const events = [{
    type: 4,
    timestamp,
    data: { href: 'https://app.example.test/private?token=secret#account', width: 1280, height: 800 },
  }, {
    type: 2,
    timestamp: timestamp + 1,
    data: {
      node: {
        type: 0, id: 1, childNodes: [{
          type: 1, id: 2, name: 'html', publicId: '', systemId: '',
        }, {
          type: 2, id: 3, tagName: 'html', attributes: {}, childNodes: [{
            type: 2, id: 4, tagName: 'head', attributes: {}, childNodes: [{
              type: 2, id: 5, tagName: 'style', attributes: {}, childNodes: [{
                type: 3,
                id: 6,
                isStyle: true,
                textContent: '@import "//replay-escape.invalid/private.css"; body { height:48rem; overflow:auto; background-image:url(https://replay-escape.invalid/pixel); content:"alice@example.test" }',
              }],
            }],
          }, {
            type: 2, id: 7, tagName: 'body', attributes: {}, childNodes: [{
              type: 2, id: 8, tagName: 'main', attributes: {}, childNodes: [{
                type: 3, id: 9, textContent: 'Visible safe replay content',
              }],
            }],
          }],
        }],
      },
      initialOffset: { top: 0, left: 0 },
    },
  }];
  expect((await api(env, env.ingestToken, 'PUT', `/i/v1/replays/${replayId}/chunks`, {
    upload_token: uploadToken,
    sequence: 0,
    checksum: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
    events,
  })).status).toBe(201);
  expect((await api(env, env.ingestToken, 'POST', `/i/v1/replays/${replayId}/complete`, {
    upload_token: uploadToken, last_sequence: 0,
  })).body.status).toBe('playable');

  const stored = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/replays/${replayId}/events?env=prod`);
  expect(JSON.stringify(stored.body)).not.toContain('replay-escape.invalid');
  expect(JSON.stringify(stored.body)).toContain('height:48rem;overflow:auto');

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const escaped: string[] = [];
  await context.route('https://replay-escape.invalid/**', (route) => {
    escaped.push(route.request().url());
    return route.fulfill({ status: 204, body: '' });
  });
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
    status: 200, contentType: 'text/css', body: '',
  }));
  const page = await context.newPage();
  await page.goto(`${webUrl}/replay-fixture.html`);
  await page.evaluate(({ adminToken, projectSlug }) => {
    localStorage.setItem('poolstatis.conn', JSON.stringify({ baseUrl: '', token: adminToken }));
    localStorage.setItem('poolstatis.project', projectSlug);
    localStorage.setItem(`poolstatis.env.${projectSlug}`, 'prod');
  }, { adminToken: env.personalToken, projectSlug: env.projectSlug });
  await page.goto(`${webUrl}/experience?replay=${replayId}&env=prod`);
  await expect(page.locator(`iframe[title="Session replay content ${replayId}"]`)).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled();
  await page.waitForTimeout(500);
  expect(escaped).toEqual([]);
  await context.close();
});

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('free port unavailable'));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForHttp(url: string, process: ChildProcess): Promise<void> {
  const errors: Buffer[] = [];
  process.stderr?.on('data', (chunk) => errors.push(Buffer.from(chunk)));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Vite exited early: ${Buffer.concat(errors).toString('utf8')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Vite did not become ready: ${Buffer.concat(errors).toString('utf8')}`);
}
