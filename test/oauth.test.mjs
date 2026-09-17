/**
 * Unit tests for the OAuth device-flow client.
 *
 * These pin the wire contract against the endpoints verified live:
 * `accounts.feishu.cn/oauth/v1/device_authorization` and
 * `open.feishu.cn/open-apis/authen/v2/oauth/token`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREDENTIAL_KEY_PATTERN,
  MONITOR_SCOPES,
  beginDeviceAuthorization,
  credentialKeyFor,
  pollDeviceToken,
  refreshUserToken,
} from '../src/oauth.mjs';

/** A fetch stub that records calls and replays one JSON response. */
function stubFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

test('beginDeviceAuthorization posts to the accounts host with the app id and scopes', async () => {
  const { fetchImpl, calls } = stubFetch({
    device_code: 'dc_1',
    user_code: 'UC-1',
    verification_uri: 'https://accounts.feishu.cn/verify',
    expires_in: 300,
    interval: 5,
  });
  const attempt = await beginDeviceAuthorization({
    appId: 'cli_x', appSecret: 's', fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://accounts.feishu.cn/oauth/v1/device_authorization');
  assert.equal(calls[0].init.method, 'POST');
  const body = new URLSearchParams(calls[0].init.body.toString());
  assert.equal(body.get('client_id'), 'cli_x');
  assert.equal(body.get('client_secret'), 's');
  assert.ok(body.get('scope').includes('im:message.p2p_msg:get_as_user'));
  assert.equal(attempt.deviceCode, 'dc_1');
  assert.equal(attempt.userCode, 'UC-1');
  assert.equal(attempt.intervalSeconds, 5);
});

test('the lark brand uses the larksuite hosts', async () => {
  const { fetchImpl, calls } = stubFetch({
    device_code: 'dc', verification_uri: 'https://accounts.larksuite.com/verify',
  });
  await beginDeviceAuthorization({ appId: 'a', appSecret: 'b', domain: 'lark', fetchImpl });
  assert.equal(calls[0].url, 'https://accounts.larksuite.com/oauth/v1/device_authorization');
});

test('a device authorization without a device code fails loudly', async () => {
  const { fetchImpl } = stubFetch({ error: 'invalid_client', error_description: 'no app' });
  await assert.rejects(
    () => beginDeviceAuthorization({ appId: 'a', appSecret: 'b', fetchImpl }),
    /no app/,
  );
});

test('a missing credential pair is rejected before any request', async () => {
  const { fetchImpl, calls } = stubFetch({});
  await assert.rejects(
    () => beginDeviceAuthorization({ appId: '', appSecret: '', fetchImpl }),
    /appId and appSecret are required/,
  );
  assert.equal(calls.length, 0);
});

test('polling reports pending and slow-down as states, not failures', async () => {
  const pending = stubFetch({ error: 'authorization_pending' });
  assert.deepEqual(
    await pollDeviceToken({ appId: 'a', appSecret: 'b', deviceCode: 'd', fetchImpl: pending.fetchImpl }),
    { status: 'pending' },
  );
  const slow = stubFetch({ error: 'slow_down' });
  assert.deepEqual(
    await pollDeviceToken({ appId: 'a', appSecret: 'b', deviceCode: 'd', fetchImpl: slow.fetchImpl }),
    { status: 'slow-down' },
  );
});

test('redeeming a device code uses the RFC 8628 grant type and parameter', async () => {
  // Regression guard for a real failure: sending `authorization_code`/`code`
  // makes Feishu answer "The authorization code is not found", because that
  // grant expects a browser redirect code this flow never produces.
  const { fetchImpl, calls } = stubFetch({ access_token: 'at', expires_in: 7200 });
  await pollDeviceToken({ appId: 'a', appSecret: 'b', deviceCode: 'dc_123', fetchImpl });
  const body = new URLSearchParams(calls[0].init.body.toString());
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(body.get('device_code'), 'dc_123');
  assert.equal(body.get('code'), null);
});

test('an approved poll returns a token whose expiry is pulled in by a margin', async () => {
  const { fetchImpl, calls } = stubFetch({
    access_token: 'at', refresh_token: 'rt', expires_in: 7200, scope: 's',
  });
  const now = () => 1_000_000;
  const outcome = await pollDeviceToken({
    appId: 'a', appSecret: 'b', deviceCode: 'd', fetchImpl, now,
  });
  assert.equal(outcome.status, 'authorized');
  assert.equal(outcome.token.accessToken, 'at');
  assert.equal(outcome.token.refreshToken, 'rt');
  // 7200s minus the 60s safety margin.
  assert.equal(outcome.token.expiresAt, 1_000_000 + 7140 * 1000);
  assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
  const body = new URLSearchParams(calls[0].init.body.toString());
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(body.get('device_code'), 'd');
});

test('refresh keeps the old refresh token when the response omits one', async () => {
  const { fetchImpl } = stubFetch({ access_token: 'at2', expires_in: 7200 });
  const token = await refreshUserToken({
    appId: 'a', appSecret: 'b', refreshToken: 'rt_old', fetchImpl,
  });
  assert.equal(token.refreshToken, 'rt_old');
  assert.equal(token.accessToken, 'at2');
});

test('refresh without a stored token fails with a typed code', async () => {
  const { fetchImpl } = stubFetch({});
  await assert.rejects(
    () => refreshUserToken({ appId: 'a', appSecret: 'b', refreshToken: '', fetchImpl }),
    (error) => error.code === 'feishu-oauth-missing-refresh-token',
  );
});

test('credential keys are namespaced per app so two apps never collide', () => {
  assert.notEqual(credentialKeyFor('cli_a'), credentialKeyFor('cli_b'));
});

test('credential keys satisfy the credentials service <scope>/<id> grammar', () => {
  // Regression guard for a Host-killing bug: the credentials loader validates
  // every stored record key against `^[a-z][a-z0-9-]*$` per segment, and ONE
  // bad key fails the whole document — taking `dsh` startup down. A
  // colon-joined key ("scope:id") is written happily but rejected at the next
  // boot, so the format is asserted here rather than trusted.
  for (const appId of ['cli_abc123def456', 'CLI_UPPER', 'weird id!', '', 'a']) {
    const key = credentialKeyFor(appId);
    assert.ok(
      CREDENTIAL_KEY_PATTERN.test(key),
      `credential key ${JSON.stringify(key)} (from ${JSON.stringify(appId)}) breaks the grammar`,
    );
    assert.equal(key.split('/').length, 2, 'a key is exactly two segments');
    assert.ok(!key.includes(':'), 'a key never contains a colon');
  }
});

test('a real Feishu app id maps to a stable, readable key', () => {
  assert.equal(credentialKeyFor('cli_abc123def456'), 'dsh-lark-session-monitor/cli-abc123def456');
});

test('the requested scopes cover p2p, group and refresh', () => {
  assert.ok(MONITOR_SCOPES.includes('im:message.p2p_msg:get_as_user'));
  assert.ok(MONITOR_SCOPES.includes('im:message.group_msg:get_as_user'));
  assert.ok(MONITOR_SCOPES.includes('offline_access'));
});
