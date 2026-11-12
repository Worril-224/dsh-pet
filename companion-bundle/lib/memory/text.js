/**
 * 记忆文本处理：关键词抽取、分类判定、自动抽取规则、摘要生成、去重规范化。
 * 仅依赖 node:* 内置模块与包内相对路径（bundle 不能依赖任何 npm 包）。
 */
import { MEMORY_CATEGORIES } from './constants.js'

const TRAILING_NOISE = /[。！？；，、,.!?;:：\s"'“”‘’（）()【】[\]…—~～·]+$/u
const TRAILING_PARTICLES = /[吧哦呀啦呢啊嘛哈呗咯]+$/u
const CLAUSE_SPLIT = /[。！？；\n]/u
const SEGMENT_SPLIT = /[。！？；，,、\n]/u
const CATEGORY_SET = new Set(MEMORY_CATEGORIES)

/** 截断到指定字符数。 */
export function clipText(value, max) {
  const text = String(value ?? '')
  return text.length <= max ? text : text.slice(0, max)
}

/** 去掉首尾标点与句末语气词，得到干净短语。 */
export function cleanPhrase(value) {
  let text = String(value ?? '').trim()
  text = text.replace(TRAILING_NOISE, '')
  text = text.replace(TRAILING_PARTICLES, '')
  text = text.replace(TRAILING_NOISE, '')
  return text.trim()
}

/**
 * 摘要规则（SPEC 4.7）：content 的第一个分句（按 。！？；\n 切分）截断到 30 字符；
 * 若 content 本身 ≤30 字符则直接使用。
 */
export function buildSummary(content) {
  const text = String(content ?? '').trim()
  if (!text) return ''
  if (text.length <= 30) return text
  const firstClause = (text.split(CLAUSE_SPLIT)[0] || text).trim()
  return firstClause.length <= 30 ? firstClause : firstClause.slice(0, 30)
}

/**
 * 层级压缩：把正文压缩到原来的 ratio（默认 75%），尽量在句末/标点处截断。
 * 只用于非背景故事记忆的下沉（见 MemoryEngine 维护流程）。
 *
 * @param {string} content 原文
 * @param {{ ratio?: number, minChars?: number }} [options]
 * @returns {string}
 */
export function compactText(content, options = {}) {
  const text = String(content ?? '').trim()
  const ratio = Number.isFinite(Number(options.ratio)) ? Math.min(1, Math.max(0.1, Number(options.ratio))) : 0.75
  const minChars = Number.isFinite(Number(options.minChars)) ? Math.max(1, Math.round(Number(options.minChars))) : 12
  if (!text) return ''
  const target = Math.max(minChars, Math.floor(text.length * ratio))
  if (text.length <= target) return text

  const cut = text.slice(0, target)
  // 严格压缩到 target（原长度的 ratio）；若正好停在句末标点则保留，否则用省略号占最后一位，
  // 避免出现超过 75% 或截成半个标点。
  const sentenceEnd = new Set(['。', '！', '？', '!', '?', '；', ';', '\n'])
  if (sentenceEnd.has(cut[cut.length - 1])) return cut
  return `${cut.slice(0, Math.max(1, target - 1))}…`
}

/** 去重规范化：去掉空白与标点、英文转小写。 */
export function normalizeForDedup(content) {
  return String(content ?? '')
    .replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】[\]…—~～·]/gu, '')
    .toLowerCase()
}

/** 是否为忽略匹配的 # 分类回填标签（SPEC 4.3）。 */
export function isTagKeyword(keyword) {
  return typeof keyword === 'string' && keyword.trim().startsWith('#')
}

/** 分类判定规则：按关键词命中优先级判定（SPEC 4.4）。 */
const CATEGORY_RULES = [
  ['喜好', ['喜欢', '爱吃', '爱吃', '口味', '番剧', '游戏', '讨厌', '爱好', '最爱', '电影', '音乐', '零食', '饮料', '颜色', '歌手', '动漫']],
  ['身份', ['我叫', '名字', '生日', '年龄', '星座', '身份', '称呼']],
  ['情绪', ['难过', '开心', '害怕', '焦虑', '孤独', '生气', '伤心', '高兴', '委屈', '烦躁', '不安', '紧张', '幸福', '感动']],
  ['承诺', ['答应', '一定', '承诺', '约定', '保证', '发誓', '说好']],
  ['计划', ['打算', '准备', '计划', '想要', '将来', '以后', '明天要', '周末要']],
  ['事件', ['今天', '昨天', '刚才', '最近', '发生', '去了']],
  ['健康', ['健康', '生病', '吃药', '药', '医院', '头疼', '发烧', '感冒', '睡不好', '失眠']],
  ['人际', ['家人', '朋友', '同事', '同学', '宠物', '妈妈', '爸爸', '父母', '兄弟', '姐妹']],
  ['工作学习', ['工作', '学习', '考试', '上班', '学校', '专业', '作业', '加班', '项目', '课程']],
]

/**
 * 分类判定（SPEC 4.4）：含「喜欢/爱吃/口味/番剧/游戏」→ 喜好；含「我叫/名字/生日/年龄」→ 身份；
 * 含「难过/开心/害怕/焦虑/孤独」→ 情绪；含「答应/一定/承诺/约定」→ 承诺；含「打算/准备/计划」→ 计划；
 * 含「今天/昨天/发生/去了」→ 事件；默认 其他。
 */
export function classifyCategory(text) {
  const source = String(text ?? '')
  if (!source) return '其他'
  for (const [category, words] of CATEGORY_RULES) {
    if (words.some((word) => source.includes(word))) return category
  }
  return '其他'
}

/** 规范分类：显式给出且合法则采用，否则按内容判定。 */
export function resolveCategory(category, content) {
  const explicit = String(category ?? '').trim()
  if (CATEGORY_SET.has(explicit)) return explicit
  return classifyCategory(content)
}

const STOP_CHARS = new Set(
  '的了是在有和就都也还又很太最更不没把我你他她它们这那要会能可被让给对从向与及或但而再才只个一已将要着过做去来说想看听吃喝玩买学'.split(''),
)

function isMeaningfulBigram(bigram) {
  if (!/^[\u4e00-\u9fa5A-Za-z]{2}$/u.test(bigram)) return false
  return [...bigram].some((ch) => !STOP_CHARS.has(ch))
}

/** 关键词抽取用的捕获模式（优先取动词后的宾语短语）。 */
const CAPTURE_PATTERNS = [
  /(?:最|很|超|特别|非常)?喜欢([^。！？；，,\n]{1,10})/gu,
  /(?:最|很|超|特别|非常)?讨厌([^。！？；，,\n]{1,10})/gu,
  /(?:不喜欢)([^。！？；，,\n]{1,10})/gu,
  /记住[：:，, ]*([^。！？；\n]{1,16})/gu,
  /(?:我叫|我的名字是|我的名字叫|叫我)([\u4e00-\u9fa5A-Za-z0-9·]{1,10})/gu,
  /(?:生日|年龄|星座|工作|学校|专业|宠物|家人|朋友)(?:是|在|叫|有|：|:)([^。！？；，,\n]{1,10})/gu,
  /(?:打算|准备|计划|希望|想要)([^。！？；，,\n]{1,10})/gu,
  /(?:今天|昨天|刚才|最近)([^。！？；，,、\n]{1,10})/gu,
]

/**
 * 自动抽取关键词（SPEC 4.3 / 4.6），返回最多 limit 个中文关键词（越相关越靠前）。
 * 结果不保证 ≥3 个，由 normalizeKeywordList 负责用 #分类 标签补足。
 */
export function extractKeywords(content, limit = 5) {
  const text = String(content ?? '').trim()
  if (!text) return []
  const body = text.replace(/^主人/u, '').trim() || text
  /** @type {Map<string, number>} 关键词 → 分数 */
  const entries = new Map()
  const add = (word, score) => {
    const cleaned = clipText(cleanPhrase(word), 12)
    if (cleaned.length < 2) return
    if (/^[#\d]+$/u.test(cleaned)) return
    const prev = entries.get(cleaned)
    if (prev === undefined || score > prev) entries.set(cleaned, score)
  }

  for (const pattern of CAPTURE_PATTERNS) {
    pattern.lastIndex = 0
    let match = pattern.exec(body)
    while (match !== null) {
      add(match[1], 40)
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1
      match = pattern.exec(body)
    }
  }

  const segments = body.split(SEGMENT_SPLIT).map((part) => part.trim()).filter(Boolean)
  for (const segment of segments) {
    if (segment.length >= 2 && segment.length <= 6) add(segment, 20)
    for (let i = 0; i < segment.length - 1; i += 1) {
      const bigram = segment.slice(i, i + 2)
      if (isMeaningfulBigram(bigram)) add(bigram, 8)
    }
  }

  const ordered = [...entries.entries()].sort(
    (a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]),
  )
  return ordered.slice(0, Math.max(1, limit)).map(([word]) => word)
}

/**
 * 规范化关键词列表（SPEC 4.3）：3~5 个；调用方顺序保留（不重排）；>5 截断；
 * <3 时用 extractKeywords(content) 补足，仍不足时允许 #分类 形式的回填标签。
 */
export function normalizeKeywordList(provided, content, category, { min = 3, max = 5 } = {}) {
  const list = []
  if (Array.isArray(provided)) {
    for (const raw of provided) {
      const word = clipText(String(raw ?? '').trim(), 24)
      if (word && !list.includes(word)) list.push(word)
      if (list.length >= max) break
    }
  }
  if (list.length < min) {
    for (const word of extractKeywords(content)) {
      if (list.length >= min) break
      if (!list.includes(word)) list.push(word)
    }
  }
  if (list.length < min) {
    const fallbackCategory = CATEGORY_SET.has(category) ? category : classifyCategory(content)
    for (const tag of [`#${fallbackCategory}`, '#记忆', '#补充']) {
      if (list.length >= min) break
      if (!list.includes(tag)) list.push(tag)
    }
  }
  return list.slice(0, max)
}

const EMOTION_WORDS = ['难过', '开心', '害怕', '焦虑', '孤独', '生气', '伤心', '高兴', '委屈', '烦躁', '不安', '紧张']
const EMOTION_PATTERN = new RegExp(
  `我(今天|昨天|刚才|最近)?((?:真的|很|非常|有点|特别|好|超)?)(${EMOTION_WORDS.join('|')})`,
  'u',
)
const EVENT_ACTION_STARTS_WITH_EMOTION = new RegExp(
  `^(?:真的|很|非常|有点|特别|好|超)?(?:${EMOTION_WORDS.join('|')})`,
  'u',
)

function makeMatch({ content, keywords, category, emphasis, matched }) {
  const text = String(content ?? '').trim()
  if (text.length < 4) return null
  const clipped = text.length > 120 ? `${text.slice(0, 118)}。` : text
  const resolvedCategory = CATEGORY_SET.has(category) ? category : classifyCategory(clipped)
  const clampedEmphasis = Math.min(3, Math.max(0, Math.round(Number(emphasis) || 0)))
  return {
    content: clipped,
    keywords: normalizeKeywordList(keywords, clipped, resolvedCategory),
    category: resolvedCategory,
    emphasis: clampedEmphasis,
    matched,
  }
}

/**
 * 自动抽取记忆（SPEC 4.6）：覆盖 7 类中文模式，返回匹配数组（每条消息最多 3 条）。
 * 返回项：{ content, keywords, category, emphasis, matched }
 * @param {string} text 用户原始文本
 * @param {string|number} [at] 保留参数（时间戳由调用方写入条目）
 */
export function extractMemories(text, at = Date.now()) {
  void at
  const source = String(text ?? '').trim()
  if (!source) return []
  const matches = []
  const add = (result) => {
    const match = makeMatch(result)
    if (match) matches.push(match)
  }

  // 3. 不喜欢 / 讨厌（先判定，避免「不喜欢」被误判成「喜欢」）
  const dislike = source.match(/我(?:很|最|超|特别|非常)?(?:不喜欢|讨厌)([^。！？；，,\n]{1,60})/u)
  if (dislike) {
    const value = cleanPhrase(dislike[1])
    if (value) {
      add({
        content: `主人不喜欢${value}。`,
        category: '喜好',
        emphasis: 1,
        matched: 'dislike',
        keywords: [clipText(value, 12), '不喜欢', '讨厌'],
      })
    }
  }

  // 2. 喜欢
  const like = source.match(/我(?:很|超|最|特别|非常)?喜欢([^。！？；，,\n]{1,60})/u)
  if (like) {
    const value = cleanPhrase(like[1])
    if (value) {
      add({
        content: `主人喜欢${value}。`,
        category: '喜好',
        emphasis: 1,
        matched: 'like',
        keywords: [clipText(value, 12), '喜欢', '爱好'],
      })
    }
  }

  // 4. 记住……
  const remember = source.match(/(?:帮我)?记住[：:，, ]*([^。！？；\n]{1,90})/u)
  if (remember) {
    const value = cleanPhrase(remember[1])
    if (value) {
      const category = /答应|一定|承诺|约定|保证|发誓/u.test(value) ? '承诺' : '事件'
      add({
        content: `主人希望我记住：${value}。`,
        category,
        emphasis: 2,
        matched: 'remember',
        keywords: [clipText(value, 12), '记住', '提醒'],
      })
    }
  }

  // 1. 我叫X / 我的名字是X / 叫我X
  const name = source.match(/(?:我叫|我的名字是|我的名字叫|叫我)([\u4e00-\u9fa5A-Za-z0-9·]{1,12})/u)
  if (name) {
    const value = cleanPhrase(name[1])
    if (value) {
      add({
        content: `主人叫${value}。`,
        category: '身份',
        emphasis: 0,
        matched: 'identity_name',
        keywords: [value, '名字', '称呼'],
      })
    }
  }

  // 5. 我(的)?(生日|年龄|星座|工作|学校|专业|宠物|家人|朋友)……是/在/叫X
  const profile = source.match(
    /我(?:的)?(生日|年龄|星座|工作|学校|专业|宠物|家人|朋友)(?:是|在|叫|有|：|:)([^。！？；，,\n]{1,60})/u,
  )
  if (profile) {
    const field = profile[1]
    const value = cleanPhrase(profile[2])
    if (value) {
      const category = ['宠物', '家人', '朋友'].includes(field) ? '人际' : '身份'
      add({
        content: `主人的${field}是${value}。`,
        category,
        emphasis: 0,
        matched: 'profile',
        keywords: [clipText(value, 12), field, '情况'],
      })
    }
  }

  // 7. 我(难过|开心|害怕|焦虑|孤独|生气)……
  const emotion = source.match(EMOTION_PATTERN)
  const hasEmotion = Boolean(emotion)
  if (emotion) {
    // 保留原文中的时间词（今天/昨天/刚才/最近），未出现则不补时间词，避免篡改记忆内容。
    const timeWord = emotion[1] ?? ''
    const modifier = emotion[2] || ''
    const emotionWord = emotion[3]
    add({
      content: `主人${timeWord}${modifier}${emotionWord}。`,
      category: '情绪',
      emphasis: 0,
      matched: 'emotion',
      keywords: [emotionWord, ...(modifier ? [modifier.trim()] : []), ...(timeWord ? [timeWord] : [])],
    })
  }

  // 6. 我(今天|昨天|刚才|最近)……（取动作短语；若只是情绪则交给情绪规则）
  const event = source.match(/我(今天|昨天|刚才|最近)([^。！？；，,\n]{1,90})/u)
  if (event) {
    const timeWord = event[1]
    const action = cleanPhrase(event[2])
    const emotionOnly = hasEmotion && EVENT_ACTION_STARTS_WITH_EMOTION.test(action)
    if (action && !emotionOnly) {
      add({
        content: `主人${timeWord}${action}。`,
        category: '事件',
        emphasis: 0,
        matched: 'event',
        keywords: [clipText(action, 12), timeWord, '经历'],
      })
    }
  }

  // 去重（规范化后相等或包含关系）并按 SPEC 限制每条消息最多 3 条
  const unique = []
  for (const match of matches) {
    const normalized = normalizeForDedup(match.content)
    const duplicated = unique.some((existing) => {
      const other = normalizeForDedup(existing.content)
      return other === normalized || other.includes(normalized) || normalized.includes(other)
    })
    if (!duplicated) unique.push(match)
  }
  return unique.slice(0, 3)
}
