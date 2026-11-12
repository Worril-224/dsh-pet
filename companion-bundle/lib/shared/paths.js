/**
 * 共享路径工具：陪伴数据目录布局、层级中文名、层/分类常量。
 */
import path from 'node:path'
import { ensureDirSync } from './fsutil.js'

/** 长期记忆层数。 */
export const LONG_TERM_LAYERS = 7

/** 中文数字，用于层级名称。 */
const CHINESE_NUMERALS = ['一', '二', '三', '四', '五', '六', '七']

/** 层的中文名：'short' → 短期记忆；1 → 第一层。 */
export function layerLabel(layer) {
  if (layer === 'short' || layer === '短期') return '短期记忆'
  const n = Number(layer)
  const numeral = CHINESE_NUMERALS[n - 1]
  return numeral ? `第${numeral}层` : `第${layer}层`
}

/** 层的排序权重（越小越靠上/检索越优先）。 */
export function layerOrder(layer) {
  return layer === 'short' ? 0 : Number(layer)
}

/** 记忆分类枚举。 */
export const MEMORY_CATEGORIES = ['喜好', '身份', '人际', '事件', '情绪', '承诺', '计划', '健康', '工作学习', '其他']

/** 记忆层级枚举（供校验）。 */
export function isValidLayer(layer) {
  return layer === 'short' || (Number.isInteger(layer) && layer >= 1 && layer <= LONG_TERM_LAYERS)
}

/**
 * 解析陪伴数据目录布局。
 * @param {string} dataDir 数据目录（绝对路径）
 */
export function resolveCompanionPaths(dataDir) {
  const root = path.resolve(dataDir)
  const memoryDir = path.join(root, 'memory')
  const longTermDir = path.join(memoryDir, 'long-term')
  const personaDir = path.join(root, 'persona')
  return {
    root,
    memoryDir,
    longTermDir,
    personaDir,
    shortTermFile: path.join(memoryDir, 'short-term.json'),
    metaFile: path.join(memoryDir, 'meta.json'),
    indexFile: path.join(memoryDir, 'index.json'),
    overviewFile: path.join(memoryDir, '记忆总览.md'),
    eventsFile: path.join(memoryDir, 'events.jsonl'),
    pendingSeedFile: path.join(memoryDir, 'pending-seed.json'),
    layerFiles: Array.from({ length: LONG_TERM_LAYERS }, (_, i) => path.join(longTermDir, `layer-${i + 1}.json`)),
    personaFile: path.join(personaDir, 'persona.json'),
    personaDir,
  }
}

/** 创建记忆与人格所需的全部目录。 */
export function ensureCompanionDirs(paths) {
  ensureDirSync(paths.memoryDir)
  ensureDirSync(paths.longTermDir)
  ensureDirSync(paths.personaDir)
  return paths
}

/** 角色目录名（方案 A：每个角色一个独立 dataDir）。 */
export const CHARACTERS_DIRNAME = 'characters'

/** 角色 id 规则：小写字母开头，仅小写字母/数字/下划线/连字符，最长 32。 */
export function isValidCharacterId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(id)
}

/** 解析角色根目录（默认 <dataRoot>/characters）。 */
export function resolveCharactersDir(dataRoot, charactersDirname = CHARACTERS_DIRNAME) {
  return path.resolve(dataRoot, charactersDirname)
}

/**
 * 解析某个角色的 dataDir：charactersDir/<characterId>。
 * 该目录同时是 persona 与 memory 的根（<dataDir>/persona、<dataDir>/memory）。
 */
export function characterDataDir(charactersDir, characterId) {
  if (!isValidCharacterId(characterId)) {
    throw new Error(`角色 id 非法：「${String(characterId)}」，规则：小写字母开头，仅小写字母/数字/下划线/连字符，最长 32。`)
  }
  return path.join(path.resolve(charactersDir), characterId)
}
