# 验收资料 · DshPet 情感陪伴型 AI 助手

本目录集中存放项目的**验收资料**：验收报告、验收标准（用例矩阵）、独立验收测试与行为演示脚本。
开发实现位于上级目录 `companion-bundle/`，示例运行时数据位于 `companion-data/`。

## 目录结构

| 路径 | 内容 |
|---|---|
| [验收标准.md](验收标准.md) | 验收用例矩阵：沿用原项目 **118 条验收用例 / 25 个模块组**（M / P / I / C / QC / QW / QB / QV / QL / QM / CM / SM / PE / PL / PP / PV / RL / DL / LM / TM / GL / CTX / BL / IG / A5 / A6 / QC17–20）；依赖一次性私有脚本的条目已标注为「历史验收项」 |
| [验收报告.md](验收报告.md) | 验收总报告（公开版）：结论摘要、验收方法与证据、各模块组结果、发现并修复的问题、公开版变更说明、未验证项、复验命令 |
| [verification/](verification/) | verifier 自写的独立验收测试：**19 个测试文件 / 173 项用例，全部通过**（与开发者测试相互独立） |
| [脚本/acceptance-demo.mjs](脚本/acceptance-demo.mjs) | 10 天固定时钟行为演示（11 个阶段断言：夜间转移、七层衰减、提及上浮、分级检索、摘要注入） |

## 快速开始

1. 先看总报告：[验收报告.md](验收报告.md)（第一节为结论摘要）。
2. 想核对用例矩阵：[验收标准.md](验收标准.md)。
3. 想自己复跑：见下方命令。

## 复跑验收

```bash
# 开发者测试（232 项）
node scripts/run-tests.mjs all

# 独立验收测试（19 个文件 / 173 项）
node 验收/verification/run-verification.mjs

# 10 天行为演示（11 个阶段断言）
node 验收/脚本/acceptance-demo.mjs
```

> Windows 下如果没有把 Node 加入 PATH，可用 Harness 自带 Node：`& "<node.exe 路径>" 验收/verification/run-verification.mjs`。

## 说明

- 全部自动化测试使用操作系统临时目录（`fs.mkdtempSync`），不会修改或污染示例数据目录 `companion-data/`；
  少数「示例数据只读核对」用例只读取仓库内的虚构示例数据。
- 验收对象：Harness 插件 bundle `@local/dsh-companion`（Host 插件 `companion-host` / `companion-qq` + `companion` Agent 预设 + `lib/life` / `lib/bilibili` / `lib/imagegen`）。
- 验收环境：Windows 11 / DeepSeek Harness（profile `desktop`）/ Node ≥ 20 / 时区 Asia/Shanghai。
- 公开版移除了原项目的原始输出快照（`验收/输出/`）与独立验收报告（`验收/独立验收报告.md`，含真实账号与聊天数据）；
  历史生产验收结论保留在本报告中，标注为「原项目历史验收记录」。
- 未自动验证项（真人对话体验、预设真机挂载、QQ 真机联调、B 站真实扫码、本地 ComfyUI 真实出图等）已在验收报告中如实标注。
