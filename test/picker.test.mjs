/**
 * Tests for the settings-page snapshot merge.
 *
 * These exercise the real module the page uses. The two bugs they pin both
 * presented as "目标工作区（0 个）" on a Host that had many workspaces:
 *
 * - a settings response written as a whole object, dropping a workspace list
 *   that had already arrived;
 * - a workspace result discarded because the settings snapshot did not exist
 *   yet, which never recovered because the loader runs once.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_SNAPSHOT,
  mergeChats,
  mergeSettings,
  mergeTargets,
} from '../src/client/snapshot.mjs';

const TARGETS = [{ workspaceId: 'w1', path: '/a', sessions: [] }];

function settingsResponse(monitors = []) {
  return {
    settings: { app: { appId: 'cli_x', hasSecret: true }, monitors, pollIntervalMs: 30000 },
    authorization: { authorized: true },
    runtime: [],
  };
}

test('a settings merge preserves a workspace list that already arrived', () => {
  // The original defect: `setSnapshot(data)` replaced the object, so whichever
  // loader finished first lost its data.
  const withTargets = mergeTargets(null, TARGETS);
  const merged = mergeSettings(withTargets, settingsResponse());
  assert.deepEqual(merged.targets, TARGETS);
  assert.equal(merged.settings.app.appId, 'cli_x');
});

test('a settings merge adds no keys of its own when nothing has arrived', () => {
  const merged = mergeSettings(null, settingsResponse());
  assert.equal('targets' in merged, false);
  assert.equal('chats' in merged, false);
  assert.equal(merged.settings.app.appId, 'cli_x');
});

test('a workspace merge preserves settings that already arrived', () => {
  const withSettings = mergeSettings(null, settingsResponse([{ monitorId: 'mon_1' }]));
  const merged = mergeTargets(withSettings, TARGETS);
  assert.equal(merged.settings.monitors.length, 1);
  assert.deepEqual(merged.targets, TARGETS);
});

test('a workspace result survives arriving before the settings snapshot', () => {
  // `prev ? {...} : prev` used to return `null`, and the effect never re-ran.
  const merged = mergeTargets(null, TARGETS);
  assert.deepEqual(merged.targets, TARGETS);
  // The render path reads these unconditionally, so the fallback must be full.
  assert.equal(typeof merged.settings.app.hasSecret, 'boolean');
  assert.ok(Array.isArray(merged.settings.monitors));
  assert.equal(merged.authorization.authorized, false);
});

test('a chat list survives arriving before the settings snapshot', () => {
  const merged = mergeChats(null, [{ chatId: 'oc_1' }]);
  assert.equal(merged.chats.length, 1);
  assert.ok(merged.settings);
});

test('merging never mutates the previous snapshot', () => {
  const before = mergeSettings(null, settingsResponse());
  const frozen = JSON.parse(JSON.stringify(before));
  mergeTargets(before, TARGETS);
  assert.deepEqual(before, frozen, 'the earlier snapshot must be untouched');
});

test('the empty snapshot is a valid, renderable shape', () => {
  assert.equal(EMPTY_SNAPSHOT.settings.app.appId, '');
  assert.equal(EMPTY_SNAPSHOT.settings.app.hasSecret, false);
  assert.deepEqual(EMPTY_SNAPSHOT.settings.monitors, []);
  assert.deepEqual(EMPTY_SNAPSHOT.targets, []);
  assert.deepEqual(EMPTY_SNAPSHOT.chats, []);
  assert.equal(EMPTY_SNAPSHOT.authorization.authorized, false);
});

test('targets and chats from different loaders coexist', () => {
  let snapshot = mergeSettings(null, settingsResponse([{ monitorId: 'mon_1' }]));
  snapshot = mergeTargets(snapshot, TARGETS);
  snapshot = mergeChats(snapshot, [{ chatId: 'oc_1' }]);
  assert.equal(snapshot.settings.monitors.length, 1);
  assert.equal(snapshot.targets.length, 1);
  assert.equal(snapshot.chats.length, 1);
});
