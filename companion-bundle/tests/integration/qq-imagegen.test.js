/**
 * QC19：QQ 生图链路——触发判断 → 先发送文字回复 → 生成完补发图片；
 * 生图任务在回复发送前启动，图片在最后单独发送。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createQQHost } from '../../lib/qq-host.js'

const BOT_QQ = '123456789'
const OWNER_QQ = '10001'

test('QC19：生图任务先启动，文字回复先发，图片生成完最后补发', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-imagegen-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sent = []
  const events = []
  const imagegen = {
    enabled: true,
    detectTrigger: async () => {
      events.push('detect')
      return { shouldGenerate: true, triggerType: 'new_scene', scene: '雨夜的旧图书馆', title: '雨夜' }
    },
    generate: async () => {
      events.push('generate')
      return { imagePath: 'D:\\tmp\\ophelia-test.png', prompt: 'a rainy library', format: { title: '雨夜' } }
    },
    close: async () => {},
    status: () => ({ enabled: true }),
  }
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
      imagegenEnabled: true,
      bubbleDelayMs: 0,
    },
    deps: {
      persona: { renderPersonaSection: () => 'persona', lookup: () => ({ ok: false }) },
      memory: {
        ensure() {},
        renderDigest: () => 'digest',
        ingestMessage: () => ({ created: [], mentioned: [], skipped: false }),
        recordConversationTurn: () => ({ ok: true, created: true, item: { id: 'conv-1' } }),
      },
      replyEngine: {
        generate: async () => {
          events.push('reply')
          return { text: '雨夜啊……我陪您待一会儿。' }
        },
      },
      adapter,
      imagegen,
    },
  })
  const result = await host.handleInbound({
    id: 'm-image-1',
    channel: 'qq',
    adapterId: adapter.id,
    userId: OWNER_QQ,
    text: '外面下雨了，我们进图书馆吧',
    receivedAt: Date.now(),
    meta: {},
  })
  assert.equal(result.accepted, true)
  assert.equal(result.imageGenerated, true)
  assert.ok(imagegen.enabled)
  assert.deepEqual(events.slice(0, 2), ['detect', 'reply'])
  assert.equal(sent.length, 2, '先文字，后图片')
  assert.equal(sent[0].images, undefined)
  assert.equal(sent[1].images[0], 'D:\\tmp\\ophelia-test.png')
  assert.match(sent[1].text, /画面|递过来/u)
  assert.equal(host.sessions.get(OWNER_QQ).length, 3)
})

