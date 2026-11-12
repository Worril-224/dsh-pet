/**
 * 覆盖验收编号：M1（记忆字段完整性）、M2（关键词规则）、M3（重要性/清晰度公式）。
 * 对应 验收/验收标准.md A. 记忆模块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { computeClarity, computeImportance } from '../../lib/memory/model.js'
import { renderItemByClarity } from '../../lib/memory/render.js'
import { formatLocalIso } from '../../lib/shared/clock.js'
import { CATEGORY_ENUM, createEngine, isoOf, localMs } from './_helpers.mjs'

const ITEM_FIELDS = [
  'id',
  'content',
  'summary',
  'keywords',
  'category',
  'mentionCount',
  'emphasis',
  'importance',
  'clarity',
  'createdAt',
  'firstSeenAt',
  'lastMentionedAt',
  'layer',
  'mentionCountAtLastMaintenance',
  'lastLayerChangeAt',
  'history',
  'source',
]

test('M1 记忆字段完整性：remember 创建的条目含 SPEC 4.1 全部字段，内容为中文', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const atIso = formatLocalIso(clock.now())
  const content = '主人最喜欢草莓味蛋糕，生日那天一定要买。'
  const result = engine.remember({
    content,
    keywords: ['草莓蛋糕', '生日', '喜欢'],
    category: '喜好',
    emphasis: 1,
  })

  assert.equal(result.ok, true)
  assert.equal(result.action, 'created')
  const item = result.item
  for (const field of ITEM_FIELDS) assert.ok(field in item, `缺少字段 ${field}`)
  assert.match(item.id, /^mem-\d{6}$/u)
  assert.equal(item.content, content)
  assert.match(item.content, /[\u4e00-\u9fa5]/u, 'content 必须包含中文')
  assert.ok(item.summary.length > 0 && item.summary.length <= 30, 'summary 长度 1~30')
  assert.match(item.summary, /[\u4e00-\u9fa5]/u, 'summary 必须包含中文')
  assert.ok(Array.isArray(item.keywords))
  assert.ok(item.keywords.length >= 3 && item.keywords.length <= 6, 'keywords 必须 3~6 个（含生成日期）')
  assert.ok(item.keywords.every((word) => typeof word === 'string' && word.length > 0))
  assert.ok(CATEGORY_ENUM.includes(item.category), `分类 ${item.category} 不在枚举内`)
  assert.equal(item.category, '喜好')
  assert.equal(item.mentionCount, 1)
  assert.equal(item.emphasis, 1)
  assert.ok(Number.isInteger(item.importance) && item.importance >= 1 && item.importance <= 100)
  assert.ok(item.clarity >= 0.15 && item.clarity <= 1)
  assert.equal(item.firstSeenAt, atIso)
  assert.equal(item.lastMentionedAt, atIso)
  assert.equal(item.layer, 'short')
  assert.ok(Number.isInteger(item.mentionCountAtLastMaintenance))
  assert.ok(item.lastLayerChangeAt === null || typeof item.lastLayerChangeAt === 'string')
  assert.ok(Array.isArray(item.history))
  assert.equal(typeof item.source, 'string')
  assert.equal(item.source, 'tool:memory_note')

  // 落盘数据文件中的条目字段同样完整，且内容为中文 UTF-8
  const shortDoc = JSON.parse(fs.readFileSync(path.join(ctx.memoryDir, 'short-term.json'), 'utf8'))
  assert.equal(shortDoc.items.length, 1)
  for (const field of ITEM_FIELDS) assert.ok(field in shortDoc.items[0], `落盘条目缺少字段 ${field}`)
  assert.match(shortDoc.items[0].content, /草莓味蛋糕/u)
})

test('M1 自动抽取的记忆同样字段完整、历史/来源字段合法', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const atIso = formatLocalIso(clock.now())
  const result = engine.ingestMessage({
    text: '我喜欢草莓蛋糕',
    messageId: 'm-field-1',
    role: 'user',
    at: atIso,
  })
  assert.equal(result.created.length, 1)
  const item = result.created[0]
  for (const field of ITEM_FIELDS) assert.ok(field in item, `缺少字段 ${field}`)
  assert.equal(item.source, 'auto_extract')
  assert.equal(item.layer, 'short')
  assert.match(item.content, /[\u4e00-\u9fa5]/u)
  assert.equal(item.firstSeenAt, atIso)
  assert.equal(item.lastMentionedAt, atIso)
})

test('M1 listLayer/getItem 返回拷贝，外部修改不影响引擎内部状态', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const created = engine.remember({ content: '主人喜欢夜里听雨声。', keywords: ['雨声', '夜晚', '喜欢'] }).item

  const listed = engine.listLayer('short')
  assert.equal(listed.length, 1)
  listed[0].content = '被外部篡改'
  listed[0].keywords.push('篡改')
  const fetched = engine.getItem(created.id)
  assert.equal(fetched.content, created.content)
  assert.ok(!fetched.keywords.includes('篡改'))
  fetched.summary = '另一个篡改'
  assert.equal(engine.getItem(created.id).summary, created.summary)
})

test('M2 关键词 >5 时截断为前 5 个且顺序保留', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const keywords = ['一', '二', '三', '四', '五', '六', '七']
  const item = engine.remember({ content: '主人喜欢的东西很多。', keywords }).item
  assert.deepEqual(item.keywords, ['一', '二', '三', '四', '五', item.createdAt.slice(0, 10)])
})

test('M2 关键词 <3 时用抽取结果自动补足到 3~5 个，且调用方顺序不被重排', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const item = engine.remember({ content: '主人喜欢抹茶', keywords: ['抹茶'] }).item
  assert.ok(item.keywords.length >= 3 && item.keywords.length <= 6, '补足后应 3~6 个（含生成日期）')
  assert.equal(item.keywords[0], '抹茶', '调用方给出的关键词必须保持首位、不被重排')
  assert.ok(item.keywords.slice(0, -1).every((word) => /[\u4e00-\u9fa5#]/u.test(word)))
  assert.equal(item.keywords.at(-1), item.createdAt.slice(0, 10))
})

test('M2 恰好 3 个关键词时完全保留调用方顺序', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const item = engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['蛋糕', '草莓', '喜欢'] }).item
  assert.deepEqual(item.keywords, ['蛋糕', '草莓', '喜欢', item.createdAt.slice(0, 10)])
})

test('M2 # 开头的分类回填标签在提及匹配时被忽略', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const item = engine.remember({
    content: '主人喜欢抹茶蛋糕。',
    keywords: ['#喜好', '抹茶蛋糕', '抹茶'],
  }).item
  assert.equal(item.mentionCount, 1)

  // 文本只包含标签内容「喜好」，不应命中（# 标签忽略）
  const first = engine.ingestMessage({
    text: '这条消息只提到了喜好',
    messageId: 'm-tag-1',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(first.mentioned.length, 0)
  assert.equal(engine.getItem(item.id).mentionCount, 1)

  // 命中普通关键词则会计数
  engine.ingestMessage({
    text: '想吃抹茶蛋糕',
    messageId: 'm-tag-2',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(engine.getItem(item.id).mentionCount, 2)
  assert.equal(engine.getItem(item.id).emphasis, 0)
})

test('M2 自动抽取的记忆关键词为 3~5 个中文词', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const result = engine.ingestMessage({
    text: '我今天去公园散步了',
    messageId: 'm-keywords-1',
    role: 'user',
  })
  assert.equal(result.created.length, 1)
  const keywords = result.created[0].keywords
  assert.ok(keywords.length >= 3 && keywords.length <= 6)
  assert.ok(keywords.slice(0, -1).every((word) => typeof word === 'string' && word.length >= 2))
  assert.ok(keywords.slice(0, -1).every((word) => /[\u4e00-\u9fa5#]/u.test(word)), '关键词应为中文或 # 标签')
  assert.match(keywords.at(-1), /^\d{4}-\d{2}-\d{2}$/u, '最后一项应为生成日期')
})

test('M3 importance/clarity 公式与 SPEC 4.2 逐项一致（短期 + 七个长期层）', () => {
  const layers = ['short', 1, 2, 3, 4, 5, 6, 7]
  for (const layer of layers) {
    for (const mentionCount of [0, 1, 2, 3, 4, 5, 6, 7, 12]) {
      for (const emphasis of [0, 1, 2, 3]) {
        const layerBonus = layer === 'short' ? 0 : (7 - layer) * 4
        const raw = 20 + 10 * Math.min(mentionCount, 6) + 10 * Math.min(emphasis, 3) + layerBonus
        const expectedImportance = Math.min(100, Math.max(1, Math.round(raw)))
        const item = { mentionCount, emphasis, layer }
        assert.equal(
          computeImportance(item),
          expectedImportance,
          `importance 不一致：layer=${layer} mention=${mentionCount} emphasis=${emphasis}`,
        )
        const expectedClarity = Math.round(Math.min(1, Math.max(0.15, expectedImportance / 100)) * 100) / 100
        assert.equal(computeClarity(expectedImportance), expectedClarity)
      }
    }
  }
  assert.equal(computeClarity(0), 0.15)
})

test('M3 引擎内条目的 importance/clarity 始终与公式一致（提及后重算）', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const item = engine.remember({
    content: '主人喜欢夜里听雨声。',
    keywords: ['雨声', '夜晚', '喜欢'],
    emphasis: 2,
  }).item
  const assertFormula = () => {
    const current = engine.getItem(item.id)
    assert.equal(current.importance, computeImportance(current))
    assert.equal(current.clarity, computeClarity(current.importance))
  }
  assertFormula()
  for (let i = 0; i < 4; i += 1) {
    engine.ingestMessage({
      text: '雨声很好听',
      messageId: `m-formula-${i}`,
      role: 'user',
      at: isoOf(clock.advance(60000)),
    })
    assertFormula()
  }
  // 夜间转移后进入第一层，层级加成 (7-1)*4 = 24 也按公式计入
  clock.set(localMs(2026, 11, 6, 4, 30))
  engine.maintain({ at: clock.now(), reason: '每日凌晨维护窗口' })
  const moved = engine.getItem(item.id)
  assert.equal(moved.layer, 1)
  assertFormula()
})

test('M3 清晰度三档渲染可区分：清晰 / 一般 / 模糊', () => {
  const clear = renderItemByClarity({
    content: '主人最喜欢草莓蛋糕，生日那天要买。',
    summary: '主人最喜欢草莓蛋糕。',
    keywords: ['草莓蛋糕', '喜欢', '生日'],
    firstSeenAt: '2026-11-01T10:00:00+08:00',
    mentionCount: 5,
    clarity: 0.7,
  })
  const normal = renderItemByClarity({
    content: '主人喜欢夜里听雨声。',
    summary: '主人喜欢夜里听雨声。',
    keywords: ['雨声', '夜晚', '喜欢'],
    firstSeenAt: '2026-11-02T10:00:00+08:00',
    mentionCount: 2,
    clarity: 0.5,
  })
  const fuzzy = renderItemByClarity({
    content: '主人喜欢夜里听雨声。',
    summary: '主人喜欢夜里听雨声。',
    keywords: ['雨声', '夜晚', '喜欢'],
    firstSeenAt: '2026-11-03T10:00:00+08:00',
    mentionCount: 1,
    clarity: 0.3,
  })

  // 清晰：完整 content + 关键词 + 首次时间 + 提及次数
  assert.ok(clear.includes('主人最喜欢草莓蛋糕，生日那天要买。'))
  assert.ok(clear.includes('关键词：草莓蛋糕、喜欢、生日'))
  assert.ok(clear.includes('首次：'))
  assert.ok(clear.includes('提及 5 次'))
  assert.ok(!clear.includes('记忆有些模糊'))

  // 一般：summary + 首个关键词 + 提及次数，不含首次时间
  assert.ok(normal.includes('主人喜欢夜里听雨声。'))
  assert.ok(normal.includes('关键词：雨声'))
  assert.ok(normal.includes('提及 2 次'))
  assert.ok(!normal.includes('首次：'))
  assert.ok(!normal.includes('记忆有些模糊'))

  // 模糊：前 12 字 + …（记忆有些模糊）
  assert.ok(fuzzy.includes('…（记忆有些模糊）'))
  assert.ok(!fuzzy.includes('关键词：'))

  assert.notEqual(clear, normal)
  assert.notEqual(normal, fuzzy)
  assert.notEqual(clear, fuzzy)
})
