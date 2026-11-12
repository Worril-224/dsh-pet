/**
 * 记忆条目模型：重要性/清晰度公式（SPEC 4.2）、条目创建、拷贝与派生字段重算。
 */
import { LONG_TERM_LAYERS } from './constants.js'

/** 数值夹取。 */
export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/**
 * 重要度公式（SPEC 4.2）：
 * importance = clamp(1, 100, round(
 *   20 + 10 * min(mentionCount, 6) + 10 * min(emphasis, 3)
 *      + (layer === 'short' ? 0 : (7 - layer) * 4)
 * ))
 */
export function computeImportance(item = {}) {
  const mentionCount = Number.isFinite(Number(item.mentionCount)) ? Number(item.mentionCount) : 0
  const emphasis = Number.isFinite(Number(item.emphasis)) ? Number(item.emphasis) : 0
  const layer = item.layer
  const layerBonus = layer === 'short' ? 0 : (LONG_TERM_LAYERS - Number(layer)) * 4
  const raw = 20 + 10 * Math.min(mentionCount, 6) + 10 * Math.min(emphasis, 3) + layerBonus
  return clamp(Math.round(raw), 1, 100)
}

/** 清晰度公式（SPEC 4.2）：clarity = round(clamp(0.15, 1, importance / 100) * 100) / 100。 */
export function computeClarity(importance) {
  return Math.round(clamp(Number(importance) / 100, 0.15, 1) * 100) / 100
}

/** 重新计算条目的 importance / clarity 派生字段。 */
export function recomputeDerived(item) {
  item.importance = computeImportance(item)
  item.clarity = computeClarity(item.importance)
  return item
}

/** 一天毫秒数（层级估算用）。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 按「事件发生时间」估算应该写入的层（功能3：人设个人经历按时间导入记忆区）。
 *
 * 规则（从最近到最久远）：
 * - 距今 <= 1 天（含未来时间）：短期记忆；
 * - <= 7 天：第一层；<= 14 天：第二层；<= 30 天：第三层；<= 60 天：第四层；
 * - <= 90 天：第五层；<= 140 天：第六层；> 140 天：第七层；
 * - 缺少 / 非法 occurredAt：短期记忆（与 remember 默认写入短期记忆保持一致）。
 *
 * @param {string|number|Date|undefined|null} occurredAt 事件发生时间（ISO 字符串 / 毫秒 / Date）
 * @param {number} [nowMs] 当前时刻毫秒（默认 Date.now()，测试可注入固定时钟）
 * @returns {'short'|1|2|3|4|5|6|7}
 */
export function estimateLayerByOccurredAt(occurredAt, nowMs = Date.now()) {
  if (occurredAt === undefined || occurredAt === null || occurredAt === '') return 'short'
  let occurredMs
  if (occurredAt instanceof Date) occurredMs = occurredAt.getTime()
  else if (typeof occurredAt === 'number') occurredMs = occurredAt
  else occurredMs = Date.parse(String(occurredAt))
  if (!Number.isFinite(occurredMs)) return 'short'
  const base = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const days = Math.max(0, Math.floor((base - occurredMs) / DAY_MS))
  if (days <= 1) return 'short'
  if (days <= 7) return 1
  if (days <= 14) return 2
  if (days <= 30) return 3
  if (days <= 60) return 4
  if (days <= 90) return 5
  if (days <= 140) return 6
  return 7
}

/** 记忆生成时间（本地日期 `YYYY-MM-DD`，用于时间关键词与展示）。 */
export function memoryCreatedDate(at) {
  const ms = typeof at === 'number' ? at : Date.parse(String(at ?? ''))
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 把“生成时间”作为一个独立 keyword 追加；最多保留 max 个关键词，优先保留时间。 */
export function withCreatedTimeKeyword(keywords, at, max = 12) {
  const time = memoryCreatedDate(at)
  const list = (Array.isArray(keywords) ? keywords : []).filter(
    (word) => typeof word === 'string' && word.trim() && word !== time,
  )
  if (!time) return list.slice(0, max)
  if (list.length >= max) return [...list.slice(0, max - 1), time]
  return [...list, time]
}

/** 深拷贝记忆条目，避免调用方修改引擎内部状态。 */
export function cloneItem(item) {
  if (!item) return item
  return {
    id: item.id,
    content: item.content,
    summary: item.summary,
    keywords: Array.isArray(item.keywords) ? [...item.keywords] : [],
    category: item.category,
    mentionCount: item.mentionCount,
    emphasis: item.emphasis,
    importance: item.importance,
    clarity: item.clarity,
    createdAt: item.createdAt,
    firstSeenAt: item.firstSeenAt,
    lastMentionedAt: item.lastMentionedAt,
    occurredAt: item.occurredAt,
    layer: item.layer,
    mentionCountAtLastMaintenance: item.mentionCountAtLastMaintenance,
    lastLayerChangeAt: item.lastLayerChangeAt,
    history: Array.isArray(item.history) ? item.history.map((entry) => ({ ...entry })) : [],
    source: item.source,
    backgroundStory: item.backgroundStory,
    metadata: item.metadata && typeof item.metadata === 'object' ? JSON.parse(JSON.stringify(item.metadata)) : undefined,
    kind: item.kind,
    sessionId: item.sessionId,
    topicId: item.topicId,
    topicLabel: item.topicLabel,
    turnCount: item.turnCount,
    startedAt: item.startedAt,
    lastTurnAt: item.lastTurnAt,
    charCount: item.charCount,
    compression: item.compression ? { ...item.compression } : undefined,
    compaction: item.compaction
      ? {
          ...item.compaction,
        }
      : undefined,
  }
}

/**
 * 构造记忆条目（字段顺序与 SPEC 4.1 一致；occurredAt 为功能3新增的可选字段）。
 * 新记忆默认进入短期记忆，创建即算第一次提及（mentionCount = 1）。
 */
export function createMemoryItem({
  id,
  content,
  summary,
  keywords,
  category,
  at,
  occurredAt,
  createdAt,
  source,
  metadata,
  layer = 'short',
  mentionCount = 1,
  emphasis = 0,
  mentionCountAtLastMaintenance = undefined,
  importanceOverride = undefined,
}) {
  const item = {
    id,
    content,
    summary,
    keywords: withCreatedTimeKeyword(keywords, createdAt ?? at, 12),
    category,
    mentionCount,
    emphasis: clamp(Math.round(emphasis), 0, 3),
    importance: 0,
    clarity: 0,
    createdAt: createdAt ?? at,
    firstSeenAt: at,
    lastMentionedAt: at,
    occurredAt,
    layer,
    mentionCountAtLastMaintenance:
      mentionCountAtLastMaintenance === undefined ? mentionCount : mentionCountAtLastMaintenance,
    lastLayerChangeAt: null,
    history: [],
    source,
    compaction: undefined,
    metadata: metadata && typeof metadata === 'object' ? JSON.parse(JSON.stringify(metadata)) : undefined,
  }
  recomputeDerived(item)
  if (importanceOverride !== undefined && importanceOverride !== null) {
    item.importance = clamp(Math.round(importanceOverride), 1, 100)
    item.clarity = computeClarity(item.importance)
  }
  return item
}

/** 记忆编号比较（em-000001 形式，按数字序）。 */
export function compareItemId(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true })
}
