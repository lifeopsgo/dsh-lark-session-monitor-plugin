<div align="center">

# dsh-lark-session-monitor

**Watch Feishu (Lark) conversations as yourself, and forward new messages into a DeepSeek Harness session.**

**English** · [简体中文](./README.zh-CN.md)

<img alt="The 飞书会话监听 settings page: app credentials, authorization state, and one configured monitor" src="./docs/setting-page.jpeg" width="820">

<sub>Settings → Plugins → 飞书会话监听: credentials, authorization state, and one monitor forwarding a Feishu conversation into a DSH session.</sub>

</div>

## What it is

A **DeepSeek Harness (DSH)** plugin that reads Feishu conversations with **your own user identity** and delivers new messages as prompts into a DSH session you choose.

It exists because of one hard constraint: Feishu delivers `im.message.receive_v1` to *applications*, and an application that is not a member of a p2p chat never receives its events. A person's own token can read any conversation they belong to — but Feishu offers **no user-identity push channel**, so the only way to watch an arbitrary conversation as a person is to poll it. This plugin does exactly that.

Typical uses: feed meeting-note or alert bots into an analysis session, archive a channel's messages, or trigger work from a private conversation.

## Compatible DSH versions

| DSH version | Status | How it was checked |
| --- | --- | --- |
| 0.1.5-rc.1 | **supported — verified** | built and run in a live Web profile: plugin mounted, settings endpoint registered, and a real Feishu authorization completed through the browser |
| 0.1.5-rc.2 / 0.1.6-alpha.x | expected to work | every DSH surface this plugin consumes was read from the installed 0.1.5-rc.1 packages and is unchanged across this range; not run against those builds |

The declared `peerDependencies` admit the `0.1.x` prerelease line (npm's `next` and `alpha` tags) and reject `0.2.0` and later.

> Note: npm's `latest` tag for the `@deepseek-ai/dsh-*` packages still points at a stale `0.0.1-rc.1`. Install DSH from `next` or `alpha`, not `latest`.

## Quick start

Requires **Node.js ≥ 22.6**.

```bash
dsh plugin --profile web add github:REPLACE_OWNER/dsh-lark-session-monitor#v0.1.0
```

Restart the running DSH Web process, then refresh the page. When it is stopped, start it with:

```bash
dsh --profile web web
```

Open **Settings → Plugins → 飞书会话监听**. Replace `web` with another profile name when needed.

<details>
<summary>Upgrade or remove</summary>

```bash
# Upgrade or downgrade: use any tag listed on the releases page
dsh plugin --profile web add github:REPLACE_OWNER/dsh-lark-session-monitor#v0.1.0

# Remove
dsh plugin --profile web remove dsh-lark-session-monitor
```

</details>

## Setup

### 1. Create a Feishu app

In the [Feishu Open Platform](https://open.feishu.cn/app) console, create a self-built app and enable these **user** permissions:

| Scope | Why |
| --- | --- |
| `im:message.p2p_msg:get_as_user` | Read your p2p conversations |
| `im:message.group_msg:get_as_user` | Read your group conversations |
| `im:chat:read` | Resolve conversation names |
| `offline_access` | Refresh the token without re-authorizing |

Copy the **App ID** and **App Secret** into the plugin's settings page and save.

### 2. Authorize

Click **开始授权**. The plugin starts an OAuth 2.0 device flow: open the link, approve the scopes in Feishu, then click **我已完成授权**.

The resulting user token is stored in DSH's own **credentials** service and refreshed automatically. The app secret and the token never leave the Host — no RPC response returns them.

### 3. Create a monitor

Click **新建监听** and choose:

| Field | Meaning |
| --- | --- |
| **名称** | Optional label for the row |
| **会话类型** | Filter the picker to 全部 / 私聊 / 群 |
| **监听会话** | The conversation to watch; type to filter the list |
| **Prompt** | Sent first, with the message text beneath it |
| **目标工作区** | Where the target session lives |
| **目标会话** | Leave empty to auto-create (see below) |
| **启用** | Whether this monitor polls |

## How delivery works

Each poll cycle delivers new messages as a single prompt:

```text
<your prompt>

[发送者] 消息正文

[发送者] 第二条消息
```

**Message rendering.** Only readable text is ever delivered — the raw Feishu JSON never reaches the model. Text messages use their own text; rich posts are flattened; cards contribute their title and summary; images, files and other non-text types become a short label such as `[图片]`. Messages with nothing to say (empty bodies, membership notices) are skipped rather than delivered blank.

**Target session modes.** The `目标会话` field decides where messages land:

| Target session | Auto-create + pin | Behavior |
| --- | --- | --- |
| A chosen session | — | Messages accumulate in that session |
| Empty | ✅ | The first delivery creates a session and pins it; later messages reuse it |
| Empty | ⬜ | Every delivery creates a new session |

**Polling.** Each enabled monitor is polled on the configured interval, and a poll is single-flight per monitor, so a slow Feishu response never stacks requests. At most **10 messages** are delivered in one prompt; the remainder continues after that delivery finishes. Message batches advance the cursor only after delivery succeeds, so a failed delivery re-reads its messages instead of dropping them.

**Deleted targets.** If a session is deleted, the plugin creates a replacement in the monitor's workspace and updates the binding. An id no workspace ever declared is treated as a **misconfiguration** and reported, not silently replaced — auto-creating there would deliver somewhere you never chose.

## Settings reference

| Setting | Default | Meaning |
| --- | --- | --- |
| **App ID** / **App Secret** | — | Feishu app credentials. An empty secret on save keeps the stored one |
| **轮询间隔（秒）** | `30` | Poll interval; minimum 10 seconds |
| **Prompt** | — | Your prompt stays on each monitor, where delivery uses it |

All settings persist to `$DSH_HOME/plugin-data/dsh-lark-session-monitor/settings.json`, written atomically with `0600` permissions (the file holds the app secret).

Optional plugin config, settable in the profile's `cordis.patch.yml`:

```yaml
- id: lark-session-monitor
  config:
    # Settings endpoint access policy: trusted-host (default) or loopback.
    rpcAuthority: trusted-host
    # Start polling on Host start instead of on the first settings visit.
    autoStart: true
    # Ceiling on conversations returned to the picker.
    maxChats: 500
```

## Privacy and security

- **What is read:** the conversations you configure, plus their message history within the polling window. Nothing else.
- **Where credentials go:** the App Secret and the user token are stored on the Host only — the token in DSH's credentials service, the secret in the plugin's settings file. Neither is ever returned over RPC.
- **What leaves the Host:** only the Feishu API calls you authorized. The plugin has no other network access and no telemetry.
- **What is delivered:** message text is handed to the DSH session you selected, and nowhere else. The plugin never replies into Feishu.
- **Endpoints:** the settings endpoint rides DSH's authenticated `/api` carrier, so DSH's browser authentication and Host/Origin trust checks apply first. Set `rpcAuthority: loopback` to additionally require a loopback Host and Origin.

## Limitations

- **Text only.** Images, files, audio and video are delivered as type labels; the plugin does not download or interpret them.
- **Polling, not push.** Feishu has no user-identity push channel, so delivery is bounded by the poll interval. Messages from while the Host was offline are not back-filled beyond the initial window.
- **User identity required.** The monitor reads as you, so it sees exactly what you can see — including conversations a bot could never join.
- **Feishu (Lark) only.** No other IM platform is supported.

## Development

```bash
npm install
npm run check     # build both halves, then run the test suite
```

The Host half bundles to `lib/index.js` and the browser half to `lib/client.js`; both are committed, because a git install runs no build step (see [Publishing notes](#publishing-notes)).

Link a checkout into a live profile while iterating:

```bash
dsh plugin --profile web add /absolute/path/to/this/checkout
```

Restart the Host after a Host-half change; a browser half change only needs a page refresh.

### Publishing notes

The built `lib/` is **committed on purpose.** A `github:` install fetches sources and runs no build script unless the package declares `prepare` and the user allowlists it by hash in their profile's `pnpm-workspace.yaml`. Shipping the built output keeps installation to a single command, matching how other published DSH plugins ship.

If you prefer not to commit build output, add a self-contained `prepare` script and document the `allowBuilds` entry users must add.

## License

MIT — see [LICENSE](./LICENSE).
