/**
 * Tests for the workspace inventory reader.
 *
 * This module exists because the Remote `workspace.follow` stream answered
 * empty on the live Host while the registry plainly held twenty workspaces.
 * The reader accepts both the legacy `{ id, record: { ... } }` projection and
 * current DSH `Workspace` entries (`{ id, path, title, sessionIds }`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findWorkspaceByPath,
  isArchivedSession,
  isKnownSession,
  listInventory,
  listWorkspaceTargets,
  listWorkspaces,
  sessionTitleFor,
  workspaceFromEntity,
} from '../src/inventory.mjs';

/** A Host context double exposing only the services the reader uses. */
function contextWith({ entities, archived, live, title } = {}) {
  const services = new Map();
  if (entities !== undefined) {
    services.set('workspaceRegistry', {
      list: () => entities,
      ...(archived === undefined ? {} : { archivedSessionIds: archived }),
    });
  }
  if (live !== undefined) services.set('sessions', { list: () => live });
  if (title !== undefined) services.set('sessionTitle', { get: title });
  return {
    get: (key) => services.get(key),
  };
}

function entity(id, path, sessionIds = [], title = '') {
  return { id, record: { path, title, sessionIds } };
}

test('a legacy registry entity projects to the Remote workspace shape', () => {
  const projected = workspaceFromEntity(entity('w1', '/a', ['s1'], 'Alpha'));
  assert.deepEqual(projected, {
    workspaceId: 'w1', path: '/a', title: 'Alpha', sessionIds: ['s1'],
  });
});

test('a current Workspace registry entry projects to the Remote workspace shape', () => {
  const projected = workspaceFromEntity({
    id: 'w2', path: '/current', title: 'Current', sessionIds: ['s2', 's3'],
  });
  assert.deepEqual(projected, {
    workspaceId: 'w2', path: '/current', title: 'Current', sessionIds: ['s2', 's3'],
  });
});

test('malformed entities are dropped rather than crashing the reader', () => {
  assert.equal(workspaceFromEntity(null), undefined);
  assert.equal(workspaceFromEntity({}), undefined);
  assert.equal(workspaceFromEntity({ id: '', record: {} }), undefined);
  // A missing record still yields a usable entry with defaults.
  const bare = workspaceFromEntity({ id: 'w1' });
  assert.equal(bare.path, '');
  assert.deepEqual(bare.sessionIds, []);
});

test('non-string session ids are filtered out of the projection', () => {
  const projected = workspaceFromEntity({
    id: 'w1', record: { sessionIds: ['s1', 42, null, 's2'] },
  });
  assert.deepEqual(projected.sessionIds, ['s1', 's2']);
});

test('every registry workspace is returned', () => {
  const ctx = contextWith({
    entities: [entity('w1', '/a'), entity('w2', '/b'), entity('w3', '/c')],
  });
  const workspaces = listWorkspaces(ctx);
  assert.equal(workspaces.length, 3);
  assert.deepEqual(workspaces.map((w) => w.path), ['/a', '/b', '/c']);
});

test('a Host without the registry degrades to an empty list', () => {
  assert.deepEqual(listWorkspaces({ get: () => undefined }), []);
  assert.deepEqual(listWorkspaces({}), []);
});

test('a throwing registry degrades to an empty list instead of propagating', () => {
  const ctx = { get: () => ({ list: () => { throw new Error('registry offline'); } }) };
  assert.deepEqual(listWorkspaces(ctx), []);
});

test('the inventory carries archived session ids when the registry exposes them', () => {
  const ctx = contextWith({
    entities: [entity('w1', '/a')],
    archived: new Set(['s_gone', 's_also_gone']),
  });
  const inventory = listInventory(ctx);
  assert.ok(isArchivedSession(inventory, 's_gone'));
  assert.ok(!isArchivedSession(inventory, 's_other'));
});

test('an archived list given as an array also works', () => {
  const ctx = contextWith({ entities: [], archived: ['s_gone'] });
  assert.deepEqual(listInventory(ctx).archivedSessionIds, ['s_gone']);
});

test('a missing archived list is treated as empty', () => {
  const ctx = contextWith({ entities: [entity('w1', '/a')] });
  assert.deepEqual(listInventory(ctx).archivedSessionIds, []);
});

test('isKnownSession reports every workspace declaring the session', () => {
  const workspaces = [
    { workspaceId: 'w1', path: '/a', sessionIds: ['s1'] },
    { workspaceId: 'w2', path: '/b', sessionIds: ['s1'] },
    { workspaceId: 'w3', path: '/c', sessionIds: ['s2'] },
  ];
  assert.equal(isKnownSession(workspaces, 's1').length, 2);
  assert.equal(isKnownSession(workspaces, 's2').length, 1);
  assert.equal(isKnownSession(workspaces, 's_missing').length, 0);
});

test('titles come from the live sessionTitle service when available', () => {
  const session = { id: 's1' };
  const ctx = contextWith({ title: (s) => (s === session ? { title: '会话标题' } : undefined) });
  assert.equal(sessionTitleFor(ctx, session), '会话标题');
});

test('a session with no live title falls back to an empty string', () => {
  assert.equal(sessionTitleFor(contextWith({ title: () => undefined }), { id: 's1' }), '');
  assert.equal(sessionTitleFor(contextWith({}), { id: 's1' }), '');
  assert.equal(sessionTitleFor(contextWith({}), undefined), '');
});

test('a throwing title service does not break the inventory', () => {
  const ctx = contextWith({ title: () => { throw new Error('title offline'); } });
  assert.equal(sessionTitleFor(ctx, { id: 's1' }), '');
});

test('targets pair each workspace with its own declared sessions', async () => {
  const ctx = contextWith({
    entities: [entity('w1', '/a', ['s1', 's2']), entity('w2', '/b', ['s3'])],
    live: [{ id: 's1' }],
    title: (s) => (s?.id === 's1' ? { title: 'T1' } : undefined),
  });
  const targets = await listWorkspaceTargets(ctx);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0].sessions, [
    { sessionId: 's1', title: 'T1' },
    // A session the workspace lists but that is not live still appears: it is
    // a valid delivery target, just without a resolved title here.
    { sessionId: 's2', title: '' },
  ]);
  assert.deepEqual(targets[1].sessions, [{ sessionId: 's3', title: '' }]);
});

test('a live-store fault does not hide the workspace list', async () => {
  const ctx = {
    get: (key) => {
      if (key === 'workspaceRegistry') return { list: () => [entity('w1', '/a', ['s1'])] };
      if (key === 'sessions') return { list: () => { throw new Error('store offline'); } };
      return undefined;
    },
  };
  const targets = await listWorkspaceTargets(ctx);
  assert.equal(targets.length, 1, 'workspaces must survive a session-store fault');
  assert.equal(targets[0].sessions[0].sessionId, 's1');
});

test('cold sessions are titled from the session-query corpus', async () => {
  // Regression guard for "every option reads （无标题）": the live sessionTitle
  // service folds only in-memory events, so a persisted session has no title
  // there. The corpus folds the session's own log and is the only source that
  // can name history.
  const requested = [];
  const ctx = {
    get: (key) => {
      if (key === 'workspaceRegistry') {
        return { list: () => [entity('w1', '/a', ['s_cold', 's_gone'])] };
      }
      if (key === 'sessionQuery') {
        return {
          readTitleSnapshots: async (ids) => {
            requested.push(...ids);
            return [
              { status: 'fulfilled', value: { title: '历史会话标题' } },
              { status: 'fulfilled', value: {} },
            ];
          },
        };
      }
      return undefined;
    },
  };
  const targets = await listWorkspaceTargets(ctx);
  assert.deepEqual(requested, ['s_cold', 's_gone'], 'ids are looked up in one batch');
  assert.deepEqual(targets[0].sessions, [
    { sessionId: 's_cold', title: '历史会话标题' },
    // A session with no title event still appears, just unnamed.
    { sessionId: 's_gone', title: '' },
  ]);
});

test('a per-session title failure does not blank the other sessions', async () => {
  const ctx = {
    get: (key) => {
      if (key === 'workspaceRegistry') return { list: () => [entity('w1', '/a', ['s1', 's2'])] };
      if (key === 'sessionQuery') {
        return {
          readTitleSnapshots: async () => [
            { status: 'rejected', reason: new Error('log unreadable') },
            { status: 'fulfilled', value: { title: '可读的标题' } },
          ],
        };
      }
      return undefined;
    },
  };
  const targets = await listWorkspaceTargets(ctx);
  assert.deepEqual(targets[0].sessions, [
    { sessionId: 's1', title: '' },
    { sessionId: 's2', title: '可读的标题' },
  ]);
});

test('a title snapshot in object form is unwrapped', async () => {
  const ctx = {
    get: (key) => {
      if (key === 'workspaceRegistry') return { list: () => [entity('w1', '/a', ['s1'])] };
      if (key === 'sessionQuery') {
        return {
          readTitleSnapshots: async () => [
            { status: 'fulfilled', value: { title: { title: '嵌套标题', source: 'user' } } },
          ],
        };
      }
      return undefined;
    },
  };
  const targets = await listWorkspaceTargets(ctx);
  assert.equal(targets[0].sessions[0].title, '嵌套标题');
});

test('a throwing corpus degrades to untitled sessions rather than failing', async () => {
  const ctx = {
    get: (key) => {
      if (key === 'workspaceRegistry') return { list: () => [entity('w1', '/a', ['s1'])] };
      if (key === 'sessionQuery') {
        return { readTitleSnapshots: async () => { throw new Error('corpus offline'); } };
      }
      return undefined;
    },
  };
  const targets = await listWorkspaceTargets(ctx);
  assert.equal(targets.length, 1, 'the picker must still list workspaces');
  assert.equal(targets[0].sessions[0].title, '');
});

test('a Host with no session query still lists workspaces', async () => {
  const ctx = contextWith({ entities: [entity('w1', '/a', ['s1'])] });
  const targets = await listWorkspaceTargets(ctx);
  assert.equal(targets[0].sessions[0].sessionId, 's1');
});

test('an empty inventory makes no title lookup at all', async () => {
  let called = false;
  const ctx = {
    get: (key) => {
      if (key === 'workspaceRegistry') return { list: () => [] };
      if (key === 'sessionQuery') {
        return { readTitleSnapshots: async () => { called = true; return []; } };
      }
      return undefined;
    },
  };
  const targets = await listWorkspaceTargets(ctx);
  assert.deepEqual(targets, []);
  assert.equal(called, false);
});

test('workspaces resolve by path for delivery-time lookup', () => {
  const workspaces = [{ workspaceId: 'w1', path: '/a' }, { workspaceId: 'w2', path: '/b' }];
  assert.equal(findWorkspaceByPath(workspaces, '/b').workspaceId, 'w2');
  assert.equal(findWorkspaceByPath(workspaces, '/missing'), undefined);
});
