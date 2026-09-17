/**
 * Read the Host's workspace and session inventory.
 *
 * The Remote `workspace.follow` stream is the documented cross-boundary path,
 * but it is a *stream*: it must be opened, read once, and aborted, and on the
 * live Host that read produced an empty list while the registry plainly held
 * twenty workspaces. A host-plane plugin can read the registry directly — it
 * is the same data `workspace.follow` projects (`workspaceView` maps
 * `entity.record`), minus the transport.
 *
 * This module is the single source of truth for that inventory, so delivery
 * and the settings picker cannot disagree about which workspaces exist.
 *
 * @module dsh-lark-session-monitor-plugin/inventory
 */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Project one registry entity the way `workspaceView` does.
 *
 * The registry entity is `{ id, record: { path, title, sessionIds, ... } }`;
 * the Remote projection flattens that into `workspaceId`/`path`/`sessionIds`.
 */
export function workspaceFromEntity(entity) {
  if (!isRecord(entity)) return undefined;
  const record = isRecord(entity.record) ? entity.record : {};
  const id = entity.id;
  if (typeof id !== 'string' || !id) return undefined;
  const sessionIds = Array.isArray(record.sessionIds)
    ? record.sessionIds.filter((value) => typeof value === 'string' && value)
    : [];
  return {
    workspaceId: id,
    path: stringOr(record.path),
    title: stringOr(record.title),
    sessionIds,
  };
}

/**
 * Resolve every workspace the Host knows about, plus the archived sessions.
 *
 * `archivedSessionIds` is what distinguishes "the target was deleted" (a state
 * delivery recovers from by creating a new session) from "the target was never
 * a session at all" (a misconfiguration, where creating one would mask the
 * error). Both look like "absent from every workspace" without it.
 *
 * @param ctx - Host context; the registry is read through `get` so a Host
 *   without it degrades to an empty inventory rather than failing the plugin.
 */
export function listInventory(ctx) {
  const registry = ctx?.get?.('workspaceRegistry');
  if (!registry || typeof registry.list !== 'function') {
    return { workspaces: [], archivedSessionIds: [] };
  }
  let entities;
  let archived;
  try {
    entities = registry.list();
    archived = registry.archivedSessionIds;
  } catch {
    return { workspaces: [], archivedSessionIds: [] };
  }
  const workspaces = Array.isArray(entities)
    ? entities.map(workspaceFromEntity).filter(Boolean)
    : [];
  // The registry exposes this as a Set on some lines and an array on others.
  const archivedSessionIds = archived && typeof archived[Symbol.iterator] === 'function'
    ? [...archived].filter((value) => typeof value === 'string' && value)
    : [];
  return { workspaces, archivedSessionIds };
}

/** Every workspace the Host knows about. */
export function listWorkspaces(ctx) {
  return listInventory(ctx).workspaces;
}

/** Whether a session was archived (deleted) rather than merely unknown. */
export function isArchivedSession(inventory, sessionId) {
  return inventory.archivedSessionIds.includes(sessionId);
}

/**
 * Title for one *live* session, when the Host can name it.
 *
 * This is the fallback path only: the `sessionTitle` service folds a session's
 * in-memory events, so it knows nothing about a session that is merely
 * persisted. {@link listWorkspaceTargets} prefers the session-query corpus and
 * uses this for the handful of sessions that are open right now.
 */
export function sessionTitleFor(ctx, session) {
  if (!session) return '';
  const title = ctx?.get?.('sessionTitle');
  if (!title || typeof title.get !== 'function') return '';
  try {
    const snapshot = title.get(session);
    return stringOr(snapshot?.title);
  } catch {
    return '';
  }
}

/** Normalize one `readTitleSnapshots` entry to a plain title string. */
function titleFromSnapshot(result) {
  if (!result || result.status !== 'fulfilled') return '';
  const title = result.value?.title;
  if (typeof title === 'string') return title;
  // A snapshot may carry `{ title, ... }` rather than the bare string.
  if (title && typeof title === 'object' && typeof title.title === 'string') return title.title;
  return '';
}

/**
 * Resolve the picker's view: workspaces, each with its sessions titled where
 * the Host can name them.
 *
 * Titles come from the session-query corpus, which folds each session's own
 * log: that is the only source that knows a session which is merely persisted.
 * Reading the live `sessionTitle` service instead leaves every historical
 * session blank — the "（无标题）" the picker showed for all of them.
 *
 * Only the sessions a workspace actually lists are returned, because those are
 * the ones that can be a delivery target.
 */
export async function listWorkspaceTargets(ctx, signal) {
  const workspaces = listWorkspaces(ctx);
  const ids = [...new Set(workspaces.flatMap((workspace) => workspace.sessionIds))];

  const titles = new Map();
  const query = ctx?.get?.('sessionQuery');
  if (ids.length > 0 && query && typeof query.readTitleSnapshots === 'function') {
    try {
      // One batch: each log is folded once, and a failure is isolated per
      // session so one unreadable log cannot blank the whole list.
      const results = await query.readTitleSnapshots(ids, signal);
      if (Array.isArray(results)) {
        results.forEach((result, index) => {
          const id = ids[index];
          const title = titleFromSnapshot(result);
          if (id && title) titles.set(id, title);
        });
      }
    } catch {
      // Titles are decoration: the picker still works on ids alone.
    }
  }

  // A session the corpus could not title may still be open; ask the live
  // service for those rather than showing blank where a name exists.
  const live = ctx?.get?.('sessions');
  if (live && typeof live.list === 'function') {
    try {
      for (const session of live.list()) {
        const id = session?.id;
        if (typeof id === 'string' && id && !titles.has(id)) {
          const title = sessionTitleFor(ctx, session);
          if (title) titles.set(id, title);
        }
      }
    } catch {
      // A live-store fault must not hide the workspace list.
    }
  }

  return workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    title: workspace.title,
    sessions: workspace.sessionIds.map((sessionId) => ({
      sessionId,
      title: titles.get(sessionId) ?? '',
    })),
  }));
}

/** Find one workspace by its path, for delivery-time resolution. */
export function findWorkspaceByPath(workspaces, path) {
  return workspaces.find((workspace) => workspace.path === path);
}

/** Whether a session id is registered to any workspace. */
export function isKnownSession(workspaces, sessionId) {
  return workspaces.filter((workspace) => workspace.sessionIds.includes(sessionId));
}
