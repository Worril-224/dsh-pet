/**
 * 多角色（方案 A）：每个智能助手一个独立角色目录，人设与记忆完全隔离。
 *
 * 目录布局：
 *   <charactersDir>/
 *     ├── linglan/
 *     │   ├── character.json        # 角色元数据（id/name/role/order/createdAt）
 *     │   ├── persona/persona.json  # 该角色独立人设
 *     │   └── memory/               # 该角色独立记忆（短期 + 七层长期）
 *     └── <other-id>/...
 *
 * 角色目录本身就是 memory 引擎的 dataDir，因此不同角色 = 不同 dataDir = 记忆互不可见。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDirSync, existsSync, readJsonSync, writeJsonSync } from './shared/fsutil.js'
import { formatLocalIso } from './shared/clock.js'
import {
  characterDataDir,
  ensureCompanionDirs,
  isValidCharacterId,
  resolveCompanionPaths,
} from './shared/paths.js'
import { createPersonaService } from './persona/index.js'

/** 角色 dataDir 解析（charactersDir/<id>），供 preset/host 复用。 */
export { characterDataDir } from './shared/paths.js'

/** 默认数据目录（可移植）：DSH_PET_DATA_DIR 优先，否则 ~/.dsh/dsh-pet/companion-data。 */
export const DEFAULT_DATA_DIR =
  process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')

/** 默认角色根目录（与 cordis.patch.yml 的默认值一致）。 */
export const DEFAULT_CHARACTERS_DIR = path.join(DEFAULT_DATA_DIR, 'characters')

/** 角色元数据文件名。 */
export const CHARACTER_META_FILE = 'character.json'

/** 默认角色 id（当前示例角色「铃兰」）。 */
export const DEFAULT_CHARACTER_ID = 'linglan'

/** 默认角色顺序基数（与现有预设 order=20 配合，新角色从 21 起）。 */
export const CHARACTER_ORDER_BASE = 21

/** 解析角色根目录；空值使用默认路径。 */
export function resolveCharactersRoot(charactersDir) {
  const value = charactersDir === undefined || charactersDir === null ? '' : String(charactersDir).trim()
  return value ? path.resolve(value) : path.resolve(DEFAULT_CHARACTERS_DIR)
}

/** 读取一个角色目录的 character.json（不存在返回 null）。 */
export function readCharacterMeta(characterDir) {
  const meta = readJsonSync(path.join(characterDir, CHARACTER_META_FILE), null)
  return meta && typeof meta === 'object' ? meta : null
}

/**
 * 扫描角色根目录，列出所有合法角色（带元数据、人设/记忆存在性）。
 * 每次调用重新扫描，因此新建角色无需重启 Host 即可被维护调度发现。
 * @param {string} [charactersDir]
 * @returns {Array<{id:string,dir:string,name:string,role:string,description:string,
 *   order:number,createdAt?:string,meta:object|null,personaFile:string,hasPersona:boolean,hasMemory:boolean}>}
 */
export function listCharacters(charactersDir) {
  const root = resolveCharactersRoot(charactersDir)
  if (!existsSync(root)) return []
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const characters = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (!isValidCharacterId(entry.name)) continue
    const dir = path.join(root, entry.name)
    const meta = readCharacterMeta(dir)
    const personaFile = path.join(dir, 'persona', 'persona.json')
    const hasPersona = existsSync(personaFile)
    const hasMemory = existsSync(path.join(dir, 'memory'))
    if (!meta && !hasPersona && !hasMemory) continue
    characters.push({
      id: entry.name,
      dir,
      name: typeof meta?.name === 'string' && meta.name.trim() ? meta.name.trim() : entry.name,
      role: typeof meta?.role === 'string' && meta.role.trim() ? meta.role.trim() : '情感陪伴',
      description: typeof meta?.description === 'string' ? meta.description : '',
      order: Number.isFinite(Number(meta?.order)) ? Number(meta.order) : 100,
      createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : undefined,
      meta,
      personaFile,
      hasPersona,
      hasMemory,
    })
  }
  return characters.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** 按 id 读取一个角色；不存在返回 undefined。 */
export function getCharacter(charactersDir, id) {
  return listCharacters(charactersDir).find((character) => character.id === id)
}

/** 建议的下一个预设 order（现有角色最大值 + 1，至少 CHARACTER_ORDER_BASE）。 */
export function suggestCharacterOrder(charactersDir) {
  const orders = listCharacters(charactersDir).map((character) => character.order)
  const max = orders.length > 0 ? Math.max(...orders) : 0
  return Math.max(CHARACTER_ORDER_BASE, max + 1)
}

/** 递归替换 JSON 中所有字符串里的旧角色名（用于默认模板换名）。 */
function replaceNameInJson(value, oldName, newName) {
  if (typeof value === 'string') return oldName ? value.split(oldName).join(newName) : value
  if (Array.isArray(value)) return value.map((entry) => replaceNameInJson(entry, oldName, newName))
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, entry] of Object.entries(value)) result[key] = replaceNameInJson(entry, oldName, newName)
    return result
  }
  return value
}

/** 推断人设中的角色名。 */
function personaName(definition) {
  return (
    definition?.meta?.name ??
    definition?.character?.name ??
    (Array.isArray(definition?.modules) ? definition.modules.find((m) => m.id === 'role_definition')?.label : undefined) ??
    ''
  )
}

/** YAML 单引号字符串（内部单引号转义为两个）。 */
function yamlQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`
}

/**
 * 生成「新增角色预设」的 YAML 片段（追加到 companion-bundle/cordis.patch.yml 后重新安装即可）。
 * @param {{id:string,name:string,role?:string,description?:string,charactersDir?:string,order?:number}} input
 */
export function buildCharacterPresetSnippet(input) {
  const id = input.id
  const displayName = input.name || id
  const role = input.role || '情感陪伴'
  const order = Number.isFinite(Number(input.order)) ? Number(input.order) : CHARACTER_ORDER_BASE
  const charactersDir = resolveCharactersRoot(input.charactersDir)
  const description = input.description || `${displayName}：拥有独立人设与七层长期记忆的${role}助手`
  return [
    '- insert:',
    `    - id: preset-companion-${id}`,
    `      name: '@deepseek-ai/dsh-agent-preset'`,
    '      config:',
    `        id: companion-${id}`,
    `        name: ${yamlQuote(`情感陪伴 · ${displayName}`)}`,
    `        description: ${yamlQuote(description)}`,
    `        order: ${order}`,
    '        plugins:',
    '          - id: companion-core',
    `            name: '@local/dsh-companion/preset'`,
    '            config:',
    `              charactersDir: ${yamlQuote(charactersDir.replaceAll('\\', '/'))}`,
    `              characterId: ${id}`,
    '',
  ].join('\n')
}

/**
 * 创建一个新角色：独立目录 + 人物设定文件 + character.json + 记忆目录，并校验人设。
 *
 * @param {object} input
 * @param {string} input.id 角色 id（小写字母开头）
 * @param {string} input.name 显示名
 * @param {string} [input.role] 角色定位
 * @param {string} [input.description]
 * @param {number} [input.order]
 * @param {string} [input.charactersDir] 角色根目录
 * @param {string} [input.personaFile] 现成的人设 JSON 文件（会复制到角色目录）
 * @param {string} [input.defaultPersonaFile] 无人设时使用的模板（默认 bundle 内置铃兰模板）
 * @param {boolean} [input.overwrite] 是否覆盖已存在的人设文件
 * @param {{now:()=>number}} [input.clock]
 * @returns {{ok:boolean, id:string, name:string, dataDir:string, charactersDir:string,
 *   personaFile:string, metaFile:string, validation:object, presetSnippet:string}}
 */
export function createCharacter(input) {
  const { id, name } = input
  if (!isValidCharacterId(id)) {
    throw new Error(`角色 id 非法：「${String(id)}」，规则：小写字母开头，仅小写字母/数字/下划线/连字符，最长 32。`)
  }
  if (typeof name !== 'string' || !name.trim()) throw new Error('创建角色需要非空的显示名 name。')
  const charactersDir = resolveCharactersRoot(input.charactersDir)
  // 先计算建议 order（在创建本角色目录之前，避免把「进行中的目录」当成已有角色）
  const resolvedOrder = Number.isFinite(Number(input.order)) ? Number(input.order) : suggestCharacterOrder(charactersDir)
  ensureDirSync(charactersDir)
  const dir = characterDataDir(charactersDir, id)
  const paths = resolveCompanionPaths(dir)
  const dirExistedBefore = existsSync(dir)
  ensureCompanionDirs(paths)

  /** 创建失败时清理本次新建的角色目录，避免残留空角色被 Host 扫描维护。 */
  const cleanupOnFailure = (error) => {
    if (!dirExistedBefore) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清理失败不掩盖原始错误
      }
    }
    throw error
  }

  try {
    const overwrite = input.overwrite === true
    let source = 'existing'
    if (input.personaFile) {
      const definition = readJsonSync(path.resolve(input.personaFile), null)
      if (!definition || typeof definition !== 'object' || !Array.isArray(definition.modules)) {
        throw new Error(`人设文件不合法（需要包含 modules 数组）：${input.personaFile}`)
      }
      if (!existsSync(paths.personaFile) || overwrite) {
        writeJsonSync(paths.personaFile, definition)
        source = 'persona-file'
      }
    } else if ((!existsSync(paths.personaFile) || overwrite) && input.defaultPersonaFile) {
      const template = readJsonSync(path.resolve(input.defaultPersonaFile), null)
      if (!template || typeof template !== 'object' || !Array.isArray(template.modules)) {
        throw new Error(`默认人设模板不合法：${input.defaultPersonaFile}`)
      }
      const oldName = personaName(template)
      let definition = replaceNameInJson(template, oldName, name)
      if (!definition.meta || typeof definition.meta !== 'object') definition.meta = {}
      definition.meta.name = name
      if (definition.character && typeof definition.character === 'object') definition.character.name = name
      writeJsonSync(paths.personaFile, definition)
      source = 'template'
    }
    if (!existsSync(paths.personaFile)) {
      throw new Error(`角色「${id}」缺少人设文件：请通过 personaFile 提供现成人设，或提供 defaultPersonaFile 模板。`)
    }

    const nowIso = formatLocalIso(input.clock?.now?.() ?? Date.now())
    const existingMeta = readCharacterMeta(dir)
    const meta = {
      schemaVersion: 1,
      id,
      name: name.trim(),
      role: input.role && String(input.role).trim() ? String(input.role).trim() : '情感陪伴',
      description: typeof input.description === 'string' ? input.description : '',
      order: resolvedOrder,
      createdAt: typeof existingMeta?.createdAt === 'string' ? existingMeta.createdAt : nowIso,
      updatedAt: nowIso,
      personaSource: source,
    }
    const metaFile = path.join(dir, CHARACTER_META_FILE)
    writeJsonSync(metaFile, meta)

    const persona = createPersonaService({
      dataDir: dir,
      defaultPersonaFile: paths.personaFile,
      clock: input.clock,
    })
    persona.ensure()
    const validation = persona.validate()

    return {
      ok: validation.ok,
      id,
      name: meta.name,
      dataDir: dir,
      charactersDir,
      personaFile: paths.personaFile,
      metaFile,
      meta,
      validation,
      presetSnippet: buildCharacterPresetSnippet({
        id,
        name: meta.name,
        role: meta.role,
        description: meta.description,
        charactersDir,
        order: meta.order,
      }),
    }
  } catch (error) {
    cleanupOnFailure(error)
  }
}
