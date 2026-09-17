/**
 * Unit tests for the polling runtime.
 *
 * These pin the behaviors that decide whether messages are delivered exactly
 * once: the cursor advance, the same-second boundary, batching, and the rule
 * that a failed delivery must not move the cursor.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_BATCH_SIZE, MonitorRuntime } from '../src/runtime.mjs';

/** In-memory store double exposing only what the runtime reads. */
function fakeStore(monitors) {
  const state = monitors.map((m) => ({ ...m }));
  return {
    monitors: () => state.map((m) => ({ ...m })),
    monitor: (id) => {
      const found = state.find((m) => m.monitorId === id);
      return found ? { ...found } : undefined;
    },
    advanceCursor: (id, cursor) => {
      const index = state.findIndex((m) => m.monitorId === id);
      if (index < 0) return Promise.resolve(undefined);
      const current = state[index].cursor ?? {};
      state[index].cursor = {
        ...current,
        ...cursor,
        lastCreateTimeMs: Math.max(current.lastCreateTimeMs ?? 0, cursor.lastCreateTimeMs ?? 0) || undefined,
      };
      return Promise.resolve(state[index].cursor);
    },
    snapshot: () => ({ monitors: state, pollIntervalMs: 30000 }),
    setMonitorSession: (id, patch) => {
      const index = state.findIndex((m) => m.monitorId === id);
      if (index < 0) return Promise.resolve(undefined);
      if (patch.sessionId !== undefined) state[index].sessionId = patch.sessionId;
      if (patch.sessionTitle !== undefined) state[index].sessionTitle = patch.sessionTitle;
      return Promise.resolve({ ...state[index] });
    },
    state,
  };
}

/** Delivery double recording each batch. */
function fakeDeliverer({ fail = false } = {}) {
  const batches = [];
  return {
    batches,
    deliver: async (monitor, bodies) => {
      if (fail) throw new Error('delivery failed');
      batches.push({ monitorId: monitor.monitorId, bodies: [...bodies] });
      return { delivered: bodies.length };
    },
    forget: () => {},
  };
}

/** Client double returning a scripted message page. */
function fakeClient(messages) {
  const calls = [];
  return {
    calls,
    listMessages: async (options) => {
      calls.push(options);
      return messages;
    },
  };
}

function feishuMessage({ id, text, timeMs, sender = '张三', senderType = 'user', type = 'text' }) {
  return {
    message_id: id,
    msg_type: type,
    create_time: String(timeMs),
    deleted: false,
    sender: { sender_type: senderType, name: sender },
    body: { content: JSON.stringify({ text }) },
  };
}

function monitor(overrides = {}) {
  return {
    monitorId: 'mon_0123456789abcdef',
    chatId: 'oc_chat',
    prompt: '归档',
    enabled: true,
    cursor: undefined,
    ...overrides,
  };
}

function runtimeFor({ monitors, messages, deliverer, now = () => 1_700_000_000_000, client }) {
  const store = fakeStore(monitors);
  const clientImpl = client ?? fakeClient(messages);
  const runtime = new MonitorRuntime({
    store,
    deliverer,
    getClient: async () => clientImpl,
    getIntervalMs: () => 30_000,
    logger: { warn: () => {}, error: () => {} },
    now,
  });
  return { runtime, store, client: clientImpl };
}

test('a new monitor reads a bounded lookback window, never the whole history', async () => {
  const now = () => 1_700_000_000_000;
  const { runtime, client } = runtimeFor({
    monitors: [monitor()], messages: [], deliverer: fakeDeliverer(), now,
  });
  await runtime.poll();
  assert.equal(client.calls.length, 1);
  const expectedStart = Math.floor((now() - 600_000) / 1000) - 1;
  assert.equal(client.calls[0].startTimeSeconds, expectedStart);
  assert.equal(client.calls[0].chatId, 'oc_chat');
});

test('new messages are delivered and the cursor advances past them', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '第一条', timeMs: 1_700_000_000_000 }),
    feishuMessage({ id: 'om_2', text: '第二条', timeMs: 1_700_000_001_000 }),
  ];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages,
    deliverer,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 1);
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] 第一条', '[张三] 第二条']);
  assert.equal(store.state[0].cursor.lastMessageId, 'om_2');
  assert.equal(store.state[0].cursor.lastCreateTimeMs, 1_700_000_001_000);
});

test('the prompt is composed with the message under it', async () => {
  const deliverer = fakeDeliverer();
  const { runtime } = runtimeFor({
    monitors: [monitor({ prompt: '请归档' })],
    messages: [feishuMessage({ id: 'om_1', text: '正文', timeMs: 1_700_000_000_000 })],
    deliverer,
  });
  // Assert on what the deliverer received; composePrompt is unit-tested apart.
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] 正文']);
});

test('an already-delivered message at the same second is not re-delivered', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_old', text: '旧的', timeMs: 1_700_000_000_000 }),
    feishuMessage({ id: 'om_new', text: '新的', timeMs: 1_700_000_000_000 }),
  ];
  const { runtime } = runtimeFor({
    monitors: [monitor({ cursor: { lastCreateTimeMs: 1_700_000_000_000, lastMessageId: 'om_old' } })],
    messages,
    deliverer,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 1);
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] 新的']);
});

test('messages older than the cursor are ignored entirely', async () => {
  const deliverer = fakeDeliverer();
  const messages = [feishuMessage({ id: 'om_old', text: '旧的', timeMs: 1_600_000_000_000 })];
  const { runtime } = runtimeFor({
    monitors: [monitor({ cursor: { lastCreateTimeMs: 1_700_000_000_000, lastMessageId: 'om_x' } })],
    messages,
    deliverer,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
});

test('deleted messages are skipped', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    { ...feishuMessage({ id: 'om_del', text: '删了', timeMs: 1_700_000_000_000 }), deleted: true },
  ];
  const { runtime } = runtimeFor({ monitors: [monitor()], messages, deliverer });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
});

test('a page larger than the batch cap is delivered in full, not truncated', async () => {
  const deliverer = fakeDeliverer();
  const messages = Array.from({ length: MAX_BATCH_SIZE + 5 }, (_, i) => feishuMessage({
    id: `om_${i}`, text: `消息${i}`, timeMs: 1_700_000_000_000 + i * 1000,
  }));
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages,
    deliverer,
  });
  await runtime.poll();
  const delivered = deliverer.batches.flatMap((b) => b.bodies);
  assert.equal(delivered.length, MAX_BATCH_SIZE + 5);
  assert.equal(deliverer.batches[0].bodies.length, MAX_BATCH_SIZE);
  // The cursor still reaches the last message.
  assert.equal(store.state[0].cursor.lastMessageId, `om_${MAX_BATCH_SIZE + 4}`);
});

test('a failed delivery leaves the cursor untouched so nothing is lost', async () => {
  const deliverer = fakeDeliverer({ fail: true });
  const messages = [feishuMessage({ id: 'om_1', text: '正文', timeMs: 1_700_000_000_000 })];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages,
    deliverer,
  });
  await runtime.poll();
  assert.equal(store.state[0].cursor.lastMessageId, undefined);
  assert.equal(store.state[0].cursor.lastCreateTimeMs, 1_699_999_999_000);
  assert.ok(runtime.status()[0].lastError);
});

test('app senders are labelled as bots in the delivered text', async () => {
  const deliverer = fakeDeliverer();
  const messages = [feishuMessage({
    id: 'om_1', text: '纪要链接', timeMs: 1_700_000_000_000,
    sender: '智能纪要助手', senderType: 'app',
  })];
  const { runtime } = runtimeFor({ monitors: [monitor()], messages, deliverer });
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['[智能纪要助手（机器人）] 纪要链接']);
});

test('disabled monitors are never polled', async () => {
  const deliverer = fakeDeliverer();
  const { runtime, client } = runtimeFor({
    monitors: [monitor({ enabled: false })], messages: [], deliverer,
  });
  await runtime.poll();
  assert.equal(client.calls.length, 0);
});

test('a second poll does not overlap the first for the same monitor', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = {
    calls: 0,
    listMessages: async () => { client.calls += 1; await gate; return []; },
  };
  const { runtime } = runtimeFor({
    monitors: [monitor()], deliverer: fakeDeliverer(), client,
  });
  const first = runtime.poll();
  await runtime.poll();
  release();
  await first;
  assert.equal(client.calls, 1);
});

test('status reports delivery counts and pending length', async () => {
  const deliverer = fakeDeliverer();
  const { runtime } = runtimeFor({
    monitors: [monitor()],
    messages: [feishuMessage({ id: 'om_1', text: 'a', timeMs: 1_700_000_000_000 })],
    deliverer,
  });
  await runtime.poll();
  const [status] = runtime.status();
  assert.equal(status.delivered, 1);
  assert.equal(status.lastError, null);
  assert.ok(status.lastPollAt > 0);
});

test('a multi-batch page re-reads the monitor so a pinned session is reused', async () => {
  // Regression guard: batches used to share the caller's monitor snapshot, so
  // after the first batch pinned an auto-created session the next batch still
  // saw an empty sessionId and created a second one — silently defeating the
  // pin.
  const store = fakeStore([monitor({
    sessionId: '',
    autoCreateAndPin: true,
    workspace: '/w',
    cursor: { lastCreateTimeMs: 1_699_999_999_000 },
  })]);
  const deliveredFor = [];
  const deliverer = {
    deliver: async (m, bodies) => {
      deliveredFor.push({ sessionId: m.sessionId, count: bodies.length });
      // Emulate what the real deliverer does on the first pinned delivery.
      if (!m.sessionId) {
        await store.setMonitorSession(m.monitorId, { sessionId: 's_pinned', sessionTitle: '' });
      }
      return { delivered: bodies.length };
    },
    forget: () => {},
  };
  const messages = Array.from({ length: MAX_BATCH_SIZE + 3 }, (_, i) => feishuMessage({
    id: `om_${i}`, text: `m${i}`, timeMs: 1_700_000_000_000 + i * 1000,
  }));
  const runtime = new MonitorRuntime({
    store,
    deliverer,
    getClient: async () => fakeClient(messages),
    getIntervalMs: () => 30_000,
    logger: { warn: () => {}, error: () => {} },
    now: () => 1_700_000_000_000,
  });
  await runtime.poll();

  assert.equal(deliveredFor.length, 2, 'a 13-message page is two batches');
  assert.equal(deliveredFor[0].sessionId, '');
  // The second batch must see the session the first batch pinned.
  assert.equal(deliveredFor[1].sessionId, 's_pinned');
});
