/**
 * Unit tests for the settings store.
 *
 * These run against real temporary files rather than a storage double. The
 * previous double implemented `loadAll`/`setGlobal`, which is why it passed
 * while the live Host — whose `open()` returns a handle exposing only
 * `table()`/`close()` — silently persisted nothing. A real file cannot be
 * wrong about the disk.
 *
 * The store guards three things worth pinning: secrets never leak into a
 * public snapshot, a settings save never rewinds a cursor, and concurrent
 * writes cannot lose an edit.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MonitorStore,
  isValidMonitorId,
  newMonitorId,
  normalizeSettings,
  publicSettings,
  settingsPath,
} from '../src/store.mjs';

/** A store over a fresh temp directory; the caller reads the file back. */
async function openStore(seed) {
  const dir = await mkdtemp(join(tmpdir(), 'lsm-store-'));
  const file = join(dir, 'settings.json');
  if (seed !== undefined) await writeFile(file, JSON.stringify(seed), 'utf8');
  const store = new MonitorStore({ file });
  await store.open();
  return { store, file, dir };
}

/** Reopen the same file with a fresh store, as a Host restart would. */
async function reopen(file) {
  const store = new MonitorStore({ file });
  await store.open();
  return store;
}

test('the settings path lives under DSH_HOME/plugin-data', () => {
  const path = settingsPath({ DSH_HOME: '/tmp/fake-home' });
  assert.equal(path, '/tmp/fake-home/plugin-data/dsh-lark-session-monitor-plugin/settings.json');
});

test('generated monitor ids match the declared pattern', () => {
  const id = newMonitorId();
  assert.ok(isValidMonitorId(id), id);
  assert.equal(isValidMonitorId('mon_short'), false);
  assert.equal(isValidMonitorId('nope'), false);
});

test('a monitor requires a chat and a prompt', async () => {
  const { store } = await openStore();
  await assert.rejects(() => store.upsertMonitor({ chatId: '', prompt: 'x' }), /必填/);
  await assert.rejects(() => store.upsertMonitor({ chatId: 'oc_a', prompt: '  ' }), /必填/);
});

test('upserting twice with the same id updates instead of duplicating', async () => {
  const { store } = await openStore();
  const created = await store.upsertMonitor({ chatId: 'oc_a', prompt: 'p1' });
  await store.upsertMonitor({ monitorId: created.monitorId, chatId: 'oc_a', prompt: 'p2' });
  assert.equal(store.monitors().length, 1);
  assert.equal(store.monitor(created.monitorId).prompt, 'p2');
});

test('a settings save cannot rewind the polling cursor', async () => {
  const { store } = await openStore();
  const created = await store.upsertMonitor({ chatId: 'oc_a', prompt: 'p' });
  await store.advanceCursor(created.monitorId, { lastCreateTimeMs: 5_000, lastMessageId: 'om_5' });
  // The settings page posts the whole monitor back, without a cursor.
  await store.upsertMonitor({ monitorId: created.monitorId, chatId: 'oc_a', prompt: 'p', name: '改名' });
  const monitor = store.monitor(created.monitorId);
  assert.equal(monitor.cursor.lastCreateTimeMs, 5_000);
  assert.equal(monitor.cursor.lastMessageId, 'om_5');
  assert.equal(monitor.name, '改名');
});

test('advanceCursor never moves the high-water mark backwards', async () => {
  const { store } = await openStore();
  const created = await store.upsertMonitor({ chatId: 'oc_a', prompt: 'p' });
  await store.advanceCursor(created.monitorId, { lastCreateTimeMs: 5_000 });
  await store.advanceCursor(created.monitorId, { lastCreateTimeMs: 1_000, lastMessageId: 'om_old' });
  assert.equal(store.monitor(created.monitorId).cursor.lastCreateTimeMs, 5_000);
});

test('concurrent writes are serialized so no edit is lost', async () => {
  const { store } = await openStore();
  await Promise.all([
    store.upsertMonitor({ chatId: 'oc_a', prompt: 'a' }),
    store.upsertMonitor({ chatId: 'oc_b', prompt: 'b' }),
    store.upsertMonitor({ chatId: 'oc_c', prompt: 'c' }),
  ]);
  assert.equal(store.monitors().length, 3);
});

test('the public snapshot never carries the app secret', async () => {
  const { store } = await openStore({
    app: { appId: 'cli_x', appSecret: 'super-secret', domain: 'feishu' },
    monitors: [],
  });
  const publicView = publicSettings(store.snapshot());
  assert.equal(publicView.app.hasSecret, true);
  assert.equal('appSecret' in publicView.app, false);
  assert.ok(!JSON.stringify(publicView).includes('super-secret'));
});

test('removing a monitor persists the removal', async () => {
  const { store, file } = await openStore();
  const created = await store.upsertMonitor({ chatId: 'oc_a', prompt: 'p' });
  await store.removeMonitor(created.monitorId);
  assert.equal(store.monitors().length, 0);
  // Read the document back rather than trusting the in-memory view.
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.monitors.length, 0);
  await assert.rejects(() => store.removeMonitor(created.monitorId), /不存在/);
});

test('settings survive a restart through the real file', async () => {
  // The regression this file now guards: the previous storage API was used
  // wrongly, every write threw inside a swallowed promise, and the settings
  // page lost everything on the next Host start.
  const { store, file } = await openStore();
  await store.saveApp({ appId: 'cli_persist', appSecret: 'secret-x', pollIntervalMs: 45_000 });
  await store.upsertMonitor({ chatId: 'oc_keep', prompt: '归档', workspace: '/w' });

  const reopened = await reopen(file);
  const settings = reopened.snapshot();
  assert.equal(settings.app.appId, 'cli_persist');
  assert.equal(settings.app.appSecret, 'secret-x');
  assert.equal(settings.pollIntervalMs, 45_000);
  assert.equal(settings.monitors.length, 1);
  assert.equal(settings.monitors[0].chatId, 'oc_keep');
});

test('a cursor written before a restart is still there afterwards', async () => {
  const { store, file } = await openStore();
  const created = await store.upsertMonitor({ chatId: 'oc_a', prompt: 'p' });
  await store.advanceCursor(created.monitorId, {
    lastCreateTimeMs: 1_700_000_000_000, lastMessageId: 'om_x',
  });

  const reopened = await reopen(file);
  const monitor = reopened.monitor(created.monitorId);
  // Losing the cursor would re-deliver the conversation's history on restart.
  assert.equal(monitor.cursor.lastCreateTimeMs, 1_700_000_000_000);
  assert.equal(monitor.cursor.lastMessageId, 'om_x');
});

test('the persisted document is written with restrictive permissions', async () => {
  const { store, file } = await openStore();
  await store.saveApp({ appId: 'cli_x', appSecret: 'secret' });
  const { stat } = await import('node:fs/promises');
  const info = await stat(file);
  // The file holds the app secret.
  assert.equal(info.mode & 0o777, 0o600);
});

test('a corrupt document starts from defaults instead of failing to load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsm-corrupt-'));
  const file = join(dir, 'settings.json');
  await writeFile(file, '{ this is not json', 'utf8');
  const store = new MonitorStore({ file });
  await store.open();
  assert.deepEqual(store.monitors(), []);
});

test('a first run with no file yet starts from defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsm-fresh-'));
  const store = new MonitorStore({ file: join(dir, 'missing.json') });
  await store.open();
  assert.equal(store.snapshot().app.appId, '');
});

test('no temp file is left behind after a write', async () => {
  const { store, file } = await openStore();
  await store.saveApp({ appId: 'cli_x' });
  const { readdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const entries = await readdir(dirname(file));
  assert.ok(!entries.some((name) => name.endsWith('.tmp')), `leftover: ${entries.join(',')}`);
});

test('the poll interval is clamped to a sane floor', async () => {
  const { store } = await openStore();
  await store.saveApp({ pollIntervalMs: 1000 });
  assert.equal(store.snapshot().pollIntervalMs, 2_000);
});

test('a two second poll interval is kept, not clamped', async () => {
  const { store } = await openStore();
  await store.saveApp({ pollIntervalMs: 2_000 });
  assert.equal(store.snapshot().pollIntervalMs, 2_000);
});

test('an empty secret on save leaves the stored secret intact', async () => {
  // Regression guard: the settings page never receives the secret back, so it
  // posts an empty field on every save. Treating that as a clear would delete
  // the credential whenever the user changed the poll interval.
  const { store } = await openStore();
  await store.saveApp({ appId: 'cli_x', appSecret: 'secret-1' });
  await store.saveApp({ appId: 'cli_x', appSecret: '', pollIntervalMs: 60_000 });
  assert.equal(store.snapshot().app.appSecret, 'secret-1');
  assert.equal(store.snapshot().pollIntervalMs, 60_000);
});

test('an omitted secret on save also leaves the stored secret intact', async () => {
  const { store } = await openStore();
  await store.saveApp({ appId: 'cli_x', appSecret: 'secret-1' });
  await store.saveApp({ pollIntervalMs: 45_000 });
  assert.equal(store.snapshot().app.appSecret, 'secret-1');
});

test('a non-empty secret replaces the stored one', async () => {
  const { store } = await openStore();
  await store.saveApp({ appId: 'cli_x', appSecret: 'secret-1' });
  await store.saveApp({ appSecret: 'secret-2' });
  assert.equal(store.snapshot().app.appSecret, 'secret-2');
});

test('unknown fields are dropped on read', () => {
  const settings = normalizeSettings({
    version: 1,
    app: { appId: 'a', appSecret: 'b', domain: 'lark', bogus: 1 },
    monitors: [{ chatId: 'oc', prompt: 'p', nonsense: true }],
    extraTop: 'x',
  });
  assert.equal('extraTop' in settings, false);
  assert.equal('bogus' in settings.app, false);
  assert.equal('nonsense' in settings.monitors[0], false);
  assert.equal(settings.app.domain, 'lark');
});

test('setMonitorSession records the auto-created session', async () => {
  const { store } = await openStore();
  const created = await store.upsertMonitor({ chatId: 'oc_a', prompt: 'p' });
  await store.setMonitorSession(created.monitorId, { sessionId: 's_1', sessionTitle: '标题' });
  const monitor = store.monitor(created.monitorId);
  assert.equal(monitor.sessionId, 's_1');
  assert.equal(monitor.sessionTitle, '标题');
});

test('autoCreateAndPin defaults off and survives a round trip', async () => {
  const { store } = await openStore();
  const plain = await store.upsertMonitor({ chatId: 'oc_a', prompt: 'p' });
  assert.equal(plain.autoCreateAndPin, false);

  const pinned = await store.upsertMonitor({
    chatId: 'oc_b', prompt: 'p', autoCreateAndPin: true,
  });
  assert.equal(pinned.autoCreateAndPin, true);

  // The public view carries it, or the editor cannot show the current mode.
  const view = publicSettings(store.snapshot()).monitors
    .find((m) => m.monitorId === pinned.monitorId);
  assert.equal(view.autoCreateAndPin, true);
});

test('only a literal true enables pinning', async () => {
  const { store } = await openStore();
  // A hand-edited or stringly value must not silently turn the mode on.
  const created = await store.upsertMonitor({
    chatId: 'oc_a', prompt: 'p', autoCreateAndPin: 'yes',
  });
  assert.equal(created.autoCreateAndPin, false);
});

test('skipOwnMessages defaults off and survives a round trip', async () => {
  const { store } = await openStore();
  const plain = await store.upsertMonitor({ chatId: 'oc_a', prompt: 'p' });
  assert.equal(plain.skipOwnMessages, false);

  const skipping = await store.upsertMonitor({
    chatId: 'oc_b', prompt: 'p', skipOwnMessages: true,
  });
  assert.equal(skipping.skipOwnMessages, true);

  // The public view carries it, or the editor cannot show the current mode.
  const view = publicSettings(store.snapshot()).monitors
    .find((m) => m.monitorId === skipping.monitorId);
  assert.equal(view.skipOwnMessages, true);
});

test('only a literal true skips own messages', async () => {
  const { store } = await openStore();
  // A hand-edited or stringly value must not silently turn the filter on.
  const created = await store.upsertMonitor({
    chatId: 'oc_a', prompt: 'p', skipOwnMessages: 'yes',
  });
  assert.equal(created.skipOwnMessages, false);
});

test('onlySenderIds keeps unique, non-empty ids and drops everything else', async () => {
  const { store } = await openStore();
  const monitor = await store.upsertMonitor({
    chatId: 'oc_a', prompt: 'p',
    onlySenderIds: ['ou_1', ' ou_2 ', '', 'ou_1', 42, null, ['ou_3']],
  });
  assert.deepEqual(monitor.onlySenderIds, ['ou_1', 'ou_2']);
  // The public view carries it, or the editor cannot show the selection.
  const view = publicSettings(store.snapshot()).monitors
    .find((m) => m.monitorId === monitor.monitorId);
  assert.deepEqual(view.onlySenderIds, ['ou_1', 'ou_2']);
});

test('blockedKeywords keeps unique non-empty strings and drops everything else', async () => {
  const { store } = await openStore();
  const monitor = await store.upsertMonitor({
    chatId: 'oc_a', prompt: 'p',
    blockedKeywords: [' 周报 ', '', '周报', 42, null, ['会议纪要'], '报销'],
  });
  // The nested array is garbage and is dropped like the other non-strings.
  assert.deepEqual(monitor.blockedKeywords, ['周报', '报销']);
  // The public view carries it, or the editor cannot show the list.
  const view = publicSettings(store.snapshot()).monitors
    .find((m) => m.monitorId === monitor.monitorId);
  assert.deepEqual(view.blockedKeywords, ['周报', '报销']);
});

test('allowedKeywords keeps unique non-empty strings and drops everything else', async () => {
  const { store } = await openStore();
  const monitor = await store.upsertMonitor({
    chatId: 'oc_a', prompt: 'p',
    allowedKeywords: [' 纪要 ', '', '纪要', 42, null, ['周报'], '报销'],
  });
  // The nested array is garbage and is dropped like the other non-strings.
  assert.deepEqual(monitor.allowedKeywords, ['纪要', '报销']);
  const view = publicSettings(store.snapshot()).monitors
    .find((m) => m.monitorId === monitor.monitorId);
  assert.deepEqual(view.allowedKeywords, ['纪要', '报销']);
});

test('alsoBotMention needs a literal true', async () => {
  const { store } = await openStore();
  const off = await store.upsertMonitor({ chatId: 'oc_a', prompt: 'p', alsoBotMention: 'yes' });
  assert.equal(off.alsoBotMention, false);
  const on = await store.upsertMonitor({ chatId: 'oc_b', prompt: 'p', alsoBotMention: true });
  assert.equal(on.alsoBotMention, true);
});
