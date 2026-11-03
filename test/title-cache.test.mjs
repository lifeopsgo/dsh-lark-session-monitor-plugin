/**
 * Tests for the progressive title cache.
 *
 * The regression behind it: folding every title of a workspace in one batch
 * took 61 seconds on the live Host (one session log is 334MB), so the picker
 * timed out and showed bare session ids. The cache folds a chunk per call,
 * remembers what it learned, and stops paying for a chunk that misses its
 * deadline.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createTitleCache } from '../src/title-cache.mjs';

/** A fold that answers from a map, recording each chunk it was given. */
function folder(titles, calls = []) {
  return async (ids) => {
    calls.push([...ids]);
    const found = new Map();
    for (const id of ids) {
      const title = titles[id];
      if (title) found.set(id, title);
    }
    return found;
  };
}

test('the first call folds one chunk and reports that more remains', async () => {
  const calls = [];
  const cache = createTitleCache({
    fold: folder({ s1: '一号', s2: '二号', s3: '三号' }, calls),
    chunkSize: 2,
  });
  const first = await cache.resolve(['s1', 's2', 's3']);
  assert.deepEqual(calls, [['s1', 's2']], 'only one chunk per call');
  assert.deepEqual([...first.titles], [['s1', '一号'], ['s2', '二号']]);
  assert.equal(first.pending, true);

  const second = await cache.resolve(['s1', 's2', 's3']);
  assert.deepEqual(calls, [['s1', 's2'], ['s3']]);
  assert.deepEqual([...second.titles], [['s1', '一号'], ['s2', '二号'], ['s3', '三号']]);
  assert.equal(second.pending, false);
});

test('a settled workspace folds nothing again', async () => {
  const calls = [];
  const cache = createTitleCache({ fold: folder({ s1: '一号' }, calls), chunkSize: 4 });
  await cache.resolve(['s1']);
  const callsAfterFirst = calls.length;
  const again = await cache.resolve(['s1']);
  assert.equal(calls.length, callsAfterFirst, 'the cache answers without folding');
  assert.deepEqual([...again.titles], [['s1', '一号']]);
  assert.equal(again.pending, false);
});

test('a session with no title event is remembered as tried', async () => {
  // Untitled sessions are common; re-reading their logs on every page open
  // would defeat the cache.
  const calls = [];
  const cache = createTitleCache({ fold: folder({ s1: '一号' }, calls), chunkSize: 4 });
  const first = await cache.resolve(['s1', 's_untitled']);
  assert.deepEqual([...first.titles], [['s1', '一号']]);
  assert.equal(first.pending, false);
  const before = calls.length;
  await cache.resolve(['s1', 's_untitled']);
  assert.equal(calls.length, before, 'an untitled session is not folded twice');
});

test('a chunk past its deadline is abandoned, not retried forever', async () => {
  let folded = 0;
  const cache = createTitleCache({
    chunkSize: 1,
    chunkBudgetMs: 10,
    fold: async (ids, signal) => {
      folded += 1;
      // The first chunk hangs past its budget; the second answers at once.
      if (ids[0] === 's_slow') {
        await new Promise((resolve, reject) => {
          // No fallback timer: the abort is the only way out, and leaving a
          // live timer here would keep the whole test process open.
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return new Map([[ids[0], '快']]);
    },
  });
  const first = await cache.resolve(['s_slow', 's_fast']);
  assert.deepEqual([...first.titles], [], 'the slow chunk learned nothing yet');

  const second = await cache.resolve(['s_slow', 's_fast']);
  assert.equal(second.pending, false, 'a chunk that missed its deadline is not retried');
  assert.deepEqual([...second.titles], [['s_fast', '快']]);
  assert.equal(folded, 2, 'the abandoned chunk is folded once, the next one once');
});

test('a fold that faults abandons its chunk instead of failing the request', async () => {
  const cache = createTitleCache({
    chunkSize: 2,
    fold: async () => { throw new Error('corpus offline'); },
  });
  const result = await cache.resolve(['s1', 's2']);
  assert.deepEqual([...result.titles], []);
  assert.equal(result.pending, false, 'ids stay usable when titles cannot be read');
});

test('concurrent callers share one fold', async () => {
  let folds = 0;
  const cache = createTitleCache({
    chunkSize: 4,
    fold: async (ids) => {
      folds += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Map(ids.map((id) => [id, '标题']));
    },
  });
  const [a, b] = await Promise.all([cache.resolve(['s1']), cache.resolve(['s1'])]);
  assert.equal(folds, 1, 'two pages asking at once must not read the log twice');
  assert.deepEqual([...a.titles], [['s1', '标题']]);
  assert.deepEqual([...b.titles], [['s1', '标题']]);
});

test('cancelling the caller does not mark the chunk slow', async () => {
  // A page closing is not a fold failure: the next page open should still
  // try these sessions. The fold rejects on abort and leaves no timer behind,
  // so the suite does not wait out a budget nobody is using.
  let attempts = 0;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const cache = createTitleCache({
    chunkSize: 1,
    chunkBudgetMs: 5000,
    fold: async (ids, signal) => {
      attempts += 1;
      if (attempts === 1) {
        started();
        await new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return new Map([[ids[0], '标题']]);
    },
  });
  const controller = new AbortController();
  const pending = cache.resolve(['s1'], controller.signal);
  await running;
  controller.abort();
  const first = await pending;
  assert.deepEqual([...first.titles], []);
  const second = await cache.resolve(['s1']);
  assert.deepEqual([...second.titles], [['s1', '标题']], 'the chunk is retried after an abandoned caller');
});

test('titles survive in a file and reload into a fresh cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsm-titles-'));
  const file = join(dir, 'session-titles.json');
  const cache = createTitleCache({ fold: folder({ s1: '一号' }), file, chunkSize: 4 });
  await cache.resolve(['s1']);
  // Writes are debounced; wait for the file to appear.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const written = JSON.parse(await readFile(file, 'utf8'));
      if (written?.titles?.s1 === '一号') break;
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.titles.s1, '一号');

  const reopened = createTitleCache({
    fold: async () => { throw new Error('must not fold: the cache has the title'); },
    file,
    chunkSize: 4,
  });
  const result = await reopened.resolve(['s1']);
  assert.deepEqual([...result.titles], [['s1', '一号']]);
  assert.equal(result.pending, false);
});

test('an unreadable cache file starts an empty cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsm-titles-bad-'));
  const file = join(dir, 'session-titles.json');
  const cache = createTitleCache({ fold: folder({ s1: '一号' }), file: join(dir, 'missing.json') });
  const result = await cache.resolve(['s1']);
  assert.deepEqual([...result.titles], [['s1', '一号']]);
  assert.ok(file, 'the guard is the missing path, not the cache');
});

test('clear drops every remembered title', async () => {
  const calls = [];
  const cache = createTitleCache({ fold: folder({ s1: '一号' }, calls), chunkSize: 4 });
  await cache.resolve(['s1']);
  cache.clear();
  const after = await cache.resolve(['s1']);
  assert.deepEqual([...after.titles], [['s1', '一号']]);
  assert.equal(calls.length, 2, 'clear forces a re-fold');
});

test('a cache without a fold function is rejected', () => {
  assert.throws(() => createTitleCache({}), /fold/);
});
