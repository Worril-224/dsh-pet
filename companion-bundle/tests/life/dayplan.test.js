/**
 * 覆盖功能 2a（每日生活事件计划 · dayplan 部分）：
 * D1 日期键与日期加减；D2 计划路径与原子读写；D3 时间槽位在未来且可复现；
 * D4 到期判定（未到 / 已发 / 超过宽限 / 非当天 / 非法输入）；
 * D5 markEventSent 纯函数；D6 计划结构校验；D7 计划骨架；D8 种子随机可复现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DUE_GRACE_MS,
  PLAN_VERSION,
  addDays,
  collectPlanErrors,
  createPlanShell,
  createSeededRandom,
  formatDateKey,
  formatMinutesAsTime,
  listDueEvents,
  loadDayPlan,
  markEventSent,
  parseDateKey,
  parseTimeToMinutes,
  resolvePlanPath,
  saveDayPlan,
  selectEventSlots,
  validateDayPlan,
} from '../../lib/life/dayplan.js'

function tmpDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-life-dayplan-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makePlan(overrides = {}) {
  return {
    version: PLAN_VERSION,
    dateKey: '2026-11-06',
    characterId: 'ophelia',
    generatedAt: '2026-11-05T04:30:00+08:00',
    source: 'nightly-memory-maintenance',
    events: [
      {
        id: 'evt-1',
        time: '09:20',
        title: '整理近来的记录',
        content: '上午我把最近几天的记录重新排好，窗外的光正好移到桌角。',
        sourceType: 'memory',
        sentAt: null,
      },
      {
        id: 'evt-2',
        time: '13:40',
        title: '翻阅旧档案',
        content: '下午我去闭架库核对旧卷，翻到一页从前的记载。',
        sourceType: 'memory',
        sentAt: null,
      },
      {
        id: 'evt-3',
        time: '17:10',
        title: '翻到手边的一本书',
        content: '傍晚读到一本书，里面写到把日子慢下来。',
        sourceType: 'life',
        sentAt: null,
      },
    ],
    ...overrides,
  }
}

test('D1：日期键 / 日期加减 / 时间解析与格式化', () => {
  assert.equal(formatDateKey(new Date(2026, 10, 6, 9, 0)), '2026-11-06')
  assert.equal(formatDateKey(new Date(2026, 0, 2, 23, 59)), '2026-01-02')
  assert.equal(formatDateKey(new Date(2026, 10, 6, 9, 0).getTime()), '2026-11-06')
  assert.equal(addDays('2026-11-06', 1), '2026-11-07')
  assert.equal(addDays('2026-11-06', 0), '2026-11-06')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2027-01-01', -1), '2026-12-31')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2028-03-01', -1), '2028-02-29')
  assert.equal(parseTimeToMinutes('09:20'), 560)
  assert.equal(parseTimeToMinutes('23:59'), 1439)
  assert.equal(formatMinutesAsTime(560), '09:20')
  assert.equal(formatMinutesAsTime(0), '00:00')
  assert.throws(() => parseDateKey('2026-2-3'), /日期键非法/)
  assert.throws(() => parseDateKey('2026-02-30'), /日期键非法/)
  assert.throws(() => formatDateKey('not-a-date'), /无效日期/)
  assert.throws(() => addDays('2026-11-06', 1.5), /整数/)
  assert.throws(() => parseTimeToMinutes('24:00'), /时间格式非法/)
})

test('D2：计划路径 / 原子读写 / 缺失与损坏文件返回 undefined / 非法结构拒绝写入', (t) => {
  const dataDir = tmpDataDir(t)
  const expected = path.join(dataDir, 'life', 'day-plan-2026-11-06.json')
  assert.equal(resolvePlanPath(dataDir, '2026-11-06'), expected)
  assert.equal(loadDayPlan(dataDir, '2026-11-06'), undefined)

  const plan = makePlan()
  saveDayPlan(dataDir, plan)
  assert.ok(fs.existsSync(expected))
  assert.deepEqual(loadDayPlan(dataDir, '2026-11-06'), JSON.parse(JSON.stringify(plan)))

  // 同日期再次写入：覆盖旧计划
  saveDayPlan(dataDir, { ...plan, source: 'ensure' })
  assert.equal(loadDayPlan(dataDir, '2026-11-06').source, 'ensure')

  // 损坏 JSON → 返回 undefined（发送端不应因此崩溃）
  fs.writeFileSync(expected, '{ 坏掉的 json', 'utf8')
  assert.equal(loadDayPlan(dataDir, '2026-11-06'), undefined)

  // 非法结构抛错，拒绝把坏计划写入磁盘
  assert.throws(() => saveDayPlan(dataDir, makePlan({ events: [] })), /结构非法/)
  // 非法参数快速失败
  assert.throws(() => resolvePlanPath('', '2026-11-06'), /dataDir/)
  assert.throws(() => resolvePlanPath(dataDir, 'bad-date'), /日期键非法/)
  assert.throws(() => loadDayPlan('', '2026-11-06'), /dataDir/)
})

test('D3：时间槽位——今天跳过已过去、明天全部可用、种子随机可复现', () => {
  const nowMs = new Date(2026, 10, 6, 10, 0, 0).getTime()
  const dateKey = formatDateKey(nowMs)

  const slotsA = selectEventSlots({ dateKey, nowMs, count: 3, random: createSeededRandom('life-test:slots') })
  const slotsB = selectEventSlots({ dateKey, nowMs, count: 3, random: createSeededRandom('life-test:slots') })
  assert.deepEqual(slotsA, slotsB, '同一种子应得到相同时间槽位')
  assert.equal(slotsA.length, 3)
  assert.deepEqual([...slotsA].sort(), slotsA, '时间槽位应升序')
  for (const time of slotsA) {
    assert.match(time, /^\d{2}:\d{2}$/u)
    assert.ok(parseTimeToMinutes(time) > 10 * 60, `今天 10:00 之后不应安排已过去的时间：${time}`)
  }

  // 明天：主时间池全部可用
  const tomorrow = addDays(dateKey, 1)
  const tomorrowSlots = selectEventSlots({ dateKey: tomorrow, nowMs, count: 3, random: createSeededRandom('seed-x') })
  assert.equal(tomorrowSlots.length, 3)
  const otherSlots = selectEventSlots({ dateKey: tomorrow, nowMs, count: 3, random: createSeededRandom('seed-another') })
  assert.notDeepEqual(tomorrowSlots, otherSlots, '不同种子应产生不同抖动')

  // 深夜：主时间池已过，仍应尽量给出未来时间
  const lateNow = new Date(2026, 10, 6, 22, 50, 0).getTime()
  const lateSlots = selectEventSlots({
    dateKey: formatDateKey(lateNow),
    nowMs: lateNow,
    count: 2,
    random: createSeededRandom('late'),
  })
  assert.ok(lateSlots.length >= 1)
  for (const time of lateSlots) assert.ok(parseTimeToMinutes(time) > 22 * 60 + 50)

  // 过去日期拒绝生成槽位
  assert.throws(
    () => selectEventSlots({ dateKey: addDays(dateKey, -1), nowMs, count: 3 }),
    /过去的日期/u,
  )
})

test('D4：到期判定——未到 / 已发 / 超过宽限 / 非当天 / 非法输入', () => {
  assert.equal(DUE_GRACE_MS, 6 * 60 * 60 * 1000)
  const plan = makePlan()
  const at = (hour, minute) => new Date(2026, 10, 6, hour, minute, 0).getTime()

  // 08:00 都还没到
  assert.deepEqual(listDueEvents(plan, at(8, 0)).map((event) => event.id), [])
  // 13:45：09:20 与 13:40 都已到（09:20 仍在 6 小时宽限内），按时间升序
  const due = listDueEvents(plan, at(13, 45))
  assert.deepEqual(due.map((event) => event.id), ['evt-1', 'evt-2'])
  assert.deepEqual(due.map((event) => event.index), [0, 1])
  // 22:00：17:10 已到且在宽限内；09:20 / 13:40 超过 6 小时宽限，不再补发
  assert.deepEqual(listDueEvents(plan, at(22, 0)).map((event) => event.id), ['evt-3'])
  // 已发送的事件不再返回
  const sentPlan = markEventSent(plan, 'evt-1', '2026-11-06T09:21:00+08:00')
  assert.deepEqual(listDueEvents(sentPlan, at(9, 30)).map((event) => event.id), [])
  // 非当天计划返回空
  assert.deepEqual(listDueEvents(plan, new Date(2026, 10, 7, 13, 45).getTime()), [])
  // 自定义宽限：只补发 1 小时内的
  const tight = listDueEvents(plan, at(14, 5), { graceMs: 60 * 60 * 1000 })
  assert.deepEqual(tight.map((event) => event.id), ['evt-2'])
  // 非法/缺失输入不抛错
  assert.deepEqual(listDueEvents(undefined, at(13, 45)), [])
  assert.deepEqual(listDueEvents({ dateKey: plan.dateKey, events: [{ id: 'x', time: '25:00' }] }, at(13, 45)), [])
  assert.deepEqual(listDueEvents(plan, Number.NaN), [])
  // 返回的是浅拷贝，不污染计划
  due[0].title = '被外部改掉'
  assert.equal(plan.events[0].title, '整理近来的记录')
})

test('D5：markEventSent 纯函数——不改原对象、按 id/下标/事件对象、未知目标原样返回', () => {
  const plan = makePlan()
  const before = JSON.parse(JSON.stringify(plan))
  const updated = markEventSent(plan, 'evt-2', '2026-11-06T13:41:00+08:00')
  assert.notEqual(updated, plan)
  assert.equal(updated.events[1].sentAt, '2026-11-06T13:41:00+08:00')
  assert.equal(updated.events[0].sentAt, null)
  assert.deepEqual(plan, before, '原计划不能被修改')

  const byIndex = markEventSent(plan, 0, '2026-11-06T09:21:00+08:00')
  assert.equal(byIndex.events[0].sentAt, '2026-11-06T09:21:00+08:00')
  assert.equal(byIndex.events[1].sentAt, null)

  const fromObject = markEventSent(plan, { id: 'evt-3' }, '2026-11-06T17:11:00+08:00')
  assert.equal(fromObject.events[2].sentAt, '2026-11-06T17:11:00+08:00')

  const unknown = markEventSent(plan, 'evt-404', '2026-11-06T09:21:00+08:00')
  assert.deepEqual(unknown.events.map((event) => event.sentAt), [null, null, null])
  assert.deepEqual(plan, before)

  assert.throws(() => markEventSent(null, 0), /合法的计划/u)
})

test('D6：计划结构校验——合法通过、各类非法结构给出中文错误', () => {
  assert.equal(validateDayPlan(makePlan()), true)
  assert.deepEqual(collectPlanErrors(makePlan()), [])

  const validEvents = makePlan().events
  const cases = [
    [null, /对象/u],
    [{ ...makePlan(), version: 2 }, /version/u],
    [{ ...makePlan(), dateKey: '2026-13-01' }, /日期键/u],
    [{ ...makePlan(), characterId: '' }, /characterId/u],
    [{ ...makePlan(), generatedAt: '昨天' }, /generatedAt/u],
    [{ ...makePlan(), events: [] }, /数量/u],
    [{ ...makePlan(), events: validEvents.slice(0, 1) }, /数量/u],
    [
      {
        ...makePlan(),
        events: [
          ...validEvents,
          { ...validEvents[0], id: 'evt-4' },
          { ...validEvents[1], id: 'evt-5' },
          { ...validEvents[2], id: 'evt-6' },
          { ...validEvents[0], id: 'evt-7' },
          { ...validEvents[1], id: 'evt-8' },
        ],
      },
      /数量/u,
    ],
    [{ ...makePlan(), events: validEvents.map((event, index) => (index === 0 ? { ...event, time: '9:20' } : event)) }, /time/u],
    [{ ...makePlan(), events: validEvents.map((event, index) => (index === 0 ? { ...event, title: ' ' } : event)) }, /title/u],
    [{ ...makePlan(), events: validEvents.map((event, index) => (index === 0 ? { ...event, content: '  ' } : event)) }, /content/u],
    [{ ...makePlan(), events: validEvents.map((event, index) => (index === 0 ? { ...event, id: 'evt-2' } : event)) }, /重复/u],
    [{ ...makePlan(), events: validEvents.map((event, index) => (index === 0 ? { ...event, sourceType: 'dream' } : event)) }, /sourceType/u],
    [{ ...makePlan(), events: validEvents.map((event, index) => (index === 0 ? { ...event, sentAt: '不是时间' } : event)) }, /sentAt/u],
  ]
  for (const [plan, pattern] of cases) {
    assert.equal(validateDayPlan(plan), false)
    assert.match(collectPlanErrors(plan).join('\n'), pattern)
  }
})

test('D7：计划骨架字段与日期校验', () => {
  const shell = createPlanShell({
    dateKey: '2026-11-07',
    characterId: 'ophelia',
    nowIso: '2026-11-06T04:30:00+08:00',
  })
  assert.equal(shell.version, PLAN_VERSION)
  assert.equal(shell.dateKey, '2026-11-07')
  assert.equal(shell.characterId, 'ophelia')
  assert.equal(shell.generatedAt, '2026-11-06T04:30:00+08:00')
  assert.equal(shell.source, 'ensure')
  assert.deepEqual(shell.events, [])

  const custom = createPlanShell({ dateKey: '2026-11-07', source: 'nightly-memory-maintenance' })
  assert.equal(custom.source, 'nightly-memory-maintenance')
  assert.throws(() => createPlanShell({ dateKey: 'x' }), /日期键非法/u)
})

test('D8：createSeededRandom 可复现且值域合法', () => {
  const left = createSeededRandom('2026-11-07:ophelia:memory')
  const right = createSeededRandom('2026-11-07:ophelia:memory')
  const other = createSeededRandom('2026-11-07:ophelia:draft')
  const sequenceLeft = Array.from({ length: 8 }, () => left())
  const sequenceRight = Array.from({ length: 8 }, () => right())
  const sequenceOther = Array.from({ length: 8 }, () => other())
  assert.deepEqual(sequenceLeft, sequenceRight)
  assert.notDeepEqual(sequenceLeft, sequenceOther)
  for (const value of sequenceLeft) {
    assert.equal(typeof value, 'number')
    assert.ok(value >= 0 && value < 1)
  }
})
