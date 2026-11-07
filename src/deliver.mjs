/**
 * Deliver one batch of messages into a DeepSeek Harness session.
 *
 * Delivery resolves the configured session from the workspace registry and
 * then prompts it directly: `session.prompt` itself resumes a dormant session
 * and queues into a live one. No `session.create` is involved — the Host's
 * create claims a requested id only while the session is still blank, and
 * mints a fresh session with a new id once any turn has run, so delivering
 * through create lands the message in a session the user never chose.
 *
 * The prompt is submitted with `mode: 'queue'`, matching how the IM channels
 * deliver: a monitor must never interrupt a turn that is already running in
 * the target session.
 *
 * @module dsh-lark-session-monitor-plugin/deliver
 */

import { composePrompt } from './normalize.mjs';
import { isArchivedSession, isKnownSession } from './inventory.mjs';

const PROMPT_TIMEOUT_MS = 30_000;
const PROMPT_RPC_TIMEOUT_MS = 600_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unwrapRemote(value) {
  const result = value?.result ?? value;
  if (isRecord(result) && result.ok === false) {
    const error = new Error(result.error?.message ?? 'Harness 远程调用失败');
    error.code = result.error?.code;
    throw error;
  }
  if (isRecord(result) && 'value' in result) return result.value;
  return result;
}

/**
 * Thin wrapper over the Host's Typert gateway, exposing only the operations
 * delivery needs. Kept structural rather than importing the controller
 * package: the gateway is the documented seam and its shape is stable across
 * harness lines.
 *
 * `workspace.list` is not an invokable method — the workspace controller
 * exposes it as a *stream* (`workspace.follow`), whose first frame carries the
 * baseline. Reading only that first frame and closing the iterator is what the
 * shipped IM plugin does, and it is why this class holds the stream helper.
 */
export class HarnessGateway {
  #gateway;
  #requestIdPrefix;
  #peer;

  constructor({ gateway, peer, requestIdPrefix = 'lark-monitor' }) {
    if (!gateway || typeof gateway.invoke !== 'function') {
      throw new TypeError('Host Typert gateway is required');
    }
    // Every gateway call names the Peer it speaks for. The Host reads
    // `peer.signal` before it touches the method, so a call without one dies
    // with "Cannot read properties of undefined (reading 'signal')" — the
    // error this class used to produce on the first delivery of each batch.
    this.#peer = peer;
    this.#gateway = gateway;
    this.#requestIdPrefix = requestIdPrefix;
  }

  async #invoke(namespace, method, args, signal) {
    const value = await this.#gateway.invoke({
      namespace,
      method,
      args,
      ...(this.#peer === undefined ? {} : { peer: this.#peer }),
      ...(signal === undefined ? {} : { signal }),
    });
    return unwrapRemote(value);
  }

  /** Read the first frame of a stream method, then close the iterator. */
  async #streamFirst(namespace, method, args, signal) {
    if (typeof this.#gateway.stream !== 'function') {
      throw new TypeError('Host Typert gateway does not support streaming');
    }
    const controller = new AbortController();
    const streamSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let iterator;
    try {
      const source = await this.#gateway.stream({
        namespace,
        method,
        args,
        ...(this.#peer === undefined ? {} : { peer: this.#peer }),
        signal: streamSignal,
      });
      iterator = source[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) {
        throw new Error(`Harness ${namespace}.${method} stream ended before its baseline`);
      }
      return first.value;
    } finally {
      // The baseline is all we need; abort so the Host stops following.
      controller.abort(new DOMException('Baseline received', 'AbortError'));
      await Promise.resolve(iterator?.return?.()).catch(() => undefined);
    }
  }

  async listWorkspaces(signal) {
    const frame = await this.#streamFirst('workspace', 'follow', {}, signal);
    if (frame?.type !== 'baseline' || !isRecord(frame.value)) {
      throw new Error('Harness workspace.follow returned no baseline');
    }
    return Array.isArray(frame.value.items) ? frame.value.items : [];
  }

  async listSessions(signal) {
    const value = await this.#invoke('session', 'list', { _request: {} }, signal);
    const items = Array.isArray(value) ? value : value?.items;
    return Array.isArray(items) ? items : [];
  }

  async createSession({ workspaceId, sessionId, agentPreset }, signal) {
    const request = { workspaceId };
    if (sessionId) request.sessionId = sessionId;
    if (agentPreset) request.agentPreset = agentPreset;
    return this.#invoke('session', 'create', { request }, signal);
  }

  async prompt({ sessionId, text, rpcId }, signal) {
    return this.#invoke('session', 'prompt', {
      request: {
        requestId: rpcId ?? `${this.#requestIdPrefix}-${Date.now()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    }, signal);
  }
}

/**
 * Resolve which workspace declares a session id.
 *
 * Uses the shared inventory predicate so this agrees with the picker: two
 * different notions of "which workspace owns this session" is how a target
 * that looks selectable ends up failing to resolve.
 */
function workspaceForSession(sessionId, workspaces) {
  const owners = isKnownSession(workspaces, sessionId);
  if (owners.length === 0) {
    const error = new Error('目标会话不属于任何 Harness 工作区，请确认 Session ID。');
    error.code = 'session-not-registered';
    throw error;
  }
  if (owners.length > 1) {
    const error = new Error('目标会话归属多个工作区，暂时无法绑定。');
    error.code = 'session-workspace-ambiguous';
    throw error;
  }
  return owners[0];
}

/**
 * Owns target resolution and prompt delivery for the monitor runtime.
 *
 * Auto-create is deliberately narrow: it only replaces a session the Host
 * says no longer exists, and it is rate-limited per monitor so a broken
 * configuration cannot spawn sessions on every poll.
 */
export class SessionDeliverer {
  #harness;
  #store;
  #logger;
  #autoCreatedAt = new Map();
  #now;
  #autoCreateCooldownMs;
  #readInventory;

  constructor({
    harness,
    store,
    logger = console,
    now = Date.now,
    autoCreateCooldownMs = 5 * 60_000,
    /**
     * Workspace inventory reader.
     *
     * Defaults to the Remote gateway, but the Host injects a direct registry
     * read: on the live Host the `workspace.follow` stream answered empty
     * while the registry held twenty workspaces, and delivery needs the same
     * answer the picker shows.
     */
    readInventory = async (signal) => ({
      workspaces: await harness.listWorkspaces(signal),
      archivedSessionIds: [],
    }),
  }) {
    this.#harness = harness;
    this.#store = store;
    this.#logger = logger;
    this.#now = now;
    this.#autoCreateCooldownMs = autoCreateCooldownMs;
    this.#readInventory = readInventory;
  }

  /**
   * Prove the monitor's session is registered, then hand its id back for the
   * prompt. The prompt method itself resumes a dormant session and queues
   * into a live one, so nothing else is needed here.
   *
   * A `session.create` call must never be made for a configured target: the
   * Host's create claims the requested id only while the session is still
   * blank, and mints a fresh session once any turn has run — delivering
   * through create is how messages landed in sessions the user never chose.
   *
   * Existence is checked because a deleted session should surface here as
   * `session-summary-unavailable`, the one condition the caller is allowed
   * to recover from, instead of as an opaque prompt failure.
   */
  async #requireSession(monitor, signal) {

    // A session counts as existing when a workspace declares it, not when it
    // is currently open: the live store holds only the handful of active
    // sessions, while a workspace lists its whole history. Checking the live
    // store alone would call a perfectly good historical session "deleted"
    // and auto-create a replacement.
    const inventory = await this.#readInventory(signal);
    const workspaces = inventory.workspaces;
    const owners = isKnownSession(workspaces, monitor.sessionId);
    if (owners.length === 0) {
      // Distinguish the two ways a session is absent. An archived session was
      // deleted and is recoverable by creating a new one; an id no workspace
      // ever declared is a misconfiguration, and auto-creating would appear to
      // fix it while delivering somewhere the user never chose.
      if (isArchivedSession(inventory, monitor.sessionId)) {
        const error = new Error('目标会话已不存在。');
        error.code = 'session-summary-unavailable';
        throw error;
      }
      const error = new Error('目标会话不属于任何 Harness 工作区，请确认 Session ID。');
      error.code = 'session-not-registered';
      throw error;
    }
    // Ambiguous ownership is refused even though the prompt only needs the
    // id: the same target must not be silently accepted here while the picker
    // refuses to offer it.
    workspaceForSession(monitor.sessionId, workspaces);
    return monitor.sessionId;
  }

  /** Replace a session the Host reports as gone, at most once per cooldown. */
  async #recreate(monitor, signal) {
    const last = this.#autoCreatedAt.get(monitor.monitorId) ?? 0;
    if (this.#now() - last < this.#autoCreateCooldownMs) {
      const error = new Error('目标会话已不存在，且刚刚自动新建过，请稍后重试。');
      error.code = 'session-recreate-throttled';
      throw error;
    }
    if (!monitor.workspace) {
      const error = new Error('目标会话已不存在，且监听未配置工作区，无法自动新建。');
      error.code = 'session-recreate-no-workspace';
      throw error;
    }
    const workspaces = (await this.#readInventory(signal)).workspaces;
    const workspace = workspaces.find((item) => (item.path ?? item.workspace?.path) === monitor.workspace);
    if (!workspace) {
      const error = new Error(`工作区不存在：${monitor.workspace}`);
      error.code = 'workspace-not-found';
      throw error;
    }
    this.#autoCreatedAt.set(monitor.monitorId, this.#now());
    const created = await this.#harness.createSession({
      workspaceId: workspace.workspaceId ?? workspace.id,
    }, signal);
    const sessionId = created?.sessionId;
    if (!sessionId) {
      const error = new Error('自动新建会话失败：Harness 未返回 sessionId。');
      error.code = 'session-create-failed';
      throw error;
    }
    await this.#store.setMonitorSession(monitor.monitorId, { sessionId, sessionTitle: '' });
    this.#logger.warn?.(
      `[lark-session-monitor] monitor ${monitor.monitorId} auto-created session ${sessionId}`,
    );
    return sessionId;
  }

  /**
   * Whether a failed resolution means "the session is gone" rather than "the
   * configuration is wrong".
   *
   * Only a deleted session is recoverable by creating a new one. A session
   * that no workspace declares, or that two workspaces claim, is a
   * misconfiguration: auto-creating would appear to fix it while silently
   * delivering into a session the user never chose.
   */
  #isMissingSession(error) {
    return error?.code === 'session-not-found'
      || error?.code === 'session-summary-unavailable';
  }

  /**
   * Deliver one batch.
   *
   * `bodies` are already-rendered message texts; they are joined under the
   * monitor's prompt in arrival order.
   *
   * An empty `sessionId` selects one of two auto modes, decided by
   * `autoCreateAndPin`:
   *
   * - `false`: each delivery creates a fresh session and does not write it
   *   back, so every batch gets its own session ("one document per message").
   * - `true`: the first delivery creates a session and pins it to the monitor,
   *   so later messages accumulate in the same conversation. Writing the id
   *   back is exactly what distinguishes it from the per-message mode.
   */
  async deliver(monitor, bodies, signal) {
    if (bodies.length === 0) return { delivered: 0 };
    if (!monitor.sessionId && !monitor.workspace) {
      const error = new Error('监听未绑定目标会话，且未配置工作区，无法新建会话。');
      error.code = 'monitor-target-missing';
      throw error;
    }
    const text = composePrompt(monitor.prompt, bodies.join('\n\n'));
    let sessionId;
    if (!monitor.sessionId) {
      sessionId = await this.#createInWorkspace(monitor, signal);
      if (monitor.autoCreateAndPin === true) {
        await this.#store.setMonitorSession(monitor.monitorId, { sessionId, sessionTitle: '' });
        this.#logger.info?.(
          `[lark-session-monitor] monitor ${monitor.monitorId} pinned a new session ${sessionId}`,
        );
      }
    } else {
      try {
        sessionId = await this.#requireSession(monitor, signal);
      } catch (error) {
        if (!this.#isMissingSession(error)) throw error;
        sessionId = await this.#recreate(monitor, signal);
      }
    }
    await this.#harness.prompt({ sessionId, text }, signal);
    return { delivered: bodies.length, sessionId };
  }

  /**
   * Create a session in the monitor's workspace without persisting its id.
   *
   * Used by the per-message mode. Writing the id back would silently collapse
   * that mode into the single-target mode after the first delivery.
   */
  async #createInWorkspace(monitor, signal) {
    const workspaces = (await this.#readInventory(signal)).workspaces;
    const workspace = workspaces.find((item) => (item.path ?? item.workspace?.path) === monitor.workspace);
    if (!workspace) {
      const error = new Error(`工作区不存在：${monitor.workspace}`);
      error.code = 'workspace-not-found';
      throw error;
    }
    const created = await this.#harness.createSession({
      workspaceId: workspace.workspaceId ?? workspace.id,
    }, signal);
    const sessionId = created?.sessionId;
    if (!sessionId) {
      const error = new Error('新建会话失败：Harness 未返回 sessionId。');
      error.code = 'session-create-failed';
      throw error;
    }
    return sessionId;
  }

  /** Drop the auto-create cooldown so a reset can immediately recreate. */
  forget(monitorId) {
    this.#autoCreatedAt.delete(monitorId);
  }

  clear() {
    this.#autoCreatedAt.clear();
  }
}

export { PROMPT_TIMEOUT_MS, PROMPT_RPC_TIMEOUT_MS };
