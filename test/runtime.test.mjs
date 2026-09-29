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

/** Client double returning a scripted message page and, optionally, an identity. */
function fakeClient(messages, { identity, identityError } = {}) {
  const calls = [];
  const client = {
    calls,
    listMessages: async (options) => {
      calls.push(options);
      return messages;
    },
  };
  if (identity !== undefined || identityError !== undefined) {
    client.userInfoCalls = 0;
    client.userInfo = async () => {
      client.userInfoCalls += 1;
      if (identityError) throw identityError;
      return identity;
    };
  }
  return client;
}

function feishuMessage({ id, text, timeMs, sender = '张三', senderType = 'user', type = 'text', senderId, mentions, content }) {
  return {
    message_id: id,
    msg_type: type,
    create_time: String(timeMs),
    deleted: false,
    sender: {
      sender_type: senderType,
      name: sender,
      ...(senderId ? { sender_id: { open_id: senderId } } : {}),
    },
    ...(mentions ? { mentions } : {}),
    body: { content: JSON.stringify(content ?? { text }) },
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

function runtimeFor({
  monitors, messages, deliverer, now = () => 1_700_000_000_000, client,
  logger = { warn: () => {}, error: () => {} }, getIntervalMs = () => 30_000,
  getBotOpenId,
}) {
  const store = fakeStore(monitors);
  const clientImpl = client ?? fakeClient(messages);
  const runtime = new MonitorRuntime({
    store,
    deliverer,
    getClient: async () => clientImpl,
    getIntervalMs,
    logger,
    now,
    getBotOpenId,
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
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] [om_1] 第一条', '[张三] [om_2] 第二条']);
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
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] [om_1] 正文']);
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
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] [om_new] 新的']);
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
  assert.deepEqual(deliverer.batches[0].bodies, ['[智能纪要助手（机器人）] [om_1] 纪要链接']);
});

test('a message matching any blocked keyword is skipped, cursor still moves', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '周报链接', timeMs: 1_700_000_000_000 }),
    feishuMessage({ id: 'om_2', text: '正常消息', timeMs: 1_700_000_001_000 }),
  ];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ blockedKeywords: ['周报'] })], messages, deliverer,
  });
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] [om_2] 正常消息']);
  // The blocked message must not stall the cursor: it is consumed, not retried.
  assert.equal(store.state[0].cursor.lastMessageId, 'om_2');
});

test('blocked keywords match the rendered text of cards too', async () => {
  const deliverer = fakeDeliverer();
  const messages = [feishuMessage({
    id: 'om_1', type: 'interactive', timeMs: 1_700_000_000_000,
    content: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '会议纪要已生成' } }] },
  })];
  const { runtime } = runtimeFor({
    monitors: [monitor({ blockedKeywords: ['纪要'] })], messages, deliverer,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
});

test('an empty allowed list delivers everything; a non-empty one gates on hits', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '会议纪要链接', timeMs: 1_700_000_000_000 }),
    feishuMessage({ id: 'om_2', text: '闲聊一句', timeMs: 1_700_000_001_000 }),
  ];
  // Empty allowlist = no restriction.
  const open = runtimeFor({ monitors: [monitor({ allowedKeywords: [] })], messages, deliverer });
  await open.runtime.poll();
  assert.equal(deliverer.batches[0].bodies.length, 2);

  const gated = fakeDeliverer();
  const { runtime } = runtimeFor({
    monitors: [monitor({ allowedKeywords: ['纪要', '周报'] })], messages, deliverer: gated,
  });
  await runtime.poll();
  assert.deepEqual(gated.batches[0].bodies, ['[张三] [om_1] 会议纪要链接']);
});

test('the blacklist wins over the allowlist for the same message', async () => {
  const deliverer = fakeDeliverer();
  const messages = [feishuMessage({ id: 'om_1', text: '会议纪要：广告版本', timeMs: 1_700_000_000_000 })];
  const { runtime } = runtimeFor({
    monitors: [monitor({ allowedKeywords: ['纪要'], blockedKeywords: ['广告'] })], messages, deliverer,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
});

test('card messages are read with their original JSON and delivered as content', async () => {
  const deliverer = fakeDeliverer();
  const messages = [feishuMessage({
    id: 'om_card', type: 'interactive', timeMs: 1_700_000_000_000,
    content: {
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '构建失败：<a href="https://ci.example.com/1">流水线</a>' } },
      ],
    },
  })];
  const { runtime, client } = runtimeFor({ monitors: [monitor()], messages, deliverer });
  await runtime.poll();
  assert.equal(client.calls[0].cardMsgContentType, 'user_card_content');
  assert.deepEqual(
    deliverer.batches[0].bodies,
    ['[张三] [om_card] 构建失败：流水线 (https://ci.example.com/1)'],
  );
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

test('skipOwnMessages drops your own messages and delivers the rest', async () => {
  const deliverer = fakeDeliverer();
  const identity = { openId: 'ou_me', unionId: 'on_me', userId: '', name: '我' };
  const messages = [
    feishuMessage({ id: 'om_1', text: '别人的', timeMs: 1_700_000_000_000, sender: '同事', senderId: 'ou_other' }),
    feishuMessage({ id: 'om_2', text: '我的', timeMs: 1_700_000_001_000, sender: '我', senderId: 'ou_me' }),
  ];
  const client = fakeClient(messages, { identity });
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ skipOwnMessages: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    deliverer, client,
  });
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['[同事] [om_1] 别人的']);
  // The cursor must pass the skipped message, or it is re-read every poll.
  assert.equal(store.state[0].cursor.lastMessageId, 'om_2');
});

test('a batch of only your own messages delivers nothing but still advances', async () => {
  const deliverer = fakeDeliverer();
  const identity = { openId: 'ou_me', unionId: 'on_me', userId: '', name: '我' };
  const messages = [feishuMessage({ id: 'om_1', text: '我的', timeMs: 1_700_000_000_000, senderId: 'ou_me' })];
  const client = fakeClient(messages, { identity });
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ skipOwnMessages: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    deliverer, client,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
  assert.equal(store.state[0].cursor.lastMessageId, 'om_1');
});

test('own messages are delivered when the filter is off, and no identity is fetched', async () => {
  const deliverer = fakeDeliverer();
  const identity = { openId: 'ou_me', unionId: 'on_me', userId: '', name: '我' };
  const messages = [feishuMessage({ id: 'om_1', text: '我的', timeMs: 1_700_000_000_000, senderId: 'ou_me' })];
  const client = fakeClient(messages, { identity });
  const { runtime } = runtimeFor({ monitors: [monitor()], deliverer, client });
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] [om_1] 我的']);
  assert.equal(client.userInfoCalls, 0);
});

test('a failed identity fetch fails open instead of dropping messages', async () => {
  const deliverer = fakeDeliverer();
  const warnings = [];
  const messages = [feishuMessage({ id: 'om_1', text: '我的', timeMs: 1_700_000_000_000, senderId: 'ou_me' })];
  const client = fakeClient(messages, { identityError: new Error('user_info unavailable') });
  const { runtime } = runtimeFor({
    monitors: [monitor({ skipOwnMessages: true })],
    deliverer, client,
    logger: { warn: (...args) => warnings.push(args), error: () => {} },
  });
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] [om_1] 我的']);
  assert.ok(warnings.some((args) => /identity/.test(String(args[0]))));
});

test('start schedules the timer at the configured interval, down to two seconds', () => {
  // Observe the real timer contract rather than internals: the delay handed
  // to setInterval is what the user configured.
  const original = globalThis.setInterval;
  let observed = 0;
  globalThis.setInterval = (handler, delay, ...rest) => {
    observed = delay;
    return original(handler, delay, ...rest);
  };
  try {
    const { runtime } = runtimeFor({
      monitors: [], messages: [], deliverer: fakeDeliverer(),
      getIntervalMs: () => 2_000,
    });
    runtime.start();
    runtime.stop();
    assert.equal(observed, 2_000);
  } finally {
    globalThis.setInterval = original;
  }
});

test('onlySenderIds delivers just the whitelisted senders', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '白名单内', timeMs: 1_700_000_000_000, sender: '张三', senderId: 'ou_a' }),
    feishuMessage({ id: 'om_2', text: '白名单外', timeMs: 1_700_000_001_000, sender: '李四', senderId: 'ou_b' }),
  ];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ onlySenderIds: ['ou_a'], cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages, deliverer,
  });
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] [om_1] 白名单内']);
  // The cursor passes the skipped sender's message, so it is not re-read.
  assert.equal(store.state[0].cursor.lastMessageId, 'om_2');
});

test('alsoBotMention with an empty sender list means only @bot messages', async () => {
  const deliverer = fakeDeliverer();
  let botIdCalls = 0;
  const messages = [
    feishuMessage({ id: 'om_1', text: '叫我', timeMs: 1_700_000_000_000, mentions: [{ key: '@_user_1', id: 'ou_bot' }] }),
    feishuMessage({ id: 'om_2', text: '不叫我', timeMs: 1_700_000_001_000 }),
  ];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ alsoBotMention: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages, deliverer,
    getBotOpenId: async () => { botIdCalls += 1; return 'ou_bot'; },
  });
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] [om_1] 叫我']);
  assert.equal(store.state[0].cursor.lastMessageId, 'om_2');
  // The bot identity is cached for the process; a second poll does not re-fetch.
  await runtime.poll();
  assert.equal(botIdCalls, 1);
});

test('an @bot message is delivered even when its sender is not whitelisted', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '白名单内的普通消息', timeMs: 1_700_000_000_000, sender: '张三', senderId: 'ou_a' }),
    feishuMessage({ id: 'om_2', text: '路人点名机器人', timeMs: 1_700_000_001_000, sender: '李四', senderId: 'ou_b', mentions: [{ key: '@_user_1', id: 'ou_bot' }] }),
    feishuMessage({ id: 'om_3', text: '路人的普通消息', timeMs: 1_700_000_002_000, sender: '王五', senderId: 'ou_c' }),
  ];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({
      onlySenderIds: ['ou_a'], alsoBotMention: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 },
    })],
    messages, deliverer,
    getBotOpenId: async () => 'ou_bot',
  });
  await runtime.poll();
  // Both acceptance paths, in conversation order: the whitelisted sender,
  // and the @bot mention from outside the whitelist.
  assert.deepEqual(deliverer.batches[0].bodies, ['[张三] [om_1] 白名单内的普通消息', '[李四] [om_2] 路人点名机器人']);
  assert.equal(store.state[0].cursor.lastMessageId, 'om_3');
});

test('the mention path does not resurrect own messages', async () => {
  const deliverer = fakeDeliverer();
  const identity = { openId: 'ou_me', unionId: 'on_me', userId: '', name: '我' };
  const messages = [
    feishuMessage({ id: 'om_1', text: '我自己@机器人测试', timeMs: 1_700_000_000_000, sender: '我', senderId: 'ou_me', mentions: [{ key: '@_user_1', id: 'ou_bot' }] }),
    feishuMessage({ id: 'om_2', text: '同事@机器人', timeMs: 1_700_000_001_000, sender: '李四', senderId: 'ou_b', mentions: [{ key: '@_user_1', id: 'ou_bot' }] }),
  ];
  const client = fakeClient(messages, { identity });
  const { runtime } = runtimeFor({
    monitors: [monitor({ skipOwnMessages: true, alsoBotMention: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    client, deliverer,
    getBotOpenId: async () => 'ou_bot',
  });
  await runtime.poll();
  // skipOwnMessages still wins over the mention path: only the colleague's
  // @bot message is delivered, the user's own test ping is not.
  assert.deepEqual(deliverer.batches[0].bodies, ['[李四] [om_2] 同事@机器人']);
});

test('a missing bot identity holds the round instead of failing open', async () => {
  const deliverer = fakeDeliverer();
  let botIdCalls = 0;
  const messages = [
    feishuMessage({ id: 'om_1', text: '叫我', timeMs: 1_700_000_000_000, mentions: [{ key: '@_user_1', id: 'ou_bot' }] }),
  ];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ alsoBotMention: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages, deliverer,
    getBotOpenId: async () => { botIdCalls += 1; throw new Error('App Secret 不正确'); },
  });
  await runtime.poll();
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
  // Fail-open would deliver everything — the opposite of the filter's intent.
  // Instead the cursor is held and every poll retries the identity.
  assert.equal(store.state[0].cursor.lastMessageId, undefined);
  assert.equal(botIdCalls, 2);
  const status = runtime.status().find((s) => s.monitorId === store.state[0].monitorId);
  assert.match(String(status?.lastError ?? ''), /机器人/);
});

test('the identity is fetched once and cached across polls', async () => {
  const deliverer = fakeDeliverer();
  const identity = { openId: 'ou_me', unionId: 'on_me', userId: '', name: '我' };
  const messages = [feishuMessage({ id: 'om_1', text: '我的', timeMs: 1_700_000_000_000, senderId: 'ou_me' })];
  const client = fakeClient(messages, { identity });
  const { runtime } = runtimeFor({
    monitors: [monitor({ skipOwnMessages: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    deliverer, client,
  });
  await runtime.poll();
  await runtime.poll();
  assert.equal(client.userInfoCalls, 1);
});
