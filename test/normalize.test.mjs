/**
 * Unit tests for message normalization.
 *
 * The contract under test: a Feishu message becomes readable text, and raw
 * Feishu JSON never leaks into what a model reads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composePrompt,
  isAppSender,
  renderMessage,
  senderLabel,
} from '../src/normalize.mjs';

function message(msgType, content, extra = {}) {
  return {
    msg_type: msgType,
    body: { content: typeof content === 'string' ? content : JSON.stringify(content) },
    ...extra,
  };
}

test('renders a text message as its own text', () => {
  const rendered = renderMessage(message('text', { text: '  你好，世界  ' }));
  assert.deepEqual(rendered, { text: '你好，世界', kind: 'text' });
});

test('never leaks the raw JSON envelope into a text message', () => {
  const rendered = renderMessage(message('text', { text: 'hi' }));
  assert.ok(!rendered.text.includes('{'));
  assert.ok(!rendered.text.includes('body'));
});

test('renders a post by flattening its element tree', () => {
  const rendered = renderMessage(message('post', {
    title: '周报',
    content: [[
      { tag: 'text', text: '完成 ' },
      { tag: 'a', text: '文档', href: 'https://example.com/a' },
      { tag: 'at', user_id: 'ou_x', user_name: '张三' },
      { tag: 'img' },
    ]],
  }));
  assert.equal(rendered.kind, 'post');
  assert.ok(rendered.text.includes('周报'));
  assert.ok(rendered.text.includes('完成 文档 (https://example.com/a)'));
  assert.ok(rendered.text.includes('@张三'));
  assert.ok(rendered.text.includes('[图片]'));
});

test('a post with code blocks keeps the code readable', () => {
  const rendered = renderMessage(message('post', {
    content: [[{ tag: 'code_block', text: 'const a = 1;' }]],
  }));
  assert.ok(rendered.text.includes('const a = 1;'));
});

test('an interactive card yields its title and summary, not its DSL', () => {
  const rendered = renderMessage(message('interactive', {
    header: { title: { content: '构建完成' } },
    summary: { content: '全部 12 项通过' },
    elements: [{ tag: 'button', text: '查看' }],
  }));
  assert.equal(rendered.text, '构建完成\n全部 12 项通过');
  assert.ok(!rendered.text.includes('elements'));
});

test('a card with no readable text degrades to a label', () => {
  assert.equal(renderMessage(message('interactive', {})).text, '[卡片消息]');
});

test('non-text message types become type labels', () => {
  assert.equal(renderMessage(message('image', { image_key: 'k' })).text, '[图片]');
  assert.equal(renderMessage(message('file', { file_key: 'k' })).text, '[文件]');
  assert.equal(renderMessage(message('audio', {})).text, '[语音]');
  assert.equal(renderMessage(message('media', {})).text, '[视频]');
});

test('an unknown message type is still described in words', () => {
  const rendered = renderMessage(message('mystery_type', {}));
  assert.equal(rendered.text, '[mystery_type消息]');
  assert.ok(!rendered.text.includes('{'));
});

test('an empty text message is skipped rather than delivered blank', () => {
  assert.equal(renderMessage(message('text', { text: '   ' })), null);
  assert.equal(renderMessage(message('text', {})), null);
});

test('system messages are skipped', () => {
  assert.equal(renderMessage(message('system', {})), null);
});

test('malformed content JSON does not throw', () => {
  const rendered = renderMessage({ msg_type: 'text', body: { content: 'not json' } });
  assert.equal(rendered, null);
});

test('share and location messages read naturally', () => {
  assert.equal(renderMessage(message('share_chat', { chat_name: '研发群' })).text, '[分享群名片] 研发群');
  assert.equal(renderMessage(message('share_user', { user_name: '李四' })).text, '[分享个人名片] 李四');
  assert.equal(renderMessage(message('location', { name: '总部大厦' })).text, '[位置] 总部大厦');
});

test('detects application senders by both spellings', () => {
  assert.equal(isAppSender({ sender: { sender_type: 'app' } }), true);
  assert.equal(isAppSender({ sender: { sender_type: 'bot' } }), true);
  assert.equal(isAppSender({ sender: { sender_type: 'user' } }), false);
});

test('sender label prefers the name and falls back to the id', () => {
  assert.equal(senderLabel({ sender: { name: '智能纪要助手' } }), '智能纪要助手');
  assert.equal(senderLabel({ sender: { id: 'ou_x' } }), 'ou_x');
  assert.equal(senderLabel({ sender: { sender_id: { open_id: 'ou_y' } } }), 'ou_y');
  assert.equal(senderLabel({}), '未知发送者');
});

test('composePrompt puts the instruction before the message', () => {
  assert.equal(composePrompt('归档', '正文'), '归档\n\n正文');
  assert.equal(composePrompt('', '正文'), '正文');
  assert.equal(composePrompt('归档', ''), '归档');
});
