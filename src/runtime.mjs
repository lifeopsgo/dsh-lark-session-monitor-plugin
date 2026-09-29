/**
 * The polling runtime: the part that actually watches conversations.
 *
 * Feishu has no user-identity push channel. Event subscription
 * (`im.message.receive_v1`) is delivered to *applications*, and an application
 * that is not a member of a p2p chat never receives its events — so the only
 * way to watch an arbitrary conversation as a person is to poll it with that
 * person's token. This runtime does exactly that on a fixed cadence.
 *
 * Two properties matter for correctness:
 *
 * - A poll is single-flight per monitor and bounded by an abort signal, so a
 *   slow Feishu response can never stack up requests behind the interval.
 * - The cursor advances only after delivery succeeds. Advancing first would
 *   silently drop messages whenever a delivery failed.
 *
 * @module dsh-lark-session-monitor-plugin/runtime
 */

import { isAppSender, isFromSenders, isOwnMessage, mentionsId, renderMessage, senderLabel } from './normalize.mjs';
import { MIN_POLL_INTERVAL_MS } from './store.mjs';

/** Messages delivered in one prompt; the remainder waits for the next round. */
export const MAX_BATCH_SIZE = 10;

/** How far back the very first poll of a monitor looks. */
const INITIAL_LOOKBACK_MS = 10 * 60_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Feishu timestamps are epoch milliseconds in a string. */
function messageTimeMs(message) {
  const raw = message?.create_time;
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return null;
}

/**
 * Owns the poll timer and the per-monitor delivery queues.
 *
 * Constructed with a token provider rather than a token, because the access
 * token rotates: each poll resolves a live token through the authorizer.
 */
export class MonitorRuntime {
  #store;
  #deliverer;
  #logger;
  #getClient;
  #getIntervalMs;
  #now;
  #timer = null;
  #polling = false;
  #closed = false;
  #inFlight = new Map();
  #pending = new Map();
  #state = new Map();
  #controller = new AbortController();
  /** The signed-in user's identity, fetched once for own-message filtering. */
  #identityCache;
  /** The app bot's open_id, fetched once for the @机器人 filter. */
  #botIdCache;
  #getBotOpenId;

  constructor({ store, deliverer, getClient, getIntervalMs, logger = console, now = Date.now, getBotOpenId }) {
    this.#store = store;
    this.#deliverer = deliverer;
    this.#getClient = getClient;
    this.#getIntervalMs = getIntervalMs ?? (() => 30_000);
    this.#logger = logger;
    this.#now = now;
    this.#getBotOpenId = getBotOpenId;
  }

  /** Per-monitor status for the settings page. */
  status() {
    const settings = this.#store.snapshot();
    return settings.monitors.map((monitor) => {
      const state = this.#state.get(monitor.monitorId) ?? {};
      return {
        monitorId: monitor.monitorId,
        lastPollAt: state.lastPollAt ?? null,
        lastMessageAt: monitor.cursor?.lastCreateTimeMs ?? null,
        delivered: state.delivered ?? 0,
        pending: (this.#pending.get(monitor.monitorId) ?? []).length,
        lastError: state.lastError ?? null,
      };
    });
  }

  start() {
    if (this.#closed) throw new Error('Monitor runtime is closed');
    if (this.#timer) return;
    const interval = Math.max(MIN_POLL_INTERVAL_MS, Number(this.#getIntervalMs()) || 30_000);
    this.#timer = setInterval(() => { void this.poll(); }, interval);
    // Do not keep the process alive purely for polling.
    this.#timer.unref?.();
    void this.poll();
  }

  stop() {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#controller.abort(new Error('Monitor runtime stopped'));
  }

  /** Restart the timer after the configured interval changed. */
  reschedule() {
    if (this.#closed) return;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.start();
  }

  #setState(monitorId, patch) {
    this.#state.set(monitorId, { ...(this.#state.get(monitorId) ?? {}), ...patch });
  }

  /** Best-effort client construction; a missing token surfaces as poll error. */
  async #client(signal) {
    return this.#getClient({ signal });
  }

  /**
   * Resolve the signed-in user's identity once, for own-message filtering.
   *
   * A failure is cached as "no identity" and logged once: re-fetching every
   * poll would hammer a dying endpoint, and surfacing it as a monitor error
   * would turn a decoration fetch into a delivery outage. The safe reading
   * of "cannot tell who sent this" is to deliver it as before.
   */
  async #identity(client, signal) {
    if (this.#identityCache) return this.#identityCache.identity;
    try {
      const identity = await client.userInfo({ signal });
      this.#identityCache = { identity };
    } catch (error) {
      // An aborted poll is not a failed fetch: try again on the next round.
      if (error?.name === 'AbortError') return undefined;
      this.#identityCache = { identity: undefined };
      this.#logger.warn?.(
        '[lark-session-monitor] could not load your Feishu identity; own messages cannot be filtered: '
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.#identityCache.identity;
  }

  /**
   * The app bot's open_id, for the @机器人 filter.
   *
   * Success is cached for the process. A failure is not cached: this filter
   * cannot fail open (that would turn a narrow filter into a firehose), so
   * the round is held and retried until the identity resolves — the
   * monitor's lastError carries the platform's own message.
   */
  async #botId(signal) {
    if (this.#botIdCache) return this.#botIdCache;
    if (typeof this.#getBotOpenId !== 'function') return undefined;
    try {
      const openId = await this.#getBotOpenId({ signal });
      if (typeof openId === 'string' && openId) this.#botIdCache = openId;
      return this.#botIdCache;
    } catch (error) {
      // Keep the platform's own reason, but with enough context for the
      // settings page to say what to fix.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`无法识别本应用的机器人身份（${reason}）：请确认应用已启用机器人能力，且 App ID 与 App Secret 有效。`);
    }
  }

  /**
   * One polling round across every enabled monitor.
   *
   * Rounds are single-flight: a round that outlives its interval is skipped
   * rather than overlapped.
   */
  async poll() {
    if (this.#closed || this.#polling) return;
    this.#polling = true;
    try {
      const monitors = this.#store.monitors().filter((m) => m.enabled !== false && m.chatId);
      if (monitors.length === 0) return;
      await Promise.allSettled(
        monitors.map((monitor) => this.pollMonitor(monitor, this.#controller.signal)),
      );
    } finally {
      this.#polling = false;
    }
  }

  /** Poll and deliver for one monitor. Never throws. */
  async pollMonitor(monitor, signal) {
    if (this.#inFlight.has(monitor.monitorId)) return;
    const task = this.#runMonitor(monitor, signal).finally(() => {
      this.#inFlight.delete(monitor.monitorId);
    });
    this.#inFlight.set(monitor.monitorId, task);
    return task;
  }

  async #runMonitor(monitor, signal) {
    const latest = this.#store.monitor(monitor.monitorId);
    if (!latest || latest.enabled === false) return;
    try {
      const client = await this.#client(signal);
      const cursorMs = latest.cursor?.lastCreateTimeMs;
      const startTimeMs = cursorMs ?? (this.#now() - INITIAL_LOOKBACK_MS);
      const messages = await client.listMessages({
        chatId: latest.chatId,
        // Feishu's start_time is exclusive and second-granular: step back one
        // second so a message sharing the cursor's second is not skipped.
        startTimeSeconds: Math.max(0, Math.floor(startTimeMs / 1000) - 1),
        endTimeSeconds: Math.floor(this.#now() / 1000) + 1,
        // Card messages read back as a stripped projection by default; ask
        // for the original card JSON so cards can be rendered as content.
        cardMsgContentType: 'user_card_content',
        signal,
      });
      this.#setState(latest.monitorId, { lastPollAt: this.#now(), lastError: null });

      const fresh = this.#selectFresh(latest, messages);
      if (fresh.length === 0) return;

      // The cursor still covers the whole `fresh` page (see #enqueue), so
      // skipped own messages are never re-read; only the delivery shrinks.
      let deliverable = fresh;
      if (latest.skipOwnMessages === true) {
        const identity = await this.#identity(client, signal);
        if (identity) deliverable = fresh.filter((m) => !isOwnMessage(m, identity));
      }
      // Source acceptance. The sender list narrows the stream; the @机器人
      // switch widens it back by exactly one case: a message that names the
      // bot is accepted even when its sender is not on the list — being
      // addressed is the signal, not who typed it. An empty list plus the
      // switch therefore means "only @bot messages"; with both off, every
      // message is delivered as before. skipOwnMessages stays outermost, so
      // the user's own test pings never ride the mention path back in.
      const senderIds = Array.isArray(latest.onlySenderIds) ? latest.onlySenderIds : [];
      const wantSenders = senderIds.length > 0;
      const wantMention = latest.alsoBotMention === true;
      let botOpenId;
      if (wantMention) {
        botOpenId = await this.#botId(signal);
        if (!botOpenId) {
          // Failing open would deliver every message — the opposite of the
          // filter's intent. Hold the round instead: the cursor is untouched
          // and every poll retries until the identity resolves.
          throw new Error('无法识别本应用的机器人身份：请确认应用已启用机器人能力，且 App ID 与 App Secret 有效。');
        }
      }
      if (wantSenders || wantMention) {
        deliverable = deliverable.filter((message) =>
          (wantSenders && isFromSenders(message, senderIds))
          || (wantMention && mentionsId(message, botOpenId)));
      }

      const bodies = deliverable
        .map((message) => this.#format(latest, message))
        .filter((body) => typeof body === 'string' && body);
      if (bodies.length === 0) {
        // Nothing renderable, but the cursor must still move past them.
        await this.#advance(latest, fresh[fresh.length - 1]);
        return;
      }
      await this.#enqueue(latest, bodies, fresh);
    } catch (error) {
      if (this.#closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#setState(monitor.monitorId, { lastError: message, lastPollAt: this.#now() });
      this.#logger.warn?.(
        `[lark-session-monitor] poll failed for ${monitor.monitorId}: ${message}`,
      );
    }
  }

  /**
   * Drop messages at or before the cursor.
   *
   * The cursor is `(createTimeMs, messageId)`: Feishu's time window is
   * second-granular and exclusive, so both halves are needed to avoid
   * re-delivering the cursor message or skipping a sibling.
   */
  #selectFresh(monitor, messages) {
    const cursorMs = monitor.cursor?.lastCreateTimeMs;
    const cursorId = monitor.cursor?.lastMessageId;
    const usable = messages.filter((message) => {
      const id = message?.message_id;
      if (typeof id !== 'string' || !id) return false;
      const time = messageTimeMs(message);
      if (time === null) return false;
      if (message?.deleted === true) return false;
      return true;
    });
    if (cursorMs === undefined) return usable;
    return usable.filter((message) => {
      const time = messageTimeMs(message);
      if (time > cursorMs) return true;
      if (time < cursorMs) return false;
      // Same second: the cursor message itself is already delivered.
      return message.message_id !== cursorId;
    });
  }

  /**
   * Render one message, prefixing sender and Feishu message id so the
   * prompt carries provenance — the id is what makes a message referenceable
   * (replying, quoting, marking done) from the session side.
   */
  #format(monitor, message) {
    const rendered = renderMessage(message);
    if (!rendered) return undefined;
    const who = isAppSender(message) ? `${senderLabel(message)}（机器人）` : senderLabel(message);
    const id = typeof message?.message_id === 'string' && message.message_id ? message.message_id : '';
    return id ? `[${who}] [${id}] ${rendered.text}` : `[${who}] ${rendered.text}`;
  }

  /**
   * Queue bodies and deliver them in batches of {@link MAX_BATCH_SIZE}.
   *
   * The whole page is delivered before the cursor moves. Delivering only the
   * first batch and advancing anyway would drop the remainder permanently,
   * because the next poll starts after the cursor.
   *
   * Each batch re-reads the monitor: an auto-created session is written back
   * during the first delivery, and reusing the caller's snapshot would make
   * the next batch create a second session — silently defeating the "pin the
   * auto-created session" choice.
   */
  async #enqueue(monitor, bodies, fresh) {
    const queue = this.#pending.get(monitor.monitorId) ?? [];
    queue.push(...bodies);
    this.#pending.set(monitor.monitorId, queue);

    let delivered = 0;
    while (queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH_SIZE);
      const latest = this.#store.monitor(monitor.monitorId) ?? monitor;
      await this.#deliverer.deliver(latest, batch, this.#controller.signal);
      queue.splice(0, batch.length);
      delivered += batch.length;
    }

    await this.#advance(monitor, fresh[fresh.length - 1]);
    this.#setState(monitor.monitorId, {
      delivered: (this.#state.get(monitor.monitorId)?.delivered ?? 0) + delivered,
      lastError: null,
    });
  }

  async #advance(monitor, message) {
    const time = messageTimeMs(message);
    if (time === null) return;
    const cursor = { lastCreateTimeMs: time };
    if (typeof message.message_id === 'string' && message.message_id) {
      cursor.lastMessageId = message.message_id;
    }
    await this.#store.advanceCursor(monitor.monitorId, cursor);
  }

  /** Drop a monitor's queue when it is disabled or deleted. */
  forget(monitorId) {
    this.#pending.delete(monitorId);
    this.#state.delete(monitorId);
    this.#deliverer.forget(monitorId);
  }
}

export { INITIAL_LOOKBACK_MS };
