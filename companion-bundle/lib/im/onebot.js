/**
 * OneBot 11 适配器（用于 NapCat / Lagrange 等本地 QQ 桥）。
 *
 * 支持：
 *  - 接收 WebSocket 事件流（`post_type = message`，私聊 / 群聊 @）；
 *  - 统一 Inbound 结构（复用 adapter.js 的 normalizeInbound）；
 *  - 通过 WebSocket action 发送私聊 / 群聊消息（send_private_msg / send_group_msg），
 *    群聊回复自动带 @；
 *  - 断线重连、access_token 查询参数、action echo 关联与超时。
 *
 * 注意：OneBot 11 是非官方 QQ 协议桥，存在账号风险，建议使用专用小号。
 */
import { IMAdapter, IMAdapterError, normalizeInbound } from './adapter.js'
import { faceName } from './qq-face.js'

/** OneBot 11 消息事件。 */
export const ONEBOT_MESSAGE_POST_TYPE = 'message'

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 OneBot 的 message 字段（字符串或段数组）统一成段数组。 */
export function normalizeSegments(message) {
  if (Array.isArray(message)) {
    return message.filter((segment) => isObject(segment) && typeof segment.type === 'string')
  }
  if (typeof message === 'string') {
    // 解析 [CQ:type,key=value,...] 形式
    const segments = []
    const regex = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g
    let last = 0
    let match
    while ((match = regex.exec(message)) !== null) {
      if (match.index > last) segments.push({ type: 'text', data: { text: message.slice(last, match.index) } })
      const data = {}
      for (const pair of match[2].replace(/^,/, '').split(',')) {
        const index = pair.indexOf('=')
        if (index < 0) continue
        const key = pair.slice(0, index)
        const value = pair.slice(index + 1).replaceAll('&#44;', ',').replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&amp;', '&')
        data[key] = value
      }
      segments.push({ type: match[1], data })
      last = match.index + match[0].length
    }
    if (last < message.length) segments.push({ type: 'text', data: { text: message.slice(last) } })
    return segments
  }
  return []
}

/** 段数组里的纯文本。 */
export function segmentsText(segments) {
  return segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => String(segment.data?.text ?? ''))
    .join('')
}

/** 是否 @ 了机器人。 */
export function isMentionedBot(segments, selfId) {
  return segments.some(
    (segment) => segment.type === 'at' && segment.data && String(segment.data.qq ?? segment.data.user_id ?? '') === String(selfId),
  )
}

/** 去掉消息里的 @机器人 段与 CQ at 文本。 */
export function stripMention(segments, selfId) {
  const cleaned = []
  for (const segment of segments) {
    if (segment.type === 'at' && segment.data && String(segment.data.qq ?? segment.data.user_id ?? '') === String(selfId)) continue
    if (segment.type === 'text') {
      const text = String(segment.data?.text ?? '')
      cleaned.push({ type: 'text', data: { text: text.replace(/\[CQ:at,qq=\d+\]/g, '').replace(/^\s+/, '') } })
      continue
    }
    cleaned.push(segment)
  }
  return cleaned
}

/**
 * 从消息段中提取图片/表情包附件元数据（供视觉识别使用）。
 * image 段与带图的 mface（商城表情）都会收集 url/file/path。
 * @param {object[]} segments
 * @returns {object[]}
 */
export function extractImageAttachments(segments) {
  const images = []
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || (segment.type !== 'image' && segment.type !== 'mface')) continue
    const data = isObject(segment.data) ? segment.data : {}
    const url = typeof data.url === 'string' && data.url ? data.url : undefined
    const file = typeof data.file === 'string' && data.file ? data.file : undefined
    const localPath = typeof data.path === 'string' && data.path ? data.path : undefined
    if (!url && !file && !localPath) continue
    images.push({
      kind: segment.type,
      ...(url ? { url } : {}),
      ...(file ? { file } : {}),
      ...(localPath ? { path: localPath } : {}),
      ...(typeof data.summary === 'string' && data.summary ? { summary: data.summary } : {}),
      ...(data.sub_type !== undefined ? { subType: String(data.sub_type) } : {}),
      ...(Number.isFinite(Number(data.file_size)) ? { fileSize: Number(data.file_size) } : {}),
    })
  }
  return images
}

/**
 * 提取 QQ 内置表情（face / 无图 mface）名称，供文字提示使用。
 * @param {object[]} segments
 * @returns {string[]}
 */
export function extractFaceNames(segments) {
  const names = []
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || (segment.type !== 'face' && segment.type !== 'mface')) continue
    const data = isObject(segment.data) ? segment.data : {}
    if (segment.type === 'mface' && (data.url || data.file || data.path)) continue
    if (segment.type === 'face') {
      names.push(faceName(data.id ?? data.face_id ?? data.faceId))
    } else if (typeof data.summary === 'string' && data.summary.trim()) {
      names.push(data.summary.trim())
    }
  }
  return names
}

/**
 * 解析 OneBot 通知事件：目前支持 NapCat 的「对方正在输入」input_status。
 * 事件示例：
 * { post_type:'notice', notice_type:'notify', sub_type:'input_status',
 *   user_id: 10001, event_type: 1, status_text: '对方正在输入...' }
 * @param {object} event
 * @param {{ selfId?: string|number, adapterId?: string }} [options]
 * @returns {{ type: 'input_status', userId: string, isTyping: boolean, eventType: number, statusText: string, at: number, raw: object } | undefined}
 */
export function parseOneBotNoticeEvent(event, options = {}) {
  if (!isObject(event) || event.post_type !== 'notice') return undefined
  if (event.notice_type !== 'notify' || event.sub_type !== 'input_status') return undefined
  const selfId = options.selfId !== undefined ? String(options.selfId) : String(event.self_id ?? '')
  const userId = event.user_id !== undefined ? String(event.user_id) : ''
  if (!userId) return undefined
  if (selfId && userId === selfId) return undefined
  const eventType = Number.isFinite(Number(event.event_type)) ? Number(event.event_type) : 1
  const statusText = typeof event.status_text === 'string' ? event.status_text : ''
  // NapCat 的 eventType=1 通常表示开始输入；包含「正在输入」也按输入中处理。
  const isTyping = eventType === 1 || statusText.includes('正在输入')
  return {
    type: 'input_status',
    userId,
    isTyping,
    eventType,
    statusText,
    at: Number.isFinite(event.time) ? Number(event.time) * 1000 : Date.now(),
    raw: event,
  }
}

/**
 * 把 OneBot 事件解析成统一 Inbound。
 * @param {object} event OneBot 11 事件
 * @param {{ selfId?: string|number, adapterId?: string }} [options]
 * @returns {object|undefined} Inbound；非消息事件 / bot 自己 / 群聊未 @ / 空文本返回 undefined
 */
export function parseOneBotMessageEvent(event, options = {}) {
  if (!isObject(event) || event.post_type !== ONEBOT_MESSAGE_POST_TYPE) return undefined
  if (event.message_type !== 'private' && event.message_type !== 'group') return undefined
  const selfId = options.selfId !== undefined ? String(options.selfId) : String(event.self_id ?? '')
  const userId = event.user_id !== undefined ? String(event.user_id) : String(event.sender?.user_id ?? '')
  if (!userId) return undefined
  if (selfId && userId === selfId) return undefined // 自己发的消息不处理

  let segments = normalizeSegments(event.message)
  if ((event.message === undefined || event.message === null) && segments.length === 0) {
    segments = normalizeSegments(event.raw_message)
  }
  const isGroup = event.message_type === 'group'
  if (isGroup) {
    const mentioned = isMentionedBot(segments, selfId) || new RegExp(`\\[CQ:at,qq=${selfId}\\]`).test(String(event.raw_message ?? ''))
    if (!mentioned) return undefined
    segments = stripMention(segments, selfId)
  }
  const images = extractImageAttachments(segments)
  const faces = extractFaceNames(segments)
  const text = segmentsText(segments).replace(/\s+/g, ' ').trim()
  // 纯图片/纯表情消息也要交给回复引擎（视觉/表情识别）
  const fallbackText = text || (images.length > 0 ? '[图片]' : faces.length > 0 ? faces.map((name) => `[表情：${name}]`).join(' ') : '')
  if (!fallbackText) return undefined

  const receivedAt = Number.isFinite(event.time) ? Number(event.time) * 1000 : Date.now()
  const meta = { messageType: event.message_type, raw: event }
  if (isGroup && event.group_id !== undefined) meta.groupId = String(event.group_id)
  if (event.sender?.card || event.sender?.nickname) meta.senderName = String(event.sender.card || event.sender.nickname)
  if (images.length > 0) meta.images = images
  if (faces.length > 0) meta.faces = faces

  return normalizeInbound({
    id: event.message_id !== undefined ? String(event.message_id) : `onebot:${userId}:${receivedAt}:${Math.random().toString(16).slice(2, 8)}`,
    channel: 'qq',
    adapterId: options.adapterId,
    userId,
    userName: meta.senderName,
    text: fallbackText,
    receivedAt,
    meta,
    raw: event,
  })
}

/**
 * 生成 OneBot action（发送消息）。
 * @param {object} outbound 统一出站消息
 * @param {{ selfId?: string|number }} [options]
 * @returns {{ action: string, params: object }}
 */
export function buildOneBotSendAction(outbound, options = {}) {
  if (!isObject(outbound) || typeof outbound.text !== 'string' || outbound.text.trim() === '') {
    throw new IMAdapterError('invalid_outbound', 'OneBot 回复缺少文本内容')
  }
  const text = outbound.text.trim()
  const images = Array.isArray(outbound.images) ? outbound.images.filter((value) => typeof value === 'string' && value.trim()) : []
  const groupId = outbound.meta?.groupId
  if (groupId !== undefined && groupId !== null && String(groupId) !== '') {
    const mention = outbound.meta?.mention !== false
    const message = []
    if (mention && outbound.userId) {
      message.push({ type: 'at', data: { qq: Number.isFinite(Number(outbound.userId)) ? Number(outbound.userId) : String(outbound.userId) } })
    }
    message.push({ type: 'text', data: { text: `${mention && outbound.userId ? ' ' : ''}${text}` } })
    for (const image of images) message.push({ type: 'image', data: { file: image.trim() } })
    return {
      action: 'send_group_msg',
      params: {
        group_id: Number.isFinite(Number(groupId)) ? Number(groupId) : groupId,
        message,
      },
    }
  }
  return {
    action: 'send_private_msg',
    params: {
      user_id: Number.isFinite(Number(outbound.userId)) ? Number(outbound.userId) : String(outbound.userId),
      message: [{ type: 'text', data: { text } }, ...images.map((image) => ({ type: 'image', data: { file: image.trim() } }))],
    },
  }
}

/** 默认使用全局 WebSocket（Node 22+/Electron 均可用）；测试可注入 socketFactory。 */
function defaultSocketFactory(url) {
  const WebSocketImpl = globalThis.WebSocket
  if (typeof WebSocketImpl !== 'function') {
    throw new IMAdapterError('websocket_unavailable', '当前运行环境没有 WebSocket（需要 Node 22+ 或 Electron 主进程）')
  }
  return new WebSocketImpl(url)
}

/** OneBot 11 WebSocket 适配器。 */
export class OneBotAdapter extends IMAdapter {
  /**
   * @param {object} config
   * @param {string} config.url WebSocket 地址，如 ws://127.0.0.1:3001
   * @param {string} [config.accessToken] 可选 token（拼到 ?access_token=）
   * @param {string|number} config.selfId 机器人 QQ 号（用于过滤自己消息 / 群聊 @）
   * @param {number} [config.reconnectMinMs] 重连最小间隔
   * @param {number} [config.reconnectMaxMs] 重连最大间隔
   * @param {Function} [config.socketFactory] 测试用 socket 工厂
   */
  constructor(config = {}) {
    super({ ...config, channel: 'qq' })
    this._config = {
      url: typeof config.url === 'string' && config.url ? config.url : 'ws://127.0.0.1:3001',
      accessToken: typeof config.accessToken === 'string' ? config.accessToken : '',
      selfId: config.selfId !== undefined ? String(config.selfId) : '',
      reconnectMinMs: Number.isFinite(config.reconnectMinMs) ? Math.max(500, config.reconnectMinMs) : 1000,
      reconnectMaxMs: Number.isFinite(config.reconnectMaxMs) ? Math.max(1000, config.reconnectMaxMs) : 30000,
      actionTimeoutMs: Number.isFinite(config.actionTimeoutMs) ? Math.max(1000, config.actionTimeoutMs) : 10000,
      socketFactory: typeof config.socketFactory === 'function' ? config.socketFactory : defaultSocketFactory,
    }
    this._ws = undefined
    this._closed = true
    this._reconnectTimer = undefined
    this._reconnectDelay = this._config.reconnectMinMs
    this._pending = new Map()
    this._echo = 0
  }

  /** 渠道名。 */
  get channel() {
    return 'qq'
  }

  /** 当前连接所用的 URL（含 token 查询参数，token 不出现在 status 里）。 */
  _connectionUrl() {
    if (!this._config.accessToken) return this._config.url
    const separator = this._config.url.includes('?') ? '&' : '?'
    return `${this._config.url}${separator}access_token=${encodeURIComponent(this._config.accessToken)}`
  }

  async start(handlers) {
    await super.start(handlers)
    this._closed = false
    this._connect()
    return this.status()
  }

  async stop() {
    this._closed = true
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = undefined
    }
    for (const [echo, entry] of this._pending) {
      clearTimeout(entry.timer)
      entry.reject(new IMAdapterError('adapter_stopped', `OneBot action ${echo} 已取消`))
    }
    this._pending.clear()
    const ws = this._ws
    this._ws = undefined
    try {
      ws?.close()
    } catch {
      // ignore
    }
    this._state = 'stopped'
    return this.status()
  }

  _scheduleReconnect(error) {
    if (this._closed) return
    this._lastError = error?.message ?? String(error)
    this._state = 'failed'
    if (this._reconnectTimer !== undefined) return
    const delay = this._reconnectDelay
    this._reconnectDelay = Math.min(this._config.reconnectMaxMs, Math.round(this._reconnectDelay * 1.8))
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = undefined
      this._connect()
    }, delay)
    this._reconnectTimer.unref?.()
  }

  _connect() {
    if (this._closed) return
    this._state = 'starting'
    let socket
    try {
      socket = this._config.socketFactory(this._connectionUrl())
    } catch (error) {
      this._scheduleReconnect(error)
      return
    }
    this._ws = socket
    const onOpen = () => {
      if (this._ws !== socket) return
      this._state = 'running'
      this._lastError = undefined
      this._reconnectDelay = this._config.reconnectMinMs
    }
    const onClose = (event) => {
      if (this._ws !== socket) return
      this._ws = undefined
      this._scheduleReconnect(new Error(`OneBot WebSocket 已断开（code=${event?.code ?? '?'}）`))
    }
    const onError = (event) => {
      this._lastError = event?.message ?? 'OneBot WebSocket 错误'
    }
    const onMessage = (event) => {
      const data = typeof event?.data === 'string' ? event.data : undefined
      if (data === undefined) return
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        return
      }
      if (isObject(payload) && payload.echo !== undefined && this._pending.has(payload.echo)) {
        const entry = this._pending.get(payload.echo)
        this._pending.delete(payload.echo)
        clearTimeout(entry.timer)
        entry.resolve(payload)
        return
      }
      const inbound = parseOneBotMessageEvent(payload, { selfId: this._config.selfId, adapterId: this.id })
      if (inbound) {
        this._emitInbound(inbound)
        return
      }
      const notice = parseOneBotNoticeEvent(payload, { selfId: this._config.selfId, adapterId: this.id })
      if (notice) this._emitNotice(notice)
    }

    // 兼容浏览器风格 / Node 风格 socket 事件 API
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', onOpen)
      socket.addEventListener('close', onClose)
      socket.addEventListener('error', onError)
      socket.addEventListener('message', onMessage)
    } else if (typeof socket.on === 'function') {
      socket.on('open', onOpen)
      socket.on('close', onClose)
      socket.on('error', onError)
      socket.on('message', (data) => onMessage({ data: typeof data === 'string' ? data : String(data) }))
    }
  }

  /** 发送一个 OneBot action 并等待 echo 响应。 */
  _action(action, params) {
    const ws = this._ws
    if (!ws || this._state !== 'running') {
      return Promise.reject(new IMAdapterError('onebot_not_connected', `OneBot 未连接（${this._config.url}）`))
    }
    const echo = `dshpet-${Date.now()}-${++this._echo}`
    const payload = JSON.stringify({ action, params, echo })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo)
        reject(new IMAdapterError('onebot_action_timeout', `OneBot action ${action} 超时`))
      }, this._config.actionTimeoutMs)
      // 注意：不 unref 超时计时器——它代表一个正在等待的操作，必须让事件循环保持存活，
      // 否则进程/测试在事件循环空闲时会提前退出，promise 永远挂起。
      this._pending.set(echo, { resolve, reject, timer })
      try {
        if (typeof ws.send === 'function') ws.send(payload)
        else throw new Error('socket 不支持 send')
      } catch (error) {
        clearTimeout(timer)
        this._pending.delete(echo)
        reject(new IMAdapterError('onebot_send_failed', error?.message ?? String(error)))
      }
    })
  }

  async send(outbound) {
    const { action, params } = buildOneBotSendAction(outbound, { selfId: this._config.selfId })
    const response = await this._action(action, params)
    const ok = response?.status === 'ok' || response?.retcode === 0
    return {
      delivered: ok,
      reason: ok ? undefined : response?.wording ?? response?.message ?? 'onebot_send_failed',
      response,
    }
  }
}
