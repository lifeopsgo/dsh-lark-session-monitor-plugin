/**
 * Browser-side transport for the settings endpoint.
 *
 * Mirrors the Host's registration ({@link module:dsh-lark-session-monitor/rpc})
 * so both halves agree on the endpoint path. The browser reaches it through
 * DSH's public Connection RPC carrier, which applies the Host's own browser
 * authentication before the handler runs.
 *
 * @module dsh-lark-session-monitor/rpc-client
 */

/** Must match `RPC_CHANNEL` in the Host half. */
export const RPC_CHANNEL = '/lark-session-monitor';

function rpcEndpoint(channel) {
  if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)) throw new TypeError('Invalid RPC channel');
  return `dsh-plugin${channel}`;
}

/**
 * Invoke one endpoint method.
 *
 * @returns the Connection result envelope; the page unwraps it so a typed
 *   failure surfaces as a thrown error with `code` intact.
 */
export function callSettingsRpc(connection, method, payload, signal) {
  if (!connection || typeof connection.rpc?.call !== 'function') {
    throw new Error('DSH Connection RPC 不可用，无法连接插件 Host。');
  }
  return connection.rpc.call('/api', rpcEndpoint(RPC_CHANNEL), { method, payload }, signal);
}
