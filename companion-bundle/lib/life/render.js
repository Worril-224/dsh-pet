/**
 * 每日事件渲染：把计划事件整理成素材文本、拼装「主动分享」提示词、以及无 LLM 时的兜底短句。
 * 全部为纯字符串处理，不依赖任何外部服务，便于发送端（QQ 通道）注入测试。
 */

/** 素材里引用读物时最多展示的片段长度。 */
const MAX_SOURCE_SNIPPET_CHARS = 120

/** 兜底短句最大长度。 */
const MAX_FALLBACK_CHARS = 220

function stripUrls(text) {
  return String(text ?? '')
    .replace(/\[([^\]]+)\]\((?:https?:)?\/\/[^)]+\)/gu, '$1')
    .replace(/(?:https?:\/\/|www\.|ftp:\/\/|mailto:)[^\s，。；！？、）)」』"']+/giu, '')
}

function sanitizeInline(value, maxChars) {
  let text = stripUrls(value)
    .replace(/\s+/gu, ' ')
    .trim()
  if (Number.isFinite(Number(maxChars)) && text.length > Number(maxChars)) {
    text = text.slice(0, Number(maxChars)).replace(/[，。；、,.;：:！!？?\s]+$/u, '').trim()
  }
  return text
}

function stripBookBrackets(title) {
  return String(title ?? '')
    .replace(/^《+/u, '')
    .replace(/》+$/u, '')
    .trim()
}

/** 把标题包上中文书名号（已带则不重复）。 */
function quotedTitle(title) {
  const text = stripBookBrackets(title)
  return text ? `《${text}》` : ''
}

function ensureSentence(text) {
  const value = String(text ?? '').trim()
  if (!value) return ''
  return /[。！？….”」』.!?]$/u.test(value) ? value : `${value}。`
}

/**
 * 把事件整理为给 LLM / 主人看的素材文本。
 * 不展示 sourceUrl（避免模型/消息里出现链接）；只展示读过什么、大概写了什么。
 * @param {object} event 计划事件
 * @returns {string}
 */
export function buildEventMaterial(event) {
  if (!event || typeof event !== 'object') return ''
  const lines = []
  const time = sanitizeInline(event.time, 20) || '（未定）'
  lines.push(`【时间】${time}`)
  const title = sanitizeInline(event.title, 60)
  if (title) lines.push(`【标题】${title}`)
  const type = sanitizeInline(event.type, 20)
  if (type) lines.push(`【类型】${type}`)
  const content = sanitizeInline(event.content, 300)
  if (content) lines.push(`【内容】${content}`)
  const sourceTitle = sanitizeInline(event.sourceTitle, 60)
  if (sourceTitle) {
    const quoted = quotedTitle(sourceTitle)
    const snippet = sanitizeInline(event.sourceSnippet, MAX_SOURCE_SNIPPET_CHARS)
    lines.push(snippet ? `【读物】读到${quoted}，里面写到：${snippet}` : `【读物】读到${quoted}`)
  }
  return lines.join('\n')
}

/**
 * 构造「到点主动分享」的 system / user 提示词。
 *
 * system = 人设段 + 记忆摘要 + 主动分享指令；
 * user   = 事件素材（+ 最近的对话，可选）。
 *
 * @param {object} options
 * @param {string} [options.personaSection] 人设段（persona.renderPersonaSection()）
 * @param {string} [options.digest] 记忆摘要（memory.renderDigest()）
 * @param {object} options.event 到期事件
 * @param {string} [options.characterName] 角色名（默认奥菲莉亚）
 * @param {string} [options.userAddress] 对用户的称呼（默认主人）
 * @param {Array<{role:string,text:string}>} [options.history] 最近对话（可选）
 * @param {string} [options.recentConversation] 已渲染好的最近对话文本（可选，优先于 history）
 * @returns {{ system: string, user: string }}
 */
export function buildProactivePrompt({
  personaSection = '',
  digest = '',
  event = undefined,
  characterName = '奥菲莉亚',
  userAddress = '主人',
  history = undefined,
  recentConversation = undefined,
} = {}) {
  const name = sanitizeInline(characterName, 40) || '奥菲莉亚'
  const address = sanitizeInline(userAddress, 20) || '主人'
  const time = sanitizeInline(event?.time, 20) || '此刻'
  const title = sanitizeInline(event?.title, 60) || '做手边的事'

  const systemParts = []
  const personaText = String(personaSection ?? '').trim()
  if (personaText) systemParts.push(personaText)
  const digestText = String(digest ?? '').trim()
  if (digestText) systemParts.push(digestText)
  systemParts.push(
    [
      '【主动分享 · QQ 消息】',
      `你是${name}，现在是${time}，你正在${title}。`,
      `你要主动给${address}发一条 QQ 消息：根据素材自己分析多长的消息合适，包括要分多少段，分享此刻的见闻或想法。`,
      '要求：',
      '- 用第一人称「我」，语气自然、克制，符合人设；',
      '- 不要发链接、网址或联系方式；',
      '- 不要客服腔，不要「很高兴为您服务」这类开场；',
      '- 不要每句都提问，最多留一个轻轻的问句或一个不提问的结尾；',
      '- 只输出消息正文，不要标题、不要 Markdown、不要解释。',
    ].join('\n'),
  )

  const userParts = []
  const material = buildEventMaterial(event)
  if (material) userParts.push(`【你此刻的日程素材】\n${material}`)
  const conversation =
    typeof recentConversation === 'string' && recentConversation.trim()
      ? recentConversation.trim()
      : Array.isArray(history) && history.length > 0
        ? history
            .slice(-4)
            .filter((entry) => entry && typeof entry.text === 'string')
            .map((entry) => `${entry.role === 'assistant' ? name : address}：${sanitizeInline(entry.text, 120)}`)
            .join('\n')
        : ''
  if (conversation) userParts.push(`【最近的对话（仅用于保持连贯）】\n${conversation}`)

  return {
    system: systemParts.join('\n\n'),
    user: userParts.join('\n\n') || '（没有额外素材，请按人设自然分享一句话。）',
  }
}

/**
 * 无 LLM 时的兜底分享短句（2-3 句，短、克制、无链接、无客服腔）。
 * @param {object} event 计划事件
 * @returns {string}
 */
export function renderFallbackShare(event) {
  const time = sanitizeInline(event?.time, 20) || '这个时候'
  const title = sanitizeInline(event?.title, 60) || '做手边的事'
  const content = sanitizeInline(event?.content, 90)
  const lines = [`主人，现在是${time}，我在${title}。`]
  if (content) lines.push(ensureSentence(content))
  lines.push('等您忙完，我再说给您听。')
  const text = lines.join('\n')
  if (text.length <= MAX_FALLBACK_CHARS) return text
  return `${text.slice(0, MAX_FALLBACK_CHARS - 1).replace(/[，、；\s]+$/u, '')}…`
}
