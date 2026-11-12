/**
 * 覆盖功能 2a（每日生活事件计划 · generator / render 部分）：
 * G1 LLM 合法 JSON 生成；G2 LLM 抛错兜底；G3 坏 JSON/非法事件兜底；
 * G4 web 成功 → web 来源事件；G5 web 失败 → 内置书目降级；
 * G6 无模型路由兜底；G7 ensureDayPlan 不重写/坏文件重生成；
 * G8 凌晨维护生成第二天且可跳过/force；G9 非法参数快速失败；
 * G10 eventCount 可调；R1 render 辅助函数（素材 / 主动分享提示词 / 兜底短句）。
 *
 * 全部使用临时目录与假 llm/web/memory，不联网、不触碰真实 companion-data。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFixedClock } from '../../lib/shared/clock.js'
import {
  addDays,
  EVENT_TYPES,
  formatDateKey,
  loadDayPlan,
  resolvePlanPath,
  validateDayPlan,
} from '../../lib/life/dayplan.js'
import {
  ensureDayPlan,
  generateDayPlan,
  generatePlanForMaintenance,
  resolveLifeConfig,
} from '../../lib/life/generator.js'
import {
  buildEventMaterial,
  buildProactivePrompt,
  renderFallbackShare,
} from '../../lib/life/render.js'

function tmpDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-life-generator-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeMemory({
  digest = '【记忆系统 · 自动注入】\n【最近短期记忆】\n- 主人喜欢雨天，说雨声让人安心（关键词：雨天、安心；提及 2 次）',
  layers = {
    1: [{ id: 'm-1', summary: '薇拉转学那天，我替她收好了缺席的考卷', content: '薇拉转学那天，我把她的考卷收进抽屉。', keywords: ['薇拉', '转学'], category: '人际' }],
    7: [{ id: 'm-2', summary: '旧钢笔是主人第一次来时留下的', content: '旧钢笔是主人第一次来时留下的，笔尖有些磨了。', keywords: ['旧钢笔', '主人'], category: '事件' }],
  },
} = {}) {
  const calls = { digest: 0, listLayer: [] }
  return {
    calls,
    renderDigest(options) {
      calls.digest += 1
      assert.equal(options.latestUserText, '')
      return digest
    },
    listLayer(layer) {
      calls.listLayer.push(layer)
      return layers[layer] ?? []
    },
    status: () => ({ ok: true, total: 2 }),
  }
}

function makePersona() {
  return {
    renderPersonaSection: () => '【人设 · 始终生效】\n你是奥菲莉亚，白昼档案馆第七阅览室的记录官。',
    getDefinition: () => ({ character: { name: '奥菲莉亚', userAddress: '主人' } }),
  }
}

/** 从 system 提示词里提取候选时间列表（模拟真实模型读取候选池）。 */
function extractTimes(system) {
  const match = /候选时间[^\n]*?：\s*((?:\d{2}:\d{2})(?:、\d{2}:\d{2})*)/u.exec(String(system ?? ''))
  if (!match) throw new Error('system 中缺少候选时间')
  return match[1].split('、').map((time) => time.trim()).filter(Boolean)
}

function textStream(text) {
  return [
    { type: 'text-delta', text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 假 LLM：handlder 返回 chunk 数组；记录每次 prepareCall 与 stream 参数。 */
function makeLlm(handler) {
  const calls = []
  return {
    calls,
    prepareCall: async (config) => ({
      config: { ...config },
      stream: (options) => {
        calls.push({ config, options })
        const chunks = handler(options, calls.length)
        return (async function* generate() {
          for (const chunk of chunks) yield chunk
        })()
      },
    }),
  }
}

/** 返回合法 JSON 计划的假 LLM（事件时间取自 system 的候选池）。 */
function validLlm() {
  const titles = ['整理旧日记录', '翻阅旧档案', '读到一篇文章']
  const contents = [
    '上午我把最近几天的记录重新整理好，主人说过的话我都留在页边，墨迹干得很慢。',
    '下午去闭架库核对旧卷，翻到一页从前的记载，纸角有些卷，我把它抚平了。',
    '傍晚读到一篇文章，里面写到把日子慢下来，我读到这里停了一会儿。',
  ]
  return makeLlm((options) => {
    const times = extractTimes(options.system)
    const events = times.slice(0, 3).map((time, index) => ({
      time,
      title: titles[index],
      content: contents[index],
      sourceType: index === 2 ? 'life' : 'memory',
    }))
    return textStream(JSON.stringify({ events }))
  })
}

function baseOptions(t, overrides = {}) {
  const dataDir = overrides.dataDir ?? tmpDataDir(t)
  const nowMs = overrides.nowMs ?? new Date(2026, 10, 5, 4, 30, 0).getTime()
  const clock = createFixedClock(nowMs)
  return {
    dataDir,
    nowMs,
    clock,
    persona: makePersona(),
    memory: makeMemory(),
    ...overrides,
  }
}

test('G1：LLM 返回合法 JSON → 补足到 5–7 个事件、时间合法、写入计划文件', async (t) => {
  const options = baseOptions(t)
  const llm = validLlm()
  const modelSelection = () => ({ provider: 'deepseek-official', model: 'deepseek-flash' })
  const dateKey = addDays(formatDateKey(options.nowMs), 1)
  const warnings = []
  const plan = await generateDayPlan({
    ...options,
    dateKey,
    characterId: 'ophelia',
    llm,
    modelSelection,
    logger: { warn: (message) => warnings.push(message) },
    source: 'nightly-memory-maintenance',
  })

  assert.equal(plan.version, 1)
  assert.equal(plan.dateKey, dateKey)
  assert.equal(plan.characterId, 'ophelia')
  assert.equal(plan.source, 'nightly-memory-maintenance')
  assert.ok(plan.events.length >= 5 && plan.events.length <= 7, `事件数应为 5–7，实际 ${plan.events.length}`)
  assert.equal(validateDayPlan(plan), true)
  assert.deepEqual(plan.events.map((event) => event.id), Array.from({ length: plan.events.length }, (_, index) => `evt-${index + 1}`))
  for (const event of plan.events) {
    assert.match(event.time, /^\d{2}:\d{2}$/u)
    assert.ok(event.title.length > 0)
    assert.ok(event.content.length > 0)
    assert.ok(['memory', 'web', 'life'].includes(event.sourceType))
    assert.equal(event.sentAt, null)
  }

  // 模型被调用一次，路由来自 modelSelection；system 含人设段与生成指令
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].config.provider, 'deepseek-official')
  assert.equal(llm.calls[0].config.model, 'deepseek-flash')
  assert.match(llm.calls[0].options.system, /人设 · 始终生效/u)
  assert.match(llm.calls[0].options.system, /每日生活事件计划/u)
  assert.equal(Array.isArray(llm.calls[0].options.messages), true)
  // 事件时间来自候选池（system 中声明的候选时间）
  const allowedTimes = new Set(extractTimes(llm.calls[0].options.system))
  for (const event of plan.events) assert.ok(allowedTimes.has(event.time), `时间不在候选池：${event.time}`)

  // 计划文件已写入且可读回
  assert.equal(resolvePlanPath(options.dataDir, dateKey), path.join(options.dataDir, 'life', `day-plan-${dateKey}.json`))
  const saved = loadDayPlan(options.dataDir, dateKey)
  assert.deepEqual(saved, JSON.parse(JSON.stringify(plan)))
  assert.deepEqual(warnings, [])
})

test('G11：每日事件条数随机（5–7）且事件类型随机分布', async (t) => {
  const counts = new Set()
  const types = new Set()
  for (let offset = 1; offset <= 5; offset += 1) {
    const options = baseOptions(t)
    const dateKey = addDays(formatDateKey(options.nowMs), offset)
    const plan = await generateDayPlan({
      ...options,
      dateKey,
      characterId: 'ophelia',
      llm: validLlm(),
      modelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      source: 'nightly-memory-maintenance',
    })
    assert.ok(plan.events.length >= 5 && plan.events.length <= 7, `条数应为 5–7，实际 ${plan.events.length}`)
    assert.equal(validateDayPlan(plan), true)
    counts.add(plan.events.length)
    for (const event of plan.events) {
      assert.ok(EVENT_TYPES.includes(event.type), `未知事件类型：${event.type}`)
      types.add(event.type)
    }
  }
  assert.ok(counts.size >= 2, `5 天应出现至少 2 种不同条数，实际 ${[...counts].join(',')}`)
  assert.ok(types.size >= 2, `事件类型应随机分布，实际 ${[...types].join(',')}`)
})

test('G2：LLM 抛错 → 确定性草稿兜底，仍生成并写入合法计划', async (t) => {
  const options = baseOptions(t)
  const dateKey = addDays(formatDateKey(options.nowMs), 1)
  const warnings = []
  const llm = {
    prepareCall: async () => {
      throw new Error('模型不可用')
    },
  }
  const plan = await generateDayPlan({
    ...options,
    dateKey,
    llm,
    modelSelection: () => ({ provider: 'p', model: 'm' }),
    logger: { warn: (message) => warnings.push(message) },
  })
  assert.equal(validateDayPlan(plan), true)
  assert.ok(plan.events.length >= 5 && plan.events.length <= 7)
  assert.match(warnings.join('\n'), /模型生成每日计划失败/u)
  assert.ok(loadDayPlan(options.dataDir, dateKey))
  for (const event of plan.events) assert.doesNotMatch(event.content, /https?:\/\//u)
})

test('G3：LLM 返回坏 JSON / 非法事件 → 草稿兜底，计划仍合法', async (t) => {
  const options = baseOptions(t)
  const dateKey = addDays(formatDateKey(options.nowMs), 1)
  const badOutputs = [
    '抱歉，我今天不想写 JSON。',
    JSON.stringify({ events: [{ time: '99:99', title: '', content: '' }] }),
    JSON.stringify({ events: [] }),
    '',
  ]
  for (const badOutput of badOutputs) {
    const warnings = []
    const llm = makeLlm(() => textStream(badOutput))
    const plan = await generateDayPlan({
      ...options,
      dateKey,
      llm,
      modelSelection: () => ({ provider: 'p', model: 'm' }),
      logger: { warn: (message) => warnings.push(message) },
    })
    assert.equal(validateDayPlan(plan), true, `坏输出应兜底为合法计划：${badOutput.slice(0, 20)}`)
    assert.ok(plan.events.length >= 5 && plan.events.length <= 7)
    assert.ok(warnings.length > 0)
  }
})

test('G4：web 搜索成功 → 出现 web 来源事件（带 sourceTitle/sourceUrl/sourceSnippet）', async (t) => {
  const options = baseOptions(t)
  const dateKey = addDays(formatDateKey(options.nowMs), 1)
  const webCalls = []
  const web = {
    search: async ({ query, maxResults }, signal) => {
      webCalls.push({ query, maxResults, hasSignal: Boolean(signal) })
      return {
        sources: [
          {
            url: 'https://example.com/article/archive',
            title: '闭馆前的半小时',
            snippet: '阳光斜进长廊，纸页的气味比咖啡更让人安心。',
          },
        ],
        truncated: false,
      }
    },
  }
  // 不提供 llm，直接走确定性草稿路径，验证 web 素材进入事件
  const plan = await generateDayPlan({ ...options, dateKey, web })
  assert.equal(validateDayPlan(plan), true)
  assert.equal(webCalls.length, 1)
  assert.equal(webCalls[0].maxResults, 3)
  assert.equal(typeof webCalls[0].query, 'string')
  assert.ok(webCalls[0].query.length > 0)

  const webEvent = plan.events.find((event) => event.sourceType === 'web')
  assert.ok(webEvent, '应包含 web 来源事件')
  assert.equal(webEvent.sourceTitle, '闭馆前的半小时')
  assert.equal(webEvent.sourceUrl, 'https://example.com/article/archive')
  assert.match(webEvent.sourceSnippet, /阳光斜进长廊/u)
  // 事件正文不写链接（URL 只保存在 sourceUrl 字段）
  for (const event of plan.events) assert.doesNotMatch(event.content, /https?:\/\//u)
})

test('G5：web 抛错 → 仍生成计划，降级内置书目并记录警告', async (t) => {
  const options = baseOptions(t)
  const dateKey = addDays(formatDateKey(options.nowMs), 1)
  const warnings = []
  const web = {
    search: async () => {
      throw new Error('网络不可用')
    },
  }
  const plan = await generateDayPlan({
    ...options,
    dateKey,
    web,
    logger: { warn: (message) => warnings.push(message) },
  })
  assert.equal(validateDayPlan(plan), true)
  assert.match(warnings.join('\n'), /网络读物检索失败/u)
  assert.ok(plan.events.some((event) => event.sourceType === 'life' && event.sourceTitle), '应使用内置书目素材')
})

test('G6：LLM 存在但没有模型路由 → 草稿兜底并记录警告', async (t) => {
  const options = baseOptions(t)
  const dateKey = addDays(formatDateKey(options.nowMs), 1)
  const warnings = []
  const llm = validLlm()
  const plan = await generateDayPlan({
    ...options,
    dateKey,
    llm,
    modelSelection: () => undefined,
    logger: { warn: (message) => warnings.push(message) },
  })
  assert.equal(validateDayPlan(plan), true)
  assert.equal(llm.calls.length, 0, '没有路由时不应调用模型')
  assert.match(warnings.join('\n'), /没有可用的模型路由/u)
})

test('G7：ensureDayPlan——已有合法计划不重写、无计划时生成、坏文件重新生成', async (t) => {
  const options = baseOptions(t)
  const dateKey = formatDateKey(options.nowMs)
  const llm = validLlm()
  const base = {
    ...options,
    dateKey,
    llm,
    modelSelection: () => ({ provider: 'p', model: 'm' }),
  }

  const first = await ensureDayPlan(base)
  assert.equal(first.generated, true)
  assert.equal(first.dateKey, dateKey)
  assert.equal(validateDayPlan(first.plan), true)
  assert.equal(llm.calls.length, 1)

  const second = await ensureDayPlan(base)
  assert.equal(second.generated, false)
  assert.deepEqual(second.plan, first.plan)
  assert.equal(llm.calls.length, 1, '已有合法计划时不应再次调用模型')

  const planFile = resolvePlanPath(options.dataDir, dateKey)
  fs.rmSync(planFile)
  const third = await ensureDayPlan(base)
  assert.equal(third.generated, true)
  assert.equal(llm.calls.length, 2)

  fs.writeFileSync(planFile, '{ 坏掉的计划', 'utf8')
  const fourth = await ensureDayPlan(base)
  assert.equal(fourth.generated, true)
  assert.equal(validateDayPlan(fourth.plan), true)
})

test('G8：generatePlanForMaintenance——固定时钟 04:30 生成第二天，重复调用跳过，force 重生成', async (t) => {
  const options = baseOptions(t)
  const clock = createFixedClock('2026-11-06T04:30:00+08:00')
  const nowMs = clock.now()
  const tomorrow = addDays(formatDateKey(nowMs), 1)
  const llm = validLlm()
  const base = {
    ...options,
    clock,
    llm,
    modelSelection: () => ({ provider: 'p', model: 'm' }),
  }

  const first = await generatePlanForMaintenance(base)
  assert.equal(first.generated, true)
  assert.equal(first.dateKey, tomorrow)
  assert.equal(first.plan.dateKey, tomorrow)
  assert.equal(first.plan.source, 'nightly-memory-maintenance')
  assert.ok(fs.existsSync(resolvePlanPath(options.dataDir, tomorrow)))
  const callsAfterFirst = llm.calls.length

  const second = await generatePlanForMaintenance(base)
  assert.equal(second.generated, false)
  assert.deepEqual(second.plan, first.plan)
  assert.equal(llm.calls.length, callsAfterFirst)

  const forced = await generatePlanForMaintenance({ ...base, force: true })
  assert.equal(forced.generated, true)
  assert.equal(forced.dateKey, tomorrow)
  assert.equal(llm.calls.length, callsAfterFirst + 1)
})

test('G9：非法参数快速失败；resolveLifeConfig 夹紧配置', async () => {
  await assert.rejects(() => generateDayPlan({ dataDir: '' }), /dataDir/u)
  await assert.rejects(() => ensureDayPlan({}), /dataDir/u)
  await assert.rejects(() => generatePlanForMaintenance({ dataDir: '' }), /dataDir/u)
  await assert.rejects(
    () =>
      generateDayPlan({
        dataDir: path.join(os.tmpdir(), 'companion-life-unused'),
        dateKey: '2026-02-30',
      }),
    /日期键非法/u,
  )
  const config = resolveLifeConfig({ eventCount: 99, memorySampleSize: 0, llmTimeoutMs: 1, maxTokens: 1 })
  assert.equal(config.eventCount, 7)
  assert.equal(config.memorySampleSize, 2)
  assert.equal(config.llmTimeoutMs, 1000)
  assert.equal(config.maxTokens, 256)
})

test('G10：config.eventCount 可调（2 个事件）且计划仍合法', async (t) => {
  const options = baseOptions(t)
  const dateKey = addDays(formatDateKey(options.nowMs), 1)
  const llm = validLlm()
  const plan = await generateDayPlan({
    ...options,
    dateKey,
    llm,
    modelSelection: () => ({ provider: 'p', model: 'm' }),
    config: { eventCount: 2, eventCountRandom: false },
  })
  assert.equal(plan.events.length, 2)
  assert.equal(validateDayPlan(plan), true)
  const allowedTimes = new Set(extractTimes(llm.calls[0].options.system))
  assert.equal(allowedTimes.size, 2)
  for (const event of plan.events) assert.ok(allowedTimes.has(event.time))
})

test('R1：render 辅助函数——事件素材 / 主动分享提示词 / 兜底短句', () => {
  const event = {
    id: 'evt-1',
    time: '09:20',
    title: '翻阅旧档案',
    content: '下午我去闭架库核对旧卷，翻到一页从前的记载。',
    sourceType: 'web',
    sourceTitle: '闭馆前的半小时',
    sourceUrl: 'https://example.com/article',
    sourceSnippet: '阳光斜进长廊，纸页的气味比咖啡更让人安心。',
    sentAt: null,
  }
  const material = buildEventMaterial(event)
  assert.match(material, /09:20/u)
  assert.match(material, /翻阅旧档案/u)
  assert.match(material, /闭馆前的半小时/u)
  assert.doesNotMatch(material, /https?:\/\//u)
  assert.equal(buildEventMaterial(undefined), '')

  const prompts = buildProactivePrompt({
    personaSection: '【人设 · 始终生效】你是奥菲莉亚。',
    digest: '【记忆】主人喜欢雨天。',
    event,
    characterName: '奥菲莉亚',
    userAddress: '主人',
  })
  assert.match(prompts.system, /人设 · 始终生效/u)
  assert.match(prompts.system, /主人喜欢雨天/u)
  assert.match(prompts.system, /你正在翻阅旧档案/u)
  assert.match(prompts.system, /不要发链接/u)
  assert.match(prompts.system, /不要客服腔/u)
  assert.match(prompts.system, /不要每句都提问/u)
  assert.match(prompts.user, /翻阅旧档案/u)
  assert.doesNotMatch(`${prompts.system}\n${prompts.user}`, /https?:\/\//u)

  const withHistory = buildProactivePrompt({
    event,
    history: [
      { role: 'user', text: '今天好累' },
      { role: 'assistant', text: '辛苦了，主人。' },
    ],
  })
  assert.match(withHistory.user, /最近的对话/u)
  assert.match(withHistory.user, /主人：今天好累/u)
  assert.match(withHistory.user, /奥菲莉亚：辛苦了，主人。/u)

  const fallback = renderFallbackShare(event)
  assert.match(fallback, /09:20/u)
  assert.match(fallback, /我/u)
  assert.doesNotMatch(fallback, /https?:\/\//u)
  const lines = fallback.split('\n').filter(Boolean)
  assert.ok(lines.length >= 2 && lines.length <= 3, `兜底短句应为 2-3 句：${lines.length}`)
  assert.ok(renderFallbackShare(undefined).length > 0)
})
