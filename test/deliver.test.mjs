/**
 * Unit tests for session delivery.
 *
 * Delivery is where a monitor meets the Host, so these tests pin the parts
 * that silently corrupt behavior when wrong: adopting before prompting,
 * queue-mode delivery, and the narrow auto-create rule.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { HarnessGateway, SessionDeliverer } from '../src/deliver.mjs';

/** Gateway double recording calls and returning scripted values. */
function fakeGateway({ workspaces = [], sessions = [], createResult, failCreate } = {}) {
  const calls = [];
  return {
    calls,
    // Exposed so the injected inventory reader can serve the same list the
    // gateway's stream would have returned.
    workspaces,
    invoke: async (request) => {
      calls.push(request);
      if (request.namespace === 'workspace') return { ok: true, value: {} };
      if (request.namespace === 'session' && request.method === 'list') {
        return { ok: true, value: { items: sessions } };
      }
      if (request.namespace === 'session' && request.method === 'create') {
        if (failCreate) return { ok: false, error: failCreate };
        return { ok: true, value: createResult };
      }
      if (request.namespace === 'session' && request.method === 'prompt') {
        return { ok: true, value: { accepted: true } };
      }
      return { ok: true, value: {} };
    },
    stream: async () => ({
      [Symbol.asyncIterator]: () => {
        let sent = false;
        return {
          next: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: { type: 'baseline', value: { items: workspaces } } };
          },
          return: async () => ({ done: true }),
        };
      },
    }),
    workspaces,
  };
}

/** Store double capturing session writes. */
function fakeStore() {
  const writes = [];
  return {
    writes,
    setMonitorSession: async (id, patch) => { writes.push({ id, patch }); },
  };
}

function workspaceItem(path, sessionIds, workspaceId = `w_${path}`) {
  return { workspaceId, path, sessionIds, archivedSessionIds: [] };
}

function monitor(overrides = {}) {
  return {
    monitorId: 'mon_0123456789abcdef',
    sessionId: 's_1',
    workspace: '/w',
    prompt: '归档',
    ...overrides,
  };
}

/**
 * Build a deliverer over a gateway double.
 *
 * `archivedSessionIds` mirrors the registry's deleted-session list, which is
 * what separates "the target was deleted" (recoverable) from "the target was
 * never registered" (a misconfiguration).
 */
function delivererFor(gateway, store = fakeStore(), { archivedSessionIds = [] } = {}) {
  return {
    deliverer: new SessionDeliverer({
      harness: new HarnessGateway({ gateway }),
      store,
      logger: { warn: () => {}, error: () => {} },
      readInventory: async () => ({
        workspaces: gateway.workspaces ?? [],
        archivedSessionIds,
      }),
    }),
    store,
  };
}

test('delivery adopts the session before prompting it', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', ['s_1'])],
    sessions: [{ sessionId: 's_1' }],
    createResult: { sessionId: 's_1' },
  });
  const { deliverer } = delivererFor(gateway);
  await deliverer.deliver(monitor(), ['正文']);
  const methods = gateway.calls.map((c) => `${c.namespace}.${c.method}`);
  assert.ok(methods.includes('session.create'));
  const promptIndex = methods.lastIndexOf('session.prompt');
  const adoptIndex = methods.lastIndexOf('session.create');
  assert.ok(adoptIndex < promptIndex, 'adopt must precede prompt');
});

test('the prompt is submitted in queue mode with a text block', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', ['s_1'])],
    sessions: [{ sessionId: 's_1' }],
    createResult: { sessionId: 's_1' },
  });
  const { deliverer } = delivererFor(gateway);
  await deliverer.deliver(monitor(), ['第一条', '第二条']);
  const promptCall = gateway.calls.find((c) => c.method === 'prompt');
  assert.equal(promptCall.args.request.mode, 'queue');
  assert.deepEqual(promptCall.args.request.content, [{ type: 'text', text: '归档\n\n第一条\n\n第二条' }]);
  assert.equal(promptCall.args.request.sessionId, 's_1');
});

test('adoption is cached across deliveries', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', ['s_1'])],
    sessions: [{ sessionId: 's_1' }],
    createResult: { sessionId: 's_1' },
  });
  const { deliverer } = delivererFor(gateway);
  await deliverer.deliver(monitor(), ['a']);
  await deliverer.deliver(monitor(), ['b']);
  const adoptions = gateway.calls.filter((c) => c.method === 'create').length;
  assert.equal(adoptions, 1);
});

test('a session owned by no workspace is refused with a typed code', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', ['s_other'])],
    sessions: [{ sessionId: 's_1' }],
  });
  const { deliverer } = delivererFor(gateway);
  await assert.rejects(
    () => deliverer.deliver(monitor(), ['正文']),
    (error) => error.code === 'session-not-registered',
  );
});

test('a session owned by two workspaces is refused as ambiguous', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w1', ['s_1'], 'w1'), workspaceItem('/w2', ['s_1'], 'w2')],
    sessions: [{ sessionId: 's_1' }],
  });
  const { deliverer } = delivererFor(gateway);
  await assert.rejects(
    () => deliverer.deliver(monitor(), ['正文']),
    (error) => error.code === 'session-workspace-ambiguous',
  );
});

test('an id no workspace ever declared is refused, not silently replaced', async () => {
  // Regression guard: auto-creating here would appear to fix a wrong Session
  // ID while delivering somewhere the user never chose. Only a *deleted*
  // (archived) session is recoverable.
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', ['s_other'])],
    sessions: [],
    createResult: { sessionId: 's_new' },
  });
  const { deliverer } = delivererFor(gateway, fakeStore(), { archivedSessionIds: [] });
  await assert.rejects(
    () => deliverer.deliver(monitor(), ['正文']),
    (error) => error.code === 'session-not-registered',
  );
  // No session may be created for a misconfiguration.
  assert.equal(gateway.calls.filter((c) => c.method === 'create').length, 0);
});

test('a deleted session is replaced by a new one in the monitor workspace', async () => {
  const gateway = fakeGateway({
    // s_1 is absent from every workspace and listed as archived: the target
    // was deleted, which is the one condition auto-create may recover from.
    workspaces: [workspaceItem('/w', [])],
    sessions: [],
    createResult: { sessionId: 's_new' },
  });
  const store = fakeStore();
  const { deliverer } = delivererFor(gateway, store, { archivedSessionIds: ['s_1'] });
  const result = await deliverer.deliver(monitor(), ['正文']);
  assert.equal(result.sessionId, 's_new');
  // The recreate call must not carry the dead session's id.
  const createCalls = gateway.calls.filter((c) => c.method === 'create');
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].args.request.sessionId, undefined);
  // The new session is written back so the next poll reuses it.
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].patch.sessionId, 's_new');
});

test('auto-create is throttled so a broken config cannot spawn sessions', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', [])],
    sessions: [],
    createResult: { sessionId: 's_new' },
  });
  const { deliverer } = delivererFor(gateway, fakeStore(), { archivedSessionIds: ['s_1'] });
  await deliverer.deliver(monitor(), ['a']);
  deliverer.forget(monitor().monitorId);
  await assert.rejects(
    () => deliverer.deliver(monitor(), ['b']),
    (error) => error.code === 'session-recreate-throttled',
  );
});

test('auto-create without a workspace is refused rather than guessed', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', [])],
    sessions: [],
    createResult: { sessionId: 's_new' },
  });
  const { deliverer } = delivererFor(gateway, fakeStore(), { archivedSessionIds: ['s_1'] });
  await assert.rejects(
    () => deliverer.deliver(monitor({ workspace: '' }), ['a']),
    (error) => error.code === 'session-recreate-no-workspace',
  );
});

test('a monitor with neither a session nor a workspace is refused', async () => {
  const gateway = fakeGateway({});
  const { deliverer } = delivererFor(gateway);
  await assert.rejects(
    () => deliverer.deliver(monitor({ sessionId: '', workspace: '' }), ['a']),
    (error) => error.code === 'monitor-target-missing',
  );
  assert.equal(gateway.calls.length, 0);
});

test('an empty session creates one session per delivery and does not persist it', async () => {
  // "Leave the target blank" means one session per message: writing the
  // created id back would silently collapse that into a single-target monitor.
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', [])],
    sessions: [],
    createResult: { sessionId: 's_auto' },
  });
  const store = fakeStore();
  const { deliverer } = delivererFor(gateway, store);
  const first = await deliverer.deliver(monitor({ sessionId: '' }), ['a']);
  const second = await deliverer.deliver(monitor({ sessionId: '' }), ['b']);
  assert.equal(first.sessionId, 's_auto');
  assert.equal(second.sessionId, 's_auto');
  // Two creates, and nothing written back to the monitor.
  assert.equal(gateway.calls.filter((c) => c.method === 'create').length, 2);
  assert.equal(store.writes.length, 0);
});

test('the per-message mode still uses the monitor workspace', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', [])],
    sessions: [],
    createResult: { sessionId: 's_new' },
  });
  const { deliverer } = delivererFor(gateway);
  await deliverer.deliver(monitor({ sessionId: '' }), ['a']);
  const create = gateway.calls.find((c) => c.method === 'create');
  assert.equal(create.args.request.workspaceId, 'w_/w');
  assert.equal(create.args.request.sessionId, undefined);
});

test('auto-create-and-pin writes the new session back so it is reused', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', [])],
    sessions: [],
    createResult: { sessionId: 's_pinned' },
  });
  const store = fakeStore();
  const { deliverer } = delivererFor(gateway, store);
  const result = await deliverer.deliver(
    monitor({ sessionId: '', autoCreateAndPin: true }), ['a'],
  );
  assert.equal(result.sessionId, 's_pinned');
  // The pin is the whole point: the id must be persisted for later batches.
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].patch.sessionId, 's_pinned');
});

test('pinning is off unless explicitly requested', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', [])],
    sessions: [],
    createResult: { sessionId: 's_new' },
  });
  const store = fakeStore();
  const { deliverer } = delivererFor(gateway, store);
  await deliverer.deliver(monitor({ sessionId: '', autoCreateAndPin: false }), ['a']);
  assert.equal(store.writes.length, 0);
});

test('a bad workspace path in per-message mode is refused as such', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/other', [])],
    sessions: [],
    createResult: { sessionId: 's_new' },
  });
  const { deliverer } = delivererFor(gateway);
  await assert.rejects(
    () => deliverer.deliver(monitor({ sessionId: '', workspace: '/missing' }), ['a']),
    (error) => error.code === 'workspace-not-found',
  );
});

test('an empty batch performs no work at all', async () => {
  const gateway = fakeGateway({});
  const { deliverer } = delivererFor(gateway);
  const result = await deliverer.deliver(monitor(), []);
  assert.equal(result.delivered, 0);
  assert.equal(gateway.calls.length, 0);
});

test('a remote failure envelope is surfaced as a thrown error', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', ['s_1'])],
    sessions: [{ sessionId: 's_1' }],
    createResult: { sessionId: 's_1' },
  });
  gateway.invoke = async (request) => {
    if (request.method === 'prompt') {
      return { ok: false, error: { code: 'session-not-found', message: 'gone' } };
    }
    if (request.method === 'list') return { ok: true, value: { items: [{ sessionId: 's_1' }] } };
    if (request.method === 'create') return { ok: true, value: { sessionId: 's_1' } };
    return { ok: true, value: {} };
  };
  const { deliverer } = delivererFor(gateway);
  await assert.rejects(() => deliverer.deliver(monitor(), ['a']), /gone/);
});

test('the gateway reads workspaces from the follow stream baseline', async () => {
  const gateway = fakeGateway({
    workspaces: [workspaceItem('/w', ['s_1'])],
    sessions: [{ sessionId: 's_1' }],
    createResult: { sessionId: 's_1' },
  });
  const harness = new HarnessGateway({ gateway });
  const workspaces = await harness.listWorkspaces();
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].path, '/w');
});
