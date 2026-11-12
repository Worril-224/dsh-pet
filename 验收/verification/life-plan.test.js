/**
 * 独立验收测试 · 2026-11-06 新增能力（二）：每日生活事件计划 + 主动分享
 * 覆盖验收编号：QL1 QL2 QL3 QL4
 *
 * 全部使用假 LLM / 假 web / 假 adapter / 临时目录；不联网、不写 companion-data、不发真实 QQ 消息。
 * 测试由验收员 verifier 独立设计编写，不复用开发者测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUILTIN_READINGS,
  DUE_GRACE_MS,
  DEFAULT_LIFE_CONFIG,
  addDays,
  buildEventMaterial,
  buildProactivePrompt,
  collectPlanErrors,
  createPlanShell,
  ensureDayPlan,
  eventStartMs,
  formatDateKey,
  generateDayPlan,
  generatePlanForMaintenance,
  listDueEvents,
  loadDayPlan,
  markEventSent,
  renderFallbackShare,
  resolveLifeConfig,
  resolvePlanPath,
  saveDayPlan,
  selectEventSlots,
  validateDayPlan,
} from '../../companion-bundle/lib/life/index.js'
import { createQQHost } from '../../companion-bundle/lib/qq-host.js'
import { apply as applyHost } from '../../companion-bundle/lib/host.js'
import {
  makeFakeAdapter,
  makeFakeLlm,
  makeFakeWeb,
  makeMemorySessionStore,
  makeStubMemory,
  makeStubPersona,
} from './feature-helpers.mjs'
import { cleanupTempDirs, makeTempDir } from './helpers.mjs'

test.after(cleanupTempDirs)

const FIXED_MS = new Date(2026, 10, 6, 15, 0, 0).getTime() // 2026-11-06 15:00 本地时间
const TODAY = formatDateKey(FIXED_MS)
const TOMORROW = addDays(TODAY, 1)
const ROUTE = { provider: 'fake-provider', model: 'fake-model' }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 假 LLM：从 user 文本的【候选时间】里取时间，按合法 JSON 输出 events。 */
function makePlanLlm({ fail, rawText, sourceType = 'life' } = {}) {
  return makeFakeLlm({
    respond: (options) => {
      if (rawText !== undefined) return rawText
      const user = options.messages?.[0]?.content?.[0]?.text ?? ''
      const match = /【候选时间】([^\n]+)/u.exec(user)
      const times = match ? match[1].split('、').map((value) => value.trim()).filter(Boolean) : []
      const picked = times.slice(0, 3)
      if (picked.length === 0) return '{"events":[]}'
      const events = picked.map((time, index) => ({
        time,
        title: index === 2 ? '读到一篇文章' : index === 0 ? '整理近来的记录' : '把旧索引重排一遍',
        content: `我${index === 0 ? '上午' : index === 1 ? '午后' : '傍晚'}在档案馆里做了一件小事，把窗边的光留了一会儿。`,
        sourceType: index === 0 ? 'memory' : index === 2 ? sourceType : 'life',
      }))
      return JSON.stringify({ events })
    },
    fail,
  })
}

function makeLifeFixture({ llm, web, clockNow = FIXED_MS, dataDir } = {}) {
  const root = makeTempDir('dshpet-verify-life-')
  const dir = dataDir ?? path.join(root, 'ophelia')
  return {
    root,
    dataDir: dir,
    persona: makeStubPersona(),
    memory: makeStubMemory({ digest: '【记忆系统 · 自动注入】\n主人上周说想看海。' }),
    llm,
    web,
    clock: { now: () => clockNow },
    logger: { warnings: [], warn(message) { this.warnings.push(String(message)) } },
  }
}

function baseOptions(fixture, extra = {}) {
  return {
    dataDir: fixture.dataDir,
    dateKey: TODAY,
    characterId: 'ophelia',
    characterName: '奥菲莉亚',
    userAddress: '主人',
    persona: fixture.persona,
    memory: fixture.memory,
    llm: fixture.llm,
    web: fixture.web,
    clock: fixture.clock,
    logger: fixture.logger,
    config: { ...ROUTE, eventCount: 3 },
    ...extra,
  }
}

// ───────────────────────────── QL1 计划生成 ─────────────────────────────

test('QL1: LLM 合法 JSON → 5–7 个候选时间事件并落盘（含记忆/web 读物素材）', async () => {
  const web = makeFakeWeb({
    result: { sources: [{ title: '雨天的借阅单', snippet: '雨天来借书的人很少。', url: 'https://read.example/x' }] },
  })
  const llm = makePlanLlm({ sourceType: 'web' })
  const fixture = makeLifeFixture({ llm, web })
  const plan = await generateDayPlan(baseOptions(fixture))

  assert.equal(plan.dateKey, TODAY)
  assert.equal(plan.characterId, 'ophelia')
  assert.equal(plan.source, 'ensure')
  assert.equal(validateDayPlan(plan), true, `计划结构应合法：${collectPlanErrors(plan).join('；')}`)
  assert.ok(plan.events.length >= 5 && plan.events.length <= 7)
  for (const event of plan.events) {
    assert.match(event.time, /^\d{2}:\d{2}$/u)
    assert.ok(event.title.length > 0 && event.content.length > 0)
    assert.equal(event.sentAt, null)
    assert.ok(['memory', 'web', 'life'].includes(event.sourceType))
  }
  // 落盘
  const file = resolvePlanPath(fixture.dataDir, TODAY)
  assert.ok(fs.existsSync(file), '计划应写入 <dataDir>/life/day-plan-<dateKey>.json')
  assert.deepEqual(loadDayPlan(fixture.dataDir, TODAY), plan)
  // 素材进入提示词：记忆摘要、旧记忆、网络读物
  const streamOptions = llm.calls.stream[0]
  const userText = streamOptions.messages[0].content[0].text
  assert.match(streamOptions.system, /每日生活事件计划/u)
  assert.match(streamOptions.system, /JSON/u)
  assert.match(userText, /【最近记忆摘要】/u)
  assert.match(userText, /想看海/u)
  assert.match(userText, /网络上读到《雨天的借阅单》/u)
  assert.equal(web.calls.length, 1, '应调用 web.search 收集读物')
  // 读物事件带来源信息（sourceUrl 仅存储，不展示在消息里）
  const webEvent = plan.events.find((event) => event.sourceType === 'web')
  if (webEvent) {
    assert.equal(webEvent.sourceType, 'web')
    assert.ok(webEvent.sourceTitle)
    assert.equal(webEvent.sourceSnippet, '雨天来借书的人很少。')
  }
})

test('QL1: 凌晨维护生成「明天」计划；已有合法计划不重复生成，force 可覆盖', async () => {
  const fixture = makeLifeFixture({ llm: makePlanLlm(), web: makeFakeWeb({ result: { sources: [] } }) })
  const first = await generatePlanForMaintenance(baseOptions(fixture))
  assert.equal(first.dateKey, TOMORROW, '维护应生成明天的计划')
  assert.equal(first.generated, true)
  assert.equal(first.plan.source, 'nightly-memory-maintenance')
  assert.ok(fs.existsSync(resolvePlanPath(fixture.dataDir, TOMORROW)))

  const second = await generatePlanForMaintenance(baseOptions(fixture))
  assert.equal(second.generated, false, '已有合法计划时不应重复生成')
  assert.deepEqual(second.plan, first.plan)

  const forced = await generatePlanForMaintenance(baseOptions(fixture, { force: true }))
  assert.equal(forced.generated, true, 'force 应允许覆盖')
})

test('QL1: LLM 坏 JSON / 抛错 / 无路由 / web 失败 → 确定性草稿兜底且计划合法', async () => {
  // 坏 JSON
  const badJson = makeLifeFixture({ llm: makePlanLlm({ rawText: '抱歉，今天不想写 JSON。' }), web: makeFakeWeb({ result: { sources: [] } }) })
  const draft = await generateDayPlan(baseOptions(badJson))
  assert.equal(validateDayPlan(draft), true)
  assert.ok(draft.events.length >= 5 && draft.events.length <= 7)
  assert.ok(badJson.logger.warnings.some((line) => line.includes('JSON') || line.includes('模型')), '应记录 LLM 失败告警')

  // LLM 抛错
  const llmError = makeLifeFixture({ llm: makePlanLlm({ fail: new Error('模型超时') }), web: makeFakeWeb({ result: { sources: [] } }) })
  const errored = await generateDayPlan(baseOptions(llmError))
  assert.equal(validateDayPlan(errored), true)

  // 无路由（无 config.provider/model、无 modelSelection）
  const noRoute = makeLifeFixture({ llm: makePlanLlm(), web: makeFakeWeb({ result: { sources: [] } }) })
  const noRoutePlan = await generateDayPlan(baseOptions(noRoute, { config: { eventCount: 3 } }))
  assert.equal(validateDayPlan(noRoutePlan), true)
  assert.ok(noRoute.logger.warnings.some((line) => line.includes('模型路由')), '应提示无可用模型路由')

  // web 失败 → 内置书目（不抛错）
  const webFail = makeLifeFixture({ llm: makePlanLlm(), web: makeFakeWeb({ error: new Error('搜索超时') }) })
  const webFailPlan = await generateDayPlan(baseOptions(webFail))
  assert.equal(validateDayPlan(webFailPlan), true)
  assert.ok(webFail.logger.warnings.some((line) => line.includes('网络读物检索失败')))
  const userText = webFail.llm.calls.stream[0].messages[0].content[0].text
  assert.ok(
    BUILTIN_READINGS.some((book) => userText.includes(book.title)),
    'web 失败时应使用内置书目作为读物素材',
  )

  // 完全没有 llm/web 也能生成草稿
  const bare = makeLifeFixture({ llm: undefined, web: undefined })
  const barePlan = await generateDayPlan(baseOptions(bare))
  assert.equal(validateDayPlan(barePlan), true)
})

// ───────────────────────────── QL2 到期判定与不重发 ─────────────────────────────

test('QL2: 候选时间选择（未来日期/当天跳过已过时间/过去日期报错/数量上限）', () => {
  const futureSlots = selectEventSlots({ dateKey: TOMORROW, nowMs: FIXED_MS, count: 3, random: () => 0.5 })
  assert.equal(futureSlots.length, 3)
  const minutes = futureSlots.map((time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3)))
  assert.deepEqual([...minutes].sort((a, b) => a - b), minutes, '时间应升序')
  assert.ok(futureSlots.every((time) => /^\d{2}:\d{2}$/u.test(time)))

  const todaySlots = selectEventSlots({ dateKey: TODAY, nowMs: FIXED_MS, count: 3, random: () => 0.3 })
  for (const time of todaySlots) {
    const start = eventStartMs(TODAY, time)
    assert.ok(start > FIXED_MS, `当天时间应晚于当前时刻：${time}`)
  }
  assert.ok(todaySlots.length >= 1)
  assert.throws(() => selectEventSlots({ dateKey: '2026-01-01', nowMs: FIXED_MS }), /过去的日期/u)
  assert.throws(() => selectEventSlots({ dateKey: '2026-11-06', nowMs: Number.NaN }), /nowMs/u)
  const clamped = selectEventSlots({ dateKey: TOMORROW, nowMs: FIXED_MS, count: 99, random: () => 0.2 })
  assert.ok(clamped.length <= 7, '事件数量上限为 7')
})

test('QL2: listDueEvents 只取「未发+当天+已到+6h 宽限内」；markEventSent 纯函数；重复检查不重发', () => {
  const plan = createPlanShell({ dateKey: TODAY, characterId: 'ophelia', nowIso: new Date(FIXED_MS).toISOString() })
  plan.events = [
    { id: 'evt-1', time: '14:30', title: '刚过', content: '刚过的事件。', sourceType: 'life', sentAt: null },
    { id: 'evt-2', time: '08:00', title: '过期', content: '超过宽限的事件。', sourceType: 'life', sentAt: null },
    { id: 'evt-3', time: '16:00', title: '未到', content: '还没到的事件。', sourceType: 'life', sentAt: null },
    { id: 'evt-4', time: '14:40', title: '已发', content: '已经发过的事件。', sourceType: 'life', sentAt: '2026-11-06T14:41:00+08:00' },
  ]
  const due = listDueEvents(plan, FIXED_MS)
  assert.deepEqual(due.map((event) => event.id), ['evt-1'], '只有已到且未发、在宽限内的事件')
  assert.equal(due[0].index, 0)
  assert.equal(plan.events[0].sentAt, null, 'listDueEvents 不应修改原计划')

  // 宽限边界：正好 6h 内算到期；超过 1ms 不算
  const startMs = eventStartMs(TODAY, '09:00')
  const boundaryPlan = { dateKey: TODAY, events: [{ id: 'b', time: '09:00', title: 'x', content: 'y', sentAt: null }] }
  assert.equal(listDueEvents(boundaryPlan, startMs + DUE_GRACE_MS).length, 1, '恰好 6h 应算到期')
  assert.equal(listDueEvents(boundaryPlan, startMs + DUE_GRACE_MS + 1).length, 0, '超过 6h 不应发送')
  assert.equal(listDueEvents(boundaryPlan, startMs - 1).length, 0, '未到时间不发送')
  // 其他日期的计划不发送
  assert.equal(listDueEvents({ ...boundaryPlan, dateKey: TOMORROW }, startMs + 1000).length, 0)
  // grace 可覆盖
  assert.equal(listDueEvents(boundaryPlan, startMs + 1000, { graceMs: 0 }).length, 0)
  // 坏数据不崩溃
  assert.deepEqual(listDueEvents(undefined, FIXED_MS), [])
  assert.deepEqual(listDueEvents({ dateKey: TODAY, events: [{ time: 'bad' }] }, FIXED_MS), [])

  // markEventSent 纯函数
  const marked = markEventSent(plan, 'evt-1', '2026-11-06T15:01:00+08:00')
  assert.equal(marked.events[0].sentAt, '2026-11-06T15:01:00+08:00')
  assert.equal(plan.events[0].sentAt, null, '原计划不应被修改')
  assert.equal(marked.events[1].sentAt, null)
  const byIndex = markEventSent(plan, 1, '2026-11-06T15:02:00+08:00')
  assert.equal(byIndex.events[1].sentAt, '2026-11-06T15:02:00+08:00')
  const byObject = markEventSent(plan, { id: 'evt-3' }, '2026-11-06T15:03:00+08:00')
  assert.equal(byObject.events[2].sentAt, '2026-11-06T15:03:00+08:00')
  assert.equal(markEventSent(plan, 'not-exist').events[0].sentAt, null)
  assert.throws(() => markEventSent(null, 'x'), /合法的计划/u)
})

test('QL2: 计划结构校验与日期工具（version/dateKey/events 错误、addDays 跨月）', () => {
  const shell = createPlanShell({ dateKey: TODAY, characterId: 'ophelia' })
  assert.equal(shell.version, 1)
  assert.equal(shell.dateKey, TODAY)
  assert.ok(collectPlanErrors(shell).some((line) => line.includes('数量')), '空事件骨架因事件数量不足而不合法')
  const valid = {
    ...shell,
    events: [
      { id: 'evt-1', time: '14:30', title: '整理旧索引', content: '我把旧索引重排了一遍。', sourceType: 'life', sentAt: null },
      { id: 'evt-2', time: '17:00', title: '泡茶', content: '下午泡了一杯茶。', sourceType: 'life', sentAt: null },
    ],
  }
  assert.equal(validateDayPlan(valid), true, `两条合法事件应通过：${collectPlanErrors(valid).join('；')}`)
  assert.deepEqual(collectPlanErrors(valid), [])
  assert.ok(collectPlanErrors({ ...valid, version: 99 }).some((line) => line.includes('version')))
  assert.ok(collectPlanErrors({ ...valid, dateKey: '2026-02-30' }).some((line) => line.includes('日期键')))
  assert.ok(collectPlanErrors({ ...valid, events: 'x' }).some((line) => line.includes('events')))
  assert.ok(
    collectPlanErrors({ ...valid, events: [{ id: 'e', time: '25:00', title: '', content: '' }] }).length >= 3,
    '非法事件应产生多条错误',
  )
  assert.equal(addDays('2026-01-31', 1), '2026-02-01')
  assert.equal(addDays('2024-02-28', 1), '2024-02-29', '闰年跨月')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')

  // 素材/主动分享提示词/兜底文案（不依赖外部服务）
  const plan = createPlanShell({ dateKey: TODAY })
  plan.events = [{ id: 'evt-1', time: '14:30', title: '整理旧索引', content: '我把旧索引重排了一遍。', sourceType: 'life', sourceTitle: '旧书页边的批注', sourceSnippet: '字很小，像怕打扰到正文。' }]
  const material = buildEventMaterial(plan.events[0])
  assert.match(material, /【时间】14:30/u)
  assert.match(material, /【读物】读到《旧书页边的批注》/u)
  const prompt = buildProactivePrompt({ personaSection: '人设', digest: '记忆', event: plan.events[0], characterName: '奥菲莉亚', userAddress: '主人' })
  assert.match(prompt.system, /主动分享/u)
  assert.match(prompt.system, /主动给主人发一条 QQ 消息/u)
  assert.match(prompt.user, /整理旧索引/u)
  const fallback = renderFallbackShare(plan.events[0])
  assert.ok(fallback.includes('整理旧索引'))
  assert.ok(!/https?:\/\//u.test(fallback))
})

// ───────────────────────────── QL3 主动发送 ─────────────────────────────

function makeProactiveFixture({ replyEngine, nowMs = FIXED_MS, allowUsers = [OWNER_QQ, '111222333'], config = {} } = {}) {
  const root = makeTempDir('dshpet-verify-proactive-')
  const charactersDir = path.join(root, 'characters')
  const adapter = makeFakeAdapter()
  const sessions = makeMemorySessionStore()
  const host = createQQHost({
    config: {
      charactersDir,
      characterId: 'ophelia',
      botQQ: '123456789',
      allowUsers,
      bubbleDelayMs: 0,
      proactiveEnabled: true,
      ...config,
    },
    deps: {
      persona: makeStubPersona(),
      memory: makeStubMemory(),
      replyEngine: replyEngine ?? {
        generateWithPrompt: async () => '主人，刚过午后，我把窗边的旧档案理了理。\n阳光落在纸页上，很安静。',
      },
      adapter,
      sessions,
      clock: { now: () => nowMs },
    },
  })
  const dataDir = path.join(charactersDir, 'ophelia')
  return { host, adapter, sessions, dataDir, charactersDir }
}

const OWNER_QQ = '10001'

function makeTodayPlan(dataDir, events, dateKey = TODAY) {
  const shell = createPlanShell({ dateKey, characterId: 'ophelia', nowIso: new Date(FIXED_MS).toISOString() })
  shell.events = events
  saveDayPlan(dataDir, shell)
  return shell
}

test('QL3: 到点事件通过私聊发给白名单（多气泡）；写 sentAt；第二次不重发', async () => {
  const { host, adapter, sessions, dataDir } = makeProactiveFixture()
  makeTodayPlan(dataDir, [
    { id: 'evt-1', time: '14:30', title: '整理旧索引', content: '我把旧索引重排了一遍。', sourceType: 'life', sentAt: null },
    { id: 'evt-2', time: '16:00', title: '未到', content: '还没到。', sourceType: 'life', sentAt: null },
    { id: 'evt-3', time: '08:00', title: '过期', content: '超过宽限。', sourceType: 'life', sentAt: null },
    { id: 'evt-4', time: '14:40', title: '泡茶', content: '下午泡了一杯茶。', sourceType: 'life', sentAt: null },
  ])

  const first = await host.checkLifeEvents()
  assert.equal(first.sent, 2, '只发送已到期且在 6h 宽限内的两条')
  assert.deepEqual(first.events.map((event) => event.id).sort(), ['evt-1', 'evt-4'].sort())
  // 多气泡：每条事件两条气泡 × 两个白名单用户
  assert.equal(adapter.state.sent.length, 2 * 2 * 2)
  for (const outbound of adapter.state.sent) {
    assert.ok(['10001', '111222333'].includes(outbound.userId), '只应发送给白名单用户')
    assert.equal(outbound.meta?.groupId, undefined, '主动分享走私聊')
    assert.ok(outbound.text.length > 0)
  }
  // sentAt 落盘
  const saved = loadDayPlan(dataDir, TODAY)
  assert.equal(saved.events.find((event) => event.id === 'evt-1').sentAt !== null, true)
  assert.equal(saved.events.find((event) => event.id === 'evt-4').sentAt !== null, true)
  assert.equal(saved.events.find((event) => event.id === 'evt-2').sentAt, null)
  assert.equal(saved.events.find((event) => event.id === 'evt-3').sentAt, null, '超过 6h 宽限不发送')
  // 会话历史 append（每个用户每条事件一条 assistant 记录）
  assert.equal(sessions.get('10001').length, 2)

  const before = adapter.state.sent.length
  const second = await host.checkLifeEvents()
  assert.equal(second.sent, 0, '已发送事件不应重复发送')
  assert.equal(adapter.state.sent.length, before, '第二次不应产生新发送')
})

test('QL3: 模型生成失败用兜底文案；proactiveMaxPerTick 限制单次发送数量', async () => {
  const failing = makeProactiveFixture({ replyEngine: { generateWithPrompt: async () => { throw new Error('模型不可用') } } })
  makeTodayPlan(failing.dataDir, [
    { id: 'evt-1', time: '14:30', title: '整理旧索引', content: '我把旧索引重排了一遍。', sourceType: 'life', sentAt: null },
    { id: 'evt-2', time: '14:40', title: '泡茶', content: '下午泡了一杯茶。', sourceType: 'life', sentAt: null },
  ])
  const fallbackResult = await failing.host.checkLifeEvents()
  assert.equal(fallbackResult.sent, 2)
  const sentTexts = failing.adapter.state.sent.map((outbound) => outbound.text).join('\n')
  assert.ok(sentTexts.includes('整理旧索引') || sentTexts.includes('泡茶'), '兜底文案应包含事件标题')
  assert.ok(!/https?:\/\//u.test(sentTexts), '兜底文案不应含链接')
  assert.ok(failing.host.status().proactive.lastError === undefined)

  // maxPerTick=1：一次只发一条，下一次发下一条
  const limited = makeProactiveFixture({ config: { proactiveMaxPerTick: 1 } })
  makeTodayPlan(limited.dataDir, [
    { id: 'evt-1', time: '14:30', title: 'A', content: '第一件事。', sourceType: 'life', sentAt: null },
    { id: 'evt-2', time: '14:40', title: 'B', content: '第二件事。', sourceType: 'life', sentAt: null },
    { id: 'evt-3', time: '14:50', title: 'C', content: '第三件事。', sourceType: 'life', sentAt: null },
  ])
  const firstTick = await limited.host.checkLifeEvents()
  assert.equal(firstTick.sent, 1)
  const secondTick = await limited.host.checkLifeEvents()
  assert.equal(secondTick.sent, 1)
  assert.equal(loadDayPlan(limited.dataDir, TODAY).events.filter((event) => event.sentAt).length, 2)
})

test('QL3: 当天无计划时自动补齐（ensureTodayPlan），无到期事件则 sent=0', async () => {
  const llm = makePlanLlm()
  const root = makeTempDir('dshpet-verify-proactive-ensure-')
  const charactersDir = path.join(root, 'characters')
  const adapter = makeFakeAdapter()
  const host = createQQHost({
    config: { charactersDir, characterId: 'ophelia', botQQ: '123456789', allowUsers: [OWNER_QQ], bubbleDelayMs: 0, provider: 'fake-provider', model: 'fake-model' },
    deps: {
      persona: makeStubPersona(),
      memory: makeStubMemory(),
      replyEngine: { generateWithPrompt: async () => '分享一句。' },
      adapter,
      sessions: makeMemorySessionStore(),
      llm,
      web: makeFakeWeb({ result: { sources: [] } }),
      clock: { now: () => FIXED_MS },
    },
  })
  const result = await host.checkLifeEvents()
  assert.equal(result.sent, 0, '新生成的计划时间都在未来，不应立即发送')
  const plan = loadDayPlan(path.join(charactersDir, 'ophelia'), TODAY)
  assert.ok(plan, '应自动生成当天计划并落盘')
  assert.equal(validateDayPlan(plan), true)
  assert.equal(host.status().proactive.lastError, undefined)
})

// ───────────────────────────── QL4 当天计划补齐 / 失败安全 ─────────────────────────────

test('QL4: ensureDayPlan（缺失生成/已有跳过/坏文件重建/保存失败不崩溃）', async () => {
  const fixture = makeLifeFixture({ llm: makePlanLlm(), web: makeFakeWeb({ result: { sources: [] } }) })
  const first = await ensureDayPlan(baseOptions(fixture))
  assert.equal(first.generated, true)
  assert.equal(validateDayPlan(first.plan), true)

  const second = await ensureDayPlan(baseOptions(fixture))
  assert.equal(second.generated, false, '当天已有合法计划时不再生成')
  assert.deepEqual(second.plan, first.plan)

  // 坏 JSON 文件 → 视为缺失并重建
  const file = resolvePlanPath(fixture.dataDir, TODAY)
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
  const rebuilt = await ensureDayPlan(baseOptions(fixture))
  assert.equal(rebuilt.generated, true)
  assert.equal(validateDayPlan(rebuilt.plan), true)

  // 保存失败（dataDir 是文件）→ 安全返回，不抛出
  const root = makeTempDir('dshpet-verify-life-bad-')
  const asFile = path.join(root, 'not-a-dir')
  fs.writeFileSync(asFile, 'x', 'utf8')
  const badFixture = makeLifeFixture({ llm: makePlanLlm(), web: makeFakeWeb({ result: { sources: [] } }), dataDir: asFile })
  const safe = await ensureDayPlan(baseOptions(badFixture))
  assert.equal(safe.generated, true, '保存失败仍应返回生成的计划，不崩溃')
  assert.equal(validateDayPlan(safe.plan), true)
})

test('QL1/QL4: Host 凌晨维护后为各角色生成「明天」计划（fake ctx/timer，临时角色目录）', async () => {
  const root = makeTempDir('dshpet-verify-host-life-')
  const charactersDir = path.join(root, 'characters')
  const roleDir = path.join(charactersDir, 'alpha')
  fs.mkdirSync(path.join(roleDir, 'persona'), { recursive: true })
  fs.writeFileSync(path.join(roleDir, 'character.json'), JSON.stringify({ id: 'alpha', name: '阿尔法' }), 'utf8')
  fs.copyFileSync(
    path.join(ROOT, 'companion-bundle', 'data', 'persona.default.json'),
    path.join(roleDir, 'persona', 'persona.json'),
  )

  const timeouts = []
  const intervals = []
  const llm = makePlanLlm()
  const fakeContext = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ROUTE }
      if (name === 'timer') {
        return {
          timeout: (callback) => {
            timeouts.push(callback)
            return () => {}
          },
          interval: (callback) => {
            intervals.push(callback)
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(callback) {
      const cleanup = callback()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const host = applyHost(fakeContext, { charactersDir, bilibili: { enabled: false } })
  assert.ok(host)
  assert.equal(timeouts.length, 1, 'Host 应注册启动检查')
  assert.equal(intervals.length, 1, 'Host 应注册定时检查')

  // 触发启动检查（首次运行会执行维护并异步生成明天计划）
  timeouts[0]()
  const tomorrow = addDays(formatDateKey(Date.now()), 1)
  const planFile = resolvePlanPath(roleDir, tomorrow)
  for (let index = 0; index < 200 && !fs.existsSync(planFile); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(fs.existsSync(planFile), '维护后应生成 characters/alpha/life/<明天>.json')
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  assert.equal(validateDayPlan(plan), true)
  assert.equal(plan.characterId, 'alpha')
  assert.equal(plan.source, 'nightly-memory-maintenance')
})

test('QL3: 主动分享没有计划/生成失败时安全返回（不抛错）', async () => {
  const root = makeTempDir('dshpet-verify-proactive-safe-')
  const charactersDir = path.join(root, 'characters')
  const adapter = makeFakeAdapter()
  const host = createQQHost({
    config: { charactersDir, characterId: 'ophelia', botQQ: '123456789', allowUsers: [OWNER_QQ], bubbleDelayMs: 0, proactiveEnabled: true },
    deps: {
      persona: makeStubPersona(),
      memory: makeStubMemory(),
      replyEngine: { generateWithPrompt: async () => 'x' },
      adapter,
      sessions: makeMemorySessionStore(),
      clock: { now: () => FIXED_MS },
    },
  })
  // 无 llm/web 时 ensureDayPlan 走草稿，仍应安全返回
  const result = await host.checkLifeEvents()
  assert.equal(typeof result.sent, 'number')
  assert.equal(adapter.state.sent.length, 0, '没有到期事件时不应发送')
  // 关闭主动分享 → 直接返回 disabled
  const disabled = createQQHost({
    config: { charactersDir, characterId: 'ophelia', botQQ: '123456789', allowUsers: [OWNER_QQ], proactiveEnabled: false },
    deps: { persona: makeStubPersona(), memory: makeStubMemory(), replyEngine: { generateWithPrompt: async () => 'x' }, adapter: makeFakeAdapter(), sessions: makeMemorySessionStore(), clock: { now: () => FIXED_MS } },
  })
  assert.deepEqual(await disabled.checkLifeEvents(), { sent: 0, events: [], reason: 'disabled' })
})

test('QL1: 生成器配置夹取（eventCount 2–4 / memorySampleSize 2–4 / 超时下限）', () => {
  const defaults = resolveLifeConfig({})
  assert.equal(defaults.eventCount, DEFAULT_LIFE_CONFIG.eventCount)
  assert.equal(defaults.eventCount, 6)
  assert.equal(resolveLifeConfig({ eventCount: 9 }).eventCount, 7)
  assert.equal(resolveLifeConfig({ eventCount: -1 }).eventCount, 2)
  assert.equal(resolveLifeConfig({ memorySampleSize: 9 }).memorySampleSize, 4)
  assert.equal(resolveLifeConfig({ memorySampleSize: 0 }).memorySampleSize, 2)
  assert.equal(resolveLifeConfig({ llmTimeoutMs: 1 }).llmTimeoutMs, 1000)
  assert.equal(resolveLifeConfig({ webTimeoutMs: 1 }).webTimeoutMs, 1000)
  assert.equal(resolveLifeConfig({ maxTokens: 1 }).maxTokens, 256)
  assert.equal(resolveLifeConfig({ digestMaxChars: 1 }).digestMaxChars, 200)
})
