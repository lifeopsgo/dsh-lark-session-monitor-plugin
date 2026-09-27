window.__ModuleLoader__.load({
  id: "dsh-lark-session-monitor-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  ENDPOINTS: () => EP,
  LarkMonitorPage: () => LarkMonitorPage,
  apply: () => apply,
  inject: () => inject,
  name: () => name,
  unwrap: () => unwrap
});
module.exports = __toCommonJS(index_exports);
var React = __toESM(require("react"), 1);

// src/rpc-client.mjs
var RPC_CHANNEL = "/lark-session-monitor";
function rpcEndpoint(channel) {
  if (!/^\/[A-Za-z0-9._~-]+$/.test(channel)) throw new TypeError("Invalid RPC channel");
  return `dsh-plugin${channel}`;
}
function callSettingsRpc(connection, method, payload, signal) {
  if (!connection || typeof connection.rpc?.call !== "function") {
    throw new Error("DSH Connection RPC \u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u8FDE\u63A5\u63D2\u4EF6 Host\u3002");
  }
  return connection.rpc.call("/api", rpcEndpoint(RPC_CHANNEL), { method, payload }, signal);
}

// src/client/snapshot.mjs
var EMPTY_SNAPSHOT = Object.freeze({
  settings: {
    version: 1,
    app: { appId: "", domain: "feishu", hasSecret: false },
    pollIntervalMs: 3e4,
    monitors: []
  },
  authorization: { authorized: false, scope: "", expiresAt: null, needsRefresh: false },
  runtime: [],
  chats: [],
  targets: []
});
function mergeSettings(previous, data) {
  const merged = { ...data };
  if (previous?.targets !== void 0) merged.targets = previous.targets;
  if (previous?.chats !== void 0) merged.chats = previous.chats;
  return merged;
}
function mergeTargets(previous, targets) {
  const base = previous ?? EMPTY_SNAPSHOT;
  return { ...base, targets };
}
function mergeChats(previous, chats) {
  const base = previous ?? EMPTY_SNAPSHOT;
  return { ...base, chats };
}

// src/client/index.js
var name = "dsh-lark-session-monitor-plugin";
var inject = ["slots", "connection"];
var h = React.createElement;
var EP = Object.freeze({
  get: "settings.get",
  save: "settings.save",
  authBegin: "auth.begin",
  authComplete: "auth.complete",
  authSignOut: "auth.signOut",
  chatList: "chat.list",
  chatSenders: "chat.senders",
  monitorSave: "monitor.save",
  monitorDelete: "monitor.delete",
  monitorReset: "monitor.reset",
  monitorPollNow: "monitor.pollNow",
  targetList: "target.list"
});
function unwrap(result, method) {
  const value = result?.result ?? result;
  if (value && typeof value === "object" && value.ok === false) {
    const error = new Error(value.error?.message ?? `${method} \u8C03\u7528\u5931\u8D25`);
    error.code = value.error?.code;
    throw error;
  }
  if (value && typeof value === "object" && "value" in value) return value.value;
  return value;
}
function installStyles() {
  const id = "dsh-lark-session-monitor-plugin-styles";
  if (document.getElementById(id)) return () => {
  };
  const style = document.createElement("style");
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
   background while leaving its white text \u2014 invisible in light mode. */
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
  return () => {
    style.remove();
  };
}
function Field({ label, children, className, title }) {
  return h("label", {
    className: className ? `lsm-field ${className}` : "lsm-field"
  }, h("span", { className: "lsm-label", title: title || void 0 }, label), children);
}
var SEARCH_SELECT_LIMIT = 60;
function SearchSelect({ options, value, onChange, placeholder, emptyText }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const selected = options.find((option) => option.value === value);
  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle));
  }, [options, query]);
  const shown = matches.slice(0, SEARCH_SELECT_LIMIT);
  const hidden = matches.length - shown.length;
  const choose = (option) => {
    onChange(option);
    setOpen(false);
    setQuery("");
  };
  return h(
    "div",
    { className: "lsm-combo" },
    h("input", {
      className: "lsm-input",
      value: open ? query : selected?.label ?? "",
      placeholder: placeholder ?? "\u8F93\u5165\u4EE5\u7B5B\u9009\u2026",
      role: "combobox",
      "aria-expanded": open,
      onFocus: () => {
        setOpen(true);
        setQuery("");
      },
      onBlur: () => {
        setOpen(false);
        setQuery("");
      },
      onChange: (e) => {
        setQuery(e.target.value);
        setOpen(true);
      },
      onKeyDown: (e) => {
        if (e.key === "Escape") {
          setOpen(false);
          setQuery("");
          e.currentTarget.blur();
        }
        if (e.key === "Enter" && shown.length === 1) {
          e.preventDefault();
          choose(shown[0]);
        }
      }
    }),
    open ? h(
      "div",
      { className: "lsm-combo-list", role: "listbox" },
      shown.length === 0 ? h("div", { className: "lsm-combo-empty" }, emptyText ?? "\u65E0\u5339\u914D\u9879") : shown.map((option) => h(
        "div",
        {
          key: option.value,
          role: "option",
          "aria-selected": option.value === value,
          className: option.value === value ? "lsm-combo-item lsm-combo-item-on" : "lsm-combo-item",
          onMouseDown: (e) => {
            e.preventDefault();
            choose(option);
          }
        },
        h("span", { className: "lsm-combo-label" }, option.label),
        option.hint ? h("span", { className: "lsm-combo-hint" }, option.hint) : null
      )),
      hidden > 0 ? h("div", { className: "lsm-combo-empty" }, `\u53E6\u6709 ${hidden} \u9879\uFF0C\u7EE7\u7EED\u8F93\u5165\u4EE5\u7F29\u5C0F\u8303\u56F4`) : null
    ) : null
  );
}
function Badge({ tone, children }) {
  const cls = tone === "ok" ? "lsm-badge lsm-badge-ok" : tone === "err" ? "lsm-badge lsm-badge-err" : "lsm-badge lsm-badge-off";
  return h("span", { className: cls }, children);
}
function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "\u2014";
  const date = new Date(ms);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
var EMPTY_DRAFT = Object.freeze({
  monitorId: "",
  name: "",
  chatId: "",
  chatName: "",
  prompt: "",
  workspace: "",
  sessionId: "",
  sessionTitle: "",
  autoCreateAndPin: false,
  skipOwnMessages: false,
  onlySenderIds: [],
  alsoBotMention: false,
  enabled: true
});
function MonitorEditor({ draft, setDraft, chats, targets, senders, onSave, onCancel, busy, error }) {
  const update = (patch) => setDraft({ ...draft, ...patch });
  const [chatKind, setChatKind] = React.useState("all");
  const workspaceSessions = targets.find((w) => w.path === draft.workspace)?.sessions ?? [];
  const visibleChats = React.useMemo(() => {
    if (chatKind === "all") return chats;
    return chats.filter((chat) => (chat.chatType === "p2p" ? "p2p" : "group") === chatKind);
  }, [chats, chatKind]);
  const chatOptions = React.useMemo(() => visibleChats.map((chat) => ({
    value: chat.chatId,
    label: chat.name || chat.chatId,
    // The id is the only unambiguous identifier when two chats share a name.
    hint: chat.chatType === "p2p" ? "\u79C1\u804A" : "\u7FA4"
  })), [visibleChats]);
  return h(
    "div",
    { className: "lsm-card" },
    h("div", { className: "lsm-title" }, draft.monitorId ? "\u7F16\u8F91\u76D1\u542C" : "\u65B0\u5EFA\u76D1\u542C"),
    h(
      "div",
      { className: "lsm-grid" },
      h(
        Field,
        { label: "\u540D\u79F0\uFF08\u53EF\u9009\uFF09" },
        h("input", {
          className: "lsm-input",
          value: draft.name,
          placeholder: "\u4F8B\u5982\uFF1A\u7EAA\u8981\u5F52\u6863",
          onChange: (e) => update({ name: e.target.value })
        })
      ),
      h(
        Field,
        { label: "\u4F1A\u8BDD\u7C7B\u578B" },
        h(
          "select",
          {
            className: "lsm-select",
            value: chatKind,
            onChange: (e) => setChatKind(e.target.value)
          },
          h("option", { value: "all" }, "\u5168\u90E8"),
          h("option", { value: "p2p" }, "\u79C1\u804A"),
          h("option", { value: "group" }, "\u7FA4")
        )
      ),
      h(
        Field,
        { label: `\u76D1\u542C\u4F1A\u8BDD\uFF08${visibleChats.length} \u4E2A\uFF0C\u53EF\u8F93\u5165\u7B5B\u9009\uFF09` },
        h(SearchSelect, {
          options: chatOptions,
          value: draft.chatId,
          placeholder: "\u8F93\u5165\u540D\u79F0\u6216 chat_id \u4EE5\u7B5B\u9009\u2026",
          emptyText: chatKind === "p2p" ? "\u6CA1\u6709\u5339\u914D\u7684\u79C1\u804A" : "\u6CA1\u6709\u5339\u914D\u7684\u4F1A\u8BDD",
          onChange: (option) => update({ chatId: option.value, chatName: option.label })
        })
      )
    ),
    h(
      Field,
      { label: "Prompt\uFF08\u65B0\u6D88\u606F\u5C06\u8FFD\u52A0\u5728\u6B64\u63D0\u793A\u8BCD\u4E4B\u540E\uFF09" },
      h("textarea", {
        className: "lsm-textarea",
        value: draft.prompt,
        placeholder: "\u4F8B\u5982\uFF1A\u8BF7\u9605\u8BFB\u8FD9\u6761\u6D88\u606F\u5E76\u6309\u6A21\u677F\u5F52\u6863\u3002",
        onChange: (e) => update({ prompt: e.target.value })
      })
    ),
    h(
      "div",
      { className: "lsm-grid" },
      h(
        Field,
        { label: `\u76EE\u6807\u5DE5\u4F5C\u533A\uFF08${targets.length} \u4E2A\uFF09` },
        h(SearchSelect, {
          options: targets.map((w) => ({
            value: w.path,
            label: w.path,
            hint: `${w.sessions.length} \u4E2A\u4F1A\u8BDD`
          })),
          value: draft.workspace,
          placeholder: "\u8F93\u5165\u8DEF\u5F84\u4EE5\u7B5B\u9009\u2026",
          emptyText: "\u6CA1\u6709\u5339\u914D\u7684\u5DE5\u4F5C\u533A",
          onChange: (option) => update({ workspace: option.value, sessionId: "" })
        })
      ),
      h(
        Field,
        { label: "\u76EE\u6807\u4F1A\u8BDD\uFF08\u7559\u7A7A = \u81EA\u52A8\u521B\u5EFA\uFF09" },
        h(SearchSelect, {
          options: workspaceSessions.map((s) => ({
            value: s.sessionId,
            // Fall back to the id rather than a placeholder: a session with no
            // title event is common, and its id is what identifies it.
            label: s.title || s.sessionId,
            hint: s.title ? s.sessionId.slice(0, 12) : "",
            // Carried separately so the saved record keeps the real title:
            // `label` may be the id fallback, which must not be stored as one.
            title: s.title ?? ""
          })),
          value: draft.sessionId,
          placeholder: draft.workspace ? "\u7559\u7A7A\u5219\u81EA\u52A8\u521B\u5EFA\uFF1B\u6216\u8F93\u5165\u6807\u9898/sessionId \u7B5B\u9009" : "\u8BF7\u5148\u9009\u62E9\u5DE5\u4F5C\u533A",
          emptyText: "\u8BE5\u5DE5\u4F5C\u533A\u4E0B\u65E0\u5339\u914D\u4F1A\u8BDD",
          // The title is saved with the id so the monitor card can name its
          // target without re-reading every session on each render.
          onChange: (option) => update({
            sessionId: option.value,
            sessionTitle: option.title ?? ""
          })
        })
      )
    ),
    // Source filtering: an empty sender list and an unchecked mention box
    // mean "every message", which is also the default for saved monitors.
    // Rendered as a plain div, not a Field: a Field is one <label>, and a
    // label may only control one form element — wrapping the checkbox list
    // in it would make clicking any name toggle the first checkbox.
    h(
      "div",
      { className: "lsm-field" },
      h("span", { className: "lsm-label" }, "\u6D88\u606F\u6765\u6E90\uFF1A\u4EC5\u63A5\u6536\u6307\u5B9A\u53D1\u9001\u8005\uFF08\u7559\u7A7A = \u6240\u6709\u53D1\u9001\u8005\uFF09"),
      !draft.chatId ? h("span", { className: "lsm-hint" }, "\u8BF7\u5148\u9009\u62E9\u8981\u76D1\u542C\u7684\u4F1A\u8BDD") : h(
        "div",
        { className: "lsm-sender-list" },
        senders.length === 0 ? h(
          "span",
          { className: "lsm-hint" },
          "\u6B63\u5728\u8BFB\u53D6\u53D1\u9001\u8005\u2026\uFF08\u5019\u9009\u6765\u81EA\u8BE5\u4F1A\u8BDD\u6700\u8FD1 7 \u5929\u7684\u6D88\u606F\uFF0C\u672A\u53D1\u8A00\u7684\u6210\u5458\u4E0D\u4F1A\u51FA\u73B0\u5728\u5217\u8868\u4E2D\uFF09"
        ) : senders.map((sender) => h(
          "label",
          { key: sender.id, className: "lsm-inline" },
          h("input", {
            type: "checkbox",
            checked: (draft.onlySenderIds ?? []).includes(sender.id),
            onChange: (e) => update({
              onlySenderIds: e.target.checked ? [...draft.onlySenderIds ?? [], sender.id] : (draft.onlySenderIds ?? []).filter((id) => id !== sender.id)
            })
          }),
          h(
            "span",
            { className: "lsm-hint" },
            `${sender.name || sender.id}\uFF08${sender.type === "bot" ? "\u673A\u5668\u4EBA" : "\u7528\u6237"}\uFF09`
          )
        ))
      )
    ),
    h(
      "label",
      { className: "lsm-inline" },
      h("input", {
        type: "checkbox",
        checked: draft.alsoBotMention === true,
        onChange: (e) => update({ alsoBotMention: e.target.checked })
      }),
      h(
        "span",
        { className: "lsm-hint" },
        "\u4E5F\u63A5\u6536 @\u673A\u5668\u4EBA \u7684\u6D88\u606F\uFF08@\u672C\u5E94\u7528\u673A\u5668\u4EBA\u7684\u6D88\u606F\u4E0D\u53D7\u53D1\u9001\u8005\u540D\u5355\u9650\u5236\uFF1B\u540D\u5355\u7559\u7A7A\u65F6\u5373\u53EA\u6536 @\u673A\u5668\u4EBA \u7684\u6D88\u606F\uFF09"
      )
    ),
    // Only meaningful while no session is chosen: it decides whether the
    // auto-created session is reused or a fresh one is made per message.
    draft.sessionId ? null : h(
      "label",
      { className: "lsm-inline lsm-inline-box" },
      h("input", {
        type: "checkbox",
        checked: draft.autoCreateAndPin === true,
        onChange: (e) => update({ autoCreateAndPin: e.target.checked })
      }),
      h(
        "span",
        { className: "lsm-hint" },
        "\u81EA\u52A8\u521B\u5EFA\u5E76\u56FA\u5B9A\u7ED1\u5B9A\uFF08\u52FE\u9009\uFF1A\u9996\u6B21\u81EA\u52A8\u521B\u5EFA\u540E\u56FA\u5B9A\u4F7F\u7528\u8BE5\u4F1A\u8BDD\uFF1B\u4E0D\u52FE\u9009\uFF1A\u6BCF\u6761\u6D88\u606F\u90FD\u65B0\u5EFA\u4E00\u4E2A\u4F1A\u8BDD\uFF09"
      )
    ),
    h(
      "label",
      { className: "lsm-inline" },
      h("input", {
        type: "checkbox",
        checked: draft.skipOwnMessages === true,
        onChange: (e) => update({ skipOwnMessages: e.target.checked })
      }),
      h("span", { className: "lsm-hint" }, "\u8FC7\u6EE4\u81EA\u5DF1\u53D1\u9001\u7684\u6D88\u606F\uFF08\u4E0D\u6295\u9012\u4F60\u672C\u4EBA\u53D1\u9001\u7684\u6D88\u606F\uFF09")
    ),
    h(
      "label",
      { className: "lsm-inline" },
      h("input", {
        type: "checkbox",
        checked: draft.enabled,
        onChange: (e) => update({ enabled: e.target.checked })
      }),
      h("span", { className: "lsm-hint" }, "\u542F\u7528\u8BE5\u76D1\u542C")
    ),
    error ? h("div", { className: "lsm-notice lsm-notice-err" }, error) : null,
    h(
      "div",
      { className: "lsm-row" },
      h(
        "button",
        { className: "lsm-btn lsm-btn-primary", disabled: busy, onClick: onSave },
        busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58"
      ),
      h("button", { className: "lsm-btn", disabled: busy, onClick: onCancel }, "\u53D6\u6D88")
    )
  );
}
function AuthCard({ settings, authorization, onBegin, onComplete, onSignOut, busy, error, attempt }) {
  if (!settings.app.appId || !settings.app.hasSecret) {
    return h(
      "div",
      { className: "lsm-notice" },
      "\u8BF7\u5148\u5728\u4E0A\u65B9\u586B\u5199\u5E76\u4FDD\u5B58 App ID \u4E0E App Secret\uFF0C\u7136\u540E\u56DE\u5230\u8FD9\u91CC\u5B8C\u6210\u6388\u6743\u3002"
    );
  }
  if (attempt) {
    return h(
      "div",
      { className: "lsm-card" },
      h("div", { className: "lsm-title" }, "\u7B49\u5F85\u6388\u6743"),
      h("div", { className: "lsm-hint" }, "\u8BF7\u5728\u6D4F\u89C8\u5668\u4E2D\u6253\u5F00\u4E0B\u9762\u7684\u94FE\u63A5\u5E76\u786E\u8BA4\u6388\u6743\uFF0C\u7136\u540E\u70B9\u51FB\u300C\u6211\u5DF2\u5B8C\u6210\u6388\u6743\u300D\u3002"),
      h("div", { className: "lsm-url" }, attempt.verificationUrlComplete || attempt.verificationUrl),
      h(
        "div",
        { className: "lsm-row" },
        h("button", { className: "lsm-btn", onClick: () => window.open(attempt.verificationUrlComplete || attempt.verificationUrl, "_blank", "noopener") }, "\u6253\u5F00\u6388\u6743\u9875"),
        h(
          "button",
          { className: "lsm-btn lsm-btn-primary", disabled: busy, onClick: () => onComplete(attempt.deviceCode) },
          busy ? "\u68C0\u67E5\u4E2D\u2026" : "\u6211\u5DF2\u5B8C\u6210\u6388\u6743"
        ),
        h("button", { className: "lsm-btn", disabled: busy, onClick: onSignOut }, "\u53D6\u6D88")
      ),
      error ? h("div", { className: "lsm-notice lsm-notice-err" }, error) : null
    );
  }
  if (!authorization.authorized) {
    return h(
      "div",
      { className: "lsm-card" },
      h("div", { className: "lsm-title" }, "\u672A\u6388\u6743"),
      h(
        "div",
        { className: "lsm-hint" },
        "\u672C\u63D2\u4EF6\u4EE5\u4F60\u672C\u4EBA\u7684\u8EAB\u4EFD\u8BFB\u53D6\u4F1A\u8BDD\uFF0C\u56E0\u6B64\u9700\u8981\u4F60\u6388\u6743\u4E00\u6B21\u3002\u6388\u6743\u540E token \u4FDD\u5B58\u5728 DSH \u51ED\u636E\u670D\u52A1\u4E2D\u5E76\u81EA\u52A8\u5237\u65B0\u3002"
      ),
      error ? h("div", { className: "lsm-notice lsm-notice-err" }, error) : null,
      h(
        "button",
        { className: "lsm-btn lsm-btn-primary", disabled: busy, onClick: onBegin },
        busy ? "\u53D1\u8D77\u4E2D\u2026" : "\u5F00\u59CB\u6388\u6743"
      )
    );
  }
  return h(
    "div",
    { className: "lsm-card" },
    h(
      "div",
      { className: "lsm-row" },
      h("div", { className: "lsm-title" }, "\u5DF2\u6388\u6743"),
      h(Badge, { tone: "ok" }, "user token \u6709\u6548"),
      h(
        "div",
        { className: "lsm-meta" },
        h("span", null, `\u5230\u671F\u65F6\u95F4\uFF1A${formatTime(authorization.expiresAt)}`),
        authorization.needsRefresh ? h("span", null, "\uFF08\u5C06\u5728\u4E0B\u6B21\u8C03\u7528\u524D\u81EA\u52A8\u5237\u65B0\uFF09") : null
      ),
      h("div", { className: "lsm-spacer" }),
      h("button", {
        className: "lsm-btn lsm-btn-danger",
        disabled: busy,
        onClick: onSignOut
      }, "\u9000\u51FA\u6388\u6743")
    ),
    error ? h("div", { className: "lsm-notice lsm-notice-err" }, error) : null
  );
}
function LarkMonitorPage({ rpcCall }) {
  const [snapshot, setSnapshot] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [appForm, setAppForm] = React.useState({ appId: "", appSecret: "", domain: "feishu", pollIntervalMs: 3e4 });
  const [attempt, setAttempt] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [editorError, setEditorError] = React.useState("");
  const invoke = React.useCallback(async (method, payload = {}) => {
    const value = unwrap(await rpcCall(method, payload), method);
    return value;
  }, [rpcCall]);
  const load = React.useCallback(async (forceChats = false) => {
    try {
      const data = await invoke(EP.get);
      setSnapshot((prev) => mergeSettings(prev, data));
      setAppForm((prev) => ({
        appId: data.settings.app.appId || prev.appId,
        // Keep whatever the user typed. Clearing it here would both wipe the
        // dots they just typed and — because an empty secret means "clear the
        // stored one" on save — silently delete the credential on the next
        // unrelated save.
        appSecret: prev.appSecret,
        domain: data.settings.app.domain || "feishu",
        pollIntervalMs: data.settings.pollIntervalMs || 3e4
      }));
      if (data.authorization.authorized) {
        const list = await invoke(EP.chatList, { force: forceChats });
        setSnapshot((prev) => mergeChats(prev, list.chats));
      }
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [invoke]);
  const loadTargets = React.useCallback(async () => {
    try {
      const targets2 = await invoke(EP.targetList);
      setSnapshot((prev) => mergeTargets(prev, targets2.workspaces));
    } catch (err) {
      setError(`\u52A0\u8F7D\u5DE5\u4F5C\u533A\u5931\u8D25\uFF1A${err.message}`);
    }
  }, [invoke]);
  const [senders, setSenders] = React.useState([]);
  React.useEffect(() => {
    const chatId = draft?.chatId;
    if (!chatId) {
      setSenders([]);
      return void 0;
    }
    let cancelled = false;
    setSenders([]);
    invoke(EP.chatSenders, { chatId }).then((data) => {
      if (!cancelled) setSenders(data.senders ?? []);
    }).catch(() => {
      if (!cancelled) setSenders([]);
    });
    return () => {
      cancelled = true;
    };
  }, [draft?.chatId, invoke]);
  const sessionTitles = React.useMemo(() => {
    const byId = /* @__PURE__ */ new Map();
    for (const workspace of snapshot?.targets ?? []) {
      for (const session of workspace.sessions ?? []) {
        if (session.sessionId && session.title) byId.set(session.sessionId, session.title);
      }
    }
    return byId;
  }, [snapshot?.targets]);
  React.useEffect(() => {
    void loadTargets();
  }, [loadTargets]);
  React.useEffect(() => {
    void load();
  }, [load]);
  const run = async (action, okMessage) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await action();
      if (okMessage) setNotice(okMessage);
      return value;
    } catch (err) {
      setError(err.message);
      return void 0;
    } finally {
      setBusy(false);
    }
  };
  if (!snapshot) {
    return h(
      "div",
      { className: "lsm-root" },
      error ? h("div", { className: "lsm-notice lsm-notice-err" }, error) : h("div", { className: "lsm-empty" }, "\u52A0\u8F7D\u4E2D\u2026")
    );
  }
  const chats = snapshot.chats ?? [];
  const targets = snapshot.targets ?? [];
  const statuses = new Map((snapshot.runtime ?? []).map((s) => [s.monitorId, s]));
  return h(
    "div",
    { className: "lsm-root" },
    // ---- app credentials ----
    h(
      "section",
      { className: "lsm-section" },
      h(
        "div",
        { className: "lsm-card" },
        // One row: the three credential fields and the button that commits
        // them. Flex (not the grid) because the button is not a field and must
        // not stretch to a field's height.
        h(
          "div",
          { className: "lsm-fieldrow" },
          h(
            Field,
            { label: "App ID" },
            h("input", {
              className: "lsm-input",
              value: appForm.appId,
              placeholder: "cli_xxx",
              onChange: (e) => setAppForm({ ...appForm, appId: e.target.value })
            })
          ),
          h(
            Field,
            { label: "App Secret" },
            h("input", {
              className: "lsm-input",
              type: "password",
              value: appForm.appSecret,
              placeholder: snapshot.settings.app.hasSecret ? "\u5DF2\u4FDD\u5B58\uFF08\u7559\u7A7A\u5219\u4E0D\u4FEE\u6539\uFF09" : "\u586B\u5199 App Secret",
              onChange: (e) => setAppForm({ ...appForm, appSecret: e.target.value })
            })
          ),
          h(
            Field,
            {
              label: "\u8F6E\u8BE2\u95F4\u9694\uFF08\u79D2\uFF09",
              className: "lsm-field-narrow",
              title: "\u6700\u5C0F 2 \u79D2"
            },
            h("input", {
              // Stored as milliseconds; shown as seconds because that is the
              // unit a person reasons about here.
              className: "lsm-input",
              type: "number",
              min: 2,
              step: 1,
              title: "\u6700\u5C0F 2 \u79D2",
              value: Math.round(appForm.pollIntervalMs / 1e3),
              onChange: (e) => setAppForm({
                ...appForm,
                pollIntervalMs: Math.max(2, Number(e.target.value) || 2) * 1e3
              })
            })
          ),
          h(
            Field,
            { label: "\xA0" },
            h("button", {
              className: "lsm-btn lsm-btn-primary",
              disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.save, { ...appForm });
                await load(true);
              }, "\u5DF2\u4FDD\u5B58\u3002")
            }, "\u4FDD\u5B58")
          )
        )
      )
    ),
    // ---- authorization ----
    h(
      "section",
      { className: "lsm-section" },
      h("div", { className: "lsm-title" }, "\u7528\u6237\u6388\u6743"),
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
          if (outcome.status === "authorized") {
            setAttempt(null);
            await load(true);
          } else if (outcome.status === "slow-down") {
            setError("\u98DE\u4E66\u8981\u6C42\u964D\u4F4E\u8F6E\u8BE2\u9891\u7387\uFF0C\u8BF7\u7A0D\u7B49\u51E0\u79D2\u518D\u8BD5\u3002");
          } else {
            setError("\u5C1A\u672A\u68C0\u6D4B\u5230\u6388\u6743\uFF0C\u8BF7\u786E\u8BA4\u5DF2\u5728\u98DE\u4E66\u9875\u9762\u5B8C\u6210\u6388\u6743\u3002");
          }
        }),
        onSignOut: () => run(async () => {
          await invoke(EP.authSignOut);
          setAttempt(null);
          await load();
        }, "\u5DF2\u9000\u51FA\u6388\u6743\u3002")
      })
    ),
    // ---- monitors ----
    h(
      "section",
      { className: "lsm-section" },
      h(
        "div",
        { className: "lsm-section-head" },
        h("div", { className: "lsm-title" }, `\u76D1\u542C\u5217\u8868\uFF08${snapshot.settings.monitors.length}\uFF09`),
        h("button", {
          className: "lsm-btn lsm-btn-primary",
          disabled: busy,
          onClick: () => {
            setEditorError("");
            setDraft({ ...EMPTY_DRAFT });
          }
        }, "\u65B0\u5EFA\u76D1\u542C")
      ),
      h(
        "div",
        { className: "lsm-hint" },
        "\u6BCF 30 \u79D2\u8F6E\u8BE2\u4E00\u6B21\u88AB\u76D1\u542C\u4F1A\u8BDD\uFF1B\u65B0\u6D88\u606F\u4EE5\u300CPrompt + \u6D88\u606F\u6587\u672C\u300D\u6295\u9012\u5230\u76EE\u6807\u4F1A\u8BDD\u3002\u56FE\u7247\u3001\u6587\u4EF6\u7B49\u975E\u6587\u672C\u6D88\u606F\u4EE5\u7C7B\u578B\u6807\u7B7E\u6295\u9012\u3002"
      ),
      draft ? h(MonitorEditor, {
        draft,
        setDraft,
        chats,
        targets,
        senders,
        busy,
        error: editorError,
        onCancel: () => setDraft(null),
        onSave: () => run(async () => {
          setEditorError("");
          if (!draft.chatId) {
            setEditorError("\u8BF7\u9009\u62E9\u8981\u76D1\u542C\u7684\u4F1A\u8BDD\u3002");
            return;
          }
          if (!draft.prompt.trim()) {
            setEditorError("Prompt \u4E3A\u5FC5\u586B\u9879\u3002");
            return;
          }
          try {
            await invoke(EP.monitorSave, { ...draft, enabled: draft.enabled });
            setDraft(null);
            setNotice("\u76D1\u542C\u5DF2\u4FDD\u5B58\u3002");
            await load();
          } catch (err) {
            setEditorError(err.message);
          }
        }, "")
      }) : null,
      snapshot.settings.monitors.length === 0 && !draft ? h("div", { className: "lsm-empty" }, "\u5C1A\u672A\u914D\u7F6E\u76D1\u542C\u3002\u70B9\u51FB\u300C\u65B0\u5EFA\u76D1\u542C\u300D\u9009\u62E9\u8981\u76D1\u542C\u7684\u4F1A\u8BDD\u3002") : null,
      // Editing the only monitor hides its card, which would otherwise leave
      // this area blank and read as "the monitor disappeared".
      draft && draft.monitorId && snapshot.settings.monitors.length === 1 ? h("div", { className: "lsm-hint" }, "\u8BE5\u76D1\u542C\u6B63\u5728\u4E0A\u65B9\u7F16\u8F91\u3002") : null,
      snapshot.settings.monitors.map((monitor) => {
        if (draft && draft.monitorId === monitor.monitorId) return null;
        const status = statuses.get(monitor.monitorId) ?? {};
        return h(
          "div",
          { key: monitor.monitorId, className: "lsm-monitor" },
          h(
            "div",
            { className: "lsm-monitor-head" },
            h("div", { className: "lsm-monitor-name" }, monitor.name || monitor.chatName || monitor.chatId),
            h(
              "div",
              { className: "lsm-inline" },
              monitor.enabled ? h(Badge, { tone: "ok" }, "\u542F\u7528") : h(Badge, { tone: "off" }, "\u505C\u7528"),
              status.lastError ? h(Badge, { tone: "err" }, "\u5F02\u5E38") : null
            )
          ),
          h(
            "div",
            { className: "lsm-meta" },
            h("span", null, `\u4F1A\u8BDD\uFF1A${monitor.chatName || monitor.chatId}`),
            h(
              "span",
              { className: "lsm-code" },
              monitor.sessionId ? h(
                "span",
                { title: monitor.sessionId },
                `\u76EE\u6807\uFF1A${monitor.sessionTitle || sessionTitles.get(monitor.sessionId) || monitor.sessionId}`
              ) : monitor.autoCreateAndPin ? "\u76EE\u6807\uFF1A\u81EA\u52A8\u521B\u5EFA\u5E76\u56FA\u5B9A\u7ED1\u5B9A\uFF08\u5C1A\u672A\u521B\u5EFA\uFF09" : "\u76EE\u6807\uFF1A\u6BCF\u6761\u6D88\u606F\u65B0\u5EFA"
            ),
            monitor.skipOwnMessages ? h("span", null, "\u8FC7\u6EE4\u81EA\u5DF1\u6D88\u606F") : null,
            monitor.alsoBotMention || (monitor.onlySenderIds?.length ?? 0) > 0 ? h("span", null, [
              (monitor.onlySenderIds?.length ?? 0) > 0 ? `\u6307\u5B9A\u53D1\u9001\u8005\xD7${monitor.onlySenderIds.length}` : "",
              monitor.alsoBotMention ? "@\u673A\u5668\u4EBA" : ""
            ].filter(Boolean).map((part, index) => index === 0 ? `\u6765\u6E90\uFF1A${part}` : ` \u6216 ${part}`).join("")) : null,
            h("span", null, `\u5DF2\u6295\u9012 ${status.delivered ?? 0} \u6761`),
            h("span", null, `\u6700\u540E\u8F6E\u8BE2\uFF1A${formatTime(status.lastPollAt)}`)
          ),
          h(
            "div",
            { className: "lsm-meta" },
            h("span", null, `Prompt\uFF1A${monitor.prompt.slice(0, 60)}${monitor.prompt.length > 60 ? "\u2026" : ""}`)
          ),
          status.lastError ? h("div", { className: "lsm-notice lsm-notice-err" }, status.lastError) : null,
          h(
            "div",
            { className: "lsm-row" },
            h("button", {
              className: "lsm-btn",
              disabled: busy,
              onClick: () => {
                setEditorError("");
                setDraft({ ...EMPTY_DRAFT, ...monitor });
              }
            }, "\u7F16\u8F91"),
            h("button", {
              className: "lsm-btn",
              disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.monitorSave, { monitorId: monitor.monitorId, enabled: !monitor.enabled });
                await load();
              })
            }, monitor.enabled ? "\u505C\u7528" : "\u542F\u7528"),
            h("button", {
              className: "lsm-btn",
              disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.monitorPollNow, { monitorId: monitor.monitorId });
                await load();
              }, "\u5DF2\u89E6\u53D1\u4E00\u6B21\u8F6E\u8BE2\u3002")
            }, "\u7ACB\u5373\u8F6E\u8BE2"),
            h("button", {
              className: "lsm-btn",
              disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.monitorReset, { monitorId: monitor.monitorId });
                await load();
              }, "\u5DF2\u91CD\u7F6E\u6E38\u6807\uFF0C\u5C06\u91CD\u65B0\u8BFB\u53D6\u6700\u8FD1 10 \u5206\u949F\u7684\u6D88\u606F\u3002")
            }, "\u91CD\u7F6E\u6E38\u6807"),
            h("button", {
              className: "lsm-btn lsm-btn-danger",
              disabled: busy,
              onClick: () => run(async () => {
                await invoke(EP.monitorDelete, { monitorId: monitor.monitorId });
                await load();
              }, "\u76D1\u542C\u5DF2\u5220\u9664\u3002")
            }, "\u5220\u9664")
          )
        );
      })
    ),
    notice ? h("div", { className: "lsm-notice lsm-notice-ok" }, notice) : null,
    error && !snapshot ? null : error ? h("div", { className: "lsm-notice lsm-notice-err" }, error) : null
  );
}
function apply(ctx) {
  ctx.effect(() => installStyles(), "dsh-lark-session-monitor-plugin: styles");
  ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
    name: "settings.plugins.tab",
    id: "lark-session-monitor",
    order: 40,
    label: () => "\u98DE\u4E66\u4F1A\u8BDD\u76D1\u542C",
    // The page receives only a bound RPC function; it never touches the
    // connection directly, so the transport stays swappable.
    inject: () => ({
      rpcCall: (method, payload, signal) => callSettingsRpc(ctx.connection, method, payload, signal)
    })
  }, LarkMonitorPage));
}

    return module.exports;
  },
});
