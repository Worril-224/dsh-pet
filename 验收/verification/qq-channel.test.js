/**
 * 独立验收 · QQ 接入通道（2026-11-11 追加）
 *
 * 覆盖：
 *  - QQ 官方机器人配置/帧解析/payload；
 *  - 假 fetch + 假 WebSocket 下的 token → gateway → Identify → 收消息 → 被动回复；
 *  - createQQHost 的 NapCat ↔ QQ 官方切换、凭据持久化、Secret 不泄漏；
 *  - 通道路由 GET/POST 与 openid 批准。
 *
 * 不连接真实 QQ，不修改仓库内 companion-data。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  QQBotAdapter,
  buildQQReplyPayload,
  parseQQGatewayFrame,
  validateQQBotConfig,
} from '../../companion-bundle/lib/im/qq-bot.js'
import { createQQHost } from '../../companion-bundle/lib/qq-host.js'
import { registerQQChannelRoutes } from '../../companion-bundle/lib/qq-channel-routes.js'
import { cleanupTempDirs, makeTempDir } from './helpers.mjs'

test.after(cleanupTempDirs)

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return data
    },
  }
}

function fakeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const value = String(url)
    if (value.includes('getAppAccessToken')) return jsonResponse({ access_token: 'verify-token', expires_in: '7200' })
    if (value.endsWith('/gateway')) return jsonResponse({ url: 'wss://fake/websocket' })
    if (value.includes('/messages')) return jsonResponse({ id: 'verify-out-1' })
    return jsonResponse({})
  }
}

function fakeSocket(sockets) {
  const listeners = new Map()
  const sent = []
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
        queueMicrotask(() => socket.emit('message', {
          data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'verify-session' } }),
        }))
      }
    },
    close() {
      socket.emit('close', { code: 1000 })
    },
  }
  sockets.push(socket)
  setTimeout(() => {
    socket.emit('open', {})
    socket.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) })
  }, 0)
  return socket
}

function fakeAdapter(channel) {
  return {
    id: `verify-${channel}`,
    maxBubblesPerReply: channel === 'qqbot' ? 3 : undefined,
    supportsProactive: channel !== 'qqbot',
    supportsAttention: channel !== 'qqbot',
    status: () => ({ id: `verify-${channel}`, state: 'running' }),
    start: async () => ({ state: 'running' }),
    stop: async () => ({ state: 'stopped' }),
    send: async () => ({ delivered: true }),
  }
}

function makeHost() {
  const root = makeTempDir('dshpet-verify-channel-')
  const adapters = new Map()
  const host = createQQHost({
    config: {
      charactersDir: root,
      characterId: 'ophelia',
      botQQ: '123456789',
      allowUsers: ['10001'],
      channel: 'napcat',
    },
    deps: {
      persona: { renderPersonaSection: () => '【人设】', lookup: () => ({ ok: false }) },
      memory: {
        ensure: () => {},
        renderDigest: () => '',
        remember: () => {},
        recordConversationTurn: () => ({}),
        organizeShortTermOverflow: () => {},
      },
      replyEngine: { generate: async () => ({ text: '在。' }), generateWithPrompt: async () => '在。' },
      adapterFactory: ({ channel }) => {
        if (!adapters.has(channel)) adapters.set(channel, fakeAdapter(channel))
        return adapters.get(channel)
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  })
  return { root, host, adapters }
}

function fakeWebServer() {
  const handlers = new Map()
  return {
    handlers,
    register(route) {
      handlers.set(route.path, route.handler)
      return () => handlers.delete(route.path)
    },
  }
}

function fakeRequest(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:56182' }
  return req
}

async function call(handler, req) {
  const res = {
    headersSent: false,
    status: undefined,
    body: undefined,
    writeHead(status) {
      this.status = status
      this.headersSent = true
    },
    end(body) {
      this.body = body
    },
  }
  await handler(req, res)
  return { status: res.status, body: res.body ? JSON.parse(res.body) : undefined }
}

test('VC1: QQ 官方配置 / 图片帧 / msg_seq payload', () => {
  assert.equal(validateQQBotConfig({}).ok, false)
  assert.deepEqual(validateQQBotConfig({ appId: '1', clientSecret: 's' }), { ok: true, errors: [] })
  assert.equal(validateQQBotConfig({ appId: '1', secret: 's' }).ok, true, '旧 secret 字段仍兼容')

  const image = parseQQGatewayFrame({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id: 'img-1',
      content: '',
      author: { user_openid: 'openid-1' },
      attachments: [{ url: 'https://example.test/a.png', content_type: 'image/png' }],
    },
  })
  assert.ok(image)
  assert.equal(image.text, '[图片]')
  assert.equal(image.meta.images.length, 1)

  const payload = buildQQReplyPayload(
    { text: '晚安', userId: 'openid-1', replyTo: 'msg-1' },
    { msgSeq: 3 },
  )
  assert.equal(payload.endpoint, '/v2/users/openid-1/messages')
  assert.deepEqual(payload.body, { content: '晚安', msg_type: 0, msg_id: 'msg-1', msg_seq: 3 })
})

test('VC2: QQ 官方适配器假网络端到端（token/Identify/收消息/被动回复）', async () => {
  const calls = []
  const sockets = []
  const adapter = new QQBotAdapter({
    appId: 'verify-app',
    clientSecret: 'verify-secret',
    fetchImpl: fakeFetch(calls),
    socketFactory: () => fakeSocket(sockets),
  })
  const received = []
  const started = await adapter.start({ onMessage: (inbound) => received.push(inbound) })
  assert.equal(started.state, 'running')
  const identify = sockets[0].sent.find((entry) => entry.op === 2)
  assert.equal(identify.d.token, 'QQBot verify-token')
  assert.equal(identify.d.intents, 1 << 25)

  sockets[0].emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      s: 2,
      d: { id: 'in-1', content: '在吗', author: { user_openid: 'openid-1' } },
    }),
  })
  assert.equal(received.length, 1)
  assert.equal(received[0].text, '在吗')

  const outbound = { text: '我在。', userId: 'openid-1', replyTo: 'in-1' }
  await adapter.send(outbound)
  await adapter.send(outbound)
  const messageCalls = calls.filter((entry) => entry.url.includes('/v2/users/openid-1/messages'))
  const bodies = messageCalls.map((entry) => JSON.parse(entry.init.body))
  assert.equal(bodies[0].msg_seq, 1)
  assert.equal(bodies[1].msg_seq, 2)
  assert.equal(bodies[0].msg_id, 'in-1')
  assert.equal(messageCalls[0].init.headers.authorization, 'QQBot verify-token')
  await adapter.stop()
  assert.equal(adapter.state, 'stopped')
})

test('VC3: NapCat ↔ QQ 官方切换、凭据持久化、Secret 不泄漏', async () => {
  const { root, host } = makeHost()
  assert.equal(host.getChannelState().channel, 'napcat')

  const switched = await host.setChannel('qqbot', {
    qqbot: { appId: 'verify-app', clientSecret: 'verify-secret' },
  })
  assert.equal(switched.channel, 'qqbot')
  assert.equal(switched.qqbot.configured, true)
  assert.equal(JSON.stringify(switched).includes('verify-secret'), false)
  assert.equal(switched.supportsProactive, false)

  const file = path.join(root, 'ophelia', 'qq', 'channel.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.channel, 'qqbot')
  assert.equal(saved.qqbot.clientSecret, 'verify-secret')

  // 用同一 root 重启一个 Host 验证保存值优先
  const restartedHost = createQQHost({
    config: {
      charactersDir: root,
      characterId: 'ophelia',
      botQQ: '123456789',
      allowUsers: ['10001'],
      channel: 'napcat',
    },
    deps: {
      persona: { renderPersonaSection: () => '【人设】', lookup: () => ({ ok: false }) },
      memory: {
        ensure: () => {},
        renderDigest: () => '',
        remember: () => {},
        recordConversationTurn: () => ({}),
        organizeShortTermOverflow: () => {},
      },
      replyEngine: { generate: async () => ({ text: '在。' }), generateWithPrompt: async () => '在。' },
      adapterFactory: ({ channel }) => fakeAdapter(channel),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  })
  assert.equal(restartedHost.getChannelState().channel, 'qqbot')
  assert.equal(restartedHost.getChannelState().qqbot.appId, 'verify-app')
  assert.equal(JSON.stringify(restartedHost.status()).includes('verify-secret'), false)
})

test('VC4: 通道路由 GET/POST 与 openid 批准', async () => {
  const { host } = makeHost()
  const webServer = fakeWebServer()
  const ctx = {
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    effect(callback) {
      callback()
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  registerQQChannelRoutes(ctx, host, { logger: ctx.logger })
  const channelRoute = webServer.handlers.get('/dsh-companion/qq/channel')
  const allowRoute = webServer.handlers.get('/dsh-companion/qq/channel/allow')
  assert.ok(channelRoute && allowRoute)

  const initial = await call(channelRoute, fakeRequest('GET'))
  assert.equal(initial.status, 200)
  assert.equal(initial.body.data.channel, 'napcat')

  const switched = await call(channelRoute, fakeRequest('POST', {
    channel: 'qqbot',
    qqbot: { appId: 'verify-app', clientSecret: 'verify-secret' },
  }))
  assert.equal(switched.status, 200)
  assert.equal(switched.body.data.channel, 'qqbot')

  const allowed = await call(allowRoute, fakeRequest('POST', { openid: 'openid-approved' }))
  assert.equal(allowed.status, 200)
  assert.ok(allowed.body.data.qqbot.allowOpenids.includes('openid-approved'))
})
