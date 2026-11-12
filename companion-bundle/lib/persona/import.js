/**
 * 人设卡导入：把外部「8+1 模块人设卡 JSON」转换为本项目可用的 persona.json 定义。
 *
 * 支持两种来源：
 *  1. 人设卡格式（例如 persona-ophelia/persona.json）：
 *     { persona: {...}, modules: { role_definition, speaking_style, self,
 *       memory_and_promises, rules, appearance, other_ai, identity, backstory },
 *       identity_facts?, relationship?, assembly?, system_prompt? }
 *  2. 已经是本项目格式：{ modules: [ {id,label,activation,content}, ... ], style, ... }
 *
 * 转换规则：
 *  - 模块 id 映射：speaking_style→speech_style、self→herself、other_ai→other_ai_characters、backstory→personal_history；
 *  - activation：always 保持；lookup / on-demand / on_demand 统一为 on_demand；
 *  - style 缺失时从「说话风格」「规则」正文推导（禁用开头、语气词、长度等），并可被 options.style 覆盖；
 *  - personalHistory：backstory ready → status="ready"，entries 至少一条；否则保持 pending_user_input；
 *  - 其余人设卡字段（identity_facts / relationship / 构建信息）收进顶层 identityFacts / relationship / sourceMeta，仅作参考，不进入 system prompt。
 */
import { PERSONA_MODULES } from './index.js'

/** 来源模块 key → 本项目模块 id。 */
const SOURCE_KEY_TO_ID = {
  role_definition: 'role_definition',
  speaking_style: 'speech_style',
  speech_style: 'speech_style',
  self: 'herself',
  herself: 'herself',
  memory_and_promises: 'memory_and_promises',
  rules: 'rules',
  appearance: 'appearance',
  other_ai: 'other_ai_characters',
  other_ai_characters: 'other_ai_characters',
  identity: 'identity',
  backstory: 'personal_history',
  personal_history: 'personal_history',
}

/** 反向：本项目模块 id → 可能的人设卡 key（按优先级）。 */
const ID_TO_SOURCE_KEYS = {
  role_definition: ['role_definition'],
  speech_style: ['speaking_style', 'speech_style'],
  herself: ['self', 'herself'],
  memory_and_promises: ['memory_and_promises'],
  rules: ['rules'],
  appearance: ['appearance'],
  other_ai_characters: ['other_ai', 'other_ai_characters'],
  identity: ['identity'],
  personal_history: ['backstory', 'personal_history'],
}

const DEFAULT_STYLE = {
  sentence: '句子长短错落，先回应或给结论，再补充理由；以现代书面中文为主，克制、认真、有书卷气。',
  length: '日常闲聊 1~3 句；有信息量的问题 3~6 句；步骤、清单才用列表，通常不超过 7 条。',
  toneWords: ['呢', '吧', '了', '呀'],
  kaomojiFrequency: '默认不用颜文字与 emoji；只有用户明确要求或玩笑时，最多 1 个简单颜文字。',
  bannedOpeners: ['作为 AI 语言模型', '很高兴为您服务', '当然可以！', '没问题！', '首先、其次、最后'],
  forbiddenPatterns: ['http://', 'https://', 'www.'],
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstSentence(text) {
  const raw = String(text ?? '').replace(/\r/g, '').trim()
  if (!raw) return ''
  const match = raw.match(/^[^。！？\n]+[。！？]?/)
  return (match ? match[0] : raw).trim()
}

/** 取 content 中某个【标题】后到下一个【标题】之间的正文。 */
function extractSection(content, heading) {
  const text = String(content ?? '')
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const rest = text.slice(start + heading.length)
  const next = rest.indexOf('【')
  return (next >= 0 ? rest.slice(0, next) : rest).trim()
}

/** 提取中文引号「」中的短语。 */
function extractQuoted(text) {
  const found = []
  const regex = /「([^」]{1,40})」/g
  let match
  while ((match = regex.exec(String(text ?? ''))) !== null) {
    const value = match[1].trim()
    if (value && !found.includes(value)) found.push(value)
  }
  return found
}

/**
 * 从人设卡的「说话风格」「规则」正文推导 style 字段。
 * @param {Record<string, {content?: string}>} modulesById 来源模块（key 为来源 key）
 * @param {object} [override] 调用方显式覆盖
 */
export function deriveStyle(modulesById, override = {}) {
  const speaking =
    modulesById?.speaking_style?.content ??
    modulesById?.speech_style?.content ??
    ''
  const rules = modulesById?.rules?.content ?? ''

  const bannedSection = extractSection(speaking, '【禁用开头】')
  let bannedOpeners = extractQuoted(bannedSection)
    .map((entry) => entry.replace(/\s+/g, ' ').trim())
    .filter((entry) => entry.length >= 3 && !/^(主人|您|我|你)$/.test(entry))
  bannedOpeners = [...new Set(bannedOpeners)]
  if (bannedOpeners.length < 3) bannedOpeners = DEFAULT_STYLE.bannedOpeners

  const toneSection = extractSection(speaking, '【语气词与颜文字】') || extractSection(speaking, '【语气词】')
  const toneWords = []
  for (const fragment of toneSection.split(/[；;\n]/u)) {
    // 跳过「不用啦/嘛」「避免……」这类否定句，避免把被禁用的语气词当成允许项
    if (/不用|不使用|避免|不要|忌用|别用/u.test(fragment)) continue
    for (const quoted of extractQuoted(fragment)) {
      for (const word of quoted.split(/[、,，/\s]+/u)) {
        const trimmed = word.trim()
        if (trimmed.length >= 1 && trimmed.length <= 2 && !toneWords.includes(trimmed)) toneWords.push(trimmed)
      }
    }
  }
  const resolvedToneWords = override.toneWords ?? (toneWords.length > 0 ? toneWords.slice(0, 6) : [...DEFAULT_STYLE.toneWords])

  const lengthSection = extractSection(speaking, '【长度】')
  const length = lengthSection ? lengthSection.replace(/^[-•\s]+/gm, '').replace(/\n+/g, ' ').trim() : DEFAULT_STYLE.length

  const kaomojiSection = extractSection(speaking, '【语气词与颜文字】')
  const kaomojiLine = kaomojiSection.split('\n').find((line) => line.includes('颜文字') || line.includes('emoji'))
  const kaomojiFrequency = kaomojiLine ? kaomojiLine.replace(/^[-•\s]+/, '').trim() : DEFAULT_STYLE.kaomojiFrequency

  // 句式：优先取「说话风格」中描述句式的行
  const sentenceLine = speaking
    .split('\n')
    .map((line) => line.replace(/^[-•\s]+/, '').trim())
    .find((line) => line.includes('句子') || line.includes('句式'))
  const sentence = override.sentence ?? (sentenceLine || DEFAULT_STYLE.sentence)

  const forbiddenPatterns = [...DEFAULT_STYLE.forbiddenPatterns]
  if (rules.includes('mailto:')) forbiddenPatterns.push('mailto:')
  if (rules.includes('ftp://')) forbiddenPatterns.push('ftp://')

  return {
    sentence,
    length: override.length ?? (length || DEFAULT_STYLE.length),
    toneWords: resolvedToneWords,
    kaomojiFrequency: override.kaomojiFrequency ?? (kaomojiFrequency || DEFAULT_STYLE.kaomojiFrequency),
    bannedOpeners: override.bannedOpeners ?? bannedOpeners,
    forbiddenPatterns: override.forbiddenPatterns ?? forbiddenPatterns,
  }
}

/** 从「语气标尺」等段落提取 user/assistant 示例对。 */
function extractExamples(speakingContent) {
  const section = extractSection(speakingContent, '【语气标尺】')
  const source = section || speakingContent
  const examples = []
  const regex = /「([^」]{1,120})」\s*[→\->⇒]\s*「([^」]{1,400})」/gu
  let match
  while ((match = regex.exec(source)) !== null) {
    examples.push({ user: match[1].trim(), assistant: match[2].trim() })
    if (examples.length >= 4) break
  }
  return examples
}

/** 将人设卡来源模块整理成 key→{content,activation,status} 映射。 */
function collectSourceModules(sourceModules) {
  const byKey = {}
  if (Array.isArray(sourceModules)) {
    for (const entry of sourceModules) {
      if (!isObject(entry)) continue
      const id = SOURCE_KEY_TO_ID[entry.id] ?? entry.id
      byKey[entry.id] = entry
      if (id && !byKey[id]) byKey[id] = entry
    }
    return byKey
  }
  if (isObject(sourceModules)) {
    for (const [key, entry] of Object.entries(sourceModules)) {
      if (!isObject(entry)) continue
      byKey[key] = entry
      const mapped = SOURCE_KEY_TO_ID[key]
      if (mapped && !byKey[mapped]) byKey[mapped] = entry
    }
  }
  return byKey
}

/** 取某个本项目模块 id 的来源内容。 */
function pickSourceModule(byKey, moduleId) {
  for (const key of ID_TO_SOURCE_KEYS[moduleId] ?? [moduleId]) {
    if (byKey[key]) return byKey[key]
  }
  return undefined
}

function normalizeActivation(value) {
  if (value === 'always') return 'always'
  if (value === 'on_demand' || value === 'lookup' || value === 'on-demand') return 'on_demand'
  return undefined
}

/**
 * 导出一份人设卡为本项目 persona.json 定义。
 * @param {object} source 人设卡 JSON（支持两种格式）
 * @param {{ id?:string, name?:string, role?:string, platform?:string, oneLiner?:string,
 *   style?:object, examples?:Array<{user:string,assistant:string}>, editableHint?:string }} [options]
 * @returns {object} 本项目格式的人设定义
 */
export function importPersonaCard(source, options = {}) {
  if (!isObject(source)) throw new Error('人设卡必须是 JSON 对象。')

  // 已经是本项目格式（modules 为数组）：直接规范化后返回
  if (Array.isArray(source.modules)) {
    const definition = JSON.parse(JSON.stringify(source))
    definition.schemaVersion = 1
    if (options.id && definition.meta) definition.meta.id = options.id
    if (options.name) {
      if (!definition.meta) definition.meta = {}
      definition.meta.name = options.name
      if (definition.character) definition.character.name = options.name
    }
    if (!definition.style || !Array.isArray(definition.style.bannedOpeners)) {
      definition.style = deriveStyle({}, options.style ?? {})
    }
    if (!definition.personalHistory) {
      definition.personalHistory = { status: 'pending_user_input', entries: [], note: '个人经历待补充。' }
    }
    if (!Array.isArray(definition.examples)) definition.examples = []
    return definition
  }

  const persona = isObject(source.persona) ? source.persona : {}
  const byKey = collectSourceModules(source.modules)
  const modulesById = {}
  for (const id of Object.values(SOURCE_KEY_TO_ID)) {
    if (!modulesById[id]) modulesById[id] = pickSourceModule(byKey, id)
  }

  const modules = PERSONA_MODULES.map((expected) => {
    const found = pickSourceModule(byKey, expected.id)
    if (!found || typeof found.content !== 'string' || found.content.trim() === '') {
      throw new Error(`人设卡缺少模块或正文为空：${expected.id}（${expected.label}）`)
    }
    const activation = normalizeActivation(found.activation) ?? expected.activation
    return { id: expected.id, label: expected.label, activation, content: found.content.trim() }
  })

  const id = typeof options.id === 'string' && options.id ? options.id : String(persona.id ?? 'character')
  const name =
    typeof options.name === 'string' && options.name.trim()
      ? options.name.trim()
      : String(persona.name ?? id)
  const roleContent = pickSourceModule(byKey, 'role_definition')?.content ?? ''
  const tagline = typeof persona.tagline === 'string' ? persona.tagline.trim() : ''
  const intro = firstSentence(roleContent).replace(/^你是/, '').replace(/[。！？；\s]+$/u, '').trim()
  const oneLiner =
    options.oneLiner ??
    (tagline && intro && !intro.includes(tagline) ? `${intro}——${tagline}` : intro || tagline || `${name}，情感陪伴型 AI 角色助手。`)

  const style = { ...deriveStyle(byKey, options.style ?? {}) }
  const speakingContent = pickSourceModule(byKey, 'speech_style')?.content ?? ''
  const examplesRaw = Array.isArray(source.examples) ? source.examples : []
  const examples =
    Array.isArray(options.examples) && options.examples.length > 0
      ? options.examples
      : examplesRaw.length > 0
        ? examplesRaw.filter((entry) => isObject(entry) && entry.user && entry.assistant).map((entry) => ({ user: String(entry.user), assistant: String(entry.assistant) }))
        : extractExamples(speakingContent)

  const backstory = pickSourceModule(byKey, 'personal_history')
  const backstoryStatus = backstory?.status === 'ready' ? 'ready' : 'pending_user_input'
  const personalHistory =
    backstoryStatus === 'ready'
      ? {
          status: 'ready',
          entries: [
            {
              title: '个人经历（来自人设卡）',
              content: backstory?.content ?? '',
            },
          ],
          note: '个人经历已归档在人设卡中；完整正文见 personal_history 模块，被问到时通过 persona_lookup 读取。',
        }
      : {
          status: 'pending_user_input',
          entries: [],
          note: '个人经历待主人补充；补充后写入 personal_history 模块并更新本段状态。',
        }

  const userAddressRaw = typeof persona.user_address === 'string' ? persona.user_address : '主人'
  const userAddress = userAddressRaw.split(/[（(]/u)[0].trim() || '主人'

  return {
    schemaVersion: 1,
    meta: {
      name,
      title: typeof persona.archetype === 'string' && persona.archetype ? persona.archetype : 'AI 角色',
      version: typeof persona.version === 'string' && persona.version ? persona.version : '1.0.0',
      editableHint:
        options.editableHint ??
        `可直接编辑本文件修改「${name}」的人设；修改后重启 Harness（或在会话中调用 persona_status 查看校验结果）。`,
      source: typeof persona.source === 'string' ? persona.source : undefined,
    },
    character: {
      name,
      selfReference: '我',
      userAddress,
      platform: options.platform ?? 'DeepSeek Harness 桌面聊天（DeepSeek 平台）',
      oneLiner,
      role: options.role ?? '情感陪伴 + 轻量协作型 AI 角色助手',
    },
    modules,
    style,
    examples,
    personalHistory,
    identityFacts: isObject(source.identity_facts) ? source.identity_facts : undefined,
    relationship: isObject(source.relationship) ? source.relationship : undefined,
    sourceMeta: {
      schemaVersion: typeof source.schema_version === 'string' ? source.schema_version : undefined,
      builtAt: typeof persona.built_at === 'string' ? persona.built_at : undefined,
      builder: typeof persona.builder === 'string' ? persona.builder : undefined,
      source: typeof persona.source === 'string' ? persona.source : undefined,
    },
  }
}
