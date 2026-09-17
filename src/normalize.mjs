/**
 * Turn one Feishu message object into the text a monitor delivers.
 *
 * The monitor's contract with the user is "prompt + the message's own text".
 * Feishu hands back a `body.content` string that is itself JSON, shaped
 * differently per `msg_type`, so this module is the only place that knows
 * those shapes. Raw Feishu JSON must never reach the prompt: a model reading
 * `{"title":null,"elements":[...]}` learns nothing and the monitor looks
 * broken. Anything we cannot render as readable text is described in words.
 *
 * @module dsh-lark-session-monitor-plugin/normalize
 */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse Feishu's nested `body.content` JSON; returns undefined when unusable. */
function parseContent(raw) {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Concatenate the `text` leaves of a post's nested element tree. */
function flattenPostElements(elements) {
  const lines = [];
  for (const line of Array.isArray(elements) ? elements : []) {
    if (!Array.isArray(line)) continue;
    let buffer = '';
    for (const node of line) {
      if (!isRecord(node)) continue;
      if (node.tag === 'text' && typeof node.text === 'string') {
        buffer += node.text;
      } else if (node.tag === 'a' && typeof node.text === 'string') {
        const href = typeof node.href === 'string' ? node.href : '';
        buffer += href ? `${node.text} (${href})` : node.text;
      } else if (node.tag === 'at' && typeof node.user_id === 'string') {
        buffer += `@${node.user_name ?? node.user_id}`;
      } else if (node.tag === 'img') {
        buffer += '[图片]';
      } else if (node.tag === 'media') {
        buffer += '[音视频]';
      } else if (node.tag === 'emotion' && typeof node.emoji_type === 'string') {
        buffer += `[表情:${node.emoji_type}]`;
      } else if (node.tag === 'code_block' && typeof node.text === 'string') {
        buffer += `\n\`\`\`\n${node.text}\n\`\`\``;
      }
    }
    if (buffer.trim()) lines.push(buffer);
  }
  return lines.join('\n');
}

const UNRENDERABLE_LABELS = Object.freeze({
  image: '图片',
  file: '文件',
  audio: '语音',
  media: '视频',
  sticker: '表情包',
  folder: '文件夹',
});

/**
 * Render one message as plain text.
 *
 * @returns `{ text, kind }` where `kind` names what was recognized, or `null`
 *   when the message carries nothing worth delivering (for example an empty
 *   body). Callers skip `null` rather than delivering a placeholder.
 */
export function renderMessage(message) {
  const msgType = typeof message?.msg_type === 'string' ? message.msg_type : '';
  const content = parseContent(message?.body?.content);

  if (msgType === 'text') {
    const text = typeof content?.text === 'string' ? content.text.trim() : '';
    return text ? { text, kind: 'text' } : null;
  }

  if (msgType === 'post') {
    const title = typeof content?.title === 'string' ? content.title.trim() : '';
    const body = flattenPostElements(
      content?.content ?? content?.elements ?? (Array.isArray(content) ? content : []),
    ).trim();
    const text = [title, body].filter(Boolean).join('\n');
    return text ? { text, kind: 'post' } : null;
  }

  if (msgType === 'interactive') {
    // Card payloads are a rendering DSL; a readable fallback beats a JSON dump.
    const title = typeof content?.header?.title?.content === 'string'
      ? content.header.title.content.trim()
      : '';
    const summary = typeof content?.summary?.content === 'string' ? content.summary.content.trim() : '';
    const text = [title, summary].filter(Boolean).join('\n');
    return text ? { text, kind: 'interactive' }
      : { text: '[卡片消息]', kind: 'interactive' };
  }

  if (msgType === 'share_chat') {
    const name = typeof content?.chat_name === 'string' ? content.chat_name.trim() : '';
    return { text: name ? `[分享群名片] ${name}` : '[分享群名片]', kind: 'share_chat' };
  }

  if (msgType === 'share_user') {
    const name = typeof content?.user_name === 'string' ? content.user_name.trim() : '';
    return { text: name ? `[分享个人名片] ${name}` : '[分享个人名片]', kind: 'share_user' };
  }

  if (msgType === 'location') {
    const name = typeof content?.name === 'string' ? content.name.trim() : '';
    return { text: name ? `[位置] ${name}` : '[位置]', kind: 'location' };
  }

  if (msgType === 'system') {
    // System rows are membership and recall notices, not conversation.
    return null;
  }

  const label = UNRENDERABLE_LABELS[msgType];
  if (label) return { text: `[${label}]`, kind: msgType };

  return { text: `[${msgType || '未知类型'}消息]`, kind: msgType || 'unknown' };
}

/** True when the message was sent by an application or bot rather than a person. */
export function isAppSender(message) {
  const senderType = message?.sender?.sender_type;
  return senderType === 'app' || senderType === 'bot';
}

/** Display name for a message's sender, falling back to the raw id. */
export function senderLabel(message) {
  const sender = message?.sender;
  const name = typeof sender?.name === 'string' ? sender.name.trim() : '';
  if (name) return name;
  const id = sender?.id ?? sender?.sender_id?.open_id ?? '';
  return typeof id === 'string' && id ? id : '未知发送者';
}

/**
 * Compose the prompt delivered into the DSH session.
 *
 * The configured prompt comes first and the message text after it, so an
 * instruction such as "按模板归档" reads as applying to what follows.
 */
export function composePrompt(prompt, rendered) {
  const instruction = typeof prompt === 'string' ? prompt.trim() : '';
  const body = typeof rendered === 'string' ? rendered.trim() : '';
  if (!instruction) return body;
  if (!body) return instruction;
  return `${instruction}\n\n${body}`;
}
