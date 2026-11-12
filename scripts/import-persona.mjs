/**
 * 从外部「人设卡 JSON」导入一个新角色（方案 A：独立角色目录 + 独立人设 + 独立记忆）。
 *
 * 支持 persona-ophelia 这类 8+1 模块人设卡（modules 为对象，key 为
 * role_definition / speaking_style / self / memory_and_promises / rules / appearance /
 * other_ai / identity / backstory），也支持已经是本项目格式的 persona.json。
 *
 * 用法：
 *   node scripts/import-persona.mjs --source <人设卡.json> [选项]
 *
 * 常用选项：
 *   --id <角色id>            必填（小写字母开头）
 *   --name <显示名>          默认取人设卡里的名字
 *   --role <定位>            默认「情感陪伴 + 轻量协作型 AI 角色助手」
 *   --platform <平台>        默认「DeepSeek Harness 桌面聊天（DeepSeek 平台）」
 *   --style-file <json>      覆盖从正文推导出的 style（sentence/length/toneWords/...）
 *   --order <数字>           预设排序，默认自动递增
 *   --characters-dir <dir>   角色根目录，默认 <DSH_PET_DATA_DIR>/characters
 *                            （即 ~/.dsh/dsh-pet/companion-data/characters）
 *   --archive <旧角色id>     导入后把旧角色目录归档到 characters/.retired/（用于「替换铃兰」这类场景）
 *   --overwrite              覆盖已存在角色的人设
 *   --output <json路径>      只导出转换后的人设 JSON，不创建角色
 *
 * 导入后仍需要：把预设片段写入 companion-bundle/cordis.patch.yml（新角色追加；替换则修改现有预设行的
 * characterId/name/description），重新安装 bundle 或重启 Harness。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCharacter,
  listCharacters,
  suggestCharacterOrder,
} from '../companion-bundle/lib/characters.js'
import { importPersonaCard } from '../companion-bundle/lib/persona/import.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 默认数据目录：与 companion-bundle 保持一致（可用 DSH_PET_DATA_DIR 覆盖）。 */
const DEFAULT_DATA_DIR = process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')
const defaultCharactersDir = path.join(DEFAULT_DATA_DIR, 'characters')

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'overwrite') {
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
  console.log(`用法：node scripts/import-persona.mjs --source <人设卡.json> --id <角色id> [--name 显示名] [选项]
选项：--role --platform --style-file --order --characters-dir --archive <旧id> --overwrite --output <json>
当前角色（${charactersDir}）：`)
  const characters = listCharacters(charactersDir)
  if (characters.length === 0) console.log('  （暂无角色）')
  for (const character of characters) console.log(`  - ${character.id}：${character.name}（order=${character.order}）`)
}

const args = parseArgs(process.argv.slice(2))
const charactersDir = path.resolve(args['characters-dir'] ? String(args['characters-dir']) : defaultCharactersDir)
if (args.help || !args.source || (!args.id && !args.output)) {
  usage(charactersDir)
  process.exit(args.help ? 0 : 2)
}

const sourcePath = path.resolve(String(args.source))
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))
const styleOverride = args['style-file']
  ? JSON.parse(fs.readFileSync(path.resolve(String(args['style-file'])), 'utf8'))
  : undefined

const options = {
  id: args.id ? String(args.id) : undefined,
  name: args.name ? String(args.name) : undefined,
  role: args.role ? String(args.role) : undefined,
  platform: args.platform ? String(args.platform) : undefined,
  style: styleOverride,
}
const definition = importPersonaCard(source, options)

if (args.output) {
  const outputPath = path.resolve(String(args.output))
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(definition, null, 2) + '\n', 'utf8')
  console.log(`✅ 已导出转换后的人设：${outputPath}`)
  console.log(`  角色：${definition.character.name}（${definition.character.role}）`)
  console.log(`  模块：${definition.modules.map((module) => module.id).join('、')}`)
  console.log(`  样式：语气词 ${definition.style.toneWords.join('、')}；禁用开头 ${definition.style.bannedOpeners.length} 条`)
  process.exit(0)
}

const order = args.order !== undefined ? Number(args.order) : suggestCharacterOrder(charactersDir)
const tempFile = path.join(os.tmpdir(), `dshpet-import-${Date.now()}-${process.pid}.json`)
fs.writeFileSync(tempFile, JSON.stringify(definition, null, 2) + '\n', 'utf8')

try {
  const result = createCharacter({
    charactersDir,
    id: String(args.id),
    name: definition.character.name,
    role: definition.character.role,
    description: definition.meta.title,
    order,
    personaFile: tempFile,
    overwrite: args.overwrite === true,
  })

  console.log('✅ 角色已创建（方案 A：独立人设 + 独立记忆）')
  console.log(`  角色 id ：${result.id}`)
  console.log(`  显示名  ：${result.name}`)
  console.log(`  数据目录：${result.dataDir}`)
  console.log(`  人设文件：${result.personaFile}`)
  console.log(`  人设校验：${result.validation.ok ? '通过' : `失败 ${result.validation.errors.join('；')}`}`)
  if (result.validation.warnings.length > 0) console.log(`  校验警告：${result.validation.warnings.join('；')}`)

  if (args.archive) {
    const oldId = String(args.archive)
    const oldDir = path.join(charactersDir, oldId)
    if (!fs.existsSync(oldDir)) {
      console.log(`\n⚠️ 要归档的旧角色目录不存在：${oldDir}`)
    } else if (oldId === result.id) {
      console.log('\n⚠️ --archive 与 --id 相同，跳过归档。')
    } else {
      const retiredDir = path.join(charactersDir, '.retired')
      fs.mkdirSync(retiredDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = path.join(retiredDir, `${oldId}-${stamp}`)
      fs.renameSync(oldDir, target)
      console.log(`\n✅ 旧角色已归档：${oldId} → ${target}`)
    }
  }

  console.log('\n把以下预设片段写入 companion-bundle/cordis.patch.yml（新角色追加；替换旧角色则修改现有预设行）：')
  console.log('----------------------------------------------------------------------')
  console.log(result.presetSnippet.trimEnd())
  console.log('----------------------------------------------------------------------')
  console.log('\n后续步骤：')
  console.log('  1) 修改/追加 bundle 的预设声明后，重新安装 bundle（plugin_manager remove/install）或重启 Harness；')
  console.log('  2) 在 Web GUI 新建会话选择「情感陪伴 · 名字」预设；')
  console.log('  3) 该角色记忆只写入自己的角色目录，与其他角色隔离。')
} finally {
  fs.rmSync(tempFile, { force: true })
}
