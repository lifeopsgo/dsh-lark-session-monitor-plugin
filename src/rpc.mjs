/**
 * Host half of the settings bridge.
 *
 * The browser reaches the Host over DSH's public Connection `/api` carrier,
 * the same transport the shipped IM plugin uses. This module owns the wire
 * format only: authentication, the `client-request`/`server-response`
 * envelope, and JSON error mapping. Business logic lives in the feature
 * modules and is reached through the handler this factory receives.
 *
 * @module dsh-lark-session-monitor-plugin/rpc
 */

export const RPC_CHANNEL = '/lark-session-monitor';

function rpcEndpoint(channel) {
  if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)) throw new TypeError('Invalid RPC channel');
  return `dsh-plugin${channel}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackAuthority(authority) {
  if (!authority) return false;
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    const hostname = url.hostname.replace(/\.$/, '');
    return hostname === 'localhost' || hostname === '[::1]'
      || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  } catch { return false; }
}

function isLoopbackRequest(request) {
  if (!isLoopbackAuthority(request.headers.get('host'))) return false;
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && isLoopbackAuthority(url.host);
  } catch { return false; }
}

function failureOf(error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal';
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function reply(rpcId, result) {
  const value = result.ok === false
    ? { ...result, error: { ...result.error, details: result.error.details ?? {} } }
    : result;
  return Response.json({ type: 'server-response', rpcId, result: value });
}

/**
 * Register the settings endpoint.
 *
 * @param handler - `(method, payload, signal) => Promise<value>`; throwing is
 *   how a failure crosses to the browser, so handlers throw rather than
 *   returning error envelopes.
 */
export function registerSettingsRpc(ctx, handler, { authority = 'trusted-host' } = {}) {
  const endpoint = rpcEndpoint(RPC_CHANNEL);
  if (typeof ctx?.connection?.fetch?.register !== 'function') {
    throw new TypeError('DSH Host Connection Fetch registry is required');
  }
  const loopbackOnly = authority === 'loopback';
  return ctx.connection.fetch.register({
    path: `/api/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (loopbackOnly && !isLoopbackRequest(request)) {
        return new Response('forbidden', { status: 403 });
      }
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let message;
      try { message = await request.json(); }
      catch { return new Response('body is not JSON', { status: 400 }); }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
      const call = message?.payload;
      if (!isRecord(message) || message.type !== 'client-request'
        || typeof message.rpcId !== 'string'
        || message.method !== endpoint
        || !isRecord(call) || typeof call.method !== 'string'
        || !Object.hasOwn(call, 'payload')) {
        return reply(rpcId, {
          ok: false,
          error: { code: 'bad-request', message: 'Invalid settings request.', details: {} },
        });
      }
      try {
        return reply(rpcId, { ok: true, value: await handler(call.method, call.payload, request.signal) });
      } catch (error) {
        // A failure rides a 200 with a typed error envelope: the browser is
        // calling through DSH's RPC client, which reads `result.error.code`
        // rather than the HTTP status, and a bare 4xx/5xx would surface as an
        // opaque transport error instead of the code the UI branches on.
        return reply(rpcId, { ok: false, error: failureOf(error) });
      }
    },
  });
}

export function callSettingsRpc(connection, method, payload, signal) {
  return connection.rpc.call('/api', rpcEndpoint(RPC_CHANNEL), { method, payload }, signal);
}
