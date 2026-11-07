/**
 * Tests for the cross-process poller lock.
 *
 * The lock's decisions hinge on whether the recorded pid is alive, which the
 * real OS answer cannot fake deterministically in a test — so the liveness
 * probe is injected and every scenario is driven against a temp directory.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquirePollerLock, releasePollerLock, POLLER_LOCK_FILE_NAME } from '../src/poller-lock.mjs';

const OUR_PID = 4242;
const OTHER_PID = 9001;
const alive = (...pids) => (pid) => pids.includes(pid);

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'lsm-lock-'));
}

test('acquiring an empty directory writes a lock naming this process', async () => {
  const dir = await tempDir();
  try {
    const lock = acquirePollerLock(dir, { pid: OUR_PID, isAlive: alive(OUR_PID) });
    assert.equal(lock.ok, true);
    const stored = JSON.parse(await readFile(join(dir, POLLER_LOCK_FILE_NAME), 'utf8'));
    assert.equal(stored.pid, OUR_PID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a lock naming this same process is a restart, not a conflict', async () => {
  const dir = await tempDir();
  try {
    assert.equal(acquirePollerLock(dir, { pid: OUR_PID, isAlive: alive() }).ok, true);
    assert.equal(acquirePollerLock(dir, { pid: OUR_PID, isAlive: alive() }).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a live foreign owner refuses the start and names the holder', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, POLLER_LOCK_FILE_NAME), JSON.stringify({ pid: OTHER_PID }), 'utf8');
    const lock = acquirePollerLock(dir, { pid: OUR_PID, isAlive: alive(OTHER_PID) });
    assert.equal(lock.ok, false);
    assert.equal(lock.holderPid, OTHER_PID);
    // The holder's lock is left exactly as it was.
    const stored = JSON.parse(await readFile(join(dir, POLLER_LOCK_FILE_NAME), 'utf8'));
    assert.equal(stored.pid, OTHER_PID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a dead foreign owner is a crashed instance and gets taken over', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, POLLER_LOCK_FILE_NAME), JSON.stringify({ pid: OTHER_PID }), 'utf8');
    const lock = acquirePollerLock(dir, { pid: OUR_PID, isAlive: alive() });
    assert.equal(lock.ok, true);
    const stored = JSON.parse(await readFile(join(dir, POLLER_LOCK_FILE_NAME), 'utf8'));
    assert.equal(stored.pid, OUR_PID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt lock file is replaced rather than blocking forever', async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, POLLER_LOCK_FILE_NAME), 'not json', 'utf8');
    const lock = acquirePollerLock(dir, { pid: OUR_PID, isAlive: alive(OTHER_PID) });
    assert.equal(lock.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('release removes a lock naming this process and spares a successor', async () => {
  const dir = await tempDir();
  try {
    acquirePollerLock(dir, { pid: OUR_PID, isAlive: alive() });
    // A successor took over (this process crashed and came back); the lock now
    // names someone else, so a late release from this pid must not touch it.
    await writeFile(join(dir, POLLER_LOCK_FILE_NAME), JSON.stringify({ pid: OTHER_PID }), 'utf8');
    assert.equal(releasePollerLock(dir, { pid: OUR_PID }), false);
    const stored = JSON.parse(await readFile(join(dir, POLLER_LOCK_FILE_NAME), 'utf8'));
    assert.equal(stored.pid, OTHER_PID);
    // Once the lock names this process again, release removes it.
    await writeFile(join(dir, POLLER_LOCK_FILE_NAME), JSON.stringify({ pid: OUR_PID }), 'utf8');
    assert.equal(releasePollerLock(dir, { pid: OUR_PID }), true);
    await assert.rejects(readFile(join(dir, POLLER_LOCK_FILE_NAME), 'utf8'), /ENOENT/);
    // Releasing with nothing to release is a quiet no-op.
    assert.equal(releasePollerLock(dir, { pid: OUR_PID }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
