# companion-data · 示例角色数据

> **这是随仓库发布的示例数据，不是任何人的真实记录。**
> 角色「奥菲莉亚」是虚构人物；本目录下的对话、记忆、日程均为虚构的日常片段，不对应任何真实用户、真实聊天记录或真实经历。
> 真实运行时数据保存在本机的运行数据目录里（默认 `~/.dsh/dsh-pet/companion-data`，可用环境变量 `DSH_PET_DATA_DIR` 覆盖），不会随仓库提交。

## 这个目录有什么

- `characters/ophelia/`：一个完整的示例角色，展示 9 模块人设、说话风格、七层长期记忆 + 短期记忆的结构与字段。
- `*.example.json`：需要用户自己填写的配置模板（QQ 通道、B 站账号、每日日程等）。复制成真实文件名后再填写。
- 真实运行时产物（`status.json`、`sessions.json`、`day-plan-YYYY-MM-DD.json` 等）在运行时生成，已在 `.gitignore` 中忽略。

## 目录结构

```
companion-data/
└── characters/
    └── ophelia/                        # 角色 id（目录名 = character.json 的 id）
        ├── character.json              # 角色元数据：id / name / role / order / 时间戳
        ├── assets/
        │   └── ophelia-reference.jpg   # 外观参考图（示例素材）
        ├── persona/
        │   └── persona.json            # 9 模块人设 + 说话风格 + 示例对话（虚构）
        ├── memory/                     # 记忆引擎数据（示例规模：30 条）
        │   ├── meta.json               # 维护记录、序列号
        │   ├── short-term.json         # 短期记忆（示例 8 条）
        │   ├── long-term/
        │   │   └── layer-1.json … layer-7.json   # 七层长期记忆（示例合计 22 条）
        │   ├── index.json              # 关键词 / 分类 / 层级索引
        │   ├── events.jsonl            # 记忆事件流（每行一条 JSON）
        │   └── 记忆总览.md             # 由引擎自动生成的可读总览
        ├── qq/
        │   ├── channel.example.json    # QQ 通道模板 → 复制为 channel.json
        │   ├── qqbot.example.json      # QQ 官方机器人凭据模板 → 复制为 qqbot.json
        │   ├── status.example.json     # 连接状态示例 → 运行时生成 status.json
        │   └── sessions.example.json   # 通话历史示例 → 运行时生成 sessions.json
        ├── bilibili/
        │   └── account.example.json    # B 站账号模板 → 复制为 account.json
        └── life/
            └── day-plan.example.json   # 每日日程示例 → 运行时生成 day-plan-YYYY-MM-DD.json
```

## 示例文件 vs 运行时文件

`.gitignore` 只放行 `*.example.json`，真实文件名留给运行时生成或用户自己填写：

| 仓库中的示例文件 | 实际运行使用的文件 | 是否被 .gitignore 忽略 | 说明 |
| --- | --- | --- | --- |
| `qq/channel.example.json` | `qq/channel.json` | 是 | 通道选择（NapCat / 官方机器人）与官方机器人凭据 |
| `qq/qqbot.example.json` | `qq/qqbot.json`（或并入 `channel.json` 的 `qqbot` 字段） | 是 | appId / clientSecret |
| `qq/status.example.json` | `qq/status.json` | 是 | 连接状态，运行时自动写入 |
| `qq/sessions.example.json` | `qq/sessions.json` | 是 | 每个 QQ 用户的最近对话历史，运行时自动写入 |
| `bilibili/account.example.json` | `bilibili/account.json` | 是 | B 站 Cookie / UID，含登录凭证 |
| `life/day-plan.example.json` | `life/day-plan-YYYY-MM-DD.json` | 是 | 每日日程，运行时按天生成 |
| — | `qq/reply-model.json` | 是 | 面板里切换的聊天模型 |
| — | `memory/long-term/*.tmp-*` | 是 | 记忆写入的临时文件 |
| — | `images/generated/*` | 是 | 运行时生成的图片 |

## 如何替换成自己的角色

1. **把示例数据复制到运行数据目录**（目标目录非空时会拒绝覆盖）：
   ```bash
   node scripts/init-data.mjs
   # 或指定目录：node scripts/init-data.mjs --target <数据目录>
   ```
   `init-data.mjs` 只做复制；之后请在运行数据目录里改，不要改仓库里的示例数据本身。

2. **新建一个角色目录**：
   - 复制 `characters/ophelia` 为 `characters/<你的角色id>`（id 用小写字母、数字、连字符）。
   - 修改 `character.json`：`id` 必须与目录名一致，`name` / `role` / `description` / `order` 按需要改。
   - 或直接用脚本：`node scripts/add-character.mjs --id <id> --name <名字>`。

3. **改人设**：编辑 `persona/persona.json`。9 个模块的 id 与用途见下表；说话风格在 `speech_style` 模块与顶层 `style` / `examples` 字段里。
   修改 `persona.json` 后重启一次 Harness 生效；建议先备份（本仓库不保留 `persona.before-*.json` 这类自动备份，属于个人数据）。

4. **重建记忆**（可选）：示例记忆是虚构的，删掉 `memory/` 下的 JSON 后由引擎重新生成即可；也可以参考 `docs/数据修改指南.md` 手动构造。人设里的 `personalHistory` 可用 `scripts/seed-persona-memories.mjs` 导入为长期记忆种子。

5. **配置 QQ 通道**：
   - NapCat（本地 OneBot 11）：在插件配置里填 `botQQ` 与 `allowUsers` 白名单；`channel.json` 里把 `channel` 设为 `"napcat"`。
   - QQ 官方机器人：把 `qqbot.example.json` 复制为 `qqbot.json`，填入自己的 `appId` / `clientSecret`；`channel.json` 里把 `channel` 设为 `"qqbot"`。
   - 详见 `docs/QQ接入-NapCat.md`、`docs/QQ接入-官方机器人.md`。

6. **配置 B 站（可选）**：把 `bilibili/account.example.json` 复制为 `account.json`，填入自己的 Cookie（至少包含 `SESSDATA` 与 `bili_jct`）、主人 UID 与昵称，再把 `commentEnabled` 改为 `true`。详见 `docs/B站观看.md`。

7. 重启 Harness，在 Web GUI 新建会话即可看到角色。

### 人设模块

| 模块 id | 名称 | 激活方式 | 内容 |
| --- | --- | --- | --- |
| `role_definition` | 角色定义 | always | 身份、核心驱动、与用户的关系边界 |
| `speech_style` | 说话风格 | always | 称呼、语气、长度、描写格式、禁用写法 |
| `herself` | 她自己 | on_demand | 性格、喜恶、小毛病、情感表达 |
| `memory_and_promises` | 记忆和承诺 | always | 记忆原则与承诺原则 |
| `rules` | 规则 | always | 安全边界、诚实、隐私、能力边界 |
| `appearance` | 外貌 | on_demand | 外观与随身物 |
| `other_ai_characters` | 其他同僚 | on_demand | 同僚设定与对外态度 |
| `identity` | 身份设定 | on_demand | 世界设定、组织、职责 |
| `personal_history` | 个人经历 | on_demand | 虚构故事线（示例数据，不对应真实经历） |

## 哪些文件不要提交

- **任何真实凭据**：`qq/channel.json`、`qq/qqbot.json`、`qq/reply-model.json`、`bilibili/account.json`、`.env`。
- **任何真实聊天 / 记忆 / 日程**：`qq/sessions.json`、`qq/status.json`、`life/day-plan-*.json`、`memory/**` 里由真实对话生成的内容、`images/generated/*`。
- 本仓库的 `*.example.json` 只是模板：密钥字段必须留空或使用占位符；示例 QQ 号（`123456789` / `10001`）、示例 appId（`1234567890`）、示例 B 站 UID（`12345678`）都不是真实账号。

> ⚠️ **把真实聊天记录、真实记忆或真实账号凭据提交到公开仓库，等于向全世界公开隐私。**
> 提交前请全局搜索自己的 QQ 号、B 站 UID、Cookie 关键字（`SESSDATA`、`bili_jct`）、真实姓名与本机绝对路径。

## 数据格式速查

- 时间：ISO 8601 带时区，例如 `2026-11-11T20:12:00+08:00`；`events.jsonl` 与 `sessions.example.json` 中的 `at` 为毫秒时间戳。
- 短期记忆 `short-term.json`：`items[]`，每条含 `id / content / summary / keywords / category / mentionCount / importance / clarity / layer / metadata.segments` 等字段。
- 长期记忆 `long-term/layer-N.json`：`layer` 为 1–7，数字越大越深（越久未被提及）；每条含 `history[]` 记录上浮 / 下沉经过。
- `index.json`：`keywords`（关键词 → 记忆 id）、`categories`（分类 → 记忆 id）、`layers`（各层条数）。
- `events.jsonl`：每行一条事件（`maintenance` / `memory_created` / `layer_moved` / `memories_mentioned` / `memory_reindexed` 等）。
