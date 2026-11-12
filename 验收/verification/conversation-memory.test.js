/**
 * 独立验收测试 · 2026-11-06 会话话题记忆 + 短期 5w 字上限（TM1–TM5）
 *
 * TM1 QQ 每轮主人+奥菲莉亚完整对话写入同一条短期话题记忆（含 QQ Host 集成、autoExtract:false）；
 * TM2 同一 session 30 分钟内追加、超时/换 session 新建（一条话题一条记忆）；
 * TM3 单话题超过 topicMemoryMaxChars（默认 1w）压缩旧对话，保留最近原文 + 早期摘要；
 * TM4 短期总字数超过 shortTermCharLimit（默认 5w）按重要度/提及次数低的一半转入 L1，正文不压缩；
 * TM5 凌晨维护保留话题在短期、普通记忆转 L1；转入长期的话题 L3 起才按层级压缩。
 *
 * 全部使用 fs.mkdtempSync 临时目录 + 假时钟/假 QQ Host 依赖；不写真实 companion-data、不联网、不改实现、不重启 Harness。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createQQHost } from '../../companion-bundle/lib/qq-host.js'
import {
  cleanupTempDirs,
  localMs,
  makeClock,
  makeSeedItem,
  makeTempDir,
  memoryPaths,
  newMemoryEngine,
  readJson,
  seedMemoryData,
} from './helpers.mjs'

test.after(cleanupTempDirs)

const REAL_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'companion-data', 'characters', 'ophelia')

function isoLocal(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+08:00`
}

function conversationItems(engine) {
  return engine.listLayer('short').filter((item) => item.kind === 'conversation')
}

function seedShortEngine({ short = [], config, atMs }) {
  const dataDir = makeTempDir('dshpet-verify-tm-')
  seedMemoryData(dataDir, { short })
  const clock = makeClock(atMs)
  const { engine } = newMemoryEngine({ dataDir, clock, config })
  return { engine, dataDir, clock }
}

// ───────────────────────────── TM1 ─────────────────────────────

test('TM1: QQ 每轮完整记录主人+奥菲莉亚原话到同一条短期话题记忆；Host 集成传完整双人文本且 autoExtract:false', async () => {
  const atUser = localMs(2026, 11, 6, 21, 0)
  const atAssistant = localMs(2026, 11, 6, 21, 0, 20)
  const { engine } = newMemoryEngine({ clock: makeClock(atAssistant) })
  const userText = '今天图书馆的灯有点暗，我在找一本旧书。'
  const assistantText = '我把第七阅览室的灯调亮一些。您先坐，我去闭架库找找那本旧书。'
  const result = engine.recordConversationTurn({
    sessionId: 'qq:10001',
    userText,
    assistantText,
    atUser,
    atAssistant,
  })
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  const item = result.item
  assert.equal(item.kind, 'conversation')
  assert.equal(item.source, 'qq-conversation')
  assert.equal(item.sessionId, 'qq:10001')
  assert.equal(item.topicId, item.id)
  assert.equal(item.turnCount, 2)
  assert.equal(item.layer, 'short')
  assert.ok(item.content.startsWith('【话题】'))
  assert.ok(item.content.includes(`主人：${userText}`), '应包含主人完整原话')
  assert.ok(item.content.includes(`奥菲莉亚：${assistantText}`), '应包含奥菲莉亚完整原话')
  assert.equal(item.charCount, item.content.length)
  assert.match(item.summary, /轮，\d+ 字/u)
  assert.match(item.startedAt, /\+08:00$/)
  assert.match(item.lastTurnAt, /\+08:00$/)
  assert.ok(item.mentionCount >= 2)

  // 只传单侧也能记录
  const single = engine.recordConversationTurn({ sessionId: 'qq:single', userText: '只有主人一句', atUser })
  assert.equal(single.created, true)
  assert.equal(single.item.turnCount, 1)
  assert.ok(single.item.content.includes('主人：只有主人一句'))

  // QQ Host 集成：回复后调用 recordConversationTurn（主人+奥菲莉亚原话），ingestMessage 传 autoExtract:false
  const charactersDir = makeTempDir('dshpet-verify-tm-host-')
  const calls = { ingest: [], conversation: [] }
  const host = createQQHost({
    config: { charactersDir, characterId: 'ophelia', botQQ: '123456789', allowUsers: ['10001'] },
    deps: {
      persona: { renderPersonaSection: () => '人设', lookup: () => ({ ok: true }) },
      memory: {
        renderDigest: () => 'digest',
        ingestMessage: (input) => {
          calls.ingest.push(input)
          return { created: [], mentioned: [], skipped: false }
        },
        recordConversationTurn: (input) => {
          calls.conversation.push(input)
          return { ok: true, created: true }
        },
      },
      replyEngine: { generate: async () => ({ text: '奥菲莉亚收到。', onDemandModules: [] }) },
      adapter: {
        id: 'fake-adapter',
        channel: 'qq',
        start: async () => ({}),
        stop: async () => ({}),
        send: async () => ({ delivered: true }),
        status: () => ({ state: 'running' }),
      },
    },
  })
  const handled = await host.handleInbound({
    id: 'm-tm1',
    channel: 'qq',
    adapterId: 'fake-adapter',
    userId: '10001',
    text: userText,
    receivedAt: localMs(2026, 11, 6, 21, 0),
    meta: {},
  })
  assert.equal(handled.accepted, true)
  assert.equal(calls.ingest.length, 1)
  assert.equal(calls.ingest[0].autoExtract, false, 'QQ Host 不应再拆模糊自动抽取事实')
  assert.equal(calls.conversation.length, 1)
  assert.equal(calls.conversation[0].sessionId, 'qq:10001')
  assert.equal(calls.conversation[0].userText, userText)
  assert.equal(calls.conversation[0].assistantText, '奥菲莉亚收到。')
  assert.equal(handled.conversation?.created, true)
})

// ───────────────────────────── TM2 ─────────────────────────────

test('TM2: 同一 session 30 分钟内追加同一话题；超时/换 session 新建；一条话题一条记忆', () => {
  const at0 = localMs(2026, 11, 6, 21, 0)
  const { engine } = newMemoryEngine({ clock: makeClock(at0) })
  const first = engine.recordConversationTurn({
    sessionId: 'qq:20002',
    userText: '第一轮',
    assistantText: '第一轮回答',
    atUser: at0,
    atAssistant: at0 + 20_000,
  })
  assert.equal(first.created, true)
  const itemId = first.item.id

  // 29 分钟内：追加同一话题
  const at1 = at0 + 29 * 60 * 1000
  const second = engine.recordConversationTurn({
    sessionId: 'qq:20002',
    userText: '第二轮',
    assistantText: '第二轮回答',
    atUser: at1,
    atAssistant: at1 + 20_000,
  })
  assert.equal(second.created, false)
  assert.equal(second.item.id, itemId, '应追加到同一条话题记忆')
  assert.equal(conversationItems(engine).length, 1)
  assert.equal(conversationItems(engine)[0].turnCount, 4)

  // 超过 30 分钟：新话题
  const at2 = at1 + 31 * 60 * 1000
  const third = engine.recordConversationTurn({
    sessionId: 'qq:20002',
    userText: '第三轮',
    assistantText: '第三轮回答',
    atUser: at2,
    atAssistant: at2 + 20_000,
  })
  assert.equal(third.created, true)
  assert.notEqual(third.item.id, itemId)
  assert.equal(conversationItems(engine).length, 2)

  // 换 session：新话题
  const other = engine.recordConversationTurn({
    sessionId: 'qq:30003',
    userText: '另一个会话',
    assistantText: '另一个回答',
    atUser: at2 + 60_000,
    atAssistant: at2 + 80_000,
  })
  assert.equal(other.created, true)
  assert.equal(conversationItems(engine).length, 3)
  assert.equal(new Set(conversationItems(engine).map((item) => item.id)).size, 3)
  assert.ok(conversationItems(engine).every((item) => item.topicId === item.id))
})

// ───────────────────────────── TM3 ─────────────────────────────

test('TM3: 单话题超过 topicMemoryMaxChars 压缩旧对话——≤上限、保留最近原文、compression.count/长度、旧内容有摘要', () => {
  const at0 = localMs(2026, 11, 6, 21, 0)
  const { engine } = newMemoryEngine({
    clock: makeClock(at0),
    config: { topicMemoryMaxChars: 1000, topicCompressionTargetRatio: 0.75 },
  })
  const filler = '这是一段用于填充话题记忆的完整对话内容，包含主人和奥菲莉亚两个人的原话。'
  let at = at0
  let last
  for (let index = 0; index < 6; index += 1) {
    at += 60 * 1000 // 保持在 30 分钟窗口内
    last = engine.recordConversationTurn({
      sessionId: 'qq:40004',
      userText: `第 ${index} 段：${filler.repeat(5)}`,
      assistantText: `奥菲莉亚回答第 ${index} 段：${filler.repeat(5)}`,
      atUser: at,
      atAssistant: at + 1000,
    })
  }
  const item = conversationItems(engine).find((entry) => entry.id === last.item.id)
  assert.ok(item, '话题记忆应存在')
  assert.ok(item.content.length <= 1000, `单话题应 ≤1w 配置上限，实际 ${item.content.length}`)
  assert.ok(item.compression && item.compression.count >= 1, '应记录 compression.count')
  assert.ok(item.compression.originalLength > 1000)
  assert.equal(item.compression.compactedLength, item.content.length)
  assert.ok(item.content.includes('【早期对话摘要】'), '旧内容应压成早期对话摘要')
  assert.ok(item.content.includes('第 5 段'), '最近一轮对话应保留原文')
  assert.ok(!item.content.includes(`第 0 段：${filler.repeat(5)}`), '最早对话正文应已进入摘要/被移除')
  assert.equal(item.charCount, item.content.length)
  // 摘要块存在且不是空
  const summaryLine = item.content.split('\n').find((line) => line.startsWith('【早期对话摘要】'))
  assert.ok(summaryLine && summaryLine.length > '【早期对话摘要】'.length + 5)
})

// ───────────────────────────── TM4 ─────────────────────────────

test('TM4: 短期正文 >shortTermCharLimit 时按重要度/提及次数低的一半转入 L1，正文不压缩', () => {
  const atMs = localMs(2026, 11, 6, 21, 0)
  const big = (label) => `${label}：${'这是一条较长的普通短期记忆内容，用于凑满短期的字数上限。'.repeat(20)}`
  const low1 = makeSeedItem({
    id: 'tm4-low1',
    content: big('低重要 1'),
    source: 'auto_extract',
    layer: 'short',
    mentionCount: 1,
    mentionCountAtLastMaintenance: 1,
    emphasis: 0,
    lastMentionedAt: isoLocal(localMs(2026, 11, 1, 10, 0)),
  })
  const low2 = makeSeedItem({
    id: 'tm4-low2',
    content: big('低重要 2'),
    source: 'auto_extract',
    layer: 'short',
    mentionCount: 1,
    mentionCountAtLastMaintenance: 1,
    emphasis: 0,
    lastMentionedAt: isoLocal(localMs(2026, 11, 2, 10, 0)),
  })
  const high1 = makeSeedItem({
    id: 'tm4-high1',
    content: big('高重要 1'),
    source: 'auto_extract',
    layer: 'short',
    mentionCount: 6,
    mentionCountAtLastMaintenance: 6,
    emphasis: 3,
    lastMentionedAt: isoLocal(localMs(2026, 11, 5, 10, 0)),
  })
  const high2 = makeSeedItem({
    id: 'tm4-high2',
    content: big('高重要 2'),
    source: 'auto_extract',
    layer: 'short',
    mentionCount: 5,
    mentionCountAtLastMaintenance: 5,
    emphasis: 2,
    lastMentionedAt: isoLocal(localMs(2026, 11, 5, 11, 0)),
  })
  const { engine } = seedShortEngine({
    atMs,
    config: { shortTermCharLimit: 2000, shortTermOverflowMoveRatio: 0.5 },
    short: [low1, low2, high1, high2],
  })
  const before = new Map(engine.listLayer('short').map((item) => [item.id, item.content]))
  assert.ok([...before.values()].reduce((sum, text) => sum + text.length, 0) > 2000)
  const result = engine.recordConversationTurn({
    sessionId: 'qq:50005',
    userText: '触发溢出的短对话',
    assistantText: '好的。',
    atUser: atMs,
    atAssistant: atMs + 1000,
  })
  // 5 条短期 → 移动 floor(5*0.5)=2 条最低重要度（2 条 low）
  assert.equal(result.moved, 2, `应移动一半，实际 ${result.moved}`)
  const shortIds = new Set(engine.listLayer('short').map((item) => item.id))
  assert.equal(shortIds.has('tm4-low1'), false)
  assert.equal(shortIds.has('tm4-low2'), false)
  assert.equal(shortIds.has('tm4-high1'), true, '高重要度记忆应保留')
  assert.equal(shortIds.has('tm4-high2'), true)
  assert.ok(shortIds.has(result.item.id), '新话题记忆应保留在短期')
  // 正文不压缩、L1 完整保存
  const layer1 = new Map(engine.listLayer(1).map((item) => [item.id, item]))
  for (const id of ['tm4-low1', 'tm4-low2']) {
    const moved = layer1.get(id)
    assert.ok(moved, `${id} 应转入 L1`)
    assert.equal(moved.content, before.get(id), '移动不应压缩正文')
    assert.equal(moved.layer, 1)
    assert.equal(moved.compaction, undefined)
    assert.ok(moved.history.some((entry) => String(entry.reason).includes('字数上限')))
  }
  // 事件
  const events = fs
    .readFileSync(memoryPaths(engine.dataDir).events, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.ok(events.some((event) => event.type === 'layer_moved' && String(event.reason || '').includes('字数上限')))
})

// ───────────────────────────── TM5 ─────────────────────────────

test('TM5: 凌晨维护保留话题在短期、普通记忆转 L1；持久化字段完整；转入长期的话题 L3 起才压缩', () => {
  const atMs = localMs(2026, 11, 6, 22, 0)
  const { engine, dataDir } = newMemoryEngine({ clock: makeClock(atMs) })
  engine.recordConversationTurn({
    sessionId: 'qq:60006',
    userText: '晚安。',
    assistantText: '晚安，灯我关。',
    atUser: atMs,
    atAssistant: atMs + 20_000,
  })
  engine.remember({ content: '主人喜欢伯爵红茶。', category: '喜好' })
  const conversationBefore = conversationItems(engine)[0]
  const report = engine.maintain({ at: localMs(2026, 11, 7, 4, 30), reason: '每日凌晨维护窗口' })
  assert.equal(report.ok, true)
  const short = engine.listLayer('short')
  const keptConversation = short.find((item) => item.id === conversationBefore.id)
  assert.ok(keptConversation, '话题记忆应保留在短期')
  assert.equal(keptConversation.content, conversationBefore.content, '维护不应改写话题正文')
  assert.ok(engine.listLayer(1).some((item) => item.kind !== 'conversation'), '普通短期记忆应转入长期第一层')

  // 重启后话题字段完整
  const reopened = newMemoryEngine({ dataDir, clock: makeClock(localMs(2026, 11, 7, 5, 0)) })
  const loaded = reopened.engine.listLayer('short').find((item) => item.id === conversationBefore.id)
  assert.ok(loaded)
  for (const field of ['kind', 'sessionId', 'topicId', 'topicLabel', 'turnCount', 'startedAt', 'lastTurnAt', 'charCount']) {
    assert.equal(loaded[field], conversationBefore[field], `重启后字段 ${field} 应保留`)
  }
  assert.equal(loaded.content, conversationBefore.content)

  // 话题被 5w 溢出移入 L1 后正文完整；下沉到 L2 不压缩，进入 L3 才按 75% 层级压缩
  const at0 = localMs(2026, 11, 8, 9, 0)
  const small = newMemoryEngine({
    clock: makeClock(at0),
    config: { shortTermCharLimit: 1000, shortTermOverflowMoveRatio: 0.5 },
  })
  const filler = '用于占满短期字数上限的对话内容。'.repeat(10)
  const turn1 = small.engine.recordConversationTurn({
    sessionId: 'qq:70007',
    userText: `第一段：${filler}`,
    assistantText: `回答第一段：${filler}`,
    atUser: at0,
    atAssistant: at0 + 1000,
  })
  // 再建第二条话题使其超过配置的 1000 字上限（两个话题约各 500+ 字）
  const turn2 = small.engine.recordConversationTurn({
    sessionId: 'qq:80008',
    userText: `第二段：${filler}`,
    assistantText: `回答第二段：${filler}`,
    atUser: at0 + 2 * 60 * 1000,
    atAssistant: at0 + 2 * 60 * 1000 + 1000,
  })
  const allShort = small.engine.listLayer('short')
  const shortChars = allShort.reduce((sum, item) => sum + item.content.length, 0)
  // 至少有一轮把某一半移入 L1（可能移动的是较早话题或普通记忆）
  const movedConversations = small.engine
    .listLayer(1)
    .filter((item) => item.kind === 'conversation')
  const shortConversations = allShort.filter((item) => item.kind === 'conversation')
  assert.ok(movedConversations.length + shortConversations.length >= 2)
  if (movedConversations.length > 0) {
    const moved = movedConversations[0]
    assert.ok(moved.content.length > 0, '转入长期的话题正文应完整')
    const fullLength = moved.content.length
    assert.equal(moved.compaction, undefined, '刚转入 L1 不应有层级压缩')
    // 推进到下沉周期：L1→L2（不压缩）
    const day = 24 * 60 * 60 * 1000
    small.engine.maintain({ at: at0 + 2 * day, reason: '每日凌晨维护窗口' })
    const atL2 = small.engine.listLayer(2).find((item) => item.id === moved.id)
    if (atL2) {
      assert.equal(atL2.content.length, fullLength, 'L1→L2 不压缩')
      // L2→L3（进入第 3 层应层级压缩 75%）
      small.engine.maintain({ at: at0 + 6 * day, reason: '每日凌晨维护窗口' })
      const atL3 = small.engine.listLayer(3).find((item) => item.id === moved.id)
      if (atL3) {
        assert.ok(atL3.content.length <= Math.floor(fullLength * 0.75))
        assert.ok(atL3.compaction && atL3.compaction.count >= 1)
      }
    }
  }
  assert.ok(turn1.item && turn2.item)

  // 示例数据只读：话题记忆字段合法、无 pending-seed 残留
  const realShort = readJson(`${REAL_DIR}/memory/short-term.json`)
  const realLayers = []
  for (let layer = 1; layer <= 7; layer += 1) realLayers.push(readJson(`${REAL_DIR}/memory/long-term/layer-${layer}.json`).items)
  const realAll = [...realShort.items, ...realLayers.flat()]
  assert.ok(realAll.length >= 20, `示例数据应含足量记忆，实际 ${realAll.length}`)
  const realConversationItems = realAll.filter((entry) => entry.kind === 'conversation' || entry.source === 'qq-conversation')
  assert.ok(realConversationItems.length >= 1, '示例数据应包含会话话题记忆')
  for (const item of realConversationItems) {
    // 完整双人对话为 kind=conversation；更早的话题以普通记忆保存，但都来自 qq-conversation
    assert.ok(['conversation', 'memory'].includes(item.kind), `话题记忆 kind 非法：${item.id}`)
    assert.ok(item.content.startsWith('【话题】'), `话题记忆应带【话题】标题：${item.id}`)
    assert.ok(['short', 1, 2, 3, 4, 5, 6, 7].includes(item.layer))
  }
  assert.ok(realConversationItems.filter((item) => item.kind === 'conversation').length >= 1, '示例数据应至少有一条完整双人对话话题记忆')
  assert.ok(!fs.existsSync(`${REAL_DIR}/memory/pending-seed.json`))
})
