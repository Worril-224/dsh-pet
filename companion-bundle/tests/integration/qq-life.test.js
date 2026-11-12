/**
 * 功能2（QQ 主动分享）集成测试：
 *  - 读取当天 life 计划，到点事件主动发给白名单主人（多气泡）；
 *  - 发送成功后标记 sentAt 并落盘，第二次检查不重发；
 *  - 模型生成失败时使用兜底短句；
 *  - 没有计划时不误发。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createQQHost } from '../../lib/qq-host.js'
import { createPlanShell, saveDayPlan } from '../../lib/life/index.js'

const BOT_QQ = '123456789'
const OWNER_QQ = '10001'

function fixedClock(date) {
  return { now: () => date.getTime() }
}

function makeHost(root, deps = {}) {
  const sent = []
  const adapter = {
    id: 'fake-adapter',
    start: async () => ({ state: 'running' }),
    stop: async () => ({ state: 'stopped' }),
    send: async (outbound) => {
      sent.push(outbound)
      return { delivered: true }
    },
    status: () => ({ state: 'running' }),
  }
  const host = createQQHost({
    config: {
      charactersDir: path.join(root, 'characters'),
      characterId: 'ophelia',
      botQQ: BOT_QQ,
      allowUsers: [OWNER_QQ],
      bubbleDelayMs: 0,
      proactiveEnabled: true,
      proactiveIntervalMs: 600000,
    },
    deps: {
      clock: deps.clock,
      persona: {
        renderPersonaSection: () => '【人设】奥菲莉亚',
        getDefinition: () => ({ character: { name: '奥菲莉亚', userAddress: '主人' } }),
        lookup: () => ({ ok: false }),
      },
      memory: { renderDigest: () => '【记忆】主人喜欢雨天。', ingestMessage: () => ({ created: [], mentioned: [] }), ensure() {} },
      adapter,
      replyEngine: deps.replyEngine ?? { generate: async () => ({ text: '好', webSearchUsed: false }), generateWithPrompt: async () => '第一段。\n第二段。' },
      ...deps.extra,
    },
  })
  return { host, sent }
}

function dateAt(hour, minute = 0, day = 6) {
  return new Date(2026, 10, day, hour, minute, 0, 0)
}

test('QL1：到点事件主动发送（多气泡）+ 标记 sentAt + 不重发 + 写入记忆', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-life-qq-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'characters', 'ophelia')
  fs.mkdirSync(path.join(dataDir, 'life'), { recursive: true })
  const clock = fixedClock(dateAt(10, 5))
  const remembered = []
  const plan = {
    ...createPlanShell({ dateKey: '2026-11-06', characterId: 'ophelia', nowIso: '2026-11-06T04:10:00+08:00', source: 'test' }),
    events: [
      { id: 'evt-1', time: '09:20', title: '整理旧剪报', type: '日常', content: '我把海边日落的剪报重新压平。', sourceType: 'memory', sentAt: null },
      { id: 'evt-2', time: '13:40', title: '读一篇散文', type: '阅读', content: '读到一篇写雨的散文。', sourceType: 'web', sentAt: null },
    ],
  }
  saveDayPlan(dataDir, plan)
  const { host, sent } = makeHost(root, {
    clock,
    extra: {
      memory: {
        renderDigest: () => '【记忆】主人喜欢雨天。',
        ingestMessage: () => ({ created: [], mentioned: [] }),
        remember: (input) => remembered.push(input),
        ensure() {},
      },
    },
  })
  assert.equal(host.settings.proactiveEnabled, true)

  const first = await host.checkLifeEvents()
  assert.equal(first.sent, 1)
  assert.equal(first.events[0].id, 'evt-1')
  assert.equal(sent.length, 2) // 两个气泡
  assert.deepEqual(sent.map((item) => item.text), ['第一段。', '第二段。'])
  assert.equal(remembered.length, 1)
  assert.match(remembered[0].content, /生活分享/)
  assert.match(remembered[0].content, /整理旧剪报/)
  assert.equal(remembered[0].source, 'life-share')
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'life', 'day-plan-2026-11-06.json'), 'utf8'))
  assert.ok(stored.events[0].sentAt)
  assert.equal(stored.events[1].sentAt, null)

  const second = await host.checkLifeEvents()
  assert.equal(second.sent, 0)
  assert.equal(sent.length, 2)
  assert.equal(remembered.length, 1)
})

test('QL2：模型失败时用兜底文案；未来事件不发送；无计划不误发', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-life-qq-fallback-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'characters', 'ophelia')
  fs.mkdirSync(path.join(dataDir, 'life'), { recursive: true })
  const clock = fixedClock(dateAt(10, 5))
  const plan = {
    ...createPlanShell({ dateKey: '2026-11-06', characterId: 'ophelia', nowIso: '2026-11-06T04:10:00+08:00', source: 'test' }),
    events: [
      { id: 'evt-1', time: '09:20', title: '整理旧剪报', content: '我把海边日落的剪报重新压平。', sourceType: 'memory', sentAt: null },
      { id: 'evt-2', time: '13:40', title: '读一篇散文', content: '读到一篇写雨的散文。', sourceType: 'web', sentAt: null },
    ],
  }
  saveDayPlan(dataDir, plan)
  const { host, sent } = makeHost(root, {
    clock,
    replyEngine: {
      generate: async () => ({ text: '好' }),
      generateWithPrompt: async () => {
        throw new Error('llm down')
      },
    },
  })
  const result = await host.checkLifeEvents()
  assert.equal(result.sent, 1)
  assert.equal(sent.length >= 1, true)
  assert.match(sent[0].text, /主人/)
  assert.equal(sent[0].meta?.groupId, undefined)

  // 没有当天计划：不会误发；ensureDayPlan 尝试生成（这里 fake 依赖不全会失败，但必须安全返回）
  const noPlanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-life-qq-noplan-'))
  t.after(() => fs.rmSync(noPlanRoot, { recursive: true, force: true }))
  const { host: noPlanHost, sent: noPlanSent } = makeHost(noPlanRoot, { clock })
  const noPlan = await noPlanHost.checkLifeEvents()
  assert.equal(noPlan.sent, 0)
  assert.equal(noPlanSent.length, 0)
})
