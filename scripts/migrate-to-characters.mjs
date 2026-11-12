/**
 * 把旧版单目录（<dataDir>/persona + <dataDir>/memory）迁移为方案 A 的角色目录：
 *   <dataDir>/characters/<角色id>/{persona, memory}
 *
 * 用法：
 *   node scripts/migrate-to-characters.mjs [--data-dir <数据目录>]
 *       [--id linglan] [--name 铃兰] [--copy] [--force]
 *
 * 默认数据目录：$DSH_PET_DATA_DIR 或 ~/.dsh/dsh-pet/companion-data。
 * 默认移动（move）；--copy 复制并保留旧数据。--force 允许覆盖已存在的目标角色目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCharacter,
  listCharacters,
} from '../companion-bundle/lib/characters.js'
import { formatLocalIso } from '../companion-bundle/lib/shared/clock.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultTemplate = path.join(root, 'companion-bundle', 'data', 'persona.default.json')

/** 默认数据目录：与 companion-bundle 保持一致（可用 DSH_PET_DATA_DIR 覆盖）。 */
const DEFAULT_DATA_DIR = process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'copy' || key === 'force') {
      args[key] = true
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function migratePath(source, target) {
  if (args.copy) {
    fs.cpSync(source, target, { recursive: true, force: true })
  } else {
    fs.renameSync(source, target)
  }
}

const args = parseArgs(process.argv.slice(2))
const dataDir = path.resolve(args['data-dir'] ? String(args['data-dir']) : DEFAULT_DATA_DIR)
const characterId = String(args.id ?? 'linglan')
const characterName = String(args.name ?? '铃兰')
const charactersDir = path.resolve(
  args['characters-dir'] ? String(args['characters-dir']) : path.join(dataDir, 'characters'),
)
const legacyPersona = path.join(dataDir, 'persona', 'persona.json')
const legacyMemory = path.join(dataDir, 'memory')
const targetCharacterDir = path.join(charactersDir, characterId)

if (!fs.existsSync(legacyPersona) && !fs.existsSync(legacyMemory)) {
  console.log(`旧版单目录没有可迁移的数据（${dataDir}）。当前角色：`)
  const characters = listCharacters(charactersDir)
  if (characters.length === 0) console.log('  （暂无角色）')
  for (const character of characters) console.log(`  - ${character.id}：${character.name}`)
  process.exit(0)
}
if (fs.existsSync(targetCharacterDir) && !args.force) {
  console.error(`目标角色目录已存在：${targetCharacterDir}\n如需覆盖请加 --force。`)
  process.exit(2)
}

fs.mkdirSync(path.dirname(targetCharacterDir), { recursive: true })
if (fs.existsSync(targetCharacterDir) && args.force) fs.rmSync(targetCharacterDir, { recursive: true, force: true })
fs.mkdirSync(path.join(targetCharacterDir, 'persona'), { recursive: true })
if (fs.existsSync(legacyPersona)) migratePath(legacyPersona, path.join(targetCharacterDir, 'persona', 'persona.json'))
if (fs.existsSync(legacyMemory)) migratePath(legacyMemory, path.join(targetCharacterDir, 'memory'))

// 兜底：迁移后若仍无人设，用 bundle 默认模板生成
const result = createCharacter({
  charactersDir,
  id: characterId,
  name: characterName,
  role: '情感陪伴',
  order: 20,
  defaultPersonaFile: defaultTemplate,
  overwrite: false,
})

// 覆盖本次迁移的角色元数据（保留迁移来源）
const nowIso = formatLocalIso()
fs.writeFileSync(
  path.join(targetCharacterDir, 'character.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      id: result.id,
      name: result.name,
      role: result.meta.role,
      description: result.meta.description,
      order: result.meta.order,
      createdAt: nowIso,
      updatedAt: nowIso,
      personaSource: 'migrated',
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

// 移动模式：清理旧目录（persona/memory 已迁走，空目录一并移除）
if (!args.copy) {
  for (const legacyDir of [path.join(dataDir, 'persona'), legacyMemory]) {
    try {
      if (fs.existsSync(legacyDir)) fs.rmSync(legacyDir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响迁移结果
    }
  }
}

console.log('✅ 迁移完成（方案 A）')
console.log(`  角色 id ：${result.id}`)
console.log(`  显示名  ：${result.name}`)
console.log(`  新目录  ：${result.dataDir}`)
console.log(`  人设校验：${result.validation.ok ? '通过' : `失败 ${result.validation.errors.join('；')}`}`)
console.log(`  迁移方式：${args.copy ? '复制（保留旧数据）' : '移动'}`)
console.log('\n预设片段（当前 bundle 已内置 linglan，可跳过）：')
console.log(result.presetSnippet.trimEnd())
