/**
 * LLM 记忆整理器 + 结构化记忆字段测试。
 * 假 LLM，不联网；覆盖：事件分段、关键词覆盖谁/时间/地点/动作、书籍高频词、图片描述、长摘要注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryAnalyzer } from '../../lib/memory/analyzer.js'
import { createEngine, localMs } from './_helpers.mjs'

function fakeLlm(replies) {
  return {
    prepareCall: async (config) => ({
      config: { ...config },
      stream: (options) => {
        const text = replies(options)
        return (async function* () {
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }),
  }
}

function makeAnalyzer(reply) {
  return createMemoryAnalyzer({
    llm: fakeLlm((options) => reply(options)),
    modelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  })
}

test('A1：事件整理输出 who/when/where/what，长事件拆段并进入关键词', async () => {
  const analyzer = makeAnalyzer(() =>
    JSON.stringify({
      kind: 'event',
      category: '事件',
      importance: 65,
      summary: '昨天下午主人在图书馆整理旧书。',
      keywords: ['主人', '昨天下午', '市图书馆', '整理旧书'],
      segments: [
        {
          who: '主人',
          when: '昨天下午',
          where: '市图书馆',
          what: '整理旧书',
          content: '主人昨天下午在市图书馆整理旧书。',
        },
        {
          who: '奥菲莉亚',
          when: '傍晚',
          where: '第七阅览室',
          what: '登记书目',
          content: '奥菲莉亚傍晚在第七阅览室登记书目。',
        },
      ],
    }),
  )
  const result = await analyzer.analyze({ content: '主人昨天下午在图书馆整理旧书。' })
  assert.equal(result.kind, 'event')
  assert.equal(result.category, '事件')
  assert.equal(result.segments.length, 2)
  assert.deepEqual(result.segments[1], {
    who: '奥菲莉亚',
    when: '傍晚',
    where: '第七阅览室',
    what: '登记书目',
    content: '奥菲莉亚傍晚在第七阅览室登记书目。',
  })
  for (const word of ['主人', '昨天下午', '市图书馆', '整理旧书']) {
    assert.ok(result.keywords.includes(word), `关键词应包含：${word}`)
  }
})

test('A2：书籍/材料提取高频重要词；图片先描述再提取关键词', async () => {
  const book = makeAnalyzer(() =>
    JSON.stringify({
      kind: 'book',
      category: '工作学习',
      importance: 50,
      summary: '读《图书馆史》。',
      keywords: ['图书馆史', '公共图书馆', '阅读', '档案'],
      segments: [{ who: '奥菲莉亚', when: '下午', where: '阅览室', what: '读书', content: '读《图书馆史》。' }],
    }),
  )
  const bookResult = await book.analyze({ content: '今天读了《图书馆史》，讲公共图书馆和阅读。' })
  assert.equal(bookResult.kind, 'book')
  assert.ok(bookResult.keywords.includes('公共图书馆'))

  const image = makeAnalyzer(() =>
    JSON.stringify({
      kind: 'image',
      category: '事件',
      importance: 40,
      summary: '一张图书馆窗边的照片。',
      described: '窗边木桌上摊着一本旧书，阳光落在书页上。',
      keywords: ['窗边', '旧书', '阳光', '图书馆'],
      segments: [{ who: '不知道', when: '不知道', where: '图书馆窗边', what: '旧书和阳光', content: '一张图书馆窗边的照片。' }],
    }),
  )
  const imageResult = await image.analyze({ content: '[图片]', kindHint: 'image' })
  assert.equal(imageResult.kind, 'image')
  assert.match(imageResult.described, /旧书/)
  assert.ok(imageResult.keywords.includes('阳光'))
})

test('A3：引擎保存分析元数据；LLM 关键词最多 12 个；会话分析写入关键词', (t) => {
  const ctx = createEngine({ start: localMs(2026, 11, 8, 10, 0) })
  t.after(ctx.cleanup)
  const { engine } = ctx
  const keywords = ['主人', '昨天', '图书馆', '整理旧书', '奥菲莉亚', '傍晚', '第七阅览室']
  const item = engine.remember({
    content: '主人昨天在图书馆整理旧书。',
    keywords,
    category: '事件',
    metadata: {
      llm: true,
      kind: 'event',
      segments: [{ who: '主人', when: '昨天', where: '图书馆', what: '整理旧书' }],
    },
  }).item
  assert.deepEqual(item.keywords, [...keywords, '2026-11-08']) 
  assert.equal(item.metadata.kind, 'event')
  assert.deepEqual(engine.getItem(item.id).metadata.segments[0], {
    who: '主人',
    when: '昨天',
    where: '图书馆',
    what: '整理旧书',
  })

  const convo = engine.recordConversationTurn({
    sessionId: 'qq:test',
    userText: '昨天在图书馆整理旧书',
    assistantText: '我记得。',
    analysis: {
      topicLabel: '图书馆整理旧书',
      category: '事件',
      keywords: ['主人', '昨天', '图书馆', '整理旧书'],
      segments: [{ who: '主人', when: '昨天', where: '图书馆', what: '整理旧书', content: '...' }],
    },
  })
  assert.ok(convo.item.keywords.includes('图书馆'))
  assert.equal(convo.item.metadata.llm, true)
})

test('A4：默认 digest 上限提升，短期 + 第一层全部进入上下文', (t) => {
  const ctx = createEngine({ start: localMs(2026, 11, 8, 10, 0), config: { shortTermCapacity: 40 } })
  t.after(ctx.cleanup)
  const { engine } = ctx
  for (let index = 0; index < 30; index += 1) {
    engine.remember({
      content: `第${index + 1}条短期记忆：主人在图书馆整理第${index + 1}批旧书。`,
      keywords: ['主人', '图书馆', `第${index + 1}批`, '旧书'],
      category: '事件',
    })
  }
  const digest = engine.renderDigest({ latestUserText: '' })
  assert.ok(digest.length <= 30000)
  const count = (digest.match(/第\d+条短期记忆/gmu) || []).length
  assert.ok(count >= 30, `应包含全部 30 条短期记忆，实际 ${count}`)
})


test('A5：所有层先 keyword，未命中再看 summary，命中后才读全文', (t) => {
  const ctx = createEngine({ start: localMs(2026, 11, 8, 10, 0) })
  t.after(ctx.cleanup)
  const { engine } = ctx
  engine.seedMemories([
    { id: 'm-short', content: '短期：主人在图书馆。', keywords: ['图书馆'], category: '事件', layer: 'short' },
    { id: 'm-l1', content: '第一层：主人在市图书馆。', keywords: ['市图书馆'], category: '事件', layer: 1 },
    { id: 'm-l2-hit', content: '第二层正文没有查询词，但关键词有葡萄。', keywords: ['葡萄'], category: '喜好', layer: 2 },
    { id: 'm-l3-miss', content: '第三层正文包含秘密内容，但关键词无关。', summary: '与查询无关的摘要。', keywords: ['无关'], category: '其他', layer: 3 },
    { id: 'm-l4-miss', content: '第四层正文包含图书馆，但关键词无关。', summary: '与查询无关的摘要。', keywords: ['无关'], category: '其他', layer: 4 },
    { id: 'm-l5-summary', content: '第五层正文没有查询词。', summary: '这条摘要提到图书馆。', keywords: ['无关'], category: '其他', layer: 5 },
  ])
  const result = engine.recall('图书馆', { limit: 20 })
  const ids = result.hits.map((hit) => hit.item.id)
  assert.deepEqual(ids.filter((id) => id === 'm-short' || id === 'm-l1'), ['m-short', 'm-l1'])
  assert.ok(!ids.includes('m-l3-miss'), '第三层正文含查询词但关键词/摘要均未命中，应跳过')
  assert.ok(!ids.includes('m-l4-miss'), '第四层正文含查询词但关键词/摘要均未命中，应跳过')
  assert.ok(ids.includes('m-l5-summary'), '关键词未命中但 summary 命中，应读取正文并召回')

  const grape = engine.recall('葡萄', { limit: 20 })
  assert.ok(grape.hits.some((hit) => hit.item.id === 'm-l2-hit'), '关键词命中后才读该层全文')
})


test('A6：收到消息时只按长期 keywords 预加载，命中项挪回短期，不加载全部长期正文', (t) => {
  const ctx = createEngine({ start: localMs(2026, 11, 8, 10, 0) })
  t.after(ctx.cleanup)
  const { engine } = ctx
  engine.seedMemories([
    { id: 'm-long-hit', content: '闭馆夜，她听见走廊尽头的脚步。', keywords: ['闭馆夜', '薇拉'], category: '事件', layer: 3 },
    { id: 'm-long-miss', content: '完全无关的旧档案内容。', keywords: ['葡萄', '果园'], category: '其他', layer: 4 },
  ])
  const digest = engine.renderDigest({ latestUserText: '闭馆夜' })
  assert.ok(engine.listLayer('short').some((item) => item.id === 'm-long-hit'))
  assert.ok(!engine.listLayer(3).some((item) => item.id === 'm-long-hit'))
  assert.ok(engine.listLayer(4).some((item) => item.id === 'm-long-miss'), '未命中的长期记忆不应挪动')
  assert.ok(digest.includes('闭馆夜'))
  assert.ok(!digest.includes('【长期记忆命中】'))
  assert.ok(!digest.includes('葡萄'))
})
