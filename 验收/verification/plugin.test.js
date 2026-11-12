/**
 * 独立验收测试 · 插件集成与静态结构（补充验证）
 * 覆盖需求编号：P10（预设注入模拟）、I1（bundle 结构）、I4（主流程模拟）、
 *                Host 插件 5.3（启动检查 / 定时检查 / ctx.effect 清理）
 *
 * 本文件是验收员在指定 M1–M14 / P1–P9 / I5 范围之外的补充验证，用于交叉核对
 * 插件接线是否与 SPEC 第 5 节一致。全部测试使用系统临时目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply as applyHost, runMaintenanceCheck } from '../../companion-bundle/lib/host.js'
import * as hostModule from '../../companion-bundle/lib/host.js'
import { apply as applyPreset } from '../../companion-bundle/lib/preset.js'
import { createPersonaService } from '../../companion-bundle/lib/persona/index.js'
import { getMemoryEngine, resetMemoryEngineRegistry } from '../../companion-bundle/lib/memory/index.js'
import { createCompanionTools } from '../../companion-bundle/lib/tools/companion-tools.js'
import { cleanupTempDirs, makeTempDir, newMemoryEngine } from './helpers.mjs'

test.after(cleanupTempDirs)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLE = path.join(ROOT, 'companion-bundle')

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function walk(dir, filter) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, filter))
    else if (entry.isFile() && filter(full)) out.push(full)
  }
  return out
}

function makeFakeCtx({ sectionOrder = -50, timer } = {}) {
  const state = { sections: [], contexts: [], tools: [], listeners: new Map(), effects: [], logs: [] }
  const ctx = {
    logger: {
      info: (message) => state.logs.push(['info', message]),
      warn: (message) => state.logs.push(['warn', message]),
      error: (message) => state.logs.push(['error', message]),
    },
    get: (name) => (name === 'timer' ? timer : undefined),
    effect: (fn) => {
      const dispose = fn()
      state.effects.push(dispose)
      return dispose
    },
    on: (event, handler) => {
      state.listeners.set(event, handler)
      return () => state.listeners.delete(event)
    },
    systemPrompt: {
      getSectionOrder: () => sectionOrder,
      section: (desc) => {
        state.sections.push(desc)
        return () => {}
      },
      context: (desc) => {
        state.contexts.push(desc)
        return () => {}
      },
    },
    tools: {
      register: (tool) => {
        state.tools.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, state }
}

// ───────────────────────────── I1 bundle 结构（静态） ─────────────────────────────

test('I1: package.json / cordis.patch.yml / locale / icon / 零 npm 依赖均符合 SPEC', () => {
  const pkg = readJsonFile(path.join(BUNDLE, 'package.json'))
  assert.equal(pkg.name, '@local/dsh-companion')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'], './lib/host.js')
  assert.equal(pkg.exports['./preset'], './lib/preset.js')
  assert.ok('./locale/*.json' in pkg.exports)
  assert.ok('./icon' in pkg.exports)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dependencies, undefined, 'bundle 不得依赖 npm 包')
  assert.equal(pkg.devDependencies, undefined, 'bundle 不得依赖 npm 包')

  for (const file of ['cordis.patch.yml', 'icon.svg', 'data/persona.default.json', 'locale/en.json', 'locale/zh.json', 'lib/host.js', 'lib/preset.js', 'lib/characters.js']) {
    assert.ok(fs.existsSync(path.join(BUNDLE, file)), `bundle 缺少文件：${file}`)
  }

  // 所有 JS 源码只能 import node:* 内置模块或包内相对路径
  const jsFiles = walk(path.join(BUNDLE, 'lib'), (file) => file.endsWith('.js'))
  assert.ok(jsFiles.length >= 15, `lib 源码数量异常：${jsFiles.length}`)
  const importPattern = /(?:^|\n)\s*(?:import|export)\s[^\n]*?from\s+['"]([^'"]+)['"]/gu
  for (const file of jsFiles) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/'),
        `${path.relative(BUNDLE, file)} 引入了不受支持的模块：${specifier}`,
      )
    }
    // 不应出现 require(...) 形式
    assert.ok(!/(?:^|\n)\s*const\s+[\w\s{},]+\s*=\s*require\(/u.test(source), `${path.relative(BUNDLE, file)} 不应使用 require()`)
  }

  // cordis.patch.yml 关键行（方案 A：host/preset/qq 均按默认数据目录解析；charactersDir 为注释示例）
  const patch = fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8')
  for (const fragment of [
    '- insert:',
    'id: companion-host',
    "name: '@local/dsh-companion'",
    'checkIntervalMinutes: 10',
    'id: preset-companion',
    "'@deepseek-ai/dsh-agent-preset'",
    'id: companion',
    'name: 情感陪伴 · 奥菲莉亚',
    'description: 奥菲莉亚',
    'order: 20',
    'id: companion-core',
    "name: '@local/dsh-companion/preset'",
    'characterId: ophelia',
    'id: time-context',
    'id: tool-ask-user',
    'id: tool-web',
    'id: tool-schedule',
    'id: compaction',
  ]) {
    assert.ok(patch.includes(fragment), `cordis.patch.yml 缺少片段：${fragment}`)
  }
  // 公开版模板：charactersDir 只以注释示例出现，默认走 DSH_PET_DATA_DIR；不得含盘符绝对路径
  assert.match(patch, /#\s*charactersDir:/, 'charactersDir 应以注释示例形式给出')
  assert.match(patch, /DSH_PET_DATA_DIR/, '注释应说明 DSH_PET_DATA_DIR')
  assert.doesNotMatch(patch, /^\s*charactersDir:/m, 'patch 不应保留活动的 charactersDir 绝对路径')
  assert.doesNotMatch(patch, /^\s*dataDir:/m, 'bundle patch 应使用 charactersDir 而非根 dataDir')
  assert.doesNotMatch(patch, /\b[A-Za-z]:[\\/]/, 'patch 不应含盘符绝对路径')

  // locale 中英文元数据完整
  for (const locale of ['en.json', 'zh.json']) {
    const data = readJsonFile(path.join(BUNDLE, 'locale', locale))
    assert.ok(typeof data.meta?.title === 'string' && data.meta.title.length > 0)
    assert.ok(typeof data.meta?.description === 'string' && data.meta.description.length > 0)
  }
  const zh = readJsonFile(path.join(BUNDLE, 'locale', 'zh.json'))
  assert.match(zh.meta.title, /[\u4e00-\u9fff]/u)

  // icon 为合法 SVG
  const icon = fs.readFileSync(path.join(BUNDLE, 'icon.svg'), 'utf8')
  assert.ok(icon.trimStart().startsWith('<svg'))
  assert.ok(icon.includes('xmlns="http://www.w3.org/2000/svg"'))
  assert.ok(icon.trimEnd().endsWith('</svg>'))

  // 默认人设文件为合法中文 JSON，9 模块
  const personaDefault = readJsonFile(path.join(BUNDLE, 'data', 'persona.default.json'))
  assert.equal(personaDefault.modules.length, 9)
  assert.match(personaDefault.character.oneLiner, /[\u4e00-\u9fff]/u)
})

// ───────────────────────────── P10 预设注入（fake ctx 模拟） ─────────────────────────────

test('P10: fake ctx 挂载 preset 插件：注册 deployment:persona-prefix section、companion:memory context、5 个工具与消息监听', () => {
  const dataDir = makeTempDir('dshpet-verify-p10-')
  const { ctx, state } = makeFakeCtx({ sectionOrder: -50 })
  const result = applyPreset(ctx, { dataDir })

  assert.ok(result.persona && result.memory)

  // 1) 人设 section
  assert.equal(state.sections.length, 1)
  const section = state.sections[0]
  assert.equal(section.name, 'deployment:persona-prefix', 'section name 必须是 deployment:persona-prefix')
  assert.equal(section.order, -50, 'order 应使用 getSectionOrder(DEPLOYMENT_PERSONA_PREFIX) 的返回值')
  const sectionText = section.text()
  assert.ok(sectionText.includes('【人设 · 始终生效】'))
  assert.ok(sectionText.includes('【被问到才用的人设资料】'))
  // 不得注入 on_demand 正文（外观模块的发色描述不应出现）
  assert.ok(!sectionText.includes('银白色的长头发'), 'system prompt 不应包含 on_demand 正文')

  // 2) 记忆 context
  assert.equal(state.contexts.length, 1)
  const memoryContext = state.contexts[0]
  assert.equal(memoryContext.name, 'companion:memory')
  assert.equal(memoryContext.order, 130)
  assert.ok(memoryContext.text().includes('【记忆系统 · 自动注入】'))

  // 3) 5 个陪伴工具
  assert.deepEqual(
    state.tools.map((tool) => tool.name).sort(),
    ['memory_note', 'memory_recall', 'memory_status', 'persona_lookup', 'persona_status'],
  )

  // 4) 消息监听（主 + 兜底）
  assert.ok(state.listeners.has('agent/inbox/inserted'))
  assert.ok(state.listeners.has('agent/pre-step'))

  // 5) 模拟 inbox 消息 → 记忆写入 + 动态摘要变化
  const inbox = state.listeners.get('agent/inbox/inserted')
  inbox({ agent: { id: 'agent-1' }, message: { id: 'inbox-msg-1', content: [{ type: 'text', text: '我喜欢草莓蛋糕' }] } })
  assert.ok(result.memory.status().total >= 1)
  assert.ok(memoryContext.text().includes('草莓蛋糕'), '动态记忆摘要应包含新写入记忆')

  // 6) 同一 messageId 经两个监听器重复投递 → 引擎去重（提及不翻倍）
  const totalBefore = result.memory.status().total
  state.listeners.get('agent/inbox/inserted')({
    agent: { id: 'agent-1' },
    message: { id: 'inbox-msg-1', content: [{ type: 'text', text: '我喜欢草莓蛋糕' }] },
  })
  const preStep = state.listeners.get('agent/pre-step')
  const next = () => 'next-called'
  const returned = preStep({ agent: { id: 'agent-1' }, messages: [{ id: 'inbox-msg-1', content: '我喜欢草莓蛋糕' }] }, next)
  assert.equal(returned, 'next-called', 'pre-step 兜底监听必须调用 next()')
  assert.equal(result.memory.status().total, totalBefore, '同一 messageId 重复投递不应重复新增记忆')

  // 7) 兜底监听写入不同 messageId（字符串 content 也应能提取）
  preStep({ agent: { id: 'agent-1' }, messages: [{ id: 'pre-msg-1', content: '我叫小明' }] }, next)
  assert.ok(result.memory.recall('小明').hits.length >= 1, 'pre-step 兜底监听应能写入记忆')

  // 8) effect 清理函数可执行
  assert.ok(state.effects.length >= 3)
  for (const dispose of state.effects) assert.equal(typeof dispose, 'function')
})

// ───────────────────────────── I4 主流程模拟（工具层） ─────────────────────────────

test('I4: 工具定义结构与执行结果（persona_lookup/memory_recall/memory_note/memory_status/persona_status）', async () => {
  const dataDir = makeTempDir('dshpet-verify-i4-')
  const persona = createPersonaService({ dataDir })
  persona.ensure()
  resetMemoryEngineRegistry()
  const memory = getMemoryEngine({ dataDir, clock: { now: () => Date.now() } })
  memory.ensure()
  const tools = createCompanionTools({ persona, memory })
  assert.equal(tools.length, 5)
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string')
    assert.match(tool.description, /[\u4e00-\u9fff]/u, '工具描述应为中文')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(tool.output && tool.output.schema && typeof tool.output.render === 'function')
    assert.equal(typeof tool.execute, 'function')
  }

  // persona_lookup：9 个模块都能查；未知模块返回错误
  for (const moduleId of ['role_definition', 'speech_style', 'herself', 'memory_and_promises', 'rules', 'appearance', 'other_ai_characters', 'identity', 'personal_history']) {
    const value = await byName.persona_lookup.execute({ module: moduleId })
    assert.equal(value.ok, true, `persona_lookup(${moduleId}) 应成功`)
    assert.ok(value.content.length > 0)
    const rendered = byName.persona_lookup.output.render({ module: moduleId }, value)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /[\u4e00-\u9fff]/u)
  }
  const unknown = await byName.persona_lookup.execute({ module: '不存在' })
  assert.equal(unknown.ok, false)
  assert.ok(byName.persona_lookup.output.render({}, unknown)[0].text.includes('没有找到'))
  assert.equal((await byName.persona_lookup.execute({})).ok, false)

  // memory_note：写入 → 关键词 3~5 → 重复写入变 updated
  const noted = await byName.memory_note.execute({
    content: '主人最喜欢草莓味蛋糕，生日时也会吃。',
    keywords: ['草莓蛋糕', '喜欢', '生日'],
    category: '喜好',
    emphasis: 2,
  })
  assert.equal(noted.ok, true)
  assert.equal(noted.action, 'created')
  assert.ok(noted.item.keywords.length >= 3 && noted.item.keywords.length <= 12)
  assert.equal(noted.item.category, '喜好')
  assert.equal(noted.item.mentionCount, 1)
  // 工具的返回结构未包含 emphasis，回查引擎确认强调值已落库
  assert.equal(memory.getItem(noted.item.id).emphasis, 2)
  assert.ok(noted.item.importance >= 40)
  const noteRender = byName.memory_note.output.render({}, noted)[0].text
  assert.ok(noteRender.includes('已写入记忆'))
  assert.ok(noteRender.includes('草莓味蛋糕'))

  const duplicated = await byName.memory_note.execute({ content: '主人最喜欢草莓味蛋糕，生日时也会吃。', keywords: ['草莓蛋糕'] })
  assert.equal(duplicated.action, 'updated')
  assert.ok(byName.memory_note.output.render({}, duplicated)[0].text.includes('增加提及次数'))
  assert.equal((await byName.memory_note.execute({ content: '   ' })).ok, false)

  // memory_recall：能检索到；limit 1~20 夹取；缺 query 报错
  const recalled = await byName.memory_recall.execute({ query: '草莓蛋糕', limit: 3 })
  assert.equal(recalled.ok, true)
  assert.ok(recalled.hits.length >= 1)
  assert.equal(recalled.hits[0].item.content.includes('草莓'), true)
  const recallRender = byName.memory_recall.output.render({}, recalled)[0].text
  assert.ok(recallRender.includes('【记忆检索】'))
  assert.ok((await byName.memory_recall.execute({ query: '' })).ok === false)
  assert.equal((await byName.memory_recall.execute({ query: '草莓蛋糕', limit: 999 })).ok, true)

  // memory_status
  const status = await byName.memory_status.execute({})
  assert.equal(status.ok, true)
  assert.ok(status.total >= 1)
  assert.ok(Array.isArray(status.counts.layers) && status.counts.layers.length === 7)
  assert.ok(byName.memory_status.output.render({}, status)[0].text.includes('【记忆库状态】'))

  // persona_status
  const personaStatus = await byName.persona_status.execute({})
  assert.equal(personaStatus.ok, true)
  assert.equal(personaStatus.validation.ok, true)
  assert.equal(personaStatus.modules.length, 9)
  assert.equal(personaStatus.characterName, '铃兰')
  const personaRender = byName.persona_status.output.render({}, personaStatus)[0].text
  assert.ok(personaRender.includes('【人设状态】'))
  assert.ok(personaRender.includes('校验通过'))
})

// ───────────────────────────── Host 插件 5.3 ─────────────────────────────

test('Host 插件: 启动立即检查（含首次维护）与定时检查，副作用通过 ctx.effect 清理', () => {
  // 纯函数 runMaintenanceCheck
  const calls = []
  const fakeEngine = {
    checkMaintenance: () => ({ shouldRun: true, reason: '每日凌晨维护窗口' }),
    maintain: (options) => {
      calls.push(options)
      return { ok: true, transferred: 0 }
    },
  }
  const ran = runMaintenanceCheck(fakeEngine, { now: () => 123456 })
  assert.equal(ran.ran, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].at, 123456)
  assert.equal(calls[0].reason, '每日凌晨维护窗口')

  const skip = runMaintenanceCheck({ checkMaintenance: () => ({ shouldRun: false }), maintain: () => assert.fail('不应维护') }, { now: () => 1 })
  assert.equal(skip.ran, false)

  // apply 挂到 fake ctx：使用 fake timer，避免真实定时器泄漏
  const captured = []
  const timer = {
    timeout: (fn, ms) => {
      captured.push({ kind: 'timeout', fn, ms })
      return () => {}
    },
    interval: (fn, ms) => {
      captured.push({ kind: 'interval', fn, ms })
      return () => {}
    },
  }
  const dataDir = makeTempDir('dshpet-verify-host-')
  const { ctx, state } = makeFakeCtx({ timer })
  const result = applyHost(ctx, { dataDir, checkIntervalMinutes: 10, bilibili: { enabled: false } })
  assert.ok(result.engine)
  assert.equal(captured.length, 2, '应注册启动检查与周期检查')
  assert.equal(captured.find((entry) => entry.kind === 'interval').ms, 10 * 60 * 1000)
  assert.ok(state.effects.length >= 2)

  // 执行启动检查 → 首次运行初始化维护（引擎无维护记录）
  captured.find((entry) => entry.kind === 'timeout').fn()
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'meta.json'), 'utf8'))
  assert.ok(meta.lastMaintenanceAt, '启动检查应触发首次维护并记录 lastMaintenanceAt')
  assert.ok(Array.isArray(meta.maintenanceHistory) && meta.maintenanceHistory.length >= 1)

  // 再次执行定时检查：今天已维护，不应重复维护
  const historyBefore = meta.maintenanceHistory.length
  captured.find((entry) => entry.kind === 'interval').fn()
  const metaAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'meta.json'), 'utf8'))
  assert.equal(metaAfter.maintenanceHistory.length, historyBefore, '当天已维护后定时检查不应重复维护')

  // 清理函数可执行
  for (const dispose of state.effects) {
    if (typeof dispose === 'function') dispose()
  }
})

// ───────────────────────────── 修复后复验（RISK-01 / DEV-03） ─────────────────────────────

test('DEV-03 修复复验: host.js 导出契约含 inject = []（SPEC 5.3）', () => {
  assert.equal(hostModule.name, 'companion-host')
  assert.equal(typeof hostModule.apply, 'function')
  assert.ok(Array.isArray(hostModule.inject), 'host.js 必须导出 inject 数组')
  assert.deepEqual(hostModule.inject, [], 'host 插件不声明强制依赖（timer 为可选服务）')
})

test('RISK-01 修复复验: preset 消息监听按 source.kind 过滤，只把用户来源消息写入记忆', () => {
  const dataDir = makeTempDir('dshpet-verify-risk01-')
  const { ctx, state } = makeFakeCtx()
  const { memory } = applyPreset(ctx, { dataDir })
  const inbox = state.listeners.get('agent/inbox/inserted')
  const preStep = state.listeners.get('agent/pre-step')
  const next = () => 'next'
  const total = () => memory.status().total

  // 1) 真实用户消息（DSH 以 source.kind='user' 创建用户消息）→ 写入
  inbox({ agent: { id: 'agent-1' }, message: { id: 'src-user-1', content: [{ type: 'text', text: '我喜欢草莓蛋糕' }], source: { kind: 'user' } } })
  assert.equal(total(), 1, 'source.kind=user 的消息应写入记忆')
  assert.ok(memory.recall('草莓蛋糕').hits.length >= 1)

  // 2) 插件注入消息（agent-instructions）→ 不写入
  inbox({ agent: { id: 'agent-1' }, message: { id: 'src-agent-1', content: [{ type: 'text', text: '系统提醒：我不喜欢香蕉，我叫机器人' }], source: { kind: 'agent-instructions' } } })
  assert.equal(total(), 1, 'agent-instructions 消息不应写入记忆')

  // 3) 其他插件来源（DSH 文档示例 kind='my-plugin'）→ 不写入
  inbox({ agent: { id: 'agent-1' }, message: { id: 'src-plugin-1', content: [{ type: 'text', text: '插件注入：记住我喜欢苹果' }], source: { kind: 'my-plugin' } } })
  assert.equal(total(), 1, '非用户来源消息不应写入记忆')

  // 4) 无 source 字段（旧行为/合成消息）→ 按用户消息处理，保持向后兼容
  inbox({ agent: { id: 'agent-1' }, message: { id: 'src-none-1', content: [{ type: 'text', text: '我叫小明' }] } })
  assert.equal(total(), 2, '无 source 的消息应保持向后兼容、按用户消息处理')

  // 5) pre-step 兜底监听同样过滤
  preStep({ agent: { id: 'agent-1' }, messages: [{ id: 'pre-agent-1', content: '注入内容：我不喜欢香菜', source: { kind: 'agent-instructions' } }] }, next)
  assert.equal(total(), 2, 'pre-step 兜底同样应过滤非用户来源消息')
  preStep({ agent: { id: 'agent-1' }, messages: [{ id: 'pre-user-1', content: '我最近有点焦虑', source: { kind: 'user' } }] }, next)
  assert.equal(total(), 3, 'pre-step 应写入 source.kind=user 的用户消息')
})
