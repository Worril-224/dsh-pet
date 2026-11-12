# scripts — 工具脚本

这里的脚本都是可选的辅助工具，不是插件运行所必需。插件本体在 [`../companion-bundle`](../companion-bundle)，
示例数据在 [`../companion-data`](../companion-data)。

## 数据目录约定

所有脚本的默认数据目录都是：

```
$DSH_PET_DATA_DIR  或  ~/.dsh/dsh-pet/companion-data
```

（Windows 上即 `C:\Users\<你>\.dsh\dsh-pet\companion-data`。）
优先用环境变量 `DSH_PET_DATA_DIR` 覆盖；大部分脚本另外提供 `--data-dir` / `--characters-dir` 参数。

## Node 版本

用系统 `node`（18+）即可；如果 Node 不在 PATH，可以用 Harness 自带的 Node 执行，例如：

```powershell
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" scripts/init-data.mjs
```

下文示例统一写成 `node scripts/xxx.mjs`。

## 脚本一览

| 脚本 | 用途 | 示例 |
|---|---|---|
| `init-data.mjs` | 把仓库自带的 `companion-data` 复制到数据目录，完成首次初始化 | `node scripts/init-data.mjs`；覆盖已有数据：`node scripts/init-data.mjs --force` |
| `run-tests.mjs` | 跑 companion-bundle 的测试（`memory` / `persona` / `life` / `integration` / `unit` / `all`） | `node scripts/run-tests.mjs all` |
| `add-character.mjs` | 新增一个独立角色（独立人设 + 独立记忆），并打印要写入 bundle 的预设片段 | `node scripts/add-character.mjs --id alice --name 爱丽丝` |
| `import-persona.mjs` | 从外部「人设卡 JSON」导入角色（支持 8+1 模块人设卡） | `node scripts/import-persona.mjs --source ./persona.json --id alice --name 爱丽丝` |
| `migrate-to-characters.mjs` | 把旧版单目录（`persona/` + `memory/`）迁移成方案 A 的角色目录 | `node scripts/migrate-to-characters.mjs --id linglan --name 铃兰 --copy` |
| `report-character-status.mjs` | 生成某个角色的现状报告（人设模块 / 记忆 / 回复链路） | `node scripts/report-character-status.mjs --character ophelia` |
| `seed-persona-memories.mjs` | 从角色人设的「个人经历」按时间线导入记忆（默认 dry-run） | `node scripts/seed-persona-memories.mjs`；写入：`node scripts/seed-persona-memories.mjs --write` |

所有脚本都支持 `--help` 查看参数。

## NapCat 自启 / 启动脚本（可选，仅 Windows）

只有想用 QQ 通道（NapCat / OneBot 11）并希望 NapCat 开机常驻时才需要这些脚本。
它们不会随仓库分发 NapCat 本体，需要你另外下载 NapCat Shell，默认放在
`<仓库目录>\NapCat.Shell`；也可以用 `-NapCatDir` 参数或 `DSH_PET_NAPCAT_DIR` 环境变量指定其它位置。

机器人 QQ 号不写死在脚本里，通过参数传入，示例值 `123456789` 只是占位：

```powershell
# 首次安装自启（双击 bat 会在 UAC 里确认，也可以带上你的机器人 QQ）
scripts\install-napcat-autostart-admin.bat 123456789

# 手动以管理员身份启动 NapCat（-q = 用已保存的快速登录记录登录）
scripts\start-napcat-admin.bat 123456789

# 卡住时重启 NapCat（杀进程树后再 -q 启动）
wscript scripts\restart-napcat-admin.vbs 123456789
```

| 脚本 | 用途 |
|---|---|
| `start-napcat-admin.bat` / `.vbs` | 以管理员身份启动 NapCat（`launcher.bat -q <QQ>`），可选参数为机器人 QQ |
| `restart-napcat-admin.vbs` | 结束卡住的 NapCat/QQ 进程树后重新以管理员身份启动，可选参数为机器人 QQ |
| `install-napcat-autostart-admin.bat` / `.vbs` | 一键安装「登录时最高权限运行」的计划任务（隐藏窗口守护），可选参数为机器人 QQ |
| `install-napcat-autostart.ps1` | 上面两者的 PowerShell 实现：创建/卸载计划任务（`-Uninstall`）、立即启动（`-StartNow`）、指定 `-BotQQ` / `-NapCatDir` |
| `napcat-autostart.ps1` | 后台守护：NapCat 不在时启动一次，卡死时受控恢复；日志在 `<NapCatDir>\logs\autostart.log`，创建 `<NapCatDir>\STOP_AUTOSTART.flag` 可让它退出 |
| `napcat-autostart-hidden.vbs` | 由计划任务调用，隐藏窗口启动守护，并把机器人 QQ 透传给 `napcat-autostart.ps1` |
| `启动NapCat管理员.vbs` / `安装NapCat管理员自启.vbs` | 中文名快捷入口，内容只是转发到同目录的英文名 `.vbs` |

说明：`.vbs` / `.bat` 内容为纯 ASCII（Windows 脚本宿主对非 ANSI 编码支持不一致，避免中文乱码）；
PowerShell 脚本为 UTF-8 with BOM，可直接在 Windows PowerShell 5.1 下运行。

## 安全提醒

- `init-data.mjs --force`、`migrate-to-characters.mjs`、`import-persona.mjs --overwrite` 会改动/覆盖数据，执行前先备份数据目录。
- `seed-persona-memories.mjs` 默认 dry-run，只有加 `--write` 才会写记忆。
- NapCat 是第三方非官方 QQ 协议桥，存在账号风险，建议用小号；不要把自己的 QQ 密码写进任何脚本。
