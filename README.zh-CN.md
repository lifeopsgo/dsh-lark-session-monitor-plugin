<div align="center">

# dsh-lark-session-monitor-plugin

**以你本人的身份监听飞书（Lark）会话，把新消息投递到指定的 DeepSeek Harness 会话。**

[English](./README.md) · **简体中文**

<img alt="「飞书会话监听」设置页" src="./docs/setting-page.png" width="620">

</div>

## 这是什么

一个 **DeepSeek Harness (DSH)** 插件，以**你本人的用户身份**读取飞书会话，把新消息作为 prompt 投递到你指定的 DSH 会话。


## 兼容的 DSH 版本

| DSH 版本 | 状态 |
| --- | --- |
| 0.2.0-rc.1 及以上 | **已验证** — 已针对当前 DSH Web 运行时核验包表面与插件契约，并通过自动构建和回归测试 |
| 更早的 0.1.x 版本 | 此发布线不支持 |

## 快速开始

需要 **Node.js ≥ 22.6**。

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-lark-session-monitor-plugin#v2.2.0
```

重启 DSH，然后刷新页面。打开 **设置 → 插件 → 飞书会话监听**。

<details>
<summary>升级或卸载</summary>

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-lark-session-monitor-plugin#v2.2.0
dsh plugin --profile web remove dsh-lark-session-monitor-plugin
```

</details>

## 配置步骤

### 1. 创建飞书应用

在[飞书开放平台](https://open.feishu.cn/app)创建自建应用，开通以下**用户**权限：

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:get_as_user` | 读取你的私聊会话 |
| `im:message.group_msg:get_as_user` | 读取你的群会话 |
| `im:chat:read` | 解析会话名称 |
| `offline_access` | 免重复授权即可刷新 token |

把 **App ID** 与 **App Secret** 填入设置页并保存。

### 2. 授权

点击 **开始授权**，打开链接、在飞书中确认授权，然后点击 **我已完成授权**。

用户 token 保存在 DSH 的 **credentials** 服务中并自动刷新。Secret 与 token 都不会通过 RPC 返回。

### 3. 新建监听

点击 **新建监听**：

| 字段 | 含义 |
| --- | --- |
| **名称** | 可选标识 |
| **会话类型** | 把选择列表筛选为 全部 / 私聊 / 群 |
| **监听会话** | 要监听的会话；输入名称或 chat_id 筛选，匹配在你的全部会话中执行，被 `maxChats` 截掉的会话同样能搜到 |
| **Prompt** | 置于消息正文之前一并发送 |
| **目标工作区** | 目标会话所在的工作区 |
| **目标会话** | 留空则自动创建；标题在选中工作区后分批载入并逐个出现，无标题的会话以 sessionId 显示 |
| **过滤自己发送的消息** | 默认关闭；开启后不投递你本人发送的消息 |
| **仅接收指定发送者** | 默认留空 = 所有发送者；可多选会话中出现过的用户/机器人，仅投递其消息。姓名取自该会话的成员列表（`im:chat.members:read`），读不到姓名的成员显示其 open_id |
| **也接收 @机器人 的消息** | 默认关闭；开启后 @本应用机器人 的消息即使发送者不在名单内也投递 |
| **关键词黑名单** | 默认留空；消息渲染文本命中任一关键词即不投递（进度照常推进，不会卡住重读） |
| **关键词白名单** | 默认留空 = 全部投递；配置后仅投递渲染文本命中任一关键词的消息；与黑名单同时命中时黑名单优先 |
| **启用** | 该监听是否参与轮询 |

## 配置参考

Host 侧插件配置写在 loader 条目的 `config` 下（bundle 自带的 `cordis.patch.yml` 插入 id 为 `lark-session-monitor` 的条目）：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `maxChats` | `500` | 会话选择器单次返回的会话数上限。列表按群组活跃时间倒序（飞书 `sort_type=ByActiveTimeDesc`）载入，超出的部分从最不活跃的一端截掉；关键词搜索在你的全部会话中执行，不受此上限影响 |
| `rpcAuthority` | `trusted-host` | 设置端点的准入；`loopback` 额外要求回环 Host 与 Origin |
| `autoStart` | `true` | 完成授权后是否自动开始轮询 |

覆盖示例（`~/.dsh/cordis.patch.yml`）：

```yaml
- id: lark-session-monitor
  name: 'dsh-lark-session-monitor-plugin'
  config:
    maxChats: 1000
```

## 投递机制

新消息合成一条 prompt 投递：

```text
<你的 prompt>

[发送者] [消息ID] 消息正文

[发送者] [消息ID] 第二条消息
```

**消息渲染。** 只有可读文本会被投递，飞书原始 JSON 不会进入 prompt。文本取其正文，富文本被展平，卡片按原始卡片 JSON（`card_msg_content_type=user_card_content`）读取并渲染成可读行——标题、正文、备注、按钮及其链接；链接只作为 URL 文本投递，不会抓取内容。图片/文件/音视频转为 `[图片]` 这样的标签。无可投递内容的消息会被跳过。每条投递都带飞书消息 ID，会话侧可以引用具体某条消息。

**目标会话。** `目标会话` 字段决定消息去向：

| 目标会话 | 自动创建并固定绑定 | 行为 |
| --- | --- | --- |
| 选中的会话 | — | 消息累积到该会话 |
| 留空 | ✅ | 首次投递创建会话并固定 |
| 留空 | ⬜ | 每条消息都新建一个会话 |

**轮询。** 同一监听同时只跑一轮。单条 prompt 最多 **10 条消息**，其余在本次投递后继续。游标只在投递成功后推进，因此投递失败会重读该批消息。

**自己的消息。** 监听可以过滤掉你本人发送的消息；若无法读取你的身份，则照旧投递。
**消息来源筛选。** 发送者名单把监听收窄到指定发送者（候选来自该会话最近的发言者）；「也接收 @机器人」把它放宽一格：@本应用机器人的消息即使发送者不在名单里也投递——被点名本身就是信号。名单留空 + 开关打开 = 只收 @机器人 的消息；两者都不设即照旧接收全部。机器人身份用应用自身的凭据解析，无需新增授权；解析失败时本轮挂起——不投递也不丢消息，每次轮询自动重试。

## 隐私

- 仅读取你配置的会话，以及轮询窗口内的消息。
- App Secret 存在设置文件，用户 token 存在 DSH 的 credentials 服务；两者都不会通过 RPC 返回。
- 唯一的网络访问是你授权的飞书 API 调用：用户 token 读取会话，应用自身凭据解析 @机器人 筛选所需的机器人身份。没有遥测。
- 消息文本只交给你选定的 DSH 会话。插件不会向飞书回复。
- 设置端点走 DSH 已认证的 `/api` 通道。`rpcAuthority: loopback` 可额外要求回环 Host 与 Origin。

## 已知限制

- **仅文本。** 图片、文件、音视频以类型标签投递。
- **轮询而非推送。** 投递延迟受轮询间隔约束；离线期间的消息不会被补推（超出首次读取窗口的部分）。
- **会话列表按活跃度截断。** 选择器按群组活跃时间倒序载入，超出 `maxChats` 的会话不出现在未筛选列表中（设置页会显示提示）；关键词搜索不受影响。飞书官方提示 `ByActiveTimeDesc` 排序在分页期间可能跳过活跃时间突变的个别会话，被跳过的会话会在下一次列表刷新（60 秒缓存过期后）出现。
- **会话标题按工作区渐进载入。** 折叠一个标题要读取并解析该会话的完整日志，因此 `target.list` 只返回会话 id。标题在选中工作区后分批折叠：每批 4 个会话、每批 3 秒，界面先显示 id，标题逐个补齐，结果写入 `$DSH_HOME/plugin-data/dsh-lark-session-monitor-plugin/session-titles.json`，重启后不再重读。超出单批时限的会话以 id 显示，不再重试——一个巨型或损坏的日志不会拖住该工作区的其他会话。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
