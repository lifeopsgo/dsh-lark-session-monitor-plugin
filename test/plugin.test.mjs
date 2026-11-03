/**
 * Smoke test for the Host plugin body.
 *
 * Loads the *built* bundle the profile will actually import and runs `apply`
 * against a minimal Cordis-like context. This catches the wiring mistakes that
 * unit tests miss: a service read under the wrong name, an effect that throws
 * on the first call, or a registration that never happens.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, Config, name } from '../lib/index.js';
import { chatsMatchingQuery } from '../src/index.mjs';

/** A context double recording effects, listeners and registered routes. */
function fakeContext(services = {}) {
  const effects = [];
  const routes = [];
  const logs = [];
  const registry = new Map(Object.entries(services));
  return {
    effects,
    routes,
    logs,
    get: (key) => registry.get(key),
    set: (key, value) => registry.set(key, value),
    logger: () => ({
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    }),
    effect: (fn, label) => {
      const disposer = fn();
      effects.push({ label, disposer });
      return disposer;
    },
    connection: {
      fetch: {
        register: (route) => {
          routes.push(route);
          return () => {};
        },
      },
    },
  };
}

const baseConfig = { rpcAuthority: 'trusted-host', autoStart: false, maxChats: 500 };

test('the bundle exposes the plugin contract', () => {
  assert.equal(name, 'dsh-lark-session-monitor-plugin');
  assert.equal(typeof apply, 'function');
});

test('the bundle exposes a schema that resolves valid configuration defaults', () => {
  assert.equal(typeof Config, 'function');
  assert.deepEqual(Config({}), {
    rpcAuthority: 'trusted-host',
    autoStart: true,
    maxChats: 500,
  });
  assert.throws(() => Config({ maxChats: 0 }), /maxChats/);
});

test('apply registers an effect and a settings route without touching the network', () => {
  const ctx = fakeContext();
  apply(ctx, baseConfig);
  assert.ok(ctx.effects.length >= 2, 'expected at least the endpoint and lifecycle effects');
  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].path, '/api/dsh-plugin/lark-session-monitor');
  assert.deepEqual(ctx.routes[0].methods, ['POST']);
});

test('the plugin mounts without a storage service at all', () => {
  // Settings persist to a plain file, so no Host service is required for
  // them. The plugin used to read `storage`, and using that domain API wrongly
  // is what silently lost every setting.
  const ctx = fakeContext();
  apply(ctx, baseConfig);
  assert.equal(ctx.routes.length, 1, 'the endpoint must still register');
  assert.ok(!ctx.logs.some(([, message]) => /storage/.test(message)));
});

test('a missing credentials service degrades to a warning rather than a throw', () => {
  const ctx = fakeContext();
  apply(ctx, baseConfig);
  assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && /credentials/.test(message)));
});

test('the settings endpoint answers settings.get without a Feishu call', async () => {
  const ctx = fakeContext();
  apply(ctx, baseConfig);
  const route = ctx.routes[0];
  const response = await route.fetch(new Request(
    'http://127.0.0.1/api/dsh-plugin/lark-session-monitor',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r1',
        method: 'dsh-plugin/lark-session-monitor',
        payload: { method: 'settings.get', payload: {} },
      }),
    },
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, 'server-response');
  assert.equal(body.rpcId, 'r1');
  assert.equal(body.result.ok, true);
  // No authorization yet, and the secret is never in the payload.
  assert.equal(body.result.value.authorization.authorized, false);
  assert.equal(body.result.value.settings.app.hasSecret, false);
  assert.ok(!JSON.stringify(body.result.value).includes('appSecret'));
});

test('an unknown endpoint method returns a typed error envelope', async () => {
  const ctx = fakeContext();
  apply(ctx, baseConfig);
  const route = ctx.routes[0];
  const response = await route.fetch(new Request(
    'http://127.0.0.1/api/dsh-plugin/lark-session-monitor',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r2',
        method: 'dsh-plugin/lark-session-monitor',
        payload: { method: 'nope.method', payload: {} },
      }),
    },
  ));
  const body = await response.json();
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error.code, 'bad-request');
});

test('a non-JSON body is rejected before any handler runs', async () => {
  const ctx = fakeContext();
  apply(ctx, baseConfig);
  const route = ctx.routes[0];
  const response = await route.fetch(new Request(
    'http://127.0.0.1/api/dsh-plugin/lark-session-monitor',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: 'not json',
    },
  ));
  assert.equal(response.status, 400);
});

test('an unauthorized settings.get still reports the poll interval', async () => {
  const ctx = fakeContext();
  apply(ctx, baseConfig);
  const route = ctx.routes[0];
  const response = await route.fetch(new Request(
    'http://127.0.0.1/api/dsh-plugin/lark-session-monitor',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r3',
        method: 'dsh-plugin/lark-session-monitor',
        payload: { method: 'settings.get', payload: {} },
      }),
    },
  ));
  const body = await response.json();
  assert.equal(body.result.value.settings.pollIntervalMs, 30_000);
  assert.deepEqual(body.result.value.settings.monitors, []);
});

test('the loopback authority rejects a non-loopback Host header', async () => {
  const ctx = fakeContext();
  apply(ctx, { ...baseConfig, rpcAuthority: 'loopback' });
  const route = ctx.routes[0];
  const response = await route.fetch(new Request(
    'http://example.com/api/dsh-plugin/lark-session-monitor',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'example.com' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r4',
        method: 'dsh-plugin/lark-session-monitor',
        payload: { method: 'settings.get', payload: {} },
      }),
    },
  ));
  assert.equal(response.status, 403);
});

test('chatsMatchingQuery mirrors the picker filter', () => {
  const chats = [
    { chatId: 'oc_1', name: '国内 EMQX 迁移 IOTHUB 阶段验证' },
    { chatId: 'oc_2', name: '海外 EMQX 迁移 IOTHUB 阶段验证' },
    { chatId: 'oc_3', name: '' },
  ];
  // No query means the whole list, not an empty one.
  assert.equal(chatsMatchingQuery(chats, undefined), chats);
  // Trimmed and case-folded, matching the browser-side filter.
  assert.deepEqual(chatsMatchingQuery(chats, '  国内 emqx  '), [chats[0]]);
  // The chat id matches too, so an unnamed chat stays findable.
  assert.deepEqual(chatsMatchingQuery(chats, 'oc_2'), [chats[1]]);
  assert.deepEqual(chatsMatchingQuery(chats, '不存在'), []);
});

/** An RPC call against the registered route, unwrapping the envelope. */
async function rpc(route, payload) {
  const response = await route.fetch(new Request(
    'http://127.0.0.1/api/dsh-plugin/lark-session-monitor',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r',
        method: 'dsh-plugin/lark-session-monitor',
        payload,
      }),
    },
  ));
  const body = await response.json();
  if (body.result.ok === false) throw new Error(body.result.error.message);
  return body.result.value;
}

test('chat.list searches the whole list beyond the maxChats cap', async () => {
  // The regression this pins: a chat beyond the cap was invisible to every
  // query because the slice ran before any filtering. The endpoint needs an
  // authorized grant and a settings document, so the store runs inside an
  // isolated DSH_HOME and fetch serves a paginated fake.
  const home = await mkdtemp(join(tmpdir(), 'lsm-chatlist-'));
  const dataDir = join(home, 'plugin-data', 'dsh-lark-session-monitor-plugin');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({
    version: 1,
    app: { appId: 'cli_test', appSecret: 'secret', domain: 'feishu' },
    pollIntervalMs: 30000,
    monitors: [],
  }));

  const all = Array.from({ length: 600 }, (_, index) => ({
    chat_id: `oc_${String(index).padStart(3, '0')}`,
    name: index === 550 ? '国内 EMQX 迁移 IOTHUB 阶段验证' : `群 ${index}`,
    chat_mode: 'group',
    external: false,
  }));
  const originalFetch = globalThis.fetch;
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const pageSize = Number(url.searchParams.get('page_size') ?? '20');
    const start = Number(url.searchParams.get('page_token') ?? '0');
    const items = all.slice(start, start + pageSize);
    return new Response(JSON.stringify({
      code: 0,
      msg: 'success',
      data: { items, has_more: start + pageSize < all.length, page_token: String(start + pageSize) },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const ctx = fakeContext({
      credentials: {
        readRecord: async () => ({
          kind: 'grant',
          payload: {
            accessToken: 'token',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 3_600_000,
            scope: '',
            tokenType: 'Bearer',
          },
        }),
        modifyRecord: async (key, mutate) => mutate?.(),
        deleteRecord: async () => {},
      },
    });
    apply(ctx, { ...baseConfig, maxChats: 500 });
    const route = ctx.routes[0];

    // The lifecycle effect loads the store asynchronously; the chat read
    // needs the appId from it, so wait until settings.get reports it.
    let loaded = false;
    for (let attempt = 0; attempt < 400 && !loaded; attempt += 1) {
      const settings = await rpc(route, { method: 'settings.get', payload: {} });
      loaded = settings.settings.app.appId === 'cli_test';
      if (!loaded) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(loaded, 'the settings store must load before the chat list can be read');

    const unfiltered = await rpc(route, { method: 'chat.list', payload: {} });
    assert.equal(unfiltered.total, 600);
    assert.equal(unfiltered.truncated, true);
    assert.equal(unfiltered.chats.length, 500);
    assert.equal(
      unfiltered.chats.some((chat) => chat.name === '国内 EMQX 迁移 IOTHUB 阶段验证'),
      false,
      'the capped slice must not contain the chat at index 550',
    );

    // The query runs against all 600 chats, so the chat beyond the cap is
    // found — case-folded, exactly as the picker types it.
    const searched = await rpc(route, { method: 'chat.list', payload: { query: '国内 emqx' } });
    assert.equal(searched.total, 600);
    assert.equal(searched.truncated, false);
    assert.equal(searched.chats.length, 1);
    assert.equal(searched.chats[0].name, '国内 EMQX 迁移 IOTHUB 阶段验证');
    assert.equal(searched.chats[0].chatId, 'oc_550');

    // A chat id prefix narrows to its matches, keeping unnamed chats findable.
    const byId = await rpc(route, { method: 'chat.list', payload: { query: 'oc_55' } });
    assert.equal(byId.chats.length, 10);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('target.list answers from the registry and titles load per workspace', async () => {
  // The regression this pins: `target.list` folded a title for every
  // registered session on every page open, which read and parsed each
  // session's whole log — minutes on a large Host — while the picker showed
  // "目标工作区（0 个）". The list must answer without touching a log; titles
  // fold only for the workspace the user picked.
  const foldCalls = [];
  const ctx = fakeContext({
    workspaceRegistry: {
      list: () => [
        { id: 'w1', path: '/a', title: 'Alpha', sessionIds: ['s_cold', 's_open'] },
        { id: 'w2', path: '/b', title: 'Beta', sessionIds: ['s_other'] },
      ],
      archivedSessionIds: new Set(),
    },
    sessionQuery: {
      readTitleSnapshots: async (ids) => {
        foldCalls.push([...ids]);
        return [
          { status: 'fulfilled', value: { title: '历史会话标题' } },
          { status: 'rejected', reason: new Error('log unreadable') },
        ];
      },
    },
    sessions: { list: () => [{ id: 's_open' }] },
    sessionTitle: {
      get: (session) => (session?.id === 's_open' ? { title: '在线标题' } : undefined),
    },
  });
  apply(ctx, baseConfig);
  const route = ctx.routes[0];

  // Registry-only: no log may be read before the user picks a workspace.
  const listed = await rpc(route, { method: 'target.list', payload: {} });
  assert.equal(listed.workspaces.length, 2);
  assert.deepEqual(listed.workspaces[0].sessions, [
    { sessionId: 's_cold', title: '' },
    { sessionId: 's_open', title: '' },
  ]);
  assert.deepEqual(foldCalls, [], 'the workspace list must not fold any title');

  // One picked workspace folds only its own sessions; the live service
  // still names a session the corpus could not.
  const titled = await rpc(route, { method: 'target.sessions', payload: { workspace: '/a' } });
  assert.deepEqual(foldCalls, [['s_cold', 's_open']], 'one chunk, this workspace only');
  assert.deepEqual(titled, {
    workspace: '/a',
    sessions: [
      { sessionId: 's_cold', title: '历史会话标题' },
      { sessionId: 's_open', title: '在线标题' },
    ],
    pending: false,
  });

  // A second call answers from the cache without touching a log.
  const cached = await rpc(route, { method: 'target.sessions', payload: { workspace: '/a' } });
  assert.equal(cached.sessions.length, 2);
  assert.deepEqual(foldCalls, [['s_cold', 's_open']], 'titles are folded once, then cached');

  // An unknown workspace and a missing argument both answer empty.
  assert.deepEqual(
    await rpc(route, { method: 'target.sessions', payload: { workspace: '/missing' } }),
    { workspace: '/missing', sessions: [], pending: false },
  );
  assert.deepEqual(
    await rpc(route, { method: 'target.sessions', payload: {} }),
    { workspace: '', sessions: [], pending: false },
  );
});
