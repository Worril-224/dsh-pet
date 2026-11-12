/**
 * 新增一个独立角色（方案 A：每个角色独立人设 + 独立记忆）。
 *
 * 用法：
 *   node scripts/add-character.mjs --id <角色id> --name <显示名> [选项]
 *
 * 常用选项：
 *   --persona <json>        现成的人设 JSON（会复制到角色目录，并按该角色使用）
 *   --template <json>       无人设时使用的模板（默认 bundle 内置 data/persona.default.json）
 *   --role <文本>           角色定位（默认「情感陪伴」）
 *   --description <文本>    预设描述
 *   --order <数字>          预设排序（默认自动递增）
 *   --characters-dir <dir>  角色根目录（默认 <DSH_PET_DATA_DIR>/characters，
 *                           即 ~/.dsh/dsh-pet/companion-data/characters）
 *   --overwrite             覆盖已存在的角色人设
 *   --write-patch           自动把预设片段追加到 companion-bundle/cordis.patch.yml
 *
 * 创建后：重新安装 bundle（或重启 Harness 触发配置刷新），新建会话即可在预设列表中看到该角色。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCharacter, listCharacters, suggestCharacterOrder } from '../companion-bundle/lib/characters.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultTemplate = path.join(root, 'companion-bundle', 'data', 'persona.default.json')
const defaultPatchFile = path.join(root, 'companion-bundle', 'cordis.patch.yml')

/** 默认数据目录：与 companion-bundle 保持一致（可用 DSH_PET_DATA_DIR 覆盖）。 */
const DEFAULT_DATA_DIR = process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')
const defaultCharactersDir = path.join(DEFAULT_DATA_DIR, 'characters')

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    if (key === 'once' || key === 'overwrite' || key === 'write-patch') {
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

function usage(charactersDir) {
  console.log(`用法：node scripts/add-character.mjs --id <角色id> --name <显示名> [--persona <人设.json>] [--write-patch]
可选：--role --description --order --characters-dir --template --overwrite

当前角色列表（${charactersDir}）：`)
  const characters = listCharacters(charactersDir)
  if (characters.length === 0) console.log('  （暂无角色）')
  for (const character of characters) {
    console.log(`  - ${character.id}：${character.name}（order=${character.order}）${character.hasPersona ? '' : '（缺人设）'}`)
  }
}

const args = parseArgs(process.argv.slice(2))
const charactersDir = path.resolve(args['characters-dir'] ? String(args['characters-dir']) : defaultCharactersDir)
if (args.help || !args.id || !args.name) {
  usage(charactersDir)
  process.exit(args.help ? 0 : 2)
}

const order = args.order !== undefined ? Number(args.order) : suggestCharacterOrder(charactersDir)
const result = createCharacter({
  charactersDir,
  id: String(args.id),
  name: String(args.name),
  role: args.role,
  description: args.description,
  order,
  personaFile: args.persona ? path.resolve(String(args.persona)) : undefined,
  defaultPersonaFile: args.template ? path.resolve(String(args.template)) : defaultTemplate,
  overwrite: args.overwrite === true,
})

console.log('✅ 角色目录已创建（方案 A：独立人设 + 独立记忆）')
console.log(`  角色 id ：${result.id}`)
console.log(`  显示名  ：${result.name}`)
console.log(`  数据目录：${result.dataDir}`)
console.log(`  人设文件：${result.personaFile}`)
console.log(`  元数据  ：${result.metaFile}`)
console.log(`  人设校验：${result.validation.ok ? '通过' : `失败 ${result.validation.errors.join('；')}`}`)
console.log('\n把以下预设片段追加到 companion-bundle/cordis.patch.yml：')
console.log('----------------------------------------------------------------------')
console.log(result.presetSnippet.trimEnd())
console.log('----------------------------------------------------------------------')

if (args['write-patch']) {
  const patchFile = args['patch-file'] ? path.resolve(String(args['patch-file'])) : defaultPatchFile
  const existing = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : ''
  const marker = `id: preset-companion-${result.id}`
  if (existing.includes(marker)) {
    console.log(`\n⚠️ ${patchFile} 已包含 ${marker}，跳过追加。`)
  } else {
    const next = `${existing.replace(/\s*$/, '')}\n\n${result.presetSnippet}`
    fs.writeFileSync(patchFile, next, 'utf8')
    console.log(`\n✅ 预设片段已追加到 ${patchFile}`)
  }
}

console.log('\n后续步骤：')
console.log('  1) 重新安装 bundle 让新的预设声明生效（plugin_manager install_bundle，target 指向仓库里的 companion-bundle 目录），或重启 Harness；')
console.log('  2) 在 Web GUI 新建会话，选择该角色的「情感陪伴 · 名字」预设；')
console.log('  3) 该角色的记忆位于自己的角色目录，不会与其它角色共享。')
