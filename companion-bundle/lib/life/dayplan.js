/**
 * 每日生活事件计划：数据结构、时间槽位、到期判定与本地持久化（功能 2「每日生活事件计划」生成部分）。
 *
 * 计划文件路径：<dataDir>/life/day-plan-<YYYY-MM-DD>.json
 * 计划结构（PLAN_VERSION = 1）：
 * {
 *   version: 1,
 *   dateKey: '2026-11-06',
 *   characterId: 'ophelia',
 *   generatedAt: '2026-11-06T04:30:00+08:00',
 *   source: 'nightly-memory-maintenance' | 'ensure',
 *   events: [{
 *     id: 'evt-1',
 *     time: '09:20',
 *     title: '...',
 *     content: '...',
 *     sourceType: 'memory' | 'web' | 'life',
 *     sourceTitle?: '...', sourceUrl?: '...', sourceSnippet?: '...',
 *     sentAt: null | '2026-11-06T09:21:00+08:00',
 *   }],
 * }
 *
 * 本模块是同步纯函数 + 原子文件读写：
 *  - 生成端（Host 凌晨记忆维护）调用 createPlanShell / saveDayPlan；
 *  - 发送端（QQ 通道）调用 loadDayPlan / listDueEvents / markEventSent。
 * 仅依赖 node:* 内置模块与 ../shared 下的共享工具（不允许安装任何 npm 依赖）。
 */
import path from 'node:path'
import { readJsonSync, writeJsonSync } from '../shared/fsutil.js'
import { formatLocalIso } from '../shared/clock.js'

/** 计划 schema 版本。 */
export const PLAN_VERSION = 1

/** 计划目录名（<dataDir>/life）。 */
export const PLAN_DIRNAME = 'life'

/** 默认事件时间池（本地时间 HH:mm，生成时会加 ±SLOT_JITTER_MINUTES 分钟抖动）。 */
export const DEFAULT_TIME_POOL = Object.freeze(['07:40', '10:20', '13:40', '16:30', '19:10', '21:10', '22:40'])

/** 当天主时间池不够用时的更晚时间。 */
export const LATE_TIME_POOL = Object.freeze(['23:20'])

/** 完整时间池（升序）。 */
export const TIME_POOL = Object.freeze([...DEFAULT_TIME_POOL, ...LATE_TIME_POOL])

/** 时间槽位抖动幅度（分钟，±）。 */
export const SLOT_JITTER_MINUTES = 20

/** 到期宽限：事件时间过去超过该时长就不再补发（默认 6 小时）。 */
export const DUE_GRACE_MS = 6 * 60 * 60 * 1000

/** 每日事件数量范围。默认生成 5–7 条，保持 QQ 活跃。
 *  MIN_EVENTS 保留 2，兼容旧计划；新计划由 LIFE config 默认生成 5–7。
 */
export const MIN_EVENTS = 2
export const MAX_EVENTS = 7

/** 事件字段长度上限（生成端合法化与校验共用）。 */
export const MAX_EVENT_TITLE_CHARS = 40
export const MAX_EVENT_CONTENT_CHARS = 600
export const MAX_TOTAL_CONTENT_CHARS = 6000

/** 事件来源类型枚举。 */
export const EVENT_SOURCE_TYPES = Object.freeze(['memory', 'web', 'life'])

/** 事件内容类型（用于每日随机化，让生活分享不总是同一种日常）。 */
export const EVENT_TYPES = Object.freeze(['日常', '回忆', '阅读', '外出', '休息', '整理', '料理'])

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/u
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/u
const MAX_MINUTE_OF_DAY = 23 * 60 + 59

function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 解析日期键 YYYY-MM-DD 为本地日期（校验真实存在的日期，拒绝 2026-02-30）。
 * @param {string} dateKey
 * @returns {{ year: number, month: number, day: number, date: Date }}
 */
export function parseDateKey(dateKey) {
  const text = String(dateKey ?? '').trim()
  const match = DATE_KEY_RE.exec(text)
  if (!match) throw new Error(`日期键非法：「${text}」，应为 YYYY-MM-DD。`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day, 12, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`日期键非法：「${text}」不是一个真实日期。`)
  }
  return { year, month, day, date }
}

/**
 * 本地时区日期键 YYYY-MM-DD。
 * @param {Date|number|string} [date] Date / 毫秒时间戳 / 可被 Date 解析的字符串
 * @returns {string}
 */
export function formatDateKey(date = new Date()) {
  let value
  if (date instanceof Date) value = date
  else if (typeof date === 'number') value = new Date(date)
  else value = new Date(String(date))
  if (Number.isNaN(value.getTime())) throw new Error(`无效日期：${String(date)}`)
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
}

/**
 * 日期键加减天数（本地日历，自动跨月/跨年）。
 * @param {string} dateKey YYYY-MM-DD
 * @param {number} delta 天数（可为负）
 * @returns {string} YYYY-MM-DD
 */
export function addDays(dateKey, delta = 0) {
  const days = Number(delta)
  if (!Number.isInteger(days)) throw new Error(`addDays 需要整数天数：${String(delta)}`)
  const { year, month, day } = parseDateKey(dateKey)
  return formatDateKey(new Date(year, month - 1, day + days, 12, 0, 0, 0))
}

/**
 * 计划文件绝对路径：<dataDir>/life/day-plan-<dateKey>.json
 * @param {string} dataDir 角色数据目录
 * @param {string} dateKey YYYY-MM-DD
 * @returns {string}
 */
export function resolvePlanPath(dataDir, dateKey) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new Error('每日计划需要合法的 dataDir（角色数据目录）。')
  }
  parseDateKey(dateKey)
  return path.join(path.resolve(dataDir), PLAN_DIRNAME, `day-plan-${dateKey}.json`)
}

/**
 * 读取某天的计划；文件不存在或内容损坏时返回 undefined（发送端调用不应因此崩溃）。
 * @param {string} dataDir
 * @param {string} dateKey
 * @returns {object|undefined}
 */
export function loadDayPlan(dataDir, dateKey) {
  const file = resolvePlanPath(dataDir, dateKey)
  try {
    const plan = readJsonSync(file)
    return plan === null || plan === undefined ? undefined : plan
  } catch {
    return undefined
  }
}

/**
 * 原子写入计划文件（覆盖同日期旧计划）；结构非法时抛错，避免把坏计划交给发送端。
 * @param {string} dataDir
 * @param {object} plan
 * @returns {object} 写入的 plan（便于链式调用）
 */
export function saveDayPlan(dataDir, plan) {
  const errors = collectPlanErrors(plan)
  if (errors.length > 0) {
    throw new Error(`每日计划结构非法，拒绝写入：${errors.slice(0, 3).join('；')}`)
  }
  writeJsonSync(resolvePlanPath(dataDir, plan.dateKey), plan)
  return plan
}

/**
 * 创建空计划骨架（生成端在写入事件前调用）。
 * @param {{ dateKey: string, characterId?: string, nowIso?: string, source?: string }} options
 * @returns {object}
 */
export function createPlanShell({ dateKey, characterId = 'ophelia', nowIso, source = 'ensure' } = {}) {
  parseDateKey(dateKey)
  return {
    version: PLAN_VERSION,
    dateKey,
    characterId: String(characterId || 'ophelia'),
    generatedAt: typeof nowIso === 'string' && nowIso ? nowIso : formatLocalIso(Date.now()),
    source,
    events: [],
  }
}

/**
 * mulberry32 确定性随机数生成器：同一 seedString 产生同一序列，便于测试复现与按日期稳定生成。
 * @param {string} seedString
 * @returns {() => number} 返回 [0, 1) 的随机函数
 */
export function createSeededRandom(seedString) {
  const text = String(seedString ?? '')
  let hash = 1779033703 ^ text.length
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353)
    hash = (hash << 13) | (hash >>> 19)
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507)
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
  let state = (hash ^ (hash >>> 16)) >>> 0
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function randomValue(random) {
  try {
    const value = typeof random === 'function' ? Number(random()) : Number.NaN
    if (Number.isFinite(value)) return Math.min(0.999999, Math.max(0, value))
  } catch {
    // 随机函数异常时退回中点，保证计划生成不中断
  }
  return 0.5
}

/** 把 HH:mm 解析为当天分钟数（0-1439）。 */
export function parseTimeToMinutes(time) {
  const match = TIME_RE.exec(String(time ?? '').trim())
  if (!match) throw new Error(`时间格式非法：「${String(time)}」，应为 HH:mm。`)
  return Number(match[1]) * 60 + Number(match[2])
}

/** 把当天分钟数格式化为 HH:mm（0-1439）。 */
export function formatMinutesAsTime(minutes) {
  const value = Math.min(MAX_MINUTE_OF_DAY, Math.max(0, Math.round(Number(minutes) || 0)))
  return `${pad2(Math.floor(value / 60))}:${pad2(value % 60)}`
}

/**
 * 事件开始时间（本地时区毫秒时间戳）。
 * @param {string} dateKey
 * @param {string} time HH:mm
 * @returns {number}
 */
export function eventStartMs(dateKey, time) {
  const { year, month, day } = parseDateKey(dateKey)
  const minutes = parseTimeToMinutes(time)
  return new Date(year, month - 1, day, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime()
}

function jitteredMinutes(baseMinutes, random) {
  const offset = Math.round((randomValue(random) * 2 - 1) * SLOT_JITTER_MINUTES)
  return Math.min(MAX_MINUTE_OF_DAY, Math.max(0, baseMinutes + offset))
}

/**
 * 从时间池中挑选 count 个「未来」时间（升序，HH:mm）。
 *  - 目标日期在未来：时间池全部可用（加 ±20 分钟抖动）；
 *  - 目标日期是今天：跳过已经过去的时间；不够时用更晚的 21:00/22:30，
 *    仍不够则从 now 之后按 30 分钟间隔补足到 23:59。
 * @param {{ dateKey: string, nowMs?: number, count?: number, random?: () => number }} options
 * @returns {string[]} 升序 HH:mm 列表（当天深夜可能少于 count）
 */
export function selectEventSlots({ dateKey, nowMs = Date.now(), count = 3, random } = {}) {
  parseDateKey(dateKey)
  const now = Number(nowMs)
  if (!Number.isFinite(now)) throw new Error('selectEventSlots 需要合法的 nowMs（毫秒时间戳）。')
  const todayKey = formatDateKey(now)
  if (dateKey < todayKey) throw new Error(`不能为过去的日期安排事件：${dateKey}`)
  const wanted = Math.min(MAX_EVENTS, Math.max(1, Math.round(Number(count) || 3)))
  const nowDate = new Date(now)
  const nowMinutes =
    dateKey === todayKey ? nowDate.getHours() * 60 + nowDate.getMinutes() : -1

  const candidates = []
  const used = new Set()
  for (const slot of TIME_POOL) {
    let minutes = jitteredMinutes(parseTimeToMinutes(slot), random)
    while (used.has(minutes) && minutes < MAX_MINUTE_OF_DAY) minutes += 1
    if (used.has(minutes)) continue
    used.add(minutes)
    candidates.push(minutes)
  }
  candidates.sort((a, b) => a - b)

  let future = candidates.filter((minutes) => minutes > nowMinutes)
  if (future.length < wanted && dateKey === todayKey) {
    for (let minutes = nowMinutes + 15; minutes <= MAX_MINUTE_OF_DAY && future.length < wanted; minutes += 30) {
      if (used.has(minutes)) continue
      used.add(minutes)
      future.push(minutes)
    }
    future.sort((a, b) => a - b)
  }
  if (future.length > wanted) {
    // 可用时间多于需要的数量时，用种子随机挑 count 个（每天的时段组合更有变化），最后按时间升序
    for (let index = future.length - 1; index > 0; index -= 1) {
      const other = Math.floor(randomValue(random) * (index + 1))
      const temp = future[index]
      future[index] = future[other]
      future[other] = temp
    }
    future = future.slice(0, wanted)
    future.sort((a, b) => a - b)
  }
  return future.slice(0, wanted).map(formatMinutesAsTime)
}

/**
 * 列出「此刻应当发送」的事件（按时间升序，带原数组 index）。
 * 条件：未发送（sentAt 为空）、计划日期就是今天、事件时间已到、且当前时间 - 事件时间 <= graceMs。
 * @param {object|undefined} plan
 * @param {number} [nowMs]
 * @param {{ graceMs?: number }} [options]
 * @returns {Array<object>} 事件浅拷贝 + index（不修改传入 plan）
 */
export function listDueEvents(plan, nowMs = Date.now(), { graceMs = DUE_GRACE_MS } = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.events) || typeof plan.dateKey !== 'string') {
    return []
  }
  const now = Number(nowMs)
  if (!Number.isFinite(now)) return []
  if (plan.dateKey !== formatDateKey(now)) return []
  const grace = Number.isFinite(Number(graceMs)) ? Math.max(0, Number(graceMs)) : DUE_GRACE_MS
  const due = []
  plan.events.forEach((event, index) => {
    if (!event || typeof event !== 'object') return
    if (event.sentAt || event.canceledAt) return
    let startMs
    try {
      startMs = eventStartMs(plan.dateKey, event.time)
    } catch {
      return
    }
    if (!Number.isFinite(startMs)) return
    if (now < startMs) return
    if (now - startMs > grace) return
    due.push({ ...event, index })
  })
  due.sort((a, b) => {
    try {
      return parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time)
    } catch {
      return (a.index ?? 0) - (b.index ?? 0)
    }
  })
  return due
}

/**
 * 标记事件已发送：返回新的 plan（纯函数，浅拷贝，不修改入参）。
 * @param {object} plan
 * @param {string|number|{id?: string}} eventIdOrIndex 事件 id（如 evt-1）、数组下标或带 id 的事件对象
 * @param {string} [atIso] 发送时间（默认当前本地 ISO）
 * @returns {object} 新的 plan
 */
export function markEventSent(plan, eventIdOrIndex, atIso = formatLocalIso(Date.now())) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.events)) {
    throw new Error('markEventSent 需要合法的计划对象。')
  }
  const at = typeof atIso === 'string' && atIso.trim() ? atIso.trim() : formatLocalIso(Date.now())
  const fromObject =
    eventIdOrIndex && typeof eventIdOrIndex === 'object' ? eventIdOrIndex.id : undefined
  const targetId = typeof eventIdOrIndex === 'string' ? eventIdOrIndex : fromObject
  const targetIndex = typeof eventIdOrIndex === 'number' ? eventIdOrIndex : -1
  return {
    ...plan,
    events: plan.events.map((event, index) => {
      const matched = targetIndex >= 0 ? index === targetIndex : event?.id === targetId
      return matched ? { ...event, sentAt: at } : { ...event }
    }),
  }
}

/**
 * 收集计划结构错误（中文错误信息；空数组表示合法）。
 * @param {object} plan
 * @returns {string[]}
 */
export function collectPlanErrors(plan) {
  const errors = []
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return ['计划必须是一个对象。']
  }
  if (plan.version !== PLAN_VERSION) errors.push(`version 必须为 ${PLAN_VERSION}。`)
  try {
    parseDateKey(plan.dateKey)
  } catch (error) {
    errors.push(error.message)
  }
  if (typeof plan.characterId !== 'string' || !plan.characterId.trim()) {
    errors.push('characterId 必须是非空字符串。')
  }
  if (typeof plan.generatedAt !== 'string' || Number.isNaN(Date.parse(plan.generatedAt))) {
    errors.push('generatedAt 必须是可解析的 ISO 时间字符串。')
  }
  if (plan.source !== undefined && typeof plan.source !== 'string') {
    errors.push('source 必须是字符串。')
  }
  if (!Array.isArray(plan.events)) {
    errors.push('events 必须是数组。')
    return errors
  }
  if (plan.events.length < MIN_EVENTS || plan.events.length > MAX_EVENTS) {
    errors.push(`events 数量必须为 ${MIN_EVENTS}-${MAX_EVENTS} 个（当前 ${plan.events.length} 个）。`)
  }
  const ids = new Set()
  let totalChars = 0
  plan.events.forEach((event, index) => {
    const where = `events[${index}]`
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      errors.push(`${where} 必须是对象。`)
      return
    }
    if (typeof event.id !== 'string' || !event.id.trim()) {
      errors.push(`${where}.id 必须是非空字符串。`)
    } else if (ids.has(event.id)) {
      errors.push(`${where}.id 重复：${event.id}。`)
    } else {
      ids.add(event.id)
    }
    if (typeof event.time !== 'string' || !TIME_RE.test(event.time)) {
      errors.push(`${where}.time 必须是 HH:mm 格式。`)
    }
    if (event.pending === true) {
      // 延后生成内容的占位事件：只要求 id/time，标题/正文到点再补。
      return
    }
    if (typeof event.title !== 'string' || !event.title.trim()) {
      errors.push(`${where}.title 必须是非空字符串。`)
    } else if (event.title.length > MAX_EVENT_TITLE_CHARS) {
      errors.push(`${where}.title 不能超过 ${MAX_EVENT_TITLE_CHARS} 个字符。`)
    }
    if (typeof event.content !== 'string' || !event.content.trim()) {
      errors.push(`${where}.content 必须是非空字符串。`)
    } else {
      if (event.content.length > MAX_EVENT_CONTENT_CHARS) {
        errors.push(`${where}.content 不能超过 ${MAX_EVENT_CONTENT_CHARS} 个字符。`)
      }
      totalChars += event.content.length
    }
    if (event.sourceType !== undefined && !EVENT_SOURCE_TYPES.includes(event.sourceType)) {
      errors.push(`${where}.sourceType 必须是 ${EVENT_SOURCE_TYPES.join(' / ')} 之一。`)
    }
    if (event.type !== undefined && !EVENT_TYPES.includes(event.type)) {
      errors.push(`${where}.type 必须是 ${EVENT_TYPES.join(' / ')} 之一。`)
    }
    if (
      event.sentAt !== undefined &&
      event.sentAt !== null &&
      (typeof event.sentAt !== 'string' || Number.isNaN(Date.parse(event.sentAt)))
    ) {
      errors.push(`${where}.sentAt 必须是 null 或可解析的 ISO 时间字符串。`)
    }
  })
  if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
    errors.push(`events 内容总长度不能超过 ${MAX_TOTAL_CONTENT_CHARS} 个字符。`)
  }
  return errors
}

/**
 * 校验每日计划结构（供发送端/生成端使用）。
 * @param {object} plan
 * @returns {boolean}
 */
export function validateDayPlan(plan) {
  return collectPlanErrors(plan).length === 0
}
