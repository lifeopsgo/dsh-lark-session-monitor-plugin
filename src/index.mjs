/**
 * dsh-lark-session-monitor-plugin, Host half.
 *
 * Watches Feishu conversations with the signed-in user's own identity and
 * forwards new messages into a DeepSeek Harness session as a prompt.
 *
 * Why polling and why a user token: Feishu delivers `im.message.receive_v1`
 * to applications, and an application that is not a member of a p2p chat
 * never receives its events. A person's own token can read the conversation,
 * but Feishu offers no user-identity push channel — so the monitor polls.
 *
 * The Host half owns everything stateful: the OAuth grant, the settings
 * document, the poll timer, and prompt delivery. The browser half only
 * renders what this half reports.
 *
 * @module dsh-lark-session-monitor-plugin
 */

import { Authorizer } from './auth.mjs';
import { fetchAppBotOpenId } from './bot-identity.mjs';
import { SessionDeliverer, HarnessGateway } from './deliver.mjs';
import { listInventory, listWorkspaceTargets } from './inventory.mjs';
import { LarkUserClient } from './lark-api.mjs';
import { distinctSenders } from './normalize.mjs';
import { MonitorRuntime } from './runtime.mjs';
import { registerSettingsRpc } from './rpc.mjs';
import { MonitorStore, publicSettings } from './store.mjs';

export const name = 'dsh-lark-session-monitor-plugin';

/**
 * Services this plugin requires before `apply` runs.
 *
 * `connection` is a hard dependency: it carries the settings endpoint, and
 * Cordis refuses a bare `ctx.connection` read without it ("cannot get property
 * \"connection\" without inject"). Everything else is read optionally through
 * `ctx.get`, so a Host missing `storage` or `credentials` still mounts the
 * plugin and can report the degradation.
 */
export const inject = ['connection'];

/**
 * Defaults for the configurable surface.
 *
 * Declared as plain values rather than a Schemastery schema on purpose: this
 * package is installed by path, and a schema import would make the plugin
 * depend on how the profile hoists `@deepseek-ai/schemastery`. The shipped IM
 * plugin takes the same route, and it keeps the package self-contained.
 * Everything here is still overridable from `cordis.patch.yml`.
 */
const DEFAULT_CONFIG = Object.freeze({
  rpcAuthority: 'trusted-host',
  autoStart: true,
  maxChats: 500,
});

function resolveConfig(input) {
  const config = input && typeof input === 'object' ? input : {};
  return {
    rpcAuthority: config.rpcAuthority === 'loopback' ? 'loopback' : DEFAULT_CONFIG.rpcAuthority,
    autoStart: config.autoStart === false ? false : DEFAULT_CONFIG.autoStart,
    maxChats: Number.isFinite(config.maxChats) && config.maxChats > 0
      ? Math.trunc(config.maxChats)
      : DEFAULT_CONFIG.maxChats,
  };
}

/**
 * Resolve an optional service.
 *
 * Optional rather than injected so the plugin still mounts on a Host that
 * lacks one of them; each absence is logged where it matters instead of
 * failing the whole loader entry.
 */
function optional(ctx, key) {
  if (typeof ctx.get === 'function') return ctx.get(key);
  return ctx[key];
}

/**
 * Milliseconds until a monitor is polled again.
 *
 * Read through the store on every read so a settings change applies to the
 * next interval without restarting the Host.
 */
function intervalReader(store) {
  return () => store.snapshot().pollIntervalMs;
}

export function apply(ctx, config) {
  const settings = resolveConfig(config);
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : console;

  const credentials = optional(ctx, 'credentials');
  if (!credentials) {
    logger.warn?.('[lark-session-monitor] credentials service unavailable; authorization cannot persist');
  }

  // Settings persist to a plain file under $DSH_HOME/plugin-data; no Host
  // service is required for them.
  const store = new MonitorStore();
  const authorizer = new Authorizer({ credentials, store });
  const runtime = { current: null };
  const chats = { cache: new Map(), at: 0 };

  const harnessGateway = () => {
    const gateway = optional(ctx, 'typertGateway');
    if (!gateway) throw new Error('Host Typert gateway is unavailable.');
    return new HarnessGateway({ gateway });
  };

  // Built lazily: the gateway is only needed once a delivery or target lookup
  // actually happens, so a Host without it can still load the plugin and show
  // its settings instead of failing the whole mount.
  let delivererInstance = null;
  const deliverer = {
    deliver: (monitor, bodies, signal) => {
      if (!delivererInstance) {
        delivererInstance = new SessionDeliverer({
          harness: harnessGateway(),
          store,
          logger,
          // Delivery resolves workspaces from the registry, the same source
          // the picker reads, plus the archived ids that distinguish a deleted
          // target from a misconfigured one.
          readInventory: async () => listInventory(ctx),
        });
      }
      return delivererInstance.deliver(monitor, bodies, signal);
    },
    forget: (monitorId) => delivererInstance?.forget(monitorId),
  };

  /** A client whose token provider is the authorizer, rebuilt per domain. */
  const clientFor = () => {
    const app = store.snapshot().app;
    return new LarkUserClient({
      domain: app.domain,
      getToken: async () => authorizer.accessToken(),
      onAuthFailure: () => {
        logger.warn?.('[lark-session-monitor] Feishu rejected the user token; re-authorize in settings');
      },
    });
  };

  const start = () => {
    if (runtime.current) return;
    const instance = new MonitorRuntime({
      store,
      deliverer,
      getClient: async () => clientFor(),
      getIntervalMs: intervalReader(store),
      logger,
      // The @机器人 acceptance path needs the app bot's own open_id; the
      // stored appId/appSecret pair is the only bridge to it. Fetched
      // lazily, at most once per process, and only when a monitor uses the
      // switch.
      getBotOpenId: ({ signal }) => {
        const app = store.snapshot().app;
        return fetchAppBotOpenId({
          appId: app.appId,
          appSecret: app.appSecret,
          domain: app.domain,
          signal,
        });
      },
    });
    instance.start();
    runtime.current = instance;
  };

  const stop = () => {
    runtime.current?.stop();
    runtime.current = null;
  };

  // ---- settings endpoint ------------------------------------------------

  const requireAuthorized = async () => {
    const state = await authorizer.authorizationState();
    if (!state.authorized) {
      const error = new Error('尚未完成飞书授权，请先授权。');
      error.code = 'not-authorized';
      throw error;
    }
  };

  const cachedChats = async (force = false) => {
    const now = Date.now();
    // The chat list changes rarely; a minute of caching keeps the settings
    // page responsive while typing without hammering the Feishu API.
    if (!force && chats.cache.size > 0 && now - chats.at < 60_000) return [...chats.cache.values()];
    await requireAuthorized();
    const list = await clientFor().listChats();
    chats.cache = new Map(list.map((chat) => [chat.chatId, chat]));
    chats.at = now;
    return list;
  };

  const endpoint = {
    async 'settings.get'() {
      const settings = publicSettings(store.snapshot());
      const auth = await authorizer.authorizationState();
      return { settings, authorization: auth, runtime: runtime.current ? runtime.current.status() : [] };
    },

    async 'settings.save'(payload) {
      const patch = payload ?? {};
      // `saveApp` treats an empty secret as "leave it alone", so the whole
      // patch can be forwarded as-is; no branch is needed to protect the
      // stored credential from a settings save that omits it.
      await store.saveApp({
        appId: patch.appId,
        appSecret: patch.appSecret,
        domain: patch.domain,
        pollIntervalMs: patch.pollIntervalMs,
      });
      // A changed interval applies from the next tick.
      runtime.current?.reschedule();
      if (store.snapshot().app.appId) {
        if (settings.autoStart) start();
      } else {
        stop();
      }
      return publicSettings(store.snapshot());
    },

    async 'auth.begin'() {
      const app = store.snapshot().app;
      if (!app.appId || !app.appSecret) {
        const error = new Error('请先填写并保存飞书 App ID 与 App Secret。');
        error.code = 'invalid-argument';
        throw error;
      }
      return authorizer.begin();
    },

    async 'auth.complete'(payload) {
      const deviceCode = typeof payload?.deviceCode === 'string' ? payload.deviceCode : '';
      if (!deviceCode) {
        const error = new Error('缺少 deviceCode。');
        error.code = 'invalid-argument';
        throw error;
      }
      const outcome = await authorizer.complete(deviceCode);
      if (outcome.status === 'authorized' && settings.autoStart) start();
      return outcome;
    },

    async 'auth.signOut'() {
      await authorizer.signOut();
      chats.cache = new Map();
      stop();
      return { signedOut: true };
    },

    async 'chat.list'(payload) {
      const force = payload?.force === true;
      const list = await cachedChats(force);
      const limit = settings.maxChats;
      return { chats: list.slice(0, limit), truncated: list.length > limit };
    },

    /**
     * Senders observed in a conversation, for the source picker.
     *
     * Candidates come from the last week of messages through the same
     * user-token read the poller uses — no extra scope, and a member who
     * has never spoken simply is not offered as a choice.
     */
    async 'chat.senders'(payload, signal) {
      const chatId = typeof payload?.chatId === 'string' ? payload.chatId : '';
      if (!chatId) {
        const error = new Error('缺少 chatId。');
        error.code = 'invalid-argument';
        throw error;
      }
      await requireAuthorized();
      const now = Date.now();
      const messages = await clientFor().listMessages({
        chatId,
        startTimeSeconds: Math.floor((now - 7 * 24 * 60 * 60 * 1000) / 1000),
        endTimeSeconds: Math.floor(now / 1000) + 1,
        maxMessages: 200,
        signal,
      });
      return { senders: distinctSenders(messages) };
    },

    async 'monitor.save'(payload) {
      const monitor = await store.upsertMonitor(payload ?? {});
      if (monitor.enabled !== false && settings.autoStart) start();
      runtime.current?.reschedule();
      return monitor;
    },

    async 'monitor.delete'(payload) {
      const monitorId = typeof payload?.monitorId === 'string' ? payload.monitorId : '';
      if (!monitorId) {
        const error = new Error('缺少 monitorId。');
        error.code = 'invalid-argument';
        throw error;
      }
      const result = await store.removeMonitor(monitorId);
      runtime.current?.forget(monitorId);
      return result;
    },

    /** Reset a monitor's cursor so the next poll re-reads recent history. */
    async 'monitor.reset'(payload) {
      const monitorId = typeof payload?.monitorId === 'string' ? payload.monitorId : '';
      const monitor = store.monitor(monitorId);
      if (!monitor) {
        const error = new Error('监听不存在。');
        error.code = 'unknown-monitor';
        throw error;
      }
      await store.advanceCursor(monitorId, {
        lastCreateTimeMs: payload?.sinceMs ?? (Date.now() - 10 * 60_000),
        lastMessageId: '',
      });
      runtime.current?.forget(monitorId);
      return store.monitor(monitorId);
    },

    /** Poll once, on demand, for a monitor or every enabled monitor. */
    async 'monitor.pollNow'(payload) {
      if (!runtime.current) start();
      if (!runtime.current) {
        const error = new Error('轮询未启动，请先完成授权。');
        error.code = 'not-authorized';
        throw error;
      }
      const monitorId = typeof payload?.monitorId === 'string' ? payload.monitorId : undefined;
      if (monitorId) {
        const monitor = store.monitor(monitorId);
        if (!monitor) {
          const error = new Error('监听不存在。');
          error.code = 'unknown-monitor';
          throw error;
        }
        await runtime.current.pollMonitor(monitor, new AbortController().signal);
      } else {
        await runtime.current.poll();
      }
      return runtime.current.status();
    },

    /** Workspaces and their sessions, for the delivery-target picker. */
    async 'target.list'(payload, signal) {
      // Read the registry directly. The Remote `workspace.follow` stream is
      // the documented path, but it must be opened, read once and aborted, and
      // on this Host that read answered empty while the registry held twenty
      // workspaces — the picker showed "0" against a fully populated Host.
      void payload;
      return { workspaces: await listWorkspaceTargets(ctx, signal) };
    },
  };

  ctx.effect(() => {
    const dispose = registerSettingsRpc(ctx, async (method, payload, signal) => {
      void signal;
      if (!Object.hasOwn(endpoint, method)) {
        const error = new Error(`未知的接口：${method}`);
        error.code = 'bad-request';
        throw error;
      }
      return endpoint[method](payload, signal);
    }, { authority: settings.rpcAuthority });
    return () => dispose?.();
  }, 'dsh-lark-session-monitor-plugin: settings endpoint');

  /**
   * Log what the workspace read actually returns.
   *
   * The picker and delivery both read the registry now, so this reports that
   * same source. Without it, a reader that silently resolves nothing is
   * indistinguishable from a Host that genuinely has no workspaces — which is
   * exactly how the empty picker went unnoticed.
   */
  const reportWorkspaceRead = () => {
    try {
      const inventory = listInventory(ctx);
      logger.info?.(
        `[lark-session-monitor] workspace read: workspaces=${inventory.workspaces.length}`
        + ` archived=${inventory.archivedSessionIds.length}`
        + ` first=${inventory.workspaces[0] ? inventory.workspaces[0].path : 'none'}`,
      );
      if (inventory.workspaces.length === 0) {
        logger.warn('[lark-session-monitor] no workspaces resolved; the target picker will be empty');
      }
    } catch (error) {
      logger.error?.('[lark-session-monitor] workspace read unavailable', error);
    }
  };

  // ---- lifecycle --------------------------------------------------------

  ctx.effect(() => {
    let disposed = false;
    // `open()` reads the persisted document; polling starts only after the
    // document is loaded, or the first round would see an empty monitor list.
    store.open()
      .then(() => {
        if (disposed) return;
        const app = store.snapshot().app;
        logger.info?.(
          `[lark-session-monitor] settings loaded: monitors=${store.monitors().length}`
          + ` appId=${app.appId ? 'set' : 'unset'} secret=${app.appSecret ? 'set' : 'unset'}`,
        );
        if (settings.autoStart && app.appId && app.appSecret) start();
      })
      .catch((error) => {
        logger.error?.('[lark-session-monitor] failed to load settings', error);
      });
    // One startup probe: the workspace list is what the picker shows, and an
    // empty result is indistinguishable from "no workspaces exist" without it.
    void reportWorkspaceRead();
    return () => {
      disposed = true;
      stop();
    };
  }, 'dsh-lark-session-monitor-plugin: runtime lifecycle');
}

export { MonitorStore, publicSettings };
