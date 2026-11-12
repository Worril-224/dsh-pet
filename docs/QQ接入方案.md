# 把「奥菲莉亚」接入 QQ · 方案与操作指引

> **2026-11-11 更新：通道 A（QQ 官方机器人）已实现并可切换。**
> - 在 Web UI 左侧「模型」→「QQ 接入通道」里选择 NapCat 或 QQ 官方机器人；
> - 官方通道需要 QQ 开放平台的 AppID / AppSecret，WebSocket 接收，不需要公网 Webhook；
> - 官方通道只能被动回复，主动生活分享/输入状态会自动跳过；
> - 操作步骤见 [docs/QQ接入-官方机器人.md](QQ接入-官方机器人.md)。

> **NapCat / OneBot 11 通道（通道 B）已实现并安装。**
> - 示例配置：机器人 QQ `123456789`，主人 QQ（白名单）`10001`，OneBot WS `ws://127.0.0.1:3001`；
> - 实现：`companion-qq` Host 插件（`lib/im/onebot.js` + `lib/im/reply-engine.js` + `lib/qq-host.js`）；
> - 剩余步骤：在本机安装并登录 NapCat → 开启 OneBot 11 WS 服务 → 重启 Harness 即自动连接。
> - **操作手册：[docs/QQ接入-NapCat.md](QQ接入-NapCat.md)**（本文保留为方案对比与设计说明）。

> 原始现状说明：代码里的 IM 接口层（`companion-bundle/lib/im/`）已完成——统一消息结构、QQ 网关事件解析、出站 payload、`CompanionIMBridge` 入站→记忆→上下文→回复派发，均有测试覆盖（I5）。
> 本文给出两条可选通道与实现路线。

## 1. 整体数据流

```
你的 QQ / 群
   │ 消息
   ▼
QQ 通道（二选一）
   A. QQ 开放平台官方机器人：WebSocket 网关 / Webhook（AppID + AppSecret + Token）
   B. NapCat / OneBot 11：本地 QQ 客户端桥（HTTP / WebSocket，无需开放平台审核）
   │
   ▼  companion-qq 插件（待实现，Host 侧常驻）
   ├─ 凭据校验 / access_token 刷新 / 心跳 / 断线重连 / 去重 / 频率限制
   ├─ 白名单（默认只允许主人）与用户映射
   ▼
CompanionIMBridge（已有）
   ├─ memory.ingestMessage(...)      # 写入奥菲莉亚的独立记忆
   └─ context = { personaSection, memoryDigest }   # 人设 + 记忆摘要
   ▼
回复生成（二选一，见第 4 节）
   A. Host 插件内直接调用 ctx.llm（带人设 + 记忆 + persona_lookup/memory_note 工具循环）
   B. 为每个 QQ 用户创建/续接 Harness companion 会话（完整工具与 UI 记录）
   ▼
CompanionIMBridge.dispatchReply(outbound)
   └─ QQBotAdapter.send() / OneBotAdapter.send()   # 真实发送到 QQ
```

## 2. 通道 A：QQ 开放平台官方机器人（推荐，合规）

### 2.1 你需要准备

1. 用 QQ 账号登录 [QQ 开放平台](https://q.qq.com/)，注册开发者（个人或企业均可）。
2. 创建「机器人」应用，记录 **AppID**、**AppSecret**、**Token**（机器人 Token，用于鉴权）。
3. 在开放平台配置机器人可用的场景与权限：
   - 私聊（C2C）：需要在沙箱/能力申请中开通，部分能力需审核或白名单；
   - 群聊：把机器人添加进群，群主授权后，仅 @机器人 的消息会推送给 bot（`GROUP_AT_MESSAGE_CREATE`）；
   - 频道（Guild）：如需要，可另开 `AT_MESSAGE_CREATE` 事件；
   - 事件订阅：勾选 `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE`（对应 intents 的 GROUP_AND_C2C_EVENT）。
4. 选择消息接收方式：
   - **WebSocket**（推荐，不需要公网 IP）：`wss://api.sgroup.qq.com/websocket`（沙箱 `wss://sandbox.api.sgroup.qq.com/websocket`）；
   - Webhook：需要公网可访问 HTTPS 回调地址（本机无公网时需内网穿透）。
5. 凭据不要贴在聊天里，建议放在：
   - 环境变量 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET` / `QQ_BOT_TOKEN`，或
   - `<repo>\companion-data\qq-bot.json`（本地文件，不进 Git；插件只读取）。

### 2.2 官方 API 要点（我们的适配器已按此实现消息解析）

- 获取 access_token：`POST https://bots.qq.com/app/getAppAccessToken`，body `{ appId, clientSecret }`；返回 `access_token` / `expires_in`，需要缓存并在过期前刷新。
- 鉴权头：`Authorization: QQBot <access_token>`；沙箱域名 `https://sandbox.api.sgroup.qq.com`。
- WebSocket：先 `GET /gateway` 拿地址 → 连接 → 收 `op=10 hello` 后发 `op=2 identify`（`token: "QQBot <机器人Token>"`，`intents` 含 GROUP_AND_C2C_EVENT）→ 按 `heartbeat_interval` 发 `op=1` 心跳（带 `last seq`）→ 断线用 `op=6 resume`。
- 收消息：`C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` / `AT_MESSAGE_CREATE`（我们的 `parseQQGatewayFrame` 已处理这三类，并会去掉群聊开头的 `@` 占位）。
- 发消息：
  - 私聊：`POST /v2/users/{openid}/messages`，body `{ content, msg_type: 0, msg_id? }`
  - 群聊：`POST /v2/groups/{group_openid}/messages`
  - 频道：`POST /channels/{channel_id}/messages`
  - 我们的 `buildQQReplyPayload` 已生成 `{ endpoint, method, body }`。
- 注意：QQ 机器人 API 有频率限制；同一用户短时间多条消息需合并/排队；`msg_id` 可用于被动回复。

## 3. 通道 B：NapCat / OneBot 11（无需开放平台审核，但有封号风险）

适合「先在自己 QQ 上跑通、不想走开放平台审核」：

1. 安装 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)（或 Lagrange 等 OneBot 11 实现），登录你的 QQ 账号（建议小号；主号有封号风险）。
2. 开启 OneBot 11 的 **WebSocket 服务端**（如 `ws://127.0.0.1:3001`）或 HTTP API。
3. 事件格式与 QQ 官方完全不同（`post_type=message`、`user_id`、`group_id`、`raw_message` 等），发送用 `send_private_msg` / `send_group_msg` action。
4. 我们新增一个 `OneBotAdapter` 实现同一套 `IMAdapter` 接口即可（消息解析 + 发送），约百来行；记忆/人设/回复桥完全复用。
5. 风险：非官方协议，违反 QQ 用户协议时可能被限制/封号；仅建议自动化小号。

## 4. 由谁生成回复（关键缺口）

QQ 网关本身只负责收发消息；回复必须由「奥菲莉亚」这个人设 + 记忆来生成。两种实现：

### 4.1 方案 A（推荐 v1）：Host 插件内直接调用模型（不依赖打开 Harness 会话）

- 在 Host 插件里用 `ctx.llm` 按当前默认模型（或显式配置 provider/model）调用；
- system prompt = `persona.renderPersonaSection()` + `memory.renderDigest()`（与 Harness 内聊天完全一致）；
- 用现有的 5 个陪伴工具做一轮轻量工具循环（`persona_lookup` / `memory_recall` / `memory_note` / `memory_status` / `persona_status`），预算小、延迟低；
- 入站消息写记忆、回复成功后可选记录事件；
- 优点：不依赖 Harness 窗口/会话，重启 Harness 后 bot 仍在线；适合长期挂机；
- 缺点：QQ 对话不会出现在 Harness 的会话列表里（如需要可后续加）。

### 4.2 方案 B：把 QQ 消息转发进 Harness 会话（完整工具、UI 可见）

- 每个 QQ 用户映射到一个 companion 会话（sessionId → userId），通过插件创建/续接 agent，把消息注入 inbox，监听 assistant 输出后回发 QQ；
- 优点：与网页端体验、工具、轨迹完全一致；群聊可复用同一角色；
- 缺点：需要管理会话生命周期、并发与错误重试；Harness 不运行时 bot 不可用；实现与验收成本更高。

**建议：先做方案 A 跑通「私聊主人」闭环，稳定后再评估方案 B。**

## 5. 多个 QQ 用户时：记忆必须按用户隔离（重要）

当前记忆设计是「每个角色一份独立记忆」。如果 QQ 机器人允许很多人私聊，或群里有多个成员 @ 她，**所有人的记忆会混进奥菲莉亚同一份记忆库**，既不隐私也会串线。

三个选择：

| 模式 | 行为 | 适用 |
|---|---|---|
| **只服务主人（推荐 v1）** | 白名单：只有你的 QQ openid/QQ 号可用；其他消息忽略或礼貌拒绝 | 个人情感陪伴，最安全 |
| 群聊仅响应主人 | 群里只处理你 @ 她的消息；其他人 @ 忽略 | 想在群里用 |
| 多用户独立记忆 | 每个 QQ 用户一个记忆线：`characters/ophelia/users/<hash>/memory`（人设共享、记忆隔离），需要扩展 dataDir 分片与会话映射 | 想让朋友也能用 |

v1 建议默认「只服务主人」，同时在配置里预留 `allowUsers` / `memoryScope: 'owner' | 'per-user'`。

## 6. 实现清单

| 文件/能力 | 内容 |
|---|---|
| `companion-bundle/lib/im/qq-gateway.js` | access_token 获取与刷新、WebSocket 连接/心跳/重连/resume、事件分发到 `QQBotAdapter.handleGatewayFrame`、发送 |
| `companion-bundle/lib/im/onebot.js`（可选） | OneBot 11 适配器（HTTP/WS 收发），复用同一套桥接 |
| `companion-bundle/lib/im/reply-engine.js` | 方案 A：ctx.llm 调用 + 人设/记忆注入 + 工具循环；方案 B：Harness 会话桥 |
| `lib/host.js` 或新 Host 行 `companion-qq` | 凭据配置、白名单、用户映射、去重、限流、日志脱敏；无凭据时保持禁用 |
| bundle patch 新增一行（默认 disabled） | `companion-qq` 配置项：provider/model/凭据环境变量名/allowUsers/memoryScope |
| 测试 | 假 WS/HTTP 服务下的 token 刷新、心跳、事件解析、发送、重连、白名单、去重、限流；不依赖真实 QQ |
| 验收 | 单元/集成新增 QC1–QC6；真实联调由你提供凭据后在本地跑 |

## 7. 部署前需要确认的信息

1. **走哪条通道**：QQ 开放平台官方机器人（推荐）/ NapCat OneBot / 两条都要？
2. **使用场景**：只私聊你自己 / 群聊 @ / 两者都要？
3. **是否已有凭据**：QQ 开放平台 AppID/AppSecret/Token？NapCat 是否已安装？
4. **回复生成**：先按方案 A（独立在线）还是直接上方案 B（进 Harness 会话）？
5. **多用户**：v1 是否只服务主人（推荐）；未来要不要多用户独立记忆？
6. **模型与额度**：bot 直接用 Harness 当前默认模型是否可以？

## 8. 安全与合规提醒

- 凭据只进环境变量或本地配置文件，不入库、不发聊天；日志里做脱敏。
- 官方 QQ 机器人需遵守平台规则（不得主动私聊骚扰、频率限制、敏感内容拦截）；情感陪伴场景建议只服务于你自己/白名单用户。
- NapCat 等非官方协议存在账号风险，建议小号。
- 无论哪种通道，回复仍应遵守奥菲莉亚人设里的规则：AI 身份披露、不发链接、安全边界、不诱导依赖。

---

**下一步**：按你的通道与场景选择准备好凭据（NapCat 或开放平台），按 [docs/QQ接入-NapCat.md](QQ接入-NapCat.md) 或 [docs/QQ接入-官方机器人.md](QQ接入-官方机器人.md) 完成接入；验收项见 `验收/` 报告。
