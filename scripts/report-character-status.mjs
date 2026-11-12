#!/usr/bin/env node
/**
 * 生成某个角色的现状报告：人设模块 / 全部记忆 / 回复链路。
 *
 * 用法：
 *   node scripts/report-character-status.mjs [--character <角色id>] [--data-dir <数据目录>] [--out <输出.md>]
 *
 * 默认数据目录：$DSH_PET_DATA_DIR 或 ~/.dsh/dsh-pet/companion-data；
 * 默认角色：$DSH_PET_CHARACTER 或 ophelia；
 * 默认输出：<角色目录>/status-report.md。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPersonaService } from '../companion-bundle/lib/persona/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

/** 默认数据目录：与 companion-bundle 保持一致（可用 DSH_PET_DATA_DIR 覆盖）。 */
const DEFAULT_DATA_DIR = process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')
const dataDir = path.resolve(option('data-dir') ?? DEFAULT_DATA_DIR)
const characterId = option('character') ?? process.env.DSH_PET_CHARACTER ?? 'ophelia'
const CHAR = path.join(dataDir, 'characters', characterId)
const MEM = path.join(CHAR, 'memory')
const OUT = option('out') ? path.resolve(option('out')) : path.join(CHAR, 'status-report.md')

if (!fs.existsSync(CHAR)) {
  console.error(`角色目录不存在：${CHAR}`)
  console.error('可用 --character <id> / --data-dir <dir> 指定；或先运行 node scripts/init-data.mjs 初始化示例数据。')
  process.exit(2)
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const short = read(path.join(MEM, 'short-term.json')).items.map((item) => ({ ...item, layerLabel: '短期' }))
const layers = []
for (let i = 1; i <= 7; i += 1) {
  layers.push(...read(path.join(MEM, 'long-term', `layer-${i}.json`)).items.map((item) => ({ ...item, layerLabel: `第${i}层` })))
}
const all = [...short, ...layers].sort(
  (a, b) => String(a.occurredAt ?? a.firstSeenAt).localeCompare(String(b.occurredAt ?? b.firstSeenAt)) || String(a.id).localeCompare(String(b.id)),
)
const meta = read(path.join(MEM, 'meta.json'))
const character = read(path.join(CHAR, 'character.json'))
const persona = createPersonaService({ dataDir: CHAR })
persona.ensure()
const definition = persona.getDefinition()
const validation = persona.validate()
const rendered = persona.renderPersonaSection()
const pendingFile = path.join(MEM, 'pending-seed.json')
const pendingCount = fs.existsSync(pendingFile) ? read(pendingFile).items.length : 0
const qqStatusFile = path.join(CHAR, 'qq', 'status.json')
const qqStatus = fs.existsSync(qqStatusFile) ? read(qqStatusFile) : null
const planDir = path.join(CHAR, 'life')
const plans = fs.existsSync(planDir) ? fs.readdirSync(planDir).filter((name) => name.endsWith('.json')).sort() : []

const bySource = {}
for (const item of all) bySource[item.source ?? 'unknown'] = (bySource[item.source ?? 'unknown'] ?? 0) + 1
const layerCounts = { 短期: short.length }
for (let i = 1; i <= 7; i += 1) layerCounts[`第${i}层`] = layers.filter((item) => item.layerLabel === `第${i}层`).length

const fmtDate = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : iso ?? '—')
const cell = (value, max = 60) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const lines = []
lines.push(`# ${character.name} · 当前状态`)
lines.push('')
lines.push(`> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}（本机本地时区）`)
lines.push(`> 角色目录：\`${CHAR}\``)
lines.push('')
lines.push('## 一、记忆现状')
lines.push('')
lines.push(`- 总条数：**${all.length}**`)
lines.push(
  `- 来源：${Object.entries(bySource)
    .map(([source, count]) => `${source} ${count} 条`)
    .join('；')}`,
)
lines.push(
  `- 层级：${Object.entries(layerCounts)
    .map(([layer, count]) => `${layer} ${count}`)
    .join('；')}`,
)
lines.push(`- 最近维护：${meta.lastMaintenanceAt ?? '—'}（${meta.lastMaintenanceReason ?? '—'}）`)
lines.push(`- pending-seed：${pendingCount} 条${pendingCount > 0 ? '（等待重启 Harness 后吸收）' : ''}`)
lines.push('')
lines.push('| 编号 | 层 | 分类 | 重要度 | 发生时间 | 关键词 | 内容摘要 |')
lines.push('|---|---|---|---:|---|---|---|')
for (const item of all) {
  lines.push(
    `| ${item.id} | ${item.layerLabel} | ${item.category} | ${item.importance} | ${fmtDate(item.occurredAt ?? item.firstSeenAt)} | ${(item.keywords ?? []).join(' / ')} | ${cell(item.content, 70)} |`,
  )
}
lines.push('')
lines.push('## 二、人设')
lines.push('')
lines.push(`- 显示名：**${character.name}**`)
lines.push(`- 角色描述：${character.description}`)
lines.push(`- 人设文件：\`${path.join(CHAR, 'persona', 'persona.json')}\``)
lines.push(`- 校验：\`${JSON.stringify(validation)}\``)
lines.push(`- 渲染长度：**${rendered.length} 字**（always 模块全文 + on_demand 模块索引与个人经历状态）`)
lines.push('')
lines.push('| 模块 | 名称 | 生效方式 | 正文字数 |')
lines.push('|---|---|---|---:|')
for (const module of definition.modules) {
  lines.push(`| ${module.id} | ${module.label} | ${module.activation} | ${module.content.length} |`)
}
lines.push('')
lines.push('其它：`style`（句式/长度/语气词/颜文字/禁用开头/禁用链接）、`examples`、`identityFacts`、`relationship`、`personalHistory`。')
lines.push('')
lines.push('## 三、每次回复会经过的内容')
lines.push('')
lines.push('### QQ 私聊 / 群聊 @')
lines.push('')
lines.push('1. OneBot 事件解析（文本/图片/表情/@；过滤自己、非白名单、群聊未 @、重复消息）。')
lines.push('2. 记忆写入：提及匹配（mentionCount/emphasis）+ 规则自动抽取，写入短期记忆。')
lines.push('3. 图片（如有）：下载/校验 → `ctx.attachments` → 多模态图片附件。')
lines.push('4. system prompt 依次包含：')
lines.push('   - ① 人设段（always 四模块全文 + on_demand 索引 + 个人经历状态，约 ' + rendered.length + ' 字）；')
lines.push('   - ② 记忆摘要（短期按重要度 + 与当前话题相关的长期命中 + 各层数量）；')
lines.push('   - ③ 命中的 on_demand 档案全文（她自己/外貌/其他 AI/身份/个人经历）；')
lines.push('   - ④ 联网检索结果（命中查资料意图时，来源标题/片段，无 URL；失败提示不要编造）；')
lines.push('   - ⑤ 图片张数 + QQ 表情名；')
lines.push('   - ⑥ QQ 渠道指令（只输出正文、不要链接/客服腔、没记录不要编造）。')
lines.push('5. user 内容：最近若干轮对话 + 本次消息；图片以 image block 附加。')
lines.push('6. 输出：去链接、限长 → 按换行拆成多条气泡（群聊仅第一条 @）。')
lines.push('7. 写回 `qq/sessions.json`。')
lines.push('')
lines.push('### 每日主动分享')
lines.push('')
lines.push('定时检查当天 `life/day-plan-<日期>.json`；到点且未发的事件 → 人设+记忆+事件素材 → 生成分享文案（失败用兜底）→ 多气泡私聊主人 → 写入 `sentAt` 防重发。')
lines.push('')
lines.push('### Web GUI（情感陪伴预设）')
lines.push('')
lines.push('system = 人设段 + 动态记忆摘要（每步刷新）+ 时间上下文 + 工具说明；工具含 `persona_lookup / memory_recall / memory_note / memory_status / persona_status / web_search / web_fetch / ask_user` 等；用户消息同样写入记忆，模型可按需查档案/回忆/联网。')
lines.push('')
lines.push('### 凌晨维护')
lines.push('')
lines.push('04:00–06:00（或补跑）：短期全部转 L1 → 提及增加上浮 → 按层级下沉 → 重建总览；之后生成第二天的生活事件计划。')
lines.push('')
lines.push('## 四、当前运行状态')
lines.push('')
if (qqStatus) {
  lines.push(`- QQ：state=${qqStatus.adapter?.state ?? '—'}；features=${JSON.stringify(qqStatus.features ?? {})}；proactive.started=${qqStatus.proactive?.started ?? '—'}`)
  if (qqStatus.replyModel) {
    const route = qqStatus.replyModel
    lines.push(`- QQ 回复模型：${route.provider}/${route.model}，reasoningEffort=${route.reasoningEffort ?? '—'}`)
  }
}
lines.push(`- 生活计划：${plans.length > 0 ? plans.join('、') : '无'}`)
lines.push(`- 记忆文件：\`${MEM}\``)
lines.push(
  `- 重要：当前运行中的 Harness 进程若尚未重启，可能仍使用旧人设/旧记忆引擎缓存；新人设与 ${pendingCount} 条 pending-seed 需要**重启一次 Harness** 后才会在当前运行环境生效。`,
)
lines.push('')

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log(`written ${OUT} (${all.length} memories, ${rendered.length} chars persona)`)
