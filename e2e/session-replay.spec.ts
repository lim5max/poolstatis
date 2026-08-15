import { spawn, type ChildProcess } from 'node:child_process';
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
