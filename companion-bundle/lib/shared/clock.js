/**
 * 共享时钟工具：系统时钟 / 测试用固定时钟、本地时区 ISO 时间格式化、日期与天数计算。
 * 记忆系统的时间戳统一使用「本地时区 ISO 8601」字符串，例如 2026-11-05T04:30:00+08:00。
 */

export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60 * MS_PER_SECOND
export const MS_PER_HOUR = 60 * MS_PER_MINUTE
export const MS_PER_DAY = 24 * MS_PER_HOUR

/** 系统时钟：返回 Date.now()。 */
export function createSystemClock() {
  return { now: () => Date.now() }
}

/**
 * 测试用固定时钟。
 * @param {string|number} [start] ISO 字符串或毫秒时间戳
 */
export function createFixedClock(start = '2026-11-05T04:30:00+08:00') {
  let current = typeof start === 'number' ? start : Date.parse(start)
  if (Number.isNaN(current)) throw new Error(`无效的测试时钟起点：${start}`)
  return {
    now: () => current,
    /** 设置到指定时刻（ISO 或毫秒），返回新的 now。 */
    set(next) {
      current = typeof next === 'number' ? next : Date.parse(next)
      if (Number.isNaN(current)) throw new Error(`无效的测试时钟时间：${next}`)
      return current
    },
    /** 前进指定毫秒，返回新的 now。 */
    advance(ms = 0) {
      current += ms
      return current
    },
    /** 前进指定天数。 */
    advanceDays(days = 0) {
      current += days * MS_PER_DAY
      return current
    },
  }
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/** 把毫秒时间格式化为本地时区 ISO 8601（带偏移，如 2026-11-05T04:30:00+08:00）。 */
export function formatLocalIso(ms = Date.now()) {
  const d = new Date(ms)
  const offsetMinutes = -d.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** 本地日期键 YYYY-MM-DD。 */
export function formatLocalDate(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地小时（0-23）。 */
export function localHour(ms = Date.now()) {
  return new Date(ms).getHours()
}

/** 两个时刻之间经过的整天数（向下取整，可为负）。 */
export function wholeDaysBetween(fromMs, toMs) {
  return Math.floor((toMs - fromMs) / MS_PER_DAY)
}

/** 解析 ISO 字符串为毫秒；非法返回 NaN。 */
export function parseIso(iso) {
  return Date.parse(iso)
}
