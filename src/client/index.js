/**
 * Browser half of dsh-lark-session-monitor-plugin.
 *
 * Registers one page in the Plugins settings section. All data arrives over
 * the plugin's own RPC endpoint; this half holds no durable state beyond the
 * form and the last snapshot it loaded.
 *
 * @module dsh-lark-session-monitor-plugin/client
 */

import * as React from 'react';

import { callSettingsRpc } from '../rpc-client.mjs';
import { mergeChats, mergeSettings, mergeTargets } from './snapshot.mjs';

export const name = 'dsh-lark-session-monitor-plugin';

/** Services the page reads. `connection` carries the RPC. */
export const inject = ['slots', 'connection'];

const h = React.createElement;

/** Endpoint methods, mirrored from the Host handler. */
const EP = Object.freeze({
  get: 'settings.get',
  save: 'settings.save',
  authBegin: 'auth.begin',
  authComplete: 'auth.complete',
  authSignOut: 'auth.signOut',
  chatList: 'chat.list',
  chatSenders: 'chat.senders',
  monitorSave: 'monitor.save',
  monitorDelete: 'monitor.delete',
  monitorReset: 'monitor.reset',
  monitorPollNow: 'monitor.pollNow',
  targetList: 'target.list',
});

/** Unwrap the Connection RPC envelope, turning a failure into a throw. */
function unwrap(result, method) {
  const value = result?.result ?? result;
  if (value && typeof value === 'object' && value.ok === false) {
    const error = new Error(value.error?.message ?? `${method} 调用失败`);
    error.code = value.error?.code;
    throw error;
  }
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value;
}

function installStyles() {
  const id = 'dsh-lark-session-monitor-plugin-styles';
  if (document.getElementById(id)) return () => {};
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
.lsm-root { display: flex; flex-direction: column; gap: 20px; padding: 4px 2px 32px; }
.lsm-section { display: flex; flex-direction: column; gap: 12px; }
.lsm-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.lsm-title { font-size: 13px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-primary); }
.lsm-hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.lsm-card {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px; background: var(--dsw-alias-bg-layer-1);
}
/* Fields and their committing button on one line.
   Two rules keep the button from dropping to a second line. The fields use a
   zero flex-basis, because a positive basis makes their combined width exceed
   a narrow settings panel and the row wraps; and the row does not wrap at all,
   so the credential fields shrink instead of pushing the button down. */
.lsm-fieldrow { display: flex; align-items: flex-end; gap: 10px; flex-wrap: nowrap; }
.lsm-fieldrow > .lsm-field { flex: 1 1 0; min-width: 0; }
/* The numeric field is sized to its own label and does not grow: the width it
   does not take is what the credentials get instead. */
.lsm-fieldrow > .lsm-field-narrow { flex: 0 0 auto; width: 92px; }
.lsm-fieldrow > .lsm-field-narrow .lsm-label { white-space: nowrap; }
/* The action cell keeps its own width so it never stretches like a field. */
.lsm-fieldrow > .lsm-field:last-child { flex: 0 0 auto; }
/* Pushes its content to the far end of a row. */
.lsm-spacer { flex: 1 1 auto; }
.lsm-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lsm-grid { display: grid; gap: 10px 14px; }
.lsm-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.lsm-label { font-size: 11px; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); }
.lsm-input, .lsm-select, .lsm-textarea {
  width: 100%; box-sizing: border-box; padding: 7px 9px; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2);
}
.lsm-input::placeholder, .lsm-textarea::placeholder { color: var(--dsw-alias-label-secondary); opacity: .7; }
.lsm-textarea { min-height: 78px; resize: vertical; line-height: 1.5; }
.lsm-input:focus, .lsm-select:focus, .lsm-textarea:focus {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px;
}
.lsm-btn {
  font: inherit; font-size: 12px; padding: 6px 13px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-primary);
}
/* Explicit hover per variant. A generic .lsm-btn:hover rule outranks the
   single-class variant selectors, so it would repaint the primary button's
   background while leaving its white text — invisible in light mode. */
.lsm-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.lsm-btn:disabled { opacity: .5; cursor: default; }
.lsm-btn-primary {
  border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff;
}
.lsm-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); opacity: .88; }
.lsm-btn-danger { color: var(--dsw-alias-state-error-primary); }
.lsm-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.lsm-monitor {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.lsm-monitor-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.lsm-monitor-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.lsm-meta {
  font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap;
  color: var(--dsw-alias-label-secondary);
}
.lsm-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  color: var(--dsw-alias-label-primary);
}
.lsm-badge {
  font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid currentColor;
}
.lsm-badge-ok { color: var(--dsw-alias-state-success-primary); }
.lsm-badge-off { color: var(--dsw-alias-label-secondary); }
.lsm-badge-err { color: var(--dsw-alias-state-error-primary); }
.lsm-notice {
  font-size: 12px; line-height: 1.6; padding: 9px 11px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
}
.lsm-notice-err { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.lsm-notice-ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.lsm-url {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  word-break: break-all; color: var(--dsw-alias-label-primary);
}
.lsm-empty { font-size: 12.5px; padding: 18px 4px; text-align: center; color: var(--dsw-alias-label-secondary); }
.lsm-inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.lsm-inline-box {
  align-items: flex-start; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
}
.lsm-inline-box input[type="checkbox"] { margin-top: 2px; flex: none; }
/* Searchable single-select: the input is the control, the list hangs below it. */
.lsm-combo { position: relative; }
.lsm-combo-list {
  position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; right: 0;
  max-height: 240px; overflow-y: auto; padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-overlay); box-shadow: 0 8px 24px rgba(0,0,0,.18);
}
.lsm-combo-item {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
}
.lsm-combo-item:hover { background: var(--dsw-alias-bg-layer-2); }
.lsm-combo-item-on { background: var(--dsw-alias-bg-layer-2); font-weight: 600; }
.lsm-combo-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lsm-combo-hint {
  flex: none; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-secondary);
}
.lsm-combo-empty {
  padding: 8px; font-size: 11.5px; text-align: center;
  color: var(--dsw-alias-label-secondary);
}
/* Multi-select for source filtering: the candidates are a bounded sample of
   the conversation's recent speakers, so a scrollable column stays short. */
.lsm-sender-list {
  display: flex; flex-direction: column; gap: 4px;
  max-height: 168px; overflow-y: auto;
  padding: 6px 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
}
`;
  document.head.appendChild(style);
  return () => { style.remove(); };
}

/** One field row. */
/** One field row. `title` becomes the native hover tooltip on the label. */
function Field({ label, children, className, title }) {
  return h('label', {
    className: className ? `lsm-field ${className}` : 'lsm-field',
  }, h('span', { className: 'lsm-label', title: title || undefined }, label), children);
}

/** How many matches to render before truncating the dropdown. */
const SEARCH_SELECT_LIMIT = 60;

/**
 * A single-select whose list is filtered by typing.
 *
 * A plain `<select>` is unusable here: a Feishu account can hold hundreds of
 * conversations, and scrolling that list to find one is the whole problem this
 * replaces. The input carries the query while open and the chosen label while
 * closed, so the control still reads as a selected value.
 *
 * Options are `{ value, label, hint }`; `hint` renders dimmed on the right.
 */
function SearchSelect({ options, value, onChange, placeholder, emptyText }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const selected = options.find((option) => option.value === value);
  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => (
      option.label.toLowerCase().includes(needle)
      || option.value.toLowerCase().includes(needle)
    ));
  }, [options, query]);

  const shown = matches.slice(0, SEARCH_SELECT_LIMIT);
  const hidden = matches.length - shown.length;

  // Selecting must beat the blur that the click causes, or the list closes
  // before the click lands; `onMouseDown` runs first and the handler is kept.
  const choose = (option) => {
    onChange(option);
    setOpen(false);
    setQuery('');
  };

  return h('div', { className: 'lsm-combo' },
    h('input', {
      className: 'lsm-input',
      value: open ? query : (selected?.label ?? ''),
      placeholder: placeholder ?? '输入以筛选…',
      role: 'combobox',
      'aria-expanded': open,
      onFocus: () => { setOpen(true); setQuery(''); },
      onBlur: () => { setOpen(false); setQuery(''); },
      onChange: (e) => { setQuery(e.target.value); setOpen(true); },
      onKeyDown: (e) => {
        if (e.key === 'Escape') { setOpen(false); setQuery(''); e.currentTarget.blur(); }
        if (e.key === 'Enter' && shown.length === 1) { e.preventDefault(); choose(shown[0]); }
      },
    }),
    open
      ? h('div', { className: 'lsm-combo-list', role: 'listbox' },
          shown.length === 0
            ? h('div', { className: 'lsm-combo-empty' }, emptyText ?? '无匹配项')
            : shown.map((option) => h('div', {
                key: option.value,
                role: 'option',
                'aria-selected': option.value === value,
                className: option.value === value ? 'lsm-combo-item lsm-combo-item-on' : 'lsm-combo-item',
                onMouseDown: (e) => { e.preventDefault(); choose(option); },
              },
              h('span', { className: 'lsm-combo-label' }, option.label),
              option.hint ? h('span', { className: 'lsm-combo-hint' }, option.hint) : null)),
          hidden > 0
            ? h('div', { className: 'lsm-combo-empty' }, `另有 ${hidden} 项，继续输入以缩小范围`)
            : null)
      : null);
}

function Badge({ tone, children }) {
  const cls = tone === 'ok' ? 'lsm-badge lsm-badge-ok'
    : tone === 'err' ? 'lsm-badge lsm-badge-err' : 'lsm-badge lsm-badge-off';
  return h('span', { className: cls }, children);
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const date = new Date(ms);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

const EMPTY_DRAFT = Object.freeze({
  monitorId: '',
  name: '',
  chatId: '',
  chatName: '',
  prompt: '',
  workspace: '',
  sessionId: '',
  sessionTitle: '',
  autoCreateAndPin: false,
  skipOwnMessages: false,
  onlySenderIds: [],
  alsoBotMention: false,
  enabled: true,
});

/** The monitor editor form. */
function MonitorEditor({ draft, setDraft, chats, targets, senders, onSave, onCancel, busy, error }) {
  const update = (patch) => setDraft({ ...draft, ...patch });
  const [chatKind, setChatKind] = React.useState('all');
  const workspaceSessions = targets.find((w) => w.path === draft.workspace)?.sessions ?? [];
  // A p2p chat is named after its counterpart, so a bot's display name is
  // right there — covering third-party bots the app identity cannot reach.
  const chat = chats.find((c) => c.chatId === draft.chatId);
  const chatIsP2P = chat?.chatType === 'p2p';

  const visibleChats = React.useMemo(() => {
    if (chatKind === 'all') return chats;
    return chats.filter((chat) => (chat.chatType === 'p2p' ? 'p2p' : 'group') === chatKind);
  }, [chats, chatKind]);

  const chatOptions = React.useMemo(() => visibleChats.map((chat) => ({
    value: chat.chatId,
    label: chat.name || chat.chatId,
    // The id is the only unambiguous identifier when two chats share a name.
    hint: chat.chatType === 'p2p' ? '私聊' : '群',
  })), [visibleChats]);

  return h('div', { className: 'lsm-card' },
    h('div', { className: 'lsm-title' }, draft.monitorId ? '编辑监听' : '新建监听'),
    h('div', { className: 'lsm-grid' },
      h(Field, { label: '名称（可选）' },
        h('input', {
          className: 'lsm-input', value: draft.name,
          placeholder: '例如：纪要归档',
          onChange: (e) => update({ name: e.target.value }),
        })),
      h(Field, { label: '会话类型' },
        h('select', {
          className: 'lsm-select', value: chatKind,
          onChange: (e) => setChatKind(e.target.value),
        },
        h('option', { value: 'all' }, '全部'),
        h('option', { value: 'p2p' }, '私聊'),
        h('option', { value: 'group' }, '群'))),
      h(Field, { label: `监听会话（${visibleChats.length} 个，可输入筛选）` },
        h(SearchSelect, {
          options: chatOptions,
          value: draft.chatId,
          placeholder: '输入名称或 chat_id 以筛选…',
          emptyText: chatKind === 'p2p' ? '没有匹配的私聊' : '没有匹配的会话',
          onChange: (option) => update({ chatId: option.value, chatName: option.label }),
        })),
    ),
    h(Field, { label: 'Prompt（新消息将追加在此提示词之后）' },
      h('textarea', {
        className: 'lsm-textarea', value: draft.prompt,
        placeholder: '例如：请阅读这条消息并按模板归档。',
        onChange: (e) => update({ prompt: e.target.value }),
      })),
    h('div', { className: 'lsm-grid' },
      h(Field, { label: `目标工作区（${targets.length} 个）` },
        h(SearchSelect, {
          options: targets.map((w) => ({
            value: w.path,
            label: w.path,
            hint: `${w.sessions.length} 个会话`,
          })),
          value: draft.workspace,
          placeholder: '输入路径以筛选…',
          emptyText: '没有匹配的工作区',
          onChange: (option) => update({ workspace: option.value, sessionId: '' }),
        })),
      h(Field, { label: '目标会话（留空 = 自动创建）' },
        h(SearchSelect, {
          options: workspaceSessions.map((s) => ({
            value: s.sessionId,
            // Fall back to the id rather than a placeholder: a session with no
            // title event is common, and its id is what identifies it.
            label: s.title || s.sessionId,
            hint: s.title ? s.sessionId.slice(0, 12) : '',
            // Carried separately so the saved record keeps the real title:
            // `label` may be the id fallback, which must not be stored as one.
            title: s.title ?? '',
          })),
          value: draft.sessionId,
          placeholder: draft.workspace
            ? '留空则自动创建；或输入标题/sessionId 筛选'
            : '请先选择工作区',
          emptyText: '该工作区下无匹配会话',
          // The title is saved with the id so the monitor card can name its
          // target without re-reading every session on each render.
          onChange: (option) => update({
            sessionId: option.value,
            sessionTitle: option.title ?? '',
          }),
        })),
    ),
    // Source filtering: an empty sender list and an unchecked mention box
    // mean "every message", which is also the default for saved monitors.
    // Rendered as a plain div, not a Field: a Field is one <label>, and a
    // label may only control one form element — wrapping the checkbox list
    // in it would make clicking any name toggle the first checkbox.
    h('div', { className: 'lsm-field' },
      h('span', { className: 'lsm-label' }, '消息来源：仅接收指定发送者（留空 = 所有发送者）'),
      !draft.chatId
        ? h('span', { className: 'lsm-hint' }, '请先选择要监听的会话')
        : h('div', { className: 'lsm-sender-list' },
            senders.length === 0
              ? h('span', { className: 'lsm-hint' },
                  '正在读取发送者…（候选来自该会话最近 7 天的消息，未发言的成员不会出现在列表中）')
              : senders.map((sender) => h('label', { key: sender.id, className: 'lsm-inline' },
                  h('input', {
                    type: 'checkbox',
                    checked: (draft.onlySenderIds ?? []).includes(sender.id),
                    onChange: (e) => update({
                      onlySenderIds: e.target.checked
                        ? [...(draft.onlySenderIds ?? []), sender.id]
                        : (draft.onlySenderIds ?? []).filter((id) => id !== sender.id),
                    }),
                  }),
                  h('span', { className: 'lsm-hint' },
                    `${sender.type === 'bot' && chatIsP2P && chat?.name ? chat.name : (sender.name || sender.id)}（${sender.type === 'bot' ? '机器人' : '用户'}）`))))),
    h('label', { className: 'lsm-inline' },
      h('input', {
        type: 'checkbox', checked: draft.alsoBotMention === true,
        onChange: (e) => update({ alsoBotMention: e.target.checked }),
      }),
      h('span', { className: 'lsm-hint' },
        '也接收 @机器人 的消息（@本应用机器人的消息不受发送者名单限制；名单留空时即只收 @机器人 的消息）')),
    // Only meaningful while no session is chosen: it decides whether the
    // auto-created session is reused or a fresh one is made per message.
    draft.sessionId
      ? null
      : h('label', { className: 'lsm-inline lsm-inline-box' },
          h('input', {
            type: 'checkbox',
            checked: draft.autoCreateAndPin === true,
            onChange: (e) => update({ autoCreateAndPin: e.target.checked }),
          }),
          h('span', { className: 'lsm-hint' },
            '自动创建并固定绑定（勾选：首次自动创建后固定使用该会话；不勾选：每条消息都新建一个会话）')),
    h('label', { className: 'lsm-inline' },
      h('input', {
        type: 'checkbox', checked: draft.skipOwnMessages === true,
        onChange: (e) => update({ skipOwnMessages: e.target.checked }),
      }),
      h('span', { className: 'lsm-hint' }, '过滤自己发送的消息（不投递你本人发送的消息）')),
    h('label', { className: 'lsm-inline' },
      h('input', {
        type: 'checkbox', checked: draft.enabled,
        onChange: (e) => update({ enabled: e.target.checked }),
      }),
      h('span', { className: 'lsm-hint' }, '启用该监听')),
    error ? h('div', { className: 'lsm-notice lsm-notice-err' }, error) : null,
    h('div', { className: 'lsm-row' },
      h('button', { className: 'lsm-btn lsm-btn-primary', disabled: busy, onClick: onSave },
        busy ? '保存中…' : '保存'),
      h('button', { className: 'lsm-btn', disabled: busy, onClick: onCancel }, '取消')),
  );
}

/** The authorization card. */
function AuthCard({ settings, authorization, onBegin, onComplete, onSignOut, busy, error, attempt }) {
  if (!settings.app.appId || !settings.app.hasSecret) {
    return h('div', { className: 'lsm-notice' },
      '请先在上方填写并保存 App ID 与 App Secret，然后回到这里完成授权。');
  }
  if (attempt) {
    return h('div', { className: 'lsm-card' },
      h('div', { className: 'lsm-title' }, '等待授权'),
      h('div', { className: 'lsm-hint' }, '请在浏览器中打开下面的链接并确认授权，然后点击「我已完成授权」。'),
      h('div', { className: 'lsm-url' }, attempt.verificationUrlComplete || attempt.verificationUrl),
      h('div', { className: 'lsm-row' },
        h('button', { className: 'lsm-btn', onClick: () => window.open(attempt.verificationUrlComplete || attempt.verificationUrl, '_blank', 'noopener') }, '打开授权页'),
        h('button', { className: 'lsm-btn lsm-btn-primary', disabled: busy, onClick: () => onComplete(attempt.deviceCode) },
          busy ? '检查中…' : '我已完成授权'),
        h('button', { className: 'lsm-btn', disabled: busy, onClick: onSignOut }, '取消')),
      error ? h('div', { className: 'lsm-notice lsm-notice-err' }, error) : null,
    );
  }
  if (!authorization.authorized) {
    return h('div', { className: 'lsm-card' },
      h('div', { className: 'lsm-title' }, '未授权'),
      h('div', { className: 'lsm-hint' },
        '本插件以你本人的身份读取会话，因此需要你授权一次。授权后 token 保存在 DSH 凭据服务中并自动刷新。'),
      error ? h('div', { className: 'lsm-notice lsm-notice-err' }, error) : null,
      h('button', { className: 'lsm-btn lsm-btn-primary', disabled: busy, onClick: onBegin },
        busy ? '发起中…' : '开始授权'),
    );
  }
  // The sign-out action rides the status line, pushed to the far end, so it
  // reads as an action on the state shown beside it rather than its own row.
  return h('div', { className: 'lsm-card' },
    h('div', { className: 'lsm-row' },
      h('div', { className: 'lsm-title' }, '已授权'),
      h(Badge, { tone: 'ok' }, 'user token 有效'),
      h('div', { className: 'lsm-meta' },
        h('span', null, `到期时间：${formatTime(authorization.expiresAt)}`),
        authorization.needsRefresh ? h('span', null, '（将在下次调用前自动刷新）') : null),
      h('div', { className: 'lsm-spacer' }),
      h('button', {
        className: 'lsm-btn lsm-btn-danger', disabled: busy, onClick: onSignOut,
      }, '退出授权')),
    error ? h('div', { className: 'lsm-notice lsm-notice-err' }, error) : null,
  );
}

/** The settings page. */
export function LarkMonitorPage({ rpcCall }) {
  const [snapshot, setSnapshot] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [appForm, setAppForm] = React.useState({ appId: '', appSecret: '', domain: 'feishu', pollIntervalMs: 30000 });
  const [attempt, setAttempt] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [editorError, setEditorError] = React.useState('');

  const invoke = React.useCallback(async (method, payload = {}) => {
    const value = unwrap(await rpcCall(method, payload), method);
    return value;
  }, [rpcCall]);

  const load = React.useCallback(async (forceChats = false) => {
    try {
      const data = await invoke(EP.get);
      // Merge rather than replace: `loadTargets` runs concurrently and puts
      // `targets` on the same snapshot. A whole-object set here would drop
      // them whenever the workspace call won the race — which is exactly the
      // "0 workspaces" the picker showed.
      setSnapshot((prev) => mergeSettings(prev, data));
      setAppForm((prev) => ({
        appId: data.settings.app.appId || prev.appId,
        // Keep whatever the user typed. Clearing it here would both wipe the
        // dots they just typed and — because an empty secret means "clear the
        // stored one" on save — silently delete the credential on the next
        // unrelated save.
        appSecret: prev.appSecret,
        domain: data.settings.app.domain || 'feishu',
        pollIntervalMs: data.settings.pollIntervalMs || 30000,
      }));
      if (data.authorization.authorized) {
        const list = await invoke(EP.chatList, { force: forceChats });
        setSnapshot((prev) => mergeChats(prev, list.chats));
      }
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [invoke]);

  const loadTargets = React.useCallback(async () => {
    try {
      const targets = await invoke(EP.targetList);
      // Tolerate arriving before `settings.get`: keeping the value beat in a
      // pending slot would let the first paint miss it forever, because the
      // effect only runs once.
      setSnapshot((prev) => mergeTargets(prev, targets.workspaces));
    } catch (err) {
      setError(`加载工作区失败：${err.message}`);
    }
  }, [invoke]);

  /**
   * Sender candidates for the source picker, observed in the drafted chat.
   *
   * Loaded only while the editor is open on a chosen chat: the read is a
   * bounded sample of recent messages, not a membership list, and a stale
   * one would mislead. Failure reads as "no candidates" — the empty hint
   * already says where candidates come from.
   */
  const [senders, setSenders] = React.useState([]);
  React.useEffect(() => {
    const chatId = draft?.chatId;
    if (!chatId) { setSenders([]); return undefined; }
    let cancelled = false;
    setSenders([]);
    invoke(EP.chatSenders, { chatId })
      .then((data) => { if (!cancelled) setSenders(data.senders ?? []); })
      .catch(() => { if (!cancelled) setSenders([]); });
    return () => { cancelled = true; };
  }, [draft?.chatId, invoke]);

  /**
   * Titles for the sessions the monitors point at.
   *
   * A monitor saved before the title was captured alongside the id holds an
   * empty `sessionTitle`, and would otherwise render a bare session id. This
   * resolves the name from the same inventory the picker uses, without
   * mutating the stored record.
   */
  const sessionTitles = React.useMemo(() => {
    const byId = new Map();
    for (const workspace of snapshot?.targets ?? []) {
      for (const session of workspace.sessions ?? []) {
        if (session.sessionId && session.title) byId.set(session.sessionId, session.title);
      }
    }
    return byId;
  }, [snapshot?.targets]);

  // Workspaces are fetched independently of settings, so the picker still
  // populates when the plugin is not yet authorized.
  React.useEffect(() => { void loadTargets(); }, [loadTargets]);
  React.useEffect(() => { void load(); }, [load]);

  const run = async (action, okMessage) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await action();
      if (okMessage) setNotice(okMessage);
      return value;
    } catch (err) {
      setError(err.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) {
    return h('div', { className: 'lsm-root' },
      error ? h('div', { className: 'lsm-notice lsm-notice-err' }, error) : h('div', { className: 'lsm-empty' }, '加载中…'));
  }

  const chats = snapshot.chats ?? [];
  const targets = snapshot.targets ?? [];
  const statuses = new Map((snapshot.runtime ?? []).map((s) => [s.monitorId, s]));

  return h('div', { className: 'lsm-root' },
    // ---- app credentials ----
    h('section', { className: 'lsm-section' },
      h('div', { className: 'lsm-card' },
        // One row: the three credential fields and the button that commits
        // them. Flex (not the grid) because the button is not a field and must
        // not stretch to a field's height.
        h('div', { className: 'lsm-fieldrow' },
          h(Field, { label: 'App ID' },
            h('input', {
              className: 'lsm-input', value: appForm.appId, placeholder: 'cli_xxx',
              onChange: (e) => setAppForm({ ...appForm, appId: e.target.value }),
            })),
          h(Field, { label: 'App Secret' },
            h('input', {
              className: 'lsm-input', type: 'password', value: appForm.appSecret,
              placeholder: snapshot.settings.app.hasSecret ? '已保存（留空则不修改）' : '填写 App Secret',
              onChange: (e) => setAppForm({ ...appForm, appSecret: e.target.value }),
            })),
          h(Field, {
            label: '轮询间隔（秒）',
            className: 'lsm-field-narrow',
            title: '最小 2 秒',
          },
            h('input', {
              // Stored as milliseconds; shown as seconds because that is the
              // unit a person reasons about here.
              className: 'lsm-input', type: 'number', min: 2, step: 1,
              title: '最小 2 秒',
              value: Math.round(appForm.pollIntervalMs / 1000),
              onChange: (e) => setAppForm({
                ...appForm,
                pollIntervalMs: Math.max(2, Number(e.target.value) || 2) * 1000,
              }),
            })),
          h(Field, { label: '\u00a0' },
            h('button', {
              className: 'lsm-btn lsm-btn-primary', disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.save, { ...appForm });
                await load(true);
              }, '已保存。'),
            }, '保存')),
        ),
      ),
    ),

    // ---- authorization ----
    h('section', { className: 'lsm-section' },
      h('div', { className: 'lsm-title' }, '用户授权'),
      h(AuthCard, {
        settings: snapshot.settings,
        authorization: snapshot.authorization,
        attempt,
        busy,
        error,
        onBegin: () => run(async () => {
          const value = await invoke(EP.authBegin);
          setAttempt(value);
        }),
        onComplete: (deviceCode) => run(async () => {
          const outcome = await invoke(EP.authComplete, { deviceCode });
          if (outcome.status === 'authorized') {
            setAttempt(null);
            await load(true);
          } else if (outcome.status === 'slow-down') {
            setError('飞书要求降低轮询频率，请稍等几秒再试。');
          } else {
            setError('尚未检测到授权，请确认已在飞书页面完成授权。');
          }
        }),
        onSignOut: () => run(async () => {
          await invoke(EP.authSignOut);
          setAttempt(null);
          await load();
        }, '已退出授权。'),
      }),
    ),

    // ---- monitors ----
    h('section', { className: 'lsm-section' },
      h('div', { className: 'lsm-section-head' },
        h('div', { className: 'lsm-title' }, `监听列表（${snapshot.settings.monitors.length}）`),
        h('button', {
          className: 'lsm-btn lsm-btn-primary', disabled: busy,
          onClick: () => { setEditorError(''); setDraft({ ...EMPTY_DRAFT }); },
        }, '新建监听')),
      h('div', { className: 'lsm-hint' },
        '每 30 秒轮询一次被监听会话；新消息以「Prompt + 消息文本」投递到目标会话。图片、文件等非文本消息以类型标签投递。'),

      draft ? h(MonitorEditor, {
        draft, setDraft, chats, targets, senders, busy, error: editorError,
        onCancel: () => setDraft(null),
        onSave: () => run(async () => {
          setEditorError('');
          if (!draft.chatId) { setEditorError('请选择要监听的会话。'); return; }
          if (!draft.prompt.trim()) { setEditorError('Prompt 为必填项。'); return; }
          try {
            await invoke(EP.monitorSave, { ...draft, enabled: draft.enabled });
            setDraft(null);
            setNotice('监听已保存。');
            await load();
          } catch (err) {
            setEditorError(err.message);
          }
        }, ''),
      }) : null,

      snapshot.settings.monitors.length === 0 && !draft
        ? h('div', { className: 'lsm-empty' }, '尚未配置监听。点击「新建监听」选择要监听的会话。')
        : null,
      // Editing the only monitor hides its card, which would otherwise leave
      // this area blank and read as "the monitor disappeared".
      draft && draft.monitorId && snapshot.settings.monitors.length === 1
        ? h('div', { className: 'lsm-hint' }, '该监听正在上方编辑。')
        : null,

      snapshot.settings.monitors.map((monitor) => {
        // The card being edited is replaced by the editor above it: showing
        // both puts two copies of the same fields on screen, and the stale one
        // still carries the pre-edit values.
        if (draft && draft.monitorId === monitor.monitorId) return null;
        const status = statuses.get(monitor.monitorId) ?? {};
        return h('div', { key: monitor.monitorId, className: 'lsm-monitor' },
          h('div', { className: 'lsm-monitor-head' },
            h('div', { className: 'lsm-monitor-name' }, monitor.name || monitor.chatName || monitor.chatId),
            h('div', { className: 'lsm-inline' },
              monitor.enabled ? h(Badge, { tone: 'ok' }, '启用') : h(Badge, { tone: 'off' }, '停用'),
              status.lastError ? h(Badge, { tone: 'err' }, '异常') : null)),
          h('div', { className: 'lsm-meta' },
            h('span', null, `会话：${monitor.chatName || monitor.chatId}`),
            h('span', { className: 'lsm-code' },
              monitor.sessionId
                // Name the target when it has a title, and keep the id as the
                // tooltip: the id is the unambiguous handle, the title is what
                // a person recognizes. The lookup covers a monitor saved
                // before the title was captured with the id.
                ? h('span', { title: monitor.sessionId },
                    `目标：${monitor.sessionTitle || sessionTitles.get(monitor.sessionId) || monitor.sessionId}`)
                : (monitor.autoCreateAndPin ? '目标：自动创建并固定绑定（尚未创建）' : '目标：每条消息新建')),
            monitor.skipOwnMessages ? h('span', null, '过滤自己消息') : null,
            monitor.alsoBotMention || (monitor.onlySenderIds?.length ?? 0) > 0
              ? h('span', null, [
                  (monitor.onlySenderIds?.length ?? 0) > 0
                    ? `指定发送者×${monitor.onlySenderIds.length}` : '',
                  monitor.alsoBotMention ? '@机器人' : '',
                ].filter(Boolean).map((part, index) => (index === 0 ? `来源：${part}` : ` 或 ${part}`)).join(''))
              : null,
            h('span', null, `已投递 ${status.delivered ?? 0} 条`),
            h('span', null, `最后轮询：${formatTime(status.lastPollAt)}`)),
          h('div', { className: 'lsm-meta' },
            h('span', null, `Prompt：${monitor.prompt.slice(0, 60)}${monitor.prompt.length > 60 ? '…' : ''}`)),
          status.lastError ? h('div', { className: 'lsm-notice lsm-notice-err' }, status.lastError) : null,
          h('div', { className: 'lsm-row' },
            h('button', {
              className: 'lsm-btn', disabled: busy,
              onClick: () => { setEditorError(''); setDraft({ ...EMPTY_DRAFT, ...monitor }); },
            }, '编辑'),
            h('button', {
              className: 'lsm-btn', disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.monitorSave, { monitorId: monitor.monitorId, enabled: !monitor.enabled });
                await load();
              }),
            }, monitor.enabled ? '停用' : '启用'),
            h('button', {
              className: 'lsm-btn', disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.monitorPollNow, { monitorId: monitor.monitorId });
                await load();
              }, '已触发一次轮询。'),
            }, '立即轮询'),
            h('button', {
              className: 'lsm-btn', disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.monitorReset, { monitorId: monitor.monitorId });
                await load();
              }, '已重置游标，将重新读取最近 10 分钟的消息。'),
            }, '重置游标'),
            h('button', {
              className: 'lsm-btn lsm-btn-danger', disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.monitorDelete, { monitorId: monitor.monitorId });
                await load();
              }, '监听已删除。'),
            }, '删除')),
        );
      }),
    ),

    notice ? h('div', { className: 'lsm-notice lsm-notice-ok' }, notice) : null,
    error && !snapshot ? null : (error ? h('div', { className: 'lsm-notice lsm-notice-err' }, error) : null),
  );
}

export function apply(ctx) {
  ctx.effect(() => installStyles(), 'dsh-lark-session-monitor-plugin: styles');

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'lark-session-monitor',
    order: 40,
    label: () => '飞书会话监听',
    // The page receives only a bound RPC function; it never touches the
    // connection directly, so the transport stays swappable.
    inject: () => ({
      rpcCall: (method, payload, signal) => callSettingsRpc(ctx.connection, method, payload, signal),
    }),
  }, LarkMonitorPage));
}

export { EP as ENDPOINTS, unwrap };
