#!/usr/bin/env node
/**
 * 初始化数据目录：把仓库自带的 companion-data（示例角色人设 + 记忆）复制到运行数据目录。
 *
 * 默认目标目录（与 companion-bundle 一致）：
 *   $DSH_PET_DATA_DIR 或 ~/.dsh/dsh-pet/companion-data
 *
 * 用法：
 *   node scripts/init-data.mjs                 # 首次初始化（目标已存在且非空时拒绝覆盖）
 *   node scripts/init-data.mjs --force         # 覆盖已有数据目录（会先删除目标目录，请先备份）
 *   node scripts/init-data.mjs --target <dir>  # 指定目标目录（等价于设置 DSH_PET_DATA_DIR）
 *
 * 初始化完成后，把 bundle 的 charactersDir 指向 <数据目录>/characters（或设置 DSH_PET_DATA_DIR），
 * 再重新安装 companion-bundle 并重启 Harness。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(repoRoot, 'companion-data')

/** 默认数据目录：与 companion-bundle 保持一致。 */
const DEFAULT_DATA_DIR = process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(`--${name}`)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

if (hasFlag('help')) {
  console.log('用法：node scripts/init-data.mjs [--force] [--target <目录>]')
  console.log('  --force          覆盖已存在的数据目录（先删除目标目录）')
  console.log('  --target <目录>  目标数据目录（默认 $DSH_PET_DATA_DIR 或 ~/.dsh/dsh-pet/companion-data）')
  process.exit(0)
}

const targetDir = path.resolve(option('target') ? String(option('target')) : DEFAULT_DATA_DIR)
const charactersDir = path.join(targetDir, 'characters')
const force = hasFlag('force')

const isInside = (child, parent) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

if (!fs.existsSync(sourceDir)) {
  console.error(`仓库里找不到示例数据目录：${sourceDir}`)
  process.exit(1)
}
if (isInside(targetDir, sourceDir) || isInside(sourceDir, targetDir)) {
  console.error('目标目录不能是仓库 companion-data 目录本身或它的父/子目录：')
  console.error(`  源目录：${sourceDir}`)
  console.error(`  目标目录：${targetDir}`)
  process.exit(2)
}

function countFiles(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name))
    else if (entry.isFile()) total += 1
  }
  return total
}

const existed = fs.existsSync(targetDir)
const existingEntries = existed ? fs.readdirSync(targetDir) : []
if (existed && existingEntries.length > 0 && !force) {
  console.error(`目标数据目录已存在且非空：${targetDir}`)
  console.error('为避免覆盖你的角色记忆，默认不写入。确认要覆盖请加 --force（建议先手动备份）。')
  process.exit(2)
}
if (existed && force) {
  fs.rmSync(targetDir, { recursive: true, force: true })
}

fs.mkdirSync(path.dirname(targetDir), { recursive: true })
fs.cpSync(sourceDir, targetDir, { recursive: true, force: true })

const fileCount = countFiles(targetDir)
const characters = fs.existsSync(charactersDir)
  ? fs.readdirSync(charactersDir, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith('.'),
    ).length
  : 0

console.log('✅ 示例数据已初始化')
console.log(`  源目录  ：${sourceDir}`)
console.log(`  数据目录：${targetDir}${force && existed ? '（--force 覆盖）' : ''}`)
console.log(`  角色目录：${charactersDir}（${characters} 个角色，共 ${fileCount} 个文件）`)
console.log('')
console.log('下一步（二选一，二选一即可）：')
console.log(`  1) 把 companion-bundle 的 charactersDir 配置改为：${charactersDir}`)
console.log('     （companion-bundle/cordis.patch.yml 里的 charactersDir / config.charactersDir）')
console.log(`  2) 或设置环境变量 DSH_PET_DATA_DIR=${targetDir}（bundle 与 scripts 默认读取它）`)
console.log('')
console.log('然后重新安装 companion-bundle（或重启 Harness），在 Web GUI 新建会话即可看到示例角色。')
console.log('其它脚本：')
console.log('  node scripts/add-character.mjs --id <id> --name <名字>     # 新增角色')
console.log('  node scripts/report-character-status.mjs                  # 生成角色现状报告')
console.log('  node scripts/run-tests.mjs all                            # 跑 bundle 测试')
