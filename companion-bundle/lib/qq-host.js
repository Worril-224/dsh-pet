/**
 * companion-qq：Host 插件（QQ 通道：NapCat / OneBot 11 或 QQ 官方机器人）。
 *
 * 职责：
 *  1. 按 <角色目录>/qq/channel.json 选择通道：本地 OneBot 11 WebSocket，
 *     或 QQ 开放平台官方 WebSocket 网关；接收私聊与群聊 @ 消息；
 *  2. 白名单：只允许配置的 QQ 号（默认主人）使用；忽略机器人自己与其他人的消息；
 *  3. 每条消息交给奥菲莉亚的独立记忆引擎（写入/提及）与回复引擎（人设 + 记忆 + 按需档案）；
 *  4. 通过 OneBot 发送私聊 / 群聊回复，并维护每个 QQ 用户的最近对话上下文。
 *
 * 本插件不依赖 Harness Agent 会话，Harness 运行期间常驻；重启 Harness 后自动重连。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJsonSync, writeJsonSync, ensureDirSync } from './shared/fsutil.js'
import { formatLocalIso } from './shared/clock.js'
import { resolveCharactersRoot, characterDataDir } from './characters.js'
import { createPersonaService } from './persona/index.js'
import { getMemoryEngine } from './memory/index.js'
import { createSystemClock } from './shared/clock.js'
import { createOutbound } from './im/adapter.js'
import { OneBotAdapter } from './im/onebot.js'
import { QQBotAdapter, normalizeQQBotConfig } from './im/qq-bot.js'
import { createReplyEngine } from './im/reply-engine.js'
import { attachQQModelRoutes } from './qq-model-routes.js'
import { attachQQChannelRoutes } from './qq-channel-routes.js'
import { createMemoryAnalyzer } from './memory/analyzer.js'
import { createJsonCompleter, createImageGenerationService } from './imagegen/index.js'
import { splitBubbles } from './im/bubbles.js'
import { prepareImageRefs } from './im/vision.js'
import {
  buildProactivePrompt,
  ensureDayPlan,
  formatDateKey,
  listDueEvents,
  loadDayPlan,
  markEventSent,
  renderFallbackShare,
  saveDayPlan,
} from './life/index.js'

/** Loader 插件名。 */
export const name = 'companion-qq'

/** 使用可选服务（llm / agentDefaultModel 通过 ctx.get 读取）。 */
export const inject = []

/** 默认角色与通道参数。 */
export const DEFAULT_CHARACTER_ID = 'ophelia'
export const DEFAULT_ONEBOT_URL = 'ws://127.0.0.1:3001'
export const DEFAULT_CHANNEL = 'napcat'
export const QQ_CHANNELS = ['napcat', 'qqbot']
export const DEFAULT_HISTORY_LIMIT = 8
export const DEFAULT_REPLY_TOKENS = 8192
export const DEFAULT_REPLY_CHARS = 30000
export const DEFAULT_MAX_BUBBLES = 30
export const DEFAULT_MAX_BUBBLE_CHARS = 2000

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 规范化通道 id；未知值返回 undefined。 */
export function normalizeChannelId(value) {
  return value === 'napcat' || value === 'qqbot' ? value : undefined
}

/** 规范化 QQ 官方机器人配置：凭据 + 授权 openid + 待审批用户。 */
export function normalizeQQBotSettings(value = {}) {
  const config = isObject(value) ? value : {}
  const normalized = normalizeQQBotConfig(config)
  const allowOpenids = (Array.isArray(config.allowOpenids) ? config.allowOpenids : [])
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
  const pendingUsers = (Array.isArray(config.pendingUsers) ? config.pendingUsers : [])
    .filter((entry) => isObject(entry) && typeof entry.userId === 'string' && entry.userId.trim())
    .map((entry) => ({
      userId: entry.userId.trim(),
      ...(typeof entry.userName === 'string' && entry.userName ? { userName: entry.userName } : {}),
      ...(typeof entry.eventType === 'string' && entry.eventType ? { eventType: entry.eventType } : {}),
      ...(typeof entry.at === 'string' && entry.at ? { at: entry.at } : {}),
    }))
  return {
    ...normalized,
    allowOpenids: [...new Set(allowOpenids)],
    pendingUsers,
  }
}

/** 合并插件配置与角色目录里已保存的 QQ 官方机器人设置（保存值优先）。 */
export function mergeQQBotSettings(base, storedRaw) {
  const stored = isObject(storedRaw) ? storedRaw : {}
  const normalizedStored = normalizeQQBotSettings(stored)
  const pickString = (key, fallback) =>
    typeof stored[key] === 'string' && stored[key].trim() ? stored[key].trim() : fallback
  return {
    ...base,
    appId: pickString('appId', base.appId),
    clientSecret: pickString('clientSecret', pickString('secret', base.clientSecret)),
    sandbox: typeof stored.sandbox === 'boolean' ? stored.sandbox : base.sandbox,
    intents: Number.isInteger(stored.intents) ? stored.intents : base.intents,
    baseUrl: pickString('baseUrl', base.baseUrl),
    allowOpenids: [...new Set([...(base.allowOpenids ?? []), ...normalizedStored.allowOpenids])],
    pendingUsers: normalizedStored.pendingUsers,
  }
}

/**
 * 规范化插件配置。
 * @param {object} config Loader 行配置
 */
export function normalizeConfig(config = {}) {
  const allowUsers = (Array.isArray(config.allowUsers) ? config.allowUsers : config.allowUsers !== undefined ? [config.allowUsers] : [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0)
  const botQQ = config.botQQ !== undefined && config.botQQ !== null ? String(config.botQQ).trim() : ''
  return {
    charactersDir: resolveCharactersRoot(config.charactersDir),
    characterId:
      typeof config.characterId === 'string' && config.characterId.trim() ? config.characterId.trim() : DEFAULT_CHARACTER_ID,
    channel: normalizeChannelId(config.channel) ?? DEFAULT_CHANNEL,
    qqbot: normalizeQQBotSettings(config.qqbot),
    onebotUrl: typeof config.onebotUrl === 'string' && config.onebotUrl.trim() ? config.onebotUrl.trim() : DEFAULT_ONEBOT_URL,
    accessToken: typeof config.accessToken === 'string' ? config.accessToken : '',
    botQQ,
    allowUsers,
    allowGroups: (Array.isArray(config.allowGroups) ? config.allowGroups : []).map((value) => String(value)),
    historyLimit: Number.isFinite(config.historyLimit) ? Math.max(2, Math.round(config.historyLimit)) : DEFAULT_HISTORY_LIMIT,
    maxTokens: Number.isFinite(config.maxTokens) ? Math.max(64, Math.round(config.maxTokens)) : DEFAULT_REPLY_TOKENS,
    maxReplyChars: Number.isFinite(config.maxReplyChars) ? Math.max(50, Math.round(config.maxReplyChars)) : DEFAULT_REPLY_CHARS,
    digestMaxChars: Number.isFinite(config.digestMaxChars) ? Math.max(300, Math.round(config.digestMaxChars)) : 30000,
    provider: typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : undefined,
    model: typeof config.model === 'string' && config.model.trim() ? config.model.trim() : undefined,
    reasoningEffort:
      typeof config.reasoningEffort === 'string' && config.reasoningEffort.trim()
        ? config.reasoningEffort.trim()
        : undefined,
    reconnectMinMs: Number.isFinite(config.reconnectMinMs) ? Math.max(500, Math.round(config.reconnectMinMs)) : 1000,
    reconnectMaxMs: Number.isFinite(config.reconnectMaxMs) ? Math.max(1000, Math.round(config.reconnectMaxMs)) : 30000,
    // 多气泡：一段一个气泡
    maxBubbles: Number.isFinite(config.maxBubbles) ? Math.max(1, Math.round(config.maxBubbles)) : DEFAULT_MAX_BUBBLES,
    maxBubbleChars: Number.isFinite(config.maxBubbleChars) ? Math.max(80, Math.round(config.maxBubbleChars)) : DEFAULT_MAX_BUBBLE_CHARS,
    bubbleDelayMs: Number.isFinite(config.bubbleDelayMs) ? Math.max(0, Math.round(config.bubbleDelayMs)) : 300,
    // 联网搜索
    webSearchEnabled: config.webSearchEnabled !== false,
    webSearchMaxResults: Number.isFinite(config.webSearchMaxResults) ? Math.max(1, Math.min(8, Math.round(config.webSearchMaxResults))) : 5,
    webSearchTimeoutMs: Number.isFinite(config.webSearchTimeoutMs) ? Math.max(3000, Math.round(config.webSearchTimeoutMs)) : 25000,
    webContextMaxChars: Number.isFinite(config.webContextMaxChars) ? Math.max(1000, Math.round(config.webContextMaxChars)) : 300000,
    webFetchEnabled: config.webFetchEnabled !== false,
    webFetchMaxPages: Number.isFinite(config.webFetchMaxPages) ? Math.max(1, Math.min(3, Math.round(config.webFetchMaxPages))) : 2,
    webFetchMaxChars: Number.isFinite(config.webFetchMaxChars) ? Math.max(200, Math.round(config.webFetchMaxChars)) : 150000,
    webFetchTimeoutMs: Number.isFinite(config.webFetchTimeoutMs) ? Math.max(2000, Math.round(config.webFetchTimeoutMs)) : 8000,
    // 图片识别
    imageMaxCount: Number.isFinite(config.imageMaxCount) ? Math.max(1, Math.min(9, Math.round(config.imageMaxCount))) : 4,
    // 每日生活事件主动分享
    proactiveEnabled: config.proactiveEnabled !== false,
    proactiveIntervalMs: Number.isFinite(config.proactiveIntervalMs) ? Math.max(10000, Math.round(config.proactiveIntervalMs)) : 60000,
    proactiveMaxPerTick: Number.isFinite(config.proactiveMaxPerTick) ? Math.max(1, Math.min(6, Math.round(config.proactiveMaxPerTick))) : 3,
    // 每日事件：晚上只生成时间；内容到点生成；主人还在聊天时延后
    lifeDeferredContent: config.lifeDeferredContent !== false,
    lifeQuietMinutes: Number.isFinite(config.lifeQuietMinutes) ? Math.max(1, Math.round(config.lifeQuietMinutes)) : 5,
    // NapCat「对方正在输入」注意力模拟：持续输入/停留超过阈值就主动搭话
    attentionEnabled: config.attentionEnabled !== false,
    attentionThresholdMs: Number.isFinite(config.attentionThresholdMs) ? Math.max(3000, Math.round(config.attentionThresholdMs)) : 20000,
    attentionCooldownMs: Number.isFinite(config.attentionCooldownMs) ? Math.max(60000, Math.round(config.attentionCooldownMs)) : 600000,
    // 生图：进入新场景/特殊动作/情绪激动时，用本地 ComfyUI Qwen Image 2.1 Turbo
    imagegenEnabled: config.imagegenEnabled === true,
    imagegenCooldownMs: Number.isFinite(config.imagegenCooldownMs) ? Math.max(10000, Math.round(config.imagegenCooldownMs)) : 10000,
    imagegenMaxPerDay: Number.isFinite(config.imagegenMaxPerDay)
      ? Math.max(0, Math.min(1000, Math.round(config.imagegenMaxPerDay)))
      : 0,
    imagegenIdleStopMs: Number.isFinite(config.imagegenIdleStopMs)
      ? Math.max(60000, Math.round(config.imagegenIdleStopMs))
      : 600000,
    imagegenTimeoutMs: Number.isFinite(config.imagegenTimeoutMs)
      ? Math.max(30000, Math.round(config.imagegenTimeoutMs))
      : 600000,
    comfyUrl: typeof config.comfyUrl === 'string' && config.comfyUrl.trim() ? config.comfyUrl.trim() : 'http://127.0.0.1:8188',
    // 以下 ComfyUI 启动参数全部可选，且不内置任何本机绝对路径：
    // 需要自动拉起 ComfyUI 时，用配置或环境变量 COMFY_CLI_PATH / COMFY_WORKSPACE 提供；
    // 留空表示不自动拉起（直接连接 comfyUrl 指向的已运行实例）。
    comfyCliPath:
      typeof config.comfyCliPath === 'string' && config.comfyCliPath.trim()
        ? config.comfyCliPath.trim()
        : process.env.COMFY_CLI_PATH?.trim() || '',
    comfyWorkspace:
      typeof config.comfyWorkspace === 'string' && config.comfyWorkspace.trim()
        ? config.comfyWorkspace.trim()
        : process.env.COMFY_WORKSPACE?.trim() || '',
    comfyWorkflowPath:
      typeof config.comfyWorkflowPath === 'string' && config.comfyWorkflowPath.trim()
        ? config.comfyWorkflowPath.trim()
        : undefined,
    comfyStartTimeoutMs: Number.isFinite(config.comfyStartTimeoutMs)
      ? Math.max(30000, Math.round(config.comfyStartTimeoutMs))
      : 300000,
    comfyExtraArgs: Array.isArray(config.comfyExtraArgs)
      ? config.comfyExtraArgs.map((value) => String(value))
      : [],
  }
}

/** 每个 QQ 用户的最近对话存储（持久化到 <角色目录>/qq/sessions.json）。 */
export function createSessionStore(file, historyLimit = DEFAULT_HISTORY_LIMIT) {
  const storeFile = path.resolve(file)
  let data = { schemaVersion: 1, updatedAt: undefined, users: {} }
  try {
    const loaded = readJsonSync(storeFile, undefined)
    if (loaded && isObject(loaded) && isObject(loaded.users)) data = loaded
  } catch {
    // 损坏的会话文件不影响启动（用新文件覆盖）
  }
  function persist() {
    data.updatedAt = formatLocalIso()
    try {
      ensureDirSync(path.dirname(storeFile))
      writeJsonSync(storeFile, data)
    } catch {
      // 持久化失败不影响本次回复
    }
  }
  return {
    file: storeFile,
    load: persist,
    get(userId) {
      const list = data.users[String(userId)]
      return Array.isArray(list) ? list.map((entry) => ({ ...entry })) : []
    },
    append(userId, role, text, at = Date.now()) {
      const key = String(userId)
      const list = Array.isArray(data.users[key]) ? data.users[key] : []
      list.push({ role, text: String(text), at })
      const max = historyLimit * 2
      data.users[key] = list.slice(-max)
      persist()
    },
    clear(userId) {
      delete data.users[String(userId)]
      persist()
    },
    snapshot() {
      return JSON.parse(JSON.stringify(data))
    },
  }
}

/**
 * 创建 QQ 通道运行时（不直接依赖 Cordis，便于测试注入）。
 * @param {object} options
 * @param {object} options.config 原始配置
 * @param {object} [options.deps] 测试注入：persona/memory/replyEngine/adapter/sessions/llm/modelSelection/logger/clock
 */
export function createQQHost({ config = {}, deps = {} } = {}) {
  const settings = normalizeConfig(config)
  const clock = deps.clock ?? createSystemClock()
  const logger = deps.logger

  const dataDir = characterDataDir(settings.charactersDir, settings.characterId)
  const channelFile = path.join(dataDir, 'qq', 'channel.json')
  let persistedChannel = {}
  try {
    const loaded = readJsonSync(channelFile, undefined)
    if (isObject(loaded)) persistedChannel = loaded
  } catch {
    // 损坏的通道文件按插件配置处理，下一次保存覆盖
  }
  settings.channel = normalizeChannelId(persistedChannel.channel) ?? settings.channel
  settings.qqbot = mergeQQBotSettings(settings.qqbot, persistedChannel.qqbot)
  if (settings.channel === 'napcat') {
    if (!settings.botQQ) throw new Error('companion-qq: 缺少 botQQ（NapCat 机器人 QQ 号）')
    if (settings.allowUsers.length === 0) throw new Error('companion-qq: 缺少 allowUsers（NapCat 白名单 QQ 号）')
  }
  const persona =
    deps.persona ??
    createPersonaService({ dataDir, defaultPersonaFile: path.join(dataDir, 'persona', 'persona.json'), clock })
  if (!deps.persona) persona.ensure()
  const memory = deps.memory ?? getMemoryEngine({ dataDir, clock })
  if (!deps.memory) memory.ensure()

  const sessions = deps.sessions ?? createSessionStore(path.join(dataDir, 'qq', 'sessions.json'), settings.historyLimit)

  // QQ 面板切换的聊天模型：保存在角色目录，不重载插件、不断开 QQ 连接。
  const replyModelFile = path.join(dataDir, 'qq', 'reply-model.json')

  function normalizeReplyModel(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
    const model = typeof value.model === 'string' ? value.model.trim() : ''
    if (!provider || !model) return undefined
    const reasoningEffort =
      typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim()
        ? value.reasoningEffort.trim()
        : undefined
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
  }

  function loadReplyModelOverride() {
    try {
      const loaded = readJsonSync(replyModelFile, undefined)
      const route = normalizeReplyModel(loaded)
      if (!route) return { route: undefined, updatedAt: undefined }
      return { route, updatedAt: typeof loaded?.updatedAt === 'string' ? loaded.updatedAt : undefined }
    } catch (error) {
      logger?.warn?.(`[qq] 读取模型覆盖文件失败，使用插件配置：${error?.message ?? error}`)
      return { route: undefined, updatedAt: undefined }
    }
  }

  const loadedReplyModel = loadReplyModelOverride()
  let replyModelOverride = loadedReplyModel.route
  let replyModelUpdatedAt = loadedReplyModel.updatedAt

  const llm = deps.llm
  const modelSelection = deps.modelSelection
  const web = deps.web
  const attachments = deps.attachments
  const replyEngine =
    deps.replyEngine ??
    createReplyEngine({
      persona,
      memory,
      llm,
      web,
      modelSelection,
      getRoute: () => replyModelOverride,
      logger,
      config: {
        provider: settings.provider,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        maxTokens: settings.maxTokens,
        maxReplyChars: settings.maxReplyChars,
        digestMaxChars: settings.digestMaxChars,
        webSearchEnabled: settings.webSearchEnabled,
        webSearchMaxResults: settings.webSearchMaxResults,
        webSearchTimeoutMs: settings.webSearchTimeoutMs,
        webContextMaxChars: settings.webContextMaxChars,
        webFetchEnabled: settings.webFetchEnabled,
        webFetchMaxPages: settings.webFetchMaxPages,
        webFetchMaxChars: settings.webFetchMaxChars,
        webFetchTimeoutMs: settings.webFetchTimeoutMs,
      },
    })
  const memoryAnalyzer = createMemoryAnalyzer({ llm, modelSelection, logger, maxTokens: 2400 })
  const lifeJson = createJsonCompleter({ llm, modelSelection, logger, maxTokens: 1200 })
  let imagegen = deps.imagegen
  if (!imagegen && settings.imagegenEnabled) {
    try {
      const llmJson = createJsonCompleter({ llm, modelSelection, logger, maxTokens: 3200 })
      let personaSection = ''
      try {
        personaSection = persona.renderPersonaSection()
      } catch {
        personaSection = ''
      }
      imagegen = createImageGenerationService({
        dataDir,
        settings,
        logger,
        llmJson,
        personaSection,
        memory,
      })
    } catch (error) {
      logger?.warn?.(`[qq] 生图服务初始化失败：${error?.message ?? error}`)
      imagegen = undefined
    }
  }

  /** 按当前通道创建适配器；测试可注入 adapterFactory 同时伪造两个通道。 */
  function buildAdapter(channel) {
    if (typeof deps.adapterFactory === 'function') {
      return deps.adapterFactory({
        channel,
        settings: { ...settings, channel, qqbot: { ...settings.qqbot } },
      })
    }
    if (channel === 'qqbot') {
      return new QQBotAdapter({
        id: `qq-qqbot:${settings.qqbot.appId || 'unconfigured'}`,
        appId: settings.qqbot.appId,
        clientSecret: settings.qqbot.clientSecret,
        sandbox: settings.qqbot.sandbox,
        intents: settings.qqbot.intents,
        baseUrl: settings.qqbot.baseUrl,
        reconnectMinMs: settings.reconnectMinMs,
        reconnectMaxMs: settings.reconnectMaxMs,
      })
    }
    if (deps.adapter) return deps.adapter
    return new OneBotAdapter({
      id: `qq-onebot:${settings.botQQ}`,
      url: settings.onebotUrl,
      accessToken: settings.accessToken,
      selfId: settings.botQQ,
      reconnectMinMs: settings.reconnectMinMs,
      reconnectMaxMs: settings.reconnectMaxMs,
    })
  }

  let adapter = buildAdapter(settings.channel)
  const adapterHandlers = {
    onMessage: (inbound) => handleInbound(inbound),
    onNotice: (notice) => handleNotice(notice),
  }

  const allowed = new Set(settings.allowUsers)
  const qqbotAllowed = new Set(settings.qqbot.allowOpenids)
  const allowGroups = new Set(settings.allowGroups)
  const queues = new Map()
  const recentMessageIds = new Set()
  const statusFile = path.join(dataDir, 'qq', 'status.json')
  let started = false
  let lastError
  let lastActivityAt
  let channelUpdatedAt =
    typeof persistedChannel.updatedAt === 'string' ? persistedChannel.updatedAt : undefined
  let switchingChannel

  function persistChannelFile() {
    try {
      ensureDirSync(path.dirname(channelFile))
      channelUpdatedAt = formatLocalIso(clock.now())
      writeJsonSync(channelFile, {
        schemaVersion: 1,
        channel: settings.channel,
        updatedAt: channelUpdatedAt,
        qqbot: {
          appId: settings.qqbot.appId || undefined,
          clientSecret: settings.qqbot.clientSecret || undefined,
          sandbox: settings.qqbot.sandbox,
          intents: settings.qqbot.intents,
          baseUrl: settings.qqbot.baseUrl || undefined,
          allowOpenids: [...qqbotAllowed],
          pendingUsers: settings.qqbot.pendingUsers,
        },
      })
    } catch (error) {
      logger?.warn?.(`[qq] 保存通道设置失败：${error?.message ?? error}`)
    }
  }

  function rememberMessageId(id) {
    if (!id) return true
    if (recentMessageIds.has(id)) return false
    recentMessageIds.add(id)
    if (recentMessageIds.size > 200) {
      const first = recentMessageIds.values().next().value
      recentMessageIds.delete(first)
    }
    return true
  }

  function isAllowed(inbound) {
    if (!inbound) return false
    const userId = String(inbound.userId)
    if (!allowed.has(userId) && !qqbotAllowed.has(userId)) return false
    if (settings.channel === 'napcat' && settings.botQQ && userId === settings.botQQ) return false
    if (inbound.meta?.groupId && allowGroups.size > 0 && !allowGroups.has(String(inbound.meta.groupId))) return false
    return true
  }

  /**
   * 把回复拆成多个气泡发送（一段一个气泡）；群聊仅第一条 @ 主人。
   * @param {{text:string, userId:string, groupId?:string, replyTo?:string, sessionId?:string}} input
   */
  async function sendBubbles({ text, userId, groupId, replyTo, sessionId }) {
    const maxBubbles = Math.max(
      1,
      Math.min(
        settings.maxBubbles,
        Number.isFinite(adapter.maxBubblesPerReply) ? adapter.maxBubblesPerReply : settings.maxBubbles,
      ),
    )
    const maxCharsPerBubble = Math.max(
      80,
      Math.min(
        settings.maxBubbleChars,
        Number.isFinite(adapter.maxCharsPerBubble) ? adapter.maxCharsPerBubble : settings.maxBubbleChars,
      ),
    )
    const bubbles = splitBubbles(text, { maxBubbles, maxCharsPerBubble }).map((bubble) =>
      bubble.length > maxCharsPerBubble ? `${bubble.slice(0, maxCharsPerBubble - 1)}…` : bubble,
    )
    const sent = []
    for (let index = 0; index < bubbles.length; index += 1) {
      const meta = {}
      if (groupId) {
        meta.groupId = groupId
        meta.mention = index === 0
      }
      const outbound = createOutbound({
        text: bubbles[index],
        userId,
        channel: 'qq',
        adapterId: adapter.id,
        ...(replyTo ? { replyTo } : {}),
        ...(sessionId ? { sessionId } : {}),
        meta,
      })
      sent.push(await adapter.send(outbound))
      if (index < bubbles.length - 1 && settings.bubbleDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, settings.bubbleDelayMs))
      }
    }
    return { bubbles, sent }
  }

  /** 发送一张本地生成图（图在最后一个气泡）。 */
  async function sendImage({ userId, filePath, caption = '（把刚画好的画面递过来）', sessionId, replyTo }) {
    const text = String(caption ?? '').trim() || '（把刚画好的画面递过来）'
    const outbound = createOutbound({
      text,
      userId,
      channel: 'qq',
      adapterId: adapter.id,
      ...(replyTo ? { replyTo } : {}),
      ...(sessionId ? { sessionId } : {}),
      images: [filePath],
    })
    const result = await adapter.send(outbound)
    sessions.append(userId, 'assistant', text, clock.now())
    return result
  }

  // ───────────────────── 每日生活事件 · 主动分享 ─────────────────────

  let lifeTimer
  let proactiveStarted = false
  let planPromise
  let lastProactiveError
  let lastProactiveAt
  let lastAttentionAt
  let lastInboundAt = 0
  const attentionStates = new Map()
  const attentionCooldown = new Map()

  function resolveIdentity() {
    let definition
    try {
      definition = typeof persona.getDefinition === 'function' ? persona.getDefinition() : undefined
    } catch {
      definition = undefined
    }
    const character = definition?.character ?? {}
    return {
      characterName: typeof character.name === 'string' && character.name ? character.name : settings.characterId,
      userAddress: typeof character.userAddress === 'string' && character.userAddress ? character.userAddress : '主人',
    }
  }

  async function ensureTodayPlan() {
    const dateKey = formatDateKey(new Date(clock.now()))
    const existing = loadDayPlan(dataDir, dateKey)
    if (existing) return existing
    if (planPromise) return planPromise
    const identity = resolveIdentity()
    planPromise = ensureDayPlan({
      dataDir,
      dateKey,
      characterId: settings.characterId,
      characterName: identity.characterName,
      userAddress: identity.userAddress,
      persona,
      memory,
      llm,
      web,
      clock,
      modelSelection,
      source: 'qq-ensure',
      deferredContent: settings.lifeDeferredContent,
      logger: { warn: (message) => logger?.warn?.(`[qq] ${message}`) },
    })
      .then((result) => result?.plan)
      .catch((error) => {
        lastProactiveError = error?.message ?? String(error)
        logger?.warn?.(`[qq] 生成今日生活计划失败：${lastProactiveError}`)
        return undefined
      })
      .finally(() => {
        planPromise = undefined
      })
    return planPromise
  }

  function replacePlanEvent(plan, eventId, patch) {
    return {
      ...plan,
      events: (plan.events ?? []).map((item) => (item.id === eventId ? { ...item, ...patch, pending: false } : item)),
    }
  }

  /** 到点后才生成事件内容：结合当前人设、记忆和最近对话，而不是凌晨预写。 */
  async function resolveDeferredEvent(event) {
    const identity = resolveIdentity()
    const userId = [...allowed][0]
    const history = userId ? sessions.get(userId) : []
    const latestUserText = [...history].reverse().find((item) => item.role === 'user')?.text ?? ''
    let personaSection = ''
    let digest = ''
    try {
      personaSection = persona.renderPersonaSection()
    } catch {
      personaSection = ''
    }
    try {
      digest = memory.renderDigest({ latestUserText, maxChars: settings.digestMaxChars })
    } catch {
      digest = ''
    }
    const historyText = history
      .slice(-8)
      .map((item) => `${item.role === 'assistant' ? identity.characterName : identity.userAddress}：${item.text}`)
      .join('\n')
    try {
      const raw = await lifeJson.complete({
        system: [
          personaSection,
          '你正在为奥菲莉亚生成「此刻正在发生的日常事件」，只输出 JSON。',
          `现在是 ${event.time || '此刻'}，你正在过自己的日子；事件要具体、有动作、有场景，贴合人设和记忆。`,
          '固定 JSON：{"title":"不超过20字","content":"第一人称，40-140字，具体写正在做什么、看到什么、想到什么","type":"日常|回忆|阅读|外出|休息|整理|料理","sourceType":"memory|life"}',
          '不要写链接、不要编造素材之外的大事件、不要客服腔、不要提系统/设定。',
        ].filter(Boolean).join('\n\n'),
        user: [
          `【角色】${identity.characterName}，称呼对方「${identity.userAddress}」`,
          `【类型】${event.type || '日常'}`,
          `【最近对话】\n${historyText || '（无）'}`,
          `【记忆摘要】\n${digest || '（无）'}`,
        ].join('\n\n'),
        timeoutMs: 90000,
      })
      const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 40) : ''
      const content = typeof raw?.content === 'string' && raw.content.trim() ? raw.content.trim().slice(0, 240) : ''
      if (title && content) {
        return {
          ...event,
          title,
          content,
          type: typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : event.type || '日常',
          sourceType: raw.sourceType === 'memory' ? 'memory' : 'life',
          pending: false,
        }
      }
    } catch (error) {
      logger?.warn?.(`[qq] 延迟事件内容生成失败，使用兜底：${error?.message ?? error}`)
    }
    return {
      ...event,
      title: `${event.type || '日常'}的一小段`,
      content: '我在窗边坐了一会儿，手边的事先放下了。外头的光慢慢移过去，我忽然想起一些旧事。',
      type: event.type || '日常',
      sourceType: 'life',
      pending: false,
    }
  }

  async function generateLifeShare(event) {
    const identity = resolveIdentity()
    let personaSection = ''
    let digest = ''
    try {
      personaSection = persona.renderPersonaSection()
    } catch {
      personaSection = ''
    }
    try {
      digest = memory.renderDigest({ latestUserText: '', maxChars: settings.digestMaxChars })
    } catch {
      digest = ''
    }
    const prompts = buildProactivePrompt({
      personaSection,
      digest,
      event,
      characterName: identity.characterName,
      userAddress: identity.userAddress,
    })
    try {
      const text = await replyEngine.generateWithPrompt({ system: prompts.system, user: prompts.user, maxChars: settings.maxReplyChars })
      if (text && text.trim()) return text.trim()
    } catch (error) {
      logger?.warn?.(`[qq] 主动分享文案生成失败，使用兜底：${error?.message ?? error}`)
    }
    return renderFallbackShare(event)
  }

  /**
   * 检查今天的计划，把到点的生活事件主动发给白名单主人（私聊）。
   * @returns {Promise<{sent:number, events:object[], reason?:string, error?:string}>}
   */
  async function checkLifeEvents() {
    if (!settings.proactiveEnabled) return { sent: 0, events: [], reason: 'disabled' }
    // QQ 官方平台自 2025-04 起下线主动消息，只能被动回复；官方通道跳过主动分享。
    if (adapter.supportsProactive === false) return { sent: 0, events: [], reason: 'channel_unsupported' }
    const now = clock.now()
    const dateKey = formatDateKey(new Date(now))
    let plan = loadDayPlan(dataDir, dateKey)
    if (!plan) {
      plan = await ensureTodayPlan()
      if (!plan) return { sent: 0, events: [], reason: 'plan_unavailable', error: lastProactiveError }
    }
    const due = listDueEvents(plan, now)
    // 主人还在对话中时，直接取消本轮到点的生活事件，不插在对话之间。
    if (due.length > 0 && now - lastInboundAt < settings.lifeQuietMinutes * 60000) {
      const canceledAt = formatLocalIso(now)
      const dueIds = new Set(due.map((event) => event.id))
      plan = {
        ...plan,
        events: (plan.events ?? []).map((event) =>
          dueIds.has(event.id)
            ? { ...event, canceledAt, cancelReason: 'in_conversation' }
            : event,
        ),
      }
      try {
        saveDayPlan(dataDir, plan)
      } catch (error) {
        logger?.warn?.(`[qq] 取消生活事件后保存计划失败：${error?.message ?? error}`)
      }
      return {
        sent: 0,
        events: [],
        canceled: due.length,
        reason: 'in_conversation',
      }
    }
    const events = []
    let sentCount = 0
    for (const dueEvent of due.slice(0, settings.proactiveMaxPerTick)) {
      try {
        const event =
          dueEvent.pending || !dueEvent.title || !dueEvent.content
            ? await resolveDeferredEvent(dueEvent)
            : dueEvent
        const text = await generateLifeShare(event)
        const recipients = [...allowed]
        let delivered = 0
        for (const userId of recipients) {
          await sendBubbles({ text, userId, sessionId: `qq:${userId}` })
          sessions.append(userId, 'assistant', text, clock.now())
          delivered += 1
        }
        // 生活分享发完后写入记忆：以后聊天时能记得“那天我主动分享过什么”
        if (delivered > 0 && typeof memory.remember === 'function') {
          try {
            const lifeContent = `【生活分享·${event.type || '日常'}】${event.title}\n${text}`
            let lifeAnalysis
            try {
              lifeAnalysis = await memoryAnalyzer.analyze({ content: lifeContent, kindHint: 'event', source: 'life-share' })
            } catch {
              lifeAnalysis = undefined
            }
            memory.remember({
              content: lifeContent,
              category: lifeAnalysis?.category || '事件',
              keywords: lifeAnalysis?.keywords?.length
                ? lifeAnalysis.keywords
                : [event.title, '生活分享', event.type || '日常'],
              summary: lifeAnalysis?.summary,
              source: 'life-share',
              emphasis: 1,
              metadata: lifeAnalysis ? { ...lifeAnalysis, llm: true } : undefined,
              at: clock.now(),
            })
          } catch (error) {
            logger?.warn?.(`[qq] 生活分享写入记忆失败：${error?.message ?? error}`)
          }
        }
        plan = markEventSent(replacePlanEvent(plan, event.id, event), event.id, formatLocalIso(clock.now()))
        try {
          saveDayPlan(dataDir, plan)
        } catch (error) {
          logger?.warn?.(`[qq] 保存生活计划失败：${error?.message ?? error}`)
        }
        events.push({ id: event.id, time: event.time, title: event.title })
        sentCount += 1
        lastActivityAt = formatLocalIso(clock.now())
        lastProactiveAt = lastActivityAt
        lastError = undefined
      } catch (error) {
        lastProactiveError = error?.message ?? String(error)
        logger?.error?.(`[qq] 主动分享发送失败（${event?.id}）：${lastProactiveError}`)
      }
    }
    return { sent: sentCount, events }
  }

  /**
   * 清掉某个用户的「持续关注」计时器。
   * 主人真正发消息时调用，避免同时收到主动搭话 + 正常回复。
   */
  function clearAttention(userId) {
    const key = String(userId)
    const state = attentionStates.get(key)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    attentionStates.delete(key)
  }

  /** 停止全部注意力计时器（插件卸载/停止时）。 */
  function stopAttention() {
    for (const state of attentionStates.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    attentionStates.clear()
  }

  function parseTopicResponse(text) {
    const raw = String(text ?? '').trim()
    if (!raw) return { hasTopic: false }
    try {
      const parsed = JSON.parse(raw)
      if (parsed && parsed.hasTopic === false) return { hasTopic: false }
      if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
        return { hasTopic: true, message: parsed.message.trim() }
      }
    } catch {
      // 容忍模型直接返回一句话
    }
    const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw)
    if (fenced) {
      try {
        const parsed = JSON.parse(fenced[1].trim())
        if (parsed && parsed.hasTopic === false) return { hasTopic: false }
        if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
          return { hasTopic: true, message: parsed.message.trim() }
        }
      } catch { /* ignore */ }
    }
    if (!raw.startsWith('{') && !raw.startsWith('[')) return { hasTopic: true, message: raw }
    return { hasTopic: false }
  }

  function shortTermSnapshot() {
    try {
      if (typeof memory.listLayer !== 'function') return ''
      const items = memory.listLayer('short').slice(-12)
      return items
        .map((item) => {
          const keywords = Array.isArray(item.keywords) ? item.keywords.join('、') : ''
          const text = String(item.summary || item.content || '').replace(/\s+/g, ' ').slice(0, 180)
          return text ? `- ${text}${keywords ? `（${keywords}）` : ''}` : ''
        })
        .filter(Boolean)
        .join('\n')
    } catch {
      return ''
    }
  }

  async function generateAttentionMessage(userId) {
    const identity = resolveIdentity()
    const history = sessions.get(userId)
    const latestUserText = [...history].reverse().find((item) => item.role === 'user')?.text ?? ''
    let personaSection = ''
    let digest = ''
    try {
      personaSection = persona.renderPersonaSection()
    } catch {
      personaSection = ''
    }
    try {
      digest = memory.renderDigest({ latestUserText, maxChars: settings.digestMaxChars })
    } catch {
      digest = ''
    }
    const historyText = history.length > 0
      ? history.slice(-10).map((item) => `${item.role === 'assistant' ? identity.characterName : identity.userAddress}：${item.text}`).join('\n')
      : ''

    // 第一优先级：当前会话上下文里是否有值得主动接的话题。
    try {
      const contextResult = parseTopicResponse(await replyEngine.generateWithPrompt({
        system: [
          personaSection,
          '你正在通过 QQ 和主人聊天。你想主动找主人说话，但不要硬找话题。',
          '先判断「最近对话」里有没有一个值得现在主动接的话题：未完成的事、主人刚提到的细节、约定、情绪线索、需要回应的内容。',
          '如果只是普通寒暄/没有值得接的内容，不要勉强；如果值得，写一句 10–80 字、带动作或神态的主动话题，最多一个轻问句。',
          '严格只输出 JSON：{"hasTopic":true,"message":"..."} 或 {"hasTopic":false}。',
          '不要提输入状态、检测、系统、一直看着我。',
        ].filter(Boolean).join('\n\n'),
        user: `【角色】你是${identity.characterName}，称呼对方「${identity.userAddress}」。\n\n【最近对话】\n${historyText || '（暂无）'}\n\n请判断并输出 JSON。`,
        maxChars: 260,
      }))
      if (contextResult.hasTopic && contextResult.message) return contextResult.message
    } catch (error) {
      logger?.warn?.(`[qq] 上下文话题判断失败，继续看短期记忆：${error?.message ?? error}`)
    }

    // 第二优先级：短期记忆里是否有值得开启的话题。
    const shortTermText = shortTermSnapshot()
    if (shortTermText) {
      try {
        const memoryResult = parseTopicResponse(await replyEngine.generateWithPrompt({
          system: [
            personaSection,
            '你正在通过 QQ 和主人聊天。最近的对话没有值得主动接的话题。',
            '请从「短期记忆」里挑一件真的值得拿出来聊的事（旧约定、近况、共同经历、主人提过的细节），自然转成一句主动开启话题的话。',
            '如果这些短期记忆都不适合现在聊，不要硬编；如果合适，输出 10–80 字、带动作或神态的话，最多一个轻问句。',
            '严格只输出 JSON：{"hasTopic":true,"message":"..."} 或 {"hasTopic":false}。',
            '不要提输入状态、检测、系统、一直看着我。',
          ].filter(Boolean).join('\n\n'),
          user: `【角色】你是${identity.characterName}，称呼对方「${identity.userAddress}」。\n\n【短期记忆】\n${shortTermText}\n\n请判断并输出 JSON。`,
          maxChars: 260,
        }))
        if (memoryResult.hasTopic && memoryResult.message) return memoryResult.message
      } catch (error) {
        logger?.warn?.(`[qq] 短期记忆话题判断失败，改随机：${error?.message ?? error}`)
      }
    }

    // 第三优先级：随机的小念头/手边细节。
    const hooks = ['窗边的光', '手边翻到一半的书', '今天还没喝完的茶', '第七阅览室的灰尘', '一条没归档完的索引', '外面走过的脚步声']
    const randomHook = hooks[Math.floor(Math.random() * hooks.length)]
    try {
      const text = await replyEngine.generateWithPrompt({
        system: [
          personaSection,
          '你正在通过 QQ 和主人聊天。最近对话和短期记忆里都没有特别值得主动提起的话题。',
          '请不要硬编重要的事；随口分享一个很小的随机念头、手边正在做的事或窗外的细节，像突然想起什么。',
          '10–80 字，可以带一点动作或神态；不要提输入状态、检测、系统、一直看着我；只输出正文。',
        ].filter(Boolean).join('\n\n'),
        user: `【角色】你是${identity.characterName}，称呼对方「${identity.userAddress}」。\n【随机引子】${randomHook}`,
        maxChars: Math.min(200, settings.maxReplyChars),
      })
      if (text && text.trim()) return text.trim()
    } catch (error) {
      logger?.warn?.(`[qq] 随机话题生成失败，使用兜底：${error?.message ?? error}`)
    }
    if (shortTermText) return '（翻着刚才的记录，忽然停下来）我还在想一件事……您要是愿意，我想再听听您的看法。'
    return '（把窗边的东西挪了挪）刚才有一小会儿，风把桌上的纸吹得响了一下。'
  }

  async function fireAttention(userId) {
    const key = String(userId)
    const state = attentionStates.get(key)
    if (!state || state.triggered) return
    state.timer = undefined
    if (!settings.attentionEnabled || !allowed.has(key)) {
      attentionStates.delete(key)
      return
    }
    const now = clock.now()
    if (now < state.startAt + settings.attentionThresholdMs) return
    if (now < (state.cooldownUntil ?? 0)) {
      attentionStates.delete(key)
      return
    }
    state.triggered = true
    attentionCooldown.set(key, now + settings.attentionCooldownMs)
    attentionStates.delete(key)
    try {
      const text = await generateAttentionMessage(key)
      await sendBubbles({ text, userId: key, sessionId: `qq:${key}` })
      sessions.append(key, 'assistant', text, clock.now())
      // 自动发出的内容也写进特殊记忆，避免以后主人提起时“回想不起来”。
      if (typeof memory.remember === 'function') {
        try {
          memory.remember({
            content: `【我主动找主人说的话】${text}`,
            keywords: ['主动找话题', '我主动说的', '主人', '奥菲莉亚'],
            category: '事件',
            summary: String(text).slice(0, 180),
            source: 'proactive-topic',
            metadata: { proactive: true, kind: 'proactive_topic' },
            at: clock.now(),
          })
        } catch (error) {
          logger?.warn?.(`[qq] 主动话题写入记忆失败：${error?.message ?? error}`)
        }
      }
      lastAttentionAt = formatLocalIso(clock.now())
      lastActivityAt = lastAttentionAt
      lastError = undefined
      logger?.info?.(`[qq] 聊天框持续停留触发主动找话题（${key}）`)
    } catch (error) {
      lastProactiveError = error?.message ?? String(error)
      logger?.warn?.(`[qq] 注意力主动搭话发送失败：${lastProactiveError}`)
    }
  }

  /**
   * 处理 NapCat input_status：主人在输入框持续停留，超过阈值就主动搭话。
   * 注意：input_status 本质是「正在输入」；这里把它当作「持续关注/看对话」的近似信号。
   */
  function handleNotice(notice) {
    if (!settings.attentionEnabled) return
    if (adapter.supportsAttention === false) return
    if (!notice || notice.type !== 'input_status') return
    const userId = String(notice.userId ?? '')
    if (!userId || !allowed.has(userId)) return
    const key = userId
    if (notice.isTyping === false) {
      clearAttention(key)
      return
    }
    const now = clock.now()
    let state = attentionStates.get(key)
    if (!state) {
      state = {
        startAt: now,
        lastAt: now,
        triggered: false,
        cooldownUntil: attentionCooldown.get(key) ?? 0,
        timer: undefined,
      }
      attentionStates.set(key, state)
    } else {
      state.lastAt = now
    }
    if (state.timer) clearTimeout(state.timer)
    const delay = Math.max(0, state.startAt + settings.attentionThresholdMs - now)
    state.timer = setTimeout(() => {
      fireAttention(key).catch((error) => logger?.warn?.(`[qq] 注意力处理失败：${error?.message ?? error}`))
    }, delay)
    state.timer.unref?.()
  }

  /** 启动每日生活事件定时检查（幂等）。 */
  async function startProactive() {
    if (!settings.proactiveEnabled || proactiveStarted) return
    proactiveStarted = true
    ensureTodayPlan()
      .then(() => checkLifeEvents())
      .catch((error) => logger?.warn?.(`[qq] 主动分享启动检查失败：${error?.message ?? error}`))
    lifeTimer = setInterval(() => {
      checkLifeEvents().catch((error) => logger?.warn?.(`[qq] 主动分享检查失败：${error?.message ?? error}`))
    }, settings.proactiveIntervalMs)
    lifeTimer.unref?.()
  }

  /** 停止主动分享定时器（幂等）。 */
  function stopProactive() {
    proactiveStarted = false
    if (lifeTimer !== undefined) {
      clearInterval(lifeTimer)
      lifeTimer = undefined
    }
  }

  // ───────────────────── QQ 接入通道：NapCat / 官方机器人 ─────────────────────

  function channelLabel(channel = settings.channel) {
    return channel === 'qqbot' ? 'QQ 官方机器人' : 'NapCat（OneBot 11）'
  }

  function adapterStatusSnapshot() {
    try {
      return typeof adapter.status === 'function' ? adapter.status() : { state: adapter.state }
    } catch (error) {
      return { state: 'failed', lastError: error?.message ?? String(error) }
    }
  }

  /** 通道面板读取的完整状态（绝不返回 AppSecret）。 */
  function channelState() {
    const qqbot = settings.qqbot
    const adapterStatus = adapterStatusSnapshot()
    return {
      channel: settings.channel,
      channelLabel: channelLabel(),
      updatedAt: channelUpdatedAt,
      options: [
        {
          id: 'napcat',
          label: 'NapCat / OneBot 11',
          description: '本地 NapCat 连接，功能完整（主动分享、输入状态等）；需要保持 NapCat 在线。',
          configured: Boolean(settings.botQQ && settings.allowUsers.length > 0),
        },
        {
          id: 'qqbot',
          label: 'QQ 官方机器人',
          description: 'QQ 开放平台官方接口，不需要 NapCat；只能被动回复，主动分享不可用。',
          configured: Boolean(qqbot.appId && qqbot.clientSecret),
        },
      ],
      qqbot: {
        appId: qqbot.appId || undefined,
        configured: Boolean(qqbot.appId && qqbot.clientSecret),
        secretConfigured: Boolean(qqbot.clientSecret),
        sandbox: qqbot.sandbox,
        intents: qqbot.intents,
        baseUrl: qqbot.baseUrl || undefined,
        allowOpenids: [...qqbotAllowed],
        pendingUsers: settings.qqbot.pendingUsers.map((entry) => ({ ...entry })),
      },
      adapter: adapterStatus,
      supportsProactive: adapter.supportsProactive !== false,
      supportsAttention: adapter.supportsAttention !== false,
      switching: Boolean(switchingChannel),
    }
  }

  /** 保存面板提交的 QQ 官方机器人凭据；空 secret 表示保留原值。 */
  function applyQQBotPatch(patch) {
    if (!isObject(patch)) return false
    let changed = false
    if ('appId' in patch) {
      const next = String(patch.appId ?? '').trim()
      if (next !== settings.qqbot.appId) {
        settings.qqbot.appId = next
        changed = true
      }
    }
    if (typeof patch.clientSecret === 'string' && patch.clientSecret.trim()) {
      const next = patch.clientSecret.trim()
      if (next !== settings.qqbot.clientSecret) {
        settings.qqbot.clientSecret = next
        changed = true
      }
    }
    if (patch.clearSecret === true && settings.qqbot.clientSecret) {
      settings.qqbot.clientSecret = ''
      changed = true
    }
    if (typeof patch.sandbox === 'boolean' && patch.sandbox !== settings.qqbot.sandbox) {
      settings.qqbot.sandbox = patch.sandbox
      changed = true
    }
    if (Number.isInteger(patch.intents) && patch.intents >= 0 && patch.intents !== settings.qqbot.intents) {
      settings.qqbot.intents = patch.intents
      changed = true
    }
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim() !== (settings.qqbot.baseUrl ?? '')) {
      settings.qqbot.baseUrl = patch.baseUrl.trim() || undefined
      changed = true
    }
    return changed
  }

  function recordPendingUser(inbound) {
    if (settings.channel !== 'qqbot') return { added: false }
    const userId = String(inbound?.userId ?? '').trim()
    if (!userId) return { added: false }
    // 已授权用户被 allowGroups 等二级规则拒绝时，不应重新进入待审批列表。
    if (allowed.has(userId) || qqbotAllowed.has(userId)) return { added: false }
    if (settings.qqbot.pendingUsers.some((entry) => entry.userId === userId)) return { added: false }
    const entry = {
      userId,
      ...(typeof inbound.userName === 'string' && inbound.userName ? { userName: inbound.userName } : {}),
      ...(typeof inbound.meta?.eventType === 'string' && inbound.meta.eventType
        ? { eventType: inbound.meta.eventType }
        : {}),
      at: formatLocalIso(clock.now()),
    }
    settings.qqbot.pendingUsers = [entry, ...settings.qqbot.pendingUsers].slice(0, 10)
    persistChannelFile()
    writeStatus()
    return { added: true, entry }
  }

  /** 首次私聊的未知 openid 只回一条固定提示，不回复人设/记忆内容。 */
  async function notifyPendingUser(inbound) {
    if (inbound?.meta?.messageType !== 'private') return
    const userId = String(inbound.userId)
    try {
      const outbound = createOutbound({
        text: `（轻轻抬眼看了一下）这个 QQ 账号还没有进入可交谈名单。请主人在 Web UI 左侧「模型」→「QQ 接入通道」里批准 openid：${userId}`,
        userId,
        channel: 'qq',
        adapterId: adapter.id,
        replyTo: inbound.id,
      })
      await adapter.send(outbound)
    } catch (error) {
      logger?.warn?.(`[qq] 发送 QQ 官方机器人待审批提示失败：${error?.message ?? error}`)
    }
  }

  function delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }

  /**
   * 切换 QQ 接入通道并重连。NapCat ↔ 官方机器人可随时切换，不需要重载插件。
   * @param {'napcat'|'qqbot'} value
   * @param {{qqbot?: object}} [options]
   */
  async function setChannel(value, options = {}) {
    const next = normalizeChannelId(value)
    if (!next) throw new Error(`未知的 QQ 通道：${value}`)
    if (switchingChannel) throw new Error('QQ 通道正在切换，请稍候')
    if (next === 'napcat' && (!settings.botQQ || settings.allowUsers.length === 0)) {
      throw new Error('NapCat 通道未配置 botQQ / allowUsers，请先修改插件配置')
    }
    const credentialsChanged = options.qqbot !== undefined ? applyQQBotPatch(options.qqbot) : false
    if (next === settings.channel && !credentialsChanged) return channelState()

    const previous = adapter
    // 先构造新适配器：构造失败时旧连接仍保持原状。
    const nextAdapter = buildAdapter(next)
    const task = (async () => {
      try {
        await previous?.stop?.()
      } catch (error) {
        logger?.warn?.(`[qq] 关闭旧通道失败：${error?.message ?? error}`)
      }
      settings.channel = next
      if (next === 'qqbot') stopAttention()
      persistChannelFile()
      adapter = nextAdapter
      logger?.info?.(`[qq] 正在切换到 ${channelLabel()} 通道`)
      const startPromise = Promise.resolve()
        .then(() => adapter.start(adapterHandlers))
        .catch((error) => {
          lastError = error?.message ?? String(error)
          logger?.error?.(`[qq] ${channelLabel()} 通道启动失败：${lastError}`)
        })
      await Promise.race([startPromise, delay(1500)])
      writeStatus()
      return channelState()
    })()
    switchingChannel = task
    try {
      const state = await task
      return { ...state, switching: false }
    } finally {
      if (switchingChannel === task) switchingChannel = undefined
    }
  }

  function allowQQBotUser(openid) {
    const id = String(openid ?? '').trim()
    if (!id || id.length > 200) throw new Error('openid 无效')
    qqbotAllowed.add(id)
    settings.qqbot.allowOpenids = [...qqbotAllowed]
    settings.qqbot.pendingUsers = settings.qqbot.pendingUsers.filter((entry) => entry.userId !== id)
    persistChannelFile()
    writeStatus()
    logger?.info?.(`[qq] QQ 官方机器人已批准 openid：${id}`)
    return channelState()
  }

  function denyQQBotUser(openid) {
    const id = String(openid ?? '').trim()
    if (!id) throw new Error('openid 无效')
    qqbotAllowed.delete(id)
    settings.qqbot.allowOpenids = [...qqbotAllowed]
    settings.qqbot.pendingUsers = settings.qqbot.pendingUsers.filter((entry) => entry.userId !== id)
    persistChannelFile()
    writeStatus()
    return channelState()
  }

  /** 处理一条入站消息（立即生成回复；连续消息不再做防抖合并）。 */
  async function handleInbound(inbound) {
    if (!isAllowed(inbound)) {
      // QQ 官方机器人用 openid 标识用户，和 NapCat 的 QQ 号白名单不通用。
      // 第一次收到私聊时记录到待审批列表，并回一条固定提示；批准后才进入人设回复。
      if (settings.channel === 'qqbot') {
        const pending = recordPendingUser(inbound)
        if (pending.added) await notifyPendingUser(inbound)
      }
      return { accepted: false, reason: 'not_allowed', inbound }
    }
    if (!rememberMessageId(inbound.id)) {
      return { accepted: false, reason: 'duplicate', inbound }
    }
    const userId = String(inbound.userId)
    const at = Number.isFinite(inbound.receivedAt) ? inbound.receivedAt : clock.now()
    // 主人真的发消息了：取消「持续关注」计时，避免主动搭话和正常回复撞车。
    clearAttention(userId)
    lastInboundAt = clock.now()
    // 生图实例已启动时，聊天活动会延长它的空闲关闭倒计时。
    imagegen?.touchActivity?.()
    let ingest
    try {
      ingest = memory.ingestMessage({
        text: inbound.text,
        messageId: inbound.id,
        role: 'user',
        at,
        sessionId: `qq:${userId}`,
        // 会话原文由 recordConversationTurn 完整保存；这里不再拆成模糊的自动抽取事实
        autoExtract: false,
        // 先回复；短期溢出整理延后到发送之后，避免拖慢回复。
        deferOverflow: true,
      })
    } catch (error) {
      logger?.warn?.(`[qq] 写入记忆失败：${error?.message ?? error}`)
      ingest = { created: [], mentioned: [], skipped: true }
    }

    const task = (queues.get(userId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const history = sessions.get(userId)
        try {
          const imageList = Array.isArray(inbound.meta?.images) ? inbound.meta.images : []
          let imageRefs = []
          let imageErrors = []
          if (imageList.length > 0) {
            const prepared = await prepareImageRefs(imageList, {
              attachments,
              fetchImpl: deps.fetchImpl,
              maxImages: settings.imageMaxCount,
              logger,
            })
            imageRefs = prepared.refs
            imageErrors = prepared.errors
          }
          const faces = Array.isArray(inbound.meta?.faces) ? inbound.meta.faces : []
          // 生图触发判断和回复生成并行，避免串行多等一次模型调用。
          const imageTriggerPromise = imagegen
            ? imagegen.detectTrigger({ userId, userText: inbound.text, history })
            : undefined
          const reply = await replyEngine.generate({
            text: inbound.text,
            history,
            images: imageRefs,
            imageCount: imageRefs.length,
            faces,
          })
          // 触发后先启动生图任务，再发送文字回复；图片生成完后再补发图片。
          let imagePromise
          if (imagegen && imageTriggerPromise) {
            try {
              const trigger = await imageTriggerPromise
              if (trigger?.shouldGenerate) {
                imagePromise = imagegen
                  .generate({
                    userId,
                    userText: inbound.text,
                    replyText: reply.text,
                    history,
                    trigger,
                    at,
                  })
                  .catch((error) => {
                    logger?.warn?.(`[qq] 生图失败：${error?.message ?? error}`)
                    return undefined
                  })
              }
            } catch (error) {
              logger?.warn?.(`[qq] 生图触发等待失败：${error?.message ?? error}`)
            }
          }
          // 先把文字回复发出去；会话记忆与 LLM 整理放到发送之后，避免记忆维护拖慢回复。
          const bubble = await sendBubbles({
            text: reply.text,
            userId,
            groupId: inbound.meta?.groupId,
            replyTo: inbound.id,
            sessionId: `qq:${userId}`,
          })
          sessions.append(userId, 'user', inbound.text, at)
          sessions.append(userId, 'assistant', reply.text, clock.now())
          let conversation
          if (typeof memory.recordConversationTurn === 'function') {
            try {
              conversation = memory.recordConversationTurn({
                sessionId: `qq:${userId}`,
                userText: inbound.text,
                assistantText: reply.text,
                atUser: at,
                atAssistant: clock.now(),
              })
            } catch (error) {
              logger?.warn?.(`[qq] 写入会话话题记忆失败：${error?.message ?? error}`)
            }
          }
          lastActivityAt = formatLocalIso(clock.now())
          lastError = undefined
          // 回复已经发出，再做短期溢出整理（不阻塞回复）。
          try {
            memory.organizeShortTermOverflow?.({ at: clock.now() })
          } catch (error) {
            logger?.warn?.(`[qq] 延后整理短期记忆失败：${error?.message ?? error}`)
          }
          let imageSent = false
          let imagePath
          if (imagePromise) {
            try {
              const generated = await imagePromise
              if (generated?.imagePath) {
                imagePath = generated.imagePath
                const title = generated.format?.title ? `「${generated.format.title}」` : ''
                await sendImage({
                  userId,
                  filePath: generated.imagePath,
                  caption: `（把刚画好的画面递过来）${title}`,
                  sessionId: `qq:${userId}`,
                  replyTo: inbound.id,
                })
                imageSent = true
              }
            } catch (error) {
              logger?.warn?.(`[qq] 发送生成图失败：${error?.message ?? error}`)
            }
          }
          // 后台：LLM 分类/关键词/事件分段，并刷新会话记忆与图片/视频记忆。
          const conversationId = conversation?.item?.id
          if (memoryAnalyzer) {
            void (async () => {
              const memoryAnalysis = await memoryAnalyzer.analyze({
                content: `主人：${inbound.text}\n奥菲莉亚：${reply.text}`,
                kindHint: imageRefs.length > 0 ? 'image' : 'auto',
                source: 'qq',
                images: imageRefs,
              })
              if (!memoryAnalysis) return
              if (conversationId && typeof memory.applyMetadataUpdates === 'function') {
                memory.applyMetadataUpdates(
                  [{
                    id: conversationId,
                    category: memoryAnalysis.category,
                    keywords: memoryAnalysis.keywords,
                    summary: memoryAnalysis.summary,
                    metadata: { ...memoryAnalysis, llm: true },
                  }],
                  { reason: 'QQ 单轮对话 LLM 记忆整理' },
                )
              }
              if (typeof memory.remember === 'function') {
                if (memoryAnalysis.kind === 'event' && memoryAnalysis.segments?.length > 1) {
                  for (const segment of memoryAnalysis.segments) {
                    memory.remember({
                      content: `【事件】${segment.who}｜${segment.when}｜${segment.where}｜${segment.what}\n${segment.content}`,
                      keywords: [segment.who, segment.when, segment.where, segment.what].filter((word) => word && word !== '不知道'),
                      category: memoryAnalysis.category,
                      summary: `${segment.who}｜${segment.when}｜${segment.where}｜${segment.what}`,
                      source: 'qq-segment',
                      metadata: { ...memoryAnalysis, llm: true, segment: true },
                      at,
                    })
                  }
                } else if ((memoryAnalysis.kind === 'image' || memoryAnalysis.kind === 'video') && memoryAnalysis.described) {
                  memory.remember({
                    content: `【${memoryAnalysis.kind === 'image' ? '图片' : '视频'}】${memoryAnalysis.described}`,
                    keywords: memoryAnalysis.keywords,
                    category: memoryAnalysis.category,
                    summary: memoryAnalysis.summary,
                    source: `qq-${memoryAnalysis.kind}`,
                    metadata: { ...memoryAnalysis, llm: true },
                    at,
                  })
                }
              }
            })().catch((error) => logger?.warn?.(`[qq] 后台记忆整理失败：${error?.message ?? error}`))
          }
          return {
            accepted: true,
            inbound,
            ingest,
            conversation,
            reply: reply.text,
            bubbles: bubble.bubbles,
            sent: bubble.sent,
            imageCount: imageList.length,
            imageRefs: imageRefs.length,
            imageErrors,
            imageGenerated: imageSent,
            imagePath,
            webSearchUsed: reply.webSearchUsed === true,
            webSearchQuery: reply.webSearchQuery,
          }
        } catch (error) {
          lastError = error?.message ?? String(error)
          logger?.error?.(`[qq] 生成/发送回复失败（${userId}）：${lastError}`)
          return { accepted: true, inbound, ingest, error: lastError }
        }
      })

    queues.set(userId, task.catch(() => {}))
    return task
  }

  async function start() {
    if (started) return adapterStatusSnapshot()
    started = true
    const status = await adapter.start(adapterHandlers)
    if (settings.channel === 'qqbot') {
      if (status?.state === 'awaiting_config') {
        logger?.warn?.('[qq] QQ 官方机器人通道未配置 AppID / AppSecret，请到 Web UI「模型」→「QQ 接入通道」填写')
      } else {
        logger?.info?.(`[qq] QQ 官方机器人通道已启动：appId=${settings.qqbot.appId || '未配置'}（sandbox=${settings.qqbot.sandbox}）`)
      }
    } else {
      logger?.info?.(`[qq] OneBot 通道已启动：${settings.onebotUrl}（bot=${settings.botQQ}，白名单=${[...allowed].join(',')}）`)
    }
    return status
  }

  async function stop() {
    started = false
    stopProactive()
    stopAttention()
    try {
      await imagegen?.close?.()
    } catch (error) {
      logger?.warn?.(`[qq] 关闭生图服务失败：${error?.message ?? error}`)
    }
    return adapter.stop()
  }

  /** 当前 QQ 回复实际使用的模型路由（供 status 查看）。 */
  function currentReplyModel() {
    try {
      const route = typeof replyEngine.resolveRoute === 'function' ? replyEngine.resolveRoute() : undefined
      if (route && typeof route === 'object') {
        return { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) }
      }
    } catch {
      // 忽略读取失败
    }
    return undefined
  }

  /** 插件配置里的回退模型（删除覆盖文件后使用）。 */
  function configuredReplyModel() {
    if (!settings.provider || !settings.model) return null
    return {
      provider: settings.provider,
      model: settings.model,
      ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    }
  }

  /** 模型面板读取的完整状态。 */
  function replyModelState() {
    return {
      current: currentReplyModel() ?? null,
      override: replyModelOverride ? { ...replyModelOverride } : null,
      fallback: configuredReplyModel(),
      file: replyModelFile,
      updatedAt: replyModelUpdatedAt,
    }
  }

  /**
   * 切换 QQ 聊天模型：写入角色目录并立即生效，不需要重载插件。
   * @param {{provider:string, model:string, reasoningEffort?:string}} value
   */
  function setReplyModel(value) {
    const route = normalizeReplyModel(value)
    if (!route) throw new Error('provider/model 不能为空')
    const updatedAt = formatLocalIso(clock.now())
    ensureDirSync(path.dirname(replyModelFile))
    writeJsonSync(replyModelFile, {
      schemaVersion: 1,
      ...route,
      updatedAt,
    })
    replyModelOverride = route
    replyModelUpdatedAt = updatedAt
    writeStatus()
    logger?.info?.(`[qq] 聊天模型已切换：${route.provider}/${route.model}`)
    return replyModelState()
  }

  /** 删除覆盖文件，回到插件配置里的模型。 */
  function resetReplyModel() {
    try {
      fs.unlinkSync(replyModelFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    replyModelOverride = undefined
    replyModelUpdatedAt = undefined
    writeStatus()
    logger?.info?.('[qq] 已恢复插件配置中的聊天模型')
    return replyModelState()
  }

  function status() {
    return {
      plugin: name,
      characterId: settings.characterId,
      dataDir,
      channel: settings.channel,
      channelLabel: channelLabel(),
      botQQ: settings.botQQ,
      allowUsers: [...allowed],
      onebotUrl: settings.onebotUrl,
      qqbot: {
        appId: settings.qqbot.appId || undefined,
        configured: Boolean(settings.qqbot.appId && settings.qqbot.clientSecret),
        sandbox: settings.qqbot.sandbox,
        intents: settings.qqbot.intents,
        allowOpenids: [...qqbotAllowed],
        pendingUsers: settings.qqbot.pendingUsers.map((entry) => ({ ...entry })),
      },
      adapter: adapterStatusSnapshot(),
      replyModel: currentReplyModel(),
      replyModelSource: replyModelOverride ? 'override' : 'config',
      replyModelOverride: replyModelOverride ?? undefined,
      started,
      users: Object.keys(sessions.snapshot().users),
      features: {
        webSearch: Boolean(web && typeof web.search === 'function'),
        webFetch: Boolean(web && typeof web.fetch === 'function'),
        vision: Boolean(attachments && typeof attachments.saveImages === 'function'),
        bubbles: true,
        proactive: settings.proactiveEnabled && adapter.supportsProactive !== false,
        attention: settings.attentionEnabled && adapter.supportsAttention !== false,
        imagegen: Boolean(imagegen?.enabled),
      },
      proactive: {
        enabled: settings.proactiveEnabled && adapter.supportsProactive !== false,
        started: proactiveStarted,
        lastAt: lastProactiveAt,
        lastError: lastProactiveError,
      },
      attention: {
        enabled: settings.attentionEnabled && adapter.supportsAttention !== false,
        thresholdMs: settings.attentionThresholdMs,
        cooldownMs: settings.attentionCooldownMs,
        lastAt: lastAttentionAt,
      },
      imagegen: imagegen?.status?.(),
    }
  }

  /** 把运行状态写到 <角色目录>/qq/status.json，方便用户/验收核查连接情况。 */
  function writeStatus() {
    try {
      ensureDirSync(path.dirname(statusFile))
      writeJsonSync(statusFile, {
        plugin: name,
        updatedAt: formatLocalIso(clock.now()),
        started,
        channel: settings.channel,
        channelLabel: channelLabel(),
        botQQ: settings.botQQ,
        allowUsers: [...allowed],
        onebotUrl: settings.onebotUrl,
        qqbot: {
          appId: settings.qqbot.appId || undefined,
          configured: Boolean(settings.qqbot.appId && settings.qqbot.clientSecret),
          sandbox: settings.qqbot.sandbox,
          intents: settings.qqbot.intents,
          allowOpenids: [...qqbotAllowed],
          pendingUsers: settings.qqbot.pendingUsers.map((entry) => ({ ...entry })),
        },
        adapter: adapterStatusSnapshot(),
        replyModel: currentReplyModel(),
        replyModelSource: replyModelOverride ? 'override' : 'config',
        replyModelOverride: replyModelOverride ?? undefined,
        replyModelUpdatedAt,
        users: Object.keys(sessions.snapshot().users),
        features: {
          webSearch: Boolean(web && typeof web.search === 'function'),
        webFetch: Boolean(web && typeof web.fetch === 'function'),
          vision: Boolean(attachments && typeof attachments.saveImages === 'function'),
          bubbles: true,
          proactive: settings.proactiveEnabled && adapter.supportsProactive !== false,
          attention: settings.attentionEnabled && adapter.supportsAttention !== false,
          imagegen: Boolean(imagegen?.enabled),
        },
        proactive: {
          enabled: settings.proactiveEnabled && adapter.supportsProactive !== false,
          started: proactiveStarted,
          lastAt: lastProactiveAt,
          lastError: lastProactiveError,
        },
        imagegen: imagegen?.status?.(),
        lastActivityAt: lastActivityAt === undefined ? undefined : lastActivityAt,
        lastError: lastError === undefined ? undefined : lastError,
      })
    } catch {
      // 状态文件写入失败不影响运行
    }
  }

  return {
    settings,
    dataDir,
    channelFile,
    persona,
    memory,
    sessions,
    replyEngine,
    get adapter() {
      return adapter
    },
    web,
    attachments,
    statusFile,
    handleInbound,
    handleNotice,
    stopAttention,
    isAllowed,
    ensureTodayPlan,
    checkLifeEvents,
    startProactive,
    stopProactive,
    start,
    stop,
    status,
    writeStatus,
    getChannelState: channelState,
    setChannel,
    allowQQBotUser,
    denyQQBotUser,
    getReplyModelState: replyModelState,
    setReplyModel,
    resetReplyModel,
  }
}

/**
 * Host 插件入口。
 * @param {any} ctx Cordis 上下文
 * @param {object} config Loader 行配置
 */
export function apply(ctx, config = {}) {
  const llm = ctx.get('llm')
  if (!llm) {
    ctx.logger?.error?.('[qq] 缺少 ctx.llm 服务，QQ 通道未启动')
    return undefined
  }
  const agentDefaultModel = ctx.get('agentDefaultModel')
  const web = ctx.get('web')
  const attachments = ctx.get('attachments')
  if (!web) ctx.logger?.warn?.('[qq] 未找到 ctx.web 服务：QQ 联网搜索将不可用（Web GUI 内仍可用 web_search 工具）')
  if (!attachments) ctx.logger?.warn?.('[qq] 未找到 ctx.attachments 服务：QQ 图片/表情包识别将不可用')
  let host
  try {
    host = createQQHost({
      config,
      deps: {
        llm,
        web,
        attachments,
        modelSelection: agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function' ? () => agentDefaultModel.currentSelection() : undefined,
        logger: ctx.logger,
      },
    })
  } catch (error) {
    ctx.logger?.error?.(`[qq] 初始化失败：${error?.message ?? error}`)
    return undefined
  }
  // Web UI 的「模型」面板通过这两组路由读取/切换 QQ 聊天模型与接入通道。
  // 冷启动时 webServer 可能还没就绪，attach 会等它出现后再注册路由。
  attachQQModelRoutes(ctx, host, { logger: ctx.logger })
  attachQQChannelRoutes(ctx, host, { logger: ctx.logger })
  ctx.effect(() => {
    host
      .start()
      .then(() => {
        host.writeStatus()
        return host.startProactive()
      })
      .catch((error) => ctx.logger?.error?.(`[qq] 启动失败：${error?.message ?? error}`))
    const statusTimer = setInterval(() => host.writeStatus(), 10000)
    statusTimer.unref?.()
    return () => {
      clearInterval(statusTimer)
      host.stopProactive()
      host.stop().catch(() => {})
    }
  })
  return host
}
