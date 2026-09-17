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

import { apply, name } from '../lib/index.js';

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
