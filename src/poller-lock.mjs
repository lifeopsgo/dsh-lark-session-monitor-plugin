/**
 * Cross-process poller lock.
 *
 * The settings document and cursors live under `$DSH_HOME/plugin-data`, a
 * directory every DSH instance of the same user shares. The store keeps its
 * state in memory after `open()`, so two Host instances that both run this
 * plugin each hold their own cursor copy and deliver the same messages twice.
 * A double-opened profile is exactly how that happened in practice: the second
 * instance came up half-booted (its webserver could not bind) while the first
 * kept polling.
 *
 * The lock is a tiny file holding the owner's pid. A live foreign owner blocks
 * the start; a dead one (crashed instance) is taken over; a corrupt file is
 * replaced. Release only removes a file that still names this process, so a
 * successor's lock survives a late release from a predecessor that lost the
 * race during takeover.
 *
 * All operations are synchronous: they run once per runtime start or stop, and
 * keeping them sync lets `start()` stay synchronous for its existing callers.
 *
 * @module dsh-lark-session-monitor-plugin/poller-lock
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Lock file name inside the plugin's data directory. */
export const POLLER_LOCK_FILE_NAME = 'poller.lock';

function lockPathOf(dir) {
  return join(dir, POLLER_LOCK_FILE_NAME);
}

/** Whether `pid` names a process this OS can still signal. */
function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

function readOwner(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    const pid = Number.isInteger(parsed?.pid) ? parsed.pid : undefined;
    return pid === undefined ? undefined : { pid, raw };
  } catch {
    return undefined;
  }
}

function writeOwner(path, pid) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify({ pid, startedAt: Date.now() }));
  } finally {
    closeSync(fd);
  }
}

/**
 * Try to become the polling owner of `dir`.
 *
 * @param dir - the plugin's data directory (`pluginDataDir()`).
 * @param options - `pid` identifies this process; `isAlive` is injectable for
 *   tests. Both default to the real process.
 * @returns `{ ok: true, path }` when this process owns the poller, otherwise
 *   `{ ok: false, path, holderPid }` naming the live foreign owner.
 */
export function acquirePollerLock(dir, { pid = process.pid, isAlive = defaultIsAlive } = {}) {
  const path = lockPathOf(dir);
  try {
    writeOwner(path, pid);
    return { ok: true, path };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const owner = readOwner(path);
  // No readable owner: a crashed writer left a partial file. Replace it — the
  // alternative is a lock that blocks polling until someone deletes it by hand.
  if (owner === undefined) {
    rmSync(path, { force: true });
    try {
      writeOwner(path, pid);
      return { ok: true, path };
    } catch {
      return { ok: false, path, holderPid: undefined };
    }
  }
  // The same process re-acquiring its own lock is a restart, not a conflict.
  if (owner.pid === pid) return { ok: true, path };
  if (isAlive(owner.pid)) return { ok: false, path, holderPid: owner.pid };
  // A dead owner is a crashed instance; take over its stale lock.
  rmSync(path, { force: true });
  try {
    writeOwner(path, pid);
    return { ok: true, path };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return { ok: false, path, holderPid: undefined };
  }
}

/**
 * Give up the poller lock, but only a file that still names this process.
 *
 * @param dir - the plugin's data directory.
 * @param options - `pid` identifies this process; injectable for tests.
 * @returns whether a lock naming this process was removed.
 */
export function releasePollerLock(dir, { pid = process.pid } = {}) {
  const path = lockPathOf(dir);
  const owner = readOwner(path);
  if (owner === undefined || owner.pid !== pid) return false;
  rmSync(path, { force: true });
  return true;
}
