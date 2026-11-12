/**
 * 独立验收测试 · IM 接口（I5）
 * 覆盖需求编号：I5（IMAdapter 契约、QQ 配置校验、网关帧解析、出站 payload、
 *                CompanionIMBridge 入站→记忆→上下文、适配器注册/启动/停止）
 *
 * 全部测试使用操作系统临时目录（fs.mkdtempSync），不会修改仓库内 companion-data。
 * 测试由验收员 verifier 独立设计编写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAdapter,
  IMAdapterError,
  IM_STATES,
  createOutbound,
  normalizeInbound,
} from '../../companion-bundle/lib/im/adapter.js'
import {
  QQBotAdapter,
  QQ_MESSAGE_EVENTS,
  buildQQReplyPayload,
  parseQQGatewayFrame,
  validateQQBotConfig,
} from '../../companion-bundle/lib/im/qq-bot.js'
import { CompanionIMBridge } from '../../companion-bundle/lib/im/registry.js'
import { createPersonaService } from '../../companion-bundle/lib/persona/index.js'
import { cleanupTempDirs, localMs, makeTempDir, newMemoryEngine } from './helpers.mjs'

test.after(cleanupTempDirs)

const VALID_QQ_CONFIG = { appId: 'app-123', clientSecret: 'app-secret' }

function makeBridge({ agentName = '铃兰' } = {}) {
  const dataDir = makeTempDir('dshpet-verify-im-')
  const persona = createPersonaService({ dataDir })
  persona.ensure()
  const { engine: memory } = newMemoryEngine({ dataDir })
  const bridge = new CompanionIMBridge({ persona, memory, config: { agentName } })
  return { bridge, persona, memory, dataDir }
}

// ───────────────────────────── I5: IMAdapter 契约 ─────────────────────────────

test('I5: IMAdapter 契约（id/channel/start/stop/send/status）与 IMAdapterError 错误码', async () => {
  assert.ok(Array.isArray(IM_STATES) && IM_STATES.includes('running') && IM_STATES.includes('awaiting_network_layer'))

  const adapter = new IMAdapter({ id: 'verify-adapter-1' })
  assert.equal(adapter.id, 'verify-adapter-1')
  assert.equal(adapter.channel, 'unknown')
  assert.deepEqual(adapter.status(), { id: 'verify-adapter-1', channel: 'unknown', state: 'created' })

  await assert.rejects(() => adapter.start(), (error) => error instanceof IMAdapterError && error.code === 'invalid_handlers')

  const received = []
  const status = await adapter.start({ onMessage: (inbound) => received.push(inbound) })
  assert.equal(status.state, 'running')
  assert.equal(adapter.status().state, 'running')

  await assert.rejects(() => adapter.send({ text: 'x' }), (error) => error instanceof IMAdapterError && error.code === 'not_implemented')
  await adapter.stop()
  assert.equal(adapter.status().state, 'stopped')
  assert.equal(adapter.state, 'stopped')

  const error = new IMAdapterError('some_code', '中文错误说明')
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'IMAdapterError')
  assert.equal(error.code, 'some_code')
  assert.equal(error.message, '中文错误说明')
  assert.equal(received.length, 0)
})

test('I5: normalizeInbound 统一入站结构（含缺字段/空文本非法输入）', () => {
  const inbound = normalizeInbound({ text: '  你好呀  ', userId: 'user-1', channel: 'qq', userName: '小明' })
  assert.equal(inbound.text, '你好呀', '文本应 trim')
  assert.equal(inbound.userId, 'user-1')
  assert.equal(inbound.channel, 'qq')
  assert.equal(typeof inbound.id, 'string')
  assert.ok(inbound.id.length > 0)
  assert.equal(inbound.adapterId, 'qq:default')
  assert.equal(typeof inbound.receivedAt, 'number')
  assert.equal(inbound.userName, '小明')

  const minimal = normalizeInbound({ text: 'hi', userId: 'u2' })
  assert.equal(minimal.channel, 'unknown')
  assert.equal(minimal.receivedAt > 0, true)

  const autoId1 = normalizeInbound({ text: 'hi', userId: 'u2' }).id
  const autoId2 = normalizeInbound({ text: 'hi', userId: 'u2' }).id
  assert.notEqual(autoId1, autoId2, '未提供 id 时应生成唯一 id')

  for (const invalid of [null, undefined, 'text', 42, {}, { text: '' }, { text: '   ' }, { text: 'hi' }, { text: 'hi', userId: '' }]) {
    assert.throws(
      () => normalizeInbound(invalid),
      (error) => error instanceof IMAdapterError && error.code === 'invalid_inbound',
      `非法入站消息应抛 invalid_inbound：${JSON.stringify(invalid)}`,
    )
  }
})

test('I5: createOutbound 统一出站结构（replyTo/sessionId 可选，缺 text/userId 非法）', () => {
  const outbound = createOutbound({ text: ' 晚安呀 ', userId: 'user-1', channel: 'qq', adapterId: 'qq-adapter-1', replyTo: 'msg-1' })
  assert.equal(outbound.text, '晚安呀')
  assert.equal(outbound.userId, 'user-1')
  assert.equal(outbound.channel, 'qq')
  assert.equal(outbound.adapterId, 'qq-adapter-1')
  assert.equal(outbound.replyTo, 'msg-1')
  assert.equal(typeof outbound.id, 'string')
  assert.equal(typeof outbound.createdAt, 'number')

  const bare = createOutbound({ text: 'hi', userId: 'u1' })
  assert.equal(bare.channel, 'unknown')
  assert.equal(bare.adapterId, 'unknown:default')
  assert.equal('replyTo' in bare, false)

  assert.throws(() => createOutbound({ text: '', userId: 'u1' }), (error) => error.code === 'invalid_outbound')
  assert.throws(() => createOutbound({ text: 'hi' }), (error) => error.code === 'invalid_outbound')
  assert.throws(() => createOutbound(), (error) => error.code === 'invalid_outbound')
})

// ───────────────────────────── I5: QQ 配置校验与适配器生命周期 ─────────────────────────────

test('I5: QQ 官方配置校验（AppID + AppSecret）与配置错误状态', async () => {
  const empty = validateQQBotConfig({})
  assert.equal(empty.ok, false)
  assert.equal(empty.errors.length, 2)
  assert.match(empty.errors.join(' '), /appId/u)
  assert.match(empty.errors.join(' '), /clientSecret/u)

  assert.deepEqual(validateQQBotConfig(VALID_QQ_CONFIG), { ok: true, errors: [] })
  assert.equal(validateQQBotConfig({ ...VALID_QQ_CONFIG, intents: 1 << 25 }).ok, true)
  assert.equal(validateQQBotConfig({ ...VALID_QQ_CONFIG, intents: -1 }).ok, false)
  assert.equal(validateQQBotConfig({ ...VALID_QQ_CONFIG, intents: 1.5 }).ok, false)
  assert.equal(validateQQBotConfig('nope').ok, false)

  const adapter = new QQBotAdapter(VALID_QQ_CONFIG)
  assert.equal(adapter.channel, 'qq')
  assert.equal(adapter.validateConfig().ok, true)
  assert.equal(adapter.supportsProactive, false)
  assert.equal(adapter.maxBubblesPerReply, 3)

  const invalidAdapter = new QQBotAdapter({ appId: '' })
  const invalidStarted = await invalidAdapter.start({ onMessage: () => {} })
  assert.equal(invalidStarted.state, 'awaiting_config')
  assert.ok(invalidStarted.lastError && invalidStarted.lastError.length > 0)
  const invalidSent = await invalidAdapter.send({ text: '你好', userId: 'u1' })
  assert.equal(invalidSent.delivered, false)
  assert.equal(invalidSent.reason, 'invalid_config')
  // 配置错误不应抛异常
  assert.equal(invalidAdapter.validateConfig().ok, false)
})

// ───────────────────────────── I5: 网关帧解析 ─────────────────────────────

test('I5: QQ 网关帧解析 C2C / 群聊 @ / 频道 @；非消息帧与空文本返回 undefined', () => {
  assert.deepEqual(QQ_MESSAGE_EVENTS, ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE'])

  // C2C
  const c2c = parseQQGatewayFrame(
    {
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      id: 'evt-c2c-1',
      d: { id: 'qq-msg-1', content: '你好呀', author: { user_openid: 'openid-1', username: '小明' }, timestamp: '2026-11-05T10:00:00+08:00' },
    },
    { adapterId: 'qq-adapter-1' },
  )
  assert.ok(c2c)
  assert.equal(c2c.id, 'qq-msg-1')
  assert.equal(c2c.channel, 'qq')
  assert.equal(c2c.adapterId, 'qq-adapter-1')
  assert.equal(c2c.userId, 'openid-1')
  assert.equal(c2c.userName, '小明')
  assert.equal(c2c.text, '你好呀')
  assert.equal(c2c.receivedAt, Date.parse('2026-11-05T10:00:00+08:00'))
  assert.equal(c2c.meta.eventType, 'C2C_MESSAGE_CREATE')
  assert.ok(c2c.raw)

  // 群聊 @（d.author.member_openid + 开头 @ 占位符）
  const group = parseQQGatewayFrame({
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'qq-group-1', content: '<@!123456> 今天好累', author: { member_openid: 'member-1' }, group_openid: 'group-1' },
  })
  assert.ok(group)
  assert.equal(group.userId, 'member-1')
  assert.equal(group.text, '今天好累', '群聊消息应去掉开头的 @ 占位符')
  assert.equal(group.meta.groupId, 'group-1')

  // 频道 @
  const guild = parseQQGatewayFrame({
    op: 0,
    t: 'AT_MESSAGE_CREATE',
    d: { id: 'qq-channel-1', content: '在吗', author: { id: 'guild-user-1', username: '频道用户' }, channel_id: 'channel-1', guild_id: 'guild-1' },
  })
  assert.ok(guild)
  assert.equal(guild.userId, 'guild-user-1')
  assert.equal(guild.text, '在吗')
  assert.equal(guild.meta.channelId, 'channel-1')
  assert.equal(guild.meta.guildId, 'guild-1')

  // 非消息帧 / 空文本 / 缺 author / 非法输入
  assert.equal(parseQQGatewayFrame({ op: 0, t: 'READY', d: { session_id: 'x' } }), undefined)
  assert.equal(parseQQGatewayFrame({ op: 11 }), undefined)
  assert.equal(parseQQGatewayFrame({ t: 'C2C_MESSAGE_CREATE', d: { id: 'e', content: '', author: { user_openid: 'u' } } }), undefined)
  assert.equal(parseQQGatewayFrame({ t: 'C2C_MESSAGE_CREATE', d: { id: 'e', content: '   ', author: { user_openid: 'u' } } }), undefined)
  assert.equal(parseQQGatewayFrame({ t: 'C2C_MESSAGE_CREATE', d: { id: 'e', content: '<@!1>', author: { user_openid: 'u' } } }), undefined)
  assert.equal(parseQQGatewayFrame({ t: 'C2C_MESSAGE_CREATE', d: { id: 'e', content: '你好' } }), undefined)
  assert.equal(parseQQGatewayFrame(null), undefined)
  assert.equal(parseQQGatewayFrame('frame'), undefined)
  assert.equal(parseQQGatewayFrame([]), undefined)
})

test('I5: handleGatewayFrame 解析合法帧，非法帧返回 undefined', () => {
  const adapter = new QQBotAdapter(VALID_QQ_CONFIG)
  const inbound = adapter.handleGatewayFrame({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'dispatch-1', content: '你好', author: { user_openid: 'openid-1' } },
  })
  assert.ok(inbound)
  assert.equal(inbound.id, 'dispatch-1')
  assert.equal(inbound.adapterId, adapter.id)

  assert.equal(adapter.handleGatewayFrame({ op: 0, t: 'READY', d: {} }), undefined)
})

// ───────────────────────────── I5: 出站 payload ─────────────────────────────

test('I5: 出站 QQ 回复 payload 覆盖 C2C / 群聊 / 频道，含 content/msg_type/msg_id', () => {
  const c2c = buildQQReplyPayload({ text: '晚安呀', userId: 'openid-1', replyTo: 'msg-1' })
  assert.equal(c2c.endpoint, '/v2/users/openid-1/messages')
  assert.equal(c2c.method, 'POST')
  assert.deepEqual(c2c.body, { content: '晚安呀', msg_type: 0, msg_id: 'msg-1' })
  assert.equal(c2c.body.msg_type, 0)

  // 群聊：meta.groupId 优先
  const group = buildQQReplyPayload({ text: '收到', userId: 'member-1', meta: { groupId: 'group-1' } })
  assert.equal(group.endpoint, '/v2/groups/group-1/messages')
  assert.deepEqual(group.body, { content: '收到', msg_type: 0 })

  // 频道：meta.channelId
  const channel = buildQQReplyPayload({ text: '在的', userId: 'guild-user-1', meta: { channelId: 'channel-1' } })
  assert.equal(channel.endpoint, '/channels/channel-1/messages')
  assert.equal(channel.body.content, '在的')

  // 特殊字符需 URL 编码
  const encoded = buildQQReplyPayload({ text: 'hi', userId: 'openid/with space' })
  assert.ok(encoded.endpoint.includes('openid%2Fwith%20space'))

  assert.throws(() => buildQQReplyPayload({ text: '   ', userId: 'u1' }), (error) => error instanceof IMAdapterError && error.code === 'invalid_outbound')
  assert.throws(() => buildQQReplyPayload(null), (error) => error instanceof IMAdapterError)
})

// ───────────────────────────── I5: CompanionIMBridge 入站→记忆→上下文 ─────────────────────────────

test('I5: CompanionIMBridge 入站→记忆写入→上下文生成→回复派发', async () => {
  const { bridge, persona, memory } = makeBridge()

  // 依赖校验
  assert.throws(() => new CompanionIMBridge({}), (error) => error.code === 'invalid_dependency')
  assert.throws(() => new CompanionIMBridge({ persona }), (error) => error.code === 'invalid_dependency')

  class FakeQQAdapter extends IMAdapter {
    constructor() {
      super({ id: 'verify-qq-adapter-1' })
    }
    get channel() {
      return 'qq'
    }
    async send() {
      return { delivered: true }
    }
  }

  const adapter = new FakeQQAdapter()
  assert.throws(() => bridge.registerAdapter({}), (error) => error.code === 'invalid_adapter')
  const unregister = bridge.registerAdapter(adapter)
  assert.throws(() => bridge.registerAdapter(adapter), (error) => error.code === 'duplicate_adapter')

  const started = await bridge.startAll()
  assert.equal(started.length, 1)
  assert.equal(started[0].state, 'running')
  const status = bridge.status()
  assert.equal(status.started, true)
  assert.equal(status.agents, '铃兰')
  assert.equal(status.adapters.length, 1)
  assert.equal(status.adapters[0].channel, 'qq')

  // 入站 → 记忆写入
  const receivedAt = localMs(2026, 11, 5, 20, 0)
  const result = bridge.handleInbound({
    id: 'im-msg-1',
    text: '我喜欢草莓蛋糕',
    userId: 'openid-1',
    userName: '小明',
    channel: 'qq',
    adapterId: adapter.id,
    receivedAt,
  })
  assert.equal(result.accepted, true)
  assert.equal(result.ingest.skipped, false)
  assert.ok(result.ingest.created.length >= 1, '入站消息应触发自动抽取写入记忆')
  assert.ok(memory.status().total >= 1)
  const remembered = memory.recall('草莓蛋糕')
  assert.ok(remembered.hits.length >= 1, '记忆库中应能检索到入站消息内容')
  assert.equal(Date.parse(remembered.hits[0].item.firstSeenAt), receivedAt)

  // 上下文 = 人设段 + 记忆摘要
  assert.ok(result.context.personaSection.includes('【人设 · 始终生效】'))
  assert.ok(result.context.memoryDigest.includes('【记忆系统 · 自动注入】'))
  assert.ok(result.context.systemPrompt.includes(result.context.personaSection))
  assert.ok(result.context.systemPrompt.includes(result.context.memoryDigest))
  assert.ok(result.context.memoryDigest.includes('草莓蛋糕'), '记忆摘要应包含刚写入的记忆')

  // 同一入站消息 id 重复投递 → 引擎去重
  const replay = bridge.handleInbound({
    id: 'im-msg-1',
    text: '我喜欢草莓蛋糕',
    userId: 'openid-1',
    channel: 'qq',
    receivedAt: receivedAt + 1000,
  })
  assert.equal(replay.ingest.skipped, true)

  // 空文本入站非法
  assert.throws(
    () => bridge.handleInbound({ id: 'im-msg-2', text: '', userId: 'u1', channel: 'qq' }),
    (error) => error instanceof IMAdapterError && error.code === 'invalid_inbound',
  )

  // 适配器 send 投递成功 → 派发返回 delivered:true 并带回 outbound
  const dispatched = await bridge.dispatchReply({ text: '晚安呀', userId: 'openid-1', channel: 'qq' })
  assert.equal(dispatched.delivered, true)
  assert.ok(dispatched.outbound && dispatched.outbound.text === '晚安呀')

  const stopped = await bridge.stopAll()
  assert.equal(stopped[0].state, 'stopped')
  assert.equal(bridge.status().started, false)
  unregister()
  assert.equal(bridge.status().adapters.length, 0)
})

test('I5: dispatchReply 对自定义适配器投递成功；无适配器时明确报 adapter_not_registered', async () => {
  class LocalEchoAdapter extends IMAdapter {
    constructor(id) {
      super({ id })
      this.sent = []
    }
    get channel() {
      return 'local'
    }
    async send(outbound) {
      this.sent.push(outbound)
      return { delivered: true }
    }
  }
  const { bridge } = makeBridge()
  const echo = new LocalEchoAdapter('local-adapter-1')
  bridge.registerAdapter(echo)
  const delivered = await bridge.dispatchReply({ text: '本地回复', userId: 'u1', channel: 'local', replyTo: 'msg-9' })
  assert.equal(delivered.delivered, true)
  assert.equal(echo.sent.length, 1)
  assert.equal(echo.sent[0].text, '本地回复')
  assert.equal(echo.sent[0].channel, 'local')
  assert.equal(echo.sent[0].replyTo, 'msg-9')

  // 无适配器时
  const emptyBridge = new CompanionIMBridge({
    persona: createPersonaService({ dataDir: makeTempDir('dshpet-verify-im-') }).ensure(),
    memory: newMemoryEngine().engine,
  })
  const noAdapter = await emptyBridge.dispatchReply({ text: 'hi', userId: 'u1', channel: 'qq' })
  assert.equal(noAdapter.delivered, false)
  assert.equal(noAdapter.reason, 'adapter_not_registered')

  // 自定义适配器 send 抛错时桥接层不崩，返回 send_failed
  class BrokenAdapter extends IMAdapter {
    constructor() {
      super({ id: 'broken-1' })
    }
    get channel() {
      return 'broken'
    }
    async send() {
      throw new IMAdapterError('send_failed', '模拟发送失败')
    }
  }
  bridge.registerAdapter(new BrokenAdapter())
  const broken = await bridge.dispatchReply({ text: 'hi', userId: 'u1', channel: 'broken' })
  assert.equal(broken.delivered, false)
  assert.equal(broken.reason, 'send_failed')
  assert.equal(broken.message, '模拟发送失败')
})
