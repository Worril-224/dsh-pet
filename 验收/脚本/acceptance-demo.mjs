/**
 * 验收演示脚本（人可读证据）：用固定时钟模拟 10 天对话与每日维护，
 * 展示短期→长期转移、七层衰减、提及上浮、分级检索、记忆摘要与人设渲染。
 *
 * 运行：node 验收/脚本/acceptance-demo.mjs
 * 输出可直接保存为本地文本（仓库不再附带原始输出快照）。
 * 脚本使用临时数据目录，不影响数据目录下的真实角色数据。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { getMemoryEngine, resetMemoryEngineRegistry } from '../../companion-bundle/lib/memory/index.js'
import { createPersonaService } from '../../companion-bundle/lib/persona/index.js'
import { createFixedClock, formatLocalIso } from '../../companion-bundle/lib/shared/clock.js'
import { layerLabel } from '../../companion-bundle/lib/shared/paths.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-demo-'))
const clock = createFixedClock('2026-11-01T20:00:00+08:00')

/** 打印小节标题。 */
function h(title) {
  console.log(`\n========== ${title} ==========`)
}

/** 打印当前各层数量。 */
function printLayers(engine) {
  const counts = engine.status().counts
  const parts = [`短期 ${counts.short} 条`]
  counts.layers.forEach((n, i) => parts.push(`第${['一', '二', '三', '四', '五', '六', '七'][i]}层 ${n} 条`))
  console.log(`  层分布：${parts.join('｜')}`)
}

/** 打印某条记忆的层级与历史。 */
function printItem(engine, id, label) {
  const item = engine.getItem(id)
  console.log(
    `  ${label}：${item.content}\n    层级=${layerLabel(item.layer)}｜提及=${item.mentionCount}｜重要度=${item.importance}｜清晰度=${item.clarity}｜首次=${item.firstSeenAt}`,
  )
  if (item.history.length > 0) {
    console.log(`    历史：${item.history.map((entry) => `${layerLabel(entry.from)}→${layerLabel(entry.to)}（${entry.reason}）`).join('；')}`)
  }
}

/** 在固定时刻执行维护。 */
function maintain(engine, clock, iso, reason) {
  clock.set(iso)
  const report = engine.maintain({ at: clock.now(), reason })
  console.log(
    `  维护 @ ${formatLocalIso(clock.now())}（${report.reason}）：转移 ${report.transferred} 条，上浮 ${report.promoted} 条，下沉 ${report.demoted} 条`,
  )
  printLayers(engine)
  return report
}

try {
  h('0. 人设模块（默认「铃兰」，9 个模块）')
  const persona = createPersonaService({
    dataDir,
    defaultPersonaFile: path.join(root, 'companion-bundle', 'data', 'persona.default.json'),
    clock,
  })
  persona.ensure()
  const definition = persona.getDefinition()
  console.log(`  角色：${definition.character.name}（${definition.character.oneLiner}）`)
  console.log(`  模块：${persona.moduleList().map((m) => `${m.label}[${m.activation === 'always' ? '始终生效' : '被问到才用'}]`).join('、')}`)
  const personaSection = persona.renderPersonaSection()
  console.log(`  人设段长度：${personaSection.length} 字符；校验：${JSON.stringify(persona.validate())}`)
  const appearance = persona.lookup('appearance')
  console.log(`  persona_lookup("appearance") 返回 ${appearance.content.length} 字：${appearance.content.slice(0, 48)}…`)
  const onDemandLeaked = definition.modules.filter((m) => m.activation === 'on_demand').some((m) => personaSection.includes(m.content))
  assert.equal(onDemandLeaked, false, 'on_demand 正文不得进入人设段')

  h('1. 第 1 天 20:00：写入 4 条记忆，并提及其中一条')
  const engine = getMemoryEngine({ dataDir, clock })
  engine.ensure()
  const strawberry = engine.remember({
    content: '主人最喜欢草莓味蛋糕，生日时也会买草莓蛋糕。',
    keywords: ['草莓蛋糕', '生日', '甜品'],
    category: '喜好',
  }).item
  const genshin = engine.remember({
    content: '主人最近在玩原神，最喜欢里面的芙宁娜。',
    keywords: ['原神', '游戏', '芙宁娜'],
    category: '喜好',
  }).item
  const cat = engine.remember({
    content: '主人养了一只叫豆豆的小猫，是只橘猫。',
    keywords: ['小猫', '豆豆', '橘猫'],
    category: '人际',
  }).item
  const exam = engine.remember({
    content: '主人下周有一门重要的考试，有点紧张。',
    keywords: ['考试', '下周', '紧张'],
    category: '计划',
  }).item
  engine.ingestMessage({
    text: '今天又想吃草莓蛋糕了',
    messageId: 'demo-msg-1',
    role: 'user',
    at: clock.now(),
    sessionId: 'demo-session',
  })
  printItem(engine, strawberry.id, '草莓蛋糕')
  assert.equal(engine.getItem(strawberry.id).mentionCount, 2, '提及一次后 mentionCount 应为 2')
  printLayers(engine)

  h('2. 第 2 天 04:30：夜间维护 —— 短期记忆全部转入第一层')
  const r1 = maintain(engine, clock, '2026-11-02T04:30:00+08:00', '每日凌晨维护窗口')
  assert.equal(r1.transferred, 4)
  for (const item of [strawberry, genshin, cat, exam]) assert.equal(engine.getItem(item.id).layer, 1)
  console.log('  → 4 条记忆全部进入第一层，短期记忆清空（符合「每天晚上把这一整天的短期记忆转移到第一层」）')

  h('3. 第 2 天 21:00：主人又提到「原神」')
  clock.set('2026-11-02T21:00:00+08:00')
  engine.ingestMessage({ text: '今晚继续玩原神', messageId: 'demo-msg-2', role: 'user', at: clock.now() })
  assert.equal(engine.getItem(genshin.id).mentionCount, 2)
  console.log('  → 「原神」记忆提及次数 2，最近提及时间更新')

  const daily = []
  const recordDaily = (day) => {
    daily.push({
      day,
      layers: Object.fromEntries(
        [strawberry, genshin, cat, exam].map((item) => [item.content.slice(0, 4), engine.getItem(item.id).layer]),
      ),
    })
  }

  h('4. 第 3–5 天：每日维护，观察第 1→2 层（1 天）、第 2→3 层（3 天）衰减')
  maintain(engine, clock, '2026-11-03T04:30:00+08:00', '每日凌晨维护窗口')
  recordDaily(3)
  assert.equal(engine.getItem(strawberry.id).layer, 2, '第 1 层 1 天未提及应下沉到第 2 层')
  assert.equal(engine.getItem(genshin.id).layer, 1, '刚被提及过的记忆应留在第 1 层')
  maintain(engine, clock, '2026-11-04T04:30:00+08:00', '每日凌晨维护窗口')
  recordDaily(4)
  assert.equal(engine.getItem(genshin.id).layer, 2, '第 1 层再 1 天未提及应下沉到第 2 层')
  maintain(engine, clock, '2026-11-05T04:30:00+08:00', '每日凌晨维护窗口')
  recordDaily(5)
  assert.equal(engine.getItem(strawberry.id).layer, 3, '第 2 层 3 天未提及应下沉到第 3 层')

  h('5. 第 5 天 12:00 提到「草莓蛋糕」→ 第 6 天维护时上浮一层')
  clock.set('2026-11-05T12:00:00+08:00')
  engine.ingestMessage({ text: '草莓蛋糕真的太好吃了', messageId: 'demo-msg-3', role: 'user', at: clock.now() })
  printItem(engine, strawberry.id, '草莓蛋糕（提及后）')
  maintain(engine, clock, '2026-11-06T04:30:00+08:00', '每日凌晨维护窗口')
  recordDaily(6)
  assert.equal(engine.getItem(strawberry.id).layer, 2, '提及频率增加应上浮一层')
  printItem(engine, strawberry.id, '草莓蛋糕（上浮后）')

  h('6. 第 7–9 天：继续衰减，验证第 3→4 层（7 天）阈值')
  for (const day of [7, 8, 9]) {
    maintain(engine, clock, `2026-11-${String(day).padStart(2, '0')}T04:30:00+08:00`, '每日凌晨维护窗口')
    recordDaily(day)
  }
  assert.equal(engine.getItem(cat.id).layer, 4, '第 3 层满 7 天未提及应下沉到第 4 层')
  assert.equal(engine.getItem(strawberry.id).layer, 3, '上浮后又持续未提及，应回到第 3 层')

  h('7. 第 9 天 12:00 提到「豆豆」→ 第 10 天维护时从第 4 层上浮到第 3 层')
  clock.set('2026-11-09T12:00:00+08:00')
  engine.ingestMessage({ text: '豆豆今天又把杯子打翻了', messageId: 'demo-msg-4', role: 'user', at: clock.now() })
  const r10 = maintain(engine, clock, '2026-11-10T04:30:00+08:00', '每日凌晨维护窗口')
  recordDaily(10)
  printItem(engine, cat.id, '豆豆（上浮后）')
  assert.equal(engine.getItem(cat.id).layer, 3, '提及频率增加应上浮一层（第 4 层 → 第 3 层）')
  assert.ok(r10.promoted >= 1, '第 10 天维护应至少有 1 条上浮')

  console.log('\n  每日层级轨迹（内容前 4 字 → 层级）：')
  for (const row of daily) console.log(`    第 ${row.day} 天：${JSON.stringify(row.layers)}`)

  h('8. 第 10 天 20:00：新消息 → 自动抽取新记忆并提及旧记忆')
  clock.set('2026-11-10T20:00:00+08:00')
  const ingest = engine.ingestMessage({
    text: '我今天考试考砸了，好难过',
    messageId: 'demo-msg-5',
    role: 'user',
    at: clock.now(),
    sessionId: 'demo-session',
  })
  console.log(`  自动抽取 ${ingest.created.length} 条：${ingest.created.map((item) => `${item.content}（${item.category}）`).join('；')}`)
  console.log(`  提及旧记忆 ${ingest.mentioned.length} 条：${ingest.mentioned.map((entry) => `${entry.id}×${entry.mentionCount}`).join('、')}`)
  printLayers(engine)

  h('9. 分级检索：短期 → 第一层 → … → 第七层，命中足够即停止')
  for (const query of ['考试', '原神', '豆豆']) {
    const result = engine.recall(query, { limit: 2 })
    const hitInfo = result.hits.map((hit) => `${hit.item.content.slice(0, 12)}…@${layerLabel(hit.layer)}`).join('；')
    console.log(`  检索「${query}」→ ${hitInfo || '无命中'}`)
    console.log(
      `    检索层：${result.searchedLayers.map(layerLabel).join(' → ')}；停止层=${result.stoppedAt === null ? '无（全部检索完）' : layerLabel(result.stoppedAt)}`,
    )
    assert.equal(result.searchedLayers[0], 'short', '检索必须从短期记忆开始')
  }
  const limited = engine.recall('主人', { limit: 1 })
  assert.equal(limited.hits.length, 1)
  assert.equal(limited.searchedLayers.length, 1, 'limit=1 且短期命中时应停止在长期层检索之前')
  console.log('  → limit=1 且短期命中：只检索了短期记忆就停止（省开销）')

  h('10. 记忆摘要注入（renderDigest）')
  const digest = engine.renderDigest({ latestUserText: '考试', maxChars: 1600 })
  console.log(digest)
  assert.ok(digest.length <= 1600, 'digest 长度必须 ≤ maxChars')
  assert.match(digest, /考试/, 'digest 应包含与当前话题相关的「考试」记忆')

  h('11. 数据文件与中文总览')
  const overviewPath = engine.writeOverview()
  const overview = fs.readFileSync(overviewPath, 'utf8')
  console.log(overview.split('\n').slice(0, 18).join('\n'))
  console.log(`\n  记忆目录：${path.join(dataDir, 'memory')}`)
  console.log(`  文件：${fs.readdirSync(path.join(dataDir, 'memory')).join('、')}`)
  console.log(`  人设文件：${persona.getFilePath()}`)
  console.log(`  短期记忆文件中文示例：${fs.readFileSync(engine.paths.shortTermFile, 'utf8').slice(0, 120).replaceAll('\n', ' ')}`)

  console.log('\n✅ 验收演示全部断言通过（11 个阶段）')
} finally {
  resetMemoryEngineRegistry()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
