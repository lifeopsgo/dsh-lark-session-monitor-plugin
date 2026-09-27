/**
 * Durable plugin configuration: the app credentials, the monitor list, and the
 * per-monitor cursor.
 *
 * Persistence is a JSON file under `$DSH_HOME/plugin-data/<plugin>`, written
 * atomically (temp file + rename) and loaded once at open. This replaced an
 * earlier attempt to use the Host's `storage` domain facility: that API is
 * typed around `KvUnit` (`loadAll`/`setGlobal`), while the handle `open()`
 * returns exposes only `table()`/`close()`. Every write threw a TypeError
 * inside a swallowed promise, so settings silently failed to persist at all —
 * the settings page looked fine until a restart. A plain file has no such
 * contract to get wrong.
 *
 * @module dsh-lark-session-monitor-plugin/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const STORE_VERSION = 1;

/** The shortest polling cadence a user may configure, in milliseconds. */
export const MIN_POLL_INTERVAL_MS = 2_000;

/** Shape one monitor id must have; also used to reject hand-edited values. */
const MONITOR_ID_PATTERN = /^mon_[0-9a-f]{16}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function newMonitorId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `mon_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function isValidMonitorId(value) {
  return typeof value === 'string' && MONITOR_ID_PATTERN.test(value);
}

/**
 * Normalize one monitor.
 *
 * Unknown fields are dropped rather than carried: a settings document that
 * used to hold a field this version no longer understands must not resurrect
 * it on the next write.
 */
function normalizeMonitor(input, { existing } = {}) {
  if (!isRecord(input)) return undefined;
  const chatId = nonEmptyString(input.chatId);
  const prompt = nonEmptyString(input.prompt);
  const workspace = nonEmptyString(input.workspace);
  if (!chatId || !prompt) return undefined;
  // The picker offers ids observed in this conversation, so they are
  // whatever the chat reads carry as `sender.id`: a user's open_id or an
  // app's app_id.
  const onlySenderIds = [];
  if (Array.isArray(input.onlySenderIds)) {
    for (const value of input.onlySenderIds) {
      const id = nonEmptyString(value);
      if (id && !onlySenderIds.includes(id)) onlySenderIds.push(id);
    }
  }
  const monitor = {
    monitorId: isValidMonitorId(input.monitorId) ? input.monitorId : newMonitorId(),
    name: nonEmptyString(input.name) ?? '',
    chatId,
    chatName: nonEmptyString(input.chatName) ?? '',
    prompt,
    workspace: workspace ?? '',
    sessionId: nonEmptyString(input.sessionId) ?? '',
    sessionTitle: nonEmptyString(input.sessionTitle) ?? '',
    /**
     * Only meaningful while `sessionId` is empty.
     *
     * `false` (default): every delivery creates a new session.
     * `true`: the first delivery creates one and pins it, so later messages
     * accumulate in that session — the choice between "one document per
     * message" and "one running conversation".
     */
    autoCreateAndPin: input.autoCreateAndPin === true,
    /**
     * `false` (default): messages you sent yourself are delivered like
     * anyone else's. `true`: they are skipped, so the session receives what
     * other people say without your own echoes.
     */
    skipOwnMessages: input.skipOwnMessages === true,
    /**
     * Restrict this monitor to specific senders; an empty list means
     * everyone. Ids round-trip with the picker built from observed
     * messages.
     */
    onlySenderIds,
    /**
     * `false` (default): the sender list alone decides. `true`: messages
     * that @-mention this app's own bot are also accepted, even from a
     * sender outside the list — being addressed is the signal, not who
     * typed it. An empty list plus this switch means only @bot messages.
     */
    alsoBotMention: input.alsoBotMention === true,
    enabled: input.enabled !== false,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  // The cursor belongs to the monitor, not to the settings form: a save from
  // the settings page must never rewind polling to the top of a conversation.
  const cursor = existing?.cursor ?? cursorFrom(input.cursor);
  monitor.cursor = cursor;
  return monitor;
}

function cursorFrom(input) {
  if (!isRecord(input)) return {};
  const lastMessageId = nonEmptyString(input.lastMessageId);
  const lastCreateTimeMs = Number.isFinite(input.lastCreateTimeMs)
    ? Math.trunc(input.lastCreateTimeMs)
    : undefined;
  const cursor = {};
  if (lastMessageId) cursor.lastMessageId = lastMessageId;
  if (lastCreateTimeMs !== undefined) cursor.lastCreateTimeMs = lastCreateTimeMs;
  return cursor;
}

export function normalizeMonitors(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const monitors = [];
  for (const entry of input) {
    const monitor = normalizeMonitor(entry);
    if (!monitor || seen.has(monitor.monitorId)) continue;
    seen.add(monitor.monitorId);
    monitors.push(monitor);
  }
  return monitors;
}

/** Normalize the whole settings document. */
export function normalizeSettings(input) {
  const source = isRecord(input) ? input : {};
  const app = isRecord(source.app) ? source.app : {};
  return {
    version: STORE_VERSION,
    app: {
      appId: nonEmptyString(app.appId) ?? '',
      appSecret: nonEmptyString(app.appSecret) ?? '',
      domain: app.domain === 'lark' ? 'lark' : 'feishu',
    },
    pollIntervalMs: Number.isFinite(source.pollIntervalMs)
      ? Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(source.pollIntervalMs))
      : 30_000,
    monitors: normalizeMonitors(source.monitors),
  };
}

/** Where the settings document lives. */
export const SETTINGS_FILE_NAME = 'settings.json';

/** `$DSH_HOME/plugin-data/<plugin>/settings.json`, matching other plugins. */
export function settingsPath(env = process.env) {
  const root = env.DSH_HOME || join(homedir(), '.dsh');
  return join(root, 'plugin-data', 'dsh-lark-session-monitor-plugin', SETTINGS_FILE_NAME);
}

/**
 * Immutable settings store with a serialized write path.
 *
 * Every mutation runs through {@link #write}, so two concurrent settings
 * actions cannot interleave a read and a write and lose one of the edits.
 */
export class MonitorStore {
  #file;
  #loaded = false;
  #settings = normalizeSettings({});
  #writeChain = Promise.resolve();

  constructor({ file = settingsPath() } = {}) {
    this.#file = file;
  }

  /** Whether this store can persist; the file path is always available. */
  get persistent() {
    return Boolean(this.#file);
  }

  /** Read the document. A missing or unreadable file starts from defaults. */
  async open() {
    if (!this.#file) {
      this.#settings = normalizeSettings({});
      return this.snapshot();
    }
    try {
      const text = await readFile(this.#file, 'utf8');
      this.#settings = normalizeSettings(JSON.parse(text));
    } catch (error) {
      // A missing file is the first run. A corrupt one must not take the
      // plugin down, but it is worth surfacing rather than silently resetting:
      // the previous settings are still on disk for inspection.
      if (error?.code !== 'ENOENT') {
        console.warn(
          `[lark-session-monitor] settings at ${this.#file} could not be read; starting from defaults`,
          error?.message ?? error,
        );
      }
      this.#settings = normalizeSettings({});
    }
    this.#loaded = true;
    return this.snapshot();
  }

  /** The current settings, deep-copied so callers cannot mutate stored state. */
  snapshot() {
    return cloneJson(this.#settings);
  }

  monitors() {
    return this.#settings.monitors.map((monitor) => cloneJson(monitor));
  }

  monitor(monitorId) {
    const found = this.#settings.monitors.find((m) => m.monitorId === monitorId);
    return found ? cloneJson(found) : undefined;
  }

  /**
   * Serialize one mutation and persist the result.
   *
   * The write is atomic (temp file + rename) so a crash mid-write cannot leave
   * a half-written document that the next boot would read as corrupt.
   */
  #write(mutate) {
    const run = this.#writeChain.then(async () => {
      const draft = cloneJson(this.#settings);
      const result = mutate(draft);
      this.#settings = normalizeSettings(draft);
      await this.#persist();
      return result;
    });
    // Keep the chain alive even when one mutation rejects.
    this.#writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async #persist() {
    if (!this.#file) return;
    const body = `${JSON.stringify(this.#settings, null, 2)}\n`;
    const temp = `${this.#file}.tmp`;
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
    // Rename is atomic on the same filesystem, so a reader never sees a
    // partial document.
    await rename(temp, this.#file);
  }

  saveApp({ appId, appSecret, domain, pollIntervalMs }) {
    return this.#write((draft) => {
      if (appId !== undefined) draft.app.appId = nonEmptyString(appId) ?? '';
      // An empty secret means "leave the stored one alone", not "erase it".
      // The settings page never receives the secret back, so it always posts
      // an empty field; treating that as a clear would delete the credential
      // on any unrelated save.
      if (appSecret !== undefined) {
        const next = nonEmptyString(appSecret);
        if (next !== undefined) draft.app.appSecret = next;
      }
      if (domain !== undefined) draft.app.domain = domain === 'lark' ? 'lark' : 'feishu';
      if (pollIntervalMs !== undefined && Number.isFinite(pollIntervalMs)) {
        draft.pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(pollIntervalMs));
      }
      return cloneJson(draft.app);
    });
  }

  /**
   * Create or update one monitor.
   *
   * The existing record is merged in (rather than replaced) so a settings save
   * that omits `cursor` keeps the polling position.
   */
  upsertMonitor(input) {
    return this.#write((draft) => {
      const requestedId = isValidMonitorId(input?.monitorId) ? input.monitorId : undefined;
      const index = requestedId
        ? draft.monitors.findIndex((m) => m.monitorId === requestedId)
        : -1;
      const existing = index >= 0 ? draft.monitors[index] : undefined;
      const monitor = normalizeMonitor({ ...existing, ...input }, { existing });
      if (!monitor) throw new Error('监听配置不完整：会话与 Prompt 为必填项。');
      // A monitor update must never move the cursor backwards.
      if (existing) draft.monitors[index] = monitor;
      else draft.monitors.push(monitor);
      return cloneJson(monitor);
    });
  }

  removeMonitor(monitorId) {
    return this.#write((draft) => {
      const before = draft.monitors.length;
      draft.monitors = draft.monitors.filter((m) => m.monitorId !== monitorId);
      if (draft.monitors.length === before) throw new Error('监听不存在或已被删除。');
      return { deleted: true };
    });
  }

  /** Advance one monitor's polling cursor; ignored if the monitor is gone. */
  advanceCursor(monitorId, cursor) {
    return this.#write((draft) => {
      const index = draft.monitors.findIndex((m) => m.monitorId === monitorId);
      if (index < 0) return undefined;
      const current = draft.monitors[index].cursor ?? {};
      const next = cursorFrom(cursor);
      draft.monitors[index].cursor = {
        ...current,
        ...next,
        // Never move the high-water mark backwards.
        lastCreateTimeMs: Math.max(
          current.lastCreateTimeMs ?? 0,
          next.lastCreateTimeMs ?? 0,
        ) || undefined,
      };
      return cloneJson(draft.monitors[index].cursor);
    });
  }

  /** Record the session a monitor delivers into, after an auto-create. */
  setMonitorSession(monitorId, { sessionId, sessionTitle }) {
    return this.#write((draft) => {
      const index = draft.monitors.findIndex((m) => m.monitorId === monitorId);
      if (index < 0) return undefined;
      if (sessionId !== undefined) draft.monitors[index].sessionId = nonEmptyString(sessionId) ?? '';
      if (sessionTitle !== undefined) {
        draft.monitors[index].sessionTitle = nonEmptyString(sessionTitle) ?? '';
      }
      return cloneJson(draft.monitors[index]);
    });
  }
}

/** Redact the app secret for anything that crosses to the browser. */
export function publicSettings(settings) {
  return {
    version: settings.version,
    app: {
      appId: settings.app.appId,
      domain: settings.app.domain,
      hasSecret: Boolean(settings.app.appSecret),
    },
    pollIntervalMs: settings.pollIntervalMs,
    monitors: settings.monitors.map(publicMonitor),
  };
}

export function publicMonitor(monitor) {
  return {
    monitorId: monitor.monitorId,
    name: monitor.name,
    chatId: monitor.chatId,
    chatName: monitor.chatName,
    prompt: monitor.prompt,
    workspace: monitor.workspace,
    sessionId: monitor.sessionId,
    sessionTitle: monitor.sessionTitle,
    autoCreateAndPin: monitor.autoCreateAndPin === true,
    skipOwnMessages: monitor.skipOwnMessages === true,
    onlySenderIds: [...(monitor.onlySenderIds ?? [])],
    alsoBotMention: monitor.alsoBotMention === true,
    enabled: monitor.enabled !== false,
  };
}
