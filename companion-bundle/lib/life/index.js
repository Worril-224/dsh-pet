/**
 * 每日生活事件计划模块公共入口（功能 2a · 生成部分）。
 *
 * 典型用法（Host 凌晨记忆维护）：
 *   import { generatePlanForMaintenance } from './life/index.js'
 *   const { dateKey, plan, generated } = await generatePlanForMaintenance({ dataDir, clock, persona, memory, llm, web, logger, modelSelection })
 *
 * 典型用法（QQ 通道发送端）：
 *   import { formatDateKey, loadDayPlan, listDueEvents, markEventSent, saveDayPlan,
 *            buildProactivePrompt, renderFallbackShare } from './life/index.js'
 *   const plan = loadDayPlan(dataDir, formatDateKey(clock.now()))
 *   const due = listDueEvents(plan, clock.now())
 *   for (const event of due) {
 *     // 生成分享文案（失败时用 renderFallbackShare(event)），发送 QQ 消息
 *     saveDayPlan(dataDir, markEventSent(plan, event.id, formatLocalIso(clock.now())))
 *   }
 *
 * 仅依赖 node:* 内置模块与包内相对导入。
 */
export {
  PLAN_VERSION,
  PLAN_DIRNAME,
  DEFAULT_TIME_POOL,
  LATE_TIME_POOL,
  TIME_POOL,
  SLOT_JITTER_MINUTES,
  DUE_GRACE_MS,
  MIN_EVENTS,
  MAX_EVENTS,
  MAX_EVENT_TITLE_CHARS,
  MAX_EVENT_CONTENT_CHARS,
  MAX_TOTAL_CONTENT_CHARS,
  EVENT_SOURCE_TYPES,
  parseDateKey,
  formatDateKey,
  addDays,
  resolvePlanPath,
  loadDayPlan,
  saveDayPlan,
  createPlanShell,
  createSeededRandom,
  parseTimeToMinutes,
  formatMinutesAsTime,
  eventStartMs,
  selectEventSlots,
  listDueEvents,
  markEventSent,
  collectPlanErrors,
  validateDayPlan,
} from './dayplan.js'

export {
  DEFAULT_LIFE_CONFIG,
  BUILTIN_READINGS,
  resolveLifeConfig,
  generateDayPlan,
  ensureDayPlan,
  generatePlanForMaintenance,
  buildDraftEvents,
} from './generator.js'

export { buildEventMaterial, buildProactivePrompt, renderFallbackShare } from './render.js'
