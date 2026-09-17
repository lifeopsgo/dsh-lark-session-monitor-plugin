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

import { isAppSender, renderMessage, senderLabel } from './normalize.mjs';

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

  constructor({ store, deliverer, getClient, getIntervalMs, logger = console, now = Date.now }) {
    this.#store = store;
    this.#deliverer = deliverer;
    this.#getClient = getClient;
    this.#getIntervalMs = getIntervalMs ?? (() => 30_000);
    this.#logger = logger;
    this.#now = now;
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
    const interval = Math.max(10_000, Number(this.#getIntervalMs()) || 30_000);
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
        signal,
      });
      this.#setState(latest.monitorId, { lastPollAt: this.#now(), lastError: null });

      const fresh = this.#selectFresh(latest, messages);
      if (fresh.length === 0) return;

      const bodies = fresh
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

  /** Render one message, prefixing the sender so the prompt has provenance. */
  #format(monitor, message) {
    const rendered = renderMessage(message);
    if (!rendered) return undefined;
    const who = isAppSender(message) ? `${senderLabel(message)}（机器人）` : senderLabel(message);
    return `[${who}] ${rendered.text}`;
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
