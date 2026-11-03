<div align="center">

# dsh-lark-session-monitor-plugin

**Watch Feishu (Lark) conversations as yourself, and forward new messages into a DeepSeek Harness session.**

**English** · [简体中文](./README.zh-CN.md)

<img alt="The 飞书会话监听 settings page" src="./docs/setting-page.png" width="620">

</div>

## What it is

A **DeepSeek Harness (DSH)** plugin that reads Feishu conversations with **your own user identity** and delivers new messages as prompts into a DSH session you choose.

## Compatible DSH versions

| DSH version | Status |
| --- | --- |
| 0.2.0-rc.1 or later | **verified** — package surface and plugin contract checked against the current DSH Web runtime; automated build and regression suite pass |
| Earlier 0.1.x releases | not supported by this release line |

## Quick start

Requires **Node.js ≥ 22.6**.

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-lark-session-monitor-plugin#v2.2.0
```

Restart DSH, then refresh the page. Open **Settings → Plugins → 飞书会话监听**.

<details>
<summary>Upgrade or remove</summary>

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-lark-session-monitor-plugin#v2.2.0
dsh plugin --profile web remove dsh-lark-session-monitor-plugin
```

</details>

## Setup

### 1. Create a Feishu app

In the [Feishu Open Platform](https://open.feishu.cn/app) console, create a self-built app and enable these **user** permissions:

| Scope | Purpose |
| --- | --- |
| `im:message.p2p_msg:get_as_user` | Read your p2p conversations |
| `im:message.group_msg:get_as_user` | Read your group conversations |
| `im:chat:read` | Resolve conversation names |
| `offline_access` | Refresh the token without re-authorizing |

Enter the **App ID** and **App Secret** in the settings page and save.

### 2. Authorize

Click **开始授权**, open the link, approve the scopes in Feishu, then click **我已完成授权**.

The user token is stored in DSH's **credentials** service and refreshed automatically. Neither the secret nor the token is returned over RPC.

### 3. Create a monitor

Click **新建监听**:

| Field | Meaning |
| --- | --- |
| **名称** | Optional label |
| **会话类型** | Filter the picker to 全部 / 私聊 / 群 |
| **监听会话** | Conversation to watch; type a name or chat_id to filter — matching runs against every conversation you are in, including chats the `maxChats` cap cut from the list |
| **Prompt** | Sent first, with the message text beneath it |
| **目标工作区** | Where the target session lives |
| **目标会话** | Leave empty to auto-create; titles load for the workspace you pick and appear one row at a time, and a session without a title shows its sessionId |
| **Skip own messages** | Off by default; when on, messages you sent yourself are not delivered |
| **Senders** | Empty by default = all senders; pick specific users or bots to receive only their messages. Names come from the chat's member list (`im:chat.members:read`); a member the list does not name shows its open_id |
| **Also @bot mentions** | Off by default; when on, messages that @-mention this app's bot are delivered even from senders outside the whitelist |
| **Blocked keywords** | Empty by default; a message whose rendered text contains any listed keyword is not delivered (the cursor still moves past it) |
| **Allowed keywords** | Empty by default = deliver everything; when set, only messages whose rendered text contains at least one listed keyword are delivered. The blacklist wins when both match |
| **启用** | Whether this monitor polls |

## Settings reference

Host-side plugin configuration lives under the loader entry's `config` key (the bundle's own `cordis.patch.yml` inserts the entry with id `lark-session-monitor`):

| Option | Default | Meaning |
| --- | --- | --- |
| `maxChats` | `500` | Per-response cap for the conversation picker. The list loads most-recently-active first (Feishu `sort_type=ByActiveTimeDesc`), so the cap cuts from the least-active end; keyword search runs against your full conversation list and ignores this cap |
| `rpcAuthority` | `trusted-host` | Admission for the settings endpoint; `loopback` additionally requires a loopback Host and Origin |
| `autoStart` | `true` | Whether polling starts automatically once authorization completes |

Override example (`~/.dsh/cordis.patch.yml`):

```yaml
- id: lark-session-monitor
  name: 'dsh-lark-session-monitor-plugin'
  config:
    maxChats: 1000
```

## How delivery works

New messages are delivered as one prompt:

```text
<your prompt>

[发送者] [消息ID] 消息正文

[发送者] [消息ID] 第二条消息
```

**Message rendering.** Only readable text is delivered; raw Feishu JSON never reaches the model. Text uses its own text, posts are flattened, and cards are read from their original card JSON (`card_msg_content_type=user_card_content`) and rendered as readable lines — headings, text, notes, buttons with their links. Links are delivered as plain URLs, never fetched. Images/files/audio/video become a label such as `[图片]`. Messages with nothing to say are skipped. Each delivered line carries the Feishu message id, so a session can reference the exact message.

**Target session.** The `目标会话` field decides where messages land:

| Target session | Auto-create + pin | Behavior |
| --- | --- | --- |
| A chosen session | — | Messages accumulate there |
| Empty | ✅ | First delivery creates a session and pins it |
| Empty | ⬜ | Every delivery creates a new session |

**Polling.** Polls are single-flight per monitor. At most **10 messages** per prompt; the remainder follows after that delivery. The cursor advances only after a successful delivery, so a failed delivery re-reads its messages.

**Own messages.** A monitor can skip messages you sent yourself; if your identity cannot be read, messages are delivered as before.
**Source filters.** The sender list narrows a monitor to specific senders (candidates are whoever spoke in the chat recently); the @bot switch widens it back by one case: a message that @-mentions this app's bot is accepted even from a sender outside the list — being addressed is the signal, not who typed it. Leave the list empty with the switch on and only @bot messages arrive; leave both unset and everything is delivered as before. The bot's identity is resolved through the app's own credentials — no extra scope; while it cannot be resolved the round is held: nothing delivered, nothing lost, retried every poll.


## Privacy

- Reads only the conversations you configure, within the polling window.
- The App Secret stays in the settings file; the user token stays in DSH's credentials service. Neither is returned over RPC.
- The only network access is the Feishu API calls you authorized: your user token for chat reads, plus the app's own credentials to resolve the bot identity behind the @-mention filter. No telemetry.
- Message text goes only to the DSH session you selected. The plugin never replies into Feishu.
- The settings endpoint rides DSH's authenticated `/api` carrier. `rpcAuthority: loopback` additionally requires a loopback Host and Origin.

## Limitations

- **Text only.** Images, files and media are delivered as type labels.
- **Polling, not push.** Delivery is bounded by the poll interval; offline messages are not back-filled beyond the initial window.
- **Activity-ordered picker.** The conversation picker loads most-recently-active first and cuts what exceeds `maxChats` (the settings page says so when that happens); keyword search is unaffected. Feishu's docs warn that `ByActiveTimeDesc` can skip a chat whose activity changes mid-pagination — a skipped chat returns on the next list refresh, once the 60-second cache expires.
- **Session titles fold progressively, per workspace.** Folding a title reads and parses the session's whole log, so `target.list` answers with ids only. After you pick a workspace, titles fold in chunks of 4 sessions under a 3-second deadline each: rows show ids first and fill in as titles arrive, and the result is cached in `$DSH_HOME/plugin-data/dsh-lark-session-monitor-plugin/session-titles.json` so a restart does not re-read every log. A session whose chunk misses its deadline stays on its id and is not retried — one huge or unreadable log never holds up the rest of the workspace.

## License

MIT — see [LICENSE](./LICENSE).
