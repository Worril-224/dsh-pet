/**
 * companion-core：Agent 预设作用域插件。
 *
 * 在一个「情感陪伴」预设的会话内：
 *  1. 用本地人设文件渲染【人设 · 始终生效】段，shadow Harness 全局人格段；
 *  2. 每步注入动态记忆上下文（近期短期记忆 + 与当前话题相关的长期记忆 + 概况）；
 *  3. 注册陪伴工具 persona_lookup / memory_recall / memory_note / memory_status / persona_status；
 *  4. 监听用户消息，写入记忆引擎（提及计数 / 自动抽取）。
 *
 * 本包不依赖任何 npm 包，只使用 Node 内置模块与包内相对导入。
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPersonaService } from './persona/index.js'
import { getMemoryEngine } from './memory/index.js'
import { createCompanionTools } from './tools/companion-tools.js'
import { createMemoryAnalyzer } from './memory/analyzer.js'
import { createSystemClock } from './shared/clock.js'
import { existsSync } from './shared/fsutil.js'
import { DEFAULT_CHARACTERS_DIR, characterDataDir, resolveCharactersRoot } from './characters.js'

/** Loader 插件名。 */
export const name = 'companion-core'

/** 本插件依赖的 Host 服务。 */
export const inject = ['systemPrompt', 'tools']

/** 兼容旧版单目录模式的默认数据目录（可移植：DSH_PET_DATA_DIR 优先）。 */
export const DEFAULT_DATA_DIR =
  process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')

/** 人设默认文件（包内 data/persona.default.json）。 */
export function defaultPersonaFile() {
  return fileURLToPath(new URL('../data/persona.default.json', import.meta.url))
}

/**
 * 规范化插件配置（方案 A：一个预设对应一个角色）。
 * - `characterId` + `charactersDir` → dataDir = <charactersDir>/<characterId>（推荐）；
 * - 显式 `dataDir` → 直接使用（兼容旧配置 / 单目录模式）；
 * - `personaFile`：该角色人设文件（作为首次生成时的源文件；角色目录已有人设时不覆盖）。
 * @param {object} config Loader 行配置
 */
export function normalizeConfig(config = {}) {
  const hasDataDir = typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
  const characterId = typeof config.characterId === 'string' && config.characterId.trim() ? config.characterId.trim() : undefined
  const charactersDir = resolveCharactersRoot(
    typeof config.charactersDir === 'string' && config.charactersDir.trim() ? config.charactersDir.trim() : DEFAULT_CHARACTERS_DIR,
  )
  const dataDir = hasDataDir
    ? path.resolve(config.dataDir.trim())
    : characterId
      ? characterDataDir(charactersDir, characterId)
      : path.resolve(DEFAULT_DATA_DIR)
  const personaFile =
    typeof config.personaFile === 'string' && config.personaFile.trim()
      ? path.resolve(config.personaFile.trim())
      : undefined
  return {
    dataDir,
    charactersDir,
    characterId,
    personaFile,
  }
}

/**
 * 从 Harness 用户消息里提取纯文本。
 * @param {any} message UserMessage
 */
export function extractMessageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function safePersonaSection(persona) {
  try {
    return persona.renderPersonaSection()
  } catch (error) {
    return `【人设 · 始终生效】\n（人设文件暂时无法读取：${error?.message ?? error}。请保持温柔，并提醒主人检查人设文件。）`
  }
}

function safeMemoryDigest(memory, latestUserText) {
  try {
    return memory.renderDigest({ latestUserText: latestUserText ?? '' })
  } catch (error) {
    return `【记忆系统】\n（记忆上下文暂时不可用：${error?.message ?? error}。若需要回忆，请调用 memory_recall。）`
  }
}

/**
 * Agent 预设插件入口。
 * @param {any} ctx 该 Agent 作用域的 Cordis 上下文
 * @param {object} config Loader 行配置
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const clock = createSystemClock()

  // 防御：未知 characterId 会按默认模板初始化角色，这里明确告警，避免「以为是新人设」。
  if (settings.characterId && !existsSync(path.join(settings.dataDir, 'persona', 'persona.json'))) {
    ctx.logger?.warn?.(
      `[companion] 角色「${settings.characterId}」尚未初始化（缺少 ${path.join(settings.dataDir, 'persona', 'persona.json')}），` +
        '将按默认模板创建；建议先运行 scripts/add-character.mjs 创建角色。',
    )
  }

  let persona
  let memory
  try {
    persona = createPersonaService({
      dataDir: settings.dataDir,
      defaultPersonaFile: settings.personaFile ?? defaultPersonaFile(),
      clock,
    })
    persona.ensure()
  } catch (error) {
    // 人设加载失败不阻断会话：用兜底文案继续。
    persona = null
    ctx.logger?.error?.(`[companion] 人设加载失败：${error?.message ?? error}`)
  }

  try {
    memory = getMemoryEngine({ dataDir: settings.dataDir, clock })
    memory.ensure()
  } catch (error) {
    memory = null
    ctx.logger?.error?.(`[companion] 记忆引擎加载失败：${error?.message ?? error}`)
  }

  let latestUserText = ''

  // 1) 人设段：shadow 全局 deployment:persona-prefix。
  const sectionOrder =
    typeof ctx.systemPrompt.getSectionOrder === 'function'
      ? ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
      : 0
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'deployment:persona-prefix',
      order: typeof sectionOrder === 'number' ? sectionOrder : 0,
      text: () => (persona ? safePersonaSection(persona) : '【人设】\n（人设文件未加载）'),
      interpolate: false,
    }),
  )

  // 2) 动态记忆上下文。
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'companion:memory',
      order: 130,
      text: () =>
        memory
          ? safeMemoryDigest(memory, latestUserText)
          : '【记忆系统】\n（记忆引擎未加载；需要回忆时请先提醒主人检查插件数据目录。）',
      interpolate: false,
    }),
  )

  // 3) 陪伴工具。
  if (persona && memory) {
    try {
      const presetLlm = ctx.get('llm')
      const presetDefaultModel = ctx.get('agentDefaultModel')
      const presetModelSelection =
        presetDefaultModel && typeof presetDefaultModel.currentSelection === 'function'
          ? () => presetDefaultModel.currentSelection()
          : undefined
      const memoryAnalyzer = createMemoryAnalyzer({
        llm: presetLlm,
        modelSelection: presetModelSelection,
        logger: ctx.logger,
        maxTokens: 2400,
      })
      for (const tool of createCompanionTools({ persona, memory, analyzer: memoryAnalyzer })) {
        ctx.effect(() => ctx.tools.register(tool))
      }
    } catch (error) {
      ctx.logger?.error?.(`[companion] 工具注册失败：${error?.message ?? error}`)
    }
  }

  // 4) 用户消息写入记忆。
  const ingestUserMessage = (agent, message) => {
    if (!memory) return
    try {
      // 防御：inbox 里可能混入插件注入的 user 角色消息（例如提醒、团队消息），
      // 只把「用户本人」来源的消息写入记忆；无 source 的按用户消息处理。
      const sourceKind = message?.source?.kind
      if (typeof sourceKind === 'string' && sourceKind !== 'user') return
      const text = extractMessageText(message)
      if (!text) return
      latestUserText = text
      const messageId = typeof message?.id === 'string' ? message.id : undefined
      const sessionId = agent?.id ? `session:${agent.id}` : undefined
      memory.ingestMessage({ text, messageId, role: 'user', at: clock.now(), sessionId })
    } catch (error) {
      ctx.logger?.warn?.(`[companion] 记忆写入失败：${error?.message ?? error}`)
    }
  }

  // 主监听：消息进入收件箱。
  ctx.effect(() =>
    ctx.on('agent/inbox/inserted', (payload) => {
      ingestUserMessage(payload?.agent, payload?.message)
    }),
  )

  // 兜底监听：每一步实际进入的 user 消息（同一 messageId 由记忆引擎去重）。
  ctx.effect(() =>
    ctx.on('agent/pre-step', (payload, next) => {
      try {
        for (const message of payload?.messages ?? []) ingestUserMessage(payload?.agent, message)
      } catch {
        // 兜底失败不影响主流程
      }
      return next()
    }),
  )

  return {
    persona,
    memory,
  }
}
