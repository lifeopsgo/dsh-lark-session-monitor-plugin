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

/**
 * Inline `lark_md` markers become plain annotations.
 *
 * `<a href="u">text</a>` renders as `text (u)` — the link is delivered as
 * text, never fetched — and `<at id=..>name</at>` renders as `@name`.
 */
function inlineLarkMd(content) {
  return content
    .replace(/<a\s+href=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_m, d, s, text) => {
      const href = d ?? s ?? '';
      return href ? `${text} (${href})` : text;
    })
    .replace(/<at\s+[^>]*>([\s\S]*?)<\/at>/gi, (_m, name) => `@${name.trim() || '某人'}`);
}

/** The readable text of a card text leaf (`plain_text`, `lark_md`, `markdown`). */
function cardTextOf(node) {
  if (!isRecord(node)) return '';
  if (typeof node.content !== 'string') return '';
  const raw = node.tag === 'lark_md' || node.tag === 'md' ? inlineLarkMd(node.content) : node.content;
  return raw.trim();
}

/**
 * Flatten a card's element blocks into readable lines.
 *
 * Covers card JSON 1.0 (`elements`), the 2.0 send format (`i18n_elements`),
 * and the 2.0 builder format (`body.elements`): text blocks, fields, notes,
 * dividers, images, action buttons with their links, and column layouts.
 * Unknown block kinds fall back to harvesting their text leaves, so a card
 * DSL the renderer has never seen still yields whatever it says.
 */
function flattenCardBlocks(elements, out) {
  for (const block of Array.isArray(elements) ? elements : []) {
    if (!isRecord(block)) continue;
    if (block.tag === 'div') {
      const text = cardTextOf(block.text);
      if (text) out.push(text);
      for (const field of Array.isArray(block.fields) ? block.fields : []) {
        const fieldText = cardTextOf(isRecord(field) ? field.text : undefined);
        if (fieldText) out.push(fieldText);
      }
    } else if (block.tag === 'markdown' || block.tag === 'md') {
      const text = cardTextOf(block);
      if (text) out.push(text);
    } else if (block.tag === 'note') {
      const parts = [];
      flattenCardBlocks(block.elements, parts);
      if (parts.length) out.push(parts.join(' · '));
    } else if (block.tag === 'hr') {
      out.push('———');
    } else if (block.tag === 'img') {
      const alt = cardTextOf(block.alt);
      out.push(alt ? `[图片:${alt}]` : '[图片]');
    } else if (block.tag === 'action') {
      for (const item of Array.isArray(block.actions) ? block.actions : []) {
        if (!isRecord(item)) continue;
        const text = cardTextOf(item.text) || (typeof item.text === 'string' ? item.text : '');
        const url = typeof item.url === 'string' ? item.url : '';
        if (text && url) out.push(`${text} (${url})`);
        else if (text) out.push(text);
        else if (url) out.push(url);
      }
    } else if (block.tag === 'column_set' || block.tag === 'column') {
      const columns = Array.isArray(block.columns) ? block.columns : [];
      if (columns.length) {
        for (const column of columns) {
          if (isRecord(column)) flattenCardBlocks(column.elements, out);
        }
      } else {
        flattenCardBlocks(block.elements, out);
      }
    } else {
      // Unknown block: harvest any text leaves it nests, without leaking
      // the block's own DSL keys.
      const harvested = [];
      const walk = (value) => {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (!isRecord(value)) return;
        if (typeof value.tag === 'string' && (value.tag === 'plain_text' || value.tag === 'lark_md')) {
          const text = cardTextOf(value);
          if (text) harvested.push(text);
          return;
        }
        for (const child of Object.values(value)) walk(child);
      };
      walk(block);
      if (harvested.length) out.push(harvested.join(' · '));
    }
  }
  return out;
}

/** The element list a card body offers, by its layout variant. */
function cardElementLists(content) {
  if (Array.isArray(content?.elements)) return content.elements;
  if (isRecord(content?.i18n_elements)) {
    const locale = content.i18n_elements.zh_cn
      ?? Object.values(content.i18n_elements).find((v) => Array.isArray(v));
    if (Array.isArray(locale)) return locale;
  }
  if (isRecord(content?.body) && Array.isArray(content.body.elements)) return content.body.elements;
  return [];
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
    const title = cardTextOf(content?.header?.title) || (typeof content?.header?.title?.content === 'string'
      ? content.header.title.content.trim() : '');
    const summary = cardTextOf(content?.summary);
    const lines = flattenCardBlocks(cardElementLists(content), []);
    const text = [title, summary, ...lines].filter(Boolean).join('\n');
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

/**
 * True when the message was sent by the signed-in user themself.
 *
 * The identity and the message's sender each carry any subset of
 * open_id/union_id/user_id; matching on whichever pair both sides expose is
 * enough. Without an identity the answer is "not ours", so the filter fails
 * open — an identity outage must not silently stop delivery.
 */
export function isOwnMessage(message, identity) {
  if (!identity) return false;
  const sender = message?.sender;
  const sent = [
    sender?.id,
    sender?.sender_id?.open_id,
    sender?.sender_id?.union_id,
    sender?.sender_id?.user_id,
  ];
  const own = [identity.openId, identity.unionId, identity.userId];
  return sent.some((value) => typeof value === 'string' && value && own.includes(value));
}

/** Every id the message's sender may be known by. */
function senderIdsOf(message) {
  const sender = message?.sender;
  return [
    sender?.id,
    sender?.sender_id?.open_id,
    sender?.sender_id?.union_id,
    sender?.sender_id?.user_id,
  ].filter((value) => typeof value === 'string' && value);
}

/**
 * True when the message's sender is in the whitelist.
 *
 * An empty or absent list is "no restriction", never "deliver nothing".
 */
export function isFromSenders(message, senderIdList) {
  if (!Array.isArray(senderIdList) || senderIdList.length === 0) return true;
  const wanted = new Set(senderIdList.filter((value) => typeof value === 'string' && value));
  return senderIdsOf(message).some((id) => wanted.has(id));
}

/**
 * True when the message @-mentions the given open_id.
 *
 * Text messages carry a `mentions` array (the list reads populate it with
 * the mentioned entity's open_id); post messages embed the id in their `at`
 * nodes. Both spellings are checked.
 */
export function mentionsId(message, id) {
  if (typeof id !== 'string' || !id) return false;
  const mentions = Array.isArray(message?.mentions) ? message.mentions : [];
  for (const mention of mentions) {
    if (isRecord(mention) && mention.id === id) return true;
  }
  const content = parseContent(message?.body?.content);
  const elements = content?.content ?? content?.elements ?? (Array.isArray(content) ? content : []);
  for (const line of Array.isArray(elements) ? elements : []) {
    if (!Array.isArray(line)) continue;
    for (const node of line) {
      if (isRecord(node) && node.tag === 'at' && node.user_id === id) return true;
    }
  }
  return false;
}

/**
 * Distinct senders observed in a page of messages, for the picker.
 *
 * The id is what `sender.id` carries (a user's open_id or an app's app_id),
 * so picking a sender produces exactly the id the runtime filter matches on.
 * Names are best effort: chat reads do not always carry them.
 */
export function distinctSenders(messages) {
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const sender = isRecord(message?.sender) ? message.sender : undefined;
    const id = typeof sender?.id === 'string' && sender.id ? sender.id
      : (typeof sender?.sender_id?.open_id === 'string' ? sender.sender_id.open_id : '');
    if (!id) continue;
    const name = typeof sender?.name === 'string' ? sender.name.trim() : '';
    const type = sender?.sender_type === 'app' || sender?.sender_type === 'bot' ? 'bot' : 'user';
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { id, name, type });
    } else if (name && !existing.name) {
      existing.name = name;
    }
  }
  return [...byId.values()];
}

/**
 * Fill the configured app bot's display name into a picker list.
 *
 * Chat reads never name app senders, so the app's own bot — usually
 * exactly the bot being tested — would otherwise show as a bare `cli_…`
 * App ID. The lookup is the caller's business; this only applies it where
 * it fits, and never guesses.
 */
export function applyAppBotName(senders, appId, identity) {
  const name = typeof identity?.name === 'string' ? identity.name.trim() : '';
  if (!appId || !name) return senders;
  return senders.map((sender) => (
    sender?.id === appId && !sender.name ? { ...sender, name } : sender
  ));
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
