/**
 * 功能3：人设个人经历按时间导入记忆区（occurredAt + seedMemories + seed-persona-memories.mjs）。
 *
 * 覆盖：
 * - seedMemories 写入层 / occurredAt / importance / source / history / 事件日志；
 * - 幂等去重（同 id、规范化 content）、--force 覆盖语义；
 * - 无 occurredAt 的老数据完全向后兼容（不写盘、不影响维护/检索/摘要）；
 * - occurredAt 缺省与层级估算边界（<=1 天短期、<=7 天第一层 … >140 天第七层）；
 * - 非法条目跳过；渲染（清晰度摘要 / 记忆总览 / 记忆摘要注入）展示发生时间；
 * - 真实 ophelia 人设只读解析时间线（dry-run 语义）+ 临时目录完整导入；
 * - CLI 默认 dry-run 不写文件、--write 写入临时角色目录且可重复执行。
 *
 * 所有记忆数据都写在 fs.mkdtempSync 创建的临时目录；真实 ophelia 记忆目录只读不写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { estimateLayerByOccurredAt } from '../../lib/memory/model.js'
import { MEMORY_CATEGORIES } from '../../lib/memory/constants.js'
import { buildOverviewMarkdown, renderItemByClarity } from '../../lib/memory/render.js'
import {
  MS_PER_DAY,
  createEngine,
  isoOf,
  listFilesRecursive,
  localMs,
  makeItem,
  readJsonFile,
  readTextFile,
  reopenEngine,
  seedEngine,
} from './_helpers.mjs'
import {
  DEFAULT_CHARACTER_ID,
  PERSONA_HISTORY_TIMELINE,
  buildSeedItems,
  buildSeedItemsFromFile,
  collectPersonaHistoryContent,
  findDetailBullet,
  findSectionExcerpt,
  parseArgs,
  parseHistorySections,
  resolveCharacterPaths,
} from '../../../scripts/seed-persona-memories.mjs'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, '../../..')
const SCRIPT_FILE = path.join(REPO_ROOT, 'scripts', 'seed-persona-memories.mjs')
const REAL_PERSONA_FILE = path.join(
  REPO_ROOT,
  'companion-data',
  'characters',
  'ophelia',
  'persona',
  'persona.json',
)
const REAL_PERSONA_EXISTS = fs.existsSync(REAL_PERSONA_FILE)

/** 本文件统一的「当前时间」：2026-11-06 10:00（本地时区），对应功能开发时点。 */
const NOW_MS = localMs(2026, 11, 6, 10, 0)

function fixedNow() {
  return NOW_MS
}

function newTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

/** 快照记忆目录全部文件内容（用于断言「重复导入不改文件」）。 */
function snapshotMemoryFiles(ctx) {
  const snapshot = {}
  for (const relative of listFilesRecursive(ctx.memoryDir)) {
    snapshot[relative] = readTextFile(path.join(ctx.memoryDir, relative))
  }
  return snapshot
}

function createSeededAtNow(t) {
  const ctx = createEngine({ start: NOW_MS })
  t.after(ctx.cleanup)
  return ctx
}

test('功能3 seedMemories：按 occurredAt 估算层写入，occurredAt/source/importance/history/事件日志正确', (t) => {
  const ctx = createSeededAtNow(t)
  const { engine } = ctx
  const occurredOld = isoOf(localMs(2023, 12, 31, 22, 30))
  const occurredRecent = isoOf(localMs(2026, 11, 5, 9, 0))
  const result = engine.seedMemories([
    {
      id: 'seed-old',
      content: '那一年的闭馆夜，她听见走廊尽头的脚步，最后把登记簿翻到空白页。',
      keywords: ['闭馆夜', '薇拉', '登记簿'],
      category: '事件',
      importance: 92,
      occurredAt: occurredOld,
    },
    {
      id: 'seed-recent',
      content: '主人昨天说想去看一次真正的日落。',
      keywords: ['主人', '日落', '约定'],
      category: '承诺',
      occurredAt: occurredRecent,
    },
    {
      id: 'seed-explicit',
      content: '很早以前，她在抄录院第一次从头到尾背完了馆规。',
      keywords: ['抄录院', '馆规', '童年'],
      category: '身份',
      occurredAt: isoOf(localMs(2012, 9, 1, 9, 0)),
      layer: 3,
    },
    {
      content: '没有发生时间的记忆会写入短期记忆。',
      keywords: ['发生时间', '短期', '记忆'],
    },
  ])

  assert.equal(result.created, 4)
  assert.equal(result.skipped, 0)
  assert.equal(result.createdIds.length, 4)
  assert.equal(result.createdItems.length, 4)
  assert.deepEqual(result.skippedItems, [])

  // 很久以前的条目 → 第七层，occurredAt 原样保留，重要度覆盖生效
  const old = engine.getItem('seed-old')
  assert.ok(old, 'seed-old 应存在')
  assert.equal(old.layer, 7)
  assert.equal(old.occurredAt, occurredOld)
  assert.equal(old.source, 'persona-history')
  assert.equal(old.importance, 92)
  assert.equal(old.clarity, 0.92)
  assert.equal(old.firstSeenAt, occurredOld)
  assert.equal(old.lastMentionedAt, occurredOld)
  assert.equal(old.mentionCountAtLastMaintenance, old.mentionCount)
  assert.equal(old.history.length, 1)
  assert.match(old.history[0].reason, /^seed/u)
  assert.equal(old.history[0].to, 7)

  // <=1 天的条目 → 短期记忆
  assert.equal(engine.getItem('seed-recent').layer, 'short')
  // 显式 layer 优先于按时间估算
  assert.equal(engine.getItem('seed-explicit').layer, 3)
  // 无 occurredAt → 短期记忆，且 occurredAt 保持 undefined
  const shortItems = engine.listLayer('short')
  const withoutOccurredAt = shortItems.find((item) => item.content.includes('没有发生时间'))
  assert.ok(withoutOccurredAt)
  assert.equal(withoutOccurredAt.layer, 'short')
  assert.equal(withoutOccurredAt.occurredAt, undefined)
  assert.equal(withoutOccurredAt.source, 'persona-history')
  assert.equal(shortItems.length, 2)
  assert.deepEqual(engine.status().counts.layers, [0, 0, 1, 0, 0, 0, 1])
  assert.equal(engine.status().total, 4)

  // 持久化：short-term / 对应长期层文件写入 occurredAt 与重要度
  const shortDoc = readJsonFile(path.join(ctx.memoryDir, 'short-term.json'))
  assert.equal(shortDoc.items.length, 2)
  assert.ok(shortDoc.items.some((item) => item.id === 'seed-recent' && item.occurredAt === occurredRecent))
  const layer3Doc = readJsonFile(path.join(ctx.memoryDir, 'long-term', 'layer-3.json'))
  assert.ok(layer3Doc.items.some((item) => item.id === 'seed-explicit'))
  const layer7Doc = readJsonFile(path.join(ctx.memoryDir, 'long-term', 'layer-7.json'))
  const persistedOld = layer7Doc.items.find((item) => item.id === 'seed-old')
  assert.ok(persistedOld)
  assert.equal(persistedOld.occurredAt, occurredOld)
  assert.equal(persistedOld.importance, 92)

  // index 与「记忆总览.md」：关键词索引、发生时间列
  const index = readJsonFile(path.join(ctx.memoryDir, 'index.json'))
  assert.ok(index.keywords['闭馆夜'].includes('seed-old'))
  const overview = readTextFile(path.join(ctx.memoryDir, '记忆总览.md'))
  assert.ok(overview.includes('| 发生时间 |'))
  assert.ok(overview.includes(occurredOld))
  assert.ok(overview.includes('那一年的闭馆夜'))

  // events.jsonl：恰好一条 seed 事件，包含 created 列表
  const events = readTextFile(path.join(ctx.memoryDir, 'events.jsonl'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const seedEvents = events.filter((event) => event.type === 'seed')
  assert.equal(seedEvents.length, 1)
  assert.equal(seedEvents[0].created.length, 4)
  assert.equal(seedEvents[0].skipped, 0)
  assert.match(seedEvents[0].message, /[\u4e00-\u9fa5]/u)
})

test('功能3 seedMemories 幂等：重复导入按 id / 规范化 content 去重，不新增、不改文件、不重复写事件', (t) => {
  const ctx = createSeededAtNow(t)
  const { engine } = ctx
  const items = [
    {
      id: 'seed-idem',
      content: '薇拉的名字从抄录院名册上消失了。',
      keywords: ['薇拉', '名字', '名册'],
      category: '事件',
      occurredAt: isoOf(localMs(2024, 1, 1, 8, 0)),
    },
    {
      id: 'seed-idem-2',
      content: '她把自己的档案页脚留给了薇拉的名字。',
      keywords: ['档案页脚', '薇拉', '名字'],
      category: '人际',
      occurredAt: isoOf(localMs(2024, 1, 2, 9, 0)),
    },
  ]
  const first = engine.seedMemories(items)
  assert.equal(first.created, 2)
  const snapshot = snapshotMemoryFiles(ctx)
  const totalBefore = engine.status().total

  const second = engine.seedMemories([
    // 同 id → 跳过
    { id: 'seed-idem', content: '同 id 但内容不同，也不应覆盖。' },
    // 规范化后相等（标点差异）→ 跳过
    { content: '薇拉的名字从抄录院名册上消失了' },
    // 规范化后相等（空白差异）→ 跳过
    { content: '她把自己的档案页脚 留给了薇拉的名字。' },
  ])
  assert.equal(second.created, 0)
  assert.equal(second.skipped, 3)
  assert.equal(engine.status().total, totalBefore)
  assert.equal(engine.getItem('seed-idem').content, '薇拉的名字从抄录院名册上消失了。')
  const reasons = second.skippedItems.map((item) => item.reason).join('；')
  assert.match(reasons, /同 id 条目已存在/u)
  assert.match(reasons, /与已有记忆内容重复/u)

  // 全部跳过时不落盘：文件内容保持完全一致（含事件日志）
  assert.deepEqual(snapshotMemoryFiles(ctx), snapshot)
})

test('功能3 老数据（无 occurredAt）完全兼容：加载/维护/检索/摘要正常，occurredAt 保持 undefined 且不写盘', (t) => {
  const startMs = localMs(2026, 11, 5, 10, 0)
  const legacyShort = [
    makeItem({
      id: 'mem-000001',
      content: '主人喜欢夜里听雨声。',
      summary: '主人喜欢夜里听雨声。',
      keywords: ['雨声', '夜晚', '喜欢'],
      category: '喜好',
    }),
    makeItem({
      id: 'mem-000002',
      content: '主人在做毕业设计。',
      summary: '主人在做毕业设计。',
      keywords: ['毕业设计', '主人', '工作学习'],
      category: '工作学习',
      firstSeenAt: isoOf(startMs - 120_000),
    }),
  ]
  const ctx = seedEngine({ start: startMs, short: legacyShort })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx

  // 老条目 occurredAt 为 undefined
  for (const item of engine.listLayer('short')) assert.equal(item.occurredAt, undefined)

  // 再新增一条普通记忆（无 occurredAt），落盘文件不应出现 occurredAt 键
  engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['草莓蛋糕', '喜欢', '甜食'] })
  const shortDoc = readJsonFile(path.join(ctx.memoryDir, 'short-term.json'))
  for (const item of shortDoc.items) assert.ok(!('occurredAt' in item), `${item.id} 不应写入 occurredAt 字段`)

  // 维护 / 检索 / 摘要不因缺少 occurredAt 报错
  clock.set(localMs(2026, 11, 6, 4, 30))
  const report = engine.maintain({ at: clock.now() })
  assert.equal(report.ok, true)
  assert.equal(report.transferred, 3)
  assert.ok(engine.recall('雨声').hits.length >= 1)
  assert.ok(engine.renderDigest({ latestUserText: '雨声' }).length > 0)

  // 老数据渲染不出现「发生：」，总览也不出现「发生时间」列
  const clear = renderItemByClarity(engine.getItem('mem-000001'))
  assert.ok(!clear.includes('发生：'))
  const overview = readTextFile(path.join(ctx.memoryDir, '记忆总览.md'))
  assert.ok(!overview.includes('| 发生时间 |'))
  assert.ok(overview.includes('| 编号 | 摘要 | 分类 | 关键词 |'))

  // 重启（新引擎实例）仍然兼容：occurredAt 仍为 undefined，且写盘不新增字段
  const reopened = reopenEngine(ctx.dataDir, { start: localMs(2026, 11, 6, 10, 0) })
  for (let layer = 1; layer <= 7; layer += 1) {
    for (const item of reopened.engine.listLayer(layer)) assert.equal(item.occurredAt, undefined)
  }
  reopened.engine.writeOverview()
  for (let layer = 1; layer <= 7; layer += 1) {
    const doc = readJsonFile(path.join(ctx.memoryDir, 'long-term', `layer-${layer}.json`))
    for (const item of doc.items) assert.ok(!('occurredAt' in item))
  }
})

test('功能3 occurredAt 层级估算边界：<=1 天短期、<=7 天第一层 … >140 天第七层', () => {
  const now = fixedNow()
  const at = (days) => isoOf(now - days * MS_PER_DAY)
  const cases = [
    [0, 'short'],
    [1, 'short'],
    [2, 1],
    [7, 1],
    [8, 2],
    [14, 2],
    [15, 3],
    [30, 3],
    [31, 4],
    [60, 4],
    [61, 5],
    [90, 5],
    [91, 6],
    [140, 6],
    [141, 7],
    [3650, 7],
  ]
  for (const [days, expected] of cases) {
    assert.equal(estimateLayerByOccurredAt(at(days), now), expected, `距今 ${days} 天应估算为 ${expected}`)
  }
  assert.equal(estimateLayerByOccurredAt(undefined, now), 'short')
  assert.equal(estimateLayerByOccurredAt('', now), 'short')
  assert.equal(estimateLayerByOccurredAt('不是时间', now), 'short')
  // 未来时间（如今年的生日还没到）也落在短期记忆
  assert.equal(estimateLayerByOccurredAt(isoOf(now + 2 * MS_PER_DAY), now), 'short')
})

test('功能3 seedMemories 参数校验：空内容 / 非法层级 / 非法时间 / 非对象条目被跳过，其余正常写入', (t) => {
  const ctx = createSeededAtNow(t)
  const { engine } = ctx
  const result = engine.seedMemories([
    { id: 'ok-1', content: '一条合法的种子记忆内容。', keywords: ['合法', '种子', '记忆'] },
    { content: '   ' },
    { content: '层级非法的条目。', layer: 9 },
    { content: '发生时间非法的条目。', occurredAt: '不是时间' },
    '不是对象',
    { content: '显式短期层级可以写入。', layer: 'short', occurredAt: isoOf(localMs(2026, 11, 1, 9, 0)) },
  ])
  assert.equal(result.created, 2)
  assert.equal(result.skipped, 4)
  assert.equal(engine.status().total, 2)
  assert.ok(engine.getItem('ok-1'))
  const reasons = result.skippedItems.map((item) => item.reason).join('；')
  assert.match(reasons, /content 不能为空/u)
  assert.match(reasons, /无效的记忆层级/u)
  assert.match(reasons, /occurredAt 不是合法时间/u)
  assert.match(reasons, /条目必须是对象/u)
})

test('功能3 seedMemories force 覆盖同 id 旧条目：内容与重要度更新且不产生重复', (t) => {
  const ctx = createSeededAtNow(t)
  const { engine } = ctx
  const occurredAt = isoOf(localMs(2023, 12, 31, 22, 30))
  const first = engine.seedMemories([
    {
      id: 'seed-force',
      content: '旧的内容：她在闭馆夜什么也没做。',
      keywords: ['闭馆夜', '旧内容', '记忆'],
      category: '事件',
      importance: 40,
      occurredAt,
    },
  ])
  assert.equal(first.created, 1)
  assert.equal(engine.status().total, 1)

  const replacement = {
    id: 'seed-force',
    content: '新的内容：她在闭馆夜把登记簿翻到了空白页。',
    keywords: ['闭馆夜', '登记簿', '新内容'],
    category: '事件',
    importance: 92,
    occurredAt,
  }
  const withoutForce = engine.seedMemories([replacement])
  assert.equal(withoutForce.created, 0)
  assert.equal(withoutForce.skipped, 1)
  assert.match(withoutForce.skippedItems[0].reason, /同 id 条目已存在/u)
  assert.match(engine.getItem('seed-force').content, /旧的内容/u)

  const forced = engine.seedMemories([replacement], { force: true })
  assert.equal(forced.created, 1)
  assert.equal(forced.skipped, 0)
  assert.equal(engine.status().total, 1, 'force 覆盖不应产生重复条目')
  const updated = engine.getItem('seed-force')
  assert.equal(updated.content, replacement.content)
  assert.equal(updated.importance, 92)
  assert.equal(updated.layer, 7)
  assert.equal(updated.history.length, 1)
})

test('功能3 渲染展示发生时间：清晰度摘要 / 记忆总览，且无 occurredAt 时输出保持原有格式', () => {
  const withOccurredAt = {
    id: 'seed-001',
    content: '那一年的闭馆夜，她听见走廊尽头的脚步。',
    summary: '那一年的闭馆夜。',
    keywords: ['闭馆夜', '薇拉', '登记簿'],
    firstSeenAt: '2023-12-31T22:30:00+08:00',
    lastMentionedAt: '2023-12-31T22:30:00+08:00',
    occurredAt: '2023-12-31T22:30:00+08:00',
    mentionCount: 5,
    clarity: 0.8,
  }
  const clear = renderItemByClarity(withOccurredAt)
  assert.ok(clear.includes('发生：2023-12-31T22:30:00+08:00'))
  assert.ok(clear.includes('首次：2023-12-31T22:30:00+08:00'))
  const medium = renderItemByClarity({ ...withOccurredAt, clarity: 0.5 })
  assert.ok(medium.includes('发生：2023-12-31T22:30:00+08:00'))
  const fuzzy = renderItemByClarity({ ...withOccurredAt, clarity: 0.2 })
  assert.ok(!fuzzy.includes('发生：'), '模糊档不展示发生时间')
  const legacyRender = renderItemByClarity({ ...withOccurredAt, occurredAt: undefined })
  assert.ok(!legacyRender.includes('发生：'))
  assert.equal(legacyRender, renderItemByClarity({ ...withOccurredAt, occurredAt: null }))

  const overviewWith = buildOverviewMarkdown({
    shortItems: [withOccurredAt],
    layers: [],
    meta: {},
    updatedAt: '2026-11-06T10:00:00+08:00',
  })
  assert.ok(overviewWith.includes('| 发生时间 |'))
  assert.ok(overviewWith.includes('2023-12-31T22:30:00+08:00'))
  const overviewLegacy = buildOverviewMarkdown({
    shortItems: [{ ...withOccurredAt, occurredAt: undefined }],
    layers: [],
    meta: {},
    updatedAt: '2026-11-06T10:00:00+08:00',
  })
  assert.ok(!overviewLegacy.includes('| 发生时间 |'))
  assert.ok(overviewLegacy.includes('| 编号 | 摘要 | 分类 | 关键词 |'))
})

test('功能3 renderDigest：带 occurredAt 的记忆命中时展示发生时间且长度不超限', (t) => {
  const ctx = createSeededAtNow(t)
  const { engine } = ctx
  engine.seedMemories([
    {
      content: '那一年的闭馆夜，她听见走廊尽头的脚步，最后把登记簿翻到空白页。',
      keywords: ['闭馆夜', '薇拉', '登记簿'],
      category: '事件',
      importance: 92,
      occurredAt: isoOf(localMs(2023, 12, 31, 22, 30)),
    },
  ])
  const digest = engine.renderDigest({ latestUserText: '闭馆夜' })
  assert.ok(!digest.includes('【长期记忆命中】'), '命中后应挪回短期')
  assert.ok(digest.includes('发生：'))
  assert.ok(digest.includes('2023-12-31T22:30:00+08:00'))
  assert.ok(digest.length <= 30000)
})

test(
  '功能3 示例 ophelia 人设：只读解析分节并构建时间线（dry-run 语义，不写真实记忆）',
  { skip: REAL_PERSONA_EXISTS ? false : '示例 ophelia 人设文件不存在，跳过' },
  () => {
    const persona = JSON.parse(fs.readFileSync(REAL_PERSONA_FILE, 'utf8'))
    const historyText = collectPersonaHistoryContent(persona)
    assert.ok(historyText.trim().length > 0, '人设个人经历正文不应为空')
    assert.equal(collectPersonaHistoryContent({ persona: {} }), '')
    // 兼容「modules 为对象」的人设卡格式
    assert.ok(
      collectPersonaHistoryContent({
        modules: { personal_history: { content: '【速览】对象写法也能读取。' } },
      }).includes('对象写法'),
    )

    // 分节 / 细节解析用合成正文覆盖语义（不依赖示例人设的具体故事内容）
    const syntheticHistory = ['【速览】这一页写着一件小事。', '【细节】', '- 旧钢笔：笔帽有一道划痕。'].join('\n')
    const syntheticSections = parseHistorySections(syntheticHistory)
    assert.deepEqual(syntheticSections, {
      '速览': '这一页写着一件小事。',
      '细节': '- 旧钢笔：笔帽有一道划痕。',
    })
    // 分节摘录：同一分节能按不同线索取到不同句子；【细节】能按名字取到条目
    assert.ok(findSectionExcerpt(syntheticSections['速览'], '一件小事').startsWith('这一页写着一件小事'))
    assert.equal(findSectionExcerpt(syntheticSections['速览'], '不存在的线索'), '')
    assert.match(findDetailBullet(syntheticHistory, '旧钢笔'), /^旧钢笔：/u)
    // 示例人设正文同样能解析出分节对象（不绑定具体分节名）
    assert.equal(typeof parseHistorySections(historyText), 'object')

    const built = buildSeedItems({ persona, characterId: DEFAULT_CHARACTER_ID, nowMs: fixedNow() })
    // 示例时间线必须完整构建；正文线索缺失时允许「补充说明」兜底，因此只要求 warnings 是数组。
    assert.ok(Array.isArray(built.warnings), 'warnings 应为数组')
    assert.equal(built.characterId, 'ophelia')
    assert.ok(PERSONA_HISTORY_TIMELINE.length >= 3, `示例时间线至少 3 条，实际 ${PERSONA_HISTORY_TIMELINE.length}`)
    assert.equal(built.items.length, PERSONA_HISTORY_TIMELINE.length, '每条示例时间线都应生成一条记忆')

    const ids = built.items.map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')
    assert.ok(ids.every((id) => id.startsWith('seed-ophelia-')))
    assert.deepEqual(ids, [...ids].sort(), 'id 按时间线顺序稳定（排序即稳定）')

    // 每条记忆与示例时间线一一对应：标题 / 发生时间 / 重要度 / 层级
    PERSONA_HISTORY_TIMELINE.forEach((row, index) => {
      const item = built.items[index]
      assert.equal(item.title, String(row.title ?? row.key ?? `第 ${index + 1} 条`))
      assert.equal(item.occurredAt, String(row.occurredAt).trim())
      assert.equal(item.importance, Math.min(100, Math.max(1, Math.round(Number(row.importance) || 50))))
      assert.equal(item.layer, estimateLayerByOccurredAt(item.occurredAt, fixedNow()))
    })

    for (const item of built.items) {
      assert.ok(item.id && item.content)
      assert.ok(item.content.includes('【'), '内容应带分节/细节标记')
      assert.ok(item.keywords.length >= 3 && item.keywords.length <= 5, `${item.id} 关键词应 3~5 个`)
      assert.ok(item.keywords.every((word) => typeof word === 'string' && word.length > 0))
      assert.ok(MEMORY_CATEGORIES.includes(item.category), `${item.id} 分类非法：${item.category}`)
      assert.ok(Number.isInteger(item.importance) && item.importance >= 1 && item.importance <= 100)
      assert.ok(['short', 1, 2, 3, 4, 5, 6, 7].includes(item.layer), `${item.id} 层级非法：${item.layer}`)
      assert.equal(item.layer, estimateLayerByOccurredAt(item.occurredAt, fixedNow()), `${item.id} 层级应按发生时间估算`)
      assert.ok(Number.isFinite(Date.parse(item.occurredAt)))
      assert.equal(item.source, 'persona-history')
      assert.equal(item.firstSeenAt, item.occurredAt)
      assert.equal(item.lastMentionedAt, item.occurredAt)
    }

    // 从真实文件路径构建结果一致
    const fromFile = buildSeedItemsFromFile({ personaFile: REAL_PERSONA_FILE, characterId: 'ophelia', nowMs: fixedNow() })
    assert.equal(fromFile.items.length, built.items.length)
    assert.deepEqual(
      fromFile.items.map((item) => item.id),
      built.items.map((item) => item.id),
    )
    // 校验时不写入真实记忆目录：只读调用不会新增/修改文件（读取前后内存目录文件快照一致）
    const realMemoryDir = path.join(path.dirname(REAL_PERSONA_FILE), '..', 'memory')
    if (fs.existsSync(realMemoryDir)) {
      const snapshot = {}
      for (const relative of listFilesRecursive(realMemoryDir)) {
        snapshot[relative] = fs.statSync(path.join(realMemoryDir, relative)).mtimeMs
      }
      buildSeedItems({ persona, characterId: 'ophelia', nowMs: fixedNow() })
      for (const relative of listFilesRecursive(realMemoryDir)) {
        const stat = fs.statSync(path.join(realMemoryDir, relative))
        assert.equal(snapshot[relative], stat.mtimeMs, `dry-run 不应修改真实记忆文件 ${relative}`)
      }
    }
  },
)

test(
  '功能3 示例时间线导入临时记忆库：created 数量、层分布、重启后 occurredAt 保留、重复导入幂等',
  { skip: REAL_PERSONA_EXISTS ? false : '示例 ophelia 人设文件不存在，跳过' },
  (t) => {
    const ctx = createSeededAtNow(t)
    const { engine } = ctx
    const persona = JSON.parse(fs.readFileSync(REAL_PERSONA_FILE, 'utf8'))
    const built = buildSeedItems({ persona, characterId: 'ophelia', nowMs: fixedNow() })

    const first = engine.seedMemories(built.items)
    assert.equal(first.created, built.items.length)
    assert.equal(first.skipped, 0)
    assert.equal(engine.status().total, built.items.length)

    // 每条都写进了按发生时间估算的层
    for (const item of built.items) {
      const listed = engine.listLayer(item.layer)
      assert.ok(
        listed.some((entry) => entry.id === item.id && entry.occurredAt === item.occurredAt),
        `${item.id} 应位于 ${item.layer} 且保留 occurredAt`,
      )
    }
    // 短期记忆只接收「发生时间在未来」的条目（由示例时间线动态推导）
    const expectedShort = built.items.filter((item) => item.layer === 'short').length
    assert.equal(engine.status().counts.short, expectedShort)

    // 重启后 occurredAt 保留、编号/内容不丢
    const reopened = reopenEngine(ctx.dataDir, { start: NOW_MS })
    assert.equal(reopened.engine.status().total, built.items.length)
    const sample = reopened.engine.getItem(built.items[0].id)
    assert.equal(sample.occurredAt, built.items[0].occurredAt)
    assert.equal(sample.content, built.items[0].content)
    assert.equal(reopened.engine.getItem(built.items[built.items.length - 1].id).occurredAt, built.items[built.items.length - 1].occurredAt)

    // 重复导入幂等
    const second = reopened.engine.seedMemories(built.items)
    assert.equal(second.created, 0)
    assert.equal(second.skipped, built.items.length)
    assert.equal(reopened.engine.status().total, built.items.length)

    // 总览文件包含发生时间列
    const overview = readTextFile(path.join(ctx.memoryDir, '记忆总览.md'))
    assert.ok(overview.includes('| 发生时间 |'))
  },
)

test('功能3 脚本：人设文件缺失 / 个人经历为空 / 参数非法时给出清晰中文错误', () => {
  const tmpDir = newTmpDir('dshpet-seed-errors-')
  try {
    assert.throws(
      () => buildSeedItemsFromFile({ personaFile: path.join(tmpDir, 'missing', 'persona.json') }),
      /人设文件不存在/u,
    )
    assert.throws(() => buildSeedItems({ persona: { modules: [] }, characterId: 'no-history' }), /个人经历/u)
    assert.throws(
      () => buildSeedItems({ persona: { modules: [{ id: 'personal_history', content: '   ' }] } }),
      /个人经历/u,
    )
    assert.throws(
      () => resolveCharacterPaths({ characterId: 'Bad Id', charactersDir: tmpDir }),
      /角色 id 非法/u,
    )
    // 参数解析：默认 dry-run；--write 才真正写入；未知参数报错
    assert.equal(parseArgs([]).dryRun, true)
    assert.equal(parseArgs([]).characterId, DEFAULT_CHARACTER_ID)
    assert.equal(parseArgs(['--dry-run']).dryRun, true)
    assert.equal(parseArgs(['--write']).dryRun, false)
    assert.equal(parseArgs(['--apply']).dryRun, false)
    assert.equal(parseArgs(['--write', '--force']).force, true)
    assert.equal(parseArgs(['--character-id', 'ophelia']).characterId, 'ophelia')
    assert.throws(() => parseArgs(['--nope']), /未知参数/u)
    assert.throws(() => parseArgs(['--character-id']), /缺少取值/u)
  } finally {
    removeDir(tmpDir)
  }
})

test(
  '功能3 脚本 CLI：默认 dry-run 不写文件；--write 写入临时角色目录且重复执行幂等',
  { skip: REAL_PERSONA_EXISTS ? false : '示例 ophelia 人设文件不存在，跳过' },
  (t) => {
    const tmpRoot = newTmpDir('dshpet-seed-cli-')
    t.after(() => removeDir(tmpRoot))
    const charactersDir = path.join(tmpRoot, 'characters')
    const personaDir = path.join(charactersDir, 'ophelia', 'persona')
    fs.mkdirSync(personaDir, { recursive: true })
    const copiedPersonaFile = path.join(personaDir, 'persona.json')
    fs.copyFileSync(REAL_PERSONA_FILE, copiedPersonaFile)
    const memoryDir = path.join(charactersDir, 'ophelia', 'memory')
    // 期望条数由同一条示例时间线推导，避免把条数写死；
    // 不传 nowMs，与 CLI 一样按“当前真实时间”估算层级（短期=事件在未来）。
    const expectedBuilt = buildSeedItems({
      persona: JSON.parse(fs.readFileSync(copiedPersonaFile, 'utf8')),
      characterId: 'ophelia',
    })
    const expectedCount = expectedBuilt.items.length
    const expectedShortCount = expectedBuilt.items.filter((item) => item.layer === 'short').length
    const commonArgs = ['--character-id', 'ophelia', '--characters-dir', charactersDir]
    const runCli = (extraArgs) =>
      spawnSync(process.execPath, [SCRIPT_FILE, ...commonArgs, ...extraArgs], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })

    const dryRun = runCli([])
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.match(dryRun.stdout, /DRY-RUN/u)
    assert.match(dryRun.stdout, /未写入任何文件/u)
    assert.ok(!fs.existsSync(path.join(memoryDir, 'short-term.json')), '默认 dry-run 不应创建记忆文件')
    assert.ok(!fs.existsSync(memoryDir), '默认 dry-run 不应创建记忆目录')

    const write = runCli(['--write'])
    assert.equal(write.status, 0, write.stderr)
    assert.match(write.stdout, new RegExp(`created=${expectedCount}`, 'u'))
    assert.match(write.stdout, /skipped=0/u)
    assert.ok(fs.existsSync(path.join(memoryDir, 'short-term.json')))
    assert.ok(fs.existsSync(path.join(memoryDir, '记忆总览.md')))
    assert.ok(readTextFile(path.join(memoryDir, '记忆总览.md')).includes('| 发生时间 |'))
    const persisted = []
    for (let layer = 1; layer <= 7; layer += 1) {
      const doc = readJsonFile(path.join(memoryDir, 'long-term', `layer-${layer}.json`))
      persisted.push(...doc.items)
    }
    const seededShort = readJsonFile(path.join(memoryDir, 'short-term.json')).items
    assert.equal(persisted.length + seededShort.length, expectedCount, `长期层 + 短期应覆盖 ${expectedCount} 条`)
    assert.equal(seededShort.length, expectedShortCount, '短期条目数应等于未来事件数')

    const again = runCli(['--write'])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /created=0/u)
    assert.match(again.stdout, new RegExp(`skipped=${expectedCount}`, 'u'))

    // 人设文件缺失时清晰报错（退出码 1）
    const missing = runCli(['--character-id', 'ghost', '--characters-dir', charactersDir])
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /人设文件不存在/u)
  },
)
