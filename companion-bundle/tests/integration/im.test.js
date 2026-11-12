/**
 * 覆盖验收项：I5（IM 适配接口）。
 * 验证统一消息结构、QQ 网关帧解析、出站 payload、适配器生命周期与 CompanionIMBridge 链路。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IMAdapter,
  IMAdapterError,
  createOutbound,
  normalizeInbound,
} from '../../lib/im/adapter.js'
import {
  QQBotAdapter,
  buildQQReplyPayload,
  parseQQGatewayFrame,
  validateQQBotConfig,
} from '../../lib/im/qq-bot.js'
import { CompanionIMBridge } from '../../lib/im/registry.js'
import { createPersonaService } from '../../lib/persona/index.js'
import { getMemoryEngine, resetMemoryEngineRegistry } from '../../lib/memory/index.js'
import { createFixedClock } from '../../lib/shared/clock.js'

const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('I5：normalizeInbound / createOutbound 统一消息结构', () => {
  const inbound = normalizeInbound({ text: '  主人的消息  ', userId: 'u1', channel: 'qq' })
  assert.equal(inbound.text, '主人的消息')
  assert.equal(inbound.userId, 'u1')
  assert.equal(inbound.channel, 'qq')
  assert.equal(typeof inbound.id, 'string')
  assert.throws(() => normalizeInbound({ text: '', userId: 'u1' }), (error) => error instanceof IMAdapterError && error.code === 'invalid_inbound')
  assert.throws(() => normalizeInbound({ text: 'hi' }), /userId/)

  const outbound = createOutbound({ text: ' 你好呀 ', userId: 'u1', channel: 'qq', replyTo: 'm1' })
  assert.equal(outbound.text, '你好呀')
  assert.equal(outbound.replyTo, 'm1')
  assert.equal(outbound.channel, 'qq')
  assert.throws(() => createOutbound({ text: '', userId: 'u1' }), /文本/)
})

test('I5：QQ 官方配置校验要求 AppID + AppSecret（旧 Token 已弃用）', () => {
  const empty = validateQQBotConfig({})
  assert.equal(empty.ok, false)
  assert.equal(empty.errors.length, 2)
  assert.match(empty.errors.join(' '), /appId/u)
  assert.match(empty.errors.join(' '), /clientSecret/u)
  const ok = validateQQBotConfig({ appId: '1020', clientSecret: 'secret' })
  assert.deepEqual(ok, { ok: true, errors: [] })
  assert.equal(validateQQBotConfig({ appId: '1020', secret: 'secret' }).ok, true)
})

test('I5：QQ 网关帧解析（C2C / 群聊 @ / 频道 @ / 非消息帧）', () => {
  const c2c = parseQQGatewayFrame({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'm-1', content: '今天好累', author: { user_openid: 'openid-1' }, timestamp: '2026-11-05T10:00:00+08:00' },
  })
  assert.equal(c2c.channel, 'qq')
  assert.equal(c2c.userId, 'openid-1')
  assert.equal(c2c.text, '今天好累')
  assert.equal(c2c.receivedAt, Date.parse('2026-11-05T10:00:00+08:00'))

  const group = parseQQGatewayFrame({
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'm-2', content: '<@!123456> 陪我聊聊天', author: { member_openid: 'member-1' }, group_openid: 'group-9' },
  })
  assert.equal(group.userId, 'member-1')
  assert.equal(group.text, '陪我聊聊天')
  assert.equal(group.meta.groupId, 'group-9')

  const guild = parseQQGatewayFrame({
    op: 0,
    t: 'AT_MESSAGE_CREATE',
    d: { id: 'm-3', content: '<@!888> 晚上好', author: { id: 'guild-user-1' }, channel_id: 'channel-3' },
  })
  assert.equal(guild.userId, 'guild-user-1')
  assert.equal(guild.text, '晚上好')
  assert.equal(guild.meta.channelId, 'channel-3')

  assert.equal(parseQQGatewayFrame({ op: 0, t: 'READY', d: {} }), undefined)
  assert.equal(parseQQGatewayFrame({ op: 10, d: { heartbeat_interval: 30000 } }), undefined)
  assert.equal(parseQQGatewayFrame({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { content: '   ', author: { user_openid: 'x' } } }), undefined)
})

test('I5：QQ 出站 payload 区分 C2C / 群聊 / 频道', () => {
  const base = { text: '晚安呀', userId: 'openid-1', replyTo: 'm-1' }
  const c2c = buildQQReplyPayload(base)
  assert.equal(c2c.endpoint, '/v2/users/openid-1/messages')
  assert.deepEqual(c2c.body, { content: '晚安呀', msg_type: 0, msg_id: 'm-1' })

  const group = buildQQReplyPayload({ ...base, meta: { groupId: 'group-9' } })
  assert.equal(group.endpoint, '/v2/groups/group-9/messages')

  const guild = buildQQReplyPayload({ ...base, meta: { channelId: 'channel-3' } })
  assert.equal(guild.endpoint, '/channels/channel-3/messages')
})

test('I5：适配器生命周期与 QQ 官方适配器配置状态', async () => {
  const base = new IMAdapter({ id: 'base-1' })
  assert.equal(base.status().state, 'created')
  const received = []
  await base.start({ onMessage: (inbound) => received.push(inbound) })
  assert.equal(base.state, 'running')
  await base.stop()
  assert.equal(base.state, 'stopped')

  const qq = new QQBotAdapter({ appId: '1020', clientSecret: 'secret' })
  assert.equal(qq.channel, 'qq')
  assert.equal(qq.validateConfig().ok, true)
  assert.equal(qq.supportsProactive, false)
  assert.equal(qq.maxBubblesPerReply, 3)

  const badQQ = new QQBotAdapter({})
  const badStarted = await badQQ.start({ onMessage: () => {} })
  assert.equal(badStarted.state, 'awaiting_config')
  assert.ok(badStarted.lastError.includes('appId'))
  const badSent = await badQQ.send({ text: '在的呀', userId: 'openid-9' })
  assert.equal(badSent.delivered, false)
  assert.equal(badSent.reason, 'invalid_config')
})

test('I5：CompanionIMBridge 入站→记忆写入→上下文→回复派发', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-im-'))
  t.after(() => {
    resetMemoryEngineRegistry()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const clock = createFixedClock('2026-11-05T20:00:00+08:00')
  const persona = createPersonaService({
    dataDir,
    defaultPersonaFile: path.join(bundleDir, 'data', 'persona.default.json'),
    clock,
  })
  persona.ensure()
  const memory = getMemoryEngine({ dataDir, clock })
  memory.ensure()

  class FakeQQAdapter extends IMAdapter {
    get channel() {
      return 'qq'
    }
    async send() {
      return { delivered: true }
    }
  }

  const bridge = new CompanionIMBridge({ persona, memory })
  const qq = new FakeQQAdapter({ id: 'fake-qq-bridge' })
  const unregister = bridge.registerAdapter(qq)
  assert.equal(typeof unregister, 'function')
  assert.throws(() => bridge.registerAdapter({}), /适配器必须/)
  assert.throws(() => bridge.registerAdapter(new FakeQQAdapter({ id: qq.id })), /重复/)

  const started = await bridge.startAll()
  assert.equal(started.length, 1)
  assert.equal(started[0].state, 'running')

  const inbound = normalizeInbound({
    text: '我今天被老板批评了，有点难过',
    userId: 'openid-1',
    channel: 'qq',
    id: 'qq-msg-1',
    receivedAt: clock.now(),
  })
  const result = bridge.handleInbound(inbound)
  assert.equal(result.accepted, true)
  assert.ok(result.ingest.created.length >= 1, '应当自动抽取至少一条记忆')
  assert.match(result.context.personaSection, /【人设 · 始终生效】/)
  assert.match(result.context.memoryDigest, /记忆/)
  assert.match(result.context.systemPrompt, /【人设/)
  assert.ok(memory.status().total >= 1)
  const totalAfterFirst = memory.status().total

  // 同一 messageId 不重复写入
  const again = bridge.handleInbound(inbound)
  assert.equal(again.ingest.created.length, 0)
  assert.equal(memory.status().total, totalAfterFirst)

  const reply = await bridge.dispatchReply({ text: '抱抱你，被批评一定很难受吧。', userId: 'openid-1', channel: 'qq', adapterId: qq.id, replyTo: 'qq-msg-1' })
  assert.equal(reply.delivered, true)
  assert.equal(reply.outbound.text, '抱抱你，被批评一定很难受吧。')

  const stopped = await bridge.stopAll()
  assert.equal(stopped[0].state, 'stopped')
  assert.equal(bridge.status().started, false)
})
