import { describe, expect, it } from 'vitest';
import { BrowserExperience } from '../src/experience.js';

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

describe('BrowserExperience', () => {
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
      expect.objectContaining({ kind: 'element_clicked', label: 'pay_now', x: 0.25, y: 0.5, sequence: 2 }),
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

  it('chunks a busy interaction burst into idempotent batches no larger than one hundred events', async () => {
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
    expect(batches.every((batch) => batch.events.length <= 100)).toBe(true);
    expect(new Set(batches.map((batch) => batch.batch_id)).size).toBe(batches.length);
  });
});
