import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import setupDatabase from '../test/globalSetup.js';
import { analysisViewInput } from '../test/analysis-view-fixtures.js';
import { activeMetric, api, createTestEnv, hoursAgo, type TestEnv } from '../test/helpers.js';

let env: TestEnv;
let vite: ChildProcess;
let browser: Browser;
let webUrl: string;
let releaseDatabase: void | (() => Promise<void>);
const screenshotDir = process.env.POOLSTATIS_E2E_SCREENSHOT_DIR;

test.beforeAll(async () => {
  if (process.env.POOLSTATIS_E2E_DISPOSABLE_DB !== 'true'
      || !process.env.TEST_ADMIN_DATABASE_URL
      || !process.env.TEST_DATABASE_URL) {
    throw new Error('analytics UI E2E requires explicitly marked disposable PostgreSQL URLs');
  }

  releaseDatabase = await setupDatabase();
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  await seedAnalyticsWorkspace(env);
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
  await waitForHttp(webUrl, vite);
  browser = await chromium.launch();
});

test.afterAll(async () => {
  await browser?.close();
  if (vite && !vite.killed) {
    vite.kill('SIGTERM');
    await new Promise<void>((resolveExit) => vite.once('exit', () => resolveExit()));
  }
  await env?.close();
  if (releaseDatabase) await releaseDatabase();
});

const routes = [
  { path: '/', heading: 'Home', period: true },
  { path: '/analyze/web', heading: 'Web', period: true },
  { path: '/analyze/product', heading: 'Product', period: true },
  { path: '/analyze/funnels', heading: 'Funnels', period: true },
  { path: '/analyze/users', heading: 'People', period: true },
  { path: '/analyze/saved', heading: 'Saved answers', period: false },
  { path: '/changes', heading: 'Ship', period: false },
  { path: '/usage', heading: 'Usage', period: false },
  { path: '/setup', heading: 'Setup', period: false },
] as const;

for (const device of [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
] as const) {
  test(`keeps the complete analytics workspace clear and usable on ${device.name}`, async () => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: device.viewport });
    await context.addInitScript(({ adminToken, projectSlug }) => {
      localStorage.setItem('poolstatis.conn', JSON.stringify({ baseUrl: '', token: adminToken }));
      localStorage.setItem('poolstatis.project', projectSlug);
      localStorage.setItem(`poolstatis.env.${projectSlug}`, 'prod');
    }, { adminToken: env.personalToken, projectSlug: env.projectSlug });
    const page = await context.newPage();
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.location().url.includes('/@vite/client')) {
        browserErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    for (const route of routes) {
      await page.goto(`${webUrl}${route.path}`);
      await expect(page.getByRole('heading', { level: 1, name: route.heading, exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: 'Run answer', exact: true })).toHaveCount(0);
      if (route.period) {
        const period = page.getByRole('group', { name: 'Analytics period' });
        await expect(period).toBeVisible();
        await expect(period.getByRole('button', { name: /^Period:/ })).toBeVisible();
      }
      if (route.path === '/analyze/product') {
        await page.getByRole('button', { name: /^Period:/ }).click();
        await page.getByRole('menuitem', { name: 'Custom period…', exact: true }).click();
        const dateInputs = page.locator('input[type="date"]');
        await dateInputs.nth(0).fill('2026-08-01');
        await dateInputs.nth(1).fill('2026-08-14');
        await page.getByRole('button', { name: 'Apply period', exact: true }).click();
        await expect(page).toHaveURL(/range=custom&from=2026-08-01&to=2026-08-14/);
        await expect(page.getByRole('button', { name: /Period: Aug 1.*14, 2026/ })).toBeVisible();
        if (device.name === 'mobile') {
          await page.getByRole('button', { name: 'Open navigation' }).click();
          const navigation = page.getByRole('dialog', { name: 'Navigation' });
          await expect(navigation).toHaveCSS('width', `${device.viewport.width}px`);
          await expect(navigation).toHaveCSS('height', `${device.viewport.height}px`);
          await expect(navigation).toHaveCSS('background-color', 'rgb(240, 243, 239)');
          await expect.poll(() => navigation.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
          })).toEqual({ left: 0, top: 0, right: device.viewport.width, bottom: device.viewport.height });
          if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'mobile-navigation.png'), fullPage: false });
        }
        await expect(page.getByRole('link', { name: 'People', exact: true })).toHaveAttribute(
          'href',
          '/analyze/users?range=custom&from=2026-08-01&to=2026-08-14',
        );
        if (device.name === 'mobile') {
          await page.getByRole('button', { name: 'Close navigation' }).click();
          await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
        }
      }
      await assertNoPageOverflow(page, route.path);
      await assertReadableType(page, route.path);
      await assertCompactControlRadii(page, route.path);
      await assertCompactCardRadii(page, route.path);
      if (screenshotDir) {
        const slug = route.path === '/' ? 'home' : route.path.replace(/^\//, '').replaceAll('/', '-');
        await page.screenshot({ path: join(screenshotDir, `${device.name}-${slug}.png`), fullPage: true });
      }
    }

    expect(browserErrors).toEqual([]);
    await context.close();
  });
}

async function seedAnalyticsWorkspace(target: TestEnv): Promise<void> {
  const project = `/api/v1/projects/${target.projectSlug}`;
  const browserSetup = await api(target, target.secretToken, 'POST', `${project}/properties/browser-analytics`, {
    route_keys: ['home', 'pricing', 'signup'],
  });
  if (browserSetup.status !== 200) throw new Error(`browser setup failed: ${JSON.stringify(browserSetup.body)}`);
  for (const metric of browserSetup.body.metrics as Array<{ key: string }>) {
    const activated = await api(target, target.secretToken, 'PATCH', `${project}/metrics/${metric.key}`, { status: 'active' });
    if (activated.status !== 200) throw new Error(`browser metric activation failed: ${JSON.stringify(activated.body)}`);
  }
  const routeTrust = await api(target, target.secretToken, 'PATCH', `${project}/properties/event/%24route_key`, { status: 'trusted' });
  if (routeTrust.status !== 200) throw new Error(`route property trust failed: ${JSON.stringify(routeTrust.body)}`);

  await activeMetric(target, {
    key: 'activation_started',
    type: 'unique_actors',
    source: { event: 'activation.started' },
    purpose: 'Counts people who begin the primary product activation journey.',
  });
  await activeMetric(target, {
    key: 'activation_completed',
    type: 'unique_actors',
    source: { event: 'activation.completed' },
    purpose: 'Counts people who reach the first meaningful product outcome.',
  });
  const funnel = await api(target, target.secretToken, 'POST', `${project}/funnels`, {
    key: 'activation_funnel',
    name: 'Activation funnel',
    goal: 'Measure how many people reach the first meaningful product outcome.',
    steps: [
      { metric_key: 'activation_started', label: 'Started activation' },
      { metric_key: 'activation_completed', label: 'Completed activation' },
    ],
    window_seconds: 86_400,
  });
  if (funnel.status !== 201) throw new Error(`funnel setup failed: ${JSON.stringify(funnel.body)}`);

  const events: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 12; index += 1) {
    const actor = `visitor-${index + 1}`;
    const session = `session-${index + 1}`;
    const timestamp = hoursAgo(index + 1);
    events.push({
      event: 'page.viewed',
      distinct_id: actor,
      session_id: session,
      timestamp,
      properties: {
        $browser_context: '1',
        $route_key: index % 3 === 0 ? 'pricing' : 'home',
        $page_view_id: `page-${index + 1}`,
        $device_class: index % 2 === 0 ? 'desktop' : 'mobile',
        $browser_family: 'chrome',
        $os_family: index % 2 === 0 ? 'macos' : 'ios',
        $language: 'en',
        $viewport_bucket: index % 2 === 0 ? 'xl' : 'sm',
      },
    });
    events.push({ event: 'activation.started', distinct_id: actor, session_id: session, timestamp });
    if (index < 8) {
      events.push({
        event: 'activation.completed',
        distinct_id: actor,
        session_id: session,
        timestamp: new Date(Date.parse(timestamp) + 60_000).toISOString(),
      });
    }
  }
  const ingested = await api(target, target.ingestToken, 'POST', '/i/v1/events', {
    batch_id: `analytics-ui-${Date.now()}`,
    events,
  });
  if (ingested.status !== 200 || ingested.body.accepted !== events.length) {
    throw new Error(`analytics seed failed: ${JSON.stringify(ingested.body)}`);
  }

  const saved = await api(
    target,
    target.secretToken,
    'POST',
    `${project}/analysis-views`,
    analysisViewInput(target.projectSlug),
  );
  if (saved.status !== 201) throw new Error(`saved answer setup failed: ${JSON.stringify(saved.body)}`);
}

async function assertNoPageOverflow(page: Page, route: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions, `${route} must not overflow the viewport`).toEqual({
    viewport: dimensions.viewport,
    document: dimensions.viewport,
    body: dimensions.viewport,
  });
}

async function assertReadableType(page: Page, route: string): Promise<void> {
  const offenders = await page.locator('main').evaluate((root) => (
    Array.from(root.querySelectorAll<HTMLElement>('*')).flatMap((element) => {
      const directText = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? '')
        .join(' ')
        .trim();
      if (!directText) return [];
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
          || rect.width <= 2 || rect.height <= 2) return [];
      const fontSize = Number.parseFloat(style.fontSize);
      return fontSize < 15 ? [{ text: directText.slice(0, 80), fontSize, tag: element.tagName }] : [];
    })
  ));
  expect(offenders, `${route} contains text smaller than 15px`).toEqual([]);
}

async function assertCompactControlRadii(page: Page, route: string): Promise<void> {
  const offenders = await page.locator('button:visible').evaluateAll((buttons) => (
    buttons.flatMap((button) => {
      const rect = button.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) return [];
      const text = button.textContent?.trim() ?? '';
      const iconOnly = text.length === 0 && Math.abs(rect.width - rect.height) <= 4;
      if (iconOnly) return [];
      const radius = Number.parseFloat(getComputedStyle(button).borderTopLeftRadius);
      return radius > 12
        ? [{ label: button.getAttribute('aria-label') ?? text.slice(0, 80), radius }]
        : [];
    })
  ));
  expect(offenders, `${route} contains an excessively rounded text button`).toEqual([]);
}

async function assertCompactCardRadii(page: Page, route: string): Promise<void> {
  const offenders = await page.locator('[data-slot="card"]:visible').evaluateAll((cards) => (
    cards.flatMap((card) => {
      const radius = Number.parseFloat(getComputedStyle(card).borderTopLeftRadius);
      return radius > 16 ? [{ text: card.textContent?.trim().slice(0, 80), radius }] : [];
    })
  ));
  expect(offenders, `${route} contains a card with excessive rounding`).toEqual([]);
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
