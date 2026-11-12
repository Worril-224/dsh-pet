/**
 * IM 适配器抽象：统一入站/出站消息结构与适配器生命周期。
 *
 * 目标是为 QQ Bot 等外部聊天渠道预留稳定接口：未来的适配器只需实现
 * start(handlers) / send(outbound) 两个网络动作，其余记忆写入、人设注入、
 * 上下文组装由 CompanionIMBridge（registry.js）完成。
 */

/** 适配器状态枚举。 */
export const IM_STATES = ['created', 'starting', 'running', 'awaiting_config', 'awaiting_network_layer', 'stopped', 'failed']

/** 适配器错误：code 是稳定的可判断标识。 */
export class IMAdapterError extends Error {
  /**
   * @param {string} code 稳定错误码
   * @param {string} message 中文说明
   */
  constructor(code, message) {
    super(message)
    this.name = 'IMAdapterError'
    this.code = code
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把厂商原始消息统一为 Inbound。
 * @param {object} raw 至少包含 text；可选 id/userId/userName/receivedAt/channel/adapterId
 * @returns {{ id: string, channel: string, adapterId: string, userId: string, userName?: string,
 *   text: string, receivedAt: number, raw?: unknown }}
 */
export function normalizeInbound(raw) {
  if (!isPlainObject(raw)) throw new IMAdapterError('invalid_inbound', '入站消息必须是对象')
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!text) throw new IMAdapterError('invalid_inbound', '入站消息缺少文本内容')
  const userId = typeof raw.userId === 'string' && raw.userId ? raw.userId : typeof raw.user_id === 'string' ? raw.user_id : undefined
  if (!userId) throw new IMAdapterError('invalid_inbound', '入站消息缺少 userId')
  const channel = typeof raw.channel === 'string' && raw.channel ? raw.channel : 'unknown'
  const adapterId = typeof raw.adapterId === 'string' && raw.adapterId ? raw.adapterId : `${channel}:default`
  const receivedAt = Number.isFinite(raw.receivedAt) ? Number(raw.receivedAt) : Date.now()
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `${adapterId}:${receivedAt}:${Math.random().toString(16).slice(2, 8)}`
  const inbound = { id, channel, adapterId, userId, text, receivedAt }
  if (typeof raw.userName === 'string' && raw.userName) inbound.userName = raw.userName
  if (raw.raw !== undefined) inbound.raw = raw.raw
  if (isPlainObject(raw.meta)) inbound.meta = { ...raw.meta }
  return inbound
}

/**
 * 创建统一出站消息。
 * @param {{ text: string, userId: string, channel?: string, adapterId?: string,
 *   replyTo?: string, sessionId?: string, images?: string[], meta?: object }} input
 */
export function createOutbound(input = {}) {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text) throw new IMAdapterError('invalid_outbound', '出站消息缺少文本内容')
  const userId = typeof input.userId === 'string' ? input.userId : undefined
  if (!userId) throw new IMAdapterError('invalid_outbound', '出站消息缺少 userId')
  const channel = typeof input.channel === 'string' && input.channel ? input.channel : 'unknown'
  const adapterId = typeof input.adapterId === 'string' && input.adapterId ? input.adapterId : `${channel}:default`
  const images = Array.isArray(input.images)
    ? input.images.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
    : []
  const outbound = {
    id: `${adapterId}:out:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    channel,
    adapterId,
    userId,
    text,
    createdAt: Date.now(),
  }
  if (images.length > 0) outbound.images = images
  if (typeof input.replyTo === 'string' && input.replyTo) outbound.replyTo = input.replyTo
  if (typeof input.sessionId === 'string' && input.sessionId) outbound.sessionId = input.sessionId
  if (isPlainObject(input.meta)) outbound.meta = { ...input.meta }
  return outbound
}

/**
 * IM 适配器基类：状态机 + 入站回调注册。子类实现具体网络收发。
 */
export class IMAdapter {
  /**
   * @param {object} config 适配器配置
   * @param {string} [config.id] 适配器实例 id
   * @param {string} [config.channel] 渠道名，默认子类覆盖
   */
  constructor(config = {}) {
    this._config = { ...config }
    this._state = 'created'
    this._lastError = undefined
    this._handlers = undefined
    this._id = typeof config.id === 'string' && config.id ? config.id : `${this.channel}:${Math.random().toString(16).slice(2, 8)}`
  }

  /** 适配器实例 id。 */
  get id() {
    return this._id
  }

  /** 渠道名；子类必须覆盖。 */
  get channel() {
    return 'unknown'
  }

  /** 当前状态。 */
  get state() {
    return this._state
  }

  /** 状态快照。 */
  status() {
    const status = { id: this.id, channel: this.channel, state: this._state }
    if (this._lastError) status.lastError = this._lastError
    return status
  }

  /**
   * 启动适配器并注册入站回调。
   * @param {{ onMessage: (inbound: object) => unknown, onNotice?: (notice: object) => unknown }} handlers
   */
  async start(handlers) {
    if (!handlers || typeof handlers.onMessage !== 'function') {
      throw new IMAdapterError('invalid_handlers', 'start 需要 { onMessage } 回调')
    }
    this._handlers = handlers
    this._state = 'running'
    return this.status()
  }

  /** 停止适配器；之后不再派发入站消息。 */
  async stop() {
    this._handlers = undefined
    this._state = 'stopped'
    return this.status()
  }

  /**
   * 发送出站消息；子类实现网络动作。
   * @param {object} outbound
   */
  async send(outbound) {
    throw new IMAdapterError('not_implemented', `${this.channel} 适配器尚未实现 send()`)
  }

  /** 子类在收到合法入站消息时调用，转交 onMessage。 */
  _emitInbound(inbound) {
    if (!this._handlers || typeof this._handlers.onMessage !== 'function') return undefined
    return this._handlers.onMessage(inbound)
  }

  /** 子类在收到通知事件（如「对方正在输入」）时调用，转交 onNotice。 */
  _emitNotice(notice) {
    if (!this._handlers || typeof this._handlers.onNotice !== 'function') return undefined
    return this._handlers.onNotice(notice)
  }
}
