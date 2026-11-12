/**
 * 记忆引擎（SPEC 4.12）：短期记忆 + 七层长期记忆、提及计数与强调、
 * 自动抽取、每日维护（夜间转移 / 上浮 / 下沉）、分级检索、上下文压缩、持久化与摘要渲染。
 * 全部方法为同步方法（数据文件很小，便于 prompt 同步渲染）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { createSystemClock, formatLocalDate, formatLocalIso, localHour, parseIso, wholeDaysBetween } from '../shared/clock.js'
import { existsSync, readJsonSync } from '../shared/fsutil.js'
import { layerLabel } from '../shared/paths.js'
import {
  DECAY_DAYS,
  LONG_TERM_LAYERS,
  MEMORY_CATEGORIES,
  SCHEMA_VERSION,
  resolveConfig,
} from './constants.js'
import {
  clamp,
  cloneItem,
  compareItemId,
  createMemoryItem,
  estimateLayerByOccurredAt,
  memoryCreatedDate,
  recomputeDerived,
  withCreatedTimeKeyword,
} from './model.js'
import { MemoryStore } from './store.js'
import { decideMaintenance, toEpochMs } from './scheduler.js'
import {
  buildSummary,
  classifyCategory,
  compactText,
  extractMemories,
  isTagKeyword,
  normalizeForDedup,
  normalizeKeywordList,
  resolveCategory,
} from './text.js'
import { buildOverviewMarkdown, renderDigestText } from './render.js'

/** 把持久化文件中的条目规范化为完整字段（重启后仍满足 M1 字段完整性）。 */
function normalizeLoadedItem(raw, fallbackLayer, nowIso) {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (!id || !content) return null
  const category = MEMORY_CATEGORIES.includes(raw.category) ? raw.category : classifyCategory(content)
  const mentionCount = Number.isFinite(Number(raw.mentionCount)) ? Math.max(0, Math.round(Number(raw.mentionCount))) : 1
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt.trim()
      ? raw.createdAt.trim()
      : typeof raw.firstSeenAt === 'string' && raw.firstSeenAt.trim()
        ? raw.firstSeenAt.trim()
        : nowIso
  const item = {
    id,
    content,
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : buildSummary(content),
    keywords: withCreatedTimeKeyword(
      normalizeKeywordList(raw.keywords, content, category, {
        max: raw.metadata && raw.metadata.llm ? 12 : 5,
      }),
      createdAt,
      12,
    ),
    category,
    mentionCount,
    emphasis: clamp(Math.round(Number(raw.emphasis) || 0), 0, 3),
    importance: 0,
    clarity: 0,
    createdAt,
    firstSeenAt: typeof raw.firstSeenAt === 'string' ? raw.firstSeenAt : nowIso,
    lastMentionedAt:
      typeof raw.lastMentionedAt === 'string'
        ? raw.lastMentionedAt
        : typeof raw.firstSeenAt === 'string'
          ? raw.firstSeenAt
          : nowIso,
    // 功能3：事件发生时间（可选）。老数据没有该字段时保持 undefined，完全向后兼容。
    occurredAt: typeof raw.occurredAt === 'string' && raw.occurredAt.trim() ? raw.occurredAt.trim() : undefined,
    layer: fallbackLayer,
    mentionCountAtLastMaintenance: Number.isFinite(Number(raw.mentionCountAtLastMaintenance))
      ? Math.max(0, Math.round(Number(raw.mentionCountAtLastMaintenance)))
      : mentionCount,
    lastLayerChangeAt: typeof raw.lastLayerChangeAt === 'string' ? raw.lastLayerChangeAt : null,
    history: Array.isArray(raw.history)
      ? raw.history
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => ({
            at: typeof entry.at === 'string' ? entry.at : nowIso,
            from: entry.from ?? null,
            to: entry.to ?? null,
            reason: typeof entry.reason === 'string' ? entry.reason : '',
          }))
      : [],
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'unknown',
    backgroundStory: raw.backgroundStory === true ? true : undefined,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : undefined,
    // 会话话题记忆（2026-11-06 新增）：kind='conversation' 时保存完整对话与话题元数据
    kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'memory',
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined,
    topicId: typeof raw.topicId === 'string' && raw.topicId ? raw.topicId : undefined,
    topicLabel: typeof raw.topicLabel === 'string' && raw.topicLabel ? raw.topicLabel : undefined,
    turnCount: Number.isFinite(Number(raw.turnCount)) ? Math.max(0, Math.round(Number(raw.turnCount))) : undefined,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
    lastTurnAt: typeof raw.lastTurnAt === 'string' ? raw.lastTurnAt : undefined,
    charCount: Number.isFinite(Number(raw.charCount)) ? Math.max(0, Math.round(Number(raw.charCount))) : undefined,
    compression:
      raw.compression && typeof raw.compression === 'object'
        ? {
            count: Math.max(0, Math.round(Number(raw.compression.count) || 0)),
            at: typeof raw.compression.at === 'string' ? raw.compression.at : null,
            originalLength: Number(raw.compression.originalLength) || 0,
            compactedLength: Number(raw.compression.compactedLength) || 0,
          }
        : undefined,
    // 层级压缩元数据（2026-11-06 新增；老数据没有该字段时保持 undefined）
    compaction:
      raw.compaction && typeof raw.compaction === 'object'
        ? {
            count: Math.max(0, Math.round(Number(raw.compaction.count) || 0)),
            ratio: Number(raw.compaction.ratio) || 0.75,
            fromLayer: raw.compaction.fromLayer ?? null,
            toLayer: raw.compaction.toLayer ?? null,
            at: typeof raw.compaction.at === 'string' ? raw.compaction.at : null,
            originalLength: Number(raw.compaction.originalLength) || 0,
            compactedLength: Number(raw.compaction.compactedLength) || 0,
          }
        : undefined,
  }
  recomputeDerived(item)
  return item
}

/**
 * 功能3：规范化「历史导入」的时间参数。
 * - 字符串：可被 Date.parse 解析则原样保留（避免改写调用方给定的时区偏移）；
 * - Date / 毫秒数：转换为本地时区 ISO；
 * - 其余返回 undefined。
 */
function normalizeSeedTimestamp(value) {
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim()
    return Number.isFinite(Date.parse(text)) ? text : undefined
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return formatLocalIso(value.getTime())
  if (typeof value === 'number' && Number.isFinite(value)) return formatLocalIso(value)
  return undefined
}

/**
 * 功能3：解析 seedMemories 的显式层级。
 * @returns {'short'|number|null} null 表示未指定（按 occurredAt 估算）；NaN 表示非法
 */
function resolveSeedLayer(layer) {
  if (layer === undefined || layer === null || layer === '') return null
  if (layer === 'short' || layer === '短期') return 'short'
  const number = Number(layer)
  if (Number.isInteger(number) && number >= 1 && number <= LONG_TERM_LAYERS) return number
  return Number.NaN
}

/** 话题标题：取第一条消息的前 24 个字符，去掉多余空白。 */
function deriveTopicLabel(text) {
  const clean = String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  return clean ? clean.slice(0, 24) : '新的对话'
}

/** 把被压缩掉的旧对话压成一段短摘要（保留开头与结尾，尽量不丢上下文）。 */
function summarizeConversationText(text, maxChars = 220) {
  const clean = String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!clean) return ''
  if (clean.length <= maxChars) return clean
  const head = Math.max(1, Math.floor(maxChars * 0.6))
  const tail = Math.max(1, maxChars - head - 1)
  return `${clean.slice(0, head)}……${clean.slice(-tail)}`
}

/** 记忆引擎。 */
export class MemoryEngine {
  /**
   * @param {{ dataDir: string, clock?: { now: () => number }, config?: object }} options
   */
  constructor({ dataDir, clock, config } = {}) {
    if (!dataDir || typeof dataDir !== 'string') throw new Error('记忆引擎必须提供 dataDir')
    this.dataDir = path.resolve(dataDir)
    this.clock = clock && typeof clock.now === 'function' ? clock : createSystemClock()
    this.config = resolveConfig(config)
    this.store = new MemoryStore(this.dataDir)
    this.paths = this.store.paths
    this._loaded = false
    /** @type {object[]} 短期记忆 */
    this._short = []
    /** @type {object[][]} 长期记忆第 1~7 层 */
    this._layers = Array.from({ length: LONG_TERM_LAYERS }, () => [])
    this._meta = null
    this._index = null
  }

  // ───────────────────────────── 生命周期 ─────────────────────────────

  /** 创建目录与默认文件，加载状态（幂等）。 */
  ensure() {
    if (this._loaded) return this
    const nowIso = this._nowIso()
    this.store.ensureLayout({ nowIso, capacity: this.config.shortTermCapacity })
    const shortDoc = this.store.loadShortTerm(nowIso, this.config.shortTermCapacity)
    this._short = shortDoc.items.map((item) => normalizeLoadedItem(item, 'short', nowIso)).filter(Boolean)
    this._layers = []
    for (let layer = 1; layer <= LONG_TERM_LAYERS; layer += 1) {
      const doc = this.store.loadLayer(layer, nowIso)
      this._layers.push(doc.items.map((item) => normalizeLoadedItem(item, layer, nowIso)).filter(Boolean))
    }
    this._meta = this._normalizeMeta(this.store.loadMeta(nowIso), nowIso)
    this._loaded = true
    this._index = this._buildIndex(nowIso)
    this.store.saveIndex(this._index)
    this.store.saveOverview(this._overviewText(nowIso))
    // 吸收导入脚本写下的 pending-seed（避免常驻引擎用旧内存态覆盖新导入的个人经历）
    this._consumePendingSeedFile()
    return this
  }

  /** 记忆条数与各层分布。 */
  status() {
    this.ensure()
    this._consumePendingSeedFile()
    const total = this._short.length + this._layers.reduce((sum, items) => sum + items.length, 0)
    return {
      ok: true,
      dataDir: this.paths.root,
      counts: {
        short: this._short.length,
        layers: this._layers.map((items) => items.length),
      },
      total,
      lastMaintenanceAt: this._meta.lastMaintenanceAt,
      lastMaintenanceDateKey: this._meta.lastMaintenanceDateKey,
    }
  }

  // ───────────────────────────── 记忆写入 ─────────────────────────────

  /** 为旧记忆补 createdAt，并把生成日期加入 keywords 第一项。 */
  backfillCreatedAt(options = {}) {
    this.ensure()
    const atIso = formatLocalIso(this._atMs(options.at))
    const updatedIds = []
    for (const item of this._allItems()) {
      const createdAt =
        typeof item.createdAt === 'string' && item.createdAt.trim()
          ? item.createdAt.trim()
          : typeof item.firstSeenAt === 'string' && item.firstSeenAt.trim()
            ? item.firstSeenAt.trim()
            : typeof item.occurredAt === 'string' && item.occurredAt.trim()
              ? item.occurredAt.trim()
              : atIso
      item.createdAt = createdAt
      item.keywords = withCreatedTimeKeyword(item.keywords, createdAt, 12)
      updatedIds.push(item.id)
    }
    this._persist(atIso, [])
    return { updated: updatedIds.length, ids: updatedIds }
  }

  /**
   * 批量重写已有记忆的分类/关键词/摘要/metadata（用于 LLM 旧记忆重索引）。
   * 只改这些派生字段，不动 content/layer/提及次数；完成后重建 index 与总览。
   * @param {Array<{id:string,category?:string,keywords?:string[],summary?:string,metadata?:object}>} updates
   * @param {{at?: string|number, reason?: string}} [options]
   */
  applyMetadataUpdates(updates, options = {}) {
    this.ensure()
    const atIso = formatLocalIso(this._atMs(options.at))
    const reason = typeof options.reason === 'string' && options.reason.trim() ? options.reason.trim() : 'LLM 旧记忆重索引'
    const list = Array.isArray(updates) ? updates : []
    const byId = new Map(this._allItems().map((item) => [item.id, item]))
    const updatedIds = []
    const events = []
    for (const update of list) {
      if (!update || typeof update.id !== 'string') continue
      const item = byId.get(update.id.trim())
      if (!item) continue
      const category = MEMORY_CATEGORIES.includes(update.category) ? update.category : item.category
      item.category = category
      if (Array.isArray(update.keywords) && update.keywords.length > 0) {
        item.keywords = withCreatedTimeKeyword(
          normalizeKeywordList(update.keywords, item.content, category, { max: 12 }),
          item.createdAt,
          12,
        )
      }
      if (typeof update.summary === 'string' && update.summary.trim()) {
        item.summary = update.summary.trim().slice(0, 200)
      }
      if (update.metadata && typeof update.metadata === 'object') {
        item.metadata = { ...(item.metadata ?? {}), ...update.metadata, llm: true }
      } else {
        item.metadata = { ...(item.metadata ?? {}), llm: true }
      }
      recomputeDerived(item)
      updatedIds.push(item.id)
      events.push({
        at: atIso,
        type: 'memory_reindexed',
        itemId: item.id,
        message: `记忆重索引：${item.summary}`,
        reason,
      })
    }
    this._persist(atIso, events)
    return { updated: updatedIds.length, ids: updatedIds }
  }

  /**
   * 显式记住一条记忆（memory_note 工具）。
   * @returns {{ ok: boolean, action: 'created'|'updated', item: object }}
   */
  remember(input = {}) {
    this.ensure()
    this._consumePendingSeedFile()
    const atIso = formatLocalIso(this._atMs(input.at))
    const content = String(input.content ?? '').trim()
    if (!content) throw new Error('记忆内容不能为空')
    const category = resolveCategory(input.category, content)
    const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : undefined
    const keywords = normalizeKeywordList(input.keywords, content, category, { max: metadata?.llm ? 12 : 5 })
    const emphasis = clamp(Math.round(Number(input.emphasis) || 0), 0, 3)
    const source =
      typeof input.source === 'string' && input.source.trim() ? input.source.trim() : 'tool:memory_note'
    const events = []
    let item
    let action

    const duplicate = this._findDuplicate(content)
    if (duplicate) {
      duplicate.mentionCount += 1
      duplicate.lastMentionedAt = atIso
      duplicate.emphasis = Math.min(3, Math.max(duplicate.emphasis, emphasis))
      if (metadata) duplicate.metadata = { ...(duplicate.metadata ?? {}), ...metadata }
      if (Array.isArray(input.keywords) && input.keywords.length > 0) {
        duplicate.keywords = normalizeKeywordList(
          [...duplicate.keywords, ...input.keywords],
          duplicate.content,
          duplicate.category,
          { max: metadata?.llm ? 12 : 5 },
        )
      }
      if (input.category && MEMORY_CATEGORIES.includes(String(input.category))) {
        duplicate.category = String(input.category)
      }
      if (input.summary && String(input.summary).trim()) duplicate.summary = String(input.summary).trim()
      recomputeDerived(duplicate)
      item = duplicate
      action = 'updated'
      events.push({
        at: atIso,
        type: 'memory_updated',
        itemId: duplicate.id,
        message: `记忆被再次提及：${duplicate.summary}`,
      })
    } else {
      const importanceOverride =
        input.importance !== undefined &&
        input.importance !== null &&
        Number.isFinite(Number(input.importance))
          ? clamp(Math.round(Number(input.importance)), 1, 100)
          : undefined
      item = this._createItem({ content, keywords, category, emphasis, source, atIso, importanceOverride, metadata, summary: input.summary })
      this._short.push(item)
      action = 'created'
      events.push({
        at: atIso,
        type: 'memory_created',
        itemId: item.id,
        message: `新增记忆：${item.summary}`,
        category: item.category,
        layer: layerLabel('short'),
      })
      events.push(...this._enforceShortTermOverflow(atIso))
    }

    this._persist(atIso, events)
    return { ok: true, action, item: cloneItem(item) }
  }

  /**
   * 功能3：把「人设个人经历」等历史条目按事件发生时间批量导入记忆区（同步方法）。
   *
   * 入参 items 为数组，每个条目支持：
   * `{ id?, content, keywords?, category?, importance?, layer?('short'|1..7),
   *    occurredAt?, firstSeenAt?, lastMentionedAt?, source?, summary? }`
   *
   * 行为：
   * - ensure() 后写入；按 id 或「规范化 content 完全相等」去重（批内也去重）；
   * - layer 未指定时按 occurredAt 距今估算（见 model.estimateLayerByOccurredAt；无 occurredAt 写入短期记忆）；
   * - importance 显式给出时覆盖公式结果；firstSeenAt/lastMentionedAt 缺省用 occurredAt，仍缺省用当前时间；
   * - source 默认 `persona-history`；history 追加一条 reason 以 `seed` 开头的记录；
   * - 成功写入后持久化 short-term / 七层文件 / meta / index / 记忆总览.md，并向 events.jsonl 追加一条 seed 事件；
   * - options.force=true 时覆盖处理「同 id 已存在」的旧条目（先移除再按新内容重建），用于脚本 --force 更新。
   *
   * @param {object[]} items 历史条目数组
   * @param {{ force?: boolean }} [options]
   * @returns {{ created: number, skipped: number, createdIds: string[], createdItems: object[], skippedItems: {index: number, id: string|null, reason: string}[] }}
   */
  seedMemories(items, options = {}) {
    this.ensure()
    const atMs = this._now()
    const atIso = formatLocalIso(atMs)
    const force = Boolean(options && options.force)
    const list = Array.isArray(items) ? items : []
    const createdItems = []
    const createdIds = []
    const skippedItems = []

    for (let index = 0; index < list.length; index += 1) {
      const raw = list[index]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        skippedItems.push({ index, id: null, reason: '条目必须是对象' })
        continue
      }
      const content = String(raw.content ?? '').trim()
      const rawId = raw.id === undefined || raw.id === null ? '' : String(raw.id).trim()
      const skip = (reason) => skippedItems.push({ index, id: rawId || null, reason })
      if (!content) {
        skip('content 不能为空')
        continue
      }

      // 1) 显式层级校验（未指定时按 occurredAt 估算）
      const layerInput = resolveSeedLayer(raw.layer)
      if (Number.isNaN(layerInput)) {
        skip(`无效的记忆层级：${String(raw.layer)}（应为 short 或 1~7）`)
        continue
      }

      // 2) 事件发生时间校验（可选；给出但非法则整条跳过，避免写入错误时间）
      let occurredAt
      const hasOccurredAt =
        raw.occurredAt !== undefined && raw.occurredAt !== null && String(raw.occurredAt).trim() !== ''
      if (hasOccurredAt) {
        occurredAt = normalizeSeedTimestamp(raw.occurredAt)
        if (occurredAt === undefined) {
          skip(`occurredAt 不是合法时间：${String(raw.occurredAt)}`)
          continue
        }
      }
      const layer = layerInput === null ? estimateLayerByOccurredAt(occurredAt, atMs) : layerInput
      const firstSeenAt = normalizeSeedTimestamp(raw.firstSeenAt) ?? occurredAt ?? atIso
      const lastMentionedAt = normalizeSeedTimestamp(raw.lastMentionedAt) ?? occurredAt ?? atIso

      // 3) 去重：先按 id，再按规范化 content（完全相等；与批内已写入条目比较）
      const existingById = rawId ? this._allItems().find((item) => item.id === rawId) : undefined
      if (existingById && !force) {
        skip('同 id 条目已存在')
        continue
      }
      const normalizedContent = normalizeForDedup(content)
      const contentDuplicate = normalizedContent
        ? this._allItems().find(
            (item) => item !== existingById && normalizeForDedup(item.content) === normalizedContent,
          )
        : undefined
      if (contentDuplicate) {
        skip(`与已有记忆内容重复：${contentDuplicate.id}`)
        continue
      }
      if (existingById && force) this._removeItemById(rawId)

      // 4) 创建条目
      const category = resolveCategory(raw.category, content)
      const keywords = normalizeKeywordList(raw.keywords, content, category)
      const source =
        typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'persona-history'
      const importanceOverride =
        raw.importance !== undefined && raw.importance !== null && Number.isFinite(Number(raw.importance))
          ? clamp(Math.round(Number(raw.importance)), 1, 100)
          : undefined
      const item = this._createItem({
        id: rawId || undefined,
        content,
        summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : undefined,
        keywords,
        category,
        emphasis: 0,
        source,
        atIso: firstSeenAt,
        importanceOverride,
        layer,
        occurredAt,
      })
      item.firstSeenAt = firstSeenAt
      item.lastMentionedAt = lastMentionedAt
      item.mentionCountAtLastMaintenance = item.mentionCount
      item.lastLayerChangeAt = null
      if (raw.backgroundStory === true) item.backgroundStory = true
      if (raw.compaction && typeof raw.compaction === 'object') item.compaction = raw.compaction
      item.history = [
        {
          at: atIso,
          from: null,
          to: layer,
          reason: 'seed：按人设个人经历的事件发生时间导入',
        },
      ]
      if (layer === 'short') this._short.push(item)
      else this._layers[layer - 1].push(item)
      createdItems.push(item)
      createdIds.push(item.id)
    }

    // 5) 持久化：只有真正写入才落盘（重复执行保持文件不变），events.jsonl 追加一条 seed 事件
    if (createdItems.length > 0) {
      const events = this._enforceShortTermOverflow(atIso)
      events.push({
        at: atIso,
        type: 'seed',
        message: `从人设个人经历导入 ${createdItems.length} 条记忆（跳过 ${skippedItems.length} 条）。`,
        created: createdIds.slice(),
        skipped: skippedItems.length,
      })
      this._persist(atIso, events)
    }

    return {
      created: createdItems.length,
      skipped: skippedItems.length,
      createdIds,
      createdItems: createdItems.map((item) => cloneItem(item)),
      skippedItems,
    }
  }

  /**
   * 若记忆目录里存在 `pending-seed.json`（导入脚本写入），把其中尚未存在的条目合并进当前引擎并持久化。
   * 解决常驻 Harness 进程内记忆引擎单例「外部脚本写盘后被旧内存态覆盖」的问题：
   * 下一次用户消息 / 插件重载 / 状态查询时即可吸收 pending 条目。
   * @returns {{ created: number, skipped: number, createdIds: string[] }}
   */
  applyPendingSeed() {
    this.ensure()
    return this._consumePendingSeedFile()
  }

  /** 只有 pending-seed 文件存在时才 ensure+消费（插件启动时调用，无文件零开销）。 */
  consumePendingSeedIfAny() {
    if (!existsSync(this._pendingSeedPath())) return { created: 0, skipped: 0, createdIds: [] }
    this.ensure()
    return this._consumePendingSeedFile()
  }

  /** pending-seed 文件路径（兼容旧 paths 对象）。 */
  _pendingSeedPath() {
    return this.paths.pendingSeedFile || path.join(this.paths.memoryDir, 'pending-seed.json')
  }

  /**
   * 消费 pending-seed.json（不调用 ensure，避免递归）；成功合并后删除该文件。
   * @returns {{ created: number, skipped: number, createdIds: string[] }}
   */
  _consumePendingSeedFile() {
    const file = this._pendingSeedPath()
    if (!existsSync(file)) return { created: 0, skipped: 0, createdIds: [] }
    let doc
    try {
      doc = readJsonSync(file, undefined)
    } catch {
      try {
        fs.unlinkSync(file)
      } catch {
        // ignore
      }
      return { created: 0, skipped: 0, createdIds: [] }
    }
    const list = Array.isArray(doc) ? doc : Array.isArray(doc && doc.items) ? doc.items : []
    if (list.length === 0) {
      try {
        fs.unlinkSync(file)
      } catch {
        // ignore
      }
      return { created: 0, skipped: 0, createdIds: [] }
    }
    const atMs = this._now()
    const atIso = formatLocalIso(atMs)
    const createdIds = []
    let skipped = 0
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        skipped += 1
        continue
      }
      const content = String(raw.content ?? '').trim()
      if (!content) {
        skipped += 1
        continue
      }
      const rawId = raw.id === undefined || raw.id === null ? '' : String(raw.id).trim()
      if (rawId && this._allItems().some((item) => item.id === rawId)) {
        skipped += 1
        continue
      }
      if (this._findDuplicate(content)) {
        skipped += 1
        continue
      }
      const layerInput = resolveSeedLayer(raw.layer)
      if (Number.isNaN(layerInput)) {
        skipped += 1
        continue
      }
      let occurredAt
      const hasOccurredAt =
        raw.occurredAt !== undefined && raw.occurredAt !== null && String(raw.occurredAt).trim() !== ''
      if (hasOccurredAt) {
        occurredAt = normalizeSeedTimestamp(raw.occurredAt)
        if (occurredAt === undefined) {
          skipped += 1
          continue
        }
      }
      const layer = layerInput === null ? estimateLayerByOccurredAt(occurredAt, atMs) : layerInput
      const firstSeenAt = normalizeSeedTimestamp(raw.firstSeenAt) ?? occurredAt ?? atIso
      const lastMentionedAt = normalizeSeedTimestamp(raw.lastMentionedAt) ?? occurredAt ?? atIso
      const category = resolveCategory(raw.category, content)
      const keywords = normalizeKeywordList(raw.keywords, content, category)
      const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'persona-history'
      const importanceOverride =
        raw.importance !== undefined && raw.importance !== null && Number.isFinite(Number(raw.importance))
          ? clamp(Math.round(Number(raw.importance)), 1, 100)
          : undefined
      const item = this._createItem({
        id: rawId || undefined,
        content,
        summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : undefined,
        keywords,
        category,
        emphasis: 0,
        source,
        atIso: firstSeenAt,
        importanceOverride,
        layer,
        occurredAt,
      })
      item.firstSeenAt = firstSeenAt
      item.lastMentionedAt = lastMentionedAt
      item.mentionCountAtLastMaintenance = item.mentionCount
      item.lastLayerChangeAt = null
      if (raw.backgroundStory === true) item.backgroundStory = true
      if (raw.compaction && typeof raw.compaction === 'object') item.compaction = raw.compaction
      item.history = [
        {
          at: atIso,
          from: null,
          to: layer,
          reason: 'seed：按人设个人经历的事件发生时间合并（pending-seed）',
        },
      ]
      if (layer === 'short') this._short.push(item)
      else this._layers[layer - 1].push(item)
      createdIds.push(item.id)
    }
    try {
      fs.unlinkSync(file)
    } catch {
      // 删除失败下次会重试；条目已按 id/content 去重，不会重复写入
    }
    if (createdIds.length > 0) {
      const events = this._enforceShortTermOverflow(atIso)
      events.push({
        at: atIso,
        type: 'seed',
        message: `从人设个人经历（pending-seed）合并 ${createdIds.length} 条记忆（跳过 ${skipped} 条）。`,
        created: createdIds.slice(),
        skipped,
      })
      this._persist(atIso, events)
    }
    return { created: createdIds.length, skipped, createdIds }
  }

  /**
   * 记录一轮 QQ 对话（主人 + 奥菲莉亚）到「话题记忆」：
   * - 同一 session 且距上一轮不超过 conversationTopicGapMinutes → 追加到同一话题记忆；
   * - 否则新建一个话题记忆；
   * - 每个话题记忆最多 topicMemoryMaxChars 字，超出后压缩最旧的对话；
   * - 短期记忆总字数超过 shortTermCharLimit 时，按重要度/提及次数低的一半转入长期第一层。
   *
   * @param {{ sessionId?: string, userText?: string, assistantText?: string, atUser?: string|number|Date, atAssistant?: string|number|Date }} input
   * @returns {{ ok: boolean, created: boolean, item?: object, compressed?: object|null, moved?: number, skipped?: boolean }}
   */
  recordConversationTurn(input = {}) {
    this.ensure()
    this._consumePendingSeedFile()
    const userText = String(input.userText ?? '').trim()
    const assistantText = String(input.assistantText ?? '').trim()
    if (!userText && !assistantText) return { ok: true, created: false, skipped: true }
    const atUserIso = formatLocalIso(this._atMs(input.atUser))
    const atAssistantIso = formatLocalIso(this._atMs(input.atAssistant ?? input.atUser))
    const sessionId = String(input.sessionId ?? '').trim() || 'default'
    const analysis = input.analysis && typeof input.analysis === 'object' ? input.analysis : undefined
    const atMs = parseIso(atAssistantIso) || this._now()
    const active = this._findActiveConversationTopic(sessionId, atMs)
    const userStamp = atUserIso.slice(0, 16)
    const assistantStamp = atAssistantIso.slice(0, 16)
    const lines = []
    if (userText) lines.push(`[${userStamp}] 主人：${userText}`)
    if (assistantText) lines.push(`[${assistantStamp}] 奥菲莉亚：${assistantText}`)
    const events = []
    let item
    let created = false

    if (active) {
      item = active
      item.content += `\n${lines.join('\n')}`
      item.turnCount = (Number(item.turnCount) || 0) + (userText ? 1 : 0) + (assistantText ? 1 : 0)
      item.lastTurnAt = atAssistantIso
      item.lastMentionedAt = atAssistantIso
      item.mentionCount = Math.max(Number(item.mentionCount) || 0, Number(item.turnCount) || 1)
      if (analysis) {
        if (Array.isArray(analysis.keywords) && analysis.keywords.length > 0) item.keywords = analysis.keywords
        if (analysis.category) item.category = analysis.category
        item.metadata = { ...(item.metadata ?? {}), ...analysis, llm: true }
      }
      this._refreshConversationItem(item)
      events.push({
        at: atAssistantIso,
        type: 'conversation_updated',
        itemId: item.id,
        message: `话题「${item.topicLabel}」追加一轮对话（${item.charCount} 字）`,
        sessionId,
      })
    } else {
      const topicLabel = analysis?.topicLabel || deriveTopicLabel(userText || assistantText)
      const content = `【话题】${topicLabel}\n${lines.join('\n')}`
      item = this._createItem({
        content,
        summary: analysis?.summary,
        keywords: analysis?.keywords?.length ? analysis.keywords : [topicLabel],
        category: analysis?.category || '人际',
        emphasis: 0,
        source: this.config.conversationSource,
        atIso: atUserIso,
        layer: 'short',
        metadata: analysis ? { ...analysis, llm: true, conversation: true } : undefined,
      })
      item.kind = 'conversation'
      item.sessionId = sessionId
      item.topicId = item.id
      item.topicLabel = topicLabel
      item.turnCount = (userText ? 1 : 0) + (assistantText ? 1 : 0)
      item.startedAt = atUserIso
      item.lastTurnAt = atAssistantIso
      item.charCount = content.length
      item.mentionCount = Math.max(1, item.turnCount)
      item.mentionCountAtLastMaintenance = item.mentionCount
      item.occurredAt = atUserIso
      this._short.push(item)
      this._refreshConversationItem(item)
      created = true
      events.push({
        at: atAssistantIso,
        type: 'conversation_created',
        itemId: item.id,
        message: `新建话题「${topicLabel}」（${item.charCount} 字）`,
        sessionId,
      })
    }

    const compressed = this._compressConversationItem(item, atAssistantIso)
    if (compressed) {
      events.push({
        at: atAssistantIso,
        type: 'conversation_compressed',
        itemId: item.id,
        message: `话题「${item.topicLabel}」超过 ${this.config.topicMemoryMaxChars} 字，压缩旧对话（${compressed.originalLength} → ${compressed.compactedLength} 字）`,
        originalLength: compressed.originalLength,
        compactedLength: compressed.compactedLength,
        count: compressed.count,
      })
    }
    const overflowEvents = this._enforceShortTermOverflow(atAssistantIso)
    events.push(...overflowEvents)
    this._persist(atAssistantIso, events)
    return {
      ok: true,
      created,
      item: cloneItem(item),
      compressed,
      moved: overflowEvents.filter((event) => event.type === 'layer_moved').length,
    }
  }

  /** 找到当前 session 仍在时间窗内的活跃话题记忆。 */
  _findActiveConversationTopic(sessionId, atMs) {
    const gapMs = Math.max(1, Number(this.config.conversationTopicGapMinutes)) * 60 * 1000
    const candidates = this._short
      .filter((item) => item.kind === 'conversation' && item.sessionId === sessionId)
      .sort((a, b) => (parseIso(b.lastTurnAt) || 0) - (parseIso(a.lastTurnAt) || 0))
    for (const item of candidates) {
      const lastMs = parseIso(item.lastTurnAt)
      if (!Number.isFinite(lastMs)) continue
      if (atMs - lastMs <= gapMs) return item
    }
    return null
  }

  /** 刷新话题记忆的摘要/关键词/字数/重要度。 */
  _refreshConversationItem(item) {
    item.charCount = String(item.content ?? '').length
    const turns = Math.max(1, Math.ceil((Number(item.turnCount) || 1) / 2))
    item.summary = `${item.topicLabel ?? '对话'}（${turns} 轮，${item.charCount} 字）`
    item.keywords = normalizeKeywordList(item.keywords, item.content, item.category, {
      max: item.metadata?.llm ? 12 : 5,
    })
    recomputeDerived(item)
    return item
  }

  /**
   * 单话题超过 1w 字时压缩：保留最近对话原文，把更早的对话压成一段摘要。
   * @returns {{ originalLength:number, compactedLength:number, count:number } | null}
   */
  _compressConversationItem(item, atIso) {
    const maxChars = Math.max(1000, Number(this.config.topicMemoryMaxChars) || 10000)
    const content = String(item.content ?? '')
    if (content.length <= maxChars) return null
    const ratio = Math.min(0.9, Math.max(0.3, Number(this.config.topicCompressionTargetRatio) || 0.75))
    const target = Math.max(600, Math.floor(maxChars * ratio))
    const lines = content.split('\n')
    const header = lines[0] && lines[0].startsWith('【话题】') ? lines[0] : `【话题】${item.topicLabel ?? '对话'}`
    const body = lines.slice(1)
    const reserve = Math.min(260, Math.max(120, Math.floor(target * 0.12)))
    const kept = []
    let keptChars = header.length + 1 + reserve + 2
    for (let index = body.length - 1; index >= 0; index -= 1) {
      const line = body[index]
      if (!line) continue
      if (keptChars + line.length + 1 > target) break
      kept.unshift(line)
      keptChars += line.length + 1
    }
    const keptText = kept.join('\n')
    const removedLines = body.slice(0, body.length - kept.length)
    const removedText = removedLines.join('\n').trim()
    if (!removedText) return null
    const summaryText = summarizeConversationText(removedText, Math.max(40, target - header.length - keptText.length - 4))
    const summaryBlock = `【早期对话摘要】${summaryText}`
    let nextContent = `${header}\n${summaryBlock}${keptText ? `\n${keptText}` : ''}`
    if (nextContent.length > maxChars) {
      nextContent = `${header}\n${summaryBlock}${keptText ? `\n${keptText}` : ''}`.slice(0, maxChars)
    }
    const previousCount = Number(item.compression?.count) || 0
    const originalLength = content.length
    item.content = nextContent
    item.compression = {
      count: previousCount + 1,
      at: atIso,
      originalLength,
      compactedLength: nextContent.length,
    }
    this._refreshConversationItem(item)
    return { originalLength, compactedLength: nextContent.length, count: item.compression.count }
  }

  /**
   * 接收用户消息：提及计数 + 强调 + 自动抽取（SPEC 4.5）。
   * @param {{ text: string, messageId?: string, role?: string, at?: string|number, sessionId?: string, autoExtract?: boolean }} message
   * @returns {{ created: object[], mentioned: {id: string, mentionCount: number}[], skipped: boolean }}
   */
  ingestMessage({ text = '', messageId, role, at, sessionId, autoExtract = true, deferOverflow = false } = {}) {
    void sessionId
    this.ensure()
    this._consumePendingSeedFile()
    if (role !== 'user') return { created: [], mentioned: [], skipped: true }
    const atIso = formatLocalIso(this._atMs(at))
    const messageKey = messageId === undefined || messageId === null ? '' : String(messageId).trim()
    if (messageKey) {
      if (this._meta.processedMessageIds.includes(messageKey)) {
        return { created: [], mentioned: [], skipped: true }
      }
      this._meta.processedMessageIds.push(messageKey)
      const maxIds = this.config.processedMessageIdLimit
      if (this._meta.processedMessageIds.length > maxIds) {
        this._meta.processedMessageIds = this._meta.processedMessageIds.slice(-maxIds)
      }
    }

    const content = String(text ?? '').trim()
    if (!content) {
      this._persist(atIso, [])
      return { created: [], mentioned: [], skipped: true }
    }

    // 1) 提及：短期记忆 + 全部 7 层长期记忆逐条检查
    const mentioned = []
    const mentionedIds = new Set()
    const hasEmphasisWord = this.config.emphasisWords.some((word) => content.includes(word))
    for (const item of this._allItems()) {
      this._tryMention(item, content, atIso, hasEmphasisWord, mentioned, mentionedIds)
    }

    // 2) 自动抽取：每条消息最多新增 3 条；重复内容改为提及 +1
    const events = []
    const created = []
    const extracted = autoExtract ? extractMemories(content, atIso).slice(0, this.config.autoExtractLimit) : []
    for (const match of extracted) {
      const duplicate = this._findDuplicate(match.content)
      if (duplicate) {
        if (!mentionedIds.has(duplicate.id)) {
          duplicate.mentionCount += 1
          duplicate.lastMentionedAt = atIso
          if (match.emphasis > 0) duplicate.emphasis = Math.min(3, Math.max(duplicate.emphasis, match.emphasis))
          recomputeDerived(duplicate)
          mentionedIds.add(duplicate.id)
          mentioned.push({ id: duplicate.id, mentionCount: duplicate.mentionCount })
        }
        continue
      }
      const item = this._createItem({
        content: match.content,
        keywords: match.keywords,
        category: match.category,
        emphasis: match.emphasis,
        source: 'auto_extract',
        atIso,
      })
      this._short.push(item)
      created.push(cloneItem(item))
      events.push({
        at: atIso,
        type: 'memory_created',
        itemId: item.id,
        message: `自动抽取记忆：${item.summary}`,
        category: item.category,
        layer: layerLabel('short'),
      })
      // 每新增一条记忆后检查短期容量（SPEC 4.8）；QQ 通道会延后到回复发送后。
      if (!deferOverflow) events.push(...this._enforceShortTermOverflow(atIso))
    }
    if (mentioned.length > 0) {
      events.push({
        at: atIso,
        type: 'memories_mentioned',
        message: `用户消息让 ${mentioned.length} 条记忆被再次提及。`,
        items: mentioned.map((entry) => entry.id),
      })
    }
    if (!deferOverflow) events.push(...this._enforceShortTermOverflow(atIso))
    this._persist(atIso, events)
    return { created, mentioned, skipped: false }
  }

  /** 回复发送后补做短期容量/字数溢出整理，避免阻塞回复。 */
  organizeShortTermOverflow(options = {}) {
    this.ensure()
    const atIso = formatLocalIso(this._atMs(options.at))
    const events = this._enforceShortTermOverflow(atIso)
    if (events.length > 0) this._persist(atIso, events)
    return { moved: events.filter((event) => event.type === 'layer_moved').length, events }
  }

  /**
   * 上下文紧张压缩（SPEC 4.8）：按重要程度保留约 keepRatio 比例写入短期记忆，其余丢弃。
   * @returns {{ total: number, kept: number, dropped: number, stored: string[] }}
   */
  handleContextPressure(items, options = {}) {
    this.ensure()
    const atIso = formatLocalIso(this._atMs(options.at))
    const list = Array.isArray(items) ? items : []
    const total = list.length
    if (total === 0) return { total: 0, kept: 0, dropped: 0, stored: [] }
    const keepRatio = Number.isFinite(Number(options.keepRatio))
      ? clamp(Number(options.keepRatio), 0, 1)
      : this.config.contextPressureKeepRatio
    const candidates = list.map((raw, index) => {
      const record = raw && typeof raw === 'object' ? raw : { content: raw }
      return {
        raw: record,
        index,
        content: String(record.content ?? '').trim(),
        importance: Number.isFinite(Number(record.importance))
          ? Number(record.importance)
          : this._candidateImportance(record),
      }
    })
    const valid = candidates.filter((candidate) => candidate.content)
    const keepCount = Math.max(1, Math.round(valid.length * keepRatio))
    const kept = valid
      .slice()
      .sort((a, b) => b.importance - a.importance || a.index - b.index)
      .slice(0, keepCount)

    const source =
      typeof options.source === 'string' && options.source.trim() ? options.source.trim() : 'context_pressure'
    const stored = []
    for (const candidate of kept) {
      const duplicate = this._findDuplicate(candidate.content)
      if (duplicate) {
        duplicate.mentionCount += 1
        duplicate.lastMentionedAt = atIso
        const rawEmphasis = Number(candidate.raw.emphasis)
        if (Number.isFinite(rawEmphasis)) {
          duplicate.emphasis = Math.min(3, Math.max(duplicate.emphasis, Math.round(rawEmphasis)))
        }
        recomputeDerived(duplicate)
        stored.push(duplicate.id)
        continue
      }
      // SPEC 4.8：上下文压缩保留的条目分类默认「其他」，但调用方显式给出合法分类时沿用
      const providedCategory = String(candidate.raw.category ?? '').trim()
      const category = MEMORY_CATEGORIES.includes(providedCategory) ? providedCategory : '其他'
      const item = this._createItem({
        content: candidate.content,
        keywords: normalizeKeywordList(candidate.raw.keywords, candidate.content, category),
        category,
        emphasis: candidate.raw.emphasis,
        source,
        atIso,
      })
      this._short.push(item)
      stored.push(item.id)
    }

    const events = this._enforceShortTermOverflow(atIso)
    events.push({
      at: atIso,
      type: 'context_pressure',
      message: `上下文紧张压缩：保留 ${kept.length} 条、丢弃 ${total - kept.length} 条、写入短期记忆 ${stored.length} 条。`,
      stored: [...stored],
    })
    this._persist(atIso, events)
    return { total, kept: kept.length, dropped: total - kept.length, stored }
  }

  // ───────────────────────────── 检索 ─────────────────────────────

  /**
   * 收到消息时预加载：短期全部保留；只扫长期记忆 keywords，命中项挪回短期。
   * 不读取长期正文/摘要，避免把全部长期记忆塞进上下文。
   */
  prepareForMessage(text, options = {}) {
    this.ensure()
    const query = String(text ?? '').trim()
    if (!query) return { loaded: [], matched: 0 }
    const atIso = formatLocalIso(this._atMs(options.at))
    const loaded = []
    const events = []
    for (let layer = 1; layer <= LONG_TERM_LAYERS; layer += 1) {
      const list = this._layers[layer - 1]
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const item = list[index]
        const matched = this._mentionKeywords(item).some(
          (keyword) => query.includes(keyword) || keyword.includes(query),
        )
        if (!matched) continue
        list.splice(index, 1)
        item.layer = 'short'
        item.lastLayerChangeAt = atIso
        item.history.push({
          at: atIso,
          from: layer,
          to: 'short',
          reason: '长期记忆关键词命中，提前加载到短期记忆',
        })
        // 保留原重要度/清晰度，避免“刚被提及却被降级成模糊记忆”。
        this._short.push(item)
        loaded.push(item)
        events.push({
          at: atIso,
          type: 'layer_moved',
          itemId: item.id,
          message: `长期记忆关键词命中，加载到短期：「${item.summary}」`,
          from: layer,
          to: 'short',
        })
      }
    }
    if (loaded.length > 0) this._persist(atIso, events)
    return { loaded: loaded.map(cloneItem), matched: loaded.length }
  }

  /**
   * 分级检索（SPEC 4.10）：短期记忆 → 第一层 → … → 第七层，命中达到 limit 即停止。
   * @returns {{ query: string, hits: object[], searchedLayers: (string|number)[], stoppedAt: string|number|null, exhausted: boolean }}
   */
  recall(query, options = {}) {
    this.ensure()
    const limit = Math.max(1, Math.round(Number(options.limit) || this.config.recallLimit))
    const q = String(query ?? '').trim()
    const hits = []
    const searchedLayers = []

    if (!q) {
      // 无查询词：短期 → 第一层，各自按重要度排序；两层都属于「全量扫描」范围。
      const sortByImportance = (a, b) =>
        (b.importance || 0) - (a.importance || 0) ||
        (b.mentionCount || 0) - (a.mentionCount || 0) ||
        compareItemId(a.id, b.id)
      const candidates = [
        ...[...this._short].sort(sortByImportance).map((item) => ({ item, layer: 'short' })),
        ...[...this._layers[0]].sort(sortByImportance).map((item) => ({ item, layer: 1 })),
      ].slice(0, limit)
      for (const entry of candidates) {
        hits.push({
          item: cloneItem(entry.item),
          score: this._roundScore((entry.item.importance || 0) / 100 + 2),
          layer: entry.layer,
          layerLabel: layerLabel(entry.layer),
        })
      }
      return { query: q, hits, searchedLayers: ['short', 1], stoppedAt: null, exhausted: true }
    }

    const sources = [['short', this._short], [1, this._layers[0]]]
    this._layers.slice(1).forEach((items, index) => sources.push([index + 2, items]))
    let stoppedAt = null
    for (const [layer, items] of sources) {
      searchedLayers.push(layer)
      const scored = []
      for (const item of items) {
        // 所有层统一：先 keyword，命中才读正文；keyword 未命中再看 summary；
        // summary 也未命中的条目直接跳过，避免逐条读全文拖慢回复。
        const keywordHit = this._matchesKeywords(item, q)
        const summaryHit = keywordHit ? false : this._matchesSummary(item, q)
        if (!keywordHit && !summaryHit) continue
        let score = this._scoreItem(item, q)
        // summary 命中但正文/关键词评分恰好为 0 时，给一个基础命中分，
        // 确保「keyword 未命中 → summary 命中」的条目能进入结果。
        if (score <= 0 && summaryHit) score = 0.5
        if (score > 0) scored.push({ item, score, keywordHit, summaryHit })
      }
      scored.sort(
        (a, b) => b.score - a.score || (b.item.importance || 0) - (a.item.importance || 0) || compareItemId(a.item.id, b.item.id),
      )
      for (const hit of scored) {
        if (hits.length >= limit) break
        hits.push({
          item: cloneItem(hit.item),
          score: this._roundScore(hit.score),
          layer,
          layerLabel: layerLabel(layer),
        })
      }
      if (hits.length >= limit) {
        stoppedAt = layer
        break
      }
    }
    return { query: q, hits, searchedLayers, stoppedAt, exhausted: stoppedAt === null }
  }

  /** 只比对 keywords；不读取正文。 */
  _matchesKeywords(item, query) {
    const q = String(query ?? '').trim()
    if (!q) return false
    if (this._mentionKeywords(item).some((keyword) => q.includes(keyword) || keyword.includes(q))) return true
    // 分类名作为索引的一部分（例如搜索「喜好」）
    return Boolean(item.category && (q.includes(item.category) || item.category.includes(q)))
  }

  /** keyword 未命中时再看 summary；仍不读取正文。 */
  _matchesSummary(item, query) {
    const q = String(query ?? '').trim()
    if (!q) return false
    const summary = String(item.summary ?? '').replace(/\s+/g, ' ').trim()
    return summary.length >= 2 && (summary.includes(q) || q.includes(summary))
  }

  // ───────────────────────────── 维护 ─────────────────────────────

  /**
   * 维护调度判定（纯函数，不修改记忆状态）。
   * @param {{ at?: string|number|Date }} options
   * @returns {{ shouldRun: boolean, reason?: string }}
   */
  checkMaintenance(options = {}) {
    this.ensure()
    return decideMaintenance({ at: this._atMs(options.at), meta: this._meta })
  }

  /**
   * 判断一条记忆是否属于「背景故事」：人设个人经历（persona-history）或故事导入（story:*）。
   * 背景故事不参与层级压缩，保证剧情记忆的完整性。
   */
  _isBackgroundStoryMemory(item) {
    if (!item) return false
    if (item.backgroundStory === true) return true
    const source = String(item.source ?? '')
    if (!source) return false
    if (Array.isArray(this.config.backgroundStorySources) && this.config.backgroundStorySources.includes(source)) {
      return true
    }
    return (
      Array.isArray(this.config.backgroundStorySourcePrefixes) &&
      this.config.backgroundStorySourcePrefixes.some((prefix) => prefix && source.startsWith(prefix))
    )
  }

  /**
   * 非背景故事记忆下沉到指定层时压缩正文：从第 3 层开始，每次进入下一层压缩为原来的 75%。
   * @param {object} item
   * @param {{ from: number, to: number }} move
   * @param {string} atIso
   * @returns {{ savedChars: number, originalLength: number, compactedLength: number, count: number } | null}
   */
  _compactMemoryForLayer(item, move, atIso) {
    const targetLayer = Number(move.to)
    const startLayer = Number(this.config.layerCompactionStartLayer)
    const ratio = Number(this.config.layerCompactionRatio)
    if (!Number.isFinite(targetLayer) || targetLayer < startLayer) return null
    if (!Number.isFinite(ratio) || ratio >= 1 || ratio <= 0) return null
    if (this._isBackgroundStoryMemory(item)) return null
    const before = String(item.content ?? '')
    if (!before) return null
    const compacted = compactText(before, {
      ratio,
      minChars: Number(this.config.layerCompactionMinChars) || 12,
    })
    if (!compacted || compacted === before || compacted.length >= before.length) return null
    const previousCount = Number(item.compaction?.count) || 0
    item.content = compacted
    item.summary = buildSummary(compacted)
    item.compaction = {
      count: previousCount + 1,
      ratio,
      fromLayer: Number(move.from),
      toLayer: targetLayer,
      at: atIso,
      originalLength: before.length,
      compactedLength: compacted.length,
    }
    return {
      savedChars: before.length - compacted.length,
      originalLength: before.length,
      compactedLength: compacted.length,
      count: item.compaction.count,
    }
  }

  /**
   * 每日维护（SPEC 4.9）：夜间转移 → 上浮 → 下沉，更新索引/总览/维护历史。
   * @param {{ at?: string|number|Date, reason?: string }} options
   */
  maintain(options = {}) {
    this.ensure()
    this._consumePendingSeedFile()
    const atMs = this._atMs(options.at)
    const atIso = formatLocalIso(atMs)
    const dayKey = formatLocalDate(atMs)
    const hour = localHour(atMs)
    const defaultReason = hour >= 4 && hour < 6 ? '每日凌晨维护窗口' : '补跑（应用未在凌晨运行）'
    const reason =
      typeof options.reason === 'string' && options.reason.trim() ? options.reason.trim() : defaultReason
    const events = []
    const report = {
      ok: true,
      at: atIso,
      reason,
      transferred: 0,
      promoted: 0,
      demoted: 0,
      compacted: 0,
      savedChars: 0,
      layerCounts: {},
      shortCount: 0,
      total: 0,
      indexKeywords: 0,
    }

    // 1. 夜间转移：短期记忆中的普通记忆转入长期第一层；会话话题记忆留在短期（按 5w 字上限管理）
    const transferredItems = this._short.filter((item) => item.kind !== 'conversation')
    this._short = this._short.filter((item) => item.kind === 'conversation')
    for (const item of transferredItems) {
      this._fillItemFields(item)
      item.layer = 1
      item.history.push({ at: atIso, from: 'short', to: 1, reason: '每日夜间转移' })
      item.lastLayerChangeAt = atIso
      item.mentionCountAtLastMaintenance = item.mentionCount
      recomputeDerived(item)
      this._layers[0].push(item)
      events.push({
        at: atIso,
        type: 'layer_moved',
        itemId: item.id,
        message: `每日夜间转移：记忆从短期记忆转入第一层（${item.summary}）`,
        from: layerLabel('short'),
        to: layerLabel(1),
        reason: '每日夜间转移',
      })
    }
    report.transferred = transferredItems.length

    // 2/3. 先统一计算移动方案：提升优先，每条记忆每次维护最多移动一层。
    // 本次刚由短期记忆转入第一层的条目不再参与下沉（「维护前已在 LTM 的」才参与），
    // 保证「夜间转移后短期记忆全部进入第一层」。
    const longItems = this._layers.flat()
    const transferredIds = new Set(transferredItems.map((item) => item.id))
    const moves = []
    const promotedIds = new Set()
    for (const item of longItems) {
      if (transferredIds.has(item.id)) continue
      const delta = Number(item.mentionCount) - Number(item.mentionCountAtLastMaintenance || 0)
      if (delta >= this.config.promotionMentionDelta && Number(item.layer) > 1) {
        moves.push({
          item,
          from: Number(item.layer),
          to: Number(item.layer) - 1,
          reason: '提及频率增加，上浮一层',
        })
        promotedIds.add(item.id)
      }
    }
    for (const item of longItems) {
      if (promotedIds.has(item.id) || transferredIds.has(item.id)) continue
      const layer = Number(item.layer)
      if (!(layer >= 1 && layer < LONG_TERM_LAYERS)) continue
      const lastMs = parseIso(item.lastMentionedAt) || parseIso(item.firstSeenAt) || atMs
      const days = wholeDaysBetween(lastMs, atMs)
      const threshold = DECAY_DAYS[layer - 1]
      if (days >= threshold) {
        moves.push({ item, from: layer, to: layer + 1, reason: `超过 ${threshold} 天未提及，下沉一层` })
      }
    }
    for (const move of moves) {
      const fromList = this._layers[move.from - 1]
      const index = fromList.findIndex((item) => item.id === move.item.id)
      if (index === -1) continue
      fromList.splice(index, 1)
      move.item.layer = move.to
      move.item.history.push({ at: atIso, from: move.from, to: move.to, reason: move.reason })
      move.item.lastLayerChangeAt = atIso
      this._layers[move.to - 1].push(move.item)
      if (move.to < move.from) report.promoted += 1
      else if (move.to > move.from) {
        report.demoted += 1
        const compaction = this._compactMemoryForLayer(move.item, move, atIso)
        if (compaction) {
          report.compacted += 1
          report.savedChars += compaction.savedChars
          events.push({
            at: atIso,
            type: 'memory_compacted',
            itemId: move.item.id,
            message: `进入第${move.to}层，记忆压缩至 ${Math.round(this.config.layerCompactionRatio * 100)}%（${compaction.originalLength} → ${compaction.compactedLength} 字）`,
            from: layerLabel(move.from),
            to: layerLabel(move.to),
            originalLength: compaction.originalLength,
            compactedLength: compaction.compactedLength,
            savedChars: compaction.savedChars,
            count: compaction.count,
          })
        }
      }
      events.push({
        at: atIso,
        type: 'layer_moved',
        itemId: move.item.id,
        message: `${move.reason}：${move.item.summary}`,
        from: layerLabel(move.from),
        to: layerLabel(move.to),
        reason: move.reason,
      })
    }

    // 3.5 短期话题记忆超过 5w 字时，按重要度/提及次数低的一半转入长期
    events.push(...this._enforceShortTermOverflow(atIso))

    // 4. 更新维护基准、补齐关键词/分类、重算派生字段
    for (const item of this._layers.flat()) {
      this._fillItemFields(item)
      item.mentionCountAtLastMaintenance = item.mentionCount
      recomputeDerived(item)
    }

    // 5. 更新 meta（维护历史只保留最近 N 次）并重建 index / 总览
    for (let layer = 1; layer <= LONG_TERM_LAYERS; layer += 1) {
      report.layerCounts[layer] = this._layers[layer - 1].length
    }
    const total = this._short.length + this._layers.reduce((sum, items) => sum + items.length, 0)
    this._meta.lastMaintenanceAt = atIso
    this._meta.lastMaintenanceDateKey = dayKey
    this._meta.lastMaintenanceReason = reason
    this._meta.maintenanceHistory.push({
      at: atIso,
      reason,
      transferred: report.transferred,
      promoted: report.promoted,
      demoted: report.demoted,
      compacted: report.compacted,
      savedChars: report.savedChars,
      layerCounts: { ...report.layerCounts },
      shortCount: this._short.length,
      total,
    })
    if (this._meta.maintenanceHistory.length > this.config.maintenanceHistoryLimit) {
      this._meta.maintenanceHistory = this._meta.maintenanceHistory.slice(-this.config.maintenanceHistoryLimit)
    }
    events.push({
      at: atIso,
      type: 'maintenance',
      message: `完成记忆维护（${reason}）：夜间转移 ${report.transferred} 条，上浮 ${report.promoted} 条，下沉 ${report.demoted} 条，压缩 ${report.compacted} 条（节省 ${report.savedChars} 字）。`,
      transferred: report.transferred,
      promoted: report.promoted,
      demoted: report.demoted,
      compacted: report.compacted,
      savedChars: report.savedChars,
    })
    const indexDoc = this._persist(atIso, events)

    // 6. 返回报告
    report.shortCount = this._short.length
    report.total = total
    report.indexKeywords = Object.keys(indexDoc.keywords).length
    return report
  }

  // ───────────────────────────── 渲染 ─────────────────────────────

  /**
   * 生成注入 system prompt 的「记忆上下文」（SPEC 4.13）。
   * @param {{ latestUserText?: string, at?: string|number, maxChars?: number }} [options]
   * @returns {string}
   */
  renderDigest(options = {}) {
    this.ensure()
    this._consumePendingSeedFile()
    const atMs = this._atMs(options.at)
    const maxChars = Number.isFinite(Number(options.maxChars))
      ? Math.max(0, Math.floor(Number(options.maxChars)))
      : this.config.digestMaxChars
    const latestUserText = String(options.latestUserText ?? '').trim()
    // 新流程：短期记忆全部加载；长期记忆只按 keywords 预加载命中项到短期。
    // 不把第一层/其余层的完整正文再塞进上下文。
    if (latestUserText) this.prepareForMessage(latestUserText, { at: atMs })
    const shortTop = [...this._short]
      .sort((a, b) => (b.importance || 0) - (a.importance || 0) || compareItemId(a.id, b.id))
      .slice(0, this.config.digestShortLimit)
      .map(cloneItem)
    return renderDigestText({
      shortItems: shortTop,
      longHits: [],
      layerCounts: this._layers.map((items) => items.length),
      maxChars,
      digestShortLimit: this.config.digestShortLimit,
      digestLongLimit: this.config.digestLongLimit,
    })
  }

  /** 仅重建 index/总览/持久化文件（用于批量重索引后刷新索引）。 */
  rebuildIndex(options = {}) {
    this.ensure()
    const atIso = formatLocalIso(this._atMs(options.at))
    const indexDoc = this._persist(atIso, [])
    return { updatedAt: atIso, keywords: Object.keys(indexDoc.keywords || {}).length }
  }

  /** 重新生成「记忆总览.md」，返回文件绝对路径。 */
  writeOverview() {
    this.ensure()
    const updatedAt = this._nowIso()
    this.store.saveOverview(this._overviewText(updatedAt))
    return this.paths.overviewFile
  }

  // ───────────────────────────── 查询 ─────────────────────────────

  /** 删除指定 id 的记忆（用于清理污染记忆）；同时从 index/总览移除。 */
  removeItems(ids, options = {}) {
    this.ensure()
    const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)).filter(Boolean))
    if (wanted.size === 0) return { removed: 0, ids: [] }
    const before = this._allItems().length
    this._short = this._short.filter((item) => !wanted.has(item.id))
    this._layers = this._layers.map((items) => items.filter((item) => !wanted.has(item.id)))
    const after = this._allItems().length
    const removedIds = [...wanted].filter((id) => !this._allItems().some((item) => item.id === id))
    const atIso = formatLocalIso(this._atMs(options.at))
    this._persist(atIso, removedIds.map((id) => ({
      at: atIso,
      type: 'memory_removed',
      itemId: id,
      message: `清理记忆：${id}`,
      reason: typeof options.reason === 'string' ? options.reason : '清理污染记忆',
    })))
    return { removed: before - after, ids: removedIds }
  }

  /** 列出带生成图片的特殊记忆（最近优先），供生图提示词参考。 */
  listImageMemories(limit = 8) {
    this.ensure()
    const max = Math.max(1, Math.min(40, Math.round(Number(limit) || 8)))
    return this._allItems()
      .filter((item) => item.metadata && (item.metadata.image === true || item.metadata.type === 'generated_image'))
      .sort(
        (a, b) =>
          (b.lastMentionedAt || '').localeCompare(a.lastMentionedAt || '') ||
          (b.importance || 0) - (a.importance || 0) ||
          compareItemId(a.id, b.id),
      )
      .slice(0, max)
      .map(cloneItem)
  }

  /** 列出某层记忆拷贝：'short' | 1..7。 */
  listLayer(layer) {
    this.ensure()
    if (layer === 'short' || layer === '短期') return this._short.map(cloneItem)
    const number = Number(layer)
    if (!Number.isInteger(number) || number < 1 || number > LONG_TERM_LAYERS) {
      throw new Error(`无效的记忆层级：${String(layer)}`)
    }
    return this._layers[number - 1].map(cloneItem)
  }

  /** 按 id 查找记忆拷贝；不存在返回 undefined。 */
  getItem(id) {
    this.ensure()
    const found = this._allItems().find((item) => item.id === id)
    return found ? cloneItem(found) : undefined
  }

  // ───────────────────────────── 内部实现 ─────────────────────────────

  _now() {
    const value = Number(this.clock.now())
    return Number.isFinite(value) ? value : Date.now()
  }

  _nowIso() {
    return formatLocalIso(this._now())
  }

  _atMs(at) {
    return toEpochMs(at, this._now())
  }

  _allItems() {
    return [...this._short, ...this._layers.flat()]
  }

  _normalizeMeta(raw, nowIso) {
    const meta = { ...raw }
    meta.schemaVersion = SCHEMA_VERSION
    meta.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : nowIso
    meta.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso
    meta.lastMaintenanceAt = typeof raw.lastMaintenanceAt === 'string' ? raw.lastMaintenanceAt : null
    meta.lastMaintenanceDateKey =
      typeof raw.lastMaintenanceDateKey === 'string' ? raw.lastMaintenanceDateKey : null
    meta.lastMaintenanceReason =
      typeof raw.lastMaintenanceReason === 'string' ? raw.lastMaintenanceReason : null
    meta.maintenanceHistory = Array.isArray(raw.maintenanceHistory)
      ? raw.maintenanceHistory.filter((entry) => entry && typeof entry === 'object')
      : []
    meta.processedMessageIds = Array.isArray(raw.processedMessageIds)
      ? raw.processedMessageIds.filter((id) => typeof id === 'string').slice(-this.config.processedMessageIdLimit)
      : []
    meta.sequence = Number.isFinite(Number(raw.sequence)) ? Math.max(0, Math.round(Number(raw.sequence))) : 0
    // 防止 meta.sequence 落后于已有记忆编号（手工编辑数据时也能正确续号）
    for (const item of this._allItems()) {
      const match = /^mem-(\d+)$/u.exec(item.id)
      if (match) meta.sequence = Math.max(meta.sequence, Number(match[1]))
    }
    return meta
  }

  _nextItemId() {
    this._meta.sequence = Number(this._meta.sequence || 0) + 1
    return `mem-${String(this._meta.sequence).padStart(6, '0')}`
  }

  _createItem({
    id,
    content,
    summary,
    keywords,
    category,
    emphasis,
    source,
    atIso,
    mentionCount = 1,
    importanceOverride,
    layer = 'short',
    occurredAt,
    metadata,
  }) {
    const resolvedCategory = resolveCategory(category, content)
    return createMemoryItem({
      id: id === undefined ? this._nextItemId() : id,
      content,
      summary: summary && String(summary).trim() ? String(summary).trim() : buildSummary(content),
      keywords: normalizeKeywordList(keywords, content, resolvedCategory, { max: metadata?.llm ? 12 : 5 }),
      category: resolvedCategory,
      at: atIso,
      occurredAt,
      source,
      layer,
      mentionCount,
      emphasis,
      importanceOverride,
      metadata,
    })
  }

  /** 按 id 从短期/七层记忆中移除条目（seedMemories force 覆盖用）。返回是否移除。 */
  _removeItemById(id) {
    const shortIndex = this._short.findIndex((item) => item.id === id)
    if (shortIndex !== -1) {
      this._short.splice(shortIndex, 1)
      return true
    }
    for (const items of this._layers) {
      const index = items.findIndex((item) => item.id === id)
      if (index !== -1) {
        items.splice(index, 1)
        return true
      }
    }
    return false
  }

  _fillItemFields(item) {
    item.summary = item.summary && String(item.summary).trim() ? item.summary : buildSummary(item.content)
    if (!MEMORY_CATEGORIES.includes(item.category)) item.category = classifyCategory(item.content)
    item.keywords = normalizeKeywordList(item.keywords, item.content, item.category, {
      max: item.metadata && item.metadata.llm ? 12 : 5,
    })
    return item
  }

  _findDuplicate(content) {
    const normalized = normalizeForDedup(content)
    if (!normalized) return null
    for (const item of this._allItems()) {
      const other = normalizeForDedup(item.content)
      if (!other) continue
      if (other === normalized || other.includes(normalized) || normalized.includes(other)) return item
    }
    return null
  }

  _mentionKeywords(item) {
    if (!Array.isArray(item.keywords)) return []
    return item.keywords.filter((keyword) => typeof keyword === 'string' && keyword.trim() && !isTagKeyword(keyword))
  }

  _tryMention(item, text, atIso, hasEmphasisWord, mentioned, mentionedIds) {
    const keywords = this._mentionKeywords(item)
    if (!keywords.some((keyword) => text.includes(keyword))) return false
    item.mentionCount += 1
    item.lastMentionedAt = atIso
    if (hasEmphasisWord) item.emphasis = Math.min(3, item.emphasis + 1)
    recomputeDerived(item)
    mentionedIds.add(item.id)
    mentioned.push({ id: item.id, mentionCount: item.mentionCount })
    return true
  }

  _candidateImportance(raw) {
    const emphasis = clamp(Number(raw && raw.emphasis) || 0, 0, 3)
    const mentionCount = Number.isFinite(Number(raw && raw.mentionCount)) ? Number(raw.mentionCount) : 1
    return 20 + 10 * Math.min(mentionCount, 6) + 10 * Math.min(emphasis, 3)
  }

  _roundScore(score) {
    return Math.round(score * 1000) / 1000
  }

  _scoreItem(item, query) {
    let score = 0
    let matched = false
    const keywords = this._mentionKeywords(item)
    keywords.forEach((keyword, index) => {
      const hit = query.includes(keyword) || keyword.includes(query)
      if (!hit) return
      matched = true
      score += Math.max(0.3, 1 - index * 0.2)
    })
    if (item.category && query.includes(item.category)) {
      matched = true
      score += 0.5
    }
    if (query.length >= 2 && String(item.content || '').includes(query)) {
      matched = true
    }
    if (!matched) return 0
    score += (Number(item.importance) || 0) / 100
    score += item.layer === 'short' ? 2 : (8 - Number(item.layer)) * 0.2
    return score
  }

  _enforceShortTermOverflow(atIso) {
    const events = []
    // 1) 普通记忆条数上限（会话话题记忆不受 20 条限制；它们由字数和 5w 上限控制）
    while (true) {
      const factItems = this._short.filter((item) => item.kind !== 'conversation')
      if (factItems.length <= this.config.shortTermCapacity) break
      const moveCount = Math.max(1, Math.floor(factItems.length / 2))
      const sorted = [...factItems].sort(
        (a, b) => (parseIso(a.firstSeenAt) || 0) - (parseIso(b.firstSeenAt) || 0) || compareItemId(a.id, b.id),
      )
      const moving = sorted.slice(0, Math.min(moveCount, sorted.length))
      const movingIds = new Set(moving.map((item) => item.id))
      this._short = this._short.filter((item) => !movingIds.has(item.id))
      for (const item of moving) {
        item.layer = 1
        item.history.push({
          at: atIso,
          from: 'short',
          to: 1,
          reason: '短期记忆条数已满，最早的一半转入长期记忆第一层',
        })
        item.lastLayerChangeAt = atIso
        recomputeDerived(item)
        this._layers[0].push(item)
        events.push({
          at: atIso,
          type: 'layer_moved',
          itemId: item.id,
          message: `短期记忆条数已满，将最早的一半转入长期记忆第一层（${item.summary}）`,
          from: layerLabel('short'),
          to: layerLabel(1),
          reason: '短期记忆条数已满，最早的一半转入长期记忆第一层',
        })
      }
    }

    // 2) 短期记忆总字数上限（默认 5w）：超限时把重要度低、提及次数少的一半转入长期第一层
    const charLimit = Math.max(1000, Number(this.config.shortTermCharLimit) || 50000)
    const totalChars = this._short.reduce((sum, item) => sum + String(item.content ?? '').length, 0)
    if (totalChars > charLimit && this._short.length > 0) {
      const ratio = Math.min(1, Math.max(0.1, Number(this.config.shortTermOverflowMoveRatio) || 0.5))
      const moveCount = Math.max(1, Math.floor(this._short.length * ratio))
      const sorted = [...this._short].sort(
        (a, b) =>
          (Number(a.importance) || 0) - (Number(b.importance) || 0) ||
          (Number(a.mentionCount) || 0) - (Number(b.mentionCount) || 0) ||
          (parseIso(a.lastMentionedAt) || 0) - (parseIso(b.lastMentionedAt) || 0) ||
          compareItemId(a.id, b.id),
      )
      const moving = sorted.slice(0, Math.min(moveCount, sorted.length))
      const movingIds = new Set(moving.map((item) => item.id))
      this._short = this._short.filter((item) => !movingIds.has(item.id))
      for (const item of moving) {
        item.layer = 1
        item.history.push({
          at: atIso,
          from: 'short',
          to: 1,
          reason: '短期记忆超过字数上限，按重要度/提及次数较低的一半转入长期记忆第一层',
        })
        item.lastLayerChangeAt = atIso
        recomputeDerived(item)
        this._layers[0].push(item)
        events.push({
          at: atIso,
          type: 'layer_moved',
          itemId: item.id,
          message: `短期记忆超过 ${charLimit} 字，将重要度较低的一半转入长期记忆第一层（${item.summary}）`,
          from: layerLabel('short'),
          to: layerLabel(1),
          reason: '短期记忆超过字数上限，按重要度/提及次数较低的一半转入长期记忆第一层',
        })
      }
    }
    return events
  }

  _buildIndex(updatedAt) {
    const keywords = {}
    const categories = {}
    const add = (map, key, id) => {
      if (!map[key]) map[key] = []
      map[key].push(id)
    }
    for (const item of this._allItems()) {
      for (const keyword of item.keywords || []) {
        if (typeof keyword !== 'string' || !keyword || keyword.startsWith('#')) continue
        add(keywords, keyword, item.id)
      }
      if (item.category) add(categories, item.category, item.id)
    }
    const layers = { short: this._short.length }
    for (let layer = 1; layer <= LONG_TERM_LAYERS; layer += 1) {
      layers[layer] = this._layers[layer - 1].length
    }
    return { schemaVersion: SCHEMA_VERSION, updatedAt, keywords, categories, layers }
  }

  _overviewText(updatedAt) {
    return buildOverviewMarkdown({
      shortItems: this._short,
      layers: this._layers,
      meta: this._meta,
      updatedAt,
    })
  }

  _persist(atIso, events = []) {
    this._meta.updatedAt = atIso
    this._meta.schemaVersion = SCHEMA_VERSION
    this.store.saveShortTerm(this._short, this.config.shortTermCapacity, atIso)
    for (let layer = 1; layer <= LONG_TERM_LAYERS; layer += 1) {
      this.store.saveLayer(layer, this._layers[layer - 1], atIso)
    }
    const indexDoc = this._buildIndex(atIso)
    this.store.saveIndex(indexDoc)
    this.store.saveMeta(this._meta)
    this.store.saveOverview(this._overviewText(atIso))
    for (const event of events) {
      if (event) this.store.appendEvent(event)
    }
    this._index = indexDoc
    return indexDoc
  }
}
