/**
 * 每日生活事件计划生成器（功能 2a）：凌晨记忆维护时生成「第二天」的事件计划；
 * 也可在当天没有计划时按需补生成（ensure）。
 *
 * 设计要点：
 *  - 全部外部依赖注入（persona / memory / llm / web / clock / modelSelection / logger），
 *    任意外部服务缺失或抛错都会优雅降级为「确定性草稿」，保证总能返回一份可用计划；
 *  - 素材三类混合：①近期记忆（memory.renderDigest）②随机旧记忆（memory.listLayer 1-7）
 *    ③「图书馆 / 网上读物」（web.search，失败时用内置书目降级）；
 *  - 优先让 LLM 输出严格 JSON 计划，解析/校验失败则回退草稿；
 *  - 生成结果写入 <dataDir>/life/day-plan-<dateKey>.json（原子写）。
 *
 * 仅依赖 node:* 内置模块与 ../shared、./dayplan 的相对导入（不允许安装 npm 依赖）。
 */
import { formatLocalIso } from '../shared/clock.js'
import {
  DEFAULT_TIME_POOL,
  EVENT_SOURCE_TYPES,
  EVENT_TYPES,
  MAX_EVENT_CONTENT_CHARS,
  MAX_EVENT_TITLE_CHARS,
  MAX_EVENTS,
  MIN_EVENTS,
  TIME_POOL,
  addDays,
  createPlanShell,
  createSeededRandom,
  formatDateKey,
  formatMinutesAsTime,
  loadDayPlan,
  parseDateKey,
  parseTimeToMinutes,
  saveDayPlan,
  selectEventSlots,
  validateDayPlan,
} from './dayplan.js'

/** 生成器默认配置（config 可覆盖）。 */
export const DEFAULT_LIFE_CONFIG = Object.freeze({
  /** 固定事件数量（eventCountRandom=false 时使用）。 */
  eventCount: 6,
  /** 每日条数是否随机（默认 true）。 */
  eventCountRandom: true,
  /** 是否只生成发生时间，事件内容到点再生成（QQ 每日推送使用）。 */
  deferredContent: false,
  /** 随机条数范围：5–7 条，减少 QQ 长时间没有消息。 */
  eventCountMin: 5,
  eventCountMax: 7,
  /** 每份计划随机抽取的旧记忆条数（2-4）。 */
  memorySampleSize: 3,
  /** LLM 单次生成超时（毫秒）。 */
  llmTimeoutMs: 60000,
  /** 网络读物检索超时（毫秒）。 */
  webTimeoutMs: 20000,
  /** LLM 输出 token 上限。 */
  maxTokens: 1200,
  /** 传给记忆摘要的最大字符数。 */
  digestMaxChars: 1600,
})

/** 内置中文读物（web 不可用/无结果时降级；不含任何链接）。 */
export const BUILTIN_READINGS = Object.freeze([
  {
    title: '缓慢阅读的艺术',
    snippet: '文章说，把一天里的几个瞬间认真记下来，日子就不会显得太快。',
  },
  {
    title: '旧书页边的批注',
    snippet: '有人把心事写在书页空白处，字很小，像怕打扰到正文。',
  },
  {
    title: '档案馆的午后',
    snippet: '作者写闭馆前的半小时：阳光斜进长廊，纸页的气味比咖啡更让人安心。',
  },
  {
    title: '关于等待的一封信',
    snippet: '信里说，值得等的人不用催促，值得记的事不必声张。',
  },
  {
    title: '雨天的借阅单',
    snippet: '雨天来借书的人很少，管理员便把读者留下的借阅单一张张抚平。',
  },
])

/** 读物检索主题词（与旧记忆关键词组合成 query）。 */
const READING_TOPICS = Object.freeze([
  '档案馆 旧书 散文',
  '图书馆 记录 随笔',
  '旧书页 手记',
  '雨天文集',
  '十四行诗 赏析',
  '关于时间的散文',
  '慢生活 随笔',
  '记忆 与 遗忘 随笔',
])

const LLM_INSTRUCTIONS_TITLE = '【每日生活事件计划 · 生成任务】'

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** 合并生成器配置：数值兜底、事件数夹在 2-4。 */
export function resolveLifeConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const merged = { ...DEFAULT_LIFE_CONFIG, ...source }
  const numberOr = (value, fallback) => {
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }
  merged.eventCount = clamp(Math.round(numberOr(merged.eventCount, 3)), MIN_EVENTS, MAX_EVENTS)
  merged.eventCountRandom = merged.eventCountRandom !== false
  merged.eventCountMin = clamp(Math.round(numberOr(merged.eventCountMin, MIN_EVENTS)), MIN_EVENTS, MAX_EVENTS)
  merged.eventCountMax = clamp(Math.round(numberOr(merged.eventCountMax, MAX_EVENTS)), merged.eventCountMin, MAX_EVENTS)
  merged.memorySampleSize = clamp(Math.round(numberOr(merged.memorySampleSize, 3)), 2, 4)
  merged.llmTimeoutMs = Math.max(1000, Math.round(numberOr(merged.llmTimeoutMs, 60000)))
  merged.webTimeoutMs = Math.max(1000, Math.round(numberOr(merged.webTimeoutMs, 20000)))
  merged.maxTokens = Math.max(256, Math.round(numberOr(merged.maxTokens, 1200)))
  merged.digestMaxChars = Math.max(200, Math.round(numberOr(merged.digestMaxChars, 1600)))
  return merged
}

/** 读取注入时钟的 now（异常时退回系统时间）。 */
function resolveNowMs(clock) {
  try {
    const value = typeof clock?.now === 'function' ? Number(clock.now()) : Date.now()
    if (Number.isFinite(value)) return value
  } catch {
    // 时钟异常时退回系统时间，保证生成不中断
  }
  return Date.now()
}

/** 创建带超时的 AbortSignal（Node 不支持时返回 undefined）。 */
function createTimeoutSignal(timeoutMs) {
  try {
    if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined
    return AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 20000))
  } catch {
    return undefined
  }
}

/** 从数组里用注入随机数挑一个元素。 */
function pick(list, random) {
  if (!Array.isArray(list) || list.length === 0) return undefined
  return list[Math.floor(randomValue(random) * list.length) % list.length]
}

function randomValue(random) {
  try {
    const value = typeof random === 'function' ? Number(random()) : Number.NaN
    if (Number.isFinite(value)) return Math.min(0.999999, Math.max(0, value))
  } catch {
    // 忽略随机函数异常，退回中点
  }
  return 0.5
}

/** Fisher-Yates 洗牌（不修改入参，使用注入随机数保证可复现）。 */
function shuffle(list, random) {
  const result = Array.isArray(list) ? [...list] : []
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(randomValue(random) * (index + 1))
    const temp = result[index]
    result[index] = result[other]
    result[other] = temp
  }
  return result
}

/** 去掉 Markdown 链接语法与裸链接（事件正文/素材中不允许出现链接）。 */
function stripUrls(text) {
  return String(text ?? '')
    .replace(/\[([^\]]+)\]\((?:https?:)?\/\/[^)]+\)/gu, '$1')
    .replace(/(?:https?:\/\/|www\.|ftp:\/\/|mailto:)[^\s，。；！？、）)」』"']+/giu, '')
}

/** 单行清洗：去链接、压空白、限长、去尾部标点。 */
function sanitizeInlineText(value, maxChars = 200) {
  let text = stripUrls(value)
    .replace(/\s+/gu, ' ')
    .trim()
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).replace(/[，。；、,.;：:！!？?\s]+$/u, '').trim()
  }
  return text
}

/** 事件正文清洗：去链接、压空白、限制长度。 */
function sanitizeEventContent(value) {
  return sanitizeInlineText(value, MAX_EVENT_CONTENT_CHARS)
}

/** 去掉书名号包裹，统一存裸标题。 */
function stripBookBrackets(title) {
  return String(title ?? '')
    .replace(/^《+/u, '')
    .replace(/》+$/u, '')
    .trim()
}

/** 截断并补齐中文句号。 */
function trimToSentence(text, maxChars) {
  const value = sanitizeInlineText(text, maxChars)
  if (!value) return ''
  return /[。！？…”」』]$/u.test(value) ? value : `${value}。`
}

// ───────────────────────────── 素材收集 ─────────────────────────────

function pickMemoryFields(item, layer) {
  const keywords = Array.isArray(item?.keywords)
    ? item.keywords
        .filter((keyword) => typeof keyword === 'string' && keyword.trim() && !keyword.trim().startsWith('#'))
        .slice(0, 5)
        .map((keyword) => keyword.trim())
    : []
  return {
    layer,
    id: typeof item?.id === 'string' ? item.id : '',
    summary: String(item?.summary ?? '').trim(),
    content: String(item?.content ?? '').trim(),
    keywords,
    category: String(item?.category ?? '').trim(),
    occurredAt: typeof item?.occurredAt === 'string' ? item.occurredAt : undefined,
  }
}

/**
 * 收集记忆素材：近期摘要（renderDigest）+ 从第 1-7 层随机抽样的旧记忆。
 * 任意记忆接口缺失/抛错都只记录警告，不影响后续生成。
 */
function collectMemoryMaterials({ memory, config, logger, random }) {
  let digest = ''
  if (memory && typeof memory.renderDigest === 'function') {
    try {
      digest = String(memory.renderDigest({ latestUserText: '', maxChars: config.digestMaxChars }) ?? '').trim()
    } catch (error) {
      logger?.warn?.(`[life] 读取近期记忆摘要失败：${error?.message ?? error}`)
    }
  }

  const pool = []
  if (memory && typeof memory.listLayer === 'function') {
    for (let layer = 1; layer <= 7; layer += 1) {
      try {
        const items = memory.listLayer(layer)
        if (!Array.isArray(items)) continue
        for (const item of items) {
          if (item && typeof item === 'object') pool.push(pickMemoryFields(item, layer))
        }
      } catch (error) {
        logger?.warn?.(`[life] 读取第 ${layer} 层记忆失败：${error?.message ?? error}`)
      }
    }
  } else if (memory && typeof memory.status === 'function') {
    try {
      memory.status()
    } catch (error) {
      logger?.warn?.(`[life] 读取记忆状态失败：${error?.message ?? error}`)
    }
  }
  const oldMemories = shuffle(pool, random).slice(0, config.memorySampleSize)
  return { digest, oldMemories }
}

/** 提取近期记忆摘要里的一条可读片段（用于草稿文案）。 */
function extractRecentSnippet(digest) {
  const lines = String(digest ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    if (!line.startsWith('- ')) continue
    let text = line.slice(2)
    text = text.replace(/^【[^】]*】/u, '')
    text = text.split('（关键词')[0]
    text = text.replace(/[（(][^）)]*[）)]/gu, '')
    text = text.replace(/[，。；、\s]+$/u, '').trim()
    if (text) return sanitizeInlineText(text, 40)
  }
  return ''
}

/** 用旧记忆关键词 + 内置主题词拼出网络搜索 query。 */
function buildReadingQuery(oldMemories, random) {
  const keywords = []
  for (const item of oldMemories) {
    for (const keyword of item.keywords) {
      if (keyword && !keyword.startsWith('#')) keywords.push(keyword)
    }
  }
  const topic = pick(READING_TOPICS, random) ?? '档案馆 旧书 散文'
  const selected = shuffle(keywords, random).slice(0, 2)
  return selected.length > 0 ? `${selected.join(' ')} ${topic}` : topic
}

/**
 * 收集「图书馆 / 网上读物」素材：优先 web.search；不可用/失败/无结果时用内置书目降级。
 * @returns {Promise<Array<{kind:'web'|'library', title:string, snippet:string, url?:string, query:string}>>}
 */
async function collectReadings({ web, query, random, logger, timeoutMs }) {
  const readings = []
  if (web && typeof web.search === 'function') {
    try {
      const signal = createTimeoutSignal(timeoutMs)
      const result = await web.search({ query, maxResults: 3 }, signal)
      const sources = Array.isArray(result?.sources) ? result.sources : []
      for (const source of sources.slice(0, 3)) {
        if (!source || typeof source !== 'object') continue
        const title = sanitizeInlineText(source.title, 60)
        const snippet = sanitizeInlineText(source.snippet, 200)
        const url = typeof source.url === 'string' ? source.url.trim() : ''
        if (!title && !snippet) continue
        readings.push({ kind: 'web', title, snippet, url: url || undefined, query })
      }
      if (readings.length === 0 && typeof result?.content === 'string') {
        const content = sanitizeInlineText(result.content, 200)
        if (content) readings.push({ kind: 'web', title: '一篇网络文章', snippet: content, query })
      }
    } catch (error) {
      logger?.warn?.(`[life] 网络读物检索失败，改用内置书目：${error?.message ?? error}`)
    }
  }
  if (readings.length === 0) {
    const book = pick(BUILTIN_READINGS, random) ?? BUILTIN_READINGS[0]
    readings.push({ kind: 'library', title: book.title, snippet: book.snippet, query })
  }
  return readings
}

// ───────────────────────────── 提示词 ─────────────────────────────

function readPersonaSection(persona, logger) {
  if (!persona || typeof persona.renderPersonaSection !== 'function') return ''
  try {
    return String(persona.renderPersonaSection() ?? '').trim()
  } catch (error) {
    logger?.warn?.(`[life] 读取人设段失败：${error?.message ?? error}`)
    return ''
  }
}

/** 角色名 / 称呼：优先显式注入，其次人设 definition，最后内置默认。 */
function resolveIdentity({ persona, characterName, userAddress, logger }) {
  let definition = {}
  if (persona && typeof persona.getDefinition === 'function') {
    try {
      definition = persona.getDefinition() ?? {}
    } catch (error) {
      logger?.warn?.(`[life] 读取人设定义失败：${error?.message ?? error}`)
    }
  }
  const character = definition && typeof definition.character === 'object' ? definition.character : {}
  const resolvedName =
    (typeof characterName === 'string' && characterName.trim()) ||
    (typeof character.name === 'string' && character.name.trim()) ||
    '奥菲莉亚'
  const resolvedAddress =
    (typeof userAddress === 'string' && userAddress.trim()) ||
    (typeof character.userAddress === 'string' && character.userAddress.trim()) ||
    '主人'
  return { characterName: resolvedName, userAddress: resolvedAddress }
}

function buildPlanSystemPrompt({ personaSection, dateKey, characterName, userAddress, times, eventTypes }) {
  const lines = []
  if (personaSection) {
    lines.push(personaSection)
    lines.push('')
  }
  lines.push(LLM_INSTRUCTIONS_TITLE)
  lines.push(
    `你要为角色「${characterName}」安排 ${dateKey} 这一天的生活，供她按时间主动分享给${userAddress}。`,
  )
  lines.push('')
  lines.push('【输出要求】')
  lines.push('1. 只输出一个 JSON 对象，不要输出解释，不要用 Markdown 代码块。')
  lines.push(
    '2. JSON 结构：{"events":[{"time":"HH:mm","title":"事件标题","content":"第一人称的日程或见闻","type":"日常|回忆|阅读|外出|休息|整理|料理","sourceType":"memory|web|life"}]}',
  )
  lines.push(
    `3. 事件数量必须是 ${times.length} 个；time 必须从这些候选时间里选，每个时间只用一次：${times.join('、')}`,
  )
  lines.push(
    `4. 事件类型按顺序使用这些随机类型，每个事件的 content 必须符合它的 type：${(eventTypes || []).join('、')}；type 字段必须原样填写对应类型。`,
  )
  lines.push('5. content 用第一人称「我」，1-3 句中文短句，40-140 字，写具体的动作、场景或感想；title 不超过 20 字。')
  lines.push('6. 内容贴合人设与素材：可以延续最近的记忆，也可以写整理档案、读书、散步、泡茶这类日常；不要编造素材之外的大事件。')
  lines.push('7. 素材里有读到的文章或书时，写一个相关事件：网络文章 sourceType 用 "web"，手边的书或普通日常用 "life"。')
  lines.push('8. 不写任何链接、网址、邮箱或联系方式；不要客服腔；不用「啦」「嘛」这类卖萌语气词。')
  return lines.join('\n')
}

function buildPlanMaterialsText({
  dateKey,
  characterName,
  userAddress,
  times,
  eventTypes,
  digest,
  oldMemories,
  readings,
}) {
  const lines = []
  lines.push(`【日期】${dateKey}`)
  lines.push(`【角色】${characterName}（称呼${userAddress}为「${userAddress}」）`)
  lines.push(`【候选时间】${times.join('、')}`)
  if (Array.isArray(eventTypes) && eventTypes.length > 0) {
    lines.push(`【今日随机事件类型（按顺序）】${eventTypes.join('、')}`)
  }
  if (digest) {
    lines.push('', '【最近记忆摘要】', digest)
  }
  if (oldMemories.length > 0) {
    lines.push('', '【旧日记忆素材（随机抽取）】')
    for (const item of oldMemories) {
      const hint = sanitizeInlineText(item.summary || item.content, 80)
      if (!hint) continue
      lines.push(`- ${item.category ? `[${item.category}] ` : ''}${hint}`)
    }
  } else if (!digest) {
    lines.push('', '【记忆素材】', '（记忆库还是空的，可以写一些安静的日常。）')
  }
  lines.push('', '【今天的读物素材】')
  for (const reading of readings) {
    const title = reading.title ? `《${stripBookBrackets(reading.title)}》` : '一篇文章'
    const snippet = reading.snippet ? `：${reading.snippet}` : ''
    lines.push(`- ${reading.kind === 'web' ? '网络上读到' : '手边的书'}${title}${snippet}`)
  }
  lines.push('', '【输出】严格按 system 要求输出 JSON，不要输出其他内容。')
  return lines.join('\n')
}

// ───────────────────────────── LLM 调用与解析 ─────────────────────────────

/** 解析 LLM 路由：config.provider/model 优先，否则用 modelSelection()（如 Harness 默认模型）。 */
function resolveRoute({ config, modelSelection, logger }) {
  if (typeof config.provider === 'string' && config.provider && typeof config.model === 'string' && config.model) {
    return { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) }
  }
  if (typeof modelSelection === 'function') {
    try {
      const selection = modelSelection()
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
      }
    } catch (error) {
      logger?.warn?.(`[life] 读取默认模型失败：${error?.message ?? error}`)
    }
  }
  return undefined
}

/** 从 LLM 流里收集文本（兼容 reply-engine 的 chunk 结构）。 */
async function collectStreamText(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('模型没有返回可读取的流')
  }
  let text = ''
  let finish
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish && finish.kind === 'error') {
    throw new Error(`模型调用失败：${finish.failure?.message ?? '未知错误'}`)
  }
  if (finish && finish.kind === 'aborted') throw new Error('模型调用被中止')
  return text
}

/** 从模型输出里提取 events 数组（容忍 ```json 围栏与前后废话）。 */
function parseEventsFromText(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('模型返回为空')
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象')
  let parsed
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch (error) {
    throw new Error(`模型输出 JSON 解析失败：${error?.message ?? error}`)
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
    throw new Error('模型输出的 JSON 缺少 events 数组')
  }
  return parsed.events
}

/** 调用 LLM 生成事件；LLM/路由缺失返回 undefined（由调用方回退草稿）。 */
async function generateEventsWithLlm({ llm, route, system, user, maxTokens, timeoutMs }) {
  if (!llm || typeof llm.prepareCall !== 'function' || !route) return undefined
  const signal = createTimeoutSignal(timeoutMs)
  const call = await llm.prepareCall({ ...route, maxTokens }, signal)
  const callConfig = call && typeof call.config === 'object' && call.config !== null ? call.config : { ...route, maxTokens }
  if (typeof call?.stream !== 'function') throw new Error('模型返回的回调缺少 stream 方法')
  const stream = call.stream({
    ...callConfig,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    system,
    purpose: 'life-day-plan',
    signal,
  })
  const raw = await collectStreamText(stream)
  return parseEventsFromText(raw)
}

// ───────────────────────────── 合法化与草稿 ─────────────────────────────

/** 把 LLM 事件合法化：时间必须在候选池且未来、去重、字段清洗、web 事件补来源。 */
function normalizeLlmEvents(rawEvents, { times, readings, eventTypes = [] }) {
  if (!Array.isArray(rawEvents)) return []
  const allowedTimes = new Set(times)
  const usedTimes = new Set()
  const webReading = readings.find((reading) => reading.kind === 'web')
  const events = []
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== 'object') continue
    const time = String(raw.time ?? '').trim()
    if (!allowedTimes.has(time) || usedTimes.has(time)) continue
    const title = sanitizeInlineText(raw.title, MAX_EVENT_TITLE_CHARS)
    const content = sanitizeEventContent(raw.content)
    if (!title || !content) continue
    let sourceType = EVENT_SOURCE_TYPES.includes(raw.sourceType) ? raw.sourceType : 'life'
    const type = EVENT_TYPES.includes(raw.type) ? raw.type : eventTypes[events.length] || '日常'
    const event = { time, title, content, type, sourceType }
    if (sourceType === 'web') {
      if (!webReading) {
        // 没有可追溯的网络读物时降级为日常事件，避免出现「声称读了网文却没有素材」的悬空事件
        event.sourceType = 'life'
      } else {
        event.sourceTitle = stripBookBrackets(webReading.title) || '一篇网络文章'
        if (webReading.url) event.sourceUrl = webReading.url
        if (webReading.snippet) event.sourceSnippet = webReading.snippet
      }
    }
    usedTimes.add(time)
    events.push(event)
  }
  events.sort((a, b) => parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time))
  return events
}

function draftRecentEvent(digest, random) {
  const hint = extractRecentSnippet(digest)
  const memoryLine = hint ? `其中一条是：${hint}。` : '主人最近说过的几件小事，我都记在页边了。'
  const templates = [
    {
      title: '整理近来的记录',
      content: `上午我先把最近几天的记录按日期重新排好。${memoryLine}写到这里时，窗外的光正好移到桌角。`,
    },
    {
      title: '把最近的事记下来',
      content: `午后我翻开记录本，把这几天的琐事一件件补上。${memoryLine}墨迹干得很慢，像不太舍得翻页。`,
    },
  ]
  const template = pick(templates, random) ?? templates[0]
  return { ...template, sourceType: 'memory' }
}

function draftOldEvent(oldMemories, random) {
  const item = Array.isArray(oldMemories) && oldMemories.length > 0 ? oldMemories[0] : undefined
  const hint = item ? sanitizeInlineText(item.summary || item.content, 24) : ''
  const subject = hint || '几份没有署名的旧卷'
  const templates = [
    {
      title: '翻阅旧档案',
      content: `下午我去闭架库核对旧卷，翻到一页和「${subject}」有关的记录。纸角有些卷，我把它抚平，又把日期重抄了一遍。`,
    },
    {
      title: '在旧卷里停了一会儿',
      content: `傍晚整理旧档案时，读到一段关于「${subject}」的记载。我坐着看了很久，忽然觉得那一天并没有走远。`,
    },
  ]
  const template = pick(templates, random) ?? templates[0]
  return { ...template, sourceType: 'memory' }
}

function draftReadingEvent(readings, random) {
  const reading = Array.isArray(readings) && readings.length > 0 ? readings[0] : undefined
  if (!reading) return draftLifeEvent(random)
  const isWeb = reading.kind === 'web'
  const title = reading.title ? `《${stripBookBrackets(reading.title)}》` : '一篇文章'
  const snippetSource = reading.snippet || '把日子慢下来，认真记下几个瞬间，日子就不会显得太快'
  const snippet = sanitizeInlineText(snippetSource, 60)
  const opener = isWeb ? '傍晚在网上读到' : '午后翻到'
  const templates = [
    {
      title: isWeb ? '读到一篇文章' : '翻到手边的一本书',
      content: `${opener}${title}，里面写到「${snippet}」。我读到这里停了一会儿，想起自己记录文字的心情。`,
    },
    {
      title: isWeb ? '在网上读到一段话' : '翻到一本旧书',
      content: `${opener}${title}，里面有一句「${snippet}」。我把这一句抄进今天的页边，字写得比平时慢。`,
    },
  ]
  const template = pick(templates, random) ?? templates[0]
  const event = { ...template, sourceType: isWeb ? 'web' : 'life' }
  if (reading.title) event.sourceTitle = stripBookBrackets(reading.title)
  if (isWeb) {
    if (reading.url) event.sourceUrl = reading.url
    if (reading.snippet) event.sourceSnippet = sanitizeInlineText(reading.snippet, 200)
  }
  return event
}

function draftLifeEvent(random) {
  const templates = [
    {
      title: '整理第七阅览室的索引',
      content: '午后客人不多，我把第七阅览室的索引按笔画重排了一遍，又把几本放歪的书扶正。指尖沾了点墨，这一页过得挺实在。',
    },
    {
      title: '泡一杯红茶',
      content: '下午泡了一杯红茶，杯子放在手边慢慢凉着。窗外有人还书，我抬头应了一声，又低头继续核对借阅单。',
    },
    {
      title: '把窗台的花浇了水',
      content: '傍晚闭馆前，我给窗台的花浇了水，把借阅登记本合上。灯一盏盏关掉的时候，阅览室安静得像一页刚翻过去的纸。',
    },
  ]
  const template = pick(templates, random) ?? templates[0]
  return { ...template, sourceType: 'life' }
}

/** 基于素材的确定性草稿事件（LLM 不可用/失败时兜底，永远可用）。 */
export function buildDraftEvents({ times, digest = '', oldMemories = [], readings = [], eventTypes = [], random }) {
  const categories = ['recent', 'old', 'reading', 'life']
  const events = []
  for (let index = 0; index < times.length; index += 1) {
    const category = categories[index % categories.length]
    const time = times[index]
    let body
    if (category === 'recent') body = draftRecentEvent(digest, random)
    else if (category === 'old') body = draftOldEvent(oldMemories, random)
    else if (category === 'reading') body = draftReadingEvent(readings, random)
    else body = draftLifeEvent(random)
    events.push({ time, type: eventTypes[index] || pick(EVENT_TYPES, random) || '日常', ...body })
  }
  return events
}

function finalizeEvents(bodies, eventTypes = []) {
  return bodies.slice(0, MAX_EVENTS).map((body, index) => {
    const event = {
      id: `evt-${index + 1}`,
      time: body.time,
      title: body.title,
      content: body.content,
      type: EVENT_TYPES.includes(body.type) ? body.type : eventTypes[index] || '日常',
      sourceType: EVENT_SOURCE_TYPES.includes(body.sourceType) ? body.sourceType : 'life',
      sentAt: null,
    }
    if (body.sourceTitle) event.sourceTitle = body.sourceTitle
    if (event.sourceType === 'web') {
      if (body.sourceUrl) event.sourceUrl = body.sourceUrl
      if (body.sourceSnippet) event.sourceSnippet = body.sourceSnippet
    }
    return event
  })
}

/** 保证事件时间数量与事件数一致：不够时重复最后一个时间（极端深夜场景兜底）。 */
function ensureEventTimes(slots, desiredCount, nowMs) {
  const list = Array.isArray(slots) ? slots.filter((time) => typeof time === 'string' && time) : []
  const count = list.length >= MIN_EVENTS ? Math.min(desiredCount, list.length, MAX_EVENTS) : desiredCount
  const times = list.slice(0, count)
  if (times.length === 0) {
    const nowDate = new Date(nowMs)
    times.push(formatMinutesAsTime(nowDate.getHours() * 60 + nowDate.getMinutes()))
  }
  while (times.length < count) times.push(times[times.length - 1])
  return times
}

/**
 * 生成某一天的每日生活事件计划（异步，外部依赖全部注入，失败自动降级）。
 *
 * @param {object} options
 * @param {string} options.dataDir 角色数据目录（必填）
 * @param {string} [options.dateKey] 目标日期（默认今天，本地时区）
 * @param {string} [options.characterId] 角色 id（默认 ophelia）
 * @param {string} [options.characterName] 角色名（默认读人设）
 * @param {string} [options.userAddress] 对用户的称呼（默认读人设，兜底「主人」）
 * @param {object} [options.persona] 人设服务（renderPersonaSection / getDefinition）
 * @param {object} [options.memory] 记忆引擎（renderDigest / listLayer / status）
 * @param {object} [options.llm] ctx.llm（prepareCall）
 * @param {object} [options.web] 网络搜索服务（search）
 * @param {{ now: () => number }} [options.clock]
 * @param {() => ({provider?:string, model?:string})} [options.modelSelection]
 * @param {{ warn?: Function }} [options.logger]
 * @param {object} [options.config] 生成配置（见 DEFAULT_LIFE_CONFIG）
 * @param {string} [options.source] 计划来源标记（默认 ensure；凌晨维护传 nightly-memory-maintenance）
 * @returns {Promise<object>} 已写入磁盘的计划
 */
export async function generateDayPlan(options = {}) {
  const { dataDir, persona, memory, llm, web, logger } = options
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new Error('generateDayPlan 需要合法的 dataDir（角色数据目录）。')
  }
  const config = resolveLifeConfig(options.config)
  const nowMs = resolveNowMs(options.clock)
  const dateKey = String(options.dateKey ?? formatDateKey(nowMs))
  parseDateKey(dateKey)
  const characterId =
    typeof options.characterId === 'string' && options.characterId.trim()
      ? options.characterId.trim()
      : 'ophelia'
  const identity = resolveIdentity({
    persona,
    characterName: options.characterName,
    userAddress: options.userAddress,
    logger,
  })

  // 1. 候选时间与随机事件数/类型（同一天使用种子随机，重启不会一天内变来变去）
  const countRandom = createSeededRandom(`${dateKey}:${characterId}:count`)
  const desiredCount = config.eventCountRandom
    ? config.eventCountMin + Math.floor(randomValue(countRandom) * (config.eventCountMax - config.eventCountMin + 1))
    : config.eventCount
  const eventCount = config.eventCountRandom
    ? clamp(desiredCount, config.eventCountMin, config.eventCountMax)
    : clamp(desiredCount, MIN_EVENTS, MAX_EVENTS)
  const typeRandom = createSeededRandom(`${dateKey}:${characterId}:types`)
  const shuffledTypes = shuffle([...EVENT_TYPES], typeRandom)
  const eventTypes = Array.from({ length: eventCount }, (_, index) => shuffledTypes[index % shuffledTypes.length] ?? '日常')
  const slotRandom = createSeededRandom(`${dateKey}:${characterId}:slots`)
  const rawSlots = selectEventSlots({
    dateKey,
    nowMs,
    count: eventCount,
    random: slotRandom,
  })
  const times = ensureEventTimes(rawSlots, eventCount, nowMs)

  // 只生成发生时间：事件内容等到实际发生/推送时再按当时上下文生成。
  if (options.deferredContent === true || config.deferredContent === true) {
    const shell = createPlanShell({
      dateKey,
      characterId,
      nowIso: formatLocalIso(nowMs),
      source: typeof options.source === 'string' && options.source ? options.source : 'ensure',
    })
    const plan = {
      ...shell,
      deferredContent: true,
      events: times.map((time, index) => ({
        id: `evt-${index + 1}`,
        time,
        type: eventTypes[index] || '日常',
        pending: true,
        sentAt: null,
      })),
    }
    try {
      saveDayPlan(dataDir, plan)
    } catch (error) {
      logger?.warn?.(`[life] 延迟内容计划写入失败：${error?.message ?? error}`)
    }
    return plan
  }

  // 2. 记忆素材
  const memoryRandom = createSeededRandom(`${dateKey}:${characterId}:memory`)
  const { digest, oldMemories } = collectMemoryMaterials({ memory, config, logger, random: memoryRandom })

  // 3. 读物素材（web 优先，失败降级内置书目）
  const readingRandom = createSeededRandom(`${dateKey}:${characterId}:reading`)
  const query = buildReadingQuery(oldMemories, readingRandom)
  const readings = await collectReadings({
    web,
    query,
    random: readingRandom,
    logger,
    timeoutMs: config.webTimeoutMs,
  })

  // 4. 优先让 LLM 生成计划（无 LLM/无路由/失败/返回非法时走草稿）
  const personaSection = readPersonaSection(persona, logger)
  const route = resolveRoute({ config, modelSelection: options.modelSelection, logger })
  let llmEvents
  if (llm && route) {
    try {
      const system = buildPlanSystemPrompt({
        personaSection,
        dateKey,
        characterName: identity.characterName,
        userAddress: identity.userAddress,
        times,
        eventTypes,
      })
      const user = buildPlanMaterialsText({
        dateKey,
        characterName: identity.characterName,
        userAddress: identity.userAddress,
        times,
        eventTypes,
        digest,
        oldMemories,
        readings,
      })
      llmEvents = await generateEventsWithLlm({
        llm,
        route,
        system,
        user,
        maxTokens: config.maxTokens,
        timeoutMs: config.llmTimeoutMs,
      })
    } catch (error) {
      logger?.warn?.(`[life] 模型生成每日计划失败，改用确定性草稿：${error?.message ?? error}`)
      llmEvents = undefined
    }
  } else if (llm && !route) {
    logger?.warn?.('[life] 没有可用的模型路由，改用确定性草稿生成每日计划。')
  }

  let bodies = normalizeLlmEvents(llmEvents, { times, readings, eventTypes })
  if (bodies.length < MIN_EVENTS) {
    if (llmEvents) {
      logger?.warn?.('[life] 模型返回的事件不足 2 个或时间不合法，改用确定性草稿补足。')
    }
    bodies = buildDraftEvents({
      times,
      digest,
      oldMemories,
      readings,
      eventTypes,
      random: createSeededRandom(`${dateKey}:${characterId}:draft`),
    })
  }
  // 保障条数与随机类型一致；LLM 返回过多/过少时裁到 times 数量
  bodies = bodies.slice(0, times.length)
  while (bodies.length < times.length) {
    bodies.push(...buildDraftEvents({
      times: times.slice(bodies.length),
      digest,
      oldMemories,
      readings,
      eventTypes: eventTypes.slice(bodies.length),
      random: createSeededRandom(`${dateKey}:${characterId}:fill:${bodies.length}`),
    }))
  }

  // 5. 组装并原子写入计划文件
  const shell = createPlanShell({
    dateKey,
    characterId,
    nowIso: formatLocalIso(nowMs),
    source: typeof options.source === 'string' && options.source ? options.source : 'ensure',
  })
  const plan = { ...shell, events: finalizeEvents(bodies, eventTypes) }
  try {
    saveDayPlan(dataDir, plan)
  } catch (error) {
    // 写入失败不抛出，避免宿主（凌晨维护/QQ 通道）崩溃；由调用方日志排查
    logger?.warn?.(`[life] 每日计划写入失败：${error?.message ?? error}`)
  }
  return plan
}

/**
 * 确保某天有计划：已有合法计划直接返回；否则生成（并写入磁盘）。
 * @param {object} options 同 generateDayPlan
 * @returns {Promise<{ dateKey: string, plan: object, generated: boolean }>}
 */
export async function ensureDayPlan(options = {}) {
  const { dataDir } = options
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new Error('ensureDayPlan 需要合法的 dataDir（角色数据目录）。')
  }
  const nowMs = resolveNowMs(options.clock)
  const dateKey = String(options.dateKey ?? formatDateKey(nowMs))
  parseDateKey(dateKey)
  const existing = loadDayPlan(dataDir, dateKey)
  if (existing && validateDayPlan(existing)) {
    return { dateKey, plan: existing, generated: false }
  }
  const plan = await generateDayPlan({
    ...options,
    dateKey,
    source: typeof options.source === 'string' && options.source ? options.source : 'ensure',
  })
  return { dateKey, plan, generated: true }
}

/**
 * 凌晨记忆维护时调用：生成「第二天」的计划；已存在且合法时跳过（force=true 强制重生成）。
 * @param {object} options 同 generateDayPlan + { force?: boolean }
 * @returns {Promise<{ dateKey: string, plan: object, generated: boolean }>}
 */
export async function generatePlanForMaintenance(options = {}) {
  const { dataDir, force = false } = options
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new Error('generatePlanForMaintenance 需要合法的 dataDir（角色数据目录）。')
  }
  const nowMs = resolveNowMs(options.clock)
  const tomorrowKey = addDays(formatDateKey(nowMs), 1)
  if (!force) {
    const existing = loadDayPlan(dataDir, tomorrowKey)
    if (existing && validateDayPlan(existing)) {
      return { dateKey: tomorrowKey, plan: existing, generated: false }
    }
  }
  const plan = await generateDayPlan({
    ...options,
    dateKey: tomorrowKey,
    source: 'nightly-memory-maintenance',
  })
  return { dateKey: tomorrowKey, plan, generated: true }
}

/** 供集成/调试：默认时间池（re-export，避免调用方再 import dayplan）。 */
export { DEFAULT_TIME_POOL, TIME_POOL }
