/**
 * Snapshot state for the settings page.
 *
 * The page loads two independent things — plugin settings and the workspace
 * list — and both write into one snapshot. Keeping that merge here, as pure
 * functions, is what makes it testable: the bugs this module prevents (a
 * whole-object write dropping the other half, and a result discarded because
 * it arrived first) are invisible in a component test but obvious against
 * these functions.
 *
 * @module dsh-lark-session-monitor-plugin/client/snapshot
 */

/**
 * Shape used before `settings.get` answers.
 *
 * A workspace response can land first, and the render path reads
 * `settings.app` unconditionally — so the placeholder carries a complete,
 * valid shape rather than being `null`.
 */
export const EMPTY_SNAPSHOT = Object.freeze({
  settings: {
    version: 1,
    app: { appId: '', domain: 'feishu', hasSecret: false },
    pollIntervalMs: 30_000,
    monitors: [],
  },
  authorization: { authorized: false, scope: '', expiresAt: null, needsRefresh: false },
  runtime: [],
  chats: [],
  targets: [],
});

/**
 * Merge a `settings.get` response into the snapshot.
 *
 * Fields owned by other loaders (`targets`, `chats`) are carried over: the
 * settings response does not contain them, and replacing the object wholesale
 * would drop a workspace list that had already arrived. When there is nothing
 * to carry, the key is omitted rather than set to `undefined`, so the shape
 * stays clean for consumers that iterate it.
 */
export function mergeSettings(previous, data) {
  const merged = { ...data };
  if (previous?.targets !== undefined) merged.targets = previous.targets;
  if (previous?.chats !== undefined) merged.chats = previous.chats;
  return merged;
}

/**
 * Merge a `target.list` response into the snapshot.
 *
 * Falls back to the empty snapshot instead of returning the previous `null`,
 * because the loader runs once: discarding the value would leave the picker
 * empty for the life of the page.
 */
export function mergeTargets(previous, targets) {
  const base = previous ?? EMPTY_SNAPSHOT;
  return { ...base, targets };
}

/** Merge a chat list, tolerating arrival before the settings snapshot. */
export function mergeChats(previous, chats) {
  const base = previous ?? EMPTY_SNAPSHOT;
  return { ...base, chats };
}
