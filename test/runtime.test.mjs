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
  const identity = { userOpenId: '' };
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
    snapshot: () => ({ app: { userOpenId: identity.userOpenId }, monitors: state, pollIntervalMs: 30000 }),
    saveUserOpenId: async (openId) => {
      identity.userOpenId = openId;
      return openId;
    },
    setMonitorSession: (id, patch) => {
      const index = state.findIndex((m) => m.monitorId === id);
      if (index < 0) return Promise.resolve(undefined);
      if (patch.sessionId !== undefined) state[index].sessionId = patch.sessionId;
      if (patch.sessionTitle !== undefined) state[index].sessionTitle = patch.sessionTitle;
      return Promise.resolve({ ...state[index] });
    },
    state,
    identity,
  };
}

/** Delivery double recording each batch; fails the first `failTimes` prompts. */
function fakeDeliverer({ fail = false, failTimes = 0 } = {}) {
  const batches = [];
  let attempts = 0;
  return {
    batches,
    deliver: async (monitor, bodies) => {
      attempts += 1;
      if (fail || attempts <= failTimes) throw new Error('delivery failed');
      batches.push({ monitorId: monitor.monitorId, bodies: [...bodies] });
      return { delivered: bodies.length };
    },
    forget: () => {},
  };
}

/** Client double returning a scripted message page and a user identity. */
function fakeClient(messages, { identity, identityError } = {}) {
  const calls = [];
  const client = {
    calls,
    userInfoCalls: 0,
    listMessages: async (options) => {
      calls.push(options);
      return messages;
    },
    userInfo: async () => {
      client.userInfoCalls += 1;
      if (identityError) throw identityError;
      return identity;
    },
  };
  return client;
}

function feishuMessage({
  id, text, timeMs, sender = '张三', senderType = 'user', type = 'text', senderId, senderFields,
  mentions, content,
}) {
  return {
    message_id: id,
    msg_type: type,
    create_time: String(timeMs),
    deleted: false,
    sender: {
      sender_type: senderType,
      name: sender,
      ...(senderId ? { sender_id: { open_id: senderId } } : {}),
      ...(senderFields ?? {}),
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
  getBotOpenId, getAppId,
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
    getAppId,
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
  assert.deepEqual(deliverer.batches[0].bodies, [
    '2023-11-15 06:13:20 [张三] [om_1] 第一条',
    '2023-11-15 06:13:21 [张三] [om_2] 第二条',
  ]);
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
  assert.deepEqual(deliverer.batches[0].bodies, ['2023-11-15 06:13:20 [张三] [om_1] 正文']);
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
  assert.deepEqual(deliverer.batches[0].bodies, ['2023-11-15 06:13:20 [张三] [om_new] 新的']);
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
  assert.deepEqual(deliverer.batches[0].bodies, ['2023-11-15 06:13:20 [智能纪要助手（机器人）] [om_1] 纪要链接']);
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
  assert.deepEqual(deliverer.batches[0].bodies, ['2023-11-15 06:13:21 [张三] [om_2] 正常消息']);
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
  assert.deepEqual(gated.batches[0].bodies, ['2023-11-15 06:13:20 [张三] [om_1] 会议纪要链接']);
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
    ['2023-11-15 06:13:20 [张三] [om_card] 构建失败：流水线 (https://ci.example.com/1)'],
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

test('skipBotMessages drops the app bot\'s own messages and delivers everyone else', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '同事说的', timeMs: 1_700_000_000_000, sender: '同事', senderId: 'ou_other' }),
    feishuMessage({
      id: 'om_2', text: '机器人自己的回复', timeMs: 1_700_000_001_000, sender: '巡检机器人', senderType: 'app',
      senderFields: { id: 'cli_self', id_type: 'app_id' },
    }),
    feishuMessage({
      id: 'om_3', text: '别的机器人的回复', timeMs: 1_700_000_002_000, sender: '旁路机器人', senderType: 'app',
      senderFields: { id: 'cli_other', id_type: 'app_id' },
    }),
  ];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ skipBotMessages: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages, deliverer,
    getAppId: () => 'cli_self',
  });
  await runtime.poll();
  // Only this app's output is its own echo; every other speaker, the other
  // app included, is still conversation.
  assert.deepEqual(deliverer.batches[0].bodies, [
    '2023-11-15 06:13:20 [同事] [om_1] 同事说的',
    '2023-11-15 06:13:22 [旁路机器人（机器人）] [om_3] 别的机器人的回复',
  ]);
  // The cursor must pass the skipped message, or it is re-read every poll.
  assert.equal(store.state[0].cursor.lastMessageId, 'om_3');
});

test('a page of only the bot\'s messages delivers nothing but still advances', async () => {
  const deliverer = fakeDeliverer();
  const messages = [feishuMessage({
    id: 'om_1', text: '自己的回复', timeMs: 1_700_000_000_000, sender: '巡检机器人', senderType: 'app',
    senderFields: { id: 'cli_self', id_type: 'app_id' },
  })];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ skipBotMessages: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages, deliverer,
    getAppId: () => 'cli_self',
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
  assert.equal(store.state[0].cursor.lastMessageId, 'om_1');
  const status = runtime.status().find((s) => s.monitorId === store.state[0].monitorId);
  assert.equal(status?.lastSkip?.reason, 'bot');
});

test('a person\'s messages are delivered with the bot filter on', async () => {
  const deliverer = fakeDeliverer();
  const client = fakeClient([
    feishuMessage({ id: 'om_1', text: '我发的', timeMs: 1_700_000_000_000, sender: '我', senderId: 'ou_me' }),
  ]);
  const { runtime } = runtimeFor({
    monitors: [monitor({ skipBotMessages: true })], deliverer, client,
    getAppId: () => 'cli_self',
  });
  await runtime.poll();
  // The switch filters the bot, not the operator: the App ID from settings
  // decides it, with no extra read.
  assert.deepEqual(deliverer.batches[0].bodies, ['2023-11-15 06:13:20 [我] [om_1] 我发的']);
});

test('the bot filter fails open when the App ID is unknown', async () => {
  const deliverer = fakeDeliverer();
  const messages = [feishuMessage({
    id: 'om_1', text: '看起来像机器人', timeMs: 1_700_000_000_000, sender: '未知', senderType: 'app',
    senderFields: { id: 'cli_self', id_type: 'app_id' },
  })];
  const { runtime } = runtimeFor({
    monitors: [monitor({ skipBotMessages: true })], messages, deliverer,
  });
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['2023-11-15 06:13:20 [未知（机器人）] [om_1] 看起来像机器人']);
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
  assert.deepEqual(deliverer.batches[0].bodies, ['2023-11-15 06:13:20 [张三] [om_1] 白名单内']);
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
  assert.deepEqual(deliverer.batches[0].bodies, ['2023-11-15 06:13:20 [张三] [om_1] 叫我']);
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
  assert.deepEqual(deliverer.batches[0].bodies, [
    '2023-11-15 06:13:20 [张三] [om_1] 白名单内的普通消息',
    '2023-11-15 06:13:21 [李四] [om_2] 路人点名机器人',
  ]);
  assert.equal(store.state[0].cursor.lastMessageId, 'om_3');
});

test('a message that @-mentions the operator is delivered past the sender list and both keyword lists', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    // Someone asking the operator a question, with words both lists would
    // otherwise stop: addressed, so it goes.
    feishuMessage({
      id: 'om_1', text: '@_user_1 帮我查一下这个广告位', timeMs: 1_700_000_000_000, sender: '陆宝勤', senderId: 'ou_kenlu',
      mentions: [{ key: '@_user_1', id: 'ou_me', id_type: 'open_id', name: '黄天沛' }],
    }),
    // Polled traffic from the same person: still filtered.
    feishuMessage({ id: 'om_2', text: '【客户问题】随口一提', timeMs: 1_700_000_001_000, sender: '陆宝勤', senderId: 'ou_kenlu' }),
  ];
  const client = fakeClient(messages, { identity: { openId: 'ou_me' } });
  const { runtime, store } = runtimeFor({
    monitors: [monitor({
      alsoOperatorMention: true,
      onlySenderIds: ['ou_boss'],
      allowedKeywords: ['【客户问题】'],
      blockedKeywords: ['广告'],
      cursor: { lastCreateTimeMs: 1_699_999_999_000 },
    })],
    client, deliverer,
  });
  await runtime.poll();
  assert.deepEqual(deliverer.batches[0].bodies, ['2023-11-15 06:13:20 [陆宝勤] [om_1] @黄天沛 帮我查一下这个广告位']);
  assert.equal(store.state[0].cursor.lastMessageId, 'om_2');
  const status = runtime.status().find((s) => s.monitorId === store.state[0].monitorId);
  assert.equal(status?.operatorKnown, true);
});

test('the @我 rule is off unless the monitor asks for it', async () => {
  const deliverer = fakeDeliverer();
  const messages = [feishuMessage({
    id: 'om_1', text: '@_user_1 问一下', timeMs: 1_700_000_000_000, sender: '陆宝勤', senderId: 'ou_kenlu',
    mentions: [{ key: '@_user_1', id: 'ou_me', id_type: 'open_id', name: '黄天沛' }],
  })];
  const client = fakeClient(messages, { identity: { openId: 'ou_me' } });
  const { runtime } = runtimeFor({
    monitors: [monitor({ onlySenderIds: ['ou_boss'], cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    client, deliverer,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
  // No switch, no identity read.
  assert.equal(client.userInfoCalls, 0);
});

test('the operator open_id is read once and written back to settings', async () => {
  const deliverer = fakeDeliverer();
  const messages = [feishuMessage({ id: 'om_1', text: '普通消息', timeMs: 1_700_000_000_000, sender: '同事', senderId: 'ou_other' })];
  const client = fakeClient(messages, { identity: { openId: 'ou_me' } });
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ alsoOperatorMention: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    client, deliverer,
  });
  await runtime.poll();
  await runtime.poll();
  assert.equal(client.userInfoCalls, 1);
  assert.equal(store.identity.userOpenId, 'ou_me');
});

test('an unreadable identity leaves the @我 rule inactive and says so', async () => {
  const deliverer = fakeDeliverer();
  const warnings = [];
  const messages = [feishuMessage({
    id: 'om_1', text: '@_user_1 问一下', timeMs: 1_700_000_000_000, sender: '陆宝勤', senderId: 'ou_kenlu',
    mentions: [{ key: '@_user_1', id: 'ou_me', id_type: 'open_id', name: '黄天沛' }],
  })];
  const client = fakeClient(messages, { identityError: new Error('user_info unavailable') });
  const { runtime } = runtimeFor({
    monitors: [monitor({
      alsoOperatorMention: true, onlySenderIds: ['ou_boss'], cursor: { lastCreateTimeMs: 1_699_999_999_000 },
    })],
    client, deliverer,
    logger: { warn: (...args) => warnings.push(args), error: () => {} },
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
  assert.equal(runtime.status()[0]?.operatorKnown, false);
  assert.ok(warnings.some((args) => /身份/.test(String(args[0]))));
});

test('anyone who @-mentions the bot is delivered, the operator included', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '@_user_1 我自己 @机器人', timeMs: 1_700_000_000_000, sender: '我', senderId: 'ou_me', mentions: [{ key: '@_user_1', id: 'ou_bot' }] }),
    feishuMessage({ id: 'om_2', text: '@_user_1 同事 @机器人', timeMs: 1_700_000_001_000, sender: '李四', senderId: 'ou_b', mentions: [{ key: '@_user_1', id: 'ou_bot' }] }),
  ];
  const { runtime } = runtimeFor({
    monitors: [monitor({
      skipBotMessages: true, alsoBotMention: true, cursor: { lastCreateTimeMs: 1_699_999_999_000 },
    })],
    messages, deliverer,
    getBotOpenId: async () => 'ou_bot',
    getAppId: () => 'cli_self',
  });
  await runtime.poll();
  // Addressing the bot is the signal, whoever does it. The bot filter only
  // removes the bot's own output, so both asks arrive.
  assert.deepEqual(deliverer.batches[0].bodies, [
    '2023-11-15 06:13:20 [我] [om_1] @_user_1 我自己 @机器人',
    '2023-11-15 06:13:21 [李四] [om_2] @_user_1 同事 @机器人',
  ]);
});

test('@bot messages bypass both keyword lists; the lists only trim polled traffic', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    // Admitted by the sender list, then by the allowlist keyword.
    feishuMessage({ id: 'om_1', text: '【客户问题】车机掉线', timeMs: 1_700_000_000_000, sender: '李四', senderId: 'ou_a' }),
    // Admitted only by the mention: it never carries the capture keyword.
    feishuMessage({
      id: 'om_2', text: '帮我查一台车', timeMs: 1_700_000_001_000, sender: '王五', senderId: 'ou_c',
      mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: 'open_id', name: '巡检机器人' }],
    }),
    // Mentions the bot AND trips the blacklist: addressed, so it still goes.
    feishuMessage({
      id: 'om_3', text: '帮我查一下广告位', timeMs: 1_700_000_002_000, sender: '王五', senderId: 'ou_c',
      mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: 'open_id', name: '巡检机器人' }],
    }),
    // Same blacklisted word, no mention: this is polled traffic, so it stops.
    feishuMessage({ id: 'om_4', text: '广告位招租', timeMs: 1_700_000_003_000, sender: '赵六', senderId: 'ou_d' }),
    // Neither a listed sender nor a mention: stays out.
    feishuMessage({ id: 'om_5', text: '闲聊一句', timeMs: 1_700_000_004_000, sender: '赵六', senderId: 'ou_d' }),
  ];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({
      onlySenderIds: ['ou_a'],
      allowedKeywords: ['【客户问题】'],
      blockedKeywords: ['广告'],
      alsoBotMention: true,
      cursor: { lastCreateTimeMs: 1_699_999_999_000 },
    })],
    messages, deliverer,
    getBotOpenId: async () => 'ou_bot',
  });
  await runtime.poll();
  // Both one-word lists describe the polled stream. A message that names the
  // bot is a request, so neither the capture rule nor the blacklist stops it.
  assert.deepEqual(deliverer.batches[0].bodies, [
    '2023-11-15 06:13:20 [李四] [om_1] 【客户问题】车机掉线',
    '2023-11-15 06:13:21 [王五] [om_2] 帮我查一台车',
    '2023-11-15 06:13:22 [王五] [om_3] 帮我查一下广告位',
  ]);
  assert.equal(store.state[0].cursor.lastMessageId, 'om_5');
  const status = runtime.status().find((s) => s.monitorId === store.state[0].monitorId);
  assert.equal(status?.skipped, 2);
  assert.equal(status?.lastSkip?.reason, 'sender');
  assert.equal(status?.lastSkip?.messageId, 'om_5');
});

test('a filtered page is reported in the status instead of vanishing', async () => {
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '普通的闲聊消息', timeMs: 1_700_000_000_000, sender: '张三' }),
  ];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({
      allowedKeywords: ['【客户问题】'], cursor: { lastCreateTimeMs: 1_699_999_999_000 },
    })],
    messages, deliverer,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 0);
  // The message was consumed: the cursor moved past it.
  assert.equal(store.state[0].cursor.lastMessageId, 'om_1');
  const status = runtime.status().find((s) => s.monitorId === store.state[0].monitorId);
  assert.equal(status?.skipped, 1);
  assert.deepEqual(status?.lastSkip, {
    at: 1_700_000_000_000, reason: 'allowlist', messageId: 'om_1', sender: '张三',
  });
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

test('a multi-message batch is joined with a separator carrying time, sender, and content', async () => {
  // The digest must read as a transcript: each message on its own line with
  // its time and sender, joined by a visible separator.
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '早上好', timeMs: 1_700_000_000_000 }),
    feishuMessage({ id: 'om_2', text: '下午好', timeMs: 1_700_008_600_000 }),
  ];
  const { runtime } = runtimeFor({
    monitors: [monitor({ cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages, deliverer,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 1);
  const joined = deliverer.batches[0].bodies.join('\n');
  assert.match(joined, /2023-11-15 06:13:20.*张三.*早上好/);
  assert.match(joined, /2023-11-15 08:36:40.*张三.*下午好/);
  assert.equal(deliverer.batches[0].bodies.length, 2);
});

test('multi-message batches are merged into one prompt separated by a rule', async () => {
  // Two fresh messages in one poll must reach the session as ONE prompt whose
  // entries are separated by a visible rule, not as two separate prompts.
  const deliverer = fakeDeliverer();
  const messages = [
    feishuMessage({ id: 'om_1', text: '第一条', timeMs: 1_700_000_000_000 }),
    feishuMessage({ id: 'om_2', text: '第二条', timeMs: 1_700_000_001_000 }),
  ];
  const { runtime } = runtimeFor({
    monitors: [monitor({ cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages, deliverer,
  });
  await runtime.poll();
  assert.equal(deliverer.batches.length, 1, 'one merged prompt per poll');
  assert.equal(deliverer.batches[0].bodies.length, 2, 'both messages ride the same prompt');
});

test('a busy session keeps the batch queued and retries on the next poll', async () => {
  // The session is busy (the prompt is rejected), so this round fails, the
  // cursor does NOT move, and the same batch is retried on the next poll.
  const deliverer = fakeDeliverer({ failTimes: 1 });
  const messages = [feishuMessage({ id: 'om_1', text: '正文', timeMs: 1_700_000_000_000 })];
  const { runtime, store } = runtimeFor({
    monitors: [monitor({ cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages, deliverer,
  });
  await runtime.poll();
  assert.equal(store.state[0].cursor.lastMessageId, undefined, 'cursor held while busy');
  assert.ok(runtime.status()[0].lastError, 'the failure is surfaced in status');

  await runtime.poll();
  assert.equal(deliverer.batches.length, 1, 'retried exactly once on the next poll');
  assert.equal(deliverer.batches[0].bodies[0], '2023-11-15 06:13:20 [张三] [om_1] 正文');
  assert.equal(store.state[0].cursor.lastMessageId, 'om_1', 'cursor advances after retry succeeds');
});

test('a retried batch is not duplicated when the next poll re-reads the same message', async () => {
  // Regression guard: the failed batch stayed queued AND the next poll
  // re-enqueued the same (still-fresh) message, delivering it twice.
  const deliverer = fakeDeliverer({ failTimes: 1 });
  const messages = [feishuMessage({ id: 'om_1', text: '正文', timeMs: 1_700_000_000_000 })];
  const { runtime } = runtimeFor({
    monitors: [monitor({ cursor: { lastCreateTimeMs: 1_699_999_999_000 } })],
    messages, deliverer,
  });
  await runtime.poll();
  await runtime.poll();
  const flat = deliverer.batches.flatMap((b) => b.bodies);
  assert.equal(flat.filter((body) => body.includes('om_1')).length, 1, 'om_1 delivered exactly once');
});
