/**
 * 维护调度判定（SPEC 4.9 / 4.12 checkMaintenance）。
 * 纯函数：只读 meta，不修改任何状态。
 */
import { formatLocalDate, localHour } from '../shared/clock.js'

/** 把 at（毫秒 / Date / ISO 字符串）归一为毫秒时间戳。 */
export function toEpochMs(at, fallback = Date.now()) {
  if (at === undefined || at === null) return fallback
  if (typeof at === 'number' && Number.isFinite(at)) return at
  if (at instanceof Date) return at.getTime()
  const parsed = Date.parse(String(at))
  return Number.isNaN(parsed) ? fallback : parsed
}

/**
 * 判定是否需要执行每日维护。
 * - 从未维护过（lastMaintenanceDateKey 缺失）→ 首次运行初始化，立即执行；
 * - 本地时间 04:00–06:00 且今天未维护 → 每日凌晨维护窗口；
 * - 本地时间 ≥06:00 且今天未维护（凌晨未运行）→ 补跑；
 * - 其余 → 不执行。
 * @param {{ at?: number|string|Date, meta?: object }} options
 * @returns {{ shouldRun: boolean, reason?: string }}
 */
export function decideMaintenance({ at, meta } = {}) {
  const atMs = toEpochMs(at)
  const lastKey = meta && typeof meta.lastMaintenanceDateKey === 'string' ? meta.lastMaintenanceDateKey : null
  if (!lastKey) {
    return { shouldRun: true, reason: '首次运行初始化' }
  }
  const todayKey = formatLocalDate(atMs)
  const hour = localHour(atMs)
  if (hour >= 4 && hour < 6 && lastKey !== todayKey) {
    return { shouldRun: true, reason: '每日凌晨维护窗口' }
  }
  if (hour >= 6 && lastKey < todayKey) {
    return { shouldRun: true, reason: '补跑（应用未在凌晨运行）' }
  }
  return { shouldRun: false }
}
