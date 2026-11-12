/**
 * 独立验收测试 · QQ 通道（NapCat / OneBot 11，QC1–QC7）
 * 覆盖验收编号：QC1 OneBot 事件解析、QC2 白名单与自身过滤、QC3 发送动作、
 *             QC4 回复引擎与安全清洗、QC5 入站→记忆→回复→会话历史、
 *             QC6 配置与生命周期、QC7 真实 QQ 号配置（静态/真机状态文件只读）。
 *
 * 约束：不连接真实网络、不向真实 QQ 发消息。所有 socket 均为假 socket（socketFactory 注入），
 *       LLM/适配器/记忆/人设均可注入；除 QC7 只读核对真实 status.json/patch 外不读写 companion-data。
 * 测试由验收员 verifier 独立设计编写，不复用开发者测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  OneBotAdapter,
  buildOneBotSendAction,
  isMentionedBot,
  normalizeSegments,
  parseOneBotMessageEvent,
  segmentsText,
  stripMention,
} from '../../companion-bundle/lib/im/onebot.js'
import {
  buildReplyPrompts,
  collectReplyText,
  createReplyEngine,
  detectOnDemandModules,
  renderHistory,
  renderOnDemandSection,
  sanitizeReply,
} from '../../companion-bundle/lib/im/reply-engine.js'
import { createQQHost, createSessionStore, normalizeConfig } from '../../companion-bundle/lib/qq-host.js'
import { cleanupTempDirs, makeTempDir } from './helpers.mjs'

test.after(cleanupTempDirs)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLE = path.join(ROOT, 'companion-bundle')
const REAL_STATUS = path.join(ROOT, 'companion-data', 'characters', 'ophelia', 'qq', 'status.example.json')
const BOT_QQ = '123456789'
const OWNER_QQ = '10001'

// ───────────────────────────── 测试替身 ─────────────────────────────

/** 假 WebSocket：可手动 emit open/message/close/error，记录 send 的 payload。 */
function createFakeSocket() {
  const listeners = new Map()
  const socket = {
    sent: [],
    closed: false,
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    emit(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event)
    },
    send(data) {
      socket.sent.push(JSON.parse(data))
    },
    close() {
      socket.closed = true
      socket.emit('close', { code: 1000 })
    },
  }
  return socket
}

/** 构造 OneBot 11 消息事件（默认私聊、主人、文本「今天好累」）。 */
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

function makeStubPersona({ missing = [] } = {}) {
  return {
    renderPersonaSection: () => '【人设 · 始终生效】\n你是奥菲莉亚，白色档案馆的记录官。',
    lookup: (moduleId) => {
      if (missing.includes(moduleId)) return { ok: false, error: '未找到' }
      return { ok: true, id: moduleId, label: moduleId, content: `档案正文：${moduleId}` }
    },
  }
}

function makeStubMemory() {
  const calls = []
  return {
    calls,
    renderDigest: (options = {}) => {
      calls.push(options)
      return '【记忆系统 · 自动注入】\n主人喜欢雨天。'
    },
    ingestMessage: () => ({ created: [], mentioned: [], skipped: false }),
  }
}

/** 可编排的假 LLM：记录 prepareCall/stream 参数，按 chunks 输出流。 */
function makeStubLlm({ chunks = [{ type: 'text-delta', text: '好的，主人。' }, { type: 'finish', reason: { kind: 'stop' } }], streamError } = {}) {
  const calls = { prepare: [], stream: [] }
  return {
    calls,
    prepareCall: async (config) => {
      calls.prepare.push(config)
      return {
        config: { ...config },
        stream: (options) => {
          calls.stream.push(options)
          if (streamError) throw streamError
          return (async function* () {
            for (const chunk of chunks) yield chunk
          })()
        },
      }
    },
  }
}

// ───────────────────────────── QC1 OneBot 事件解析 ─────────────────────────────

test('QC1: 私聊/群聊@/未@/自身/空文本/非消息事件解析为统一 Inbound', () => {
  const privateMsg = parseOneBotMessageEvent(oneBotEvent(), { selfId: BOT_QQ, adapterId: 'qq-onebot:test' })
  assert.equal(privateMsg.channel, 'qq')
  assert.equal(privateMsg.adapterId, 'qq-onebot:test')
  assert.equal(privateMsg.userId, OWNER_QQ)
  assert.equal(privateMsg.text, '今天好累')
  assert.equal(privateMsg.id, '1001')
  assert.equal(privateMsg.receivedAt, 1762345678000, 'time（秒）应转换为毫秒')
  assert.equal(privateMsg.meta.messageType, 'private')
  assert.equal(privateMsg.userName, '主人')

  // 群聊 @：段数组（at + text），去掉 @ 后保留正文
  const group = parseOneBotMessageEvent(
    oneBotEvent({
      message_type: 'group',
      group_id: 998877,
      message: [
        { type: 'at', data: { qq: Number(BOT_QQ) } },
        { type: 'text', data: { text: ' 陪我聊聊天' } },
      ],
      raw_message: `[CQ:at,qq=${BOT_QQ}] 陪我聊聊天`,
    }),
    { selfId: BOT_QQ },
  )
  assert.ok(group)
  assert.equal(group.text, '陪我聊聊天')
  assert.equal(group.meta.groupId, '998877')

  // 群聊未 @ → 忽略
  assert.equal(
    parseOneBotMessageEvent(oneBotEvent({ message_type: 'group', group_id: 1, message: [{ type: 'text', data: { text: '路过' } }] }), { selfId: BOT_QQ }),
    undefined,
  )
  // 群聊 @ 的是别人 → 忽略
  assert.equal(
    parseOneBotMessageEvent(
      oneBotEvent({
        message_type: 'group',
        group_id: 1,
        message: [{ type: 'at', data: { qq: 111111 } }, { type: 'text', data: { text: ' 你好' } }],
        raw_message: '[CQ:at,qq=111111] 你好',
      }),
      { selfId: BOT_QQ },
    ),
    undefined,
  )
  // 机器人自己的消息 → 忽略
  assert.equal(parseOneBotMessageEvent(oneBotEvent({ user_id: Number(BOT_QQ) }), { selfId: BOT_QQ }), undefined)
  // 空文本 / 空白文本 → 忽略
  assert.equal(parseOneBotMessageEvent(oneBotEvent({ message: [] }), { selfId: BOT_QQ }), undefined)
  assert.equal(parseOneBotMessageEvent(oneBotEvent({ message: [{ type: 'text', data: { text: '   ' } }] }), { selfId: BOT_QQ }), undefined)
  // 非消息事件 / 未知 message_type → 忽略
  assert.equal(parseOneBotMessageEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }, { selfId: BOT_QQ }), undefined)
  assert.equal(parseOneBotMessageEvent(oneBotEvent({ message_type: 'channel' }), { selfId: BOT_QQ }), undefined)
  assert.equal(parseOneBotMessageEvent(null, { selfId: BOT_QQ }), undefined)
  assert.equal(parseOneBotMessageEvent('event', { selfId: BOT_QQ }), undefined)
})

test('QC1 边界: CQ 字符串/CQ 实体解码/raw_message 回退/stripMention 行为', () => {
  // CQ 字符串 → 段数组
  const segments = normalizeSegments(`[CQ:at,qq=${BOT_QQ}] 你好,世界 [CQ:face,id=1]`)
  assert.equal(segments[0].type, 'at')
  assert.equal(segments[0].data.qq, BOT_QQ)
  assert.equal(segmentsText(segments), ' 你好,世界 ')
  assert.equal(isMentionedBot(segments, BOT_QQ), true)
  assert.equal(isMentionedBot(segments, '123456'), false)
  const cleaned = stripMention(segments, BOT_QQ)
  assert.equal(segmentsText(cleaned).trim(), '你好,世界')
  // CQ 参数值中的实体解码（&#44; , &#91; [ &#93; ] &amp; &）
  const entitySegments = normalizeSegments('[CQ:face,id=1,name=a&#44;b&#91;c&#93;&amp;d]')
  assert.equal(entitySegments.length, 1)
  assert.equal(entitySegments[0].type, 'face')
  assert.equal(entitySegments[0].data.name, 'a,b[c]&d')

  // 段数组：text 中残留 CQ:at 文本也应被 stripMention 去掉
  const mixed = [{ type: 'text', data: { text: `[CQ:at,qq=${BOT_QQ}] 在吗` } }]
  assert.deepEqual(stripMention(mixed, BOT_QQ).map((segment) => segment.data.text), ['在吗'])

  // message 缺失时回退 raw_message（CQ 字符串）
  const fallback = parseOneBotMessageEvent(
    { post_type: 'message', message_type: 'private', self_id: Number(BOT_QQ), user_id: Number(OWNER_QQ), message_id: 2002, time: 1, raw_message: '回退文本', sender: {} },
    { selfId: BOT_QQ },
  )
  assert.ok(fallback)
  assert.equal(fallback.text, '回退文本')

  // 群消息 message 为纯文本数组但 raw_message 含 CQ:at → 通过 raw_message 识别 @，并清理 CQ 文本
  const rawOnlyMention = parseOneBotMessageEvent(
    oneBotEvent({
      message_type: 'group',
      group_id: 5,
      message: [{ type: 'text', data: { text: `[CQ:at,qq=${BOT_QQ}] 在的` } }],
      raw_message: `[CQ:at,qq=${BOT_QQ}] 在的`,
    }),
    { selfId: BOT_QQ },
  )
  assert.ok(rawOnlyMention)
  assert.equal(rawOnlyMention.text, '在的')

  // 空 CQ 串/非字符串 message → 无段
  assert.deepEqual(normalizeSegments(''), [])
  assert.deepEqual(normalizeSegments(undefined), [])
  assert.deepEqual(normalizeSegments(42), [])
})

// ───────────────────────────── QC3 发送动作与适配器 ─────────────────────────────

test('QC3: 发送动作（私聊/群聊带@/空文本拒绝/数值转换）', () => {
  const privateAction = buildOneBotSendAction({ text: ' 辛苦了，主人。 ', userId: OWNER_QQ })
  assert.equal(privateAction.action, 'send_private_msg')
  assert.equal(privateAction.params.user_id, Number(OWNER_QQ))
  assert.deepEqual(privateAction.params.message, [{ type: 'text', data: { text: '辛苦了，主人。' } }])

  const groupAction = buildOneBotSendAction({ text: '我在。', userId: OWNER_QQ, meta: { groupId: '998877' } })
  assert.equal(groupAction.action, 'send_group_msg')
  assert.equal(groupAction.params.group_id, 998877)
  assert.deepEqual(groupAction.params.message[0], { type: 'at', data: { qq: Number(OWNER_QQ) } })
  assert.equal(groupAction.params.message[1].data.text, ' 我在。')

  // 非数字 QQ / 群号保持字符串
  const strIds = buildOneBotSendAction({ text: 'hi', userId: 'not-a-number', meta: { groupId: 'g-1' } })
  assert.equal(strIds.params.userId, undefined)
  assert.equal(strIds.params.group_id, 'g-1')
  const privateStr = buildOneBotSendAction({ text: 'hi', userId: 'abc' })
  assert.equal(privateStr.params.user_id, 'abc')

  // 非法 outbound
  for (const bad of [null, {}, { text: '' }, { text: '   ' }, { text: 42 }]) {
    assert.throws(() => buildOneBotSendAction(bad), /缺少文本/u, `非法出站应被拒绝：${JSON.stringify(bad)}`)
  }
})

test('QC1/QC3: 假 socket 上 OneBotAdapter 启动/收消息/echo 发送/群聊@/停止', async () => {
  const socket = createFakeSocket()
  const adapter = new OneBotAdapter({ id: 'qq-onebot:fake', url: 'ws://fake', selfId: BOT_QQ, socketFactory: () => socket })
  const received = []
  await adapter.start({ onMessage: (inbound) => received.push(inbound) })
  assert.equal(adapter.state, 'starting')
  socket.emit('open')
  assert.equal(adapter.state, 'running')
  assert.deepEqual(adapter.status(), { id: 'qq-onebot:fake', channel: 'qq', state: 'running' })

  // 收消息（JSON 字符串）
  socket.emit('message', { data: JSON.stringify(oneBotEvent({ message_id: 3001 })) })
  assert.equal(received.length, 1)
  assert.equal(received[0].text, '今天好累')
  assert.equal(received[0].adapterId, 'qq-onebot:fake')
  // 非 JSON / 非消息事件不崩溃、不派发
  socket.emit('message', { data: 'not-json' })
  socket.emit('message', { data: JSON.stringify({ post_type: 'meta_event' }) })
  assert.equal(received.length, 1)

  // 私聊发送 + echo 关联
  const pending = adapter.send({ text: '辛苦了。', userId: OWNER_QQ })
  const sentPayload = socket.sent.at(-1)
  assert.equal(sentPayload.action, 'send_private_msg')
  assert.equal(typeof sentPayload.echo, 'string')
  socket.emit('message', { data: JSON.stringify({ echo: sentPayload.echo, status: 'ok', retcode: 0 }) })
  const result = await pending
  assert.equal(result.delivered, true)
  assert.equal(result.reason, undefined)

  // 群聊发送：消息段带 @发送者；echo 失败 → delivered:false + reason
  const groupPending = adapter.send({ text: '收到', userId: OWNER_QQ, meta: { groupId: '42' } })
  const groupPayload = socket.sent.at(-1)
  assert.equal(groupPayload.action, 'send_group_msg')
  assert.deepEqual(groupPayload.params.message[0], { type: 'at', data: { qq: Number(OWNER_QQ) } })
  socket.emit('message', { data: JSON.stringify({ echo: groupPayload.echo, status: 'failed', retcode: 100, wording: '发送失败' }) })
  const groupResult = await groupPending
  assert.equal(groupResult.delivered, false)
  assert.equal(groupResult.reason, '发送失败')

  // 空文本发送被拒绝（不进入 socket）
  await assert.rejects(() => adapter.send({ text: '   ', userId: OWNER_QQ }), /缺少文本/u)

  await adapter.stop()
  assert.equal(adapter.state, 'stopped')
  assert.equal(socket.closed, true)
})

test('QC3/QC6 边界: action 超时/未连接/断线重连/accessToken 不泄漏', async () => {
  // 未连接直接发送 → onebot_not_connected
  const idle = new OneBotAdapter({ url: 'ws://fake', selfId: BOT_QQ, socketFactory: () => createFakeSocket() })
  await assert.rejects(() => idle.send({ text: 'hi', userId: OWNER_QQ }), (error) => error.code === 'onebot_not_connected')
  await idle.stop()

  // action 超时（不注入 echo 响应）
  const socket = createFakeSocket()
  const timeoutAdapter = new OneBotAdapter({ url: 'ws://fake', selfId: BOT_QQ, socketFactory: () => socket, actionTimeoutMs: 1000 })
  await timeoutAdapter.start({ onMessage: () => {} })
  socket.emit('open')
  await assert.rejects(() => timeoutAdapter.send({ text: 'hi', userId: OWNER_QQ }), (error) => error.code === 'onebot_action_timeout')
  await timeoutAdapter.stop()

  // 断线重连：close(1006) → state failed + 定时重连（假 socket 工厂换新 socket）
  const sockets = [createFakeSocket(), createFakeSocket()]
  let factoryCalls = 0
  const reconnectAdapter = new OneBotAdapter({
    url: 'ws://fake',
    selfId: BOT_QQ,
    reconnectMinMs: 500,
    reconnectMaxMs: 1000,
    socketFactory: () => {
      const next = sockets[factoryCalls]
      factoryCalls += 1
      return next
    },
  })
  await reconnectAdapter.start({ onMessage: () => {} })
  sockets[0].emit('open')
  assert.equal(reconnectAdapter.state, 'running')
  sockets[0].emit('close', { code: 1006 })
  assert.equal(reconnectAdapter.state, 'failed')
  assert.match(reconnectAdapter.status().lastError, /code=1006/u)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(factoryCalls, 2, '断线后应按退避重连（创建第二个 socket）')
  sockets[1].emit('open')
  assert.equal(reconnectAdapter.state, 'running')
  assert.equal(reconnectAdapter.status().lastError, undefined)
  await reconnectAdapter.stop()

  // accessToken 拼到连接 URL，但不出现在 status / 默认状态里
  let observedUrl = ''
  const tokenAdapter = new OneBotAdapter({
    url: 'ws://127.0.0.1:3001',
    accessToken: 'secret-token',
    selfId: BOT_QQ,
    socketFactory: (url) => {
      observedUrl = url
      return createFakeSocket()
    },
  })
  await tokenAdapter.start({ onMessage: () => {} })
  assert.equal(observedUrl, 'ws://127.0.0.1:3001?access_token=secret-token')
  assert.ok(!JSON.stringify(tokenAdapter.status()).includes('secret-token'), 'status 不应包含 access token')
  await tokenAdapter.stop()

  // stop 时未完成的 action 应被拒绝并清理（adapter_stopped）
  const stopSocket = createFakeSocket()
  const stopAdapter = new OneBotAdapter({ url: 'ws://fake', selfId: BOT_QQ, socketFactory: () => stopSocket })
  await stopAdapter.start({ onMessage: () => {} })
  stopSocket.emit('open')
  const hanging = stopAdapter.send({ text: 'hi', userId: OWNER_QQ })
  await stopAdapter.stop()
  await assert.rejects(() => hanging, (error) => error.code === 'adapter_stopped')
  assert.equal(stopSocket.sent.length, 1)
})

// ───────────────────────────── QC2 白名单与自身过滤 ─────────────────────────────

test('QC2: Host 白名单（主人/陌生人/机器人自身/allowGroups）', () => {
  const charactersDir = path.join(makeTempDir('dshpet-verify-qq-wl-'), 'characters')
  const host = createQQHost({
    config: { charactersDir, characterId: 'ophelia', botQQ: BOT_QQ, allowUsers: [OWNER_QQ] },
    deps: { persona: makeStubPersona(), memory: makeStubMemory(), replyEngine: { generate: async () => ({ text: 'x', onDemandModules: [] }) }, adapter: { id: 'a', start: async () => ({}), stop: async () => ({}), send: async () => ({ delivered: true }), status: () => ({ state: 'running' }) } },
  })
  assert.equal(host.isAllowed({ userId: OWNER_QQ, meta: {} }), true)
  assert.equal(host.isAllowed({ userId: Number(OWNER_QQ), meta: {} }), true, '数字 QQ 号应等价匹配')
  assert.equal(host.isAllowed({ userId: '999999', meta: {} }), false, '陌生人默认拒绝')
  assert.equal(host.isAllowed({ userId: BOT_QQ, meta: {} }), false, '机器人自身消息忽略')
  assert.equal(host.isAllowed({ userId: OWNER_QQ, meta: { groupId: '123' } }), true, 'allowGroups 为空时不限制群')

  // allowGroups 非空：只服务指定群
  const groupHost = createQQHost({
    config: { charactersDir, characterId: 'ophelia', botQQ: BOT_QQ, allowUsers: [OWNER_QQ], allowGroups: [555] },
    deps: { persona: makeStubPersona(), memory: makeStubMemory(), replyEngine: { generate: async () => ({ text: 'x', onDemandModules: [] }) }, adapter: { id: 'a', start: async () => ({}), stop: async () => ({}), send: async () => ({ delivered: true }), status: () => ({ state: 'running' }) } },
  })
  assert.equal(groupHost.isAllowed({ userId: OWNER_QQ, meta: { groupId: '555' } }), true)
  assert.equal(groupHost.isAllowed({ userId: OWNER_QQ, meta: { groupId: '556' } }), false, 'allowGroups 非空时其他群拒绝')
  assert.equal(groupHost.isAllowed({ userId: OWNER_QQ, meta: {} }), true, '私聊不受群白名单影响')
})

// ───────────────────────────── QC4 回复引擎 ─────────────────────────────

test('QC4: system=人设+记忆；按需档案仅命中注入；历史进 user；路由与错误处理', async () => {
  const persona = makeStubPersona()
  const memory = makeStubMemory()
  const llm = makeStubLlm({ chunks: [{ type: 'text-delta', text: '我是奥菲莉亚。详见 https://example.com 和 [档案](https://a.b/c)。' }, { type: 'finish', reason: { kind: 'stop' } }] })
  const engine = createReplyEngine({
    persona,
    memory,
    llm,
    modelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }),
    config: { maxTokens: 256, maxReplyChars: 600, digestMaxChars: 1200 },
  })

  const reply = await engine.generate({
    text: '你长什么样子？',
    history: [
      { role: 'user', text: '晚上好' },
      { role: 'assistant', text: '主人，晚上好。' },
    ],
  })
  // 路由来自默认选择；prepareCall 收到 maxTokens；stream 收到 system/messages
  assert.equal(llm.calls.prepare[0].provider, 'deepseek-official')
  assert.equal(llm.calls.prepare[0].model, 'deepseek-flash')
  assert.equal(llm.calls.prepare[0].maxTokens, 256)
  assert.equal(Array.isArray(llm.calls.stream[0].messages), true)
  assert.match(llm.calls.stream[0].messages[0].content[0].text, /最近的对话/u)
  assert.match(llm.calls.stream[0].messages[0].content[0].text, /你长什么样子/u)
  // system = 人设 + 记忆 + 按需档案（appearance 命中）+ 渠道说明
  assert.match(reply.system, /人设 · 始终生效/u)
  assert.match(reply.system, /记忆系统 · 自动注入/u)
  assert.match(reply.system, /档案正文：appearance/u)
  assert.deepEqual(reply.onDemandModules, ['appearance'])
  assert.match(reply.user, /主人：晚上好[\s\S]*奥菲莉亚：主人，晚上好/u)
  // 记忆摘要收到 digestMaxChars 与 latestUserText
  assert.equal(memory.calls[0].latestUserText, '你长什么样子？')
  assert.equal(memory.calls[0].maxChars, 1200)
  // 输出链接清洗
  assert.ok(!reply.text.includes('http'))
  assert.ok(reply.text.includes('档案'))

  // 普通寒暄：不注入 on_demand
  const plain = await engine.generate({ text: '今天好累啊' })
  assert.deepEqual(plain.onDemandModules, [])
  assert.ok(!plain.system.includes('档案正文：'))
  // 多话题命中：过去 + 长相 → personal_history + appearance；不存在的 lookup 不注入
  const multi = await engine.generate({ text: '你的过去和长相是怎样的？' })
  assert.deepEqual(multi.onDemandModules.sort(), ['appearance', 'personal_history'].sort())
  const missingPersona = makeStubPersona({ missing: ['herself'] })
  assert.deepEqual(detectOnDemandModules('你喜欢什么', missingPersona), [], 'lookup 失败时不注入')

  // 无模型路由 → 报错
  const noRoute = createReplyEngine({ persona, memory, llm, modelSelection: () => undefined })
  await assert.rejects(() => noRoute.generate({ text: '在吗' }), /没有可用的模型路由/u)

  // 显式 config.provider/model 优先于默认选择
  const fixed = createReplyEngine({ persona, memory, llm, modelSelection: () => ({ provider: 'x', model: 'y' }), config: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  await fixed.generate({ text: '在吗' })
  assert.equal(llm.calls.prepare.at(-1).provider, 'deepseek-official')

  // 空回复 → 报错
  const emptyLlm = makeStubLlm({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  const emptyEngine = createReplyEngine({ persona, memory, llm: emptyLlm, modelSelection: () => ({ provider: 'p', model: 'm' }) })
  await assert.rejects(() => emptyEngine.generate({ text: '在吗' }), /空回复/u)

  // 流错误 / 中止 → 报错
  const errorLlm = makeStubLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: '超时' } } }] })
  const errorEngine = createReplyEngine({ persona, memory, llm: errorLlm, modelSelection: () => ({ provider: 'p', model: 'm' }) })
  await assert.rejects(() => errorEngine.generate({ text: '在吗' }), /模型调用失败/u)
  const abortLlm = makeStubLlm({ chunks: [{ type: 'finish', reason: { kind: 'aborted' } }] })
  const abortEngine = createReplyEngine({ persona, memory, llm: abortLlm, modelSelection: () => ({ provider: 'p', model: 'm' }) })
  await assert.rejects(() => abortEngine.generate({ text: '在吗' }), /模型调用被中止/u)
})

test('QC4: 清洗/历史/按需段/流收集辅助函数边界', async () => {
  // 链接清洗：http/https/www/ftp/mailto/markdown
  const cleaned = sanitizeReply('看这里 https://x.com 和 [点我](https://a.b/c) 还有 www.test.com、ftp://f.com、mailto:a@b.c 结束。')
  assert.ok(!/https?:|www\.|ftp:|mailto:/u.test(cleaned), `链接清洗不彻底：${cleaned}`)
  assert.ok(cleaned.includes('点我'), 'markdown 链接应保留文案')
  assert.equal(sanitizeReply(''), '')
  // 长度截断（默认按句号边界）
  const longText = '这是第一句。' + '这是很长的第二句内容。'.repeat(60)
  const cut = sanitizeReply(longText, 100)
  assert.ok(cut.length <= 101, `截断后长度超限：${cut.length}`)
  assert.ok(cut.endsWith('…') || cut.length <= 100)

  // 历史渲染：从最新往前拼，超过 maxChars 丢弃更早内容；角色标签
  assert.equal(renderHistory([]), '')
  assert.equal(renderHistory([{ role: 'user', text: '甲' }, { role: 'assistant', text: '乙' }]), '主人：甲\n奥菲莉亚：乙')
  const longHistory = [
    { role: 'user', text: '很早以前的消息'.repeat(20) },
    { role: 'user', text: '最近消息' },
  ]
  const shortHistory = renderHistory(longHistory, 40)
  assert.ok(shortHistory.includes('最近消息'))
  assert.ok(!shortHistory.includes('很早以前的消息'), '超长时优先保留最近消息')

  // 按需段
  assert.equal(renderOnDemandSection([]), '')
  assert.equal(renderOnDemandSection(null), '')
  const section = renderOnDemandSection([{ label: '外貌', content: '银发' }])
  assert.match(section, /【外貌】/u)
  assert.match(section, /银发/u)

  // 提示词拼装：不含 on_demand 命中时不出现档案段
  const persona = makeStubPersona()
  const memory = makeStubMemory()
  const plainPrompts = buildReplyPrompts({ text: '今天好累', persona, memory })
  assert.match(plainPrompts.system, /人设 · 始终生效/u)
  assert.match(plainPrompts.system, /记忆系统/u)
  assert.ok(!plainPrompts.system.includes('档案正文：'))
  assert.ok(plainPrompts.system.includes('没有出现在 system 中的档案内容一律视为「没有记录」'))
  assert.ok(plainPrompts.user.includes('主人刚刚发来的消息'))
  const hitPrompts = buildReplyPrompts({ text: '你长什么样', persona, memory })
  assert.match(hitPrompts.system, /档案正文：appearance/u)

  // 流收集：text-delta 拼接；坏块忽略
  const stream = (async function* () {
    yield { type: 'text-delta', text: '甲' }
    yield null
    yield { type: 'text-delta', text: '乙' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  assert.equal(await collectReplyText(stream), '甲乙')
})

// ───────────────────────────── QC5 端到端（假适配器/假 LLM） ─────────────────────────────

function makeQQHostFixture({ configOverrides = {}, replyText = '奥菲莉亚收到。', replyError, ingestError } = {}) {
  const root = makeTempDir('dshpet-verify-qq-host-')
  const charactersDir = path.join(root, 'characters')
  const sent = []
  const started = { count: 0, stop: 0 }
  let handlers
  const adapter = {
    id: 'fake-adapter',
    start: async (value) => {
      started.count += 1
      handlers = value
      return { state: 'running' }
    },
    stop: async () => {
      started.stop += 1
      return { state: 'stopped' }
    },
    send: async (outbound) => {
      sent.push(outbound)
      return { delivered: true }
    },
    status: () => ({ id: 'fake-adapter', channel: 'qq', state: 'running' }),
  }
  const ingestCalls = []
  const memory = {
    renderDigest: () => 'digest',
    ingestMessage: (input) => {
      ingestCalls.push(input)
      if (ingestError) throw ingestError
      return { created: [], mentioned: [], skipped: false }
    },
  }
  const generateCalls = []
  const replyEngine = {
    generate: async (input) => {
      generateCalls.push(input)
      if (replyError) throw replyError
      return { text: replyText, system: 's', user: 'u', onDemandModules: [] }
    },
  }
  const host = createQQHost({
    config: {
      charactersDir,
      characterId: 'ophelia',
      botQQ: BOT_QQ,
      allowUsers: [OWNER_QQ],
      onebotUrl: 'ws://127.0.0.1:3001',
      ...configOverrides,
    },
    deps: { persona: makeStubPersona(), memory, replyEngine, adapter },
  })
  return { root, charactersDir, host, adapter, sent, started, ingestCalls, generateCalls, getHandlers: () => handlers }
}

function makeInbound(overrides = {}) {
  return {
    id: 'm-1',
    channel: 'qq',
    adapterId: 'fake-adapter',
    userId: OWNER_QQ,
    text: '今天好累',
    receivedAt: 1762345678000,
    meta: {},
    ...overrides,
  }
}

test('QC5: 入站→白名单→记忆写入(sessionId)→回复→发送→会话历史；去重/拒绝/群聊', async () => {
  const fixture = makeQQHostFixture()
  const { host, sent, ingestCalls, generateCalls } = fixture

  await host.start()
  assert.equal(fixture.started.count, 1)
  assert.equal(host.status().started, true)
  assert.equal(typeof fixture.getHandlers().onMessage, 'function', 'adapter.start 应收到 onMessage 回调')

  const result = await host.handleInbound(makeInbound({ receivedAt: 1762345678000 }))
  assert.equal(result.accepted, true)
  assert.equal(result.reply, '奥菲莉亚收到。')
  // 记忆写入：sessionId 前缀 qq:
  assert.equal(ingestCalls.length, 1)
  assert.equal(ingestCalls[0].sessionId, `qq:${OWNER_QQ}`)
  assert.equal(ingestCalls[0].messageId, 'm-1')
  assert.equal(ingestCalls[0].at, 1762345678000)
  // 回复生成：历史为空 + 用户文本
  assert.equal(generateCalls.length, 1)
  assert.equal(generateCalls[0].text, '今天好累')
  assert.deepEqual(generateCalls[0].history, [])
  // OneBot 发送：统一出站结构
  assert.equal(sent.length, 1)
  assert.equal(sent[0].channel, 'qq')
  assert.equal(sent[0].adapterId, 'fake-adapter')
  assert.equal(sent[0].userId, OWNER_QQ)
  assert.equal(sent[0].replyTo, 'm-1')
  assert.equal(sent[0].text, '奥菲莉亚收到。')
  // 会话历史：user + assistant 两条
  const history = host.sessions.get(OWNER_QQ)
  assert.equal(history.length, 2)
  assert.equal(history[0].role, 'user')
  assert.equal(history[0].text, '今天好累')
  assert.equal(history[1].role, 'assistant')
  assert.equal(history[1].text, '奥菲莉亚收到。')
  // 同一用户再来一条：历史作为上下文传入
  await host.handleInbound(makeInbound({ id: 'm-2', text: '还在吗' }))
  assert.equal(generateCalls[1].history.length, 2)
  assert.equal(host.sessions.get(OWNER_QQ).length, 4)

  // 重复 messageId：不重复写记忆/回复/发送
  const dup = await host.handleInbound(makeInbound({ id: 'm-1' }))
  assert.equal(dup.accepted, false)
  assert.equal(dup.reason, 'duplicate')
  assert.equal(ingestCalls.length, 2, '重复消息不应再写记忆')
  assert.equal(sent.length, 2, '重复消息不应再发送')
  // 非白名单 / bot 自身：拒绝
  assert.equal((await host.handleInbound(makeInbound({ id: 'm-3', userId: '999999' }))).reason, 'not_allowed')
  assert.equal((await host.handleInbound(makeInbound({ id: 'm-4', userId: BOT_QQ }))).reason, 'not_allowed')
  // 群聊回复：出站 meta.groupId 透传（便于 OneBot 带 @）
  const group = await host.handleInbound(makeInbound({ id: 'm-5', userId: OWNER_QQ, meta: { groupId: '998877', messageType: 'group' } }))
  assert.equal(group.accepted, true)
  assert.equal(sent.at(-1).meta.groupId, '998877')

  const status = host.status()
  assert.equal(status.plugin, 'companion-qq')
  assert.equal(status.botQQ, BOT_QQ)
  assert.deepEqual(status.allowUsers, [OWNER_QQ])
  assert.equal(status.onebotUrl, 'ws://127.0.0.1:3001')
  assert.equal(status.adapter.channel, 'qq')
  assert.ok(status.users.includes(OWNER_QQ))

  await host.stop()
  assert.equal(fixture.started.stop, 1)
  assert.equal(host.status().started, false)
})

test('QC5/QC6 边界: 记忆写失败仍回复；生成/发送失败记录 lastError 不落历史；状态文件字段；同用户串行（OBS-Q2 复验）', async () => {
  // 记忆写入抛错 → 降级继续回复
  const ingestFail = makeQQHostFixture({ ingestError: new Error('memory boom') })
  const ingestResult = await ingestFail.host.handleInbound(makeInbound({ id: 'e-1' }))
  assert.equal(ingestResult.accepted, true)
  assert.equal(ingestResult.reply, '奥菲莉亚收到。')
  assert.equal(ingestFail.sent.length, 1)
  assert.ok(ingestFail.host.sessions.get(OWNER_QQ).length === 2, '记忆失败不影响成功回复后的历史')

  // 生成失败（空回复）→ accepted:true + error，不发送、不写历史、lastError 记录
  const genFail = makeQQHostFixture({ replyError: new Error('模型返回了空回复') })
  const failed = await genFail.host.handleInbound(makeInbound({ id: 'e-2' }))
  assert.equal(failed.accepted, true)
  assert.equal(failed.error, '模型返回了空回复')
  assert.equal(genFail.sent.length, 0)
  assert.equal(genFail.host.sessions.get(OWNER_QQ).length, 0)
  genFail.host.writeStatus()
  const failedStatus = JSON.parse(fs.readFileSync(genFail.host.statusFile, 'utf8'))
  assert.equal(failedStatus.lastError, '模型返回了空回复')
  assert.equal(failedStatus.started, false)

  // 成功一次后：状态文件含 lastActivityAt、用户列表、无 lastError
  const ok = makeQQHostFixture()
  await ok.host.handleInbound(makeInbound({ id: 'ok-1' }))
  ok.host.writeStatus()
  const okStatus = JSON.parse(fs.readFileSync(ok.host.statusFile, 'utf8'))
  assert.equal(okStatus.plugin, 'companion-qq')
  assert.equal(okStatus.botQQ, BOT_QQ)
  assert.deepEqual(okStatus.allowUsers, [OWNER_QQ])
  assert.equal(okStatus.onebotUrl, 'ws://127.0.0.1:3001')
  assert.equal(okStatus.adapter.id, 'fake-adapter')
  assert.equal(okStatus.adapter.channel, 'qq')
  assert.ok(okStatus.updatedAt && typeof okStatus.updatedAt === 'string')
  assert.equal(okStatus.started, false)
  assert.ok(okStatus.lastActivityAt)
  assert.equal('lastError' in okStatus, false, '无错误时不写 lastError（undefined 被省略）')
  assert.deepEqual(okStatus.users, [OWNER_QQ])
  // sessions.json 已落盘
  const sessionsFile = path.join(ok.host.dataDir, 'qq', 'sessions.json')
  assert.ok(fs.existsSync(sessionsFile))
  const sessionsDoc = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'))
  assert.equal(sessionsDoc.users[OWNER_QQ].length, 2)

  // OBS-Q2 修复复验：同一用户的消息必须真正串行（不并发调用 generate/发送），不同用户可并行
  const serialRoot = makeTempDir('dshpet-verify-qq-serial-')
  const serialSent = []
  const pendingReplies = []
  let serialHandlers
  const serialAdapter = {
    id: 'serial-adapter',
    start: async (value) => {
      serialHandlers = value
      return { state: 'running' }
    },
    stop: async () => ({ state: 'stopped' }),
    send: async (outbound) => {
      serialSent.push(outbound)
      return { delivered: true }
    },
    status: () => ({ id: 'serial-adapter', channel: 'qq', state: 'running' }),
  }
  const serialReplyEngine = {
    generate: (input) => new Promise((resolve, reject) => pendingReplies.push({ input, resolve, reject })),
  }
  const serialHost = createQQHost({
    config: {
      charactersDir: path.join(serialRoot, 'characters'),
      characterId: 'ophelia',
      botQQ: BOT_QQ,
      allowUsers: [OWNER_QQ, '111222333'],
    },
    deps: {
      persona: makeStubPersona(),
      memory: { renderDigest: () => 'digest', ingestMessage: () => ({ created: [], mentioned: [], skipped: false }) },
      replyEngine: serialReplyEngine,
      adapter: serialAdapter,
    },
  })
  const first = serialHost.handleInbound(makeInbound({ id: 's-1', text: '第一条' }))
  const second = serialHost.handleInbound(makeInbound({ id: 's-2', text: '第二条' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(pendingReplies.length, 1, '同一用户第二条消息应排队，不得与第一条并发调用模型')
  pendingReplies[0].resolve({ text: '回复一', onDemandModules: [] })
  for (let i = 0; i < 100 && pendingReplies.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(pendingReplies.length, 2, '第一条完成后第二条才应开始生成')
  pendingReplies[1].resolve({ text: '回复二', onDemandModules: [] })
  await Promise.all([first, second])
  assert.deepEqual(serialSent.map((outbound) => outbound.text), ['回复一', '回复二'], '发送顺序应与消息顺序一致')
  assert.deepEqual(
    serialHost.sessions.get(OWNER_QQ).map((entry) => entry.text),
    ['第一条', '回复一', '第二条', '回复二'],
    '会话历史应按「用户/助手」成对顺序落盘',
  )
  // 不同用户的消息并行处理（互不阻塞）
  pendingReplies.length = 0
  const userA = serialHost.handleInbound(makeInbound({ id: 'c-1', text: '并发A' }))
  const userB = serialHost.handleInbound(makeInbound({ id: 'c-2', userId: '111222333', text: '并发B' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(pendingReplies.length, 2, '不同用户的消息不应互相阻塞（可并行）')
  pendingReplies[0].resolve({ text: '并发A回复', onDemandModules: [] })
  pendingReplies[1].resolve({ text: '并发B回复', onDemandModules: [] })
  await Promise.all([userA, userB])

  // OBS-Q3 文档对齐：顶层 lastError/lastActivityAt 仅在错误/成功回复后出现，无则省略（不写 null）
  const fresh = makeQQHostFixture()
  fresh.host.writeStatus()
  const freshStatus = JSON.parse(fs.readFileSync(fresh.host.statusFile, 'utf8'))
  assert.equal('lastError' in freshStatus, false, '无错误时顶层 lastError 应省略')
  assert.equal('lastActivityAt' in freshStatus, false, '无活动时顶层 lastActivityAt 应省略')
  const napcatDoc = fs.readFileSync(path.join(ROOT, 'docs', 'QQ接入-NapCat.md'), 'utf8')
  assert.ok(
    napcatDoc.includes('只在实际发生错误或成功回复后出现') && napcatDoc.includes('省略'),
    '操作手册应说明顶层字段按需出现/省略（与实现一致）',
  )
})

// ───────────────────────────── QC6 配置、生命周期、会话存储 ─────────────────────────────

test('QC6: 配置解析默认值/夹取/必填校验', () => {
  const defaults = normalizeConfig({ charactersDir: 'D:/x/characters', botQQ: 123456789, allowUsers: [10001] })
  assert.equal(defaults.characterId, 'ophelia')
  assert.equal(defaults.onebotUrl, 'ws://127.0.0.1:3001')
  assert.equal(defaults.botQQ, BOT_QQ)
  assert.deepEqual(defaults.allowUsers, [OWNER_QQ])
  assert.equal(defaults.historyLimit, 8)
  assert.equal(defaults.maxTokens, 8192)
  assert.equal(defaults.maxReplyChars, 30000)
  assert.equal(defaults.digestMaxChars, 30000)
  assert.equal(defaults.reconnectMinMs, 1000)
  assert.equal(defaults.reconnectMaxMs, 30000)

  // 夹取与归一化
  const clamped = normalizeConfig({
    charactersDir: 'D:/x/characters',
    botQQ: ' 123456789 ',
    allowUsers: 10001,
    allowGroups: [555],
    historyLimit: -3,
    maxTokens: 1,
    maxReplyChars: 10,
    digestMaxChars: 1,
    reconnectMinMs: 1,
    reconnectMaxMs: 1,
    characterId: '  other  ',
  })
  assert.equal(clamped.botQQ, BOT_QQ, 'botQQ 应 trim')
  assert.deepEqual(clamped.allowUsers, [OWNER_QQ], 'allowUsers 标量 → 数组')
  assert.deepEqual(clamped.allowGroups, ['555'])
  assert.equal(clamped.historyLimit, 2, 'historyLimit 下限 2')
  assert.equal(clamped.maxTokens, 64)
  assert.equal(clamped.maxReplyChars, 50)
  assert.equal(clamped.digestMaxChars, 300)
  assert.equal(clamped.reconnectMinMs, 500)
  assert.equal(clamped.reconnectMaxMs, 1000)
  assert.equal(clamped.characterId, 'other')

  // 必填校验：NapCat 通道缺 botQQ / allowUsers → 抛错（安全默认拒绝）。
  // 使用临时角色根目录，避免读到真实角色目录里已保存的 qq/channel.json（可能已切到 QQ 官方通道）。
  const emptyRoot = makeTempDir('dshpet-verify-qq-required-')
  const base = { charactersDir: emptyRoot, characterId: 'ophelia', channel: 'napcat' }
  assert.throws(() => createQQHost({ config: { ...base, allowUsers: [OWNER_QQ] }, deps: {} }), /缺少 botQQ/u)
  assert.throws(() => createQQHost({ config: { ...base, botQQ: BOT_QQ }, deps: {} }), /缺少 allowUsers/u)
  // 空 allowUsers 数组同样拒绝
  assert.throws(() => createQQHost({ config: { ...base, botQQ: BOT_QQ, allowUsers: [] }, deps: {} }), /缺少 allowUsers/u)
})

test('QC6: 会话存储上限/持久化/损坏恢复/clear/快照隔离', () => {
  const root = makeTempDir('dshpet-verify-qq-store-')
  const file = path.join(root, 'qq', 'sessions.json')
  const store = createSessionStore(file, 2) // 2 轮 = 最多 4 条
  for (const [role, text] of [['user', '一'], ['assistant', '二'], ['user', '三'], ['assistant', '四'], ['user', '五'], ['assistant', '六']]) {
    store.append(OWNER_QQ, role, text)
  }
  assert.deepEqual(store.get(OWNER_QQ).map((entry) => entry.text), ['三', '四', '五', '六'], '超过上限应裁掉最旧消息')
  assert.ok(fs.existsSync(file))
  const reloaded = createSessionStore(file, 2)
  assert.deepEqual(reloaded.get(OWNER_QQ).map((entry) => entry.text), ['三', '四', '五', '六'], '重启后应能恢复历史')
  // 快照深拷贝
  const snapshot = store.snapshot()
  snapshot.users[OWNER_QQ][0].text = '被篡改'
  assert.equal(store.get(OWNER_QQ)[0].text, '三')
  // clear
  store.clear(OWNER_QQ)
  assert.deepEqual(store.get(OWNER_QQ), [])
  // 损坏文件恢复：不崩溃，可用新文件继续写
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
  const recovered = createSessionStore(file, 2)
  assert.deepEqual(recovered.get(OWNER_QQ), [])
  recovered.append(OWNER_QQ, 'user', '恢复后消息')
  assert.deepEqual(createSessionStore(file, 2).get(OWNER_QQ).map((entry) => entry.text), ['恢复后消息'])
})

test('QC6: Host 生命周期（start 幂等/stop/onMessage 接线/状态文件位置）', async () => {
  const fixture = makeQQHostFixture()
  const { host } = fixture
  assert.equal(host.statusFile, path.join(host.dataDir, 'qq', 'status.json'))
  assert.equal(host.settings.characterId, 'ophelia')
  await host.start()
  assert.equal(fixture.started.count, 1)
  await host.start()
  assert.equal(fixture.started.count, 1, '重复 start 不应重复连接')
  const handlers = fixture.getHandlers()
  const inbound = makeInbound({ id: 'lifecycle-1' })
  const result = await handlers.onMessage(inbound)
  assert.equal(result.accepted, true)
  assert.equal(fixture.sent.length, 1)
  await host.stop()
  assert.equal(fixture.started.stop, 1)
  assert.equal(host.status().started, false)
})

// ───────────────────────────── QC7 配置模板与示例状态文件（只读） ─────────────────────────────

test('QC7 静态: bundle patch/package exports/SPEC/README/操作手册与示例 QQ 配置一致', () => {
  const patch = fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8')
  for (const fragment of [
    'id: companion-qq',
    "name: '@local/dsh-companion/qq'",
    'characterId: ophelia',
    "onebotUrl: 'ws://127.0.0.1:3001'",
    'botQQ: 123456789',
    'allowUsers: []',
  ]) {
    assert.ok(patch.includes(fragment), `cordis.patch.yml 缺少片段：${fragment}`)
  }
  assert.match(patch, /#\s*charactersDir:/, 'charactersDir 应以注释示例形式给出')
  assert.doesNotMatch(patch, /^\s*charactersDir:/m, 'patch 不应保留活动的 charactersDir 绝对路径')
  assert.doesNotMatch(patch, /\b[A-Za-z]:[\\/]/, 'patch 不应含盘符绝对路径')
  // 反向断言：patch 不得含真实标识（数字拆开拼接，避免在公开仓库里留下真实值）
  const REAL_QQ_PATTERN = new RegExp(`\\b(${['3870', '789707'].join('')}|${['2375', '452381'].join('')})\\b`, 'u')
  assert.doesNotMatch(patch, REAL_QQ_PATTERN, 'patch 不应含真实 QQ 号')
  assert.doesNotMatch(patch, /accessToken:\s*'[^']+'/u, 'patch 不应含真实 OneBot token')

  const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./qq'], './lib/qq-host.js', '包 exports 应提供 ./qq → lib/qq-host.js')
  assert.equal(pkg.dependencies, undefined, 'bundle 仍不得依赖 npm 包')

  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'SPEC.md'), 'utf8')
  const section9 = spec.slice(spec.indexOf('## 9. QQ 通道'))
  assert.ok(section9.length > 0, 'SPEC 应有第 9 节')
  for (const fragment of ['lib/im/onebot.js', 'lib/im/reply-engine.js', 'lib/qq-host.js', 'QC1', 'QC7']) {
    assert.ok(section9.includes(fragment), `SPEC 第 9 节缺少说明：${fragment}`)
  }
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  for (const fragment of ['NapCat', 'QQ 官方机器人', '127.0.0.1:3001', '白名单']) {
    assert.ok(readme.includes(fragment), `README 缺少说明：${fragment}`)
  }
  assert.doesNotMatch(readme, REAL_QQ_PATTERN, 'README 不应含真实 QQ 号')
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'QQ接入-NapCat.md')), '缺少 NapCat 操作手册')

  const standards = fs.readFileSync(path.join(ROOT, '验收', '验收标准.md'), 'utf8')
  for (const qc of ['QC1', 'QC2', 'QC3', 'QC4', 'QC5', 'QC6', 'QC7']) {
    assert.ok(standards.includes(qc), `验收标准缺少 ${qc}`)
  }
})

test('QC7 示例状态文件（只读）: botQQ/白名单/onebotUrl/channel/adapter 字段符合配置', () => {
  const raw = fs.readFileSync(REAL_STATUS, 'utf8')
  const status = JSON.parse(raw)
  assert.equal(status.plugin, 'companion-qq')
  assert.ok(['napcat', 'qqbot'].includes(status.channel), `channel 非法：${status.channel}`)
  assert.equal(status.botQQ, BOT_QQ)
  assert.deepEqual(status.allowUsers, [OWNER_QQ])
  assert.equal(status.onebotUrl, 'ws://127.0.0.1:3001')
  assert.equal(typeof status.started, 'boolean')
  assert.equal(status.adapter.channel, 'qq')
  assert.ok(Array.isArray(status.users))
  assert.ok(['running', 'failed', 'starting', 'stopped'].includes(status.adapter.state), `adapter.state 非法：${status.adapter.state}`)
  if (status.channel === 'qqbot') {
    assert.equal(status.adapter.transport, 'qqbot')
    assert.equal(status.adapter.id, `qq-qqbot:${status.qqbot.appId}`)
    assert.equal(status.features.proactive, false)
  } else {
    assert.equal(status.adapter.id, 'qq-napcat')
    assert.equal(status.adapter.supportsProactive, true)
    if (status.adapter.state === 'failed') assert.ok(status.adapter.lastError && status.adapter.lastError.length > 0, 'failed 时应记录 lastError')
  }
  // 状态文件不得泄漏 access token / 敏感凭据
  assert.ok(!/access_token|Bearer|clientSecret|secretConfigured/i.test(raw), 'status.json 不得包含 token/凭据')
})
