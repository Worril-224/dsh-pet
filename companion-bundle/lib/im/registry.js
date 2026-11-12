/**
 * CompanionIMBridge：把 IM 渠道接入陪伴系统的「最小闭环」。
 *
 * 设计目标：未来 QQ Bot 只需要
 *   1. 创建并 registerAdapter(new QQBotAdapter(config))
 *   2. startAll()
 *   3. 收到消息时适配器内部调用 handleInbound 流程（本轮由适配器 onMessage 注入）
 *   4. 把 handleInbound 返回的 context（人设段 + 记忆摘要）交给 LLM 生成回复
 *   5. dispatchReply(outbound) 发回渠道
 *
 * QQ 官方与 OneBot 适配器都实现了 send/start 网络动作；这条桥接链路可以被单元测试完整驱动。
 */
import { IMAdapter, IMAdapterError, createOutbound, normalizeInbound } from './adapter.js'

export class CompanionIMBridge {
  /**
   * @param {{ persona: any, memory: any, config?: { agentName?: string } }} deps
   */
  constructor({ persona, memory, config = {} }) {
    if (!persona || typeof persona.renderPersonaSection !== 'function') {
      throw new IMAdapterError('invalid_dependency', 'CompanionIMBridge 需要 persona 服务')
    }
    if (!memory || typeof memory.ingestMessage !== 'function') {
      throw new IMAdapterError('invalid_dependency', 'CompanionIMBridge 需要 memory 引擎')
    }
    this._persona = persona
    this._memory = memory
    this._config = { ...config }
    /** @type {Map<string, IMAdapter>} */
    this._adapters = new Map()
    this._started = false
  }

  /**
   * 注册适配器；返回注销函数。
   * @param {IMAdapter} adapter
   */
  registerAdapter(adapter) {
    if (!(adapter instanceof IMAdapter)) throw new IMAdapterError('invalid_adapter', '适配器必须是 IMAdapter 子类实例')
    if (this._adapters.has(adapter.id)) throw new IMAdapterError('duplicate_adapter', `适配器 id 重复：${adapter.id}`)
    this._adapters.set(adapter.id, adapter)
    return () => {
      if (this._adapters.get(adapter.id) === adapter) this._adapters.delete(adapter.id)
    }
  }

  /** 启动全部适配器。 */
  async startAll() {
    const results = []
    for (const adapter of this._adapters.values()) {
      try {
        const status = await adapter.start({ onMessage: (inbound) => this.handleInbound(inbound) })
        results.push(status)
      } catch (error) {
        results.push({ id: adapter.id, channel: adapter.channel, state: 'failed', lastError: error?.message ?? String(error) })
      }
    }
    this._started = true
    return results
  }

  /** 停止全部适配器。 */
  async stopAll() {
    const results = []
    for (const adapter of this._adapters.values()) {
      try {
        results.push(await adapter.stop())
      } catch (error) {
        results.push({ id: adapter.id, channel: adapter.channel, state: 'failed', lastError: error?.message ?? String(error) })
      }
    }
    this._started = false
    return results
  }

  /**
   * 处理一条入站消息：写入/更新记忆，并生成回复所需上下文。
   * @param {object} rawOrInbound 统一 Inbound 或可归一化的原始对象
   */
  handleInbound(rawOrInbound) {
    const inbound = normalizeInbound(rawOrInbound)
    const ingest = this._memory.ingestMessage({
      text: inbound.text,
      messageId: inbound.id,
      role: 'user',
      at: inbound.receivedAt,
      sessionId: `im:${inbound.channel}`,
    })
    const context = this.buildReplyContext(inbound)
    return { accepted: true, inbound, ingest, context }
  }

  /**
   * 组装未来 LLM 回复所需的 system prompt 片段。
   * @param {object} inbound 统一 Inbound
   */
  buildReplyContext(inbound) {
    const personaSection = this._persona.renderPersonaSection()
    const memoryDigest = this._memory.renderDigest({ latestUserText: inbound?.text ?? '' })
    return {
      personaSection,
      memoryDigest,
      systemPrompt: `${personaSection}\n\n${memoryDigest}`,
    }
  }

  /**
   * 把回复发回消息来源渠道。
   * @param {{ text: string, userId: string, channel?: string, adapterId?: string,
   *   replyTo?: string, sessionId?: string, meta?: object }} input
   */
  async dispatchReply(input) {
    const outbound = createOutbound({
      ...input,
      channel: input.channel ?? this.#defaultChannel(),
      adapterId: input.adapterId ?? this.#defaultAdapterId(input.channel),
    })
    const adapter = this._adapters.get(outbound.adapterId)
    if (!adapter) return { delivered: false, reason: 'adapter_not_registered', outbound }
    try {
      const result = await adapter.send(outbound)
      return { ...result, outbound }
    } catch (error) {
      return { delivered: false, reason: error?.code ?? 'send_failed', message: error?.message ?? String(error), outbound }
    }
  }

  /** 桥接状态快照。 */
  status() {
    return {
      started: this._started,
      agents: this._config.agentName ?? '铃兰',
      adapters: [...this._adapters.values()].map((adapter) => adapter.status()),
    }
  }

  #defaultChannel() {
    const first = this._adapters.values().next()
    return first.done ? 'unknown' : first.value.channel
  }

  #defaultAdapterId(channel) {
    const match = [...this._adapters.values()].find((adapter) => adapter.channel === channel)
    if (match) return match.id
    const first = this._adapters.values().next()
    return first.done ? `${channel ?? 'unknown'}:default` : first.value.id
  }
}
