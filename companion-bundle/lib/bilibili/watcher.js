/**
 * B站「每日看视频」调度器。
 *
 * 行为：
 *  - 每天在随机时间开启 4 次观看，每次最多 5 个视频，总计每天最多 20 个；
 *  - 根据当前兴趣标签 + 人设/记忆搜索 B站视频，只挑与兴趣标签相关的；
 *  - 每个视频读完（详情/标签/字幕/AI总结，登录可用时）后写成一条短期记忆，最长 3 万字；
 *  - 有趣的视频可扩展兴趣标签；配置 B站 Cookie + 主人 UID 后，可在评论区 @ 主人发 10–30 字总结。
 *
 * 数据（角色 dataDir 下）：
 *  - bilibili/state.json   当天计划、已看、兴趣、历史、评论数
 *  - bilibili/account.json B站 Cookie / csrf / 主人 UID / 开关（由用户填写）
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  createBilibiliClient,
  csrfFromCookie,
  normalizeAid,
} from './client.js'
import { formatDateKey } from '../life/dayplan.js'
import { formatLocalIso } from '../shared/clock.js'

export const DEFAULT_BILIBILI_CONFIG = Object.freeze({
  enabled: true,
  dailyLimit: 20,
  sessionSize: 5,
  maxSessions: 4,
  startHour: 9,
  endHour: 23,
  watchStartHour: 19,
  watchEndHour: 23,
  summaryMaxChars: 30000,
  summaryMaxTokens: 2400,
  commentEnabled: false,
  commentMaxPerDay: 5,
  commentMinChars: 10,
  commentMaxChars: 30,
  interestLimit: 80,
  searchPages: 2,
  minRelevanceTags: 1,
})

const FALLBACK_INTERESTS = Object.freeze([
  '图书馆',
  '读书',
  '历史',
  '纪录片',
  '散文',
  '音乐',
  '猫',
  '手账',
])

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback
}

export function resolveBilibiliConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const merged = { ...DEFAULT_BILIBILI_CONFIG, ...source }
  merged.enabled = source.enabled !== false
  merged.dailyLimit = clampInt(merged.dailyLimit, 1, 100, 20)
  merged.sessionSize = clampInt(merged.sessionSize, 1, 20, 5)
  merged.maxSessions = clampInt(merged.maxSessions, 1, 20, 4)
  merged.startHour = clampInt(merged.startHour, 0, 23, 9)
  merged.endHour = clampInt(merged.endHour, merged.startHour + 1, 24, 23)
  merged.watchStartHour = clampInt(merged.watchStartHour, 0, 23, 19)
  merged.watchEndHour = clampInt(merged.watchEndHour, merged.watchStartHour + 1, 24, 23)
  merged.summaryMaxChars = clampInt(merged.summaryMaxChars, 1000, 30000, 30000)
  merged.summaryMaxTokens = clampInt(merged.summaryMaxTokens, 256, 32768, 2400)
  merged.commentEnabled = source.commentEnabled === true
  merged.commentMaxPerDay = clampInt(merged.commentMaxPerDay, 0, 20, 5)
  merged.commentMinChars = clampInt(merged.commentMinChars, 5, 50, 10)
  merged.commentMaxChars = clampInt(merged.commentMaxChars, merged.commentMinChars, 100, 30)
  merged.interestLimit = clampInt(merged.interestLimit, 10, 200, 80)
  merged.searchPages = clampInt(merged.searchPages, 1, 3, 2)
  merged.minRelevanceTags = clampInt(merged.minRelevanceTags, 0, 5, 1)
  return merged
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

function ensureJsonFile(file, fallback) {
  if (!fs.existsSync(file)) writeJson(file, fallback)
  return readJson(file, fallback)
}

function pickRandom(items, count) {
  const list = [...items]
  const result = []
  while (list.length > 0 && result.length < count) {
    const index = Math.floor(Math.random() * list.length)
    result.push(list.splice(index, 1)[0])
  }
  return result
}

function shuffle(items) {
  const list = [...items]
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

function normalizeTag(tag) {
  return String(tag ?? '')
    .replace(/^#/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 24)
}

function uniqueTags(tags, max = 80) {
  const seen = new Set()
  const result = []
  for (const tag of Array.isArray(tags) ? tags : []) {
    const value = normalizeTag(tag)
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= max) break
  }
  return result
}

function textLength(text) {
  return Array.from(String(text ?? '')).length
}

function truncateText(text, maxChars) {
  const chars = Array.from(String(text ?? ''))
  return chars.slice(0, maxChars).join('')
}

function summarizeFallback(material, maxChars) {
  const tags = Array.isArray(material.tags) ? material.tags.join('、') : ''
  const details = material.aiSummary || material.subtitle || material.description || '视频里没有一个很清楚的文字简介。'
  const text = [
    `今天我自己在 B 站刷到《${material.title || material.bvid}》`,
    material.author ? `，UP主是${material.author}` : '',
    tags ? `，标签有${tags}` : '',
    `。我点开看完了，视频具体讲到：${details}`,
    '我觉得这段内容值得记下来，也想讲给主人听。',
  ].join('')
  return truncateText(text, maxChars)
}

function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    // 容忍 ```json 围栏/前后解释
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw)
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      // ignore
    }
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      // ignore
    }
  }
  return undefined
}

function parseJsonArray(text) {
  const raw = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw)
  const candidate = fenced ? fenced[1].trim() : raw
  try {
    const parsed = JSON.parse(candidate)
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray(parsed.tags)) return parsed.tags
  } catch {
    // try bracket slice
  }
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    } catch {
      // ignore
    }
  }
  return []
}

/**
 * 创建 watcher。
 * @param {object} options
 * @param {string} options.dataDir
 * @param {object} [options.persona]
 * @param {object} options.memory
 * @param {object} [options.llm]
 * @param {Function} [options.modelSelection]
 * @param {{now:()=>number}} [options.clock]
 * @param {object} [options.config]
 * @param {object} [options.logger]
 * @param {object} [options.client] 测试注入
 */
export function createBilibiliWatcher({
  dataDir,
  persona,
  memory,
  llm,
  modelSelection,
  analyzer,
  clock = { now: () => Date.now() },
  config = {},
  logger,
  client,
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('B站 watcher 需要 dataDir')
  const settings = resolveBilibiliConfig(config)
  const dir = path.join(dataDir, 'bilibili')
  const stateFile = path.join(dir, 'state.json')
  const accountFile = path.join(dir, 'account.json')
  const account = ensureJsonFile(accountFile, {
    cookie: '',
    csrf: '',
    ownerUid: '',
    ownerName: '主人',
    commentEnabled: false,
  })
  let accountState = account
  let accountCookie = /在这里填|SESSDATA=在这里填/u.test(String(accountState.cookie ?? ''))
    ? ''
    : String(accountState.cookie ?? '')
  let bili = client ?? createBilibiliClient({ cookie: accountCookie, timeoutMs: 20000 })

  function reloadAccount() {
    accountState = readJson(accountFile, {
      cookie: '',
      csrf: '',
      ownerUid: '',
      ownerName: '主人',
      commentEnabled: false,
    })
    accountCookie = /在这里填|SESSDATA=在这里填/u.test(String(accountState.cookie ?? ''))
      ? ''
      : String(accountState.cookie ?? '')
    if (!client) bili = createBilibiliClient({ cookie: accountCookie, timeoutMs: 20000 })
    return { hasCookie: Boolean(accountCookie), selfName: accountState.selfName, selfUid: accountState.selfUid }
  }
  let state = ensureJsonFile(stateFile, createFreshState(clock.now()))
  let running = false
  let tickPromise

  function nowMs() {
    try {
      const value = Number(clock.now())
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  function todayKey() {
    return formatDateKey(nowMs())
  }

  function createFreshState(atMs) {
    const dateKey = formatDateKey(atMs)
    return {
      version: 1,
      dateKey,
      plannedSessions: [],
      plannedWatchSessions: [],
      watchedToday: [],
      commentsToday: 0,
      interests: [],
      history: [],
      pendingShares: [],
      lastSessionAt: null,
      lastWatchAt: null,
      lastShareAt: null,
      nextSessionAt: null,
      nextWatchAt: null,
      updatedAt: formatLocalIso(atMs),
    }
  }

  function persist() {
    state.updatedAt = formatLocalIso(nowMs())
    writeJson(stateFile, state)
  }

  function resetDayIfNeeded() {
    const key = todayKey()
    if (state.dateKey === key) return false
    state = {
      ...createFreshState(nowMs()),
      interests: Array.isArray(state.interests) ? state.interests : [],
      history: Array.isArray(state.history) ? state.history.slice(-500) : [],
      // 待分享的视频跨天保留：晚上看完，白天随机分享时间再发/写记忆。
      pendingShares: Array.isArray(state.pendingShares) ? state.pendingShares.slice(-40) : [],
    }
    planSessions()
    persist()
    return true
  }

  function randomTimes(dateKey, startHour, endHour, maxSessions = settings.maxSessions) {
    const base = new Date(`${dateKey}T00:00:00`)
    const start = startHour * 60
    const end = endHour * 60
    const times = []
    for (let i = 0; i < maxSessions; i += 1) {
      const minutes = start + Math.floor(Math.random() * Math.max(1, end - start))
      times.push(new Date(base.getTime() + minutes * 60 * 1000).getTime())
    }
    times.sort((a, b) => a - b)
    // 避免同一分钟
    for (let i = 1; i < times.length; i += 1) {
      if (times[i] - times[i - 1] < 5 * 60 * 1000) times[i] = times[i - 1] + 5 * 60 * 1000
    }
    return times.filter((time) => time > nowMs())
  }

  function planSessions() {
    // 分享时间：保持原先 09:00–23:00 的随机窗口。
    const shareTimes = randomTimes(todayKey(), settings.startHour, settings.endHour)
    state.plannedSessions = shareTimes.map((time) => formatLocalIso(time))
    state.nextSessionAt = state.plannedSessions[0] ?? null
    // 看视频时间：统一挪到晚上 watchStartHour–watchEndHour。
    const watchTimes = randomTimes(todayKey(), settings.watchStartHour, settings.watchEndHour)
    state.plannedWatchSessions = watchTimes.map((time) => formatLocalIso(time))
    state.nextWatchAt = state.plannedWatchSessions[0] ?? null
  }

  function resolveRoute() {
    if (settings.provider && settings.model) return { provider: settings.provider, model: settings.model }
    try {
      const selected = typeof modelSelection === 'function' ? modelSelection() : undefined
      if (selected && typeof selected.provider === 'string' && typeof selected.model === 'string') return selected
    } catch {
      // ignore
    }
    return undefined
  }

  async function complete({ system, user, maxTokens }) {
    if (!llm || typeof llm.prepareCall !== 'function') return ''
    const route = resolveRoute()
    if (!route) return ''
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(120000) : undefined
    const call = await llm.prepareCall({ ...route, maxTokens }, signal)
    const stream = call.stream({
      ...(call.config ?? route),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      purpose: 'bilibili-watch',
      signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(`模型调用失败：${chunk.reason?.failure?.message ?? '未知错误'}`)
      }
    }
    return text.trim()
  }

  function personaText() {
    try {
      return typeof persona?.renderPersonaSection === 'function' ? persona.renderPersonaSection() : ''
    } catch {
      return ''
    }
  }

  function memoryDigest() {
    try {
      return typeof memory?.renderDigest === 'function'
        ? memory.renderDigest({ latestUserText: '', maxChars: 1600 })
        : ''
    } catch {
      return ''
    }
  }

  async function ensureInterests() {
    if (Array.isArray(state.interests) && state.interests.length >= 3) return state.interests
    let tags = []
    try {
      const text = await complete({
        system: '你为角色维护 B站「感兴趣标签」。只输出 JSON 数组，不要解释。',
        user: `【人设】\n${truncateText(personaText(), 3000)}\n\n【近期记忆】\n${truncateText(memoryDigest(), 3000)}\n\n请给出 10–12 个适合在B站搜索的兴趣标签（短词，中文，不要#）。只输出 JSON 数组，例如 ["图书馆","历史","纪录片"]。`,
        maxTokens: 300,
      })
      tags = parseJsonArray(text)
    } catch (error) {
      logger?.warn?.(`[bilibili] 生成兴趣标签失败：${error?.message ?? error}`)
    }
    state.interests = uniqueTags(tags.length > 0 ? tags : FALLBACK_INTERESTS, settings.interestLimit)
    persist()
    return state.interests
  }

  function isRelated(video, interests) {
    const text = `${video.title ?? ''} ${video.tag ?? ''} ${(video.tags ?? []).join(' ')}`.toLowerCase()
    return interests.some((tag) => tag && text.includes(String(tag).toLowerCase()))
  }

  async function searchCandidates(interests, need) {
    const candidates = []
    const seen = new Set(state.watchedToday ?? [])
    const queries = shuffle(interests).slice(0, 5)
    for (const interest of queries) {
      for (let page = 1; page <= settings.searchPages; page += 1) {
        try {
          const rows = await bili.searchVideos({ keyword: interest, page })
          for (const row of rows) {
            if (!row?.bvid || seen.has(row.bvid)) continue
            if (!isRelated(row, interests)) continue
            seen.add(row.bvid)
            candidates.push({ ...row, matchedTag: interest })
          }
        } catch (error) {
          logger?.warn?.(`[bilibili] 搜索失败（${interest} p${page}）：${error?.message ?? error}`)
        }
        if (candidates.length >= need * 3) break
      }
      if (candidates.length >= need * 3) break
    }
    return candidates
  }

  function videoMaterialText(material) {
    const lines = [
      `【标题】${material.title}`,
      `【UP主】${material.author || '未知'}`,
      `【标签】${(material.tags ?? []).join('、') || material.tname || '无'}`,
      `【简介】${material.description || '无'}`,
    ]
    if (material.aiSummary) lines.push(`【B站AI总结】${material.aiSummary}`)
    if (material.subtitle) lines.push(`【字幕摘录】${material.subtitle}`)
    if (Array.isArray(material.comments) && material.comments.length > 0) {
      lines.push(`【热门评论】${material.comments.slice(0, 8).join(' / ')}`)
    }
    return truncateText(lines.join('\n'), 30000)
  }

  async function summarizeVideo(material) {
    const fallback = summarizeFallback(material, settings.summaryMaxChars)
    try {
      const text = await complete({
        system: [
          '你在帮角色把刚看完的 B站视频整理成自己的记忆。',
          '要写成「我自己刷 B站时点开看的」，不是平台推荐、不是平台推送、不是任务。',
          '用第一人称、具体、自然的中文写，写清视频到底讲了什么、关键细节、例子或观点；不要只写“很有意思/讲了某主题”这种模糊概括。',
          '可以写自己为什么点开、看到哪一段停了一下、想不想分享给主人；不要营销腔，不要分点，不要链接。',
          `最多 ${settings.summaryMaxChars} 字。`,
        ].join('\n'),
        user: `【视频材料】\n${videoMaterialText(material)}`,
        maxTokens: settings.summaryMaxTokens,
      })
      if (text) return truncateText(text, settings.summaryMaxChars)
    } catch (error) {
      logger?.warn?.(`[bilibili] 视频总结失败，使用材料兜底：${error?.message ?? error}`)
    }
    return fallback
  }

  async function judgeInteresting(material, interests) {
    try {
      const text = await complete({
        system: '判断这个B站视频是否让角色觉得有趣，并根据内容给出相关标签。只输出 JSON：{"interesting":true,"tags":["标签1","标签2"],"reason":"一句话"}。',
        user: `【当前兴趣】${interests.join('、')}\n【视频】\n${videoMaterialText(material)}`,
        maxTokens: 300,
      })
      const parsed = extractJson(text)
      if (parsed && typeof parsed.interesting === 'boolean') {
        return {
          interesting: parsed.interesting,
          tags: uniqueTags(parsed.tags ?? [], 8),
          reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        }
      }
    } catch (error) {
      logger?.warn?.(`[bilibili] 有趣判断失败，使用标签兜底：${error?.message ?? error}`)
    }
    const related = (material.tags ?? []).filter((tag) => isRelated({ title: tag, tag, tags: [tag] }, interests))
    return { interesting: related.length > 0, tags: related.slice(0, 5), reason: '' }
  }

  async function buildCommentSummary(material, interesting) {
    const fallback = truncateText(
      `${interesting.reason || (material.tags ?? [])[0] || material.title || '这个视频挺有意思'}`,
      settings.commentMaxChars,
    )
    try {
      const text = await complete({
        system: [
          '为B站评论区写一句给主人的推荐语，必须 @主人 的口吻之外只输出推荐内容。',
          `要求：${settings.commentMinChars}–${settings.commentMaxChars} 个汉字，具体、像熟人推荐，不要链接，不要客服腔。`,
          '只输出这一句。',
        ].join('\n'),
        user: `【视频】\n${videoMaterialText(material)}`,
        maxTokens: 120,
      })
      const cleaned = truncateText(String(text ?? '').replace(/\s+/g, ' ').trim(), settings.commentMaxChars)
      if (textLength(cleaned) >= settings.commentMinChars) return cleaned
    } catch (error) {
      logger?.warn?.(`[bilibili] 评论总结失败，使用兜底：${error?.message ?? error}`)
    }
    return fallback
  }

  function addInterests(tags) {
    state.interests = uniqueTags([...(state.interests ?? []), ...(tags ?? [])], settings.interestLimit)
    persist()
  }

  async function maybeComment(material, interesting) {
    if (!settings.commentEnabled) return { posted: false, reason: 'disabled' }
    if (accountState.commentEnabled === false) return { posted: false, reason: 'account_disabled' }
    if (!accountCookie) return { posted: false, reason: 'no_cookie' }
    if (!accountState.ownerUid) return { posted: false, reason: 'no_owner_uid' }
    if (/在这里填/u.test(String(accountState.ownerUid))) return { posted: false, reason: 'no_owner_uid' }
    if (state.commentsToday >= settings.commentMaxPerDay) return { posted: false, reason: 'daily_comment_limit' }
    const csrf = accountState.csrf || csrfFromCookie(accountCookie)
    if (!csrf) return { posted: false, reason: 'no_csrf' }
    const summary = await buildCommentSummary(material, interesting)
    const ownerName = String(accountState.ownerName || '主人').trim() || '主人'
    const message = `@${ownerName} ${summary}`
    try {
      const result = await bili.postComment({
        aid: material.aid,
        message,
        csrf,
        ownerUid: normalizeAid(accountState.ownerUid),
        ownerName,
      })
      state.commentsToday += 1
      persist()
      return { posted: true, message, replyId: result.replyId }
    } catch (error) {
      logger?.warn?.(`[bilibili] 评论发送失败：${error?.message ?? error}`)
      return { posted: false, error: error?.message ?? String(error) }
    }
  }

  async function rememberBilibiliVideo(material, summary, interesting, atMs = nowMs()) {
    let memoryStored = false
    if (typeof memory?.remember === 'function') {
      try {
        let analysis
        try {
          analysis = await analyzer?.analyze?.({
            content: `【我自己在B站刷到的视频】《${material.title || material.bvid}》\nUP主：${material.author || '未知'}\n标签：${(material.tags ?? []).join('、') || '无'}\n\n${summary}`,
            kindHint: 'video',
            source: 'bilibili',
          })
        } catch (error) {
          logger?.warn?.(`[bilibili] LLM 记忆整理失败：${error?.message ?? error}`)
        }
        const memoryKeywords = uniqueTags(
          [
            '奥菲莉亚',
            '主人',
            ...(Array.isArray(analysis?.keywords) ? analysis.keywords : []),
            material.title,
            material.author,
            ...(material.tags ?? []),
            '我自己刷到',
            '分享给主人',
          ],
          12,
        )
        const analysisSegments = Array.isArray(analysis?.segments) ? analysis.segments : []
        const memorySegments = analysisSegments.length > 0
          ? analysisSegments.map((segment) => {
              const who = typeof segment?.who === 'string' ? segment.who.trim() : ''
              return {
                ...segment,
                who: /奥菲莉亚/u.test(who) && /主人/u.test(who) ? who : `奥菲莉亚、主人（${who || '我'}）`,
              }
            })
          : [{
              who: '奥菲莉亚、主人',
              when: formatDateKey(atMs),
              where: 'B站',
              what: '奥菲莉亚自己刷到视频，看完后分享给主人',
              content: `奥菲莉亚自己刷到《${material.title || material.bvid}》，看完后把内容分享给主人。`,
            }]
        memory.remember({
          content: truncateText(
            `【我自己在B站刷到并分享给主人的视频·${formatDateKey(atMs)}】《${material.title || material.bvid}》\nUP主：${material.author || '未知'}\n标签：${(material.tags ?? []).join('、') || '无'}\n\n我不是被平台推荐看的；是我自己刷 B 站时点开的。看完以后我觉得这段内容值得让主人也知道，所以把它分享给主人。\n\n视频内容：${summary}`,
            30000,
          ),
          summary: `奥菲莉亚自己刷到《${material.title || material.bvid}》并分享给主人：${analysis?.summary || truncateText(summary, 120)}`,
          category: analysis?.category || '事件',
          keywords: memoryKeywords,
          source: 'bilibili',
          emphasis: interesting.interesting ? 2 : 1,
          metadata: analysis
            ? { ...analysis, keywords: memoryKeywords, segments: memorySegments, who: ['奥菲莉亚', '主人'], llm: true, viewedBy: 'self', sharedToOwner: true, platform: 'bilibili', videoTitle: material.title, upName: material.author, bvid: material.bvid }
            : { kind: 'video', described: material.title, keywords: memoryKeywords, segments: memorySegments, who: ['奥菲莉亚', '主人'], llm: false, viewedBy: 'self', sharedToOwner: true, platform: 'bilibili', videoTitle: material.title, upName: material.author, bvid: material.bvid },
          at: atMs,
        })
        memoryStored = true
      } catch (error) {
        logger?.warn?.(`[bilibili] 写入记忆失败：${error?.message ?? error}`)
      }
    }
    return memoryStored
  }

  async function watchOne(video, interests, options = {}) {
    const material = await bili.getVideoMaterial({ bvid: video.bvid })
    material.tags = uniqueTags([...(material.tags ?? []), ...(video.tags ?? [])], 20)
    if (!isRelated(material, interests)) {
      return { bvid: video.bvid, skipped: 'unrelated_tags' }
    }
    const summary = await summarizeVideo(material)
    const interesting = await judgeInteresting(material, interests)
    if (interesting.interesting && interesting.tags.length > 0) addInterests(interesting.tags)

    if (options.deferShare) {
      const record = {
        bvid: material.bvid,
        aid: material.aid,
        title: material.title,
        author: material.author,
        tags: material.tags,
        interesting: interesting.interesting,
        pendingShare: true,
        watchedAt: formatLocalIso(nowMs()),
      }
      state.pendingShares = [...(state.pendingShares ?? []), {
        material,
        summary,
        interesting,
        watchedAt: record.watchedAt,
      }].slice(-40)
      state.watchedToday = [...new Set([...(state.watchedToday ?? []), material.bvid])]
      state.history = [...(state.history ?? []), record].slice(-500)
      persist()
      return record
    }

    let comment = { posted: false, reason: 'not_interesting' }
    if (interesting.interesting) comment = await maybeComment(material, interesting)

    const memoryStored = await rememberBilibiliVideo(material, summary, interesting)
    const record = {
      bvid: material.bvid,
      aid: material.aid,
      title: material.title,
      author: material.author,
      tags: material.tags,
      interesting: interesting.interesting,
      commentPosted: comment.posted,
      memoryStored,
      at: formatLocalIso(nowMs()),
    }
    state.watchedToday = [...new Set([...(state.watchedToday ?? []), material.bvid])]
    state.history = [...(state.history ?? []), record].slice(-500)
    persist()
    return record
  }

  async function sharePending(pending) {
    const material = pending.material
    const comment = pending.interesting?.interesting
      ? await maybeComment(material, pending.interesting)
      : { posted: false, reason: 'not_interesting' }
    const memoryStored = await rememberBilibiliVideo(material, pending.summary, pending.interesting || { interesting: false, tags: [] })
    const record = {
      bvid: material.bvid,
      aid: material.aid,
      title: material.title,
      author: material.author,
      tags: material.tags,
      interesting: pending.interesting?.interesting === true,
      commentPosted: comment.posted,
      memoryStored,
      sharedAt: formatLocalIso(nowMs()),
    }
    state.history = [...(state.history ?? []), record].slice(-500)
    state.lastShareAt = record.sharedAt
    return record
  }

  async function runSession() {
    if (!settings.enabled) return { ok: false, reason: 'disabled' }
    if (state.watchedToday.length >= settings.dailyLimit) return { ok: false, reason: 'daily_limit' }
    const remaining = Math.min(settings.sessionSize, settings.dailyLimit - state.watchedToday.length)
    const interests = await ensureInterests()
    let candidates = await searchCandidates(interests, remaining)
    if (candidates.length === 0) {
      // 没有相关标签结果时，用组合关键词再搜一次（仍只保留相关结果）
      try {
        const combined = await bili.searchVideos({ keyword: interests.slice(0, 3).join(' ') })
        candidates = combined.filter(
          (video) => video?.bvid && !state.watchedToday.includes(video.bvid) && isRelated(video, interests),
        )
      } catch (error) {
        logger?.warn?.(`[bilibili] 组合搜索失败：${error?.message ?? error}`)
      }
    }
    const picked = shuffle(candidates).slice(0, remaining)
    const results = []
    for (const video of picked) {
      if (state.watchedToday.length >= settings.dailyLimit) break
      try {
        const record = await watchOne(video, interests)
        if (!record.skipped) results.push(record)
      } catch (error) {
        logger?.warn?.(`[bilibili] 观看失败（${video.bvid}）：${error?.message ?? error}`)
      }
    }
    state.lastSessionAt = formatLocalIso(nowMs())
    state.plannedSessions = (state.plannedSessions ?? []).filter((iso) => Date.parse(iso) > nowMs())
    state.nextSessionAt = state.plannedSessions[0] ?? null
    persist()
    return { ok: true, watched: results.length, results, nextSessionAt: state.nextSessionAt }
  }

  /** 晚间观看：只抓取/总结，评论与记忆统一放到随机分享时间。 */
  async function runWatchSession() {
    if (!settings.enabled) return { ok: false, reason: 'disabled' }
    if (state.watchedToday.length >= settings.dailyLimit) return { ok: false, reason: 'daily_limit' }
    const remaining = Math.min(settings.sessionSize, settings.dailyLimit - state.watchedToday.length)
    const interests = await ensureInterests()
    let candidates = await searchCandidates(interests, remaining)
    if (candidates.length === 0) {
      try {
        const combined = await bili.searchVideos({ keyword: interests.slice(0, 3).join(' ') })
        candidates = combined.filter(
          (video) => video?.bvid && !state.watchedToday.includes(video.bvid) && isRelated(video, interests),
        )
      } catch (error) {
        logger?.warn?.(`[bilibili] 组合搜索失败：${error?.message ?? error}`)
      }
    }
    const picked = shuffle(candidates).slice(0, remaining)
    const results = []
    for (const video of picked) {
      if (state.watchedToday.length >= settings.dailyLimit) break
      try {
        const record = await watchOne(video, interests, { deferShare: true })
        if (!record.skipped) results.push(record)
      } catch (error) {
        logger?.warn?.(`[bilibili] 晚间观看失败（${video.bvid}）：${error?.message ?? error}`)
      }
    }
    state.lastWatchAt = formatLocalIso(nowMs())
    state.plannedWatchSessions = (state.plannedWatchSessions ?? []).filter((iso) => Date.parse(iso) > nowMs())
    state.nextWatchAt = state.plannedWatchSessions[0] ?? null
    persist()
    return { ok: true, watched: results.length, results, pendingShares: state.pendingShares.length, nextWatchAt: state.nextWatchAt }
  }

  /** 随机分享时间：发评论 + 写记忆（记忆时间以分享时间为准）。 */
  async function runShareSession() {
    if (!settings.enabled) return { ok: false, reason: 'disabled' }
    const pending = Array.isArray(state.pendingShares) ? state.pendingShares : []
    const results = []
    if (pending.length > 0) {
      const batch = pending.slice(0, settings.sessionSize)
      state.pendingShares = pending.slice(batch.length)
      for (const item of batch) {
        try {
          results.push(await sharePending(item))
        } catch (error) {
          logger?.warn?.(`[bilibili] 分享失败（${item?.material?.bvid}）：${error?.message ?? error}`)
          state.pendingShares = [...(state.pendingShares ?? []), item]
        }
      }
    }
    state.lastSessionAt = formatLocalIso(nowMs())
    state.plannedSessions = (state.plannedSessions ?? []).filter((iso) => Date.parse(iso) > nowMs())
    state.nextSessionAt = state.plannedSessions[0] ?? null
    persist()
    return { ok: true, shared: results.length, results, pendingShares: state.pendingShares.length, nextSessionAt: state.nextSessionAt }
  }

  async function tick() {
    if (running) return { ok: false, reason: 'running' }
    resetDayIfNeeded()
    if (!settings.enabled) return { ok: false, reason: 'disabled' }
    if (!Array.isArray(state.plannedSessions) || !Array.isArray(state.plannedWatchSessions)) {
      planSessions()
      persist()
    }
    running = true
    try {
      let watchResult
      let shareResult
      if (state.nextWatchAt && nowMs() >= Date.parse(state.nextWatchAt)) {
        watchResult = await runWatchSession()
        if (watchResult.ok) {
          logger?.info?.(`[bilibili] 晚间观看 ${watchResult.watched} 个，待分享 ${watchResult.pendingShares} 个`)
        }
      }
      if (state.nextSessionAt && nowMs() >= Date.parse(state.nextSessionAt)) {
        shareResult = await runShareSession()
        if (shareResult.ok) {
          logger?.info?.(`[bilibili] 随机分享 ${shareResult.shared} 个，剩余待分享 ${shareResult.pendingShares} 个`)
        }
      }
      if (watchResult?.ok) return watchResult
      if (shareResult?.ok) return shareResult
      return { ok: false, reason: 'not_due' }
    } finally {
      running = false
    }
  }

  // 初始化当天计划；如果今天已经过了所有时间点，不再补课（避免启动时一次性看一堆）
  if (!Array.isArray(state.plannedSessions) || state.plannedSessions.length === 0 || !Array.isArray(state.plannedWatchSessions) || state.plannedWatchSessions.length === 0) {
    planSessions()
    persist()
  }
  resetDayIfNeeded()

  return {
    settings,
    account: () => accountState,
    state: () => state,
    stateFile,
    accountFile,
    reloadAccount,
    tick,
    runSession,
    runWatchSession,
    runShareSession,
    ensureInterests,
    getStatus: () => ({
      enabled: settings.enabled,
      dateKey: state.dateKey,
      watchedToday: state.watchedToday.length,
      dailyLimit: settings.dailyLimit,
      interests: state.interests,
      nextSessionAt: state.nextSessionAt,
      nextWatchAt: state.nextWatchAt,
      pendingShares: (state.pendingShares ?? []).length,
      watchStartHour: settings.watchStartHour,
      watchEndHour: settings.watchEndHour,
      commentsToday: state.commentsToday,
      commentEnabled: settings.commentEnabled,
      self: { mid: accountState.selfUid ?? '', name: accountState.selfName ?? '' },
      hasCookie: Boolean(accountCookie),
    }),
  }
}
