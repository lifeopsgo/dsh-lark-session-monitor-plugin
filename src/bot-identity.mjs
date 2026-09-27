/**
 * Resolve the configured app's own bot identity.
 *
 * The "@机器人" filter needs to recognize mentions of the app itself, and
 * mentions carry open_id — while the settings hold an appId/appSecret pair.
 * The only bridge is the app-identity endpoints: mint a tenant_access_token
 * from the stored credentials, then read the bot's open_id from bot/v3/info.
 * Neither endpoint requires a permission; the app merely has to have the bot
 * capability enabled.
 *
 * @module dsh-lark-session-monitor-plugin/bot-identity
 */

import { apiHost } from './oauth.mjs';

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Feishu returned a non-JSON response (HTTP ${response.status})`);
  }
}

function failFor(body, fallback) {
  const error = new Error(typeof body?.msg === 'string' && body.msg ? body.msg : fallback);
  error.code = body?.code ?? fallback;
  return error;
}

/**
 * The app bot's open_id, or undefined when the app has no bot identity.
 *
 * Missing credentials answer undefined without touching the network. A
 * Feishu-side failure throws with the platform's own message so the monitor
 * can surface it as its poll error verbatim.
 */
export async function fetchAppBotOpenId({
  appId, appSecret, domain = 'feishu', fetchImpl = fetch, signal,
} = {}) {
  if (!appId || !appSecret) return undefined;
  const host = apiHost(domain);

  const tokenResponse = await fetchImpl(
    new URL(`${host}/open-apis/auth/v3/tenant_access_token/internal`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal,
    },
  );
  const tokenBody = await readJson(tokenResponse);
  if (tokenBody?.code !== 0) throw failFor(tokenBody, 'feishu-tenant-token-failed');
  const token = tokenBody?.tenant_access_token;
  if (typeof token !== 'string' || !token) throw failFor(tokenBody, 'feishu-tenant-token-missing');

  const infoResponse = await fetchImpl(new URL(`${host}/open-apis/bot/v3/info`), {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal,
  });
  const infoBody = await readJson(infoResponse);
  if (infoBody?.code !== 0) throw failFor(infoBody, 'feishu-bot-info-failed');
  const openId = infoBody?.bot?.open_id;
  return typeof openId === 'string' && openId ? openId : undefined;
}
