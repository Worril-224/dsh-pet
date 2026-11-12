/**
 * QQ 接入通道验收：
 *  - QQ 官方机器人适配器：token、网关、Identify、消息解析、被动回复、msg_seq、图片；
 *  - NapCat ↔ QQ 官方通道切换、凭据持久化、openid 待审批；
 *  - 通道路由 GET/POST 与批准/忽略。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  QQBotAdapter,
  buildQQMediaPayload,
  buildQQReplyPayload,
  parseQQGatewayFrame,
  validateQQBotConfig,
} from '../../lib/im/qq-bot.js'
import {
  createQQHost,
  mergeQQBotSettings,
  normalizeQQBotSettings,
} from '../../lib/qq-host.js'
import { registerQQChannelRoutes } from '../../lib/qq-channel-routes.js'

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data
    },
  }
}

function createFakeFetch() {
  const calls = []
  async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), init })
    const value = String(url)
    if (value.includes('getAppAccessToken')) {
      return jsonResponse({ access_token: 'access-token-1', expires_in: '7200' })
    }
    if (value.endsWith('/gateway')) {
      return jsonResponse({ url: 'wss://fake.qq/websocket' })
    }
    if (value.includes('/files')) {
      return jsonResponse({ file_info: 'file-info-1', file_uuid: 'uuid-1', ttl: 3600 })
    }
    if (value.includes('/messages')) {
      return jsonResponse({ id: 'out-msg-1', timestamp: '1762345678' })
    }
    return jsonResponse({})
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function createFakeSocket(options = {}) {
  const listeners = new Map()
  const sent = []
  let closed = false
  const socket = {
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
      const payload = JSON.parse(data)
      sent.push(payload)
      if (payload.op === 2) {
        queueMicrotask(() => {
          if (closed) return
          socket.emit('message', {
            data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } }),
          })
        })
      }
    },
    close() {
      if (closed) return
      closed = true
      socket.emit('close', { code: 1000 })
    },
  }
  return socket
}

function autoSocketFactory(sockets) {
  return () => {
    const socket = createFakeSocket()
    sockets.push(socket)
    setTimeout(() => {
      socket.emit('open', {})
      socket.emit('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }),
      })
    }, 0)
    return socket
  }
}

function fakePersona() {
  return {
    renderPersonaSection: () => '【人设】奥菲莉亚',
    lookup: () => ({ ok: false }),
  }
}

function fakeMemory() {
  return {
    renderDigest: () => '【记忆】主人喜欢雨天。',
    ensure: () => {},
    remember: () => {},
    recordConversationTurn: () => ({ item: { id: 'm1' } }),
    organizeShortTermOverflow: () => ({}),
  }
}

function fakeReplyEngine() {
  return {
    resolveRoute: () => undefined,
    generate: async () => ({ text: '我在呢。' }),
    generateWithPrompt: async () => '我在呢。',
  }
}

function makeFakeAdapter(channel) {
  const sent = []
  return {
    id: `fake-${channel}`,
    maxBubblesPerReply: channel === 'qqbot' ? 3 : undefined,
    maxCharsPerBubble: channel === 'qqbot' ? 1800 : undefined,
    supportsProactive: channel !== 'qqbot',
    supportsAttention: channel !== 'qqbot',
    status: () => ({ id: `fake-${channel}`, state: 'running', transport: channel }),
    start: async () => ({ state: 'running' }),
    stop: async () => ({ state: 'stopped' }),
    send: async (outbound) => {
      sent.push(outbound)
      return { delivered: true, id: `sent-${sent.length}` }
    },
    sent,
  }
}

function createHost(root) {
  const adapters = new Map()
  const host = createQQHost({
    config: {
      charactersDir: root,
      characterId: 'ophelia',
      botQQ: '123456789',
      allowUsers: ['10001'],
      provider: 'cfg-provider',
      model: 'cfg-model',
      channel: 'napcat',
    },
    deps: {
      persona: fakePersona(),
      memory: fakeMemory(),
      replyEngine: fakeReplyEngine(),
      adapterFactory: ({ channel }) => {
        if (!adapters.has(channel)) adapters.set(channel, makeFakeAdapter(channel))
        return adapters.get(channel)
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  })
  return { host, adapters }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-companion-channel-'))
}

function fakeResponse() {
  return {
    headersSent: false,
    status: undefined,
    body: undefined,
    headers: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(body) {
      this.body = body
    },
  }
}

function fakeRequest({ method = 'GET', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:56182', ...headers }
  return req
}

function createFakeWebServer() {
  const handlers = new Map()
  return {
    handlers,
    register(route) {
      handlers.set(route.path, route.handler)
      return () => handlers.delete(route.path)
    },
  }
}

function createRouteContext(webServer) {
  return {
    get(name) {
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(callback) {
      callback()
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

async function call(handler, request) {
  const response = fakeResponse()
  await handler(request, response)
  return {
    status: response.status,
    body: response.body ? JSON.parse(response.body) : undefined,
  }
}

test('QQ 官方：配置校验要求 AppID + AppSecret（Token 不再是必需项）', () => {
  const empty = validateQQBotConfig({})
  assert.equal(empty.ok, false)
  assert.equal(empty.errors.length, 2)
  assert.match(empty.errors.join(' '), /appId/u)
  assert.match(empty.errors.join(' '), /clientSecret/u)
  assert.deepEqual(validateQQBotConfig({ appId: '1020', clientSecret: 'secret' }), { ok: true, errors: [] })
  assert.deepEqual(validateQQBotConfig({ appId: '1020', secret: 'secret' }), { ok: true, errors: [] })
  assert.equal(validateQQBotConfig({ appId: '1020', clientSecret: 'secret', intents: -1 }).ok, false)
})

test('QQ 官方：网关帧解析图片附件 / 纯图片消息 / 群聊 @', () => {
  const imageOnly = parseQQGatewayFrame({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id: 'm-img',
      content: '',
      author: { user_openid: 'openid-1' },
      attachments: [
        { url: 'https://example.test/a.png', content_type: 'image/png', filename: 'a.png', size: 12 },
      ],
    },
  })
  assert.ok(imageOnly)
  assert.equal(imageOnly.text, '[图片]')
  assert.equal(imageOnly.meta.images.length, 1)
  assert.equal(imageOnly.meta.images[0].url, 'https://example.test/a.png')

  const group = parseQQGatewayFrame({
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'm-group',
      content: '<@!123> 晚上好',
      author: { member_openid: 'member-1' },
      group_openid: 'group-1',
      attachments: [{ url: 'https://example.test/b.pdf', content_type: 'application/pdf', filename: 'b.pdf' }],
    },
  })
  assert.ok(group)
  assert.equal(group.text, '晚上好')
  assert.equal(group.meta.groupId, 'group-1')
  assert.equal(group.meta.messageType, 'group')
  assert.equal(group.meta.attachments.length, 1)
})

test('QQ 官方：payload 生成 msg_seq / 频道消息不发送 msg_type', () => {
  const c2c = buildQQReplyPayload(
    { text: '晚安', userId: 'openid-1', replyTo: 'msg-1' },
    { msgSeq: 2 },
  )
  assert.deepEqual(c2c.body, { content: '晚安', msg_type: 0, msg_id: 'msg-1', msg_seq: 2 })

  const channel = buildQQReplyPayload({ text: '在', userId: 'u1', replyTo: 'msg-2', meta: { channelId: 'ch-1' } })
  assert.equal(channel.endpoint, '/channels/ch-1/messages')
  assert.deepEqual(channel.body, { content: '在', msg_id: 'msg-2' })

  const media = buildQQMediaPayload(
    { text: '图', userId: 'openid-1', replyTo: 'msg-1' },
    'file-info-1',
    { msgSeq: 3 },
  )
  assert.deepEqual(media.body, { msg_type: 7, media: { file_info: 'file-info-1' }, msg_id: 'msg-1', msg_seq: 3 })
})

test('QQ 官方适配器：token → gateway → Identify → 收消息 → 被动回复 / 图片 / msg_seq', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qqbot-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const imageFile = path.join(root, 'image.png')
  fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))

  const fetchImpl = createFakeFetch()
  const sockets = []
  const adapter = new QQBotAdapter({
    appId: '1020',
    clientSecret: 'secret',
    fetchImpl,
    socketFactory: autoSocketFactory(sockets),
  })
  const received = []
  const started = await adapter.start({ onMessage: (inbound) => received.push(inbound) })
  assert.equal(started.state, 'running')
  assert.equal(sockets.length, 1)
  const identify = sockets[0].sent.find((payload) => payload.op === 2)
  assert.ok(identify)
  assert.equal(identify.d.token, 'QQBot access-token-1')
  assert.equal(identify.d.intents, 1 << 25)

  sockets[0].emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      s: 2,
      d: {
        id: 'in-1',
        content: '在吗',
        author: { user_openid: 'openid-1' },
        timestamp: '2026-11-11T20:00:00+08:00',
      },
    }),
  })
  assert.equal(received.length, 1)
  assert.equal(received[0].userId, 'openid-1')
  assert.equal(received[0].text, '在吗')

  const outbound = {
    id: 'out-1',
    channel: 'qq',
    adapterId: adapter.id,
    userId: 'openid-1',
    text: '我在。',
    replyTo: 'in-1',
  }
  const sent1 = await adapter.send(outbound)
  assert.equal(sent1.delivered, true)
  const messageCall = fetchImpl.calls.find((entry) => entry.url.includes('/v2/users/openid-1/messages'))
  assert.ok(messageCall)
  const body1 = JSON.parse(messageCall.init.body)
  assert.equal(body1.content, '我在。')
  assert.equal(body1.msg_id, 'in-1')
  assert.equal(body1.msg_seq, 1)
  assert.equal(messageCall.init.headers.authorization, 'QQBot access-token-1')

  await adapter.send(outbound)
  const messageCalls = fetchImpl.calls.filter((entry) => entry.url.includes('/v2/users/openid-1/messages'))
  const body2 = JSON.parse(messageCalls.at(-1).init.body)
  assert.equal(body2.msg_seq, 2)

  await adapter.send({ ...outbound, text: '画好了', images: [imageFile] })
  const upload = fetchImpl.calls.find((entry) => entry.url.includes('/v2/users/openid-1/files'))
  assert.ok(upload)
  const uploadBody = JSON.parse(upload.init.body)
  assert.equal(uploadBody.file_type, 1)
  assert.equal(uploadBody.srv_send_msg, false)
  assert.ok(uploadBody.file_data.length > 0)
  const mediaCall = fetchImpl.calls
    .filter((entry) => entry.url.includes('/v2/users/openid-1/messages'))
    .map((entry) => JSON.parse(entry.init.body))
    .find((body) => body.msg_type === 7)
  assert.deepEqual(mediaCall.media, { file_info: 'file-info-1' })
  assert.equal(mediaCall.msg_id, 'in-1')

  await adapter.stop()
  assert.equal(adapter.state, 'stopped')
})

test('QQ 官方：没有 msg_id 的主动消息直接拒绝（平台已下线主动消息）', async (t) => {
  const fetchImpl = createFakeFetch()
  const sockets = []
  const adapter = new QQBotAdapter({
    appId: '1020',
    clientSecret: 'secret',
    fetchImpl,
    socketFactory: autoSocketFactory(sockets),
  })
  await adapter.start({ onMessage: () => {} })
  await assert.rejects(
    () => adapter.send({ text: '主动消息', userId: 'openid-1' }),
    /只能被动回复/u,
  )
  await adapter.stop()
})

test('QQ 通道：NapCat ↔ QQ 官方切换、凭据持久化、不泄漏 AppSecret', async (t) => {
  const root = tempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const first = createHost(root)
  assert.equal(first.host.getChannelState().channel, 'napcat')
  assert.equal(first.host.getChannelState().adapter.id, 'fake-napcat')

  const switched = await first.host.setChannel('qqbot', {
    qqbot: { appId: '1020', clientSecret: 'super-secret', sandbox: true },
  })
  assert.equal(switched.channel, 'qqbot')
  assert.equal(switched.qqbot.appId, '1020')
  assert.equal(switched.qqbot.configured, true)
  assert.equal(switched.qqbot.secretConfigured, true)
  assert.equal(JSON.stringify(switched).includes('super-secret'), false)
  assert.equal(switched.supportsProactive, false)
  assert.equal(switched.adapter.id, 'fake-qqbot')

  const file = path.join(root, 'ophelia', 'qq', 'channel.json')
  assert.ok(fs.existsSync(file))
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.channel, 'qqbot')
  assert.equal(saved.qqbot.appId, '1020')
  assert.equal(saved.qqbot.clientSecret, 'super-secret')

  const second = createHost(root)
  const restored = second.host.getChannelState()
  assert.equal(restored.channel, 'qqbot')
  assert.equal(restored.qqbot.appId, '1020')
  assert.equal(restored.qqbot.secretConfigured, true)
  assert.equal(JSON.stringify(second.host.status()).includes('super-secret'), false)

  const back = await second.host.setChannel('napcat')
  assert.equal(back.channel, 'napcat')
  assert.equal(back.adapter.id, 'fake-napcat')
})

test('QQ 官方：未知 openid 进入待审批，批准后才允许回复', async (t) => {
  const root = tempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { host, adapters } = createHost(root)
  await host.setChannel('qqbot', { qqbot: { appId: '1020', clientSecret: 'secret' } })
  const adapter = adapters.get('qqbot')

  const inbound = {
    id: 'in-openid-1',
    channel: 'qq',
    adapterId: adapter.id,
    userId: 'openid-unknown',
    text: '你好',
    receivedAt: Date.now(),
    meta: { eventType: 'C2C_MESSAGE_CREATE', messageType: 'private' },
  }
  assert.equal(host.isAllowed(inbound), false)
  const result = await host.handleInbound(inbound)
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'not_allowed')
  const state = host.getChannelState()
  assert.equal(state.qqbot.pendingUsers.length, 1)
  assert.equal(state.qqbot.pendingUsers[0].userId, 'openid-unknown')
  assert.equal(adapter.sent.length, 1)
  assert.match(adapter.sent[0].text, /openid-unknown/u)

  const approved = host.allowQQBotUser('openid-unknown')
  assert.equal(approved.qqbot.pendingUsers.length, 0)
  assert.ok(approved.qqbot.allowOpenids.includes('openid-unknown'))
  assert.equal(host.isAllowed(inbound), true)

  const replayed = await host.handleInbound(inbound)
  assert.equal(replayed.accepted, true)
})

test('QQ 通道路由：GET 状态、POST 切换、批准 / 忽略 openid', async (t) => {
  const root = tempDir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { host } = createHost(root)
  const webServer = createFakeWebServer()
  const ctx = createRouteContext(webServer)
  registerQQChannelRoutes(ctx, host, { logger: ctx.logger })
  const route = webServer.handlers.get('/dsh-companion/qq/channel')
  const allowRoute = webServer.handlers.get('/dsh-companion/qq/channel/allow')
  const denyRoute = webServer.handlers.get('/dsh-companion/qq/channel/deny')
  assert.ok(route && allowRoute && denyRoute)

  const initial = await call(route, fakeRequest())
  assert.equal(initial.status, 200)
  assert.equal(initial.body.data.channel, 'napcat')

  const switched = await call(route, fakeRequest({
    method: 'POST',
    body: { channel: 'qqbot', qqbot: { appId: '1020', clientSecret: 'secret' } },
  }))
  assert.equal(switched.status, 200)
  assert.equal(switched.body.data.channel, 'qqbot')
  assert.equal(switched.body.data.qqbot.configured, true)

  host.settings.qqbot.pendingUsers = [{ userId: 'openid-pending', at: '2026-11-11T20:00:00+08:00' }]
  const allowed = await call(allowRoute, fakeRequest({ method: 'POST', body: { openid: 'openid-pending' } }))
  assert.equal(allowed.status, 200)
  assert.deepEqual(allowed.body.data.qqbot.pendingUsers, [])
  assert.ok(allowed.body.data.qqbot.allowOpenids.includes('openid-pending'))

  const denied = await call(denyRoute, fakeRequest({ method: 'POST', body: { openid: 'openid-pending' } }))
  assert.equal(denied.status, 200)
  assert.equal(denied.body.data.qqbot.allowOpenids.includes('openid-pending'), false)

  const invalid = await call(route, fakeRequest({ method: 'POST', body: { channel: 'other' } }))
  assert.equal(invalid.status, 400)
})

test('QQ 官方配置合并：插件配置 + 角色目录保存值，数组去重', () => {
  const base = normalizeQQBotSettings({ appId: 'base', clientSecret: 'base-secret', allowOpenids: ['a'] })
  const merged = mergeQQBotSettings(base, {
    appId: 'saved',
    allowOpenids: ['a', 'b'],
    pendingUsers: [{ userId: 'c', at: 'now' }],
  })
  assert.equal(merged.appId, 'saved')
  assert.equal(merged.clientSecret, 'base-secret')
  assert.deepEqual(merged.allowOpenids, ['a', 'b'])
  assert.equal(merged.pendingUsers.length, 1)
})
