/**
 * QC17：NapCat「正在输入」→ 持续关注 → 主动搭话（阈值/冷却/白名单）。
 * 使用可推进的假时钟 + 真实短定时器，不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createQQHost } from '../../lib/qq-host.js'

const BOT_QQ = '123456789'
const OWNER_QQ = '10001'

function makeHost(replyImpl) {
  let now = new Date('2026-11-09T12:00:00+08:00').getTime()
  const sent = []
  const adapter = {
    id: 'fake',
    start: async () => ({ state: 'running' }),
    stop: async () => ({ state: 'stopped' }),
    send: async (outbound) => {
      sent.push(outbound)
      return { delivered: true }
    },
    status: () => ({ state: 'running' }),
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-attention-'))
  const host = createQQHost({
    config: {
      charactersDir: root,
      characterId: 'ophelia',
      botQQ: BOT_QQ,
      allowUsers: [OWNER_QQ],
      bubbleDelayMs: 0,
      attentionEnabled: true,
      attentionThresholdMs: 3000,
      attentionCooldownMs: 60000,
      proactiveEnabled: false,
    },
    deps: {
      clock: { now: () => now },
      persona: {
        renderPersonaSection: () => '【人设】奥菲莉亚',
        getDefinition: () => ({ character: { name: '奥菲莉亚', userAddress: '主人' } }),
        lookup: () => ({ ok: false }),
      },
      memory: {
        renderDigest: () => '【记忆】主人喜欢雨天。',
        listLayer: (layer) => layer === 'short' ? [{ id: 'm1', summary: '主人喜欢雨天，雨声让人安心。', content: '主人喜欢雨天。', keywords: ['雨天', '主人', '安心'] }] : [],
        ingestMessage: () => ({ created: [], mentioned: [] }),
        ensure() {},
      },
      adapter,
      replyEngine: {
        generate: async () => ({ text: '收到。' }),
        generateWithPrompt: replyImpl ?? (async () => '（把手里的事停了停）刚才那件事，我还在想……您那边现在忙吗？'),
      },
    },
  })
  return {
    host,
    sent,
    root,
    advance(ms) {
      now += ms
    },
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('QC17：持续输入超过阈值会主动搭话，冷却期内不重复', async (t) => {
  const { host, sent, root, advance } = makeHost()
  t.after(() => {
    host.stopAttention?.()
    fs.rmSync(root, { recursive: true, force: true })
  })
  host.handleNotice({ type: 'input_status', userId: OWNER_QQ, isTyping: true, statusText: '对方正在输入...' })
  advance(3100)
  await wait(3100)
  assert.equal(sent.length, 1, '超过阈值应主动发一条')
  assert.match(sent[0].text, /刚才那件事|忙/) 
  assert.ok(host.status().attention.lastAt)

  advance(1000)
  host.handleNotice({ type: 'input_status', userId: OWNER_QQ, isTyping: true, statusText: '对方正在输入...' })
  advance(3100)
  await wait(3100)
  assert.equal(sent.length, 1, '冷却期内不应重复搭话')

  host.handleNotice({ type: 'input_status', userId: '999999', isTyping: true })
  advance(3100)
  await wait(3100)
  assert.equal(sent.length, 1, '非白名单不应触发')
})


test('QC18：主动话题优先上下文，其次短期记忆，最后随机', async (t) => {
  const replies = [
    '{"hasTopic":false}',
    '{"hasTopic":true,"message":"（翻着旧记录）您上次说的那本书，后来找到了吗？"}',
    '（把窗边的纸挪了挪）刚才风把纸吹得响了一下。',
  ]
  let index = 0
  const fakeReply = async () => replies[Math.min(index++, replies.length - 1)]
  const { host, sent, root, advance } = makeHost(fakeReply)
  t.after(() => {
    host.stopAttention?.()
    fs.rmSync(root, { recursive: true, force: true })
  })
  host.handleNotice({ type: 'input_status', userId: OWNER_QQ, isTyping: true })
  advance(3100)
  await wait(3100)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /那本书|翻着旧记录/)

  // 独立宿主：上下文和短期记忆都没有可聊的，才走随机
  let index2 = 0
  const fakeReply2 = async () => {
    index2 += 1
    if (index2 === 1) return '{"hasTopic":false}'
    if (index2 === 2) return '{"hasTopic":false}'
    return '（把窗边的纸挪了挪）刚才风把纸吹得响了一下。'
  }
  const second = makeHost(fakeReply2)
  t.after(() => {
    second.host.stopAttention?.()
    fs.rmSync(second.root, { recursive: true, force: true })
  })
  second.host.handleNotice({ type: 'input_status', userId: OWNER_QQ, isTyping: true })
  second.advance(3100)
  await wait(3100)
  assert.equal(second.sent.length, 1)
  assert.match(second.sent[0].text, /风把纸/)
})
