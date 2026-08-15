import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalReplayObjectStore,
  ReplayObjectConflictError,
  ReplayObjectTooLargeError,
} from '../src/replay/objectStore.js';
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
              disabled: 'alice@example.com',
              width: 'alice@example.com',
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

  it('masks non-allowlisted rrweb string fields by default', () => {
    const payload = sanitizeReplayEvents([{
      type: 3,
      timestamp: 101,
      data: {
        source: 0,
        arbitraryFutureField: 'Alice Smith private workspace',
        nested: { vendorPayload: 'customer-4111 1111 1111 1111' },
      },
    }], { route: 'account', textMode: 'masked' });

    const serialized = JSON.stringify(payload.events);
    expect(serialized).not.toContain('Alice Smith');
    expect(serialized).not.toContain('private workspace');
    expect(serialized).not.toContain('customer-');
    expect(serialized).toContain('••••');
  });

  it('sanitizes style-node text and input-like data even when visible text is allowed', () => {
    const payload = sanitizeReplayEvents([{
      type: 2,
      timestamp: 200,
      data: { node: { type: 0, childNodes: [{
        type: 2,
        tagName: 'body',
        attributes: {},
        childNodes: [
          {
            type: 2,
            tagName: 'style',
            attributes: {},
            childNodes: [{
              type: 3,
              textContent: '@import "//evil.test/private.css"; .private-panel { height:48rem; overflow-y:auto; background-image:url(https://evil.test/pixel); content:"alice@example.test" }',
            }],
          },
          {
            type: 2,
            tagName: 'div',
            attributes: { CONTENTEDITABLE: true },
            childNodes: [{ type: 3, textContent: 'Editable Alice Secret' }],
          },
          { type: 2, tagName: 'p', attributes: {}, childNodes: [{ type: 3, textContent: 'Visible public label' }] },
        ],
      }] } },
    }, {
      type: 3,
      timestamp: 201,
      data: { source: 5, id: 4, text: 'Typed Alice Secret', isChecked: false },
    }], { route: 'account', textMode: 'visible' });

    const serialized = JSON.stringify(payload.events);
    expect(serialized).toContain('height:48rem;overflow-y:auto');
    expect(serialized).toContain('Visible public label');
    for (const forbidden of [
      'evil.test', 'background-image', 'content:', 'alice@example.test',
      'Editable Alice Secret', 'Typed Alice Secret', '@import',
    ]) expect(serialized).not.toContain(forbidden);
  });

  it('sanitizes rrweb stylesheet/declaration mutations and reapplies explicit selectors', () => {
    const payload = sanitizeReplayEvents([{
      type: 2,
      timestamp: 300,
      data: { node: { type: 0, childNodes: [{
        type: 2,
        tagName: 'body',
        attributes: {},
        childNodes: [
          { type: 2, tagName: 'section', attributes: { class: 'private-block' }, childNodes: [{ type: 3, textContent: 'Blocked Alice Secret' }] },
          { type: 2, tagName: 'p', attributes: { 'data-mask-me': '' }, childNodes: [{ type: 3, textContent: 'Masked Alice Secret' }] },
          { type: 2, tagName: 'p', attributes: {}, childNodes: [{ type: 3, textContent: 'Visible public label' }] },
        ],
      }] } },
    }, {
      type: 3,
      timestamp: 301,
      data: {
        source: 8,
        id: 2,
        replaceSync: '@import "//evil.test/x"; .private-panel { height:48rem; background-image:url(https://evil.test/pixel) }',
      },
    }, {
      type: 3,
      timestamp: 302,
      data: { source: 13, id: 2, index: [0], set: { property: 'height', value: '32rem', priority: 'important' } },
    }, {
      type: 3,
      timestamp: 303,
      data: { source: 13, id: 2, index: [0], set: { property: 'background-image', value: 'url(https://evil.test/x)' } },
    }], {
      route: 'account',
      textMode: 'visible',
      blockSelectors: ['.private-block'],
      maskSelectors: ['[data-mask-me]'],
    });

    const serialized = JSON.stringify(payload.events);
    expect(serialized).toContain('height:48rem');
    expect(serialized).toContain('"property":"height","value":"32rem","priority":"important"');
    expect(serialized).toContain('Visible public label');
    for (const forbidden of [
      'evil.test', '@import', 'background-image', 'Blocked Alice Secret', 'Masked Alice Secret',
    ]) expect(serialized).not.toContain(forbidden);
  });

  it('rejects backward timestamps inside a chunk', () => {
    expect(() => sanitizeReplayEvents([
      { type: 4, timestamp: 200, data: { href: 'https://example.test/?token=x', width: 100, height: 100 } },
      { type: 2, timestamp: 100, data: { node: { type: 0, childNodes: [] } } },
    ], { route: 'home', textMode: 'masked' })).toThrow('timestamps');
  });

  it('does not treat a late full snapshot as a playable initial anchor', () => {
    const payload = sanitizeReplayEvents([
      { type: 3, timestamp: 100, data: { source: 1, positions: [{ x: 1, y: 1, id: 1, timeOffset: 0 }] } },
      { type: 2, timestamp: 101, data: { node: { type: 0, childNodes: [] } } },
    ], { route: 'home', textMode: 'masked' });
    expect(payload.hasCheckout).toBe(false);
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
    await expect(store.get(key, 3)).rejects.toBeInstanceOf(ReplayObjectTooLargeError);
    await expect(store.put(key, Buffer.from('different'))).rejects.toBeInstanceOf(ReplayObjectConflictError);
    await expect(store.put('../escape', Buffer.from('x'))).rejects.toThrow('invalid replay object key');
  });

  it('refuses symlinked UUID directories before any object write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poolstatis-replay-store-'));
    const outside = await mkdtemp(join(tmpdir(), 'poolstatis-replay-outside-'));
    roots.push(root, outside);
    const projectId = '11111111-1111-1111-1111-111111111111';
    await symlink(outside, join(root, projectId));
    const store = new LocalReplayObjectStore(root);
    await expect(store.put(
      `${projectId}/22222222-2222-2222-2222-222222222222/0.json`,
      Buffer.from('safe'),
    )).rejects.toThrow('invalid replay object directory');
  });
});
