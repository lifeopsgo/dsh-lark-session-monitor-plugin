/**
 * Unit tests for the Feishu read client.
 *
 * The `types` parameter is the regression this file exists for: without it the
 * chats endpoint returns only groups, and a monitor picker that omitted it
 * appeared to have no private conversations at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { LarkUserClient, LarkApiError } from '../src/lark-api.mjs';

/** Client double recording the URL of each request. */
function clientFor(handler) {
  const calls = [];
  const client = new LarkUserClient({
    domain: 'feishu',
    getToken: async () => 'token',
    fetchImpl: async (url) => {
      calls.push(String(url));
      const body = handler(String(url));
      return new Response(JSON.stringify(body), {
        status: body?.__status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, calls };
}

function page(items, extra = {}) {
  return { code: 0, data: { items, has_more: false, page_token: '', ...extra } };
}

test('listChats asks for p2p and group conversations explicitly', async () => {
  const { client, calls } = clientFor(() => page([]));
  await client.listChats();
  const url = new URL(calls[0]);
  // Regression guard: Feishu's parameter is `types`, and omitting it silently
  // returns groups only.
  assert.equal(url.searchParams.get('types'), 'p2p,group');
});

test('listChats honours an explicit types filter', async () => {
  const { client, calls } = clientFor(() => page([]));
  await client.listChats({ types: 'p2p' });
  assert.equal(new URL(calls[0]).searchParams.get('types'), 'p2p');
});

test('listChats maps chat_mode to a p2p/group type', async () => {
  const { client } = clientFor(() => page([
    { chat_id: 'oc_1', name: '张三', chat_mode: 'p2p' },
    { chat_id: 'oc_2', name: '研发群', chat_mode: 'group' },
  ]));
  const chats = await client.listChats();
  assert.equal(chats[0].chatType, 'p2p');
  assert.equal(chats[1].chatType, 'group');
});

test('listChats keeps paging until has_more is false', async () => {
  let call = 0;
  const { client, calls } = clientFor(() => {
    call += 1;
    if (call === 1) {
      return { code: 0, data: { items: [{ chat_id: 'oc_1', chat_mode: 'p2p' }], has_more: true, page_token: 't1' } };
    }
    return page([{ chat_id: 'oc_2', chat_mode: 'p2p' }]);
  });
  const chats = await client.listChats();
  assert.equal(chats.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get('page_token'), 't1');
});

test('a non-zero Feishu code is an error even on HTTP 200', async () => {
  const { client } = clientFor(() => ({ code: 99991663, msg: 'token expired' }));
  await assert.rejects(() => client.listChats(), (error) => {
    assert.ok(error instanceof LarkApiError);
    assert.equal(error.isAuthFailure, true);
    return true;
  });
});

test('a missing token is refused before any request', async () => {
  let called = false;
  const client = new LarkUserClient({
    domain: 'feishu',
    getToken: async () => undefined,
    fetchImpl: async () => { called = true; return new Response('{}'); },
  });
  await assert.rejects(() => client.listChats(), /尚未完成飞书授权/);
  assert.equal(called, false);
});

test('listMessages scopes the read to the chat and a time window', async () => {
  const { client, calls } = clientFor(() => page([]));
  await client.listMessages({ chatId: 'oc_9', startTimeSeconds: 100, endTimeSeconds: 200 });
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('container_id_type'), 'chat');
  assert.equal(url.searchParams.get('container_id'), 'oc_9');
  assert.equal(url.searchParams.get('start_time'), '100');
  assert.equal(url.searchParams.get('sort_type'), 'ByCreateTimeAsc');
});

test('an auth failure on a response triggers the re-auth hook', async () => {
  let notified = false;
  const client = new LarkUserClient({
    domain: 'feishu',
    getToken: async () => 'token',
    onAuthFailure: () => { notified = true; },
    fetchImpl: async () => new Response('{}', { status: 401 }),
  });
  await assert.rejects(() => client.listChats());
  assert.equal(notified, true);
});
