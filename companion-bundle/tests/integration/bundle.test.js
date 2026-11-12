/**
 * 覆盖验收项：I1（bundle 结构）、I6（无外部依赖 / 数据目录约定）。
 * 静态检查插件包是否满足 Harness bundle 与「零 npm 依赖」约束。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function walk(dir, suffix, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, suffix, out)
    else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(full)
  }
  return out
}

test('I1：package.json 是合法 Harness bundle 且零 npm 依赖', () => {
  const pkg = readJson(path.join(bundleDir, 'package.json'))
  assert.equal(pkg.name, '@local/dsh-companion')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(fs.existsSync(path.join(bundleDir, 'cordis.patch.yml')))
  assert.equal(pkg.exports['.'], './lib/host.js')
  assert.equal(pkg.exports['./preset'], './lib/preset.js')
  assert.ok(fs.existsSync(path.join(bundleDir, pkg.exports['.'])))
  assert.ok(fs.existsSync(path.join(bundleDir, pkg.exports['./preset'])))
  // Web UI 左栏模型面板：Client 半与 Host 半同包，客户端入口由 dsh.client 声明
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(fs.existsSync(path.join(bundleDir, 'client.js')))
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.dsh?.client?.immediately, true)
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0)
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[field], undefined, `不允许声明 ${field}（profile 无法解析 DSH 私有包）`)
  }
})

test('I1：cordis.patch.yml 声明 Host 插件行与情感陪伴预设', () => {
  const patch = fs.readFileSync(path.join(bundleDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*companion-host/)
  assert.match(patch, /name:\s*'@local\/dsh-companion'/)
  assert.match(patch, /id:\s*preset-companion/)
  assert.match(patch, /name:\s*'@deepseek-ai\/dsh-agent-preset'/)
  assert.match(patch, /id:\s*companion/)
  assert.match(patch, /name:\s*'@local\/dsh-companion\/preset'/)
  // 方案 A：Host 与预设都按角色根目录 + characterId 解析，不再共用单一 dataDir；
  // 安装模板里 charactersDir 是注释示例（不写死任何人的绝对路径）。
  assert.match(patch, /#\s*charactersDir:/)
  assert.match(patch, /characterId:\s*ophelia/)
  assert.match(patch, /name:\s*情感陪伴 · 奥菲莉亚/)
  // 预设至少包含时间上下文、记忆/人设核心、问答工具与压缩组
  assert.match(patch, /@deepseek-ai\/dsh-time-context/)
  assert.match(patch, /@deepseek-ai\/dsh-tool-ask-user/)
  assert.match(patch, /@deepseek-ai\/dsh-compaction-basic/)
  // QQ 通道（OneBot 11 / NapCat）：白名单只允许主人，绑定奥菲莉亚；只保留示例值，不含真实账号
  assert.match(patch, /id:\s*companion-qq/)
  assert.match(patch, /name:\s*'@local\/dsh-companion\/qq'/)
  assert.match(patch, /botQQ:\s*123456789/)
  assert.match(patch, /allowUsers:\s*\[\]/)
  assert.match(patch, /onebotUrl:\s*'ws:\/\/127\.0\.0\.1:3001'/)
  // 脱敏：安装模板不得出现本机绝对路径 / 真实 10 位 QQ 号 / 真实 token
  assert.doesNotMatch(patch, /\b[A-Za-z]:[\\/]/)
  assert.doesNotMatch(patch, /\b\d{10}\b/)
  assert.match(patch, /accessToken:\s*''/)
})

test('I1：locale 提供中英文显示元数据，icon 为合法 SVG', () => {
  for (const locale of ['en', 'zh']) {
    const data = readJson(path.join(bundleDir, 'locale', `${locale}.json`))
    assert.ok(typeof data.meta?.title === 'string' && data.meta.title.trim().length > 0, `${locale} 缺少 meta.title`)
    assert.ok(typeof data.meta?.description === 'string' && data.meta.description.trim().length > 0, `${locale} 缺少 meta.description`)
  }
  const icon = fs.readFileSync(path.join(bundleDir, 'icon.svg'))
  assert.ok(icon.length > 0 && icon.length < 256 * 1024, 'icon 必须存在且小于 256 KiB')
  assert.match(icon.toString('utf8').trimStart(), /^<svg/)
})

test('I1：lib 只允许 node: 内置模块与包内相对导入', () => {
  const files = walk(path.join(bundleDir, 'lib'), '.js')
  assert.ok(files.length >= 8, `lib 下 JS 文件过少：${files.length}`)
  const importRe = /(?:^|\n)\s*(?:import|export)\s[^\n]*?from\s+['"]([^'"]+)['"]/g
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  const bare = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const re of [importRe, dynamicRe]) {
      re.lastIndex = 0
      let match
      while ((match = re.exec(text)) !== null) {
        const specifier = match[1]
        if (specifier.startsWith('node:') || specifier.startsWith('.')) continue
        bare.push(`${path.relative(bundleDir, file)} → ${specifier}`)
      }
    }
  }
  assert.deepEqual(bare, [], `发现非内置/非相对的 import：${bare.join('; ')}`)
})

test('I1：关键模块文件齐全且可被静态解析', async () => {
  for (const relative of [
    'lib/host.js',
    'lib/preset.js',
    'lib/characters.js',
    'lib/memory/index.js',
    'lib/persona/index.js',
    'lib/tools/companion-tools.js',
    'lib/im/adapter.js',
    'lib/im/qq-bot.js',
    'lib/im/onebot.js',
    'lib/im/reply-engine.js',
    'lib/im/registry.js',
    'lib/qq-host.js',
    'lib/model-control.js',
    'lib/qq-model-routes.js',
    'lib/shared/http.js',
    'client.js',
    'lib/shared/fsutil.js',
    'lib/shared/clock.js',
    'lib/shared/paths.js',
    'data/persona.default.json',
  ]) {
    assert.ok(fs.existsSync(path.join(bundleDir, relative)), `缺少文件：${relative}`)
  }
  const personaDefault = readJson(path.join(bundleDir, 'data', 'persona.default.json'))
  assert.equal(personaDefault.modules.length, 9, '人设默认文件必须包含 9 个模块')
})
