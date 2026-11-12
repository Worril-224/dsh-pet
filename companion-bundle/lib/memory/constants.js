/**
 * 记忆模块常量与默认配置。
 * 仅依赖 node:* 内置模块与包内相对路径（bundle 不能依赖任何 npm 包）。
 */
import os from 'node:os'
import path from 'node:path'

/** 长期记忆层数。 */
export const LONG_TERM_LAYERS = 7

/** 短期记忆层级标识。 */
export const SHORT_LAYER = 'short'

/**
 * 默认数据目录（与 Host / Preset 插件配置保持一致，SPEC 第 2 节）。
 * 可移植：优先环境变量 DSH_PET_DATA_DIR，否则使用 ~/.dsh/dsh-pet/companion-data。
 */
export const DEFAULT_DATA_DIR =
  process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')

/** 持久化文件 schema 版本。 */
export const SCHEMA_VERSION = 1

/** 长期记忆每层下沉所需「未提及整天数」阈值（SPEC 4.9）。 */
export const DECAY_DAYS = [1, 3, 7, 14, 30, 140]

/** 记忆分类固定枚举（SPEC 4.4）。 */
export const MEMORY_CATEGORIES = ['喜好', '身份', '人际', '事件', '情绪', '承诺', '计划', '健康', '工作学习', '其他']

/** 默认记忆配置（SPEC 4.8 / 4.9 / 4.13）。 */
export const DEFAULT_MEMORY_CONFIG = Object.freeze({
  shortTermCapacity: 20,
  // 2026-11-06 会话记忆：短期记忆按字数上限而不是纯条数控制
  shortTermCharLimit: 50000,
  topicMemoryMaxChars: 10000,
  topicCompressionTargetRatio: 0.75,
  conversationTopicGapMinutes: 30,
  shortTermOverflowMoveRatio: 0.5,
  conversationSource: 'qq-conversation',
  promotionMentionDelta: 1,
  emphasisWords: Object.freeze(['很重要', '记住', '别忘', '最喜欢', '答应', '承诺']),
  keepRatio: 0.5,
  contextPressureKeepRatio: 0.5,
  digestMaxChars: 30000,
  digestShortLimit: 100,
  digestLongLimit: 100,
  recallLimit: 50,
  autoExtractLimit: 5,
  processedMessageIdLimit: 200,
  maintenanceHistoryLimit: 30,
  minKeywords: 3,
  maxKeywords: 12,
  // 层级压缩：非背景故事记忆从第 3 层开始，每次下沉进入下一层时压缩为原来的 75%。
  layerCompactionRatio: 0.75,
  layerCompactionStartLayer: 3,
  layerCompactionMinChars: 12,
  backgroundStorySources: Object.freeze(['persona-history']),
  backgroundStorySourcePrefixes: Object.freeze(['story:']),
})

/**
 * 合并用户配置与默认配置：数组深拷贝、数值兜底修正。
 * @param {object} [config]
 * @returns {object}
 */
export function resolveConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const merged = { ...DEFAULT_MEMORY_CONFIG, ...source }
  merged.emphasisWords =
    Array.isArray(source.emphasisWords) && source.emphasisWords.length > 0
      ? source.emphasisWords.map((word) => String(word)).filter(Boolean)
      : [...DEFAULT_MEMORY_CONFIG.emphasisWords]

  const toNumber = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  merged.shortTermCapacity = Math.max(1, Math.round(toNumber(merged.shortTermCapacity, 20)))
  merged.promotionMentionDelta = Math.max(1, Math.round(toNumber(merged.promotionMentionDelta, 1)))
  merged.keepRatio = Math.min(1, Math.max(0, toNumber(merged.keepRatio, 0.5)))
  merged.contextPressureKeepRatio = Math.min(1, Math.max(0, toNumber(merged.contextPressureKeepRatio, merged.keepRatio)))
  merged.digestMaxChars = Math.max(40, Math.round(toNumber(merged.digestMaxChars, 1600)))
  merged.digestShortLimit = Math.max(1, Math.round(toNumber(merged.digestShortLimit, 8)))
  merged.digestLongLimit = Math.max(1, Math.round(toNumber(merged.digestLongLimit, 4)))
  merged.recallLimit = Math.max(1, Math.round(toNumber(merged.recallLimit, 50)))
  merged.autoExtractLimit = Math.max(1, Math.round(toNumber(merged.autoExtractLimit, 5)))
  merged.processedMessageIdLimit = Math.max(1, Math.round(toNumber(merged.processedMessageIdLimit, 200)))
  merged.maintenanceHistoryLimit = Math.max(1, Math.round(toNumber(merged.maintenanceHistoryLimit, 30)))
  merged.minKeywords = 3
  merged.maxKeywords = Math.max(merged.minKeywords, Math.round(toNumber(merged.maxKeywords, 12)))
  merged.shortTermCharLimit = Math.max(1000, Math.round(toNumber(merged.shortTermCharLimit, 50000)))
  merged.topicMemoryMaxChars = Math.max(1000, Math.round(toNumber(merged.topicMemoryMaxChars, 10000)))
  merged.topicCompressionTargetRatio = Math.min(
    1,
    Math.max(0.1, toNumber(merged.topicCompressionTargetRatio, 0.75)),
  )
  merged.conversationTopicGapMinutes = Math.max(
    1,
    Math.round(toNumber(merged.conversationTopicGapMinutes, 30)),
  )
  merged.shortTermOverflowMoveRatio = Math.min(
    1,
    Math.max(0.1, toNumber(merged.shortTermOverflowMoveRatio, 0.5)),
  )
  merged.conversationSource =
    typeof merged.conversationSource === 'string' && merged.conversationSource.trim()
      ? merged.conversationSource.trim()
      : 'qq-conversation'
  merged.layerCompactionRatio = Math.min(1, Math.max(0.1, toNumber(merged.layerCompactionRatio, 0.75)))
  merged.layerCompactionStartLayer = Math.max(
    1,
    Math.min(LONG_TERM_LAYERS, Math.round(toNumber(merged.layerCompactionStartLayer, 3))),
  )
  merged.layerCompactionMinChars = Math.max(1, Math.round(toNumber(merged.layerCompactionMinChars, 12)))
  merged.backgroundStorySources =
    Array.isArray(source.backgroundStorySources) && source.backgroundStorySources.length > 0
      ? source.backgroundStorySources.map((item) => String(item)).filter(Boolean)
      : [...DEFAULT_MEMORY_CONFIG.backgroundStorySources]
  merged.backgroundStorySourcePrefixes =
    Array.isArray(source.backgroundStorySourcePrefixes)
      ? source.backgroundStorySourcePrefixes.map((item) => String(item)).filter(Boolean)
      : [...DEFAULT_MEMORY_CONFIG.backgroundStorySourcePrefixes]
  return merged
}
