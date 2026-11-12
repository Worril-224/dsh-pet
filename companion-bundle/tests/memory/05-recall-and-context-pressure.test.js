/**
 * 覆盖验收编号：M10（分级检索）、M11（上下文紧张压缩）。
 * 对应 验收/验收标准.md A. 记忆模块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, isoOf, localMs, makeItem, seedEngine } from './_helpers.mjs'

function seedRecallData() {
  const startMs = localMs(2026, 11, 10, 10, 0)
  const short = [
    makeItem({
      id: 'mem-000001',
      content: '主人喜欢草莓蛋糕。',
      summary: '主人喜欢草莓蛋糕。',
      keywords: ['草莓蛋糕', '喜欢', '蛋糕'],
      category: '喜好',
      mentionCount: 3,
      firstSeenAt: isoOf(localMs(2026, 11, 9, 10, 0)),
    }),
    makeItem({
      id: 'mem-000002',
      content: '主人今天心情很好。',
      summary: '主人今天心情很好。',
      keywords: ['心情', '很好', '今天'],
      category: '情绪',
      mentionCount: 1,
      firstSeenAt: isoOf(localMs(2026, 11, 8, 10, 0)),
    }),
  ]
  const layers = Array.from({ length: 7 }, () => [])
  layers[0] = [
    makeItem({
      id: 'mem-000003',
      content: '主人喜欢苹果。',
      summary: '主人喜欢苹果。',
      keywords: ['苹果', '喜欢', '水果'],
      category: '喜好',
      layer: 1,
      mentionCount: 1,
      firstSeenAt: isoOf(localMs(2026, 11, 1, 10, 0)),
    }),
  ]
  layers[1] = [
    makeItem({
      id: 'mem-000004',
      content: '主人喜欢香蕉。',
      summary: '主人喜欢香蕉。',
      keywords: ['香蕉', '喜欢', '水果'],
      category: '喜好',
      layer: 2,
      mentionCount: 1,
      firstSeenAt: isoOf(localMs(2026, 10, 20, 10, 0)),
    }),
  ]
  layers[3] = [
    makeItem({
      id: 'mem-000005',
      content: '主人喜欢橙子。',
      summary: '主人喜欢橙子。',
      keywords: ['橙子', '喜欢', '水果'],
      category: '喜好',
      layer: 4,
      mentionCount: 1,
      firstSeenAt: isoOf(localMs(2026, 10, 1, 10, 0)),
    }),
  ]
  layers[6] = [
    makeItem({
      id: 'mem-000006',
      content: '主人喜欢葡萄。',
      summary: '主人喜欢葡萄。',
      keywords: ['葡萄', '喜欢', '水果'],
      category: '喜好',
      layer: 7,
      mentionCount: 1,
      firstSeenAt: isoOf(localMs(2026, 9, 1, 10, 0)),
    }),
  ]
  return seedEngine({ start: startMs, short, layers })
}

test('M10 检索顺序为 短期 → 第一层 → … → 第七层，命中满足 limit 前继续逐层检索', (t) => {
  const ctx = seedRecallData()
  t.after(ctx.cleanup)
  const { engine } = ctx

  const result = engine.recall('苹果')
  assert.equal(result.query, '苹果')
  assert.equal(result.searchedLayers[0], 'short', '必须先从短期记忆开始检索')
  assert.deepEqual(result.searchedLayers, ['short', 1, 2, 3, 4, 5, 6, 7])
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0].layer, 1)
  assert.equal(result.hits[0].layerLabel, '第一层')
  assert.ok(result.hits[0].score > 0)
  assert.equal(result.stoppedAt, null)
  assert.equal(result.exhausted, true)

  const multi = engine.recall('我想吃苹果香蕉橙子葡萄')
  assert.deepEqual(
    multi.hits.map((hit) => hit.layer),
    [1, 2, 4, 7],
    '命中结果应按层级从高到低排列',
  )
  assert.deepEqual(multi.searchedLayers, ['short', 1, 2, 3, 4, 5, 6, 7])
  assert.equal(multi.exhausted, true)
})

test('M10 达到 limit 提前停止，stoppedAt 记录停止层级', (t) => {
  const ctx = seedRecallData()
  t.after(ctx.cleanup)
  const { engine } = ctx

  const two = engine.recall('我想吃苹果香蕉橙子葡萄', { limit: 2 })
  assert.equal(two.hits.length, 2)
  assert.deepEqual(two.hits.map((hit) => hit.layer), [1, 2])
  assert.deepEqual(two.searchedLayers, ['short', 1, 2])
  assert.equal(two.stoppedAt, 2)
  assert.equal(two.exhausted, false)

  const one = engine.recall('苹果香蕉橙子葡萄', { limit: 1 })
  assert.equal(one.hits.length, 1)
  assert.equal(one.hits[0].layer, 1)
  assert.deepEqual(one.searchedLayers, ['short', 1])
  assert.equal(one.stoppedAt, 1)
  assert.equal(one.exhausted, false)
})

test('M10 空 query 返回短期 + 第一层按 importance 降序的前 limit 条', (t) => {
  const ctx = seedRecallData()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const result = engine.recall('')
  assert.equal(result.query, '')
  assert.equal(result.hits.length, 3)
  assert.ok(result.hits.every((hit) => hit.layer === 'short' || hit.layer === 1))
  assert.ok(result.hits[0].item.importance >= result.hits[1].item.importance)
  assert.equal(result.hits[0].item.id, 'mem-000001')
  assert.deepEqual(result.searchedLayers, ['short', 1])

  const limited = engine.recall('', { limit: 1 })
  assert.equal(limited.hits.length, 1)
  assert.equal(limited.hits[0].item.id, 'mem-000001')
})

test('M10 分类名命中与关键词命中均可检索（含跨层）', (t) => {
  const ctx = seedRecallData()
  t.after(ctx.cleanup)
  const { engine } = ctx

  const byCategory = engine.recall('喜好')
  assert.ok(byCategory.hits.length >= 5, '分类名应命中所有「喜好」分类记忆')
  assert.ok(byCategory.hits.every((hit) => hit.item.category === '喜好'))
  assert.ok(byCategory.hits.some((hit) => hit.layer === 4))

  const byKeyword = engine.recall('葡萄')
  assert.equal(byKeyword.hits.length, 1)
  assert.equal(byKeyword.hits[0].layer, 7)
  assert.equal(byKeyword.hits[0].layerLabel, '第七层')
  assert.equal(byKeyword.hits[0].item.content, '主人喜欢葡萄。')
})

test('M10 检索结果 item 字段齐全', (t) => {
  const ctx = seedRecallData()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const hit = engine.recall('苹果').hits[0]
  for (const field of ['content', 'summary', 'clarity', 'keywords', 'firstSeenAt', 'mentionCount', 'layer']) {
    assert.ok(field in hit.item, `命中 item 缺少字段 ${field}`)
  }
  assert.ok(Array.isArray(hit.item.keywords))
  assert.equal(typeof hit.score, 'number')
  assert.equal(typeof hit.layerLabel, 'string')
})

test('M10 内容命中（query 长度>=2）与短期优先于长期', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  engine.remember({ content: '主人喜欢夜里听雨声。', keywords: ['雨声', '夜晚', '喜欢'] })
  engine.maintain({ at: localMs(2026, 11, 6, 4, 30), reason: '每日凌晨维护窗口' })
  engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['草莓蛋糕', '喜欢', '蛋糕'] })

  // 只有内容包含「夜里」才能命中（关键词中「夜晚」不含「夜里」）
  const contentHit = engine.recall('夜里')
  assert.equal(contentHit.hits.length, 1)
  assert.equal(contentHit.hits[0].layer, 1)
  assert.match(contentHit.hits[0].item.content, /夜里听雨声/u)

  // 短期记忆优先于长期记忆
  const both = engine.recall('喜欢')
  assert.equal(both.hits[0].layer, 'short')
  assert.equal(both.hits[0].layerLabel, '短期记忆')
  assert.equal(both.hits[1].layer, 1)
})

test('M10 无命中时返回空 hits 且 exhausted=true', (t) => {
  const ctx = seedRecallData()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const result = engine.recall('完全不存在的内容')
  assert.deepEqual(result.hits, [])
  assert.deepEqual(result.searchedLayers, ['short', 1, 2, 3, 4, 5, 6, 7])
  assert.equal(result.exhausted, true)
  assert.equal(result.stoppedAt, null)
})

test('M11 上下文压缩按 importance 保留一半并写入短期记忆', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const candidates = [
    { content: '候选信息一：主人喜欢草莓蛋糕。', importance: 60 },
    { content: '候选信息二：主人喜欢夜里听雨声。', importance: 90 },
    { content: '候选信息三：主人今天去了公园。', importance: 50 },
    { content: '候选信息四：主人下周要考试。', importance: 80 },
    { content: '候选信息五：主人喜欢喝热牛奶。', importance: 70 },
  ]
  const result = engine.handleContextPressure(candidates, { keepRatio: 0.5 })
  assert.equal(result.total, 5)
  assert.equal(result.kept, 3)
  assert.equal(result.dropped, 2)
  assert.equal(result.stored.length, 3)

  const storedItems = result.stored.map((id) => engine.getItem(id))
  assert.ok(storedItems.every((item) => item))
  for (const item of storedItems) {
    assert.equal(item.source, 'context_pressure')
    assert.equal(item.category, '其他', '未指定分类时上下文压缩条目分类默认「其他」')
    assert.ok(item.content.startsWith('候选信息'))
  }
  const keptContents = storedItems.map((item) => item.content).sort()
  assert.deepEqual(
    keptContents,
    ['候选信息二：主人喜欢夜里听雨声。', '候选信息四：主人下周要考试。', '候选信息五：主人喜欢喝热牛奶。'].sort(),
    '应保留 importance 最高的 3 条',
  )
  const shortContents = engine.listLayer('short').map((item) => item.content)
  assert.ok(!shortContents.includes('候选信息一：主人喜欢草莓蛋糕。'))
  assert.ok(!shortContents.includes('候选信息三：主人今天去了公园。'))
})

test('M11 keepRatio=1 全部保留；默认 keepRatio=0.5；空数组安全', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const candidates = [1, 2, 3, 4].map((index) => ({ content: `压缩候选${index}号内容。`, importance: index * 10 }))
  const all = engine.handleContextPressure(candidates, { keepRatio: 1 })
  assert.equal(all.kept, 4)
  assert.equal(all.dropped, 0)

  const ctx2 = createEngine()
  t.after(ctx2.cleanup)
  const defaultHalf = ctx2.engine.handleContextPressure(candidates)
  assert.equal(defaultHalf.kept, 2)
  assert.equal(defaultHalf.dropped, 2)

  assert.deepEqual(engine.handleContextPressure([]), { total: 0, kept: 0, dropped: 0, stored: [] })
  const single = ctx2.engine.handleContextPressure([{ content: '单独一条候选内容。', importance: 10 }])
  assert.equal(single.total, 1)
  assert.equal(single.kept, 1)
  assert.equal(single.dropped, 0)
})

test('M11 上下文压缩写入后触发短期记忆容量溢出转移', (t) => {
  const ctx = createEngine({ config: { shortTermCapacity: 2 } })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  engine.remember({ content: '主人原有的短期记忆。', keywords: ['原有', '短期', '记忆'] })
  const candidates = [
    { content: '压缩候选甲：主人喜欢草莓蛋糕。', importance: 90 },
    { content: '压缩候选乙：主人喜欢夜里听雨声。', importance: 80 },
    { content: '压缩候选丙：主人喜欢热牛奶。', importance: 70 },
  ]
  const result = engine.handleContextPressure(candidates, { keepRatio: 1 })
  assert.equal(result.kept, 3)
  // 原有 1 条 + 新增 3 条 = 4 条 > 容量 2 → 转移 floor(4/2)=2 条到第一层
  assert.equal(engine.listLayer('short').length, 2)
  const layer1 = engine.listLayer(1)
  assert.equal(layer1.length, 2)
  for (const item of layer1) {
    const lastHistory = item.history[item.history.length - 1]
    assert.ok(lastHistory.reason.includes('最早的一半'), `溢出原因不符：${lastHistory.reason}`)
  }
  // 转移的是最早的两条：原有记忆 + 最早写入的候选甲
  assert.ok(layer1.some((item) => item.content === '主人原有的短期记忆。'))
  assert.ok(layer1.some((item) => item.content === '压缩候选甲：主人喜欢草莓蛋糕。'))
})

test('M11 与已有记忆重复的候选改为提及，不重复写入', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const existing = engine.remember({
    content: '主人喜欢草莓蛋糕。',
    keywords: ['草莓蛋糕', '喜欢', '蛋糕'],
  }).item
  const result = engine.handleContextPressure([{ content: '主人喜欢草莓蛋糕。', importance: 90 }], { keepRatio: 1 })
  assert.equal(result.kept, 1)
  assert.deepEqual(result.stored, [existing.id])
  assert.equal(engine.getItem(existing.id).mentionCount, 2)
  assert.equal(engine.listLayer('short').length, 1)
})

test('M11 调用方显式给出的合法分类会保留', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const result = engine.handleContextPressure(
    [
      { content: '候选：主人喜欢热牛奶。', importance: 50, category: '喜好', keywords: ['热牛奶', '喜欢', '饮品'] },
      { content: '候选：主人今天去了公园。', importance: 40 },
    ],
    { keepRatio: 1 },
  )
  const items = result.stored.map((id) => engine.getItem(id))
  assert.equal(items.find((item) => item.content.includes('热牛奶')).category, '喜好')
  assert.equal(items.find((item) => item.content.includes('公园')).category, '其他')
})
