/**
 * 覆盖验收编号：M13（持久化与可读性）、M14（摘要注入）。
 * 对应 验收/验收标准.md A. 记忆模块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { formatLocalDate } from '../../lib/shared/clock.js'
import {
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

const EXPECTED_FILES = [
  'memory/short-term.json',
  'memory/meta.json',
  'memory/index.json',
  'memory/记忆总览.md',
  'memory/events.jsonl',
  'memory/long-term/layer-1.json',
  'memory/long-term/layer-2.json',
  'memory/long-term/layer-3.json',
  'memory/long-term/layer-4.json',
  'memory/long-term/layer-5.json',
  'memory/long-term/layer-6.json',
  'memory/long-term/layer-7.json',
]

function buildPersistedEngine(t) {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  engine.remember({ content: '主人喜欢夜里听雨声。', keywords: ['雨声', '夜晚', '喜欢'] })
  engine.ingestMessage({
    text: '我喜欢草莓蛋糕',
    messageId: 'm-persist-1',
    role: 'user',
    at: isoOf(clock.advance(60_000)),
  })
  engine.maintain({ at: localMs(2026, 11, 6, 4, 30), reason: '每日凌晨维护窗口' })
  return ctx
}

test('M13 持久化目录与文件齐全，JSON 为 UTF-8 / 2 空格缩进 / 末尾换行，内容中文', (t) => {
  const ctx = buildPersistedEngine(t)
  const files = listFilesRecursive(ctx.dataDir)
  for (const expected of EXPECTED_FILES) {
    assert.ok(files.includes(expected), `缺少持久化文件 ${expected}`)
  }
  assert.ok(
    files.every((file) => !file.includes('.tmp')),
    '原子写入不应残留临时文件',
  )

  const jsonFiles = files.filter((file) => file.endsWith('.json'))
  for (const relative of jsonFiles) {
    const raw = readTextFile(path.join(ctx.dataDir, relative))
    assert.ok(raw.endsWith('\n'), `${relative} 文件末尾应有换行`)
    assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2) + '\n', `${relative} 应为 2 空格缩进 JSON`)
  }
  // 含记忆数据的文件必须是中文 UTF-8 内容
  for (const relative of ['memory/long-term/layer-1.json', 'memory/meta.json', 'memory/index.json']) {
    assert.match(readTextFile(path.join(ctx.dataDir, relative)), /[\u4e00-\u9fa5]/u, `${relative} 应包含中文内容`)
  }

  const shortDoc = readJsonFile(path.join(ctx.memoryDir, 'short-term.json'))
  assert.equal(shortDoc.schemaVersion, 1)
  assert.equal(shortDoc.capacity, 20)
  assert.deepEqual(shortDoc.items, [], '夜间转移后短期文件应为空')
  assert.equal(typeof shortDoc.updatedAt, 'string')

  const layerDoc = readJsonFile(path.join(ctx.memoryDir, 'long-term', 'layer-1.json'))
  assert.equal(layerDoc.schemaVersion, 1)
  assert.equal(layerDoc.layer, 1)
  assert.ok(layerDoc.items.length >= 2)
  assert.ok(layerDoc.items.some((item) => item.content === '主人喜欢夜里听雨声。'))

  const meta = readJsonFile(path.join(ctx.memoryDir, 'meta.json'))
  for (const field of [
    'schemaVersion',
    'createdAt',
    'updatedAt',
    'lastMaintenanceAt',
    'lastMaintenanceDateKey',
    'lastMaintenanceReason',
    'maintenanceHistory',
    'processedMessageIds',
    'sequence',
  ]) {
    assert.ok(field in meta, `meta.json 缺少字段 ${field}`)
  }
  assert.equal(meta.lastMaintenanceReason, '每日凌晨维护窗口')
  assert.equal(meta.lastMaintenanceDateKey, formatLocalDate(localMs(2026, 11, 6, 4, 30)))
  assert.ok(meta.maintenanceHistory.length >= 1)
  assert.ok(meta.processedMessageIds.includes('m-persist-1'))
  assert.ok(meta.sequence >= 2)

  const index = readJsonFile(path.join(ctx.memoryDir, 'index.json'))
  assert.equal(index.schemaVersion, 1)
  assert.equal(typeof index.keywords, 'object')
  assert.equal(typeof index.categories, 'object')
  assert.equal(typeof index.layers, 'object')
  assert.equal(index.layers.short, 0)
  assert.equal(index.layers[1], layerDoc.items.length)
  assert.ok(Object.keys(index.keywords).length > 0)
  assert.ok(index.keywords['雨声'].includes(layerDoc.items[0].id))

  const overview = readTextFile(path.join(ctx.memoryDir, '记忆总览.md'))
  assert.ok(overview.includes('# 记忆总览'))
  assert.ok(overview.includes('## 短期记忆'))
  assert.ok(overview.includes('## 长期记忆'))
  assert.ok(overview.includes('## 关键词索引'))
  assert.ok(overview.includes('| 编号 | 摘要 | 分类 | 关键词 |'))
  assert.ok(overview.includes('主人喜欢夜里听雨声。'))

  const eventLines = readTextFile(path.join(ctx.memoryDir, 'events.jsonl'))
    .trim()
    .split('\n')
    .filter(Boolean)
  assert.ok(eventLines.length >= 3, 'events.jsonl 应记录多条事件')
  for (const line of eventLines) {
    const event = JSON.parse(line)
    assert.equal(typeof event.at, 'string')
    assert.equal(typeof event.type, 'string')
    assert.equal(typeof event.message, 'string')
    assert.match(event.message, /[\u4e00-\u9fa5]/u, '事件日志应为中文可读')
  }
  assert.ok(eventLines.some((line) => JSON.parse(line).type === 'maintenance'))
})

test('M13 重启（新引擎实例）后数据完整、编号连续、事件继续追加', (t) => {
  const ctx = buildPersistedEngine(t)
  const { engine } = ctx
  const statusBefore = engine.status()
  const shortBefore = engine.listLayer('short')
  const layer1Before = engine.listLayer(1)
  const maxSequence = Math.max(
    0,
    ...[...shortBefore, ...layer1Before].map((item) => Number(/^mem-(\d+)$/u.exec(item.id)[1])),
  )
  const eventsBefore = readTextFile(path.join(ctx.memoryDir, 'events.jsonl')).trim().split('\n').filter(Boolean).length

  const reopened = reopenEngine(ctx.dataDir, { start: localMs(2026, 11, 6, 5, 0) })
  const statusAfter = reopened.engine.status()
  assert.equal(statusAfter.dataDir, statusBefore.dataDir)
  assert.deepEqual(statusAfter.counts, statusBefore.counts)
  assert.equal(statusAfter.total, statusBefore.total)
  assert.equal(statusAfter.lastMaintenanceAt, statusBefore.lastMaintenanceAt)
  assert.equal(statusAfter.lastMaintenanceDateKey, statusBefore.lastMaintenanceDateKey)
  assert.deepEqual(
    reopened.engine.listLayer('short').map((item) => item.id),
    shortBefore.map((item) => item.id),
  )
  assert.deepEqual(
    reopened.engine.listLayer(1).map((item) => item.id),
    layer1Before.map((item) => item.id),
  )
  const rainItem = layer1Before.find((item) => item.content.includes('雨声'))
  assert.equal(reopened.engine.getItem(rainItem.id).content, rainItem.content)
  assert.equal(reopened.engine.getItem(rainItem.id).keywords.join('、'), rainItem.keywords.join('、'))

  // 重启后关键词检索仍可用
  assert.ok(reopened.engine.recall('雨声').hits.some((hit) => hit.item.id === rainItem.id))

  // 编号从已有最大序号继续自增
  const created = reopened.engine.remember({
    content: '重启之后新增的记忆。',
    keywords: ['重启', '新增', '测试'],
  }).item
  assert.equal(Number(/^mem-(\d+)$/u.exec(created.id)[1]), maxSequence + 1)

  // 事件日志继续追加且可逐行解析
  const eventsAfter = readTextFile(path.join(ctx.memoryDir, 'events.jsonl')).trim().split('\n').filter(Boolean)
  assert.ok(eventsAfter.length > eventsBefore)
  for (const line of eventsAfter) JSON.parse(line)
})

test('M13 原子写入：连续写入后无临时文件残留且文件始终可解析', (t) => {
  const ctx = createEngine({ config: { shortTermCapacity: 100 } })
  t.after(ctx.cleanup)
  const { engine, clock, dataDir } = ctx
  for (let index = 0; index < 15; index += 1) {
    clock.advance(60_000)
    engine.remember({ content: `原子写入测试第${index + 1}条记忆。`, keywords: ['原子', '写入', `第${index + 1}条`] })
    engine.writeOverview()
    const files = listFilesRecursive(dataDir)
    assert.ok(files.every((file) => !file.includes('.tmp')), '写入过程中不应留下临时文件')
    for (const relative of files.filter((file) => file.endsWith('.json'))) {
      JSON.parse(readTextFile(path.join(dataDir, relative)))
    }
  }
})

test('M14 空记忆库摘要给出「第一次对话」提示且长度不超限', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const digest = ctx.engine.renderDigest({ latestUserText: '你好呀' })
  assert.ok(digest.includes('（记忆库还是空的，这是你们的第一次对话。）'))
  assert.ok(digest.includes('memory_note'))
  assert.ok(digest.length <= 30000)
})

test('M14 摘要含短期记忆、长期命中、概况与检索提示', (t) => {
  const ctx = createEngine({ start: localMs(2026, 11, 5, 4, 30) })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  engine.remember({ content: '主人喜欢夜里听雨声。', keywords: ['雨声', '夜晚', '喜欢'] })
  engine.maintain({ at: clock.now(), reason: '每日凌晨维护窗口' })
  clock.set(localMs(2026, 11, 5, 10, 0))
  engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['草莓蛋糕', '喜欢', '蛋糕'] })

  const digest = engine.renderDigest({ latestUserText: '雨声' })
  assert.ok(digest.includes('【记忆系统 · 自动注入】') || digest.includes('【记忆'))
  assert.ok(digest.includes('【最近短期记忆】'))
  assert.ok(!digest.includes('【长期记忆命中】'), '长期命中项应先挪回短期，不再走长期命中段')
  assert.ok(digest.includes('【长期记忆概况】'))
  assert.ok(digest.includes('【检索提示】'))
  assert.ok(digest.includes('memory_recall'))
  assert.ok(digest.includes('memory_note'))
  assert.ok(digest.includes('主人喜欢草莓蛋糕。'))
  assert.ok(digest.includes('主人喜欢夜里听雨声。'))
  assert.ok(digest.length <= 30000)
})

test('M14 摘要长度严格不超过 maxChars，且保留标题与检索提示', (t) => {
  const ctx = createEngine({ config: { shortTermCapacity: 100 } })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  for (let index = 0; index < 12; index += 1) {
    clock.advance(60_000)
    engine.remember({
      content: `这是第${index + 1}条很长的记忆内容，用来验证摘要超长时的裁剪逻辑，主人希望记住这段详细的描述。`,
      keywords: ['长内容', `第${index + 1}条`, '裁剪'],
    })
  }
  const digest = engine.renderDigest({ latestUserText: '长内容', maxChars: 300 })
  assert.ok(digest.length <= 300, `摘要长度 ${digest.length} 应不超过 300`)
  assert.ok(digest.includes('【记忆系统 · 自动注入】'))
  assert.ok(digest.includes('【检索提示】'))
  assert.ok(digest.includes('memory_note'))

  const tiny = engine.renderDigest({ latestUserText: '长内容', maxChars: 60 })
  assert.ok(tiny.length <= 60)

  const defaultDigest = engine.renderDigest({ latestUserText: '长内容' })
  assert.ok(defaultDigest.length <= 30000)
})

test('M14 短期记忆摘要按 importance 降序最多 50 条', (t) => {
  const startMs = localMs(2026, 11, 10, 10, 0)
  const short = []
  const mentionCounts = [6, 5, 4, 3, 2, 1, 1, 1, 1, 1]
  for (let index = 0; index < 10; index += 1) {
    short.push(
      makeItem({
        id: `mem-${String(index + 1).padStart(6, '0')}`,
        content: index === 0 ? '最高重要的记忆内容。' : `第${index + 1}条普通记忆内容。`,
        summary: index === 0 ? '最高重要的记忆内容。' : `第${index + 1}条普通记忆内容。`,
        keywords: ['记忆', `第${index + 1}条`, '内容'],
        category: '事件',
        mentionCount: mentionCounts[index],
        emphasis: index === 0 ? 3 : 0,
        firstSeenAt: isoOf(startMs - index * 60_000),
      }),
    )
  }
  const ctx = seedEngine({ start: startMs, short })
  t.after(ctx.cleanup)
  const digest = ctx.engine.renderDigest({ latestUserText: '' })
  const lines = digest.split('\n')
  const start = lines.indexOf('【最近短期记忆】')
  assert.ok(start >= 0)
  const end = lines.findIndex(
    (line, index) => index > start && (line === '【长期记忆命中】' || line === '【长期记忆概况】'),
  )
  const itemLines = lines.slice(start + 1, end).filter((line) => line.startsWith('- '))
  assert.equal(itemLines.length, 10, '短期记忆摘要最多 50 条；当前 10 条应全部包含')
  assert.ok(itemLines[0].includes('最高重要的记忆内容。'), 'importance 最高的记忆应排在首位')
})

test('M14 摘要按清晰度分档渲染（清晰显示完整内容，模糊显示提示）', (t) => {
  const startMs = localMs(2026, 11, 10, 10, 0)
  const short = [
    makeItem({
      id: 'mem-000001',
      content: '主人最喜欢草莓蛋糕，生日那天要买。',
      summary: '主人最喜欢草莓蛋糕，生日那天要买。',
      keywords: ['草莓蛋糕', '喜欢', '生日'],
      category: '喜好',
      mentionCount: 5,
      firstSeenAt: isoOf(startMs - 120_000),
    }),
    makeItem({
      id: 'mem-000002',
      content: '主人喜欢夜里听雨声。',
      summary: '主人喜欢夜里听雨声。',
      keywords: ['雨声', '夜晚', '喜欢'],
      category: '喜好',
      mentionCount: 1,
      firstSeenAt: isoOf(startMs - 60_000),
    }),
  ]
  const ctx = seedEngine({ start: startMs, short })
  t.after(ctx.cleanup)
  const digest = ctx.engine.renderDigest({ latestUserText: '' })
  // 高清晰（importance 70 → clarity 0.7）：完整内容 + 关键词 + 首次时间
  assert.ok(digest.includes('主人最喜欢草莓蛋糕，生日那天要买。'))
  assert.ok(digest.includes('关键词：草莓蛋糕、喜欢、生日'))
  assert.ok(digest.includes('首次：'))
  // 低清晰：模糊提示
  assert.ok(digest.includes('…（记忆有些模糊）'))
})
