# @local/dsh-companion

DeepSeek Harness 本地 bundle：情感陪伴型 AI 助手（人设 + 七层长期记忆 + QQ 通道 + Web UI 模型面板）。

本包为公开模板：不含任何机器相关的绝对路径、真实 QQ 号或凭据。安装后按 `cordis.patch.yml`
里的注释示例，把角色目录、机器人 QQ、白名单和（可选）ComfyUI 路径改成你自己的即可。

## 数据目录（可移植）

默认数据根目录为 `~/.dsh/dsh-pet/companion-data`（`~` 是当前用户主目录），可用环境变量覆盖：

```bash
# 可选：改到自定义目录（bash / zsh）
export DSH_PET_DATA_DIR=/path/to/companion-data
```

```powershell
# 可选：改到自定义目录（Windows PowerShell）
$env:DSH_PET_DATA_DIR = "D:\path\to\companion-data"
```

- 角色根目录：`<DSH_PET_DATA_DIR>/characters`（未设置环境变量时是 `~/.dsh/dsh-pet/companion-data/characters`）；
- 每个角色一个子目录，人设（`persona/persona.json`）与记忆（`memory/`）完全隔离；
- Host / Preset / characters / memory 四个模块共用同一套默认路径推导规则，导出的
  `DEFAULT_DATA_DIR` / `DEFAULT_CHARACTERS_DIR` 可在代码中直接复用。

`cordis.patch.yml` 里 `charactersDir` 默认留空（注释示例），留空即使用上面的默认目录；
需要自定义时取消注释并填绝对路径。

## 组成

- 包入口 `lib/host.js`：Host 插件，扫描角色根目录并逐角色调度每日 04:00–06:00 记忆维护。
- 子路径 `./preset`（`lib/preset.js`）：角色预设作用域插件（`characterId` + `charactersDir` → 该角色 dataDir），负责人设注入、记忆摘要注入、陪伴工具、用户消息写入记忆。
- `lib/characters.js`：多角色（方案 A）——角色目录扫描/创建、角色元数据、预设 YAML 片段生成。
- `lib/memory/`：短期 + 七层长期记忆引擎（中文 JSON 持久化，按角色目录隔离）。
- `lib/persona/`：9 模块人设服务（always / on_demand，按角色目录隔离）；`lib/persona/import.js` 支持从外部 8+1 人设卡导入。
- `lib/im/`：IM 适配层——QQ 官方机器人（`qq-bot.js`：access_token、WebSocket 网关、心跳/Resume、被动回复、富媒体）与 OneBot 11（NapCat，`onebot.js`），以及 QQ 回复引擎 `reply-engine.js`。
- `lib/qq-host.js`：companion-qq Host 插件（`exports ./qq`）——接入通道切换、白名单、记忆写入、会话历史、状态文件，随 Harness 常驻。
- `lib/bilibili/`、`lib/life/`、`lib/imagegen/`：B站观看/分享、每日生活事件、ComfyUI 生图。生图画风固定为二次元动漫（线稿 + 赛璐璐上色），提示词强制以固定动漫风格前缀开头并排除写实/3D/摄影。
- `client.js` + `lib/model-control.js` + `lib/qq-model-routes.js` + `lib/qq-channel-routes.js`：Web UI 左栏「模型」面板（模型切换 + QQ 接入通道）。

## 安装

1. 把本目录放到你愿意长期保存的位置（不要放在临时目录）。
2. 打开 `cordis.patch.yml`，按注释改成你自己的配置（最少需要）：
   - `companion-qq.botQQ`：你的机器人 QQ（模板里是示例值 `123456789`）；
   - `companion-qq.allowUsers`：允许对话的主人 QQ（模板里是空数组，必须填，否则 QQ 通道不会启动）；
   - `companion-qq.accessToken`：NapCat 的 WS token（没有就留空，与 NapCat 保持一致）；
   - `companion-qq.qqbot`：用 QQ 官方机器人时填 AppID / AppSecret。
   不填 `charactersDir` 时使用上面的默认数据目录；改成自定义路径时取消对应注释即可。
3. 用 Harness 的 `plugin_manager` 安装本目录：

   ```
   plugin_manager({ action: 'install_bundle', target: '/absolute/path/to/companion-bundle' })
   ```

4. 重启 Harness 后生效；之后在 Web UI 左侧「模型」面板里切换模型 / 通道。
   如果安装之后又改了 `cordis.patch.yml`，重新执行一次 `install_bundle`（或重启 Harness）即可让改动生效。

角色数据（人设、记忆、B站 Cookie、QQ 凭据）都在数据目录里，**不要提交到 Git**。

## Web UI 模型面板

安装本 bundle 后，左侧图标栏会出现「模型」入口，点开后可以随时切换：

1. **快捷切换**：把当前模型、插件配置里的模型、手动保存过的模型，以及 Harness 已注册的模型排成按钮，点一下立即生效。
2. **QQ 聊天模型**：只影响 `companion-qq` 的文字回复。切换会写入
   `<角色目录>/qq/reply-model.json` 并立即生效，不重载插件、不断开 QQ；
   「恢复插件配置」会删除该文件，回到 `cordis.patch.yml` 里的 `provider` / `model`
   （若 patch 里没有配置，则使用 Harness 默认模型）。
3. **Harness 默认模型**：写入 Harness 的默认模型选择，用于 Web UI 新会话，以及记忆整理、生活事件、B站总结、生图提示词等工具调用。
4. **手动输入新模型**：直接填写 `provider` 和模型 id；「保存并应用」会把这条写进
   `<dataDir>/models-presets.json`（默认 `~/.dsh/dsh-pet/companion-data/models-presets.json`），
   重启 Harness 或换浏览器后仍会出现在快捷切换里。

模型目录来自 Host 的 `ctx.llm.listProviders()` / `listModels()`；一个本地端点不可达不会影响其他提供方的列表。Host 路由在 `webServer` 服务可用后注册（`attachModelRoutes` / `attachQQModelRoutes` / `attachQQChannelRoutes`），因此重启 Harness 后不会因为插件先于 webServer 激活而丢失。

## QQ 接入通道

面板顶部「QQ 接入通道」可以在两种方式之间切换，切换会重建 QQ 连接，不需要重载 Harness：

- **NapCat / OneBot 11**：本地通道，功能完整（主动生活分享、输入状态等）。需要本机运行 NapCat，并在
  `cordis.patch.yml` 里填 `botQQ` / `allowUsers` / `accessToken`。
- **QQ 官方机器人**：走 QQ 开放平台，不再需要 NapCat。需要填写 AppID / AppSecret，可选沙盒环境。官方平台自 2025-04 起下线主动消息，因此只能被动回复；主动生活分享与「输入状态」在官方通道会自动跳过。

保存的通道和凭据写入 `<角色目录>/qq/channel.json`（例如
`~/.dsh/dsh-pet/companion-data/characters/ophelia/qq/channel.json`），重启 Harness 后仍然生效；
该文件含 AppSecret，不要提交到 Git。`accessToken` 同理。

QQ 官方机器人按 **openid** 识别用户，和 NapCat 的 QQ 号白名单不同。第一次私聊时：
1. 面板「待批准的 QQBot 用户」会出现该 openid；
2. 机器人只回一条固定提示，不会回复人设/记忆内容；
3. 点「批准」后，这个 openid 才进入回复流程。

面板路由：

- `GET /dsh-companion/models/catalog`
- `GET|POST /dsh-companion/models/default`
- `GET|POST /dsh-companion/models/presets`
- `GET|POST /dsh-companion/qq/model`
- `POST /dsh-companion/qq/model/reset`
- `GET|POST /dsh-companion/qq/channel`
- `POST /dsh-companion/qq/channel/allow`
- `POST /dsh-companion/qq/channel/deny`

## 本地生图（可选）

`lib/imagegen/` 默认连接 `http://127.0.0.1:8188` 上已经运行的 ComfyUI；工作流模板在 `data/comfy/`。
如果需要插件自动拉起 ComfyUI（comfy-cli），在 `cordis.patch.yml` 里配置 `comfyCliPath` /
`comfyWorkspace`，或用环境变量 `COMFY_CLI_PATH` / `COMFY_WORKSPACE` 提供；不配置则只连接已运行的实例。

## 测试

```bash
node scripts/run-tests.mjs all
```

## License

MIT
