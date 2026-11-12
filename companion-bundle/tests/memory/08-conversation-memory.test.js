/**
 * 会话话题记忆（2026-11-06）：
 * - QQ 主人 + 奥菲莉亚的完整对话写入同一条短期话题记忆；
 * - 同一 session 30 分钟内追加，超过时间窗新开话题；
 * - 单话题超过 1w 字压缩旧对话；
 * - 短期超过 5w 字按重要度/提及次数低的一半转入长期第一层；
 * - 凌晨维护不把话题记忆转走（普通记忆仍按原规则）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, localMs, isoOf, makeItem } from './_helpers.mjs'

const LONG = '这是一段用来填充话题记忆的完整对话内容，包含主人和奥菲莉亚两个人的原话。'
const HUGE = LONG.repeat(60) // 约 2000+ 字

test('会话记忆：同一话题追加，主人和奥菲莉亚的原话都进入短期记忆', () => {
  const ctx = createEngine({ start: localMs(2026, 11, 6, 21, 0) })
  try {
    const r1 = ctx.engine.recordConversationTurn({
      sessionId: 'qq:10001',
      userText: '今天图书馆的灯有点暗。',
      assistantText: '我把第七阅览室的灯调亮一些。您先坐。',
      atUser: localMs(2026, 11, 6, 21, 0),
      atAssistant: localMs(2026, 11, 6, 21, 0, 20),
    })
    assert.equal(r1.created, true)
    assert.equal(r1.item.kind, 'conversation')
    assert.ok(r1.item.content.includes('主人：今天图书馆的灯有点暗。'))
    assert.ok(r1.item.content.includes('奥菲莉亚：我把第七阅览室的灯调亮一些。'))

    const r2 = ctx.engine.recordConversationTurn({
      sessionId: 'qq:10001',
      userText: '那本书找到了吗？',
      assistantText: '找到了，在闭架库最里面。',
      atUser: localMs(2026, 11, 6, 21, 5),
      atAssistant: localMs(2026, 11, 6, 21, 5, 20),
    })
    assert.equal(r2.created, false)
    const shortItems = ctx.engine.listLayer('short')
    const conversationItems = shortItems.filter((item) => item.kind === 'conversation')
    assert.equal(conversationItems.length, 1, '同一话题应只有一条记忆')
    assert.ok(conversationItems[0].content.includes('那本书找到了吗？'))
    assert.ok(conversationItems[0].content.includes('找到了，在闭架库最里面。'))

    // 超过 30 分钟，开新话题
    const r3 = ctx.engine.recordConversationTurn({
      sessionId: 'qq:10001',
      userText: '明天会下雨吗？',
      assistantText: '我不确定，早上起来看窗外吧。',
      atUser: localMs(2026, 11, 6, 21, 40),
      atAssistant: localMs(2026, 11, 6, 21, 40, 20),
    })
    assert.equal(r3.created, true)
    assert.equal(ctx.engine.listLayer('short').filter((item) => item.kind === 'conversation').length, 2)
  } finally {
    ctx.cleanup()
  }
})

test('会话记忆：单话题超过 1w 字后压缩旧对话，但保留最近原文', () => {
  const ctx = createEngine({ start: localMs(2026, 11, 6, 21, 0) })
  try {
    let at = localMs(2026, 11, 6, 21, 0)
    let item
    for (let index = 0; index < 12; index += 1) {
      at += 60 * 1000
      const result = ctx.engine.recordConversationTurn({
        sessionId: 'qq:20002',
        userText: `第 ${index} 段：${HUGE}`,
        assistantText: `奥菲莉亚回答第 ${index} 段：${HUGE}`,
        atUser: at,
        atAssistant: at + 1000,
      })
      item = result.item
    }
    assert.equal(item.kind, 'conversation')
    assert.ok(item.content.length <= 10000, `单话题应 ≤1w 字，实际 ${item.content.length}`)
    assert.ok(item.compression && item.compression.count >= 1, '应记录压缩次数')
    assert.ok(item.content.includes('【早期对话摘要】'))
    assert.ok(item.content.includes('第 11 段'), '最近对话应保留原文')
    const shortItems = ctx.engine.listLayer('short').filter((entry) => entry.kind === 'conversation')
    assert.equal(shortItems.length, 1)
    assert.ok(shortItems[0].content.length <= 10000)
  } finally {
    ctx.cleanup()
  }
})

test('会话记忆：短期超过 5w 字时，重要度低/提及少的一半转入长期第一层', () => {
  const ctx = createEngine({ start: localMs(2026, 11, 6, 9, 0) })
  try {
    // 先建立一条提及次数较高的话题（多轮）
    let at = localMs(2026, 11, 6, 9, 0)
    for (let index = 0; index < 4; index += 1) {
      at += 60 * 1000
      ctx.engine.recordConversationTurn({
        sessionId: 'qq:30003',
        userText: `重要话题第 ${index} 轮：${LONG.repeat(12)}`,
        assistantText: `重要回答第 ${index} 轮：${LONG.repeat(12)}`,
        atUser: at,
        atAssistant: at + 1000,
      })
    }
    // 再建立 10 条低提及话题，总字数超过 5w
    for (let topic = 0; topic < 10; topic += 1) {
      at += 31 * 60 * 1000
      ctx.engine.recordConversationTurn({
        sessionId: 'qq:30003',
        userText: `普通话题 ${topic}：${LONG.repeat(80)}`,
        assistantText: `普通回答 ${topic}：${LONG.repeat(80)}`,
        atUser: at,
        atAssistant: at + 1000,
      })
    }
    const shortItems = ctx.engine.listLayer('short')
    const longLayer1 = ctx.engine.listLayer(1)
    const shortChars = shortItems.reduce((sum, item) => sum + item.content.length, 0)
    assert.ok(shortChars <= 50000, `短期应降回 5w 字内，实际 ${shortChars}`)
    assert.ok(longLayer1.length > 0, '应有记忆转入长期第一层')
    const moved = longLayer1.filter((item) => item.history.some((entry) => String(entry.reason).includes('字数上限')))
    assert.ok(moved.length >= 1, '应有因字数上限转入长期的条目')
    // 高提及话题仍应在短期（除非它的内容本身极大）
    const important = shortItems.find((item) => String(item.topicLabel).includes('重要话题'))
    assert.ok(important, '提及次数高的话题应优先留在短期')
    assert.ok(moved.every((item) => item.content.length > 0), '转入长期时不应丢失正文')
  } finally {
    ctx.cleanup()
  }
})

test('会话记忆：凌晨维护保留话题记忆，普通短期记忆照旧转入长期', () => {
  const ctx = createEngine({ start: localMs(2026, 11, 6, 22, 0) })
  try {
    ctx.engine.recordConversationTurn({
      sessionId: 'qq:40004',
      userText: '晚安。',
      assistantText: '晚安，灯我关。',
      atUser: localMs(2026, 11, 6, 22, 0),
      atAssistant: localMs(2026, 11, 6, 22, 0, 20),
    })
    ctx.engine.remember({ content: '主人喜欢伯爵红茶。', category: '喜好' })
    const report = ctx.engine.maintain({ at: localMs(2026, 11, 7, 4, 30), reason: '每日凌晨维护窗口' })
    assert.equal(report.ok, true)
    const shortItems = ctx.engine.listLayer('short')
    assert.ok(shortItems.some((item) => item.kind === 'conversation'), '话题记忆应留在短期')
    assert.ok(ctx.engine.listLayer(1).some((item) => item.id !== undefined && item.kind !== 'conversation'), '普通短期记忆应转入长期')
  } finally {
    ctx.cleanup()
  }
})
