/**
 * 覆盖验收编号：M6（短期记忆溢出）、M7（每日夜间转移）。
 * 对应 验收/验收标准.md A. 记忆模块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { computeClarity, computeImportance } from '../../lib/memory/model.js'
import { CATEGORY_ENUM, createEngine, isoOf, localMs, makeItem, readJsonFile, readTextFile, seedEngine } from './_helpers.mjs'

test('M6 默认容量 20：第 21 条新增后最早的 floor(21/2)=10 条转入长期第一层', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  for (let i = 1; i <= 21; i += 1) {
    clock.advance(60_000)
    const result = engine.remember({
      content: `主人第${i}次提到的测试记忆。`,
      keywords: ['测试', `第${i}次`, '记忆'],
    })
    assert.equal(result.action, 'created')
  }
  const shortItems = engine.listLayer('short')
  const layer1 = engine.listLayer(1)
  assert.equal(shortItems.length, 11)
  assert.equal(layer1.length, 10)
  assert.equal(engine.status().counts.short, 11)
  assert.equal(engine.status().counts.layers[0], 10)
  assert.equal(engine.status().total, 21)

  // 转移的是最早创建的 10 条
  const movedIds = layer1.map((item) => item.id).sort()
  const expectedIds = Array.from({ length: 10 }, (_, index) => `mem-${String(index + 1).padStart(6, '0')}`)
  assert.deepEqual(movedIds, expectedIds.sort())
  assert.ok(shortItems.every((item) => !expectedIds.includes(item.id)))
})

test('M6 自定义容量 5：溢出后最早的 floor(6/2)=3 条进入第一层，history 记录原因', (t) => {
  const ctx = createEngine({ config: { shortTermCapacity: 5 } })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const created = []
  for (let i = 1; i <= 6; i += 1) {
    clock.advance(60_000)
    created.push(engine.remember({ content: `主人第${i}条短期记忆。`, keywords: ['短期', `第${i}条`, '记忆'] }).item)
  }
  assert.equal(engine.listLayer('short').length, 3)
  assert.equal(engine.listLayer(1).length, 3)

  const moved = engine.listLayer(1)
  assert.deepEqual(
    moved.map((item) => item.id).sort(),
    [created[0].id, created[1].id, created[2].id].sort(),
  )
  for (const item of moved) {
    assert.equal(item.layer, 1)
    const lastHistory = item.history[item.history.length - 1]
    assert.equal(lastHistory.from, 'short')
    assert.equal(lastHistory.to, 1)
    assert.ok(lastHistory.reason.includes('最早的一半'), `history 原因不合规：${lastHistory.reason}`)
    assert.equal(item.lastLayerChangeAt, lastHistory.at)
    assert.equal(item.history.length, 1)
  }
})

test('M6 转移后第一层条目的 importance 按层级加成重新计算', (t) => {
  const ctx = createEngine({ config: { shortTermCapacity: 2 } })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const first = engine.remember({ content: '主人喜欢夜里听雨声。', keywords: ['雨声', '夜晚', '喜欢'] }).item
  clock.advance(60_000)
  engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['草莓蛋糕', '喜欢', '蛋糕'] })
  clock.advance(60_000)
  engine.remember({ content: '主人喜欢热牛奶。', keywords: ['热牛奶', '喜欢', '饮品'] })
  // n=3 > 2 → 转移 floor(3/2)=1 条（最早的「雨声」记忆）
  const moved = engine.getItem(first.id)
  assert.equal(moved.layer, 1)
  assert.equal(moved.importance, computeImportance(moved))
  assert.equal(moved.clarity, computeClarity(moved.importance))
  assert.equal(moved.importance, Math.min(100, 20 + 10 * Math.min(moved.mentionCount, 6) + 10 * Math.min(moved.emphasis, 3) + 24))
})

test('M6 至少转移 1 条：容量 1 时溢出只转 1 条而不是全部', (t) => {
  const ctx = createEngine({ config: { shortTermCapacity: 1 } })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  engine.remember({ content: '主人第一条记忆。', keywords: ['第一条', '记忆', '测试'] })
  clock.advance(60_000)
  engine.remember({ content: '主人第二条记忆。', keywords: ['第二条', '记忆', '测试'] })
  assert.equal(engine.listLayer('short').length, 1)
  assert.equal(engine.listLayer(1).length, 1)
})

test('M7 每日夜间转移：短期记忆全部清空并进入第一层', (t) => {
  const ctx = createEngine({ start: localMs(2026, 11, 5, 10, 0) })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const ids = []
  for (const [index, content] of ['主人喜欢夜里听雨声。', '主人喜欢草莓蛋糕。', '主人今天去公园散步。'].entries()) {
    clock.advance(60_000)
    ids.push(engine.remember({ content, keywords: ['测试', `第${index + 1}条`, '记忆'] }).item.id)
  }
  assert.equal(engine.listLayer('short').length, 3)

  const report = engine.maintain({ at: localMs(2026, 11, 6, 4, 30), reason: '每日凌晨维护窗口' })
  assert.equal(report.transferred, 3)
  assert.equal(report.shortCount, 0)
  assert.equal(engine.listLayer('short').length, 0)
  const layer1 = engine.listLayer(1)
  assert.equal(layer1.length, 3)
  assert.deepEqual(layer1.map((item) => item.id).sort(), ids.sort())

  for (const item of layer1) {
    assert.equal(item.layer, 1)
    const lastHistory = item.history[item.history.length - 1]
    assert.equal(lastHistory.from, 'short')
    assert.equal(lastHistory.to, 1)
    assert.equal(lastHistory.reason, '每日夜间转移')
    assert.equal(item.mentionCountAtLastMaintenance, item.mentionCount)
    assert.equal(item.lastLayerChangeAt, lastHistory.at)
  }

  const status = engine.status()
  assert.equal(status.counts.short, 0)
  assert.equal(status.counts.layers.length, 7)
  assert.deepEqual(status.counts.layers, [3, 0, 0, 0, 0, 0, 0])
  assert.equal(status.lastMaintenanceDateKey, isoOf(localMs(2026, 11, 6, 4, 30)).slice(0, 10))
})

test('M7 维护时补齐关键词与分类，并重建 index.json / 记忆总览.md', (t) => {
  const seeded = makeItem({
    id: 'mem-000001',
    content: '主人喜欢夜里听雨声。',
    keywords: ['雨声'],
    category: '其他',
    mentionCount: 2,
    firstSeenAt: isoOf(localMs(2026, 11, 1, 10, 0)),
  })
  const ctx = seedEngine({ start: localMs(2026, 11, 5, 4, 30), short: [seeded] })
  t.after(ctx.cleanup)
  const { engine, memoryDir } = ctx

  engine.maintain({ at: localMs(2026, 11, 5, 4, 30), reason: '每日凌晨维护窗口' })
  const item = engine.listLayer(1)[0]
  assert.ok(item.keywords.length >= 3 && item.keywords.length <= 5, '维护应把关键词补足到 3~5 个')
  assert.ok(CATEGORY_ENUM.includes(item.category), `分类 ${item.category} 不在枚举内`)

  // index.json 生成且内容正确
  const index = readJsonFile(path.join(memoryDir, 'index.json'))
  assert.equal(index.schemaVersion, 1)
  assert.ok(index.keywords && typeof index.keywords === 'object')
  assert.ok(index.categories && typeof index.categories === 'object')
  assert.ok(index.layers && typeof index.layers === 'object')
  assert.equal(index.layers.short, 0)
  assert.equal(index.layers[1], 1)
  for (const keyword of item.keywords.filter((word) => !word.startsWith('#'))) {
    assert.ok(Array.isArray(index.keywords[keyword]), `index 缺少关键词 ${keyword}`)
    assert.ok(index.keywords[keyword].includes(item.id))
  }
  assert.ok(Array.isArray(index.categories[item.category]))

  // 记忆总览.md 为中文表格
  const overview = readTextFile(path.join(memoryDir, '记忆总览.md'))
  assert.ok(overview.includes('# 记忆总览'))
  assert.ok(overview.includes('| 编号 |'))
  assert.ok(overview.includes('摘要'))
  assert.ok(overview.includes('关键词'))
  assert.ok(overview.includes('主人喜欢夜里听雨声。'))
  assert.ok(overview.includes('第一层'))

  // 短期记忆文件已清空，第一层文件包含该条目
  const shortDoc = readJsonFile(path.join(memoryDir, 'short-term.json'))
  assert.deepEqual(shortDoc.items, [])
  const layerDoc = readJsonFile(path.join(memoryDir, 'long-term', 'layer-1.json'))
  assert.equal(layerDoc.layer, 1)
  assert.equal(layerDoc.items.length, 1)
  assert.equal(layerDoc.items[0].id, item.id)
  assert.equal(layerDoc.items[0].history[0].reason, '每日夜间转移')
})
