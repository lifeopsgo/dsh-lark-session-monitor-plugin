<div align="center">

# dsh-lark-session-monitor

**Watch Feishu (Lark) conversations as yourself, and forward new messages into a DeepSeek Harness session.**

**English** · [简体中文](./README.zh-CN.md)

<img alt="The 飞书会话监听 settings page" src="./docs/setting-page.jpeg" width="820">

</div>

## What it is

A **DeepSeek Harness (DSH)** plugin that reads Feishu conversations with **your own user identity** and delivers new messages as prompts into a DSH session you choose.

Feishu has no user-identity push channel, so it polls.

## Compatible DSH versions

| DSH version | Status |
| --- | --- |
| 0.1.5-rc.1 | **verified** — run in a live Web profile, including a real browser authorization |
| 0.1.5-rc.2 / 0.1.6-alpha.x | expected to work; every DSH surface this plugin uses is unchanged across that range |

`peerDependencies` admit the `0.1.x` prerelease line and reject `0.2.0` and later.

> npm's `latest` tag for `@deepseek-ai/dsh-*` still points at a stale `0.0.1-rc.1`. Install DSH from `next` or `alpha`.

## Quick start

Requires **Node.js ≥ 22.6**.

```bash
dsh plugin --profile web add github:REPLACE_OWNER/dsh-lark-session-monitor#v0.1.0
```

Restart DSH, then refresh the page. Open **Settings → Plugins → 飞书会话监听**.

<details>
<summary>Upgrade or remove</summary>

```bash
dsh plugin --profile web add github:REPLACE_OWNER/dsh-lark-session-monitor#v0.1.0
dsh plugin --profile web remove dsh-lark-session-monitor
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
| **监听会话** | Conversation to watch; type to filter |
| **Prompt** | Sent first, with the message text beneath it |
| **目标工作区** | Where the target session lives |
| **目标会话** | Leave empty to auto-create |
| **启用** | Whether this monitor polls |

## How delivery works

New messages are delivered as one prompt:

```text
<your prompt>

[发送者] 消息正文

[发送者] 第二条消息
```

**Message rendering.** Only readable text is delivered; raw Feishu JSON never reaches the model. Text uses its own text, posts are flattened, cards contribute title and summary, and images/files/audio/video become a label such as `[图片]`. Messages with nothing to say are skipped.

**Target session.** The `目标会话` field decides where messages land:

| Target session | Auto-create + pin | Behavior |
| --- | --- | --- |
| A chosen session | — | Messages accumulate there |
| Empty | ✅ | First delivery creates a session and pins it |
| Empty | ⬜ | Every delivery creates a new session |

**Polling.** Polls are single-flight per monitor. At most **10 messages** per prompt; the remainder follows after that delivery. The cursor advances only after a successful delivery, so a failed delivery re-reads its messages.

**Deleted targets.** A deleted session is replaced in the monitor's workspace. An id no workspace ever declared is reported as a misconfiguration instead of replaced.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| **App ID** / **App Secret** | — | An empty secret on save keeps the stored one |
| **轮询间隔（秒）** | `30` | Minimum 10 seconds |
| **Prompt** | — | Per monitor; used at delivery |

Stored at `$DSH_HOME/plugin-data/dsh-lark-session-monitor/settings.json`, written atomically with `0600` (it holds the app secret).

Optional config in the profile's `cordis.patch.yml`:

```yaml
- id: lark-session-monitor
  config:
    rpcAuthority: trusted-host   # or loopback
    autoStart: true              # poll from Host start
    maxChats: 500                # conversations returned to the picker
```

## Privacy

- Reads only the conversations you configure, within the polling window.
- The App Secret stays in the settings file; the user token stays in DSH's credentials service. Neither is returned over RPC.
- The only network access is the Feishu API calls you authorized. No telemetry.
- Message text goes only to the DSH session you selected. The plugin never replies into Feishu.
- The settings endpoint rides DSH's authenticated `/api` carrier. `rpcAuthority: loopback` additionally requires a loopback Host and Origin.

## Limitations

- **Text only.** Images, files and media are delivered as type labels.
- **Polling, not push.** Delivery is bounded by the poll interval; offline messages are not back-filled beyond the initial window.
- **Feishu (Lark) only.**

## Development

```bash
npm install
npm run check     # build both halves, then run the tests
```

Both `lib/index.js` (Host) and `lib/client.js` (browser) are committed — a git install runs no build step, so **rebuild and commit `lib/` with any `src/` change**. CI fails when they disagree.

Link a checkout into a live profile while iterating:

```bash
dsh plugin --profile web add /absolute/path/to/this/checkout
```

Restart the Host after a Host-half change; a browser-half change needs only a page refresh.

## License

MIT — see [LICENSE](./LICENSE).
