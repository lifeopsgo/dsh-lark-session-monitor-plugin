/**
 * Feishu Open API reads performed with the signed-in user's own token.
 *
 * Only the read endpoints the monitor needs live here, plus the batch
 * lookup used to resolve chat names for display. Every call goes through
 * {@link LarkUserClient#request}, which attaches the user token and normalizes
 * Feishu's envelope (`code !== 0` is an error even on HTTP 200 — a detail that
 * silently corrupts a poll loop when missed).
 *
 * @module dsh-lark-session-monitor-plugin/lark-api
 */

import { apiHost } from './oauth.mjs';

/** Page size for message reads; Feishu caps this endpoint at 50. */
const MESSAGE_PAGE_SIZE = 50;

export class LarkApiError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'LarkApiError';
    this.code = code;
    this.status = status;
  }

  /** A rejected or expired token: the caller must re-authorize. */
  get isAuthFailure() {
    return this.status === 401
      || this.code === 99991663
      || this.code === 99991661
      || this.code === 20005;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class LarkUserClient {
  #domain;
  #getToken;
  #fetchImpl;
  #onAuthFailure;

  /**
   * @param options.getToken - resolves the live access token, refreshing it when stale.
   * @param options.onAuthFailure - invoked when the host rejects the token.
   */
  constructor({ domain = 'feishu', getToken, fetchImpl = fetch, onAuthFailure }) {
    this.#domain = domain;
    this.#getToken = getToken;
    this.#fetchImpl = fetchImpl;
    this.#onAuthFailure = onAuthFailure;
  }

  get domain() {
    return this.#domain;
  }

  async #request(path, { method = 'GET', query, body, signal } = {}) {
    const token = await this.#getToken({ signal });
    if (!token) {
      throw new LarkApiError('尚未完成飞书授权，请先在插件设置页授权。', { code: 'not-authorized' });
    }
    const url = new URL(`${apiHost(this.#domain)}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await this.#fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch {
      throw new LarkApiError(`飞书接口返回了非 JSON 响应（HTTP ${response.status}）`, {
        status: response.status,
      });
    }
    if (!response.ok) {
      const error = new LarkApiError(
        `飞书接口请求失败（HTTP ${response.status}）`,
        { status: response.status, code: payload?.code },
      );
      if (error.isAuthFailure) this.#onAuthFailure?.();
      throw error;
    }
    // Feishu answers 200 with a non-zero `code` on logical failures.
    if (isRecord(payload) && payload.code !== undefined && payload.code !== 0) {
      const error = new LarkApiError(
        payload.msg || `飞书接口返回错误码 ${payload.code}`,
        { code: payload.code, status: response.status },
      );
      if (error.isAuthFailure) this.#onAuthFailure?.();
      throw error;
    }
    return payload?.data ?? payload;
  }

  /**
   * List the conversations the user is in.
   *
   * The `types` parameter is what makes p2p conversations appear: without it
   * this endpoint returns only groups, which is why a monitor picker that
   * omitted it looked like it had no private chats to offer. `types` takes a
   * comma-separated list, and both are requested together because the monitor
   * is not specific to one kind.
   *
   * @param options.types - `'p2p'`, `'group'`, or both; defaults to both.
   */
  async listChats({ pageSize = 100, types = 'p2p,group', signal } = {}) {
    const chats = [];
    let pageToken;
    for (let page = 0; page < 50; page += 1) {
      const data = await this.#request('/open-apis/im/v1/chats', {
        query: {
          page_size: pageSize,
          page_token: pageToken,
          sort_type: 'ByCreateTimeAsc',
          types,
        },
        signal,
      });
      for (const item of data?.items ?? []) {
        const chatId = item?.chat_id;
        if (typeof chatId !== 'string' || !chatId) continue;
        chats.push({
          chatId,
          name: typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : '',
          chatMode: item?.chat_mode ?? '',
          chatType: item?.chat_mode === 'p2p' ? 'p2p' : 'group',
          external: item?.external === true,
        });
      }
      if (!data?.has_more || !data?.page_token) break;
      pageToken = data.page_token;
    }
    return chats;
  }

  /**
   * Read one conversation's messages inside a time window.
   *
   * `start_time` is exclusive on Feishu's side and mandatory here: without it
   * the first poll would page through the conversation's entire history.
   * `maxMessages` bounds the read for callers that only need a sample —
   * the sender picker stops paging once it has enough.
   *
   * `cardMsgContentType` — pass `'user_card_content'` to receive card
   * messages as their original JSON (1.0 or 2.0 structure) instead of the
   * receive-time projection, which drops most of a card's content.
   */
  async listMessages({ chatId, startTimeSeconds, endTimeSeconds, maxMessages, cardMsgContentType, signal }) {
    const messages = [];
    let pageToken;
    for (let page = 0; page < 20; page += 1) {
      const data = await this.#request('/open-apis/im/v1/messages', {
        query: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: startTimeSeconds,
          end_time: endTimeSeconds,
          sort_type: 'ByCreateTimeAsc',
          page_size: MESSAGE_PAGE_SIZE,
          page_token: pageToken,
          ...(cardMsgContentType ? { card_msg_content_type: cardMsgContentType } : {}),
        },
        signal,
      });
      const items = data?.items ?? [];
      messages.push(...items);
      if (maxMessages !== undefined && messages.length >= maxMessages) break;
      if (!data?.has_more || !data?.page_token) break;
      pageToken = data.page_token;
    }
    return messages;
  }

  /**
   * The signed-in user's own identity, used to recognize self-sent messages.
   *
   * The endpoint needs no scope beyond a valid user token. `user_id` is a
   * sensitive field and may come back empty, which is fine: open_id is what
   * the message reads carry.
   */
  async userInfo({ signal } = {}) {
    const data = await this.#request('/open-apis/authen/v1/user_info', { signal });
    return {
      openId: typeof data?.open_id === 'string' ? data.open_id : '',
      unionId: typeof data?.union_id === 'string' ? data.union_id : '',
      userId: typeof data?.user_id === 'string' ? data.user_id : '',
      name: typeof data?.name === 'string' ? data.name.trim() : '',
    };
  }

  /** Resolve display names for chat ids; failures degrade to the raw id. */
  async chatNames(chatIds, { signal } = {}) {
    const names = new Map();
    for (const chatId of chatIds) {
      try {
        const data = await this.#request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, { signal });
        const name = typeof data?.name === 'string' ? data.name.trim() : '';
        if (name) names.set(chatId, name);
      } catch {
        // A name is decoration; the monitor works without it.
      }
    }
    return names;
  }
}
