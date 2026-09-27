/**
 * Unit tests for resolving the app bot's identity.
 *
 * The contract under test: the stored appId/appSecret pair is exchanged for
 * the bot's open_id (the id @-mentions carry) and display name (the picker
 * shows it; chat reads never name app senders), with failures surfacing the
 * platform's own message instead of a generic one.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchAppBotIdentity } from '../src/bot-identity.mjs';

/** Fetch double answering by URL fragment, recording every call. */
function fetchAnswering(entries) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const urlString = String(url);
    calls.push({ url: urlString, init });
    const body = entries.find(([fragment]) => urlString.includes(fragment))?.[1];
    if (!body) return new Response(JSON.stringify({ code: 404, msg: 'unmocked' }), { status: 404 });
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('exchanges the app credentials for the bot identity', async () => {
  const { calls, fetchImpl } = fetchAnswering([
    ['tenant_access_token/internal', { code: 0, tenant_access_token: 't-1', expire: 7200 }],
    ['bot/v3/info', { code: 0, bot: { open_id: 'ou_bot', app_name: '智能助手' } }],
  ]);
  const identity = await fetchAppBotIdentity({
    appId: 'cli_x', appSecret: 'sec', domain: 'feishu', fetchImpl,
  });
  assert.deepEqual(identity, { openId: 'ou_bot', name: '智能助手' });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'));
  assert.equal(JSON.parse(calls[0].init.body).app_id, 'cli_x');
  assert.equal(calls[1].init.headers.authorization, 'Bearer t-1');
});

test('the lark brand uses the larksuite host', async () => {
  const { calls, fetchImpl } = fetchAnswering([
    ['tenant_access_token/internal', { code: 0, tenant_access_token: 't-1' }],
    ['bot/v3/info', { code: 0, bot: { open_id: 'ou_bot' } }],
  ]);
  await fetchAppBotIdentity({ appId: 'cli_x', appSecret: 'sec', domain: 'lark', fetchImpl });
  assert.ok(calls[0].url.includes('open.larksuite.com'));
});

test('an app without a bot identity resolves to undefined', async () => {
  const { fetchImpl } = fetchAnswering([
    ['tenant_access_token/internal', { code: 0, tenant_access_token: 't-1' }],
    ['bot/v3/info', { code: 0, bot: {} }],
  ]);
  const identity = await fetchAppBotIdentity({ appId: 'cli_x', appSecret: 'sec', fetchImpl });
  assert.equal(identity, undefined);
});

test('a missing credential pair skips the network entirely', async () => {
  let called = false;
  const identity = await fetchAppBotIdentity({
    appId: '', appSecret: '',
    fetchImpl: async () => { called = true; return new Response('{}'); },
  });
  assert.equal(identity, undefined);
  assert.equal(called, false);
});

test('a non-zero envelope surfaces the Feishu message', async () => {
  const { fetchImpl } = fetchAnswering([
    ['tenant_access_token/internal', { code: 99991661, msg: 'App Secret 不正确' }],
  ]);
  await assert.rejects(
    () => fetchAppBotIdentity({ appId: 'cli_x', appSecret: 'bad', fetchImpl }),
    /App Secret 不正确/,
  );
});
