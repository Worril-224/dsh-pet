/**
 * 覆盖验收编号：M4（提及次数与强调）、M5（自动抽取）。
 * 对应 验收/验收标准.md A. 记忆模块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeClarity, computeImportance } from '../../lib/memory/model.js'
import { formatLocalIso } from '../../lib/shared/clock.js'
import { createEngine, isoOf, localMs } from './_helpers.mjs'

test('M4 用户消息命中关键词：mentionCount+1、lastMentionedAt 更新、importance 重算', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const item = engine.remember({
    content: '主人喜欢草莓蛋糕。',
    keywords: ['草莓蛋糕', '喜欢', '蛋糕'],
  }).item
  assert.equal(item.mentionCount, 1)

  const atIso = isoOf(clock.advance(3600_000))
  const result = engine.ingestMessage({
    text: '今天又吃了草莓蛋糕',
    messageId: 'm-4-1',
    role: 'user',
    at: atIso,
  })
  assert.equal(result.skipped, false)
  const mention = result.mentioned.find((entry) => entry.id === item.id)
  assert.ok(mention, '命中的记忆应出现在 mentioned 中')
  assert.equal(mention.mentionCount, 2)

  const updated = engine.getItem(item.id)
  assert.equal(updated.mentionCount, 2)
  assert.equal(updated.lastMentionedAt, atIso)
  assert.equal(updated.importance, computeImportance(updated))
  assert.equal(updated.clarity, computeClarity(updated.importance))
})

test('M4 同一 messageId 只处理一次，不重复计数', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const item = engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['草莓蛋糕', '喜欢', '蛋糕'] }).item

  const first = engine.ingestMessage({
    text: '草莓蛋糕真好吃',
    messageId: 'm-dup-1',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(first.skipped, false)
  assert.equal(engine.getItem(item.id).mentionCount, 2)
  const before = engine.getItem(item.id).mentionCount

  const second = engine.ingestMessage({
    text: '草莓蛋糕真好吃',
    messageId: 'm-dup-1',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(second.skipped, true)
  assert.deepEqual(second.created, [])
  assert.deepEqual(second.mentioned, [])
  assert.equal(engine.getItem(item.id).mentionCount, before)
})

test('M4 未提供 messageId 时跳过去重但仍正常处理', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const item = engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['草莓蛋糕', '喜欢', '蛋糕'] }).item
  const first = engine.ingestMessage({ text: '草莓蛋糕', role: 'user', at: isoOf(clock.advance(60000)) })
  const second = engine.ingestMessage({ text: '草莓蛋糕', role: 'user', at: isoOf(clock.advance(60000)) })
  assert.equal(first.skipped, false)
  assert.equal(second.skipped, false)
  assert.equal(engine.getItem(item.id).mentionCount, 3)
})

test('M4 强调词提升 emphasis，同一消息内每条最多 +1，且上限 3', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const item = engine.remember({
    content: '主人喜欢草莓蛋糕。',
    keywords: ['草莓蛋糕', '喜欢', '蛋糕'],
    emphasis: 0,
  }).item
  // 消息同时包含两个强调词「很重要」「记住」，每条记忆只 +1
  engine.ingestMessage({
    text: '草莓蛋糕很重要，记住',
    messageId: 'm-em-1',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(engine.getItem(item.id).emphasis, 1)
  assert.equal(engine.getItem(item.id).mentionCount, 2)

  engine.ingestMessage({
    text: '草莓蛋糕很重要，记住',
    messageId: 'm-em-2',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(engine.getItem(item.id).emphasis, 2)

  engine.ingestMessage({
    text: '草莓蛋糕很重要，记住',
    messageId: 'm-em-3',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(engine.getItem(item.id).emphasis, 3)

  engine.ingestMessage({
    text: '草莓蛋糕很重要，记住',
    messageId: 'm-em-4',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(engine.getItem(item.id).emphasis, 3, 'emphasis 上限为 3')
})

test('M4 非 user 角色消息被跳过，且不消耗 messageId', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const item = engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['草莓蛋糕', '喜欢', '蛋糕'] }).item

  const assistant = engine.ingestMessage({
    text: '草莓蛋糕真好吃呀',
    messageId: 'm-role-1',
    role: 'assistant',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(assistant.skipped, true)
  assert.equal(assistant.created.length, 0)
  assert.equal(assistant.mentioned.length, 0)
  assert.equal(engine.getItem(item.id).mentionCount, 1)

  // 同一 messageId 之后以 user 角色出现，应正常处理（未被 assistant 消息占用）
  const user = engine.ingestMessage({
    text: '草莓蛋糕真好吃呀',
    messageId: 'm-role-1',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(user.skipped, false)
  assert.equal(engine.getItem(item.id).mentionCount, 2)
})

test('M4 长期记忆中的条目同样参与提及计数（维护转移后）', (t) => {
  const ctx = createEngine({ start: localMs(2026, 11, 5, 4, 30) })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const item = engine.remember({
    content: '主人喜欢夜里听雨声。',
    keywords: ['雨声', '夜晚', '喜欢'],
  }).item
  engine.maintain({ at: clock.now(), reason: '每日凌晨维护窗口' })
  const moved = engine.getItem(item.id)
  assert.equal(moved.layer, 1)
  const mentionCountAtMaintenance = moved.mentionCount

  clock.set(localMs(2026, 11, 5, 9, 0))
  const result = engine.ingestMessage({
    text: '昨晚的雨声真好听',
    messageId: 'm-long-1',
    role: 'user',
    at: clock.now(),
  })
  assert.ok(result.mentioned.some((entry) => entry.id === item.id))
  assert.equal(engine.getItem(item.id).mentionCount, mentionCountAtMaintenance + 1)
  assert.equal(engine.getItem(item.id).layer, 1, '提及不改变层级')
})

test('M4 空文本消息返回 skipped 且不报错', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const result = engine.ingestMessage({ text: '   ', messageId: 'm-empty-1', role: 'user' })
  assert.equal(result.skipped, true)
  assert.deepEqual(result.created, [])
  assert.deepEqual(result.mentioned, [])
})

test('M5 七类中文模式均可自动抽取为中文记忆', (t) => {
  const cases = [
    { text: '我叫林小满', categoryIn: ['身份'], include: '林小满', emphasisAtLeast: 0 },
    { text: '我喜欢草莓蛋糕', categoryIn: ['喜好'], include: '草莓蛋糕', emphasisAtLeast: 1 },
    { text: '我不喜欢香菜', categoryIn: ['喜好'], include: '香菜', emphasisAtLeast: 1 },
    {
      text: '记住我答应你周末陪你打游戏',
      categoryIn: ['承诺', '事件'],
      include: '主人希望我记住',
      emphasisAtLeast: 2,
    },
    { text: '我的生日是三月五日', categoryIn: ['身份'], include: '生日', emphasisAtLeast: 0 },
    { text: '我今天去公园散步了', categoryIn: ['事件'], include: '公园', emphasisAtLeast: 0 },
    { text: '我今天很难过', categoryIn: ['情绪'], include: '难过', emphasisAtLeast: 0 },
  ]
  for (const testCase of cases) {
    const ctx = createEngine()
    t.after(ctx.cleanup)
    const { engine } = ctx
    const result = engine.ingestMessage({
      text: testCase.text,
      messageId: `m-extract-${testCase.include}`,
      role: 'user',
    })
    assert.equal(result.skipped, false)
    assert.ok(result.created.length >= 1, `模式「${testCase.text}」未抽取到记忆`)
    const item = result.created[0]
    assert.ok(testCase.categoryIn.includes(item.category), `分类 ${item.category} 不符合预期`)
    assert.ok(item.content.includes(testCase.include), `内容「${item.content}」缺少「${testCase.include}」`)
    assert.match(item.content, /[\u4e00-\u9fa5]/u)
    assert.ok(item.content.length >= 4 && item.content.length <= 120, '抽取内容长度应为 4~120')
    assert.ok(item.emphasis >= testCase.emphasisAtLeast)
    assert.ok(item.keywords.length >= 3 && item.keywords.length <= 5)
    // 抽取结果确实写入了短期记忆
    assert.ok(engine.listLayer('short').some((stored) => stored.id === item.id))
  }
})

test('M5 每条消息最多新增 3 条记忆', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const result = engine.ingestMessage({
    text: '我叫小明，我喜欢草莓蛋糕，我今天很难过',
    messageId: 'm-extract-max',
    role: 'user',
  })
  assert.equal(result.created.length, 3, '一条消息包含多个模式时最多新增 3 条')
  assert.equal(engine.listLayer('short').length, 3)
})

test('M5 与已有记忆重复的内容不新增，改为提及 +1', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const existing = engine.remember({
    content: '主人喜欢草莓蛋糕。',
    keywords: ['草莓蛋糕', '喜欢', '蛋糕'],
  }).item
  const result = engine.ingestMessage({
    text: '我喜欢草莓蛋糕',
    messageId: 'm-extract-dup',
    role: 'user',
    at: isoOf(clock.advance(60000)),
  })
  assert.equal(result.created.length, 0, '重复内容不应新增记忆')
  assert.equal(engine.listLayer('short').length, 1)
  assert.equal(engine.getItem(existing.id).mentionCount, 2, '重复内容应计为一次提及')
})

test('M5 抽取内容均为中文且长度合法（多模式消息）', (t) => {
  const ctx = createEngine()
  t.after(ctx.cleanup)
  const { engine } = ctx
  const result = engine.ingestMessage({
    text: '我叫阿澄，我最喜欢草莓蛋糕，我打算周末去游乐园',
    messageId: 'm-extract-cn',
    role: 'user',
  })
  assert.ok(result.created.length >= 2)
  for (const item of result.created) {
    assert.match(item.content, /[\u4e00-\u9fa5]/u)
    assert.ok(item.content.length >= 4 && item.content.length <= 120)
    assert.ok(item.summary.length > 0 && item.summary.length <= 30)
    assert.ok(item.keywords.length >= 3 && item.keywords.length <= 5)
  }
})
