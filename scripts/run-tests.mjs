import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const groups = {
  memory: 'companion-bundle/tests/memory',
  persona: 'companion-bundle/tests/persona',
  life: 'companion-bundle/tests/life',
  integration: 'companion-bundle/tests/integration',
  unit: 'companion-bundle/tests/unit',
}

function collect(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collect(full))
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(full)
  }
  return files.sort()
}

const requested = (process.argv[2] ?? 'all').trim()
const selected = requested === 'all' ? Object.keys(groups) : [requested]
for (const name of selected) {
  if (!groups[name]) {
    console.error(`未知测试组：${name}（可选：all, ${Object.keys(groups).join(', ')}）`)
    process.exit(2)
  }
}

const files = selected.flatMap((name) => collect(path.join(root, groups[name])))
if (files.length === 0) {
  console.error(`未找到测试文件：${selected.join(', ')}`)
  process.exit(2)
}

console.log(`\n运行 ${selected.join(' + ')} 测试，共 ${files.length} 个文件：`)
for (const file of files) console.log(`  - ${path.relative(root, file)}`)
console.log('')

const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...files], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
