/**
 * 独立验收测试统一入口（verifier 自写）。
 *
 * 用法（Node 不在 PATH，使用 Harness 自带 Node）：
 *   node 验收/verification/run-verification.mjs
 *   （Windows 下也可用 Harness 自带 Node：& "<node.exe 路径>" 验收/verification/run-verification.mjs）
 *
 * 只收集 verification/ 下 verifier 自写的 *.test.js，不包含开发者测试。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = fs
  .readdirSync(here)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(here, name))

if (files.length === 0) {
  console.error('verification/ 下没有找到 *.test.js')
  process.exit(2)
}

console.log(`独立验收测试：共 ${files.length} 个文件`)
for (const file of files) console.log(`  - ${path.relative(process.cwd(), file)}`)
console.log('')

const result = spawnSync(process.execPath, ['--test', ...files], { cwd: path.resolve(here, '..', '..'), stdio: 'inherit' })
process.exit(result.status ?? 1)
