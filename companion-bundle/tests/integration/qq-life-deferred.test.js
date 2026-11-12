/**
 * 每日事件：对话中延迟；到点后按当时上下文生成内容；发送后写记忆。
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

test('QC20：每日事件在对话中直接取消，之后的事件按点生成并写记忆', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-life-deferred-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const charactersDir = path.join(root, 'characters')
  const dataDir = path.join(charactersDir, 'ophelia')
  fs.mkdirSync(path.join(dataDir, 'life'), { recursive: true })
  const dateKey = '2026-11-09'
  const plan = {
    ...createPlanShell({ dateKey, characterId: 'ophelia', nowIso: `${dateKey}T00:10:00+08:00`, source: 'test' }),
    deferredContent: true,
    events: [
      { id: 'evt-1', time: '19:50', type: '整理', pending: true, sentAt: null },
      { id: 'evt-2', time: '22:00', type: '阅读', pending: true, sentAt: null },
    ],
  }
  saveDayPlan(dataDir, plan)

  let now = new Date(`${dateKey}T20:00:00+08:00`).getTime()
  const sent = []
  const remembered = []
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
  const memory = {
    ensure() {},
    renderDigest: () => '【记忆】主人最近在忙论文。',
    listLayer: () => [],
    ingestMessage: () => ({ created: [], mentioned: [] }),
    recordConversationTurn: () => ({ ok: true, item: { id: 'conv-1' } }),
    remember: (input) => {
      remembered.push(input)
      return { ok: true, item: { id: 'mem-1' } }
    },
  }
  const host = createQQHost({
    config: {
      charactersDir,
      characterId: 'ophelia',
      botQQ: BOT_QQ,
      allowUsers: [OWNER_QQ],
      proactiveEnabled: true,
      proactiveIntervalMs: 600000,
      lifeDeferredContent: true,
      lifeQuietMinutes: 5,
      bubbleDelayMs: 0,
    },
    deps: {
      clock: { now: () => now },
      persona: { renderPersonaSection: () => '【人设】奥菲莉亚', lookup: () => ({ ok: false }) },
      memory,
      adapter,
      replyEngine: {
        generate: async () => ({ text: '我在。' }),
        generateWithPrompt: async () => '（把书页压平）我刚在整理第七阅览室的索引，忽然想起您论文里那句话。',
      },
    },
  })

  await host.handleInbound({
    id: 'm-1',
    channel: 'qq',
    adapterId: adapter.id,
    userId: OWNER_QQ,
    text: '还在写论文',
    receivedAt: now - 60 * 1000,
    meta: {},
  })
  const canceled = await host.checkLifeEvents()
  assert.equal(canceled.canceled, 1)
  assert.equal(canceled.sent, 0)
  assert.equal(sent.length, 1, '只有普通回复，到点生活事件被取消')

  now = new Date(`${dateKey}T22:01:00+08:00`).getTime()
  const delivered = await host.checkLifeEvents()
  assert.equal(delivered.sent, 1)
  assert.equal(sent.length, 2)
  assert.match(sent[1].text, /整理|索引|论文/u)
  assert.ok(remembered.some((item) => item.source === 'life-share'))
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'life', `day-plan-${dateKey}.json`), 'utf8'))
  assert.ok(stored.events[0].canceledAt)
  assert.ok(stored.events[1].sentAt)
  assert.equal(stored.events[1].pending, false)
})
