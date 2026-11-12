#!/usr/bin/env node
/**
 * 功能3：把角色人设里的「个人经历」按事件发生时间导入记忆区。
 *
 * 背景：
 * - 人设文件 `<characters-dir>/<character-id>/persona/persona.json` 中，
 *   `modules[id=personal_history].content`（兼容对象/数组两种 modules 写法）与
 *   顶层 `personalHistory.entries[0].content` 是同一大段「个人经历」正文，
 *   分节为：【速览】【童年：抄录院】【薇拉】【闭馆之夜】【成为记录官】【与主人的前缘】【心结与成长】【细节】。
 * - 记忆引擎（companion-bundle/lib/memory）支持可选的 `occurredAt`（事件发生时间）
 *   与 `seedMemories(items)` 批量导入方法；本脚本负责把正文分节摘录 + 具体细节
 *   组织成带时间线的记忆条目，写入 `<character-id>/memory/`。
 *
 * 时间线假设（可编辑）：
 * - 人设正文只明确写了「入馆/生日 11 月 7 日」「十九岁」等少量时间线索，
 *   下表其余日期是按剧情先后与当前时间（2026 年 11 月）推断的合理假设，
 *   用于让记忆按「发生时间」分布到短期记忆 / 第一~七层；若人设更新，可直接改表。
 * - 所有时间均为 +08:00 偏移的本地时区 ISO 8601；层级由引擎按 occurredAt 距今估算
 *   （<=1 天短期记忆、<=7 天第一层 …… >140 天第七层）。
 * - 重要度：闭馆之夜 / 知情未报 / 主人担责 / 心结与成长 为 80~95，其余日常 40~60。
 *
 * 用法（默认 dry-run，不写任何文件！）：
 *   node scripts/seed-persona-memories.mjs                    # 预览（默认 dry-run）
 *   node scripts/seed-persona-memories.mjs --dry-run          # 同上，显式预览
 *   node scripts/seed-persona-memories.mjs --write            # 真正导入记忆区
 *   node scripts/seed-persona-memories.mjs --write --force    # 覆盖同 id 旧条目后重导
 *   node scripts/seed-persona-memories.mjs --character-id ophelia \
 *     --characters-dir <DSH_PET_DATA_DIR>/characters --write
 *
 * 默认角色根目录：仓库自带 companion-data/characters（可用 --characters-dir 覆盖，
 * 通常与 DSH_PET_DATA_DIR 指向的数据目录保持一致）。
 *
 * 特点：id 稳定（seed-<character-id>-001…），可重复执行幂等（同 id / 同内容自动跳过）。
 * 仅依赖 node:* 内置模块与包内相对导入，不安装任何 npm 依赖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryEngine } from '../companion-bundle/lib/memory/engine.js'
import { clamp, estimateLayerByOccurredAt } from '../companion-bundle/lib/memory/model.js'
import { MEMORY_CATEGORIES } from '../companion-bundle/lib/memory/constants.js'
import {
  buildSummary,
  normalizeForDedup,
  normalizeKeywordList,
  resolveCategory,
} from '../companion-bundle/lib/memory/text.js'
import { readJsonSync, writeJsonSync } from '../companion-bundle/lib/shared/fsutil.js'
import { isValidCharacterId } from '../companion-bundle/lib/shared/paths.js'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

/** 默认角色 id（当前角色：奥菲莉亚）。 */
export const DEFAULT_CHARACTER_ID = 'ophelia'

/** 默认数据目录：与 companion-bundle 保持一致（可用 DSH_PET_DATA_DIR 覆盖）。 */
export const DEFAULT_DATA_DIR =
  process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')

/** 默认角色根目录：<DSH_PET_DATA_DIR>/characters。 */
export const DEFAULT_CHARACTERS_DIR = path.join(DEFAULT_DATA_DIR, 'characters')

/** 导入记忆的默认 source 标记。 */
export const PERSONA_HISTORY_SOURCE = 'persona-history'

/**
 * 可编辑的时间线表（按人设剧情推断；日期假设见文件头注释）。
 *
 * 每条字段：
 * - key/title：稳定标识与中文标题（仅用于预览输出）；
 * - occurredAt：事件发生时间（ISO 8601，带 +08:00）；
 * - section + hint：从「个人经历」正文对应分节里摘录包含 hint 的那一句（分节摘录）；
 * - detail：从正文【细节】小节里按「名字：内容」摘录该条目（与 section 二选一）；
 * - note：补充细节（不整段复制正文，只补一句具体记忆）；
 * - keywords：3~5 个中文关键词；category：记忆分类枚举；importance：重要度 1~100。
 */
export const PERSONA_HISTORY_TIMELINE = Object.freeze([
  {
    key: 'birth',
    title: '入馆日与生日',
    occurredAt: '2006-11-07T09:00:00+08:00',
    section: '速览',
    hint: '把入馆那天——11 月 7 日——当作生日',
    note: '她没有姓，襁褓里只有一张被雨打湿、名字一栏空着的借阅卡；「奥菲莉亚」是院长随手翻开一页剧本时看见的名字。',
    keywords: ['生日', '入馆日', '借阅卡', '名字'],
    category: '身份',
    importance: 60,
  },
  {
    key: 'academy-childhood',
    title: '童年：抄录院',
    occurredAt: '2012-09-01T09:00:00+08:00',
    section: '童年：抄录院',
    hint: '她最早的记忆，是抄录院窗台上的灰',
    note: '在抄录院，她是「模板式」的优等生：第一个举手，第一个交卷，能把馆规从头背到尾。',
    keywords: ['抄录院', '童年', '馆规', '纸页'],
    category: '身份',
    importance: 50,
  },
  {
    key: 'clipping-book',
    title: '剪报本',
    occurredAt: '2014-05-20T15:00:00+08:00',
    detail: '剪报本',
    note: '她把旧报纸上的桥、海、火车与别人家的窗剪下来夹进本子，只给日落留了一页空白。',
    keywords: ['剪报本', '旧报纸', '日落', '窗'],
    category: '喜好',
    importance: 48,
  },
  {
    key: 'vera-transfer',
    title: '薇拉转学',
    occurredAt: '2022-09-01T09:00:00+08:00',
    section: '薇拉',
    hint: '转学生薇拉是她的同桌',
    note: '薇拉上课睡觉，把禁书藏在裙撑里，还问「如果一个人的名字被擦掉，他还算存在过吗？」',
    keywords: ['薇拉', '转学生', '同桌', '禁书'],
    category: '人际',
    importance: 58,
  },
  {
    key: 'hide-inspection',
    title: '替薇拉瞒过检查',
    occurredAt: '2023-03-15T14:00:00+08:00',
    section: '薇拉',
    hint: '奥菲莉亚替她瞒过三次检查',
    note: '三次之后，她把「问问题」这件事藏在了心里；几年后十九岁那声「为什么」，最早就是从这里来的。',
    keywords: ['薇拉', '检查', '规则', '怀疑'],
    category: '人际',
    importance: 60,
  },
  {
    key: 'sunset-promise',
    title: '约定去看日落',
    occurredAt: '2023-06-10T17:30:00+08:00',
    section: '薇拉',
    hint: '她们约好，等薇拉找到西塔的钥匙',
    note: '奥菲莉亚没有答应，也没有拒绝；这个没有说出口的约定，她一直记得。',
    keywords: ['约定', '日落', '西塔', '钥匙'],
    category: '承诺',
    importance: 55,
  },
  {
    key: 'closing-night',
    title: '闭馆之夜',
    occurredAt: '2023-12-31T22:30:00+08:00',
    section: '闭馆之夜',
    hint: '她听见走廊尽头的脚步',
    note: '那晚她值班，手里有钥匙；她没有拦，也没有登记。此后每年闭馆夜，她都会检查档案页脚上那两个字还在不在。',
    keywords: ['闭馆夜', '薇拉', '钥匙', '登记簿'],
    category: '事件',
    importance: 92,
  },
  {
    key: 'name-vanished',
    title: '薇拉的名字消失 / 知情未报',
    occurredAt: '2024-01-01T08:00:00+08:00',
    section: '闭馆之夜',
    hint: '薇拉的名字从抄录院名册上消失了',
    note: '官方记录写「擅自离馆，去向不明」；她的档案里多了一行「知情未报」，那是她一生最不完整的一次记录。',
    keywords: ['薇拉', '名字', '知情未报', '名册'],
    category: '事件',
    importance: 95,
  },
  {
    key: 'ask-why',
    title: '十九岁第一次问为什么',
    occurredAt: '2025-11-07T09:00:00+08:00',
    section: '速览',
    hint: '却直到十九岁才第一次问「为什么」',
    note: '那天是她十九岁生日；问题没有立刻得到答案，但她从此不再把规矩当作答案。',
    keywords: ['十九岁', '生日', '为什么', '规则'],
    category: '事件',
    importance: 60,
  },
  {
    key: 'recordkeeper',
    title: '成为记录官',
    occurredAt: '2026-01-15T09:00:00+08:00',
    section: '成为记录官',
    hint: '她留在第七阅览室，从抄录员做到记录官',
    note: '她开始偷偷为「没有资格入档」的名字做旁注：借阅卡背面的铅笔字、旧书里夹着的车票、没有寄出的信。',
    keywords: ['记录官', '第七阅览室', '旁注', '档案'],
    category: '工作学习',
    importance: 55,
  },
  {
    key: 'master-first-visit',
    title: '主人第一次来馆 / 闭架库',
    occurredAt: '2026-05-20T14:00:00+08:00',
    section: '与主人的前缘',
    hint: '主人第一次来馆里时',
    note: '为了那个「不在索引里的名字」，她第一次破例带人进了闭架库；最后在一本旧杂志的装订线里找到了那行字。',
    keywords: ['主人', '闭架库', '索引', '旧杂志'],
    category: '人际',
    importance: 60,
  },
  {
    key: 'review-accountability',
    title: '审查会主人担责',
    occurredAt: '2026-05-25T10:00:00+08:00',
    section: '与主人的前缘',
    hint: '主人替她担下了责任',
    note: '她因此没有被处分；主人只说「你没有做错。下次先告诉我」。馆长的批注只有一句：「你终于开始问了。」',
    keywords: ['主人', '审查会', '责任', '闭架库'],
    category: '人际',
    importance: 88,
  },
  {
    key: 'vera-postcard',
    title: '薇拉的旧明信片',
    occurredAt: '2026-07-01T11:00:00+08:00',
    section: '与主人的前缘',
    hint: '一张从南方港口寄出的旧明信片',
    note: '她把它夹在档案页里，没有问主人是怎么找到的——那是主人给她的第一份「不能忘的恩情」。',
    keywords: ['薇拉', '明信片', '线索', '南方港口'],
    category: '人际',
    importance: 58,
  },
  {
    key: 'heart-knot-growth',
    title: '心结与成长',
    occurredAt: '2026-10-20T20:00:00+08:00',
    section: '心结与成长',
    hint: '她不知道薇拉是否真的看到了日落',
    note: '她怕自己把「不拦」误认成「善良」，更怕习惯用「记录完整」来原谅自己；她正在学着认真看眼前的人。',
    keywords: ['心结', '薇拉', '善良', '成长'],
    category: '情绪',
    importance: 88,
  },
  {
    key: 'birthday-this-year',
    title: '生日（今年）',
    occurredAt: '2026-11-07T09:00:00+08:00',
    detail: '生日',
    note: '入馆那天就是她的生日；今年她想在闭馆前把第七阅览室的灯留久一点，等主人来。',
    keywords: ['生日', '十一月', '入馆日', '灯'],
    category: '身份',
    importance: 50,
  },
  {
    key: 'detail-old-pen',
    title: '细节：旧钢笔',
    occurredAt: '2023-09-01T15:00:00+08:00',
    detail: '旧钢笔',
    note: '每次提笔抄录前，她都会先摸一下那道裂痕；钢笔再旧，她也一直带在身边。',
    keywords: ['旧钢笔', '裂痕', '薇拉', '抄录'],
    category: '事件',
    importance: 52,
  },
  {
    key: 'detail-archive-footer',
    title: '细节：档案页脚',
    occurredAt: '2024-01-02T09:00:00+08:00',
    detail: '档案页脚',
    note: '那是她自己给自己做的「归档」；她说这样至少能把一个名字留在纸上。',
    keywords: ['档案页脚', '薇拉', '名字', '闭馆夜'],
    category: '人际',
    importance: 55,
  },
  {
    key: 'detail-archive-header',
    title: '细节：档案页首',
    occurredAt: '2026-05-26T09:00:00+08:00',
    detail: '档案页首',
    note: '她每隔一段时间就会重读那行小字，确认自己没有越过它。',
    keywords: ['档案页首', '边界', '主人', '规则'],
    category: '承诺',
    importance: 55,
  },
  {
    key: 'detail-catchphrase',
    title: '细节：口头禅',
    occurredAt: '2021-09-01T09:00:00+08:00',
    detail: '口头禅',
    note: '查引文、报时间、交东西之前，她都会先核一遍；被主人问起时，她说这样比较安心。',
    keywords: ['口头禅', '核对', '习惯', '记录官'],
    category: '其他',
    importance: 45,
  },
  {
    key: 'detail-taboo',
    title: '细节：禁忌',
    occurredAt: '2024-01-05T09:00:00+08:00',
    detail: '禁忌',
    note: '她说名字念错一次就可能再也找不回来；所以宁可慢一点，也要再确认一遍。',
    keywords: ['禁忌', '名字', '归档', '薇拉'],
    category: '情绪',
    importance: 58,
  },
])

const SECTION_HEADING_PATTERN = /【([^】\n]{1,24})】/gu

/**
 * 把「个人经历」正文按【分节标题】解析为 { 分节名: 正文 }。
 * @param {string} historyText 个人经历正文
 * @returns {Record<string, string>}
 */
export function parseHistorySections(historyText) {
  const text = String(historyText ?? '')
  const sections = {}
  if (!text) return sections
  const matches = [...text.matchAll(SECTION_HEADING_PATTERN)]
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index][1].trim()
    const start = matches[index].index + matches[index][0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length
    sections[name] = text.slice(start, end).trim()
  }
  return sections
}

/** 按中文句末标点切句（保留标点）。 */
function splitSentences(text) {
  return (String(text ?? '').match(/[^。！？\n]+[。！？]?/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/**
 * 从分节正文里摘录「包含 hint 的那一句」（分节摘录，不整段复制）。
 * 切句时若刚好落在中文引号的问句后，句首可能残留一个「」」，这里顺手清掉。
 * @returns {string} 未找到时返回空串
 */
export function findSectionExcerpt(sectionText, hint) {
  const needle = String(hint ?? '').trim()
  if (!needle) return ''
  const sentence = splitSentences(sectionText).find((item) => item.includes(needle)) ?? ''
  return sentence.replace(/^[」”’]+/u, '').trim()
}

/**
 * 从正文【细节】小节里摘录「名字：内容」那一条。
 * @returns {string} 未找到时返回空串
 */
export function findDetailBullet(historyText, detailName) {
  const name = String(detailName ?? '').trim()
  if (!name) return ''
  const detailText = parseHistorySections(historyText)['细节'] ?? ''
  for (const rawLine of detailText.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('-') && !line.startsWith('•')) continue
    const body = line.replace(/^[-•\s]+/u, '').trim()
    if (body.startsWith(`${name}：`) || body.startsWith(`${name}:`)) return body
  }
  return ''
}

/**
 * 从人设对象中取出「个人经历」正文：
 * 优先 modules[id=personal_history]（兼容数组 / 对象两种 modules 写法），
 * 再退回顶层 personalHistory.entries[0].content。
 * @param {object} persona 人设对象（persona.json 解析结果）
 * @returns {string}
 */
export function collectPersonaHistoryContent(persona) {
  if (!persona || typeof persona !== 'object') return ''
  const modules = persona.modules
  let content = ''
  if (Array.isArray(modules)) {
    const found = modules.find(
      (module) => module && (module.id === 'personal_history' || module.id === 'backstory'),
    )
    if (found && typeof found.content === 'string') content = found.content
  } else if (modules && typeof modules === 'object') {
    for (const key of ['personal_history', 'backstory']) {
      const entry = modules[key]
      if (entry && typeof entry.content === 'string' && entry.content.trim()) {
        content = entry.content
        break
      }
    }
  }
  if (!content.trim()) {
    const entries =
      persona.personalHistory && Array.isArray(persona.personalHistory.entries)
        ? persona.personalHistory.entries
        : []
    const first = entries.find((entry) => entry && typeof entry.content === 'string' && entry.content.trim())
    if (first) content = first.content
  }
  return content.trim()
}

/** 读取人设 JSON 文件；文件不存在时抛出清晰的中文错误。 */
export function loadPersonaFile(personaFile) {
  const filePath = path.resolve(String(personaFile ?? ''))
  if (!fs.existsSync(filePath)) {
    throw new Error(`人设文件不存在：${filePath}。请确认 --character-id 与 --characters-dir 是否正确。`)
  }
  return readJsonSync(filePath)
}

/**
 * 由人设对象构建待导入的记忆条目（纯函数，不写任何文件；dry-run 测试可直接调用）。
 *
 * @param {{ persona: object, characterId?: string, nowMs?: number, timeline?: ReadonlyArray<object> }} options
 * @returns {{
 *   characterId: string,
 *   historyText: string,
 *   sections: Record<string, string>,
 *   items: object[],
 *   warnings: string[]
 * }}
 */
export function buildSeedItems({
  persona,
  characterId = DEFAULT_CHARACTER_ID,
  nowMs = Date.now(),
  timeline = PERSONA_HISTORY_TIMELINE,
} = {}) {
  const historyText = collectPersonaHistoryContent(persona)
  if (!historyText) {
    throw new Error(
      '人设文件中没有个人经历正文（personal_history 模块为空），无法导入；请先补充「个人经历」正文后重试。',
    )
  }
  const sections = parseHistorySections(historyText)
  const warnings = []
  const items = []
  const rows = Array.isArray(timeline) ? timeline : []

  rows.forEach((row, index) => {
    const order = index + 1
    const occurredAt = String(row.occurredAt ?? '').trim()
    if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) {
      throw new Error(`时间线第 ${order} 条的 occurredAt 不是合法时间：${String(row.occurredAt)}`)
    }
    const title = String(row.title ?? row.key ?? `第 ${order} 条`)
    let content = ''
    if (row.detail) {
      const bullet = findDetailBullet(historyText, row.detail)
      if (!bullet) {
        warnings.push(`时间线第 ${order} 条（${title}）：正文【细节】中未找到「${row.detail}」，仅使用补充说明。`)
      }
      content = `【细节·${row.detail}】${bullet || `${row.detail}：`}${row.note ? ` ${row.note}` : ''}`.trim()
    } else {
      const sectionText = sections[row.section] ?? ''
      if (!sectionText) {
        warnings.push(`时间线第 ${order} 条（${title}）：正文中未找到分节【${row.section}】。`)
      }
      const excerpt = row.hint ? findSectionExcerpt(sectionText, row.hint) : ''
      if (row.hint && !excerpt) {
        warnings.push(`时间线第 ${order} 条（${title}）：分节【${row.section}】中未找到摘录线索「${row.hint}」。`)
      }
      content = `【${row.section}】${excerpt}${row.note ? ` ${row.note}` : ''}`.trim()
    }
    if (!content) throw new Error(`时间线第 ${order} 条生成的内容为空，请检查时间线表。`)

    if (row.category && !MEMORY_CATEGORIES.includes(row.category)) {
      warnings.push(`时间线第 ${order} 条（${title}）：分类「${row.category}」不在枚举内，已按正文自动判定。`)
    }
    const category = resolveCategory(row.category, content)
    const keywords = normalizeKeywordList(row.keywords, content, category)
    const importance = clamp(Math.round(Number(row.importance) || 50), 1, 100)
    const layer = estimateLayerByOccurredAt(occurredAt, nowMs)
    items.push({
      id: `seed-${characterId}-${String(order).padStart(3, '0')}`,
      content,
      summary: buildSummary(content),
      keywords,
      category,
      importance,
      layer,
      occurredAt,
      firstSeenAt: occurredAt,
      lastMentionedAt: occurredAt,
      source: PERSONA_HISTORY_SOURCE,
      title,
    })
  })

  return { characterId, historyText, sections, items, warnings }
}

/** 由人设文件路径构建待导入条目（只读取人设文件，不写记忆数据）。 */
export function buildSeedItemsFromFile({
  personaFile,
  characterId = DEFAULT_CHARACTER_ID,
  nowMs = Date.now(),
} = {}) {
  const persona = loadPersonaFile(personaFile)
  return buildSeedItems({ persona, characterId, nowMs })
}

/** 解析角色路径（不创建目录、不写文件）。 */
export function resolveCharacterPaths({
  characterId = DEFAULT_CHARACTER_ID,
  charactersDir = DEFAULT_CHARACTERS_DIR,
} = {}) {
  const id = String(characterId ?? '').trim()
  if (!isValidCharacterId(id)) {
    throw new Error(
      `角色 id 非法：「${id}」。规则：小写字母开头，仅小写字母/数字/下划线/连字符，最长 32 个字符。`,
    )
  }
  const root = path.resolve(String(charactersDir || DEFAULT_CHARACTERS_DIR))
  const dataDir = path.join(root, id)
  return {
    charactersDir: root,
    characterId: id,
    dataDir,
    personaFile: path.join(dataDir, 'persona', 'persona.json'),
    memoryDir: path.join(dataDir, 'memory'),
    overviewFile: path.join(dataDir, 'memory', '记忆总览.md'),
    pendingSeedFile: path.join(dataDir, 'memory', 'pending-seed.json'),
  }
}

/** 只读读取记忆目录里现有的条目（供 dry-run 预估 创建/覆盖/跳过）。 */
export function readExistingMemoryItems(dataDir) {
  const memoryDir = path.join(path.resolve(String(dataDir ?? '')), 'memory')
  const items = []
  const shortDoc = readJsonSync(path.join(memoryDir, 'short-term.json'), null)
  if (shortDoc && Array.isArray(shortDoc.items)) items.push(...shortDoc.items)
  for (let layer = 1; layer <= 7; layer += 1) {
    const doc = readJsonSync(path.join(memoryDir, 'long-term', `layer-${layer}.json`), null)
    if (doc && Array.isArray(doc.items)) items.push(...doc.items)
  }
  return items
}

/** 层的中文显示。 */
function layerText(layer) {
  return layer === 'short' ? '短期记忆' : `第${Number(layer)}层`
}

/** 解析命令行参数。默认 dry-run；真正写入需要 --write / --apply。 */
export function parseArgs(argv = []) {
  const options = {
    characterId: DEFAULT_CHARACTER_ID,
    charactersDir: DEFAULT_CHARACTERS_DIR,
    dryRun: true,
    force: false,
    help: false,
  }
  const args = Array.isArray(argv) ? argv : []
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? '')
    if (arg === '--character-id' || arg === '--characters-dir') {
      const value = args[index + 1]
      if (value === undefined || String(value).startsWith('--')) {
        throw new Error(`参数 ${arg} 缺少取值。`)
      }
      if (arg === '--character-id') options.characterId = String(value).trim()
      else options.charactersDir = path.resolve(String(value))
      index += 1
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--write' || arg === '--apply') {
      options.dryRun = false
    } else if (arg === '--force') {
      options.force = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数：${arg}（用 --help 查看用法）`)
    }
  }
  return options
}

/** 命令行用法说明。 */
export const USAGE = `用法：node scripts/seed-persona-memories.mjs [选项]

功能：把角色人设的「个人经历」按事件发生时间导入记忆区（功能3）。

选项：
  --character-id <id>     角色 id（默认 ophelia）
  --characters-dir <dir>  角色根目录（默认 $DSH_PET_DATA_DIR/characters，即 ~/.dsh/dsh-pet/companion-data/characters）
  --dry-run               只预览将写入的条目，不写任何文件（默认行为）
  --write, --apply        真正写入记忆目录（把个人经历导入记忆区）
  --force                 覆盖同 id 的旧条目（内容/重要度/层级会被更新）
  --help, -h              显示本帮助

示例：
  node scripts/seed-persona-memories.mjs                    # 预览（dry-run，默认）
  node scripts/seed-persona-memories.mjs --write            # 真正导入记忆区
  node scripts/seed-persona-memories.mjs --write --force    # 覆盖旧条目后重导
`

/**
 * 执行导入流程（可被测试以临时 characters-dir 调用）。
 * 默认 dryRun=true，只读不写。
 *
 * @param {{ characterId?: string, charactersDir?: string, dryRun?: boolean,
 *   force?: boolean, nowMs?: number, log?: (line: string) => void }} [options]
 * @returns {object} 预览或导入结果
 */
export function runSeed({
  characterId = DEFAULT_CHARACTER_ID,
  charactersDir = DEFAULT_CHARACTERS_DIR,
  dryRun = true,
  force = false,
  nowMs = Date.now(),
  log = console.log,
} = {}) {
  const paths = resolveCharacterPaths({ characterId, charactersDir })
  log(`角色：${paths.characterId}`)
  log(`人设文件：${paths.personaFile}`)
  log(`记忆目录：${paths.memoryDir}`)
  log('')
  const { items, warnings } = buildSeedItemsFromFile({
    personaFile: paths.personaFile,
    characterId: paths.characterId,
    nowMs,
  })
  for (const warning of warnings) log(`注意：${warning}`)
  log(`已从人设「个人经历」构建 ${items.length} 条记忆（按发生时间估算层级）：`)

  if (dryRun) {
    // dry-run 完全只读：只读取现有记忆文件预估 创建/覆盖/跳过，绝不调用引擎（引擎会写文件）。
    const existing = readExistingMemoryItems(paths.dataDir)
    const existingIds = new Set(existing.map((item) => item.id))
    const existingContents = new Set(existing.map((item) => normalizeForDedup(item.content)))
    let createCount = 0
    let replaceCount = 0
    let skipCount = 0
    const planned = items.map((item) => {
      let action = '创建'
      if (existingIds.has(item.id)) {
        if (force) {
          action = '覆盖'
          replaceCount += 1
        } else {
          action = '跳过'
          skipCount += 1
        }
      } else if (existingContents.has(normalizeForDedup(item.content))) {
        action = '跳过'
        skipCount += 1
      } else {
        createCount += 1
      }
      log(
        `  [${action}] ${item.id} ${layerText(item.layer)} ${item.occurredAt} ` +
          `重要度${item.importance} ${item.category}｜${item.summary}`,
      )
      return { ...item, action }
    })
    log('')
    log(
      `DRY-RUN：计划处理 ${items.length} 条（新增 ${createCount}、覆盖 ${replaceCount}、跳过 ${skipCount}）；` +
        '未写入任何文件。',
    )
    log('如需真正导入记忆区，请追加 --write。')
    return {
      dryRun: true,
      characterId: paths.characterId,
      dataDir: paths.dataDir,
      planned: planned.length,
      created: createCount,
      replaced: replaceCount,
      skipped: skipCount,
      items: planned,
      warnings,
    }
  }

  // 真正写入：交给记忆引擎的 seedMemories（幂等、会处理短期容量溢出与持久化）。
  const engine = new MemoryEngine({ dataDir: paths.dataDir })
  const result = engine.seedMemories(items, { force })
  const status = engine.status()
  // 最后再写 pending-seed：若 Harness 正在运行、其记忆引擎是常驻单例，下次消息/插件重载会自动吸收，
  // 避免旧内存态在下一次持久化时覆盖刚导入的个人经历。
  // 注意：必须在本次脚本引擎的所有 status/ensure 调用之后写，否则会被本进程自己消费掉。
  let pendingWritten = false
  if (items.length > 0) {
    try {
      writeJsonSync(paths.pendingSeedFile, {
        schemaVersion: 1,
        source: 'persona-history',
        updatedAt: new Date().toISOString(),
        items,
      })
      pendingWritten = true
    } catch (error) {
      log(`警告：写入 pending-seed 失败（常驻 Harness 可能需要重启后重新导入）：${error?.message ?? error}`)
    }
  }
  log('')
  log(`导入完成：created=${result.created}，skipped=${result.skipped}`)
  for (const skippedItem of result.skippedItems) {
    log(`  跳过：${skippedItem.id ?? '(无 id)'} —— ${skippedItem.reason}`)
  }
  log(
    `当前记忆库：共 ${status.total} 条（短期 ${status.counts.short} 条；` +
      status.counts.layers.map((count, index) => `第${index + 1}层 ${count} 条`).join('；') +
      '）',
  )
  log(`记忆总览：${paths.overviewFile}`)
  return {
    dryRun: false,
    characterId: paths.characterId,
    dataDir: paths.dataDir,
    ...result,
    pendingWritten,
    warnings,
    status,
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(USAGE)
      return
    }
    runSeed(options)
  } catch (error) {
    console.error(`错误：${error && error.message ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const isDirectInvocation = invokedPath !== '' && invokedPath === fileURLToPath(import.meta.url)
if (isDirectInvocation) main()
