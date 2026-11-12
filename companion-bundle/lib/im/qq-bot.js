/**
 * QQ 官方机器人适配器（QQ 开放平台 v2）。
 *
 * 与 NapCat / OneBot 不同，官方机器人走腾讯开放平台，不依赖外部注入：
 *  - AppID + AppSecret 换取 2 小时有效的 access_token；
 *  - WebSocket 网关接收 C2C / 群聊 @ / 频道 @ 事件，含心跳、断线重连与 Resume；
 *  - 通过 OpenAPI 被动回复（必须带触发消息的 msg_id / msg_seq）；
 *  - 支持图片：先上传到 QQ 富媒体接口拿 file_info，再发 msg_type=7。
 *
 * 平台限制（2025-04 起主动消息下线）：
 *  - 只能在收到用户消息后的窗口内被动回复；
 *  - 单聊每条消息最多 5 次回复，群聊每条消息最多 5 次回复；
 *  - 因此主动生活分享 / 注意力搭话在官方通道不可用（由 qq-host 跳过）。
 */
import fs from 'node:fs'
import { IMAdapter, IMAdapterError, normalizeInbound } from './adapter.js'

/** QQ 支持解析的网关事件类型。 */
export const QQ_MESSAGE_EVENTS = ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE']

/** QQ 官方 API 默认基座（正式环境）。 */
export const QQ_BOT_API_BASE = 'https://api.bot.qq.com'
/** QQ 官方 API 沙箱基座。 */
export const QQ_BOT_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'
/** 获取 access_token 的官方地址。 */
export const QQ_BOT_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
/** 兼容旧接入点的 token 地址，主地址不可用时兜底。 */
export const QQ_BOT_TOKEN_URL_FALLBACK = 'https://api.bot.qq.com/app/getAppAccessToken'

/** 默认订阅群聊 + 单聊事件（GROUP_AND_C2C_EVENT）。 */
export const QQ_BOT_DEFAULT_INTENTS = 1 << 25
/** QQ 单条文本消息的保守长度上限。 */
export const QQ_BOT_MAX_TEXT_CHARS = 2000
/** 同一条用户消息最多允许的被动回复条数。 */
export const QQ_BOT_MAX_REPLIES = 5
/** 官方通道给气泡拆分留出的条数（最后 2 条预留给图片的说明文字 + 媒体消息）。 */
export const QQ_BOT_MAX_BUBBLES = 3
/** 官方通道单气泡建议长度（留出平台 2000 字上限余量）。 */
export const QQ_BOT_MAX_BUBBLE_CHARS = 1800

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 去掉群聊/频道消息开头的 @ 占位符。 */
function stripLeadingMention(text) {
  return String(text).replace(/^\s*<@!?[^>]*>\s*/u, '').trim()
}

/** 规范化 QQ 官方机器人配置；secret 支持多种历史字段名。 */
export function normalizeQQBotConfig(config = {}) {
  const source = isPlainObject(config) ? config : {}
  const appId = source.appId ?? source.app_id
  const clientSecret = source.clientSecret ?? source.secret ?? source.appSecret
  const intents = Number.isInteger(source.intents) ? source.intents : QQ_BOT_DEFAULT_INTENTS
  return {
    appId: typeof appId === 'string' ? appId.trim() : appId !== undefined && appId !== null ? String(appId) : '',
    clientSecret:
      typeof clientSecret === 'string'
        ? clientSecret.trim()
        : clientSecret !== undefined && clientSecret !== null
          ? String(clientSecret)
          : '',
    sandbox: source.sandbox === true,
    intents,
    baseUrl: typeof source.baseUrl === 'string' && source.baseUrl.trim() ? source.baseUrl.trim() : undefined,
    tokenUrl: typeof source.tokenUrl === 'string' && source.tokenUrl.trim() ? source.tokenUrl.trim() : undefined,
  }
}

/** QQBotAdapter 构造配置校验。 */
export function validateQQBotConfig(config = {}) {
  if (!isPlainObject(config)) return { ok: false, errors: ['配置必须是对象'] }
  const errors = []
  const normalized = normalizeQQBotConfig(config)
  if (!normalized.appId) errors.push('缺少 appId（机器人 AppID）')
  if (!normalized.clientSecret) errors.push('缺少 clientSecret（机器人 AppSecret）')
  const intents = config.intents
  if (intents !== undefined && (!Number.isInteger(intents) || intents < 0)) errors.push('intents 必须是非负整数')
  return { ok: errors.length === 0, errors }
}

/** QQ 事件附件 → 统一图片/附件元数据。 */
function parseAttachments(value) {
  const attachments = Array.isArray(value) ? value : []
  const images = []
  const files = []
  for (const item of attachments) {
    if (!isPlainObject(item) || typeof item.url !== 'string' || !item.url) continue
    const contentType = String(item.content_type ?? item.contentType ?? '')
    const filename = typeof item.filename === 'string' ? item.filename : undefined
    const meta = {
      url: item.url,
      ...(filename ? { name: filename } : {}),
      ...(Number.isFinite(Number(item.size)) ? { size: Number(item.size) } : {}),
      ...(contentType ? { contentType } : {}),
    }
    if (contentType.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/iu.test(filename ?? item.url)) {
      images.push(meta)
    } else {
      files.push(meta)
    }
  }
  return { images, files }
}

/**
 * 把 QQ 网关事件帧解析为统一入站消息。
 * @param {object} frame 形如 { op, t, d, s, id }
 * @param {object} [options] { adapterId, receivedAt }
 * @returns {object|undefined} 统一 Inbound；非消息事件返回 undefined
 */
export function parseQQGatewayFrame(frame, options = {}) {
  if (!isPlainObject(frame)) return undefined
  const t = typeof frame.t === 'string' ? frame.t : ''
  if (!QQ_MESSAGE_EVENTS.includes(t)) return undefined
  const d = isPlainObject(frame.d) ? frame.d : undefined
  if (!d) return undefined

  const rawText = typeof d.content === 'string' ? d.content : ''
  const text = stripLeadingMention(rawText)
  const { images, files } = parseAttachments(d.attachments)
  if (!text && images.length === 0 && files.length === 0) return undefined
  const fallbackText = text || (images.length > 0 ? '[图片]' : '[附件]')

  let userId
  let userName
  if (t === 'C2C_MESSAGE_CREATE') {
    userId = d.author?.user_openid ?? d.author?.id
    userName = d.author?.username ?? d.author?.nickname
  } else if (t === 'GROUP_AT_MESSAGE_CREATE') {
    userId = d.author?.member_openid ?? d.author?.id
    userName = d.author?.member_name ?? d.author?.username
  } else {
    userId = d.author?.id
    userName = d.author?.username
  }
  if (!userId) return undefined

  const receivedAt = Number.isFinite(options.receivedAt)
    ? options.receivedAt
    : typeof d.timestamp === 'string' && !Number.isNaN(Date.parse(d.timestamp))
      ? Date.parse(d.timestamp)
      : Date.now()

  const meta = {
    eventType: t,
    messageType: t === 'C2C_MESSAGE_CREATE' ? 'private' : t === 'GROUP_AT_MESSAGE_CREATE' ? 'group' : 'channel',
  }
  if (d.group_openid) meta.groupId = String(d.group_openid)
  if (d.channel_id) meta.channelId = String(d.channel_id)
  if (d.guild_id) meta.guildId = String(d.guild_id)
  if (images.length > 0) meta.images = images
  if (files.length > 0) meta.attachments = files

  return normalizeInbound({
    id: typeof d.id === 'string' ? d.id : undefined,
    channel: 'qq',
    adapterId: options.adapterId,
    userId: String(userId),
    userName: typeof userName === 'string' ? userName : undefined,
    text: fallbackText,
    receivedAt,
    meta,
    raw: frame,
  })
}

/**
 * 生成 QQ 开放平台 v2 发送消息所需的 endpoint 与请求体。
 * C2C：POST /v2/users/{user_openid}/messages
 * 群聊：POST /v2/groups/{group_openid}/messages
 * 频道：POST /channels/{channel_id}/messages
 * @param {object} outbound 统一出站消息（meta 中可带 groupId/channelId）
 * @param {{msgSeq?: number}} [options]
 */
export function buildQQReplyPayload(outbound, options = {}) {
  if (!isPlainObject(outbound) || typeof outbound.text !== 'string' || outbound.text.trim().length === 0) {
    throw new IMAdapterError('invalid_outbound', 'QQ 回复缺少文本内容')
  }
  const text = outbound.text.trim()
  const meta = isPlainObject(outbound.meta) ? outbound.meta : {}
  const msgSeq = Number.isInteger(options.msgSeq) ? options.msgSeq : undefined
  const replyTo = typeof outbound.replyTo === 'string' && outbound.replyTo ? outbound.replyTo : undefined
  if (typeof meta.groupId === 'string' && meta.groupId) {
    const body = { content: text, msg_type: 0 }
    if (replyTo) body.msg_id = replyTo
    if (msgSeq !== undefined) body.msg_seq = msgSeq
    return { endpoint: `/v2/groups/${encodeURIComponent(meta.groupId)}/messages`, method: 'POST', body }
  }
  if (typeof meta.channelId === 'string' && meta.channelId) {
    const body = { content: text }
    if (replyTo) body.msg_id = replyTo
    return { endpoint: `/channels/${encodeURIComponent(meta.channelId)}/messages`, method: 'POST', body }
  }
  const body = { content: text, msg_type: 0 }
  if (replyTo) body.msg_id = replyTo
  if (msgSeq !== undefined) body.msg_seq = msgSeq
  return { endpoint: `/v2/users/${encodeURIComponent(outbound.userId)}/messages`, method: 'POST', body }
}

/** 生成 QQ 富媒体消息体（上传后引用 file_info）。 */
export function buildQQMediaPayload(outbound, fileInfo, options = {}) {
  if (!isPlainObject(outbound)) throw new IMAdapterError('invalid_outbound', 'QQ 媒体回复缺少消息对象')
  if (typeof fileInfo !== 'string' || !fileInfo) throw new IMAdapterError('invalid_media', 'QQ 媒体回复缺少 file_info')
  const meta = isPlainObject(outbound.meta) ? outbound.meta : {}
  const body = { msg_type: 7, media: { file_info: fileInfo } }
  if (typeof outbound.replyTo === 'string' && outbound.replyTo) body.msg_id = outbound.replyTo
  if (Number.isInteger(options.msgSeq)) body.msg_seq = options.msgSeq
  if (typeof meta.groupId === 'string' && meta.groupId) {
    return { endpoint: `/v2/groups/${encodeURIComponent(meta.groupId)}/messages`, method: 'POST', body }
  }
  return { endpoint: `/v2/users/${encodeURIComponent(outbound.userId)}/messages`, method: 'POST', body }
}

/** 把出站消息映射成 QQ 的发送目标。 */
function destinationFor(outbound, channel = 'qq') {
  const meta = isPlainObject(outbound.meta) ? outbound.meta : {}
  if (typeof meta.groupId === 'string' && meta.groupId) {
    return {
      kind: 'group',
      id: meta.groupId,
      base: `/v2/groups/${encodeURIComponent(meta.groupId)}`,
      messages: `/v2/groups/${encodeURIComponent(meta.groupId)}/messages`,
      files: `/v2/groups/${encodeURIComponent(meta.groupId)}/files`,
    }
  }
  if (typeof meta.channelId === 'string' && meta.channelId) {
    return {
      kind: 'channel',
      id: meta.channelId,
      base: `/channels/${encodeURIComponent(meta.channelId)}`,
      messages: `/channels/${encodeURIComponent(meta.channelId)}/messages`,
      files: undefined,
    }
  }
  return {
    kind: 'c2c',
    id: String(outbound.userId),
    base: `/v2/users/${encodeURIComponent(outbound.userId)}`,
    messages: `/v2/users/${encodeURIComponent(outbound.userId)}/messages`,
    files: `/v2/users/${encodeURIComponent(outbound.userId)}/files`,
  }
}

/** 默认 WebSocket（Node 22+ / Electron 主进程均可用）。 */
function defaultSocketFactory(url) {
  const WebSocketImpl = globalThis.WebSocket
  if (typeof WebSocketImpl !== 'function') {
    throw new IMAdapterError('websocket_unavailable', '当前运行环境没有 WebSocket（需要 Node 22+ 或 Electron 主进程）')
  }
  return new WebSocketImpl(url)
}

/** 兼容浏览器 / Node 两种 socket 事件 API。 */
function addSocketListener(socket, type, handler) {
  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(type, handler)
    return
  }
  if (typeof socket?.on === 'function') {
    socket.on(type, type === 'message' ? (data) => handler({ data }) : handler)
  }
}

/** 去掉末尾斜杠后拼接 API 路径。 */
function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/u, '')}/${String(path).replace(/^\/+/u, '')}`
}

/** 文本超过 QQ 单条上限时保守截断。 */
function clipText(text, maxChars = QQ_BOT_MAX_TEXT_CHARS) {
  const value = String(text ?? '').trim()
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(1, maxChars - 1))}…`
}

function jsonResponse(response) {
  if (!response) return undefined
  if (typeof response.json === 'function') return response.json()
  return undefined
}

/** QQ 官方机器人适配器：token + WebSocket 网关 + OpenAPI 发送。 */
export class QQBotAdapter extends IMAdapter {
  /**
   * @param {object} config
   * @param {string} config.appId
   * @param {string} config.clientSecret
   * @param {boolean} [config.sandbox]
   * @param {number} [config.intents]
   * @param {string} [config.baseUrl]
   * @param {string} [config.tokenUrl]
   * @param {Function} [config.fetchImpl] 测试注入
   * @param {Function} [config.socketFactory] 测试注入
   */
  constructor(config = {}) {
    super({ ...config, channel: 'qq' })
    const normalized = normalizeQQBotConfig(config)
    this._qq = {
      ...normalized,
      reconnectMinMs: Number.isFinite(config.reconnectMinMs) ? Math.max(500, config.reconnectMinMs) : 1000,
      reconnectMaxMs: Number.isFinite(config.reconnectMaxMs) ? Math.max(1000, config.reconnectMaxMs) : 30000,
      requestTimeoutMs: Number.isFinite(config.requestTimeoutMs) ? Math.max(1000, config.requestTimeoutMs) : 15000,
      connectTimeoutMs: Number.isFinite(config.connectTimeoutMs) ? Math.max(1000, config.connectTimeoutMs) : 12000,
      fetchImpl: typeof config.fetchImpl === 'function' ? config.fetchImpl : undefined,
      socketFactory: typeof config.socketFactory === 'function' ? config.socketFactory : defaultSocketFactory,
    }
    this._validation = validateQQBotConfig(config)
    this._accessToken = undefined
    this._tokenExpiresAt = 0
    this._gatewayUrl = undefined
    this._ws = undefined
    this._sessionId = undefined
    this._seq = undefined
    this._heartbeatTimer = undefined
    this._heartbeatIntervalMs = 45000
    this._lastHeartbeatAckAt = 0
    this._reconnectTimer = undefined
    this._reconnectDelay = this._qq.reconnectMinMs
    this._closed = true
    this._openPromise = undefined
    this._readyPromise = undefined
    this._readyResolve = undefined
    this._readyReject = undefined
    this._readyTimer = undefined
    this._seqMap = new Map()
  }

  get channel() {
    return 'qq'
  }

  /** 官方的被动回复条数 / 单条长度能力，供 qq-host 拆分气泡。 */
  get maxBubblesPerReply() {
    return QQ_BOT_MAX_BUBBLES
  }

  get maxCharsPerBubble() {
    return QQ_BOT_MAX_BUBBLE_CHARS
  }

  /** 官方平台自 2025-04 起下线主动消息。 */
  get supportsProactive() {
    return false
  }

  get supportsAttention() {
    return false
  }

  /** @returns {{ ok: boolean, errors: string[] }} */
  validateConfig() {
    return { ok: this._validation.ok, errors: [...this._validation.errors] }
  }

  /** 当前 API 基座（沙箱 / 正式）。 */
  get apiBaseUrl() {
    if (this._qq.sandbox) return QQ_BOT_SANDBOX_API_BASE
    return this._qq.baseUrl || QQ_BOT_API_BASE
  }

  status() {
    return {
      ...super.status(),
      transport: 'qqbot',
      displayName: 'QQ 官方机器人',
      appId: this._qq.appId || undefined,
      sandbox: this._qq.sandbox,
      intents: this._qq.intents,
      gateway: this._gatewayUrl,
      sessionActive: Boolean(this._sessionId),
      tokenExpiresAt: this._tokenExpiresAt > 0 ? new Date(this._tokenExpiresAt).toISOString() : undefined,
      heartbeatIntervalMs: this._heartbeatIntervalMs,
      supportsProactive: this.supportsProactive,
      supportsAttention: this.supportsAttention,
    }
  }

  async start(handlers) {
    await super.start(handlers)
    if (!this._validation.ok) {
      this._state = 'awaiting_config'
      this._lastError = this._validation.errors.join('；')
      return this.status()
    }
    this._closed = false
    this._state = 'starting'
    try {
      await this.#bootstrap()
    } catch (error) {
      if (this._closed) {
        this._state = 'stopped'
        return this.status()
      }
      this._lastError = error?.message ?? String(error)
      this._state = 'failed'
      this.#scheduleReconnect(error)
    }
    return this.status()
  }

  async stop() {
    this._closed = true
    this.#clearReconnect()
    this.#stopHeartbeat()
    this.#failReady(new IMAdapterError('adapter_stopped', 'QQ 官方机器人连接已停止'))
    const socket = this._ws
    this._ws = undefined
    try {
      socket?.close?.()
    } catch {
      // ignore
    }
    this._state = 'stopped'
    return this.status()
  }

  /** 网关 dispatch 帧入口：解析成功则交给 onMessage 回调。 */
  handleGatewayFrame(frame, options = {}) {
    const inbound = parseQQGatewayFrame(frame, { adapterId: this.id, ...options })
    if (!inbound) return undefined
    this._emitInbound(inbound)
    return inbound
  }

  /** 生成 QQ v2 回复体。 */
  buildReplyPayload(outbound, options = {}) {
    return buildQQReplyPayload(outbound, options)
  }

  // ───────────────────────────── 连接 / 网关 ─────────────────────────────

  #fetchImpl() {
    const fetchImpl = this._qq.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new IMAdapterError('fetch_unavailable', '当前运行环境没有 fetch，无法连接 QQ 官方 API')
    }
    return fetchImpl
  }

  async #bootstrap() {
    if (this._closed) return
    await this.#ensureAccessToken()
    const gateway = await this.#fetchGatewayUrl()
    await this.#connect(gateway)
  }

  async #fetchGatewayUrl() {
    const data = await this.#apiRequest('GET', '/gateway')
    const url = typeof data?.url === 'string' ? data.url : ''
    if (!url) throw new IMAdapterError('qq_gateway_invalid', 'QQ 网关没有返回 WebSocket 地址')
    this._gatewayUrl = url
    return url
  }

  async #connect(gatewayUrl) {
    if (this._closed) return
    const ready = this.#waitForReady()
    // 如果 socket 打开阶段就失败，ready 稍后可能因超时 rejection；附一个处理函数避免未处理拒绝。
    ready.catch(() => {})
    const opened = this.#openSocket(gatewayUrl)
    try {
      await opened
      await ready
    } catch (error) {
      this.#failReady(error)
      throw error
    }
  }

  #waitForReady() {
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve
      this._readyReject = reject
    })
    this._readyTimer = setTimeout(() => {
      this.#failReady(new IMAdapterError('qq_ready_timeout', 'QQ 网关鉴权超时'))
    }, this._qq.connectTimeoutMs)
    this._readyTimer.unref?.()
    return this._readyPromise
  }

  #markReady() {
    if (this._readyTimer !== undefined) {
      clearTimeout(this._readyTimer)
      this._readyTimer = undefined
    }
    this._state = 'running'
    this._lastError = undefined
    this._reconnectDelay = this._qq.reconnectMinMs
    const resolve = this._readyResolve
    this._readyResolve = undefined
    this._readyReject = undefined
    resolve?.()
  }

  #failReady(error) {
    if (this._readyTimer !== undefined) {
      clearTimeout(this._readyTimer)
      this._readyTimer = undefined
    }
    const reject = this._readyReject
    this._readyResolve = undefined
    this._readyReject = undefined
    reject?.(error)
  }

  async #openSocket(url) {
    const socket = this._qq.socketFactory(url)
    this._ws = socket
    await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          socket?.close?.()
        } catch {
          // ignore
        }
        reject(new IMAdapterError('qq_ws_timeout', `连接 QQ 网关超时（${url}）`))
      }, this._qq.connectTimeoutMs)
      timer.unref?.()
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      addSocketListener(socket, 'open', () => {
        this.#attachSocketReaders(socket)
        finish()
      })
      addSocketListener(socket, 'error', (event) => {
        const message = event?.message ?? event?.error?.message ?? 'QQ 网关 WebSocket 错误'
        this._lastError = message
        if (!settled) finish(new IMAdapterError('qq_ws_error', message))
      })
      addSocketListener(socket, 'close', (event) => {
        const code = event?.code ?? '?'
        const error = new IMAdapterError('qq_ws_closed', `QQ 网关连接已断开（code=${code}）`)
        if (!settled) finish(error)
        this.#onSocketClosed(socket, error)
      })
    })
  }

  #attachSocketReaders(socket) {
    addSocketListener(socket, 'message', (event) => {
      if (this._ws !== socket) return
      let data = event?.data
      if (typeof data !== 'string') {
        try {
          data = data === undefined ? undefined : String(data)
        } catch {
          data = undefined
        }
      }
      if (typeof data !== 'string' || !data) return
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        return
      }
      this.#handlePayload(payload)
    })
    addSocketListener(socket, 'close', (event) => {
      const code = event?.code ?? '?'
      this.#onSocketClosed(socket, new IMAdapterError('qq_ws_closed', `QQ 网关连接已断开（code=${code}）`))
    })
    addSocketListener(socket, 'error', (event) => {
      this._lastError = event?.message ?? event?.error?.message ?? 'QQ 网关 WebSocket 错误'
    })
  }

  #onSocketClosed(socket, error) {
    if (this._ws !== socket) return
    this._ws = undefined
    this.#stopHeartbeat()
    this.#failReady(error)
    if (this._closed) return
    this._lastError = error?.message ?? String(error)
    this._state = 'failed'
    this.#scheduleReconnect(error)
  }

  #sendPayload(payload) {
    const socket = this._ws
    if (!socket || typeof socket.send !== 'function') return false
    try {
      socket.send(JSON.stringify(payload))
      return true
    } catch (error) {
      this._lastError = error?.message ?? String(error)
      return false
    }
  }

  async #handlePayload(payload) {
    if (!isPlainObject(payload)) return
    if (Number.isFinite(payload.s)) this._seq = payload.s
    switch (payload.op) {
      case 10: {
        const interval = Number(payload.d?.heartbeat_interval)
        if (Number.isFinite(interval) && interval >= 1000) this._heartbeatIntervalMs = interval
        await this.#sendAuth()
        break
      }
      case 11:
        this._lastHeartbeatAckAt = Date.now()
        break
      case 0:
        this.#handleDispatch(payload)
        break
      case 7:
        this.#reconnect('QQ 网关要求重新连接')
        break
      case 9:
        this._sessionId = undefined
        this._seq = undefined
        this.#reconnect('QQ 会话失效，需要重新 Identify')
        break
      default:
        break
    }
  }

  #handleDispatch(payload) {
    if (typeof payload.t !== 'string') return
    if (payload.t === 'READY') {
      this._sessionId = typeof payload.d?.session_id === 'string' ? payload.d.session_id : this._sessionId
      this.#markReady()
      return
    }
    if (payload.t === 'RESUMED') {
      this.#markReady()
      return
    }
    if (!QQ_MESSAGE_EVENTS.includes(payload.t)) return
    const inbound = parseQQGatewayFrame(payload, { adapterId: this.id })
    if (inbound) this._emitInbound(inbound)
  }

  async #sendAuth() {
    if (this._closed) return
    try {
      const token = await this.#ensureAccessToken()
      if (this._closed) return
      if (this._sessionId && this._seq !== undefined) {
        this.#sendPayload({
          op: 6,
          d: { token: `QQBot ${token}`, session_id: this._sessionId, seq: this._seq },
        })
      } else {
        this.#sendPayload({
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: this._qq.intents,
            shard: [0, 1],
            properties: { $os: 'linux', $browser: 'dsh-companion', $device: 'dsh-companion' },
          },
        })
      }
      this.#startHeartbeat()
    } catch (error) {
      this._lastError = error?.message ?? String(error)
      this.#failReady(error)
      this.#reconnect(`QQ 网关鉴权失败：${this._lastError}`)
    }
  }

  #startHeartbeat() {
    this.#stopHeartbeat()
    this._lastHeartbeatAckAt = Date.now()
    this._heartbeatTimer = setInterval(() => {
      if (!this._ws) return
      if (Date.now() - this._lastHeartbeatAckAt > this._heartbeatIntervalMs * 2.5) {
        this.#reconnect('QQ 网关心跳超时')
        return
      }
      this.#sendPayload({ op: 1, d: this._seq ?? null })
    }, this._heartbeatIntervalMs)
    this._heartbeatTimer.unref?.()
  }

  #stopHeartbeat() {
    if (this._heartbeatTimer !== undefined) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = undefined
    }
  }

  #reconnect(reason) {
    if (this._closed) return
    this._lastError = reason
    this._state = 'failed'
    this.#failReady(new IMAdapterError('qq_reconnect', reason))
    this.#stopHeartbeat()
    const socket = this._ws
    this._ws = undefined
    try {
      socket?.close?.()
    } catch {
      // ignore
    }
    this.#scheduleReconnect(new Error(reason))
  }

  #scheduleReconnect(error) {
    if (this._closed || this._reconnectTimer !== undefined) return
    const delay = this._reconnectDelay
    this._reconnectDelay = Math.min(this._qq.reconnectMaxMs, Math.round(this._reconnectDelay * 1.8))
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = undefined
      this.#bootstrap().catch((cause) => {
        this._lastError = cause?.message ?? String(cause)
        this._state = 'failed'
        this.#scheduleReconnect(cause)
      })
    }, delay)
    this._reconnectTimer.unref?.()
  }

  #clearReconnect() {
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = undefined
    }
  }

  // ───────────────────────────── access_token / OpenAPI ─────────────────────────────

  async #ensureAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpiresAt - 300_000) return this._accessToken
    const payload = { appId: this._qq.appId, clientSecret: this._qq.clientSecret }
    const urls = [this._qq.tokenUrl || QQ_BOT_TOKEN_URL, QQ_BOT_TOKEN_URL_FALLBACK].filter(
      (url, index, list) => url && list.indexOf(url) === index,
    )
    let lastError
    for (const url of urls) {
      try {
        const response = await this.#fetchWithTimeout(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await jsonResponse(response)
        if (!response?.ok || !data?.access_token) {
          lastError = new IMAdapterError(
            'qq_token_failed',
            `QQ access_token 获取失败（HTTP ${response?.status ?? '?'} ${data?.message ?? ''}）`.trim(),
          )
          continue
        }
        const expiresIn = Number(data.expires_in)
        this._accessToken = String(data.access_token)
        this._tokenExpiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200) * 1000
        return this._accessToken
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new IMAdapterError('qq_token_failed', 'QQ access_token 获取失败')
  }

  async #fetchWithTimeout(url, init = {}) {
    const fetchImpl = this.#fetchImpl()
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = controller
      ? setTimeout(() => controller.abort(), this._qq.requestTimeoutMs)
      : undefined
    timer?.unref?.()
    try {
      return await fetchImpl(url, { ...init, ...(controller ? { signal: controller.signal } : {}) })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async #apiRequest(method, path, body, options = {}) {
    const token = await this.#ensureAccessToken()
    const url = joinUrl(this.apiBaseUrl, path)
    const response = await this.#fetchWithTimeout(url, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data = await jsonResponse(response)
    if (response?.status === 401 && !options.retried) {
      this._accessToken = undefined
      this._tokenExpiresAt = 0
      return this.#apiRequest(method, path, body, { ...options, retried: true })
    }
    if (!response?.ok || (typeof data?.code === 'number' && data.code !== 0 && data.id === undefined)) {
      const code = data?.code !== undefined ? ` code=${data.code}` : ''
      throw new IMAdapterError(
        'qq_api_error',
        `${method} ${path} 失败（HTTP ${response?.status ?? '?'}${code} ${data?.message ?? ''}）`.trim(),
      )
    }
    return data
  }

  // ───────────────────────────── 发送 ─────────────────────────────

  #nextSeq(replyTo) {
    const key = String(replyTo)
    const now = Date.now()
    for (const [id, entry] of this._seqMap) {
      if (now - entry.at > 10 * 60_000) this._seqMap.delete(id)
    }
    const current = this._seqMap.get(key)
    const next = (current?.seq ?? 0) + 1
    this._seqMap.set(key, { seq: next, at: now })
    return next
  }

  async #sendPayloadFor(outbound, destination, body, path = destination.messages) {
    const data = await this.#apiRequest('POST', path, body)
    return { path, data }
  }

  async #uploadImage(destination, image) {
    if (!destination.files) {
      throw new IMAdapterError('qq_media_unsupported', 'QQ 频道消息暂不支持本地图片上传')
    }
    const body = { file_type: 1, srv_send_msg: false }
    if (/^https?:\/\//iu.test(image)) {
      body.url = image
    } else {
      const bytes = fs.readFileSync(image)
      body.file_data = bytes.toString('base64')
    }
    const data = await this.#apiRequest('POST', destination.files, body)
    const fileInfo = typeof data?.file_info === 'string' ? data.file_info : ''
    if (!fileInfo) throw new IMAdapterError('qq_media_upload_failed', 'QQ 富媒体上传没有返回 file_info')
    return fileInfo
  }

  async send(outbound) {
    if (!this._validation.ok) {
      return { delivered: false, reason: 'invalid_config', errors: [...this._validation.errors] }
    }
    if (this._state !== 'running') {
      throw new IMAdapterError('qqbot_not_connected', 'QQ 官方机器人尚未连接')
    }
    if (!isPlainObject(outbound)) throw new IMAdapterError('invalid_outbound', '出站消息必须是对象')
    const replyTo =
      typeof outbound.replyTo === 'string' && outbound.replyTo
        ? outbound.replyTo
        : typeof outbound.meta?.eventId === 'string' && outbound.meta.eventId
          ? outbound.meta.eventId
          : undefined
    if (!replyTo) {
      throw new IMAdapterError('qqbot_passive_reply_required', 'QQ 官方机器人只能被动回复，必须带触发消息的 msg_id')
    }
    const destination = destinationFor(outbound)
    const images = Array.isArray(outbound.images)
      ? outbound.images.filter((value) => typeof value === 'string' && value.trim())
      : []
    const responses = []
    const text = clipText(outbound.text)
    if (text) {
      const body = {
        content: text,
        msg_type: 0,
        msg_id: replyTo,
        msg_seq: this.#nextSeq(replyTo),
      }
      if (destination.kind === 'channel') {
        delete body.msg_type
        delete body.msg_seq
      }
      const result = await this.#sendPayloadFor(outbound, destination, body)
      responses.push(result)
    }
    for (const image of images) {
      const fileInfo = await this.#uploadImage(destination, image)
      const body = {
        msg_type: 7,
        media: { file_info: fileInfo },
        msg_id: replyTo,
        msg_seq: this.#nextSeq(replyTo),
      }
      if (destination.kind === 'channel') {
        throw new IMAdapterError('qq_media_unsupported', 'QQ 频道消息暂不支持本地图片上传')
      }
      const result = await this.#sendPayloadFor(outbound, destination, body)
      responses.push(result)
    }
    return {
      delivered: true,
      id: responses.at(-1)?.data?.id,
      responses: responses.map((entry) => entry.data),
    }
  }
}
