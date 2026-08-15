import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalReplayObjectStore, ReplayObjectConflictError } from '../src/replay/objectStore.js';
import { sanitizeReplayEvents } from '../src/replay/sanitize.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('session replay privacy boundary', () => {
  it('masks text and human-readable attributes while removing executable/network DOM', () => {
    const payload = sanitizeReplayEvents([{
      type: 2,
      timestamp: 100,
      data: {
        node: {
          type: 0,
          childNodes: [{
            type: 2,
            tagName: 'main',
            attributes: {
              id: 'user-alice@example.com',
              class: 'account-secret-token',
              role: 'main',
              'aria-label': 'Alice alice@example.com',
              title: 'Bearer abcdefghijklmnopqrstuvwxyz',
              alt: '4111 1111 1111 1111',
              placeholder: 'Alice Smith',
              'data-user-email': 'alice@example.com',
              style: 'color:red;content:"alice@example.com";background-image:url(https://evil.test/x)',
              onclick: 'top.location="https://evil.test"',
              src: 'https://evil.test/pixel',
            },
            childNodes: [
              { type: 3, textContent: 'Alice private dashboard', id: 3 },
              { type: 2, tagName: 'script', attributes: {}, childNodes: [{ type: 3, textContent: 'window.pwned=true' }] },
            ],
          }],
        },
      },
    }], { route: 'account', textMode: 'masked' });

    const serialized = JSON.stringify(payload.events);
    for (const forbidden of [
      'alice@example.com', 'Alice Smith', '4111 1111 1111 1111',
      'window.pwned', 'evil.test', 'onclick', 'data-user-email', 'user-alice',
    ]) expect(serialized).not.toContain(forbidden);
    expect(serialized).toContain('"tagName":"div"');
    expect(serialized).toContain('"role":"main"');
  });

  it('rejects backward timestamps inside a chunk', () => {
    expect(() => sanitizeReplayEvents([
      { type: 4, timestamp: 200, data: { href: 'https://example.test/?token=x', width: 100, height: 100 } },
      { type: 2, timestamp: 100, data: { node: { type: 0, childNodes: [] } } },
    ], { route: 'home', textMode: 'masked' })).toThrow('timestamps');
  });

  it('preserves safe layout CSS with matching private selectors and is idempotent', () => {
    const original = [{
      type: 2,
      timestamp: 100,
      data: { node: { type: 0, childNodes: [{
        type: 2,
        tagName: 'main',
        attributes: { id: 'alice-private-panel', class: 'scroll-content' },
        childNodes: [{
          type: 2,
          tagName: 'link',
          attributes: {
            rel: 'stylesheet',
            href: 'https://evil.test/private.css?token=secret',
            _cssText: '@import "https://evil.test/x"; #alice-private-panel .scroll-content { height: 48rem; overflow-y: auto; background-image: url(https://evil.test/pixel); content: "alice@example.test"; --private-size: 12rem; width: var(--private-size) }',
          },
          childNodes: [],
        }],
      }] } },
    }];
    const once = sanitizeReplayEvents(original, { route: 'workspace', textMode: 'masked' });
    const twice = sanitizeReplayEvents(once.events, { route: 'workspace', textMode: 'masked' });
    expect(twice.events).toEqual(once.events);
    const serialized = JSON.stringify(once.events);
    const id = serialized.match(/"id":"(rr-[0-9a-f]{8})"/)?.[1];
    const className = serialized.match(/"class":"(rr-[0-9a-f]{8})"/)?.[1];
    expect(id).toBeTruthy();
    expect(className).toBeTruthy();
    expect(serialized).toContain(`#${id} .${className}{height:48rem;overflow-y:auto;--rr-`);
    expect(serialized).toContain('width:var(--rr-');
    for (const forbidden of ['alice-private-panel', 'scroll-content', 'alice@example.test', 'evil.test', 'background-image', 'content:']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('atomically accepts an identical orphan object and rejects different bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poolstatis-replay-store-'));
    roots.push(root);
    const store = new LocalReplayObjectStore(root);
    const key = '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/0.json';
    expect(await store.put(key, Buffer.from('safe'))).toBe('created');
    expect(await store.put(key, Buffer.from('safe'))).toBe('existing');
    await expect(store.put(key, Buffer.from('different'))).rejects.toBeInstanceOf(ReplayObjectConflictError);
    await expect(store.put('../escape', Buffer.from('x'))).rejects.toThrow('invalid replay object key');
  });
});
