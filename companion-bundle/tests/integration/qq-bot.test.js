/**
 * 覆盖验收项：QC1–QC7（QQ / OneBot 通道）。
 * QC1 OneBot 事件解析；QC2 白名单与自身过滤；QC3 发送动作；QC4 回复引擎与安全清洗；
 * QC5 入站→记忆→回复→会话历史；QC6 配置与生命周期；QC7 示例 QQ 号配置（bot=123456789 / owner=10001）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  OneBotAdapter,
  buildOneBotSendAction,
  isMentionedBot,
  normalizeSegments,
  parseOneBotMessageEvent,
  parseOneBotNoticeEvent,
  segmentsText,
} from '../../lib/im/onebot.js'
import {
  buildReplyPrompts,
  createReplyEngine,
  detectOnDemandModules,
  renderHistory,
  sanitizeReply,
} from '../../lib/im/reply-engine.js'
import { createQQHost, createSessionStore, normalizeConfig } from '../../lib/qq-host.js'

const BOT_QQ = '123456789'
const OWNER_QQ = '10001'

/** 假 socket：实现 addEventListener/send/close，便于驱动 OneBotAdapter。 */
function createFakeSocket() {
  const listeners = new Map()
  const sent = []
  return {
    url: 'ws://fake',
    sent,
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    emit(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event)
    },
    send(data) {
      sent.push(JSON.parse(data))
    },
    close() {
      this.emit('close', { code: 1000 })
    },
  }
}

/** 构造 OneBot 11 事件。 */
function oneBotEvent(overrides = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: Number(BOT_QQ),
    user_id: Number(OWNER_QQ),
    message_id: 1001,
    time: 1762345678,
    raw_message: '今天好累',
    message: [{ type: 'text', data: { text: '今天好累' } }],
    sender: { nickname: '主人' },
    ...overrides,
  }
}

test('QC1：OneBot 事件解析（私聊 / 群聊 @ / 未 @ / 自身 / CQ 字符串）', () => {
  const privateMessage = parseOneBotMessageEvent(oneBotEvent(), { selfId: BOT_QQ })
  assert.equal(privateMessage.channel, 'qq')
  assert.equal(privateMessage.userId, OWNER_QQ)
  assert.equal(privateMessage.text, '今天好累')
  assert.equal(privateMessage.id, '1001')

  const groupEvent = oneBotEvent({
    message_type: 'group',
    group_id: 998877,
    message: [
      { type: 'at', data: { qq: BOT_QQ } },
      { type: 'text', data: { text: ' 陪我聊聊天' } },
    ],
    raw_message: `[CQ:at,qq=${BOT_QQ}] 陪我聊聊天`,
  })
  const groupMessage = parseOneBotMessageEvent(groupEvent, { selfId: BOT_QQ })
  assert.equal(groupMessage.text, '陪我聊聊天')
  assert.equal(groupMessage.meta.groupId, '998877')

  const noMention = parseOneBotMessageEvent(
    oneBotEvent({ message_type: 'group', group_id: 1, message: [{ type: 'text', data: { text: '路过' } }] }),
    { selfId: BOT_QQ },
  )
  assert.equal(noMention, undefined)

  assert.equal(parseOneBotMessageEvent(oneBotEvent({ user_id: Number(BOT_QQ) }), { selfId: BOT_QQ }), undefined)
  assert.equal(parseOneBotMessageEvent({ post_type: 'meta_event' }, { selfId: BOT_QQ }), undefined)
  assert.equal(parseOneBotMessageEvent(oneBotEvent({ message: [] }), { selfId: BOT_QQ }), undefined)

  // 字符串 / CQ 码形式
  const segments = normalizeSegments(`[CQ:at,qq=${BOT_QQ}] 你好呀 [CQ:face,id=1]`)
  assert.equal(isMentionedBot(segments, BOT_QQ), true)
  assert.equal(segmentsText(segments).trim(), '你好呀')
})

test('QC3：OneBot 发送动作（私聊 / 群聊回复带 @）', () => {
  const privateAction = buildOneBotSendAction({ text: '辛苦了，主人。', userId: OWNER_QQ })
  assert.equal(privateAction.action, 'send_private_msg')
  assert.equal(privateAction.params.user_id, Number(OWNER_QQ))
  assert.deepEqual(privateAction.params.message, [{ type: 'text', data: { text: '辛苦了，主人。' } }])

  const groupAction = buildOneBotSendAction({ text: '我在。', userId: OWNER_QQ, meta: { groupId: '998877' } })
  assert.equal(groupAction.action, 'send_group_msg')
  assert.equal(groupAction.params.group_id, 998877)
  assert.deepEqual(groupAction.params.message[0], { type: 'at', data: { qq: Number(OWNER_QQ) } })
  assert.equal(groupAction.params.message[1].data.text, ' 我在。')

  assert.throws(() => buildOneBotSendAction({ text: '   ', userId: OWNER_QQ }), /缺少文本/)
})

test('QC1/QC3：OneBotAdapter 在假 socket 上启动、收消息、发消息、停止', async () => {
  const socket = createFakeSocket()
  const adapter = new OneBotAdapter({ url: 'ws://fake', selfId: BOT_QQ, socketFactory: () => socket })
  const received = []
  await adapter.start({ onMessage: (inbound) => received.push(inbound) })
  socket.emit('open')
  assert.equal(adapter.state, 'running')

  // 收消息
  socket.emit('message', { data: JSON.stringify(oneBotEvent({ message_id: 3001 })) })
  assert.equal(received.length, 1)
  assert.equal(received[0].text, '今天好累')

  // 发消息：send 后由假 socket 注入 echo 响应
  const outbound = { text: '辛苦了。', userId: OWNER_QQ }
  const pending = adapter.send(outbound)
  const sentPayload = socket.sent.at(-1)
  assert.equal(sentPayload.action, 'send_private_msg')
  socket.emit('message', { data: JSON.stringify({ echo: sentPayload.echo, status: 'ok', retcode: 0 }) })
  const result = await pending
  assert.equal(result.delivered, true)

  // 群聊消息只处理 @
  socket.emit(
    'message',
    {
      data: JSON.stringify(
        oneBotEvent({
          message_type: 'group',
          group_id: 42,
          message_id: 3002,
          message: [{ type: 'at', data: { qq: BOT_QQ } }, { type: 'text', data: { text: ' 在吗' } }],
        }),
      ),
    },
  )
  assert.equal(received.length, 2)
  assert.equal(received[1].text, '在吗')

  await adapter.stop()
  assert.equal(adapter.state, 'stopped')
})

test('QC4：回复引擎——人设 + 记忆 + 按需档案 + 历史 + 安全清洗', async () => {
  const persona = {
    renderPersonaSection: () => '【人设 · 始终生效】\n你是奥菲莉亚。',
    lookup: (id) =>
      id === 'appearance'
        ? { ok: true, label: '外貌', content: '银白色长发、琥珀色眼睛。' }
        : { ok: false, error: '未找到' },
  }
  const memory = { renderDigest: ({ latestUserText }) => `【记忆】与「${latestUserText}」相关：主人喜欢雨天。` }
  let lastOptions
  let lastPrepare
  const llm = {
    prepareCall: async (config) => {
      lastPrepare = config
      return {
        config: { ...config },
        stream: (options) => {
          lastOptions = options
          return (async function* () {
            yield { type: 'text-delta', text: '看这里 https://example.com 和 [链接](https://example.org) 哦。' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
  const engine = createReplyEngine({
    persona,
    memory,
    llm,
    modelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    config: { maxReplyChars: 200 },
  })
  const reply = await engine.generate({
    text: '你长什么样子？',
    history: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '主人，晚上好。' }],
  })
  assert.equal(reply.onDemandModules.includes('appearance'), true)
  assert.match(reply.system, /银白色长发/)
  assert.match(reply.system, /【记忆】/)
  assert.match(reply.user, /最近的对话/)
  assert.equal(lastPrepare.provider, 'deepseek-official')
  assert.equal(lastPrepare.model, 'deepseek-flash')
  assert.equal(Array.isArray(lastOptions.messages), true)
  assert.match(reply.text, /看这里/)
  assert.doesNotMatch(reply.text, /https?:\/\//)

  // 普通寒暄不注入按需档案
  const plain = await engine.generate({ text: '今天好累啊' })
  assert.deepEqual(plain.onDemandModules, [])
  assert.doesNotMatch(plain.system, /银白色长发/)

  // 空回复 / 无路由报错
  const emptyLlm = {
    prepareCall: async (config) => ({
      config: { ...config },
      stream: () =>
        (async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
    }),
  }
  const emptyEngine = createReplyEngine({ persona, memory, llm: emptyLlm, modelSelection: () => ({ provider: 'p', model: 'm' }) })
  await assert.rejects(() => emptyEngine.generate({ text: '在吗' }), /空回复/)
  const noRouteEngine = createReplyEngine({ persona, memory, llm, modelSelection: () => undefined })
  await assert.rejects(() => noRouteEngine.generate({ text: '在吗' }), /模型路由/)
})

test('QC4：清洗与提示词拼装辅助函数', () => {
  const withLink = sanitizeReply('你好 https://x.com 呀')
  assert.doesNotMatch(withLink, /https?:\/\//)
  assert.match(withLink, /你好/)
  assert.match(withLink, /呀/)
  assert.doesNotMatch(sanitizeReply('访问 www.test.com 或 [点我](https://a.b/c) 看看'), /https?:\/\/|www\./)
  assert.ok(sanitizeReply('很长的回复。'.repeat(100), 50).length <= 51)
  assert.equal(renderHistory([{ role: 'user', text: '甲' }, { role: 'assistant', text: '乙' }]), '主人：甲\n奥菲莉亚：乙')
  const persona = { renderPersonaSection: () => '人设段', lookup: () => ({ ok: true, label: '外貌', content: '档案' }) }
  const memory = { renderDigest: () => '记忆段' }
  const prompts = buildReplyPrompts({ text: '你长什么样', persona, memory })
  assert.match(prompts.system, /人设段/)
  assert.match(prompts.system, /记忆段/)
  assert.match(prompts.system, /档案/)
  assert.equal(detectOnDemandModules('今天吃什么好', persona).length >= 1, true)
})

test('QC14：解析「对方正在输入」通知', () => {
  const typing = parseOneBotNoticeEvent({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'input_status',
    self_id: Number(BOT_QQ),
    user_id: Number(OWNER_QQ),
    event_type: 1,
    status_text: '对方正在输入...',
  })
  assert.equal(typing.type, 'input_status')
  assert.equal(typing.userId, OWNER_QQ)
  assert.equal(typing.isTyping, true)
  const stopped = parseOneBotNoticeEvent({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'input_status',
    self_id: Number(BOT_QQ),
    user_id: Number(OWNER_QQ),
    event_type: 2,
    status_text: '取消输入',
  })
  assert.equal(stopped.isTyping, false)
  assert.equal(parseOneBotNoticeEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'other', user_id: 1 }), undefined)
  assert.equal(
    parseOneBotNoticeEvent({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'input_status',
      self_id: Number(BOT_QQ),
      user_id: Number(BOT_QQ),
    }),
    undefined,
    '机器人自己的输入状态不处理',
  )
})

test('QC5：QQ Host——白名单、记忆写入、回复、会话历史与去重', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-qq-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const charactersDir = path.join(root, 'characters')
  const ingestCalls = []
  const conversationCalls = []
  const sent = []
  const persona = { renderPersonaSection: () => 'persona', lookup: () => ({ ok: false }) }
  const memory = {
    ensure() {},
    renderDigest: () => 'digest',
    ingestMessage: (input) => {
      ingestCalls.push(input)
      return { created: [], mentioned: [], skipped: false }
    },
    recordConversationTurn: (input) => {
      conversationCalls.push(input)
      return { ok: true, created: true, item: { id: 'conv-1' } }
    },
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
  const replyEngine = { generate: async ({ text }) => ({ text: `奥菲莉亚收到：${text}`, system: 's', user: 'u', onDemandModules: [] }) }
  const host = createQQHost({
    config: { charactersDir, characterId: 'ophelia', botQQ: BOT_QQ, allowUsers: [OWNER_QQ] },
    deps: { persona, memory, replyEngine, adapter },
  })
  assert.equal(host.isAllowed({ userId: OWNER_QQ, meta: {} }), true)
  assert.equal(host.isAllowed({ userId: '999999', meta: {} }), false)
  assert.equal(host.isAllowed({ userId: BOT_QQ, meta: {} }), false)

  const inbound = {
    id: 'm-1',
    channel: 'qq',
    adapterId: adapter.id,
    userId: OWNER_QQ,
    text: '今天好累',
    receivedAt: Date.now(),
    meta: {},
  }
  const result = await host.handleInbound(inbound)
  assert.equal(result.accepted, true)
  assert.equal(result.reply, '奥菲莉亚收到：今天好累')
  assert.equal(ingestCalls.length, 1)
  assert.equal(ingestCalls[0].sessionId, `qq:${OWNER_QQ}`)
  assert.equal(ingestCalls[0].autoExtract, false, 'QQ 不再拆分模糊事实')
  assert.equal(conversationCalls.length, 1, '应把完整的一轮对话写入话题记忆')
  assert.equal(conversationCalls[0].sessionId, `qq:${OWNER_QQ}`)
  assert.equal(conversationCalls[0].userText, '今天好累')
  assert.equal(conversationCalls[0].assistantText, '奥菲莉亚收到：今天好累')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].userId, OWNER_QQ)
  const history = host.sessions.get(OWNER_QQ)
  assert.equal(history.length, 2)
  assert.equal(history[0].role, 'user')
  assert.equal(history[1].role, 'assistant')

  // 重复 messageId 不重复回复/写记忆
  const duplicate = await host.handleInbound(inbound)
  assert.equal(duplicate.accepted, false)
  assert.equal(duplicate.reason, 'duplicate')
  assert.equal(sent.length, 1)
  assert.equal(ingestCalls.length, 1)
  assert.equal(conversationCalls.length, 1)

  // 非白名单用户不处理
  const blocked = await host.handleInbound({ ...inbound, id: 'm-2', userId: '999999' })
  assert.equal(blocked.accepted, false)
  assert.equal(blocked.reason, 'not_allowed')
  assert.equal(sent.length, 1)

  // 状态文件（便于真机联调时检查连接情况）
  host.writeStatus()
  assert.ok(fs.existsSync(host.statusFile))
  const statusDoc = JSON.parse(fs.readFileSync(host.statusFile, 'utf8'))
  assert.equal(statusDoc.botQQ, BOT_QQ)
  assert.deepEqual(statusDoc.allowUsers, [OWNER_QQ])
  assert.equal(statusDoc.onebotUrl, 'ws://127.0.0.1:3001')
})

test('QC6/QC7：配置解析与会话存储（示例 QQ 号：bot=123456789，owner=10001）', (t) => {
  const charactersDir = path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data', 'characters')
  const settings = normalizeConfig({
    charactersDir,
    characterId: 'ophelia',
    botQQ: 123456789,
    allowUsers: [10001],
  })
  assert.equal(settings.charactersDir, path.resolve(charactersDir))
  assert.equal(settings.botQQ, '123456789')
  assert.deepEqual(settings.allowUsers, ['10001'])
  assert.equal(settings.characterId, 'ophelia')
  assert.equal(settings.onebotUrl, 'ws://127.0.0.1:3001')
  assert.equal(settings.historyLimit, 8)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-qq-store-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'qq', 'sessions.json')
  const store = createSessionStore(file, 2) // historyLimit=2 → 最多保留 4 条
  store.append(OWNER_QQ, 'user', '甲')
  store.append(OWNER_QQ, 'assistant', '乙')
  store.append(OWNER_QQ, 'user', '丙')
  store.append(OWNER_QQ, 'assistant', '丁')
  store.append(OWNER_QQ, 'user', '戊')
  assert.deepEqual(store.get(OWNER_QQ).map((entry) => entry.text), ['乙', '丙', '丁', '戊'])
  store.load?.()
  const reloaded = createSessionStore(file, 2)
  assert.deepEqual(reloaded.get(OWNER_QQ).map((entry) => entry.text), ['乙', '丙', '丁', '戊'])
  assert.ok(fs.existsSync(file))
})
