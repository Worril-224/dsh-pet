/**
 * 人设系统（persona）：9 个模块（8 个参考图模块 + 1 个「个人经历」扩展模块）。
 *
 * - always 模块正文每次对话都注入 system prompt；
 * - on_demand 模块正文不注入，只在 system prompt 中给出索引提示，由 persona_lookup 工具按需读取；
 * - 默认数据文件 data/persona.default.json 首次运行时复制到 <dataDir>/persona/persona.json，
 *   用户可以直接用中文编辑该文件，保存后调用 reload() 生效。
 *
 * 本模块只依赖 node:* 内置模块与包内相对导入（bundle 不能解析 DSH 私有包），
 * 所有 API 均为同步方法（文件很小，便于 prompt 同步渲染）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSystemClock, formatLocalIso } from '../shared/clock.js'
import { copyFileIfMissingSync, ensureDirSync, existsSync, readJsonSync } from '../shared/fsutil.js'
import { resolveCompanionPaths } from '../shared/paths.js'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** bundle 内置的默认人设文件（lib/persona → companion-bundle/data/persona.default.json）。 */
export const DEFAULT_PERSONA_FILE = path.resolve(MODULE_DIR, '../../data/persona.default.json')

/** 人设数据格式版本（对应 SPEC 3.2）。 */
export const PERSONA_SCHEMA_VERSION = 1

/**
 * 9 个模块的固定顺序、中文名与生效方式（必须与 SPEC 3.1 完全一致）。
 * @type {ReadonlyArray<{ id: string, label: string, activation: 'always'|'on_demand' }>}
 */
export const PERSONA_MODULES = Object.freeze([
  { id: 'role_definition', label: '角色定义', activation: 'always' },
  { id: 'speech_style', label: '说话风格', activation: 'always' },
  { id: 'herself', label: '她自己', activation: 'on_demand' },
  { id: 'memory_and_promises', label: '记忆和承诺', activation: 'always' },
  { id: 'rules', label: '规则', activation: 'always' },
  { id: 'appearance', label: '外貌', activation: 'on_demand' },
  { id: 'other_ai_characters', label: '其他 AI 角色', activation: 'on_demand' },
  { id: 'identity', label: '身份设定', activation: 'on_demand' },
  { id: 'personal_history', label: '个人经历', activation: 'on_demand' },
])

const ACTIVATIONS = new Set(['always', 'on_demand'])
const CHINESE_PATTERN = /[\u4e00-\u9fff]/

/**
 * on_demand 模块的话题提示：只是「索引」，不能包含模块正文。
 * renderPersonaSection() 用它告诉模型什么时候该调用 persona_lookup。
 */
const ON_DEMAND_TOPICS = Object.freeze({
  herself: '喜好、口味、追的番、玩的游戏、小毛病和发生过的小事',
  appearance: '发色、眼睛、服装等外貌细节',
  other_ai_characters: '她认识的同僚：白鸦、墨丘、纸鸢和她们的样貌',
  identity: '她是谁、从哪里来、与主人之间的契约',
  personal_history: '她自己的成长经历和你们之间的往事',
})

/** 规则正文必须覆盖的关键词（P5；沉浸式人设不再要求 AI 身份披露）。 */
const RULES_KEYWORDS = Object.freeze([
  ['安全', '安全边界'],
  ['链接', '不发链接'],
  ['挑衅', '处理挑衅'],
])

/** 记忆和承诺正文必须覆盖的语义（P6）。 */
const MEMORY_KEYWORDS = Object.freeze([
  ['编造', '不编造没聊过的事'],
  ['承诺', '承诺约束'],
  ['做不到', '不许做不到的承诺'],
])

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 深拷贝 JSON 值（人设数据必须是可 JSON 序列化的纯对象）。 */
function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/** 取正文第一句作为模块摘要（moduleList 用），过长时截断。 */
function summarize(text, maxLength = 60) {
  const raw = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (raw === '') return ''
  const firstClause = raw.split(/[。！？；\n]/)[0].trim() || raw
  return firstClause.length > maxLength ? `${firstClause.slice(0, maxLength)}…` : firstClause
}

/** 把字符串列表渲染成「甲」「乙」形式。 */
function quoteList(list, separator = ' ') {
  if (!Array.isArray(list) || list.length === 0) return '（未配置）'
  return list.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => `「${item}」`).join(separator)
}

/**
 * 人设服务：所有人设读取、prompt 渲染与数据校验都在这里完成。
 */
export class PersonaService {
  /**
   * @param {object} options
   * @param {string} options.dataDir 陪伴数据目录（绝对路径），人设文件位于 <dataDir>/persona/persona.json
   * @param {string} [options.defaultPersonaFile] 默认人设文件；默认使用 bundle 内置的 data/persona.default.json
   * @param {{ now: () => number }} [options.clock] 时钟（测试可注入固定时钟）
   */
  constructor({ dataDir, defaultPersonaFile = DEFAULT_PERSONA_FILE, clock } = {}) {
    if (!isNonEmptyString(dataDir)) {
      throw new Error('createPersonaService 需要 dataDir：陪伴数据目录的绝对路径。')
    }
    this.dataDir = path.resolve(dataDir)
    this.defaultPersonaFile = path.resolve(defaultPersonaFile)
    this.clock = clock && typeof clock.now === 'function' ? clock : createSystemClock()

    const companionPaths = resolveCompanionPaths(this.dataDir)
    this.personaDir = companionPaths.personaDir
    this.personaFile = companionPaths.personaFile

    this._definition = null
    this._loadedAt = null
  }

  /**
   * 创建 <dataDir>/persona/persona.json（不存在时从默认文件复制）并加载。
   * 已存在的人设文件不会被覆盖（用户编辑优先）。
   * @returns {PersonaService} this（便于链式调用）
   */
  ensure() {
    ensureDirSync(this.personaDir)
    if (!existsSync(this.personaFile)) {
      if (!existsSync(this.defaultPersonaFile)) {
        throw new Error(`默认人设文件不存在：${this.defaultPersonaFile}，无法创建人设文件。`)
      }
      copyFileIfMissingSync(this.defaultPersonaFile, this.personaFile)
    }
    this.reload()
    return this
  }

  /**
   * 重新读取人设文件（用户编辑 persona.json 后调用即可生效）。
   * @returns {PersonaService} this（便于链式调用）
   */
  reload() {
    const filePath = this.getFilePath()
    if (!existsSync(filePath)) {
      throw new Error(`人设文件不存在：${filePath}。请先调用 ensure() 从默认文件创建。`)
    }
    let definition
    try {
      definition = readJsonSync(filePath)
    } catch (error) {
      throw new Error(`人设文件无法读取：${filePath}：${error.message}`)
    }
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new Error(`人设文件格式不正确：${filePath}：顶层必须为 JSON 对象。`)
    }
    this._definition = definition
    this._loadedAt = this.clock.now()
    return this
  }

  /**
   * 原始人设对象的深拷贝（调用方修改不会影响服务内部状态）。
   * 未加载时抛出可读错误。
   */
  getDefinition() {
    return cloneJson(this._requireDefinition())
  }

  /** 当前人设文件的绝对路径。 */
  getFilePath() {
    return this.personaFile
  }

  /** 最近一次成功加载的时间（本地时区 ISO 8601）；尚未加载返回 null。 */
  getLoadedAt() {
    return this._loadedAt === null ? null : formatLocalIso(this._loadedAt)
  }

  /** 模块清单：[{ id, label, activation, summary }]，顺序与数据文件一致。 */
  moduleList() {
    const definition = this._requireDefinition()
    const modules = Array.isArray(definition.modules) ? definition.modules : []
    return modules.map((module) => ({
      id: module?.id,
      label: module?.label,
      activation: module?.activation,
      summary: summarize(module?.content),
    }))
  }

  /** 全部 always 模块（深拷贝数组）。 */
  getAlwaysModules() {
    return this._modulesByActivation('always')
  }

  /** 全部 on_demand 模块（深拷贝数组）。 */
  getOnDemandModules() {
    return this._modulesByActivation('on_demand')
  }

  /**
   * 按 id 或中文名查询模块正文（persona_lookup 工具的数据源）。
   * @param {string} moduleIdOrLabel 模块 id（如 appearance）或中文名（如 外貌）
   * @returns {{ ok: true, id: string, label: string, activation: string, content: string } | { ok: false, error: string }}
   */
  lookup(moduleIdOrLabel) {
    if (!isNonEmptyString(moduleIdOrLabel)) {
      return { ok: false, error: 'persona_lookup 需要一个模块 id 或中文名称（字符串）。' }
    }
    const query = moduleIdOrLabel.trim()
    const definition = this._requireDefinition()
    const modules = Array.isArray(definition.modules) ? definition.modules : []
    const found =
      modules.find((module) => typeof module?.id === 'string' && module.id.toLowerCase() === query.toLowerCase()) ??
      modules.find((module) => typeof module?.label === 'string' && module.label.trim() === query)
    if (!found) {
      const available = PERSONA_MODULES.map((module) => `${module.label}（${module.id}）`).join('、')
      return { ok: false, error: `未找到人设模块：「${query}」。可用模块：${available}。` }
    }
    return {
      ok: true,
      id: found.id,
      label: found.label,
      activation: found.activation,
      content: found.content,
    }
  }

  /**
   * 生成注入 system prompt 的「始终生效」人设段。
   *
   * 严格满足 SPEC 3.3：
   * 1. 标题【人设 · 始终生效】与角色一句话定义；
   * 2. 4 个 always 模块正文（角色定义 / 说话风格 / 记忆和承诺 / 规则）；
   * 3. 说话风格细则（句式、长度、语气词、颜文字频率、禁用开头列表）；
   * 4. 【被问到才用的人设资料】：5 个 on_demand 模块的名称、话题提示与 persona_lookup 使用要求；
   * 5. 【个人经历】状态提示；
   * 6. 绝不包含任何 on_demand 模块正文。
   */
  renderPersonaSection() {
    const definition = this.getDefinition()
    const modules = Array.isArray(definition.modules) ? definition.modules : []
    const character = definition.character && typeof definition.character === 'object' ? definition.character : {}
    const style = definition.style && typeof definition.style === 'object' ? definition.style : {}
    const personalHistory =
      definition.personalHistory && typeof definition.personalHistory === 'object' ? definition.personalHistory : {}

    const name = isNonEmptyString(character.name) ? character.name : '铃兰'
    const userAddress = isNonEmptyString(character.userAddress) ? character.userAddress : '主人'
    const role = isNonEmptyString(character.role) ? character.role : '情感陪伴型角色助手'
    const platform = isNonEmptyString(character.platform) ? character.platform : 'DeepSeek Harness'
    const oneLiner = isNonEmptyString(character.oneLiner) ? character.oneLiner : ''
    const selfReference = isNonEmptyString(character.selfReference) ? character.selfReference : '我'

    const alwaysModules = modules.filter((module) => module?.activation === 'always')
    const onDemandModules = modules.filter((module) => module?.activation === 'on_demand')

    const lines = []
    lines.push('【人设 · 始终生效】')
    lines.push(`你是「${name}」，${userAddress}的${role}，运行在 ${platform}。`)
    lines.push(`一句话人设：${oneLiner}`)
    lines.push(`称呼对方为「${userAddress}」，自称「${selfReference}」；下面 4 个 always 模块必须始终遵守。`)

    for (const module of alwaysModules) {
      lines.push('')
      lines.push(`【${module.label}】`)
      lines.push(module.content)
    }

    lines.push('')
    lines.push('【说话风格细则】')
    lines.push(`- 句式：${isNonEmptyString(style.sentence) ? style.sentence : '（未配置）'}`)
    lines.push(`- 长度：${isNonEmptyString(style.length) ? style.length : '（未配置）'}`)
    lines.push(`- 语气词：${Array.isArray(style.toneWords) && style.toneWords.length > 0 ? style.toneWords.join('、') : '（未配置）'}`)
    lines.push(`- 颜文字频率：${isNonEmptyString(style.kaomojiFrequency) ? style.kaomojiFrequency : '（未配置）'}`)
    lines.push(`- 禁用开头（任何回复都不要用这些开头）：${quoteList(style.bannedOpeners)}`)
    lines.push(`- 禁止输出（不要生成）：${quoteList(style.forbiddenPatterns)}（即不发任何链接、网址或联系方式）`)

    lines.push('')
    lines.push('【被问到才用的人设资料】')
    lines.push('下面的资料不会自动注入。被问到时先调用 persona_lookup 工具读取对应模块正文；未查到或读取失败时就说「这个我记不清了」，不得编造、不得猜测、不得凭印象补充。')
    for (const module of onDemandModules) {
      const topic = ON_DEMAND_TOPICS[module.id] ?? '相关话题'
      lines.push(`- ${module.label}（${module.id}）：${topic}`)
    }

    lines.push('')
    lines.push('【个人经历】')
    lines.push(this._renderPersonalHistory(personalHistory))

    return lines.join('\n')
  }

  /**
   * 校验当前已加载的人设数据（SPEC 3.3）。
   * 文件被外部修改后，请先调用 reload() 再 validate()。
   * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
   */
  validate() {
    const errors = []
    const warnings = []

    if (this._definition === null) {
      try {
        this.reload()
      } catch (error) {
        errors.push(error.message)
        return { ok: false, errors, warnings }
      }
    }

    const definition = this._definition
    const meta = definition.meta && typeof definition.meta === 'object' ? definition.meta : {}
    const character = definition.character && typeof definition.character === 'object' ? definition.character : {}
    const style = definition.style && typeof definition.style === 'object' ? definition.style : null
    const modules = Array.isArray(definition.modules) ? definition.modules : null

    // ---- 基础字段 ----
    if (definition.schemaVersion !== PERSONA_SCHEMA_VERSION) {
      warnings.push(`schemaVersion 建议为 ${PERSONA_SCHEMA_VERSION}（当前：${String(definition.schemaVersion)}）。`)
    }
    for (const [field, label] of [
      ['name', '角色名'],
      ['title', '标题'],
      ['version', '版本'],
      ['editableHint', '编辑提示'],
    ]) {
      if (!isNonEmptyString(meta[field])) warnings.push(`meta.${field}（${label}）缺失或为空。`)
    }
    for (const [field, label] of [
      ['name', '角色名'],
      ['selfReference', '自称'],
      ['userAddress', '对用户的称呼'],
      ['platform', '平台'],
      ['role', '角色定位'],
    ]) {
      if (!isNonEmptyString(character[field])) warnings.push(`character.${field}（${label}）缺失或为空。`)
    }
    if (!isNonEmptyString(character.oneLiner)) {
      errors.push('character.oneLiner（一句话角色定义）必须为非空字符串。')
    }

    // ---- 模块清单：数量 / 顺序 / id / label / activation ----
    if (modules === null) {
      errors.push('modules 必须为数组。')
    } else {
      if (modules.length !== PERSONA_MODULES.length) {
        errors.push(`模块数量应为 ${PERSONA_MODULES.length} 个，实际为 ${modules.length} 个。`)
      }
      const seenIds = new Set()
      for (const module of modules) {
        if (!module || typeof module !== 'object') {
          errors.push('modules 中存在非对象项。')
          continue
        }
        if (!isNonEmptyString(module.id)) {
          errors.push('存在缺少 id 的模块。')
        } else if (seenIds.has(module.id)) {
          errors.push(`模块 id 重复：${module.id}。`)
        } else {
          seenIds.add(module.id)
        }
      }
      PERSONA_MODULES.forEach((expected, index) => {
        const found = modules.find((module) => module && module.id === expected.id)
        if (!found) {
          errors.push(`缺少模块：${expected.id}（${expected.label}）。`)
          return
        }
        const actualAt = modules[index]
        if (!actualAt || actualAt.id !== expected.id) {
          const actualId = actualAt && isNonEmptyString(actualAt.id) ? actualAt.id : '（空）'
          errors.push(`模块顺序错误：第 ${index + 1} 位应为 ${expected.id}（${expected.label}），实际为 ${actualId}。`)
        }
        if (found.label !== expected.label) {
          // 沉浸式人设允许「其他同僚」作为 other_ai_characters 的显示名（不再强调 AI 角色）
          const labelAliases =
            expected.id === 'other_ai_characters' ? ['其他 AI 角色', '其他同僚'] : [expected.label]
          if (!labelAliases.includes(found.label)) {
            errors.push(`模块 ${expected.id} 的 label 应为「${expected.label}」，实际为「${String(found.label)}」。`)
          }
        }
        if (!ACTIVATIONS.has(found.activation)) {
          errors.push(`模块 ${expected.id} 的 activation 必须为 always 或 on_demand，实际为「${String(found.activation)}」。`)
        } else if (found.activation !== expected.activation) {
          errors.push(
            `模块 ${expected.id}（${expected.label}）的生效方式应为 ${expected.activation}，实际为 ${found.activation}。`,
          )
        }
        if (!isNonEmptyString(found.content)) {
          errors.push(`模块 ${expected.id} 的 content 不能为空。`)
        } else if (!CHINESE_PATTERN.test(found.content)) {
          errors.push(`模块 ${expected.id} 的 content 必须包含中文。`)
        }
      })
      const expectedIds = new Set(PERSONA_MODULES.map((module) => module.id))
      for (const module of modules) {
        if (module && isNonEmptyString(module.id) && !expectedIds.has(module.id)) {
          warnings.push(`存在未知模块：${module.id}（不在 SPEC 3.1 的 9 个模块中）。`)
        }
      }
    }

    // ---- 说话风格 ----
    if (!style) {
      errors.push('缺少 style 对象。')
    } else {
      for (const [field, label] of [
        ['sentence', '句式要求'],
        ['length', '长度要求'],
        ['kaomojiFrequency', '颜文字频率'],
      ]) {
        if (!isNonEmptyString(style[field])) errors.push(`style.${field}（${label}）必须为非空字符串。`)
      }
      if (!Array.isArray(style.toneWords) || style.toneWords.length === 0) {
        errors.push('style.toneWords 必须为非空数组（语气词）。')
      } else if (!style.toneWords.every((word) => isNonEmptyString(word))) {
        warnings.push('style.toneWords 中存在空字符串。')
      }
      if (!Array.isArray(style.bannedOpeners) || style.bannedOpeners.length === 0) {
        errors.push('style.bannedOpeners 必须为非空数组（禁用开头列表）。')
      } else if (style.bannedOpeners.length < 3) {
        errors.push(`style.bannedOpeners 至少需要 3 个禁用开头，实际为 ${style.bannedOpeners.length} 个。`)
      }
      if (!Array.isArray(style.forbiddenPatterns) || style.forbiddenPatterns.length === 0) {
        errors.push('style.forbiddenPatterns 必须为非空数组（禁止输出的内容模式）。')
      }
    }

    // ---- 规则正文要点（P5）----
    const rulesModule = modules === null ? undefined : modules.find((module) => module && module.id === 'rules')
    if (rulesModule && isNonEmptyString(rulesModule.content)) {
      for (const [keyword, label] of RULES_KEYWORDS) {
        if (!rulesModule.content.includes(keyword)) {
          errors.push(`规则正文缺少「${label}」相关表述（应包含「${keyword}」）。`)
        }
      }
    }

    // ---- 记忆和承诺正文要点（P6）----
    const memoryModule =
      modules === null ? undefined : modules.find((module) => module && module.id === 'memory_and_promises')
    if (memoryModule && isNonEmptyString(memoryModule.content)) {
      for (const [keyword, label] of MEMORY_KEYWORDS) {
        if (!memoryModule.content.includes(keyword)) {
          errors.push(`记忆和承诺正文缺少「${label}」相关表述（应包含「${keyword}」）。`)
        }
      }
    }

    // ---- 个人经历（P8）----
    const personalHistory = definition.personalHistory
    if (!personalHistory || typeof personalHistory !== 'object' || Array.isArray(personalHistory)) {
      errors.push('personalHistory 字段缺失或格式不正确。')
    } else {
      if (!isNonEmptyString(personalHistory.status)) {
        errors.push('personalHistory.status 缺失或为空。')
      }
      if (!Array.isArray(personalHistory.entries)) {
        errors.push('personalHistory.entries 必须为数组。')
      } else if (personalHistory.status === 'ready' && personalHistory.entries.length === 0) {
        warnings.push('personalHistory.status 为 ready，但 entries 为空，建议补充至少一条个人经历。')
      }
      if (!isNonEmptyString(personalHistory.note)) {
        warnings.push('personalHistory.note 缺失或为空，建议写明个人经历的补充说明。')
      }
    }

    // ---- 示例 ----
    if (!Array.isArray(definition.examples) || definition.examples.length === 0) {
      warnings.push('examples 缺失或为空，建议提供至少一条中文对话示例。')
    }

    return { ok: errors.length === 0, errors, warnings }
  }

  /**
   * 【个人经历】状态提示：pending 时说明等主人补充；ready 时提示用 persona_lookup 读取。
   * @param {object} personalHistory
   * @returns {string}
   */
  _renderPersonalHistory(personalHistory) {
    const status = isNonEmptyString(personalHistory.status) ? personalHistory.status : 'unknown'
    let text
    if (status === 'pending_user_input') {
      text = `当前状态：等待主人补充（${status}）。主人还没有提供个人经历，不要编造主人的过去；等主人补充后，以 persona_lookup 读取到的 personal_history 正文为准。`
    } else if (status === 'ready' || status === 'completed') {
      text = `当前状态：主人已补充（${status}）。需要时先调用 persona_lookup 读取 personal_history 的正文，不要凭印象编造。`
    } else {
      text = `当前状态：${status}。需要时先调用 persona_lookup 读取 personal_history 的正文，未查到就说记不清，不得编造。`
    }
    if (isNonEmptyString(personalHistory.note)) {
      text += `\n说明：${personalHistory.note}`
    }
    return text
  }

  /** 按生效方式取模块（深拷贝数组）。 */
  _modulesByActivation(activation) {
    const definition = this._requireDefinition()
    const modules = Array.isArray(definition.modules) ? definition.modules : []
    return modules.filter((module) => module?.activation === activation).map((module) => cloneJson(module))
  }

  /** 取已加载的人设对象；未加载时抛出可读错误。 */
  _requireDefinition() {
    if (this._definition === null) {
      throw new Error('人设数据尚未加载：请先调用 ensure()（或 reload()）。')
    }
    return this._definition
  }
}

/**
 * 创建人设服务。
 * @param {object} options 见 PersonaService 构造函数
 * @returns {PersonaService}
 */
export function createPersonaService(options = {}) {
  return new PersonaService(options)
}
