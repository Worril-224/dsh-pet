# 独立验收测试（verifier 自写）

本目录是独立验收员 **verifier** 为 DshPet「情感陪伴型 AI 助手」编写的验收测试，
与开发者测试（`companion-bundle/tests/`）相互独立：不复制、不引用开发者测试代码，
按 [`../../docs/SPEC.md`](../../docs/SPEC.md) 与 [`../验收标准.md`](../验收标准.md) 重新设计断言。

- **规模**：19 个测试文件 / **173 项用例，全部通过（0 失败 0 跳过）**
- **数据**：除少数「示例数据只读核对」用例外，全部使用 `fs.mkdtempSync` 系统临时目录 + 可注入假时钟，
  不联网、不发真实 QQ 消息、不修改仓库内示例数据。
- **运行**：`node 验收/verification/run-verification.mjs`（Windows 下也可用 Harness 自带 Node：`& "<node.exe 路径>" 验收/verification/run-verification.mjs`）

## 文件与覆盖

| 文件 | 用例数 | 覆盖需求编号 | 说明 |
|---|---:|---|---|
| `helpers.mjs` | — | — | 共享工具：临时目录、假时钟、引擎工厂、磁盘种子数据 |
| `feature-helpers.mjs` | — | — | 新能力共享替身：假 LLM/web/attachments/adapter/persona/memory、图片字节与伪 Response |
| `memory.test.js` | 26 | M1–M14 + 边界 + 修复复验 | 记忆字段/公式/关键词/提及/抽取/溢出/维护/七层阈值/提升/检索/压缩/调度/持久化/摘要；含 BUG-01、DEV-01 回归用例 |
| `persona.test.js` | 12 | P1–P9 + 健壮性 | 9 模块、always/on_demand 渲染、lookup、validate、个人经历、reload/坏 JSON |
| `im.test.js` | 9 | I5 | IMAdapter 契约、QQ 配置/网关帧/出站 payload、CompanionIMBridge 全链路 |
| `plugin.test.js` | 6 | P10 / I1 / I4 / Host + 修复复验 | fake ctx 挂载 preset、bundle 静态结构、工具执行、Host 维护调度、host inject 导出、source.kind 消息过滤 |
| `docs.test.js` | 4 | DEV-02 / DEV-04 / DEV-05 | SPEC 4.9 首次运行分支、SPEC 6 QQ payload 形态、README/SPEC 配置项与实现一致性 |
| `characters.test.js` | 13 | C1–C6 | 角色目录隔离、Host 逐角色维护与热纳入、预设按 characterId 解析、createCharacter 与 add/migrate 脚本、旧版单目录兼容 + 边界（非法 id/路径穿越、缺人设、重复创建、charactersDir 缺失、legacy 回退、未知 characterId） |
| `persona-import.test.js` | 12 | C6 | 8+1 人设卡模块映射与 activation、style 推导、ready/pending、validate/渲染安全、错误输入拒绝、CLI 导出/创建/归档、示例奥菲莉亚产物只读核对 |
| `qq-bot.test.js` | 15 | QC1–QC7 | 假 socket/假 LLM/假适配器：OneBot 11 事件解析、发送动作与 echo/超时/断线重连/token 不泄漏、白名单/allowGroups、回复引擎、QQ Host 端到端、配置与会话存储、安装模板与示例状态文件核对 |
| `qq-channel.test.js` | 4 | VC1–VC4（QQ 官方通道） | 官方配置/图片帧/msg_seq payload；假 fetch + 假 WebSocket 下 token→gateway→Identify→收消息→被动回复；双通道切换、凭据持久化、Secret 不泄漏；通道路由与 openid 批准 |
| `qq-features.test.js` | 16 | QW1–QW3 / QB1–QB2 / QV1–QV4 | 联网搜索意图/注入（来源不含 URL）/失败降级；气泡拆分/群聊仅首条 @；image/mface/face 解析、图片类型与大小、附件 refs、多模态 image block、视觉失败降级 |
| `life-plan.test.js` | 13 | QL1–QL4 | 计划 JSON/坏 JSON/抛错/web 降级 → 草稿；到期 + 6h 宽限；markEventSent；主动私聊多气泡/幂等/兜底；当天补齐；Host 维护集成 |
| `seed-memories.test.js` | 10 | QM1–QM3 | occurredAt 估层/兼容/渲染与总览列；seedMemories 去重/幂等/分层/importance/force；示例记忆只读核对（30 条）、时间线脚本解析 20 条、CLI dry-run/`--write`/重复导入/`--force` |
| `immersive-persona.test.js` | 10 | PE1–PE4 / PL1–PL3 / PP1 | 全字段无 AI/技术层词、模块改写、validate+渲染约 8,900 字、10–300 字与主动展开、人设文件不被覆盖、示例记忆 30 条与 pending 机制回归 |
| `reasoning-effort.test.js` | 3 | RL1–RL3 | 聊天模型可配置（模板不锁死）、reply-engine resolveRoute 三条路径（config low 覆盖 max、显式 max 仍尊重、无静默回落）、README/SPEC/验收标准文档一致、persona 无配置污染 |
| `dialogue-style.test.js` | 5 | DL1–DL5 | 描写格式、不以服务性追问收尾、禁止「记下来」类汇报、禁止复读/直抒心情、去助手腔；示例与兼容性、记忆不变 |
| `memory-compaction.test.js` | 5 | LM1–LM5 | 背景故事不压缩；非背景 L3 起每次 ≤75%；上浮不扩张；compaction 元数据/持久化/重启可读；配置可覆盖；示例数据只读核对 |
| `conversation-memory.test.js` | 5 | TM1–TM5 | 完整双人对话入同一条短期话题记忆（含 Host autoExtract:false）；30 分钟话题窗；单话题 1w 压缩；短期 5w 溢出；维护保留话题与长期完整正文 |
| `image-style.test.js` | 3 | IS1–IS3（固定二次元画风） | prompt_en 以固定画风开头；写实/3D/摄影描述清除与风格前缀幂等；生成服务边界强制画风、负面词去重 |
| `web-fetch.test.js` | 2 | QW4–QW5 | 网页正文抓取/HTML 清洗/注入；fetch 不可用或失败时退回标题摘录，不破坏回复 |
| `run-verification.mjs` | — | — | 统一入口（收集本目录全部 `*.test.js` 后 `node --test`） |

## 约定与判定

- 测试名称以需求编号开头（如 `M8: ...`、`P9 边界: ...`、`C2: ...`、`QC7 ...`），便于对照验收矩阵。
- 首轮验收中发现的实现 bug 以「偏差（实现 bug）」命名的失败用例明确暴露，不迁就实现；修复后对应用例改为「修复复验」并全部通过
  （BUG-01 / DEV-01 / DEV-03 / DEV-05），新增 DEV-02 / DEV-04 文档一致性检查与 RISK-01 消息过滤回归用例。
- 公开版相对原项目的调整（详见 `../验收报告.md` 第五节）：
  - 原 `story-canon.test.js`（依赖一次性脚本 `scripts/apply-ophelia-story-canon.mjs` 与私有 48 条故事数据集）与
    `voice-style.test.js`（依赖已移除的 `adjust-persona-dialogue-style.mjs`）**已移除**；
  - 其余依赖私有产物的用例改写为**示例数据（30 条虚构记忆，短期 8 + 长期 22）**断言，断言强度不降低；
  - 真实 QQ 号/绝对路径常量统一替换为示例值（`123456789` / `10001`）与数据目录推导。
