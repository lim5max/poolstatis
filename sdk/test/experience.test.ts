import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserExperience } from '../src/experience.js';
import { ExperienceCaptureError } from '../src/index.js';

type Listener = (event: any) => void;

class FakeWindow {
  location = { pathname: '/checkout' };
  innerWidth = 1000;
  innerHeight = 500;
  scrollY = 0;
  document = { documentElement: { scrollHeight: 1500 } };
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BrowserExperience', () => {
  it('starts immediately when no host pause callback is provided', async () => {
    const browser = new FakeWindow();
    const batches: Array<{ events: Array<Record<string, unknown>> }> = [];
    const experience = new BrowserExperience({
      client: { captureExperience: async (batch) => { batches.push(batch); } },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', browser,
      sessionId: 'session-immediate',
    });

    await experience.start();

    expect(batches.flatMap((batch) => batch.events)).toEqual([
      expect.objectContaining({ kind: 'page_viewed', session_id: 'session-immediate' }),
    ]);
    expect(browser.listenerCount('click')).toBe(1);
  });

  it('does nothing until consent is granted', async () => {
    const browser = new FakeWindow();
    const batches: unknown[] = [];
    const experience = new BrowserExperience({
      client: { captureExperience: async (batch) => { batches.push(batch); } },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => false, browser,
    });

    await experience.start();
    browser.dispatch('click', { target: { closest: () => ({ getAttribute: () => 'pay_now' }) }, clientX: 250, clientY: 250 });
    await experience.flush();

    expect(batches).toEqual([]);
    expect(browser.listenerCount('click')).toBe(0);
  });

  it('captures a labelled, privacy-safe session timeline and detaches cleanly', async () => {
    const browser = new FakeWindow();
    browser.location.pathname = '/reset/private-token';
    const batches: Array<{ surface: string; events: Array<Record<string, unknown>> }> = [];
    const experience = new BrowserExperience({
      client: { captureExperience: async (batch) => { batches.push(batch); } },
      surface: 'checkout', distinctId: () => 'actor-1', route: () => 'checkout', hasConsent: () => true, browser,
      sessionId: 'session-1',
    });

    await experience.start();
    browser.dispatch('click', { target: { closest: () => ({ getAttribute: () => 'pay_now' }) }, clientX: 250, clientY: 250 });
    browser.dispatch('click', { target: { closest: () => null }, clientX: 500, clientY: 200 });
    browser.scrollY = 750;
    browser.dispatch('scroll');
    browser.dispatch('error', { message: 'do not send this' });
    await experience.flush();

    expect(batches.every((batch) => batch.surface === 'checkout')).toBe(true);
    expect(batches.flatMap((batch) => batch.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'page_viewed', route: 'checkout', session_id: 'session-1', sequence: 1 }),
      expect.objectContaining({
        kind: 'element_clicked', label: 'pay_now', x: 0.25, y: 0.1667,
        viewport_x: 0.25, viewport_y: 0.5, sequence: 2,
      }),
      expect.objectContaining({ kind: 'scroll_depth', depth: 25, sequence: 3 }),
      expect.objectContaining({ kind: 'scroll_depth', depth: 50, sequence: 4 }),
      expect.objectContaining({ kind: 'scroll_depth', depth: 75, sequence: 5 }),
      expect.objectContaining({ kind: 'client_error', error_type: 'error', sequence: 6 }),
    ]));
    expect(JSON.stringify(batches)).not.toContain('do not send this');
    expect(JSON.stringify(batches)).not.toContain('private-token');

    experience.stop();
    browser.dispatch('click', { target: { closest: () => ({ getAttribute: () => 'pay_now' }) }, clientX: 250, clientY: 250 });
    await experience.flush();
    const captured = batches.flatMap((batch) => batch.events).length;
    expect(batches.flatMap((batch) => batch.events)).toHaveLength(6);
    expect(captured).toBe(6);
    expect(browser.listenerCount('click')).toBe(0);
  });

  it('uses the canonical Poolstatis label attribute and keeps the legacy attribute compatible', async () => {
    const browser = new FakeWindow();
    const batches: Array<{ events: Array<Record<string, unknown>> }> = [];
    const experience = new BrowserExperience({
      client: { captureExperience: async (batch) => { batches.push(batch); } },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => true, browser,
      sessionId: 'session-1',
    });

    await experience.start();
    browser.dispatch('click', {
      target: {
        closest: (selector: string) => selector === '[data-poolstatis-label], [data-poolsatis-label]'
          ? { getAttribute: (name: string) => name === 'data-poolstatis-label' ? 'pay_now' : null }
          : null,
      },
      clientX: 250,
      clientY: 250,
    });
    browser.dispatch('click', {
      target: {
        closest: (selector: string) => selector === '[data-poolstatis-label], [data-poolsatis-label]'
          ? { getAttribute: (name: string) => name === 'data-poolsatis-label' ? 'legacy_pay_now' : null }
          : null,
      },
      clientX: 250,
      clientY: 250,
    });
    await experience.flush();

    expect(batches.flatMap((batch) => batch.events)
      .filter((event) => event.kind === 'element_clicked')
      .map((event) => event.label)).toEqual(['pay_now', 'legacy_pay_now']);
  });

  it('captures named visible sections without reading DOM text', async () => {
    const browser = new FakeWindow();
    (browser.document as any).querySelectorAll = (selector: string) => {
      expect(selector).toBe('[data-poolstatis-section]');
      return [{
        textContent: 'Private page copy must never leave the browser',
        getAttribute: (name: string) => name === 'data-poolstatis-section' ? 'pricing' : null,
        getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
      }];
    };
    const batches: Array<{ events: Array<Record<string, unknown>> }> = [];
    const experience = new BrowserExperience({
      client: { captureExperience: async (batch) => { batches.push(batch); } },
      surface: 'marketing',
      distinctId: 'actor-1',
      route: 'home',
      version: 'release-a',
      hasConsent: () => true,
      browser,
      sessionId: 'session-1',
    });

    await experience.start();
    await experience.flush();

    expect(batches.flatMap((batch) => batch.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'section_exposed',
        section: 'pricing',
        top: 0.0667,
        version: 'release-a',
        device: 'desktop',
      }),
    ]));
    expect(JSON.stringify(batches)).not.toContain('Private page copy');
  });

  it('bounds accepted capture signals per minute', async () => {
    const browser = new FakeWindow();
    const batches: Array<{ events: Array<Record<string, unknown>> }> = [];
    const experience = new BrowserExperience({
      client: { captureExperience: async (batch) => { batches.push(batch); } },
      surface: 'checkout',
      distinctId: 'actor-1',
      route: 'checkout',
      hasConsent: () => true,
      browser,
      sessionId: 'session-1',
      maxEventsPerMinute: 2,
    });

    await experience.start();
    for (let index = 0; index < 5; index += 1) {
      browser.dispatch('click', {
        target: { closest: () => ({ getAttribute: () => 'pay_now' }) },
        clientX: 10,
        clientY: 10,
      });
    }
    await experience.flush();

    expect(batches.flatMap((batch) => batch.events)).toHaveLength(2);
  });

  it('calls native-style Element.closest with the element as this', async () => {
    const browser = new FakeWindow();
    const batches: Array<{ events: Array<Record<string, unknown>> }> = [];
    const experience = new BrowserExperience({
      client: { captureExperience: async (batch) => { batches.push(batch); } },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => true, browser,
      sessionId: 'session-1',
    });
    const target = {
      closest(this: unknown) {
        if (this !== target) throw new TypeError('Illegal invocation');
        return { getAttribute: (name: string) => name === 'data-poolstatis-label' ? 'pay_now' : null };
      },
    };

    await experience.start();
    browser.dispatch('click', { target, clientX: 250, clientY: 250 });
    await experience.flush();

    expect(batches.flatMap((batch) => batch.events)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'element_clicked', label: 'pay_now' }),
    ]));
  });

  it('keeps the nearest labelled element when canonical and legacy attributes are nested', async () => {
    const browser = new FakeWindow();
    const batches: Array<{ events: Array<Record<string, unknown>> }> = [];
    const experience = new BrowserExperience({
      client: { captureExperience: async (batch) => { batches.push(batch); } },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => true, browser,
      sessionId: 'session-1',
    });

    await experience.start();
    browser.dispatch('click', {
      target: {
        closest: (selector: string) => {
          if (selector === '[data-poolstatis-label]') {
            return { getAttribute: (name: string) => name === 'data-poolstatis-label' ? 'parent_canonical' : null };
          }
          if (selector === '[data-poolsatis-label]') {
            return { getAttribute: (name: string) => name === 'data-poolsatis-label' ? 'nearest_legacy' : null };
          }
          return { getAttribute: (name: string) => name === 'data-poolsatis-label' ? 'nearest_legacy' : null };
        },
      },
      clientX: 250,
      clientY: 250,
    });
    await experience.flush();

    expect(batches.flatMap((batch) => batch.events)
      .filter((event) => event.kind === 'element_clicked')
      .map((event) => event.label)).toEqual(['nearest_legacy']);
  });

  it('does not retain a permanently rejected capture batch in memory', async () => {
    const browser = new FakeWindow();
    let consent = false;
    let calls = 0;
    const experience = new BrowserExperience({
      client: { captureExperience: async () => { calls += 1; throw new Error('surface archived'); } },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => consent, browser,
    });

    await experience.start();
    consent = true;
    await expect(experience.start()).resolves.toBeUndefined();
    await expect(experience.flush()).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('chunks a busy interaction burst into keepalive-safe idempotent batches', async () => {
    const browser = new FakeWindow();
    const batches: Array<{ batch_id: string; events: Array<Record<string, unknown>> }> = [];
    const experience = new BrowserExperience({
      client: { captureExperience: async (batch) => { batches.push(batch); } },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => true, browser,
      sessionId: 'session-1', maxQueue: 200,
    });
    await experience.start();
    for (let index = 0; index < 101; index += 1) {
      browser.dispatch('click', { target: { closest: () => ({ getAttribute: () => 'pay_now' }) }, clientX: index, clientY: 1 });
    }
    await experience.flush();

    expect(batches.flatMap((batch) => batch.events)).toHaveLength(102);
    expect(batches.every((batch) => batch.events.length <= 25)).toBe(true);
    expect(new Set(batches.map((batch) => batch.batch_id)).size).toBe(batches.length);
  });

  it('resends navigation-time clicks with keepalive on pagehide', async () => {
    const browser = new FakeWindow();
    const sends: Array<{ keepalive: boolean; kinds: string[] }> = [];
    const experience = new BrowserExperience({
      client: {
        captureExperience: async (batch, options?: { keepalive?: boolean }) => {
          sends.push({
            keepalive: options?.keepalive === true,
            kinds: batch.events.map((event) => event.kind),
          });
        },
      },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => true, browser,
      sessionId: 'session-1',
    });
    await experience.start();
    sends.splice(0);

    browser.dispatch('click', {
      target: { closest: () => ({ getAttribute: () => 'leave_checkout' }) },
      clientX: 500,
      clientY: 250,
    });
    browser.dispatch('pagehide');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sends).toContainEqual({ keepalive: true, kinds: ['element_clicked'] });
  });

  it('limits pagehide to one keepalive batch when a large queue is pending', async () => {
    const browser = new FakeWindow();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blockRegular = false;
    const keepaliveSizes: number[] = [];
    const experience = new BrowserExperience({
      client: {
        captureExperience: async (batch, options) => {
          if (options?.keepalive) keepaliveSizes.push(batch.events.length);
          else if (blockRegular) await gate;
        },
      },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => true, browser,
      sessionId: 'session-1', maxQueue: 300,
    });
    await experience.start();
    blockRegular = true;
    browser.dispatch('click', { target: { closest: () => ({ getAttribute: () => 'leave_checkout' }) }, clientX: 1, clientY: 1 });
    await Promise.resolve();
    for (let index = 0; index < 120; index += 1) {
      browser.dispatch('click', { target: { closest: () => ({ getAttribute: () => 'queued_click' }) }, clientX: index, clientY: 1 });
    }

    browser.dispatch('pagehide');
    await Promise.resolve();

    expect(keepaliveSizes).toHaveLength(1);
    expect(keepaliveSizes[0]).toBeLessThanOrEqual(25);
    release();
    await experience.flush();
  });

  it('stops scheduled retry traffic until an explicit flush', async () => {
    vi.useFakeTimers();
    const browser = new FakeWindow();
    let calls = 0;
    const experience = new BrowserExperience({
      client: {
        captureExperience: async () => {
          calls += 1;
          throw new ExperienceCaptureError('temporary outage', true);
        },
      },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => true, browser,
      sessionId: 'session-1',
    });

    await experience.start();
    expect(calls).toBe(1);
    experience.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);

    await experience.flush();
    expect(calls).toBe(2);
  });

  it('stops an active automatic drain before it takes the next batch', async () => {
    const browser = new FakeWindow();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let block = false;
    let calls = 0;
    const experience = new BrowserExperience({
      client: {
        captureExperience: async () => {
          calls += 1;
          if (block && calls === 2) await gate;
        },
      },
      surface: 'checkout', distinctId: 'actor-1', route: 'checkout', hasConsent: () => true, browser,
      sessionId: 'session-1', maxQueue: 100,
    });
    await experience.start();
    block = true;
    for (let index = 0; index < 30; index += 1) {
      browser.dispatch('click', { target: { closest: () => ({ getAttribute: () => 'queued_click' }) }, clientX: index, clientY: 1 });
    }
    await Promise.resolve();
    experience.stop();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);

    await experience.flush();
    expect(calls).toBe(3);
  });
});
