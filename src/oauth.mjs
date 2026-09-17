/**
 * Feishu OAuth device-flow client.
 *
 * The monitor reads a private conversation, which only a *user* identity may
 * do: Feishu delivers `im.message.receive_v1` to applications, and an
 * application that is not a member of a p2p chat never sees its events. The
 * user's own token is therefore the only credential that works, and this
 * module is how one is obtained and kept fresh.
 *
 * Feishu's device flow is the OAuth 2.0 Device Authorization Grant:
 * `device_authorization` returns a `device_code` plus a `verification_uri` the
 * user opens once, and `token` is polled until the grant is approved. Only the
 * user_access_token endpoint is used; the app's own tenant token cannot read
 * the conversation we care about.
 *
 * @module dsh-lark-session-monitor-plugin/oauth
 */

import { randomUUID } from 'node:crypto';

/** Accounts host per brand; the API host is always open.feishu.cn/open.larksuite.com. */
const ACCOUNTS_HOSTS = Object.freeze({
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
});

const API_HOSTS = Object.freeze({
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
});

/** Scopes the monitor needs: read the user's p2p and group conversations. */
export const MONITOR_SCOPES = Object.freeze([
  'im:message.p2p_msg:get_as_user',
  'im:message.group_msg:get_as_user',
  'im:chat:read',
  'offline_access',
]);

/**
 * The RFC 8628 grant type used to redeem a device code.
 *
 * Distinct from `authorization_code`: that grant redeems a browser redirect
 * code, and Feishu answers it with "The authorization code is not found" when
 * handed a device code.
 */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export function accountsHost(domain) {
  return ACCOUNTS_HOSTS[domain] ?? ACCOUNTS_HOSTS.feishu;
}

export function apiHost(domain) {
  return API_HOSTS[domain] ?? API_HOSTS.feishu;
}

function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body;
}

function errorFromBody(body, fallback) {
  const code = typeof body?.error === 'string' ? body.error : undefined;
  const description = typeof body?.error_description === 'string' ? body.error_description : undefined;
  const error = new Error(description || code || fallback);
  error.code = code ?? fallback;
  return error;
}

async function postForm(url, fields, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: formBody(fields),
    signal,
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Feishu OAuth returned a non-JSON response (HTTP ${response.status})`); }
  if (!response.ok) throw errorFromBody(body, `feishu-oauth-http-${response.status}`);
  return body;
}

/**
 * Start a device authorization.
 *
 * The returned object is what the settings page renders: the user opens
 * `verificationUrl` (or scans `qrContent`) and approves the scopes once.
 */
export async function beginDeviceAuthorization(options) {
  const {
    appId,
    appSecret,
    domain = 'feishu',
    scopes = MONITOR_SCOPES,
    fetchImpl = fetch,
    signal,
  } = options;
  if (!appId || !appSecret) throw new TypeError('appId and appSecret are required');
  const body = await postForm(`${accountsHost(domain)}/oauth/v1/device_authorization`, {
    client_id: appId,
    client_secret: appSecret,
    scope: scopes.join(' '),
  }, { fetchImpl, signal });
  const deviceCode = body.device_code;
  const verificationUri = body.verification_uri ?? body.verification_uri_complete;
  if (typeof deviceCode !== 'string' || !deviceCode) {
    throw errorFromBody(body, 'feishu-oauth-missing-device-code');
  }
  if (typeof verificationUri !== 'string' || !verificationUri) {
    throw errorFromBody(body, 'feishu-oauth-missing-verification-uri');
  }
  const userCode = typeof body.user_code === 'string' ? body.user_code : undefined;
  const complete = typeof body.verification_uri_complete === 'string'
    ? body.verification_uri_complete
    : `${verificationUri}?user_code=${encodeURIComponent(userCode ?? '')}`;
  return {
    deviceCode,
    userCode,
    verificationUrl: verificationUri,
    verificationUrlComplete: complete,
    expiresInSeconds: Number.isFinite(body.expires_in) ? body.expires_in : 300,
    intervalSeconds: Number.isFinite(body.interval) ? body.interval : 5,
  };
}

function tokenRecordFrom(body, now) {
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw errorFromBody(body, 'feishu-oauth-missing-access-token');
  }
  const expiresIn = Number.isFinite(body.expires_in) ? body.expires_in : 7200;
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    // Refresh a minute early so a poll never races an expiring token.
    expiresAt: now() + Math.max(0, expiresIn - 60) * 1000,
    scope: typeof body.scope === 'string' ? body.scope : MONITOR_SCOPES.join(' '),
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
  };
}

/**
 * Poll the token endpoint once for a pending device authorization.
 *
 * `authorization_pending` and `slow_down` are states, not failures: the first
 * means the user has not approved yet and the second asks the caller to back
 * off. Everything else is terminal and throws.
 */
export async function pollDeviceToken(options) {
  const {
    appId,
    appSecret,
    deviceCode,
    domain = 'feishu',
    fetchImpl = fetch,
    signal,
    now = Date.now,
  } = options;
  const body = await postForm(`${apiHost(domain)}/open-apis/authen/v2/oauth/token`, {
    // RFC 8628 exchange: the device code is redeemed with its own grant type
    // and its own parameter name. Sending `authorization_code`/`code` gets
    // "The authorization code is not found", because the endpoint then looks
    // for a browser redirect code that this flow never produces.
    grant_type: DEVICE_CODE_GRANT_TYPE,
    client_id: appId,
    client_secret: appSecret,
    device_code: deviceCode,
  }, { fetchImpl, signal });
  const error = typeof body?.error === 'string' ? body.error : undefined;
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow-down' };
  if (error) throw errorFromBody(body, 'feishu-oauth-failed');
  return { status: 'authorized', token: tokenRecordFrom(body, now) };
}

/** Exchange a stored refresh token for a fresh access token. */
export async function refreshUserToken(options) {
  const {
    appId,
    appSecret,
    refreshToken,
    domain = 'feishu',
    fetchImpl = fetch,
    signal,
    now = Date.now,
  } = options;
  if (!refreshToken) {
    const error = new Error('No Feishu refresh token is stored; authorize again.');
    error.code = 'feishu-oauth-missing-refresh-token';
    throw error;
  }
  const body = await postForm(`${apiHost(domain)}/open-apis/authen/v2/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: appId,
    client_secret: appSecret,
    refresh_token: refreshToken,
  }, { fetchImpl, signal });
  const token = tokenRecordFrom(body, now);
  // A refresh response may omit the refresh token; keep rotating the old one.
  if (!token.refreshToken) token.refreshToken = refreshToken;
  return token;
}

/** Stable key under which one app's user grant is stored. */
/** Scope segment: this plugin's name, which the credentials service uses as the owner. */
const CREDENTIAL_SCOPE = 'dsh-lark-session-monitor-plugin';

/**
 * Both halves of a credential key must match the credentials service's segment
 * grammar: `^[a-z][a-z0-9-]*$`.
 *
 * A Feishu app id (`cli_abc123`) already satisfies it, but the
 * grammar is applied defensively: an app id is user input, and a key outside
 * the grammar is refused by `parseCredentialKey` at boot — which takes the
 * whole Host down rather than just failing this plugin. Lowercasing and
 * replacing anything else keeps a hand-entered id from becoming a load-time
 * crash on disk.
 */
function credentialIdSegment(appId) {
  const normalized = String(appId ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return /^[a-z][a-z0-9-]*$/.test(normalized) ? normalized : 'unknown-app';
}

/**
 * Stable record key for one app's user grant.
 *
 * The credentials service requires exactly `<scope>/<id>`: a colon-joined key
 * is written happily but rejected by the loader on the next boot, and one bad
 * key fails the entire credentials document — so the plugin would take the
 * Host's startup down with it.
 */
export function credentialKeyFor(appId) {
  return `${CREDENTIAL_SCOPE}/${credentialIdSegment(appId)}`;
}

/** Exposed for tests: the exact grammar this module must satisfy. */
export const CREDENTIAL_KEY_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** Opaque state token for one authorization attempt. */
export function newAttemptId() {
  return randomUUID();
}
