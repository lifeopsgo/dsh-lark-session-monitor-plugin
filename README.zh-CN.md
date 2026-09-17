<div align="center">

# dsh-lark-session-monitor

**以你本人的身份监听飞书（Lark）会话，把新消息投递到指定的 DeepSeek Harness 会话。**

[English](./README.md) · **简体中文**

<img alt="「飞书会话监听」设置页：应用凭据、授权状态，以及一条已配置的监听" src="./docs/setting-page.jpeg" width="820">

<sub>设置 → 插件 → 飞书会话监听：应用凭据、授权状态，以及一条把飞书会话投递进 DSH 会话的监听。</sub>

</div>

## 这是什么

一个 **DeepSeek Harness (DSH)** 插件，以**你本人的用户身份**读取飞书会话，把新消息作为 prompt 投递到你指定的 DSH 会话中。

它源于一个硬约束：飞书把 `im.message.receive_v1` 事件投递给**应用**，而一个不在私聊会话里的应用永远收不到该会话的事件。用户自己的 token 可以读取自己参与的任意会话——但飞书**没有用户身份的推送通道**，因此以个人身份监听任意会话的唯一办法就是轮询。本插件正是这样做的。

典型用途：把会议纪要机器人、告警机器人的消息送入分析会话；归档某个会话的消息；或由私聊触发后续工作。

## 兼容的 DSH 版本

| DSH 版本 | 状态 | 验证方式 |
| --- | --- | --- |
| 0.1.5-rc.1 | **支持 — 已实测** | 在真实 Web profile 中构建并运行：插件挂载、设置端点注册、并在浏览器中完成了真实的飞书授权 |
| 0.1.5-rc.2 / 0.1.6-alpha.x | 预期可用 | 本插件消费的每个 DSH 接口均读取自已安装的 0.1.5-rc.1 包，并确认在该区间内未变化；未在这些版本上实际运行 |

声明的 `peerDependencies` 接受 `0.1.x` 预发布线（npm 的 `next` 与 `alpha` 标签），并拒绝 `0.2.0` 及以后版本。

> 注意：`@deepseek-ai/dsh-*` 系列在 npm 上的 `latest` 标签仍指向过期的 `0.0.1-rc.1`，请从 `next` 或 `alpha` 安装 DSH，不要用 `latest`。

## 快速开始

需要 **Node.js ≥ 22.6**。

```bash
dsh plugin --profile web add github:REPLACE_OWNER/dsh-lark-session-monitor#v0.1.0
```

重启正在运行的 DSH Web 进程，然后刷新页面。若服务已停止，用以下命令启动：

```bash
dsh --profile web web
```

打开 **设置 → 插件 → 飞书会话监听**。按需把 `web` 换成其他 profile 名。

<details>
<summary>升级或卸载</summary>

```bash
# 升级或降级：使用 releases 页面上的任意 tag
dsh plugin --profile web add github:REPLACE_OWNER/dsh-lark-session-monitor#v0.1.0

# 卸载
dsh plugin --profile web remove dsh-lark-session-monitor
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

把 **App ID** 与 **App Secret** 填入插件设置页并保存。

### 2. 授权

点击 **开始授权**。插件会发起 OAuth 2.0 设备码流程：打开链接、在飞书中确认授权，然后回到页面点击 **我已完成授权**。

获得的用户 token 保存在 DSH 自带的 **credentials** 服务中并自动刷新。App Secret 与 token 都不会离开 Host——任何 RPC 响应都不会返回它们。

### 3. 新建监听

点击 **新建监听**，依次填写：

| 字段 | 含义 |
| --- | --- |
| **名称** | 可选，用于列表标识 |
| **会话类型** | 把选择列表筛选为 全部 / 私聊 / 群 |
| **监听会话** | 要监听的会话；可输入文字筛选 |
| **Prompt** | 置于消息正文之前一并发送 |
| **目标工作区** | 目标会话所在的工作区 |
| **目标会话** | 留空的含义见下文 |
| **启用** | 该监听是否参与轮询 |

## 投递机制

每轮轮询把新消息合成一条 prompt 投递：

```text
<你的 prompt>

[发送者] 消息正文

[发送者] 第二条消息
```

**消息渲染。** 只有可读文本会被投递——飞书原始 JSON 绝不会进入 prompt。文本消息取其正文；富文本（post）被展平；卡片取其标题与摘要；图片、文件等非文本类型转成 `[图片]` 这样的短标签。没有可投递内容的消息（空正文、成员变更通知）会被跳过，而不是投递空白。

**目标会话模式。** `目标会话` 字段决定消息去向：

| 目标会话 | 自动创建并固定绑定 | 行为 |
| --- | --- | --- |
| 选中的会话 | — | 消息累积到该会话 |
| 留空 | ✅ 勾选 | 首次投递创建会话并固定，后续消息复用 |
| 留空 | ⬜ 不勾选 | 每条消息都新建一个会话 |

**轮询。** 每个启用的监听按配置的间隔轮询，且同一监听同时只跑一轮，因此飞书响应慢也不会堆积请求。单条 prompt 最多投递 **10 条消息**，其余在本次投递完成后继续。游标只在投递成功后推进，因此投递失败会重读该批消息而非丢弃。

**目标被删除。** 会话被删除时，插件会在该监听的工作区内新建一个并更新绑定。而**任何工作区都未声明过的 sessionId** 会被视为**配置错误**并报出，而不是静默替换——那样会把消息投递到你从未选择的地方。

## 设置项说明

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| **App ID** / **App Secret** | — | 飞书应用凭据。保存时 Secret 留空表示保持不变 |
| **轮询间隔（秒）** | `30` | 轮询间隔；最小 10 秒 |
| **Prompt** | — | 每个监听各自持有自己的 prompt，投递时使用 |

所有设置持久化到 `$DSH_HOME/plugin-data/dsh-lark-session-monitor/settings.json`，采用原子写入，权限 `0600`（文件中含 App Secret）。

插件本身的可选配置，可写在 profile 的 `cordis.patch.yml` 中：

```yaml
- id: lark-session-monitor
  config:
    # 设置端点访问策略：trusted-host（默认）或 loopback。
    rpcAuthority: trusted-host
    # 在 Host 启动时就开始轮询，而不是等首次访问设置页。
    autoStart: true
    # 返回给选择列表的会话数量上限。
    maxChats: 500
```

## 隐私与安全

- **读取范围：** 仅你配置的会话，以及轮询窗口内的消息历史。不读取其他内容。
- **凭据存放：** App Secret 与用户 token 只存在 Host 上——token 在 DSH 的 credentials 服务，secret 在插件设置文件。两者都不会通过 RPC 返回。
- **外发内容：** 仅你授权的飞书 API 调用。插件没有其他网络访问，也没有遥测。
- **投递去向：** 消息文本只交给你选定的 DSH 会话，不发给其他任何地方。插件**不会**向飞书回复。
- **端点保护：** 设置端点走 DSH 已认证的 `/api` 通道，因此 DSH 的浏览器认证与 Host/Origin 信任检查先于处理器执行。设置 `rpcAuthority: loopback` 可额外要求回环 Host 与 Origin。

## 已知限制

- **仅文本。** 图片、文件、音视频以类型标签投递；插件不下载也不解读它们。
- **轮询而非推送。** 飞书没有用户身份的推送通道，因此投递延迟受轮询间隔约束。Host 离线期间的消息不会被补推（超出首次读取窗口的部分）。
- **需要用户身份。** 监听以你的身份读取，所以你看到什么它就看到什么——包括机器人永远无法加入的会话。
- **仅支持飞书（Lark）。** 不支持其他 IM 平台。

## 开发

```bash
npm install
npm run check     # 构建两端，然后运行测试
```

Host 端打包为 `lib/index.js`，浏览器端打包为 `lib/client.js`；两者均提交进仓库，因为 git 安装不会执行构建步骤（见[发布说明](#发布说明)）。

迭代时可把 checkout 链接进正在使用的 profile：

```bash
dsh plugin --profile web add /absolute/path/to/this/checkout
```

改动 Host 端后需重启 Host；仅改浏览器端刷新页面即可。

### 发布说明

构建产物 `lib/` 是**有意提交**的。git（`github:`）安装获取的是源码，除非包声明了 `prepare` 且用户在 profile 的 `pnpm-workspace.yaml` 中按哈希放行，否则不会执行构建脚本。提交构建产物使安装保持为单条命令，与其他已发布的 DSH 插件做法一致。

若你不希望提交构建产物，请提供自包含的 `prepare` 脚本，并在文档中说明用户需添加的 `allowBuilds` 条目。

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
