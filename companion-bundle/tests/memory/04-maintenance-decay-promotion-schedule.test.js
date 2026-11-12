/**
 * 覆盖验收编号：M8（七层衰减阈值）、M9（提及频率增加上浮）、M12（维护调度）。
 * 对应 验收/验收标准.md A. 记忆模块。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatLocalDate } from '../../lib/shared/clock.js'
import { DECAY_DAYS } from '../../lib/memory/constants.js'
import {
  MS_PER_DAY,
  createEngine,
  isoOf,
  localMs,
  makeItem,
  seedEngine,
} from './_helpers.mjs'

/** 预置一条位于指定长期层、指定「未提及天数」的记忆。 */
function seedLongTermItem({ startMs, layer, daysAgo, mentionCount = 1, emphasis = 0, content = '主人喜欢夜里听雨声。' }) {
  const item = makeItem({
    id: 'mem-000001',
    content,
    keywords: ['雨声', '夜晚', '喜欢'],
    category: '喜好',
    layer,
    mentionCount,
    emphasis,
    lastMentionedAt: isoOf(startMs - daysAgo * MS_PER_DAY),
    mentionCountAtLastMaintenance: mentionCount,
  })
  const layers = Array.from({ length: 7 }, () => [])
  layers[layer - 1] = [item]
  return seedEngine({ start: startMs, layers })
}

test('M8 七层衰减阈值：1/3/7/14/30/140 天到期下沉一层，未到期不动', (t) => {
  assert.deepEqual(DECAY_DAYS, [1, 3, 7, 14, 30, 140])
  const startMs = localMs(2026, 11, 15, 4, 30)
  for (let layer = 1; layer <= 6; layer += 1) {
    const threshold = DECAY_DAYS[layer - 1]

    // 恰好到期 → 下沉一层
    const dueCtx = seedLongTermItem({ startMs, layer, daysAgo: threshold })
    t.after(dueCtx.cleanup)
    const dueReport = dueCtx.engine.maintain({ at: startMs, reason: '每日凌晨维护窗口' })
    const dueItem = dueCtx.engine.getItem('mem-000001')
    assert.equal(dueItem.layer, layer + 1, `第 ${layer} 层满 ${threshold} 天应下沉到第 ${layer + 1} 层`)
    assert.equal(dueReport.demoted, 1, `第 ${layer} 层下沉计数应为 1`)
    const dueHistory = dueItem.history[dueItem.history.length - 1]
    assert.equal(dueHistory.from, layer)
    assert.equal(dueHistory.to, layer + 1)
    assert.ok(dueHistory.reason.includes(`超过 ${threshold} 天未提及`), `下沉原因不符：${dueHistory.reason}`)

    // 差一天到期 → 不动
    const freshCtx = seedLongTermItem({ startMs, layer, daysAgo: threshold - 1 })
    t.after(freshCtx.cleanup)
    const freshReport = freshCtx.engine.maintain({ at: startMs, reason: '每日凌晨维护窗口' })
    assert.equal(
      freshCtx.engine.getItem('mem-000001').layer,
      layer,
      `第 ${layer} 层未满 ${threshold} 天不应下沉`,
    )
    assert.equal(freshReport.demoted, 0)
  }
})

test('M8 第七层不再下沉', (t) => {
  const startMs = localMs(2026, 11, 15, 4, 30)
  const ctx = seedLongTermItem({ startMs, layer: 7, daysAgo: 9999 })
  t.after(ctx.cleanup)
  const report = ctx.engine.maintain({ at: startMs, reason: '每日凌晨维护窗口' })
  assert.equal(ctx.engine.getItem('mem-000001').layer, 7)
  assert.equal(report.demoted, 0)
})

test('M8 每条记忆每次维护最多移动一层', (t) => {
  const startMs = localMs(2026, 11, 15, 4, 30)
  const ctx = seedLongTermItem({ startMs, layer: 1, daysAgo: 365 })
  t.after(ctx.cleanup)
  const report = ctx.engine.maintain({ at: startMs, reason: '每日凌晨维护窗口' })
  assert.equal(ctx.engine.getItem('mem-000001').layer, 2, '一次维护只能下沉一层')
  assert.equal(report.demoted, 1)
})

test('M9 提及频率增加上浮：delta>=1 且 layer>1 → 上浮一层', (t) => {
  const startMs = localMs(2026, 11, 15, 4, 30)
  // 第 2 层、上次维护时提及 2 次、现在 3 次 → delta = 1
  const item = makeItem({
    id: 'mem-000001',
    layer: 2,
    mentionCount: 3,
    mentionCountAtLastMaintenance: 2,
    lastMentionedAt: isoOf(startMs - 3600_000),
  })
  const layers = Array.from({ length: 7 }, () => [])
  layers[1] = [item]
  const caseCtx = seedEngine({
    start: startMs,
    layers,
    meta: { lastMaintenanceDateKey: '2026-11-14' },
  })
  t.after(caseCtx.cleanup)
  const report = caseCtx.engine.maintain({ at: startMs, reason: '每日凌晨维护窗口' })
  const after = caseCtx.engine.getItem('mem-000001')
  assert.equal(report.promoted, 1)
  assert.equal(after.layer, 1)
  const lastHistory = after.history[after.history.length - 1]
  assert.equal(lastHistory.from, 2)
  assert.equal(lastHistory.to, 1)
  assert.equal(lastHistory.reason, '提及频率增加，上浮一层')
})

test('M9 delta=0 或 layer=1 时不上浮', (t) => {
  const startMs = localMs(2026, 11, 15, 4, 30)
  const noDelta = makeItem({
    id: 'mem-000001',
    layer: 2,
    mentionCount: 4,
    mentionCountAtLastMaintenance: 4,
    lastMentionedAt: isoOf(startMs - 3600_000),
  })
  const layersA = Array.from({ length: 7 }, () => [])
  layersA[1] = [noDelta]
  const ctxA = seedEngine({ start: startMs, layers: layersA })
  t.after(ctxA.cleanup)
  assert.equal(ctxA.engine.maintain({ at: startMs, reason: '每日凌晨维护窗口' }).promoted, 0)
  assert.equal(ctxA.engine.getItem('mem-000001').layer, 2)

  const layerOne = makeItem({
    id: 'mem-000001',
    layer: 1,
    mentionCount: 6,
    mentionCountAtLastMaintenance: 1,
    lastMentionedAt: isoOf(startMs - 3600_000),
  })
  const layersB = Array.from({ length: 7 }, () => [])
  layersB[0] = [layerOne]
  const ctxB = seedEngine({ start: startMs, layers: layersB })
  t.after(ctxB.cleanup)
  assert.equal(ctxB.engine.maintain({ at: startMs, reason: '每日凌晨维护窗口' }).promoted, 0)
  assert.equal(ctxB.engine.getItem('mem-000001').layer, 1)
})

test('M9 提升与下沉互斥且提升优先', (t) => {
  const startMs = localMs(2026, 11, 15, 4, 30)
  // 第 2 层、delta=1，同时已 10 天未提及（超过第 2→3 层的 3 天阈值）→ 应上浮而不是下沉
  const item = makeItem({
    id: 'mem-000001',
    layer: 2,
    mentionCount: 5,
    mentionCountAtLastMaintenance: 4,
    lastMentionedAt: isoOf(startMs - 10 * MS_PER_DAY),
  })
  const layers = Array.from({ length: 7 }, () => [])
  layers[1] = [item]
  const ctx = seedEngine({ start: startMs, layers })
  t.after(ctx.cleanup)
  const report = ctx.engine.maintain({ at: startMs, reason: '每日凌晨维护窗口' })
  const after = ctx.engine.getItem('mem-000001')
  assert.equal(report.promoted, 1)
  assert.equal(report.demoted, 0)
  assert.equal(after.layer, 1)
  assert.equal(after.history.length, 1)
  assert.ok(!after.history.some((entry) => String(entry.reason).includes('下沉')))
})

test('M9 端到端：下沉后再次被提及，下次维护上浮回第一层', (t) => {
  const ctx = createEngine({ start: localMs(2026, 11, 5, 4, 30) })
  t.after(ctx.cleanup)
  const { engine, clock } = ctx
  const item = engine.remember({
    content: '主人喜欢夜里听雨声。',
    keywords: ['雨声', '夜晚', '喜欢'],
  }).item
  engine.maintain({ at: localMs(2026, 11, 5, 4, 30), reason: '每日凌晨维护窗口' })
  assert.equal(engine.getItem(item.id).layer, 1)

  // 两天未提及 → 下沉到第二层
  clock.set(localMs(2026, 11, 7, 4, 30))
  const demoteReport = engine.maintain({ at: clock.now(), reason: '每日凌晨维护窗口' })
  assert.equal(demoteReport.demoted, 1)
  assert.equal(engine.getItem(item.id).layer, 2)

  // 再次提及 → mentionCount +1（delta = 1）
  clock.set(localMs(2026, 11, 7, 9, 0))
  const ingest = engine.ingestMessage({
    text: '昨晚的雨声真好听',
    messageId: 'm-promote-e2e',
    role: 'user',
    at: clock.now(),
  })
  assert.ok(ingest.mentioned.some((entry) => entry.id === item.id))

  // 下一次维护：提升优先，回到第一层
  const promoteReport = engine.maintain({ at: clock.now(), reason: '补跑（应用未在凌晨运行）' })
  assert.equal(promoteReport.promoted, 1)
  assert.equal(promoteReport.demoted, 0)
  const finalItem = engine.getItem(item.id)
  assert.equal(finalItem.layer, 1)
  assert.equal(finalItem.history[finalItem.history.length - 1].reason, '提及频率增加，上浮一层')
})

test('M12 维护调度：首次运行初始化、4-6 点窗口、6 点后补跑、当天不重复、跨天再次触发', (t) => {
  const startMs = localMs(2026, 11, 5, 3, 0)
  const ctx = createEngine({ start: startMs })
  t.after(ctx.cleanup)
  const { engine } = ctx

  // 首次运行：任何时间都判定需要执行（不改变状态）
  const before = engine.status()
  assert.deepEqual(engine.checkMaintenance({ at: startMs }), { shouldRun: true, reason: '首次运行初始化' })
  assert.deepEqual(engine.status(), before)
  assert.equal(engine.status().lastMaintenanceDateKey, null)

  // 手动完成首次维护（10:00，非窗口时间）
  engine.maintain({ at: localMs(2026, 11, 5, 10, 0), reason: '首次运行初始化' })
  assert.equal(engine.status().lastMaintenanceDateKey, formatLocalDate(localMs(2026, 11, 5, 10, 0)))

  // 当天已维护：窗口内与非窗口都不再执行
  assert.equal(engine.checkMaintenance({ at: localMs(2026, 11, 5, 4, 30) }).shouldRun, false)
  assert.equal(engine.checkMaintenance({ at: localMs(2026, 11, 5, 11, 0) }).shouldRun, false)

  // 次日凌晨 3 点：未到窗口，不执行
  assert.equal(engine.checkMaintenance({ at: localMs(2026, 11, 6, 3, 0) }).shouldRun, false)
  // 次日 4:00：凌晨窗口
  assert.deepEqual(engine.checkMaintenance({ at: localMs(2026, 11, 6, 4, 0) }), {
    shouldRun: true,
    reason: '每日凌晨维护窗口',
  })
  engine.maintain({ at: localMs(2026, 11, 6, 4, 30), reason: '每日凌晨维护窗口' })
  assert.equal(engine.checkMaintenance({ at: localMs(2026, 11, 6, 5, 59) }).shouldRun, false)

  // 后天 06:00：凌晨未运行 → 补跑
  assert.deepEqual(engine.checkMaintenance({ at: localMs(2026, 11, 7, 6, 0) }), {
    shouldRun: true,
    reason: '补跑（应用未在凌晨运行）',
  })
  engine.maintain({ at: localMs(2026, 11, 7, 6, 30), reason: '补跑（应用未在凌晨运行）' })
  assert.equal(engine.checkMaintenance({ at: localMs(2026, 11, 7, 23, 0) }).shouldRun, false)

  // 跨天再次触发凌晨窗口
  assert.deepEqual(engine.checkMaintenance({ at: localMs(2026, 11, 8, 4, 10) }), {
    shouldRun: true,
    reason: '每日凌晨维护窗口',
  })
})

test('M12 维护调度：昨天已维护、今天 6 点后未跑 → 补跑；checkMaintenance 纯函数', (t) => {
  const startMs = localMs(2026, 11, 5, 10, 0)
  const ctx = seedEngine({
    start: startMs,
    meta: {
      lastMaintenanceDateKey: '2026-11-04',
      lastMaintenanceAt: isoOf(localMs(2026, 11, 4, 4, 30)),
      lastMaintenanceReason: '每日凌晨维护窗口',
    },
  })
  t.after(ctx.cleanup)
  const { engine } = ctx
  const before = engine.status()
  assert.deepEqual(engine.checkMaintenance({ at: localMs(2026, 11, 5, 3, 0) }), { shouldRun: false })
  assert.deepEqual(engine.checkMaintenance({ at: localMs(2026, 11, 5, 5, 0) }), {
    shouldRun: true,
    reason: '每日凌晨维护窗口',
  })
  assert.deepEqual(engine.checkMaintenance({ at: localMs(2026, 11, 5, 6, 0) }), {
    shouldRun: true,
    reason: '补跑（应用未在凌晨运行）',
  })
  assert.deepEqual(engine.status(), before, 'checkMaintenance 不得修改记忆状态')

  const report = engine.maintain({ at: localMs(2026, 11, 5, 6, 30), reason: '补跑（应用未在凌晨运行）' })
  assert.equal(report.reason, '补跑（应用未在凌晨运行）')
  assert.equal(engine.status().lastMaintenanceDateKey, formatLocalDate(localMs(2026, 11, 5, 6, 30)))
  assert.equal(engine.checkMaintenance({ at: localMs(2026, 11, 5, 12, 0) }).shouldRun, false)
})
