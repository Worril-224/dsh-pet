/**
 * 记忆整理器：把「写一条记忆」交给 LLM 做分类、关键词、事件分段和媒体描述。
 *
 * 输出统一结构：
 * {
 *   kind: 'event'|'person'|'preference'|'promise'|'plan'|'book'|'material'|'image'|'video'|'conversation'|'other',
 *   category: '喜好'|'身份'|'人际'|'事件'|'情绪'|'承诺'|'计划'|'健康'|'工作学习'|'其他',
 *   importance: 1-100,
 *   summary: '一句话摘要',
 *   keywords: ['谁','时间','地点','动作', ...],
 *   segments: [{ who, when, where, what, content }],
 *   described: '图片/视频的一句话描述（仅媒体）'
 * }
 *
 * 事件很长时按「谁/时间/地点/干了什么」拆成多段；不知道的字段写“不知道”。
 * 书籍/材料提取高频且重要的词；图片/视频先给一句话描述，再从描述提取关键词。
 */
import { classifyCategory, extractKeywords, resolveCategory } from './text.js'

const CATEGORIES = ['喜好', '身份', '人际', '事件', '情绪', '承诺', '计划', '健康', '工作学习', '其他']
const KINDS = ['event', 'person', 'preference', 'promise', 'plan', 'book', 'material', 'image', 'video', 'conversation', 'other']
const UNKNOWN = '不知道'

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

function uniqueList(list, max = 12) {
  const seen = new Set()
  const result = []
  for (const raw of Array.isArray(list) ? list : []) {
    const value = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 32)
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= max) break
  }
  return result
}

function safeText(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function inferKind(content, hint) {
  if (KINDS.includes(hint)) return hint
  const text = String(content ?? '')
  if (/书|小说|文章|材料|资料|论文|纪录片|字幕|读物/.test(text)) {
    return /书|小说|读物/.test(text) ? 'book' : 'material'
  }
  if (/图片|照片|截图|表情包/.test(text)) return 'image'
  if (/视频|番剧|短片|B站|bilibili/i.test(text)) return 'video'
  return 'event'
}

function fallbackAnalysis(content, { kindHint, mediaDescription } = {}) {
  const kind = inferKind(content, kindHint)
  const text = safeText(mediaDescription || content, 2000)
  const summary = text.slice(0, 80) || '（空记忆）'
  const keywords = uniqueList(
    [...extractKeywords(text, 12), ...(mediaDescription ? extractKeywords(mediaDescription, 12) : [])],
    12,
  )
  return {
    kind,
    category: resolveCategory(undefined, text),
    importance: kind === 'promise' ? 70 : 40,
    summary,
    keywords,
    segments: [
      {
        who: /主人/.test(text) ? '主人' : UNKNOWN,
        when: UNKNOWN,
        where: UNKNOWN,
        what: summary,
        content: safeText(content, 1200),
      },
    ],
    described: kind === 'image' || kind === 'video' ? (mediaDescription ? safeText(mediaDescription, 160) : summary) : '',
  }
}

function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    // fall through
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw)
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()) } catch { /* ignore */ }
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch { /* ignore */ }
  }
  return undefined
}

function normalizeSegments(parsedSegments, content) {
  const rows = Array.isArray(parsedSegments) ? parsedSegments : []
  const segments = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const who = safeText(row.who, 40) || UNKNOWN
    const when = safeText(row.when, 40) || UNKNOWN
    const where = safeText(row.where, 60) || UNKNOWN
    const what = safeText(row.what, 300) || UNKNOWN
    const body = safeText(row.content, 3000) || `${who} ${when} 在 ${where} ${what}`
    segments.push({ who, when, where, what, content: body })
    if (segments.length >= 12) break
  }
  if (segments.length === 0) {
    segments.push({
      who: UNKNOWN,
      when: UNKNOWN,
      where: UNKNOWN,
      what: UNKNOWN,
      content: safeText(content, 3000),
    })
  }
  return segments
}

function normalize(parsed, fallback) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
  const kind = KINDS.includes(parsed.kind) ? parsed.kind : fallback.kind
  const category = CATEGORIES.includes(parsed.category)
    ? parsed.category
    : resolveCategory(undefined, parsed.summary || '')
  const segments = normalizeSegments(parsed.segments, parsed.content || parsed.summary || '')
  const segmentKeywords = segments.flatMap((segment) => [segment.who, segment.when, segment.where, segment.what])
  const keywords = uniqueList([...(parsed.keywords || []), ...segmentKeywords], 12)
  const described =
    typeof parsed.described === 'string' && parsed.described.trim()
      ? safeText(parsed.described, 200)
      : fallback.described
  return {
    kind,
    category,
    importance: clampInt(parsed.importance, 1, 100, fallback.importance),
    summary: safeText(parsed.summary, 200) || fallback.summary,
    keywords: keywords.length > 0 ? keywords : fallback.keywords,
    segments,
    described,
  }
}

/** 创建记忆整理器；没有 llm 时仍会用规则兜底。 */
export function createMemoryAnalyzer({ llm, modelSelection, logger, maxTokens = 2400 } = {}) {
  function resolveRoute() {
    try {
      const selected = typeof modelSelection === 'function' ? modelSelection() : undefined
      if (selected && typeof selected.provider === 'string' && typeof selected.model === 'string') return selected
    } catch {
      // ignore
    }
    return undefined
  }

  async function complete({ system, user, images = [] }) {
    if (!llm || typeof llm.prepareCall !== 'function') return ''
    const route = resolveRoute()
    if (!route) return ''
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(120000) : undefined
    const call = await llm.prepareCall({ ...route, maxTokens }, signal)
    const content = [{ type: 'text', text: user }]
    for (const image of Array.isArray(images) ? images : []) {
      if (image && typeof image === 'object') content.push({ type: 'image', attachment: image })
    }
    const stream = call.stream({
      ...(call.config ?? route),
      system,
      messages: [{ role: 'user', content }],
      purpose: 'memory-analysis',
      signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(`记忆整理模型失败：${chunk.reason?.failure?.message ?? '未知错误'}`)
      }
    }
    return text.trim()
  }

  /**
   * 分析一条待写入记忆。
   * @param {{content:string, kindHint?:string, source?:string, images?:object[], mediaDescription?:string}} input
   */
  async function analyze({ content, kindHint, source, images = [], mediaDescription = '' } = {}) {
    const fallback = fallbackAnalysis(content, { kindHint, mediaDescription })
    try {
      const system = [
        '你是记忆整理器，只输出 JSON 对象，不要解释、不要 Markdown 代码块。',
        '任务：判断记忆类型、分类、重要度；提取关键词；如果事件很长或包含多个事件，拆成多段。',
        '事件段必须有 who（谁）、when（时间）、where（地点）、what（干了什么）；不知道的字段写“不知道”。',
        '关键词必须覆盖：谁、时间、地点、干了什么（能提取到就写），最多 12 个，按重要性排序。',
        '书籍/文章/材料：kind=book 或 material，keywords 提取出现最多、最重要的主题词/人名/概念。',
        '图片/视频：kind=image 或 video，先写一句 described 描述内容，再从这句话和素材提取关键词。',
        '分类只能是：喜好、身份、人际、事件、情绪、承诺、计划、健康、工作学习、其他。',
        'JSON 结构：{"kind":"event|person|preference|promise|plan|book|material|image|video|conversation|other","category":"...","importance":1,"summary":"...","keywords":[],"segments":[{"who":"","when":"","where":"","what":"","content":""}],"described":""}',
        '重要度：日常琐事 20-40，普通经历 40-60，明确喜好/关系/承诺 60-80，长期重要的事 80-100。',
      ].join('\n')
      const user = [
        `【来源】${source || 'unknown'}`,
        `【类型提示】${kindHint || 'auto'}`,
        mediaDescription ? `【媒体描述】${mediaDescription}` : '',
        '【待整理内容】',
        String(content ?? ''),
      ].filter(Boolean).join('\n')
      const text = await complete({ system, user, images })
      const parsed = extractJson(text)
      if (!parsed) return fallback
      return normalize(parsed, fallback)
    } catch (error) {
      logger?.warn?.(`[memory] LLM 记忆整理失败，使用规则兜底：${error?.message ?? error}`)
      return fallback
    }
  }

  return { analyze }
}
