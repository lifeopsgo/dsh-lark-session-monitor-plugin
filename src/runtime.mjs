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

import { isAppSender, isFromSenders, isOwnBotMessage, matchesBlockedKeywords, mentionsId, renderMessage, senderLabel } from './normalize.mjs';
import { MIN_POLL_INTERVAL_MS } from './store.mjs';

/** Messages delivered in one prompt; the remainder waits for the next round. */
export const MAX_BATCH_SIZE = 10;

/** How far back the very first poll of a monitor looks. */
const INITIAL_LOOKBACK_MS = 10 * 60_000;

/** Separator between digest entries within one delivery. */
export const DIGEST_SEPARATOR = '\n\n---\n\n';

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

/** Format an epoch-ms timestamp as a local `YYYY-MM-DD HH:mm:ss` string. */
function formatTimestamp(timeMs) {
  const date = new Date(timeMs);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
  /** The app bot's open_id, fetched once for the @机器人 filter. */
  #botIdCache;
  #getBotOpenId;
  #getAppId;
  /** The authorized user's open_id, resolved at most once per process. */
  #operatorIdCache;

  constructor({
    store, deliverer, getClient, getIntervalMs, logger = console, now = Date.now, getBotOpenId, getAppId,
  }) {
    this.#store = store;
    this.#deliverer = deliverer;
    this.#getClient = getClient;
    this.#getIntervalMs = getIntervalMs ?? (() => 30_000);
    this.#logger = logger;
    this.#now = now;
    this.#getBotOpenId = getBotOpenId;
    this.#getAppId = getAppId;
  }

  /** Per-monitor status for the settings page. */
  status() {
    const settings = this.#store.snapshot();
    // Whether the @我 rule can match yet: the identity lives in settings once
    // it has been read, so a restart keeps it.
    const operatorKnown = Boolean(this.#operatorIdCache || settings?.app?.userOpenId);
    return settings.monitors.map((monitor) => {
      const state = this.#state.get(monitor.monitorId) ?? {};
      return {
        monitorId: monitor.monitorId,
        lastPollAt: state.lastPollAt ?? null,
        lastMessageAt: monitor.cursor?.lastCreateTimeMs ?? null,
        delivered: state.delivered ?? 0,
        pending: (this.#pending.get(monitor.monitorId) ?? []).length,
        lastError: state.lastError ?? null,
        operatorKnown,
        // What the filters rejected most recently, and in total. A monitor
        // that reads but never delivers is otherwise indistinguishable from
        // one that never polled.
        skipped: state.skipped ?? 0,
        lastSkip: state.lastSkip ?? null,
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
   * The authorized user's open_id, for the @我 filter.
   *
   * Persisted in settings, so a restart does not need the call again. The
   * answer is only asked for when a monitor turns the rule on, and a failure
   * is cached like a success: re-fetching every poll would hammer a dying
   * endpoint, and the rule simply does not match until the identity resolves.
   * The monitor card says so rather than leaving the switch looking broken.
   */
  async #operatorId(client, signal) {
    if (this.#operatorIdCache !== undefined) return this.#operatorIdCache;
    const stored = this.#store.snapshot()?.app?.userOpenId;
    if (typeof stored === 'string' && stored) {
      this.#operatorIdCache = stored;
      return stored;
    }
    try {
      const identity = await client.userInfo({ signal });
      const openId = typeof identity?.openId === 'string' ? identity.openId : '';
      this.#operatorIdCache = openId;
      if (openId) await this.#store.saveUserOpenId(openId);
      return openId;
    } catch (error) {
      // An aborted poll is not a failed fetch: try again on the next round.
      if (error?.name === 'AbortError') return '';
      this.#operatorIdCache = '';
      this.#logger.warn?.(
        '[lark-session-monitor] 无法读取你的飞书身份，@我 的规则暂不生效：'
        + `${error instanceof Error ? error.message : String(error)}`,
        error,
      );
      return '';
    }
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
      // settings page to say what to fix. The cause link keeps the original
      // stack reachable: Host dumps render [cause] chains, so a wrapped
      // failure still carries the frame that threw it.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法识别本应用的机器人身份（${reason}）：请确认应用已启用机器人能力，且 App ID 与 App Secret 有效。`,
        { cause: error },
      );
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

      // Every message is classified by the rule that decided it, so a round
      // that delivers nothing can still say why. Without that, the monitor
      // consumes the page and reports no error — indistinguishable from a
      // quiet chat. A manual @bot test disappeared exactly this way: read,
      // filtered, cursor advanced, nothing said.
      const skipped = [];
      const skip = (message, reason) => { skipped.push({ message, reason }); };

      // The bot's own replies are not input: its cards land in the same chat
      // this monitor reads, and delivering them back would feed the session
      // its own output. Only this app's messages are skipped — a person's
      // message is delivered like anyone else's, whoever typed it. Nothing
      // else is fetched to decide this: the sender already carries the App ID.
      // The cursor still covers the whole `fresh` page (see #enqueue), so a
      // skipped message is never re-read; only the delivery shrinks.
      let deliverable = fresh;
      if (latest.skipBotMessages === true) {
        const appId = typeof this.#getAppId === 'function' ? this.#getAppId() : '';
        deliverable = [];
        for (const message of fresh) {
          if (isOwnBotMessage(message, appId)) skip(message, 'bot');
          else deliverable.push(message);
        }
      }
      // Source acceptance. The sender list narrows the stream; two switches
      // widen it back, each by exactly one case. A message that names the bot
      // is accepted even when its sender is not on the list. A message that
      // names the operator is accepted the same way: someone asking a person
      // a question is asking the person, and this monitor answers as them.
      // Being addressed is the signal, not who typed it. Anyone may be the
      // one addressing — only the bot's own messages are filtered, and the
      // bot never mentions itself or its operator.
      const senderIds = Array.isArray(latest.onlySenderIds) ? latest.onlySenderIds : [];
      const wantSenders = senderIds.length > 0;
      const wantMention = latest.alsoBotMention === true;
      const wantOperator = latest.alsoOperatorMention === true;
      const wantAnyMention = wantMention || wantOperator;
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
      // A missing operator id leaves only the @bot rule working; the monitor
      // card reports that, so the switch never looks silently broken.
      const operatorOpenId = wantOperator ? await this.#operatorId(client, signal) : '';
      // `byMention` records the acceptance path, because the keyword rules
      // below treat an addressed message differently from polled traffic.
      const admitted = [];
      for (const message of deliverable) {
        const byMention = (wantMention && mentionsId(message, botOpenId))
          || (wantOperator && Boolean(operatorOpenId) && mentionsId(message, operatorOpenId));
        const bySender = wantSenders && isFromSenders(message, senderIds);
        if (byMention || bySender || (!wantSenders && !wantAnyMention)) {
          admitted.push({ message, byMention });
        } else {
          skip(message, wantSenders ? 'sender' : 'mention');
        }
      }

      // Keyword filters, both checked on the rendered text: a card whose
      // content mentions a keyword is treated exactly like plain text.
      //
      // Neither list applies to a message that names the bot or the
      // operator. Both are rules for traffic the monitor overhears while
      // polling; a message that addresses one of them is a request, and the
      // person typing it has already decided it matters. The blacklist
      // therefore only trims the polled stream, not the direct asks.
      // Filtered messages are consumed, not retried — the cursor advances
      // past them with the rest of `fresh`.
      const allowed = Array.isArray(latest.allowedKeywords) ? latest.allowedKeywords : [];
      const blocked = Array.isArray(latest.blockedKeywords) ? latest.blockedKeywords : [];
      const entries = [];
      for (const entry of admitted) {
        const body = this.#format(latest, entry.message);
        if (!body) {
          skip(entry.message, 'empty');
          continue;
        }
        if (!entry.byMention) {
          if (matchesBlockedKeywords(body, blocked)) {
            skip(entry.message, 'blocked');
            continue;
          }
          if (allowed.length > 0 && !matchesBlockedKeywords(body, allowed)) {
            skip(entry.message, 'allowlist');
            continue;
          }
        }
        entries.push(body);
      }
      if (skipped.length > 0) this.#recordSkips(latest.monitorId, skipped, fresh.length);

      if (entries.length === 0) {
        // Nothing deliverable, but the cursor must still move past them.
        await this.#advance(latest, fresh[fresh.length - 1]);
        return;
      }
      await this.#enqueue(latest, entries, fresh);
    } catch (error) {
      if (this.#closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#setState(monitor.monitorId, { lastError: message, lastPollAt: this.#now() });
      this.#logger.warn?.(
        `[lark-session-monitor] poll failed for ${monitor.monitorId}: ${message}`,
        // The error object keeps the stack in the Host log and startup dumps.
        // The 2026-10-25 incident lost its origin precisely because only the
        // message was recorded: the failure surfaced as a bare TypeError text
        // with no traceable frame.
        error,
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
   * Render one message as a digest entry: `time [sender] [id] content`.
   *
   * The time is what makes a merged batch auditable — a reader of the session
   * can tell which conversation moments the batch spans, and the session
   * side can reason about ordering.
   */
  #format(monitor, message) {
    const rendered = renderMessage(message);
    if (!rendered) return undefined;
    const who = isAppSender(message) ? `${senderLabel(message)}（机器人）` : senderLabel(message);
    const id = typeof message?.message_id === 'string' && message.message_id ? message.message_id : '';
    const time = messageTimeMs(message);
    const stamp = time === null ? '' : formatTimestamp(time);
    const senderPart = `[${who}]`;
    const idPart = id ? ` [${id}]` : '';
    const timePart = stamp ? `${stamp} ` : '';
    return `${timePart}${senderPart}${idPart} ${rendered.text}`;
  }

  /**
   * Queue digest entries and deliver them in merged prompts.
   *
   * The whole page is merged into as few prompts as the batch cap allows,
   * joined by the digest separator. Delivering only the first prompt and
   * advancing anyway would drop the remainder permanently, because the next
   * poll starts after the cursor.
   *
   * Each prompt re-reads the monitor: an auto-created session is written back
   * during the first delivery, and reusing the caller's snapshot would make
   * the next prompt create a second session — silently defeating the "pin the
   * auto-created session" choice.
   *
   * A failed prompt keeps its batch queued and rethrows, so the cursor does
   * not move and the next poll retries the same entries — a busy session is
   * a delay, never a loss. Because a held cursor makes the next poll re-read
   * the same messages, entries are deduplicated by Feishu message id before
   * joining the queue: a retry re-delivers the failed batch exactly once.
   */
  async #enqueue(monitor, entries, fresh) {
    const queue = this.#pending.get(monitor.monitorId) ?? [];
    // Entries arrive as `[time [sender] [id] content]` strings; the message id
    // inside brackets is the dedup key a retry arrives with (a held cursor
    // makes the next poll re-read the same messages).
    const queued = new Set(queue.map((body) => body.match(/\[((?:om_|om)[^\]]+)\]/)?.[1]).filter(Boolean));
    queue.push(...entries.filter((body) => {
      const id = body.match(/\[((?:om_|om)[^\]]+)\]/)?.[1];
      if (!id) return true;
      if (queued.has(id)) return false;
      queued.add(id);
      return true;
    }));
    this.#pending.set(monitor.monitorId, queue);

    let delivered = 0;
    try {
      while (queue.length > 0) {
        const batch = queue.slice(0, MAX_BATCH_SIZE);
        const latest = this.#store.monitor(monitor.monitorId) ?? monitor;
        await this.#deliverer.deliver(latest, batch, this.#controller.signal);
        queue.splice(0, batch.length);
        delivered += batch.length;
      }
    } catch (error) {
      // The failed batch stays at the head of the queue and the cursor stays
      // put: nothing is dropped, the next poll retries.
      this.#setState(monitor.monitorId, { lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    await this.#advance(monitor, fresh[fresh.length - 1]);
    this.#setState(monitor.monitorId, {
      delivered: (this.#state.get(monitor.monitorId)?.delivered ?? 0) + delivered,
      lastError: null,
    });
  }

  /**
   * Record what a round rejected, so the settings page can explain a silence.
   *
   * Only the totals and the newest rejection are kept: the question this
   * answers is "why did nothing arrive?", and storing every skipped message
   * would grow without bound on a busy chat.
   */
  #recordSkips(monitorId, skipped, read) {
    // The newest rejection, not the last one processed: the filters run in
    // stages, so "last pushed" is whichever stage happened to sit furthest
    // down the pipeline rather than what the chat said most recently.
    let last = skipped[0];
    let lastTime = messageTimeMs(last.message) ?? -Infinity;
    for (const entry of skipped) {
      const time = messageTimeMs(entry.message) ?? -Infinity;
      if (time >= lastTime) {
        last = entry;
        lastTime = time;
      }
    }
    const time = messageTimeMs(last.message);
    this.#setState(monitorId, {
      skipped: (this.#state.get(monitorId)?.skipped ?? 0) + skipped.length,
      lastSkip: {
        at: time ?? this.#now(),
        reason: last.reason,
        messageId: typeof last.message?.message_id === 'string' ? last.message.message_id : '',
        sender: senderLabel(last.message),
      },
    });
    const counts = {};
    for (const entry of skipped) counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
    this.#logger.debug?.(
      `[lark-session-monitor] ${monitorId}: read=${read} skipped=`
      + Object.entries(counts).map(([reason, count]) => `${reason}:${count}`).join(','),
    );
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
