/**
 * Progressive, persistent folding of session titles.
 *
 * Folding one title means reading and parsing that session's whole compressed
 * log. On this machine one workspace holds 168 sessions and 1.3GB of logs, one
 * log alone 334MB — a full fold of that workspace measured 61 seconds, so a
 * picker that waited for it showed nothing but ids, and a picker that gave up
 * after ten seconds showed nothing but ids too.
 *
 * So a fold is split into chunks. Every call folds one chunk under its own
 * deadline, records what it learned, and reports whether more remains. The
 * caller renders ids immediately and re-renders as titles arrive. The cache is
 * written to disk, so the cost is paid once per session rather than once per
 * page open.
 *
 * A chunk that hits its deadline is abandoned and its sessions are reported
 * untitled from then on: one unreadable or enormous log must not hold the rest
 * of the workspace hostage.
 *
 * @module dsh-lark-session-monitor-plugin/title-cache
 */

import { readFile, rename, writeFile } from 'node:fs/promises';

/**
 * @param options.fold - `(ids, signal) => Promise<Map<sessionId, title>>`;
 *   must stop when the signal aborts.
 * @param options.file - cache file path; omit to keep the cache in memory.
 * @param options.chunkSize - sessions folded per call.
 * @param options.chunkBudgetMs - deadline for one chunk.
 * @param options.logger - optional `{ warn }` for an unwritable cache.
 */
export function createTitleCache({
  fold,
  file,
  chunkSize = 4,
  chunkBudgetMs = 3000,
  logger,
} = {}) {
  if (typeof fold !== 'function') throw new TypeError('title cache needs a fold function');

  /** Session id to folded title. Only sessions that have a title live here. */
  const titles = new Map();
  /** Ids whose fold finished, title or not; never folded twice. */
  const attempted = new Set();
  /** Ids whose fold hit its deadline or faulted; shown by id from now on. */
  const abandoned = new Set();
  let folding = null;
  let loaded = false;
  let saveTimer;

  async function load() {
    if (loaded || !file) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      for (const [id, title] of Object.entries(parsed?.titles ?? {})) {
        if (typeof id === 'string' && typeof title === 'string' && title) titles.set(id, title);
      }
      for (const id of parsed?.attempted ?? []) {
        if (typeof id === 'string') attempted.add(id);
      }
      for (const id of parsed?.abandoned ?? []) {
        if (typeof id === 'string') abandoned.add(id);
      }
    } catch {
      // A missing or unreadable cache is an empty cache, not a failure.
    }
  }

  function scheduleSave() {
    if (!file) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void save();
    }, 500);
    saveTimer.unref?.();
  }

  async function save() {
    if (!file) return;
    const payload = JSON.stringify({
      version: 1,
      titles: Object.fromEntries(titles),
      attempted: [...attempted],
      abandoned: [...abandoned],
    });
    const temporary = `${file}.tmp`;
    try {
      await writeFile(temporary, payload, 'utf8');
      await rename(temporary, file);
    } catch (error) {
      // Titles are decoration; a cache that cannot be written must not
      // break the picker.
      logger?.warn?.('[lark-session-monitor] title cache not saved', error);
    }
  }

  const known = (ids) => {
    const result = new Map();
    for (const id of ids) {
      const title = titles.get(id);
      if (typeof title === 'string' && title) result.set(id, title);
    }
    return result;
  };

  const outstanding = (ids) => ids.filter((id) => !attempted.has(id) && !abandoned.has(id));

  async function foldChunk(chunk, callerSignal) {
    const controller = new AbortController();
    const forward = () => controller.abort();
    callerSignal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => controller.abort(), chunkBudgetMs);
    try {
      if (callerSignal?.aborted) controller.abort();
      return await fold(chunk, controller.signal);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forward);
    }
  }

  /**
   * Fold what is still unknown, one chunk per call.
   *
   * @param ids - every session id wanted, in display order.
   * @param signal - caller cancellation. An abort here abandons the chunk
   *   without marking it slow: the fold did not fail, the caller stopped
   *   waiting, and another page may still want the titles.
   * @returns `{ titles, pending }` — titles known now, and whether another
   *   call would learn more.
   */
  async function resolve(ids, signal) {
    await load();
    const wanted = outstanding(ids);
    if (wanted.length === 0) return { titles: known(ids), pending: false };

    // One fold at a time. Two settings pages asking for the same workspace
    // share the work instead of reading every log twice.
    if (folding === null) {
      const chunk = wanted.slice(0, chunkSize);
      folding = (async () => {
        try {
          const folded = await foldChunk(chunk, signal);
          for (const id of chunk) {
            const title = folded instanceof Map ? folded.get(id) : undefined;
            if (typeof title === 'string' && title) titles.set(id, title);
            attempted.add(id);
          }
        } catch {
          if (signal?.aborted) return;
          for (const id of chunk) abandoned.add(id);
        } finally {
          scheduleSave();
        }
      })().finally(() => { folding = null; });
    } else if (signal?.aborted) {
      // Someone else is folding and this caller already gave up; answering
      // now keeps a closing page from waiting out a chunk it stopped wanting.
      return { titles: known(ids), pending: false };
    }
    await folding;
    return { titles: known(ids), pending: outstanding(ids).length > 0 };
  }

  return {
    resolve,
    /** Forget every title; the next resolve folds again. */
    clear() {
      titles.clear();
      attempted.clear();
      abandoned.clear();
      scheduleSave();
    },
  };
}
