/**
 * 覆盖验收项：P10（人设注入模拟）、I4（主流程模拟）、M6/M7 的插件侧联动、I6（数据隔离）。
 * 用 fake Cordis ctx 挂载 host.js / preset.js，验证注册面与端到端行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply as applyPreset, extractMessageText } from '../../lib/preset.js'
import { apply as applyHost, normalizeConfig, runMaintenanceCheck } from '../../lib/host.js'
import { createFixedClock } from '../../lib/shared/clock.js'
import { getMemoryEngine, resetMemoryEngineRegistry } from '../../lib/memory/index.js'

const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 最小 fake Cordis ctx：记录 effect 注册的 section / context / tool / event。 */
function createFakeCtx({ timer = false } = {}) {
  const state = { sections: [], contexts: [], tools: [], events: new Map(), effects: 0, intervals: [] }
  const ctx = {
    effect(fn) {
      state.effects += 1
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on(name, handler) {
      const list = state.events.get(name) ?? []
      list.push(handler)
      state.events.set(name, list)
      return () => {
        const current = state.events.get(name) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    get(name) {
      if (name === 'timer') {
        return {
          timeout: (callback) => {
            state.startupCheck = callback
            return () => {}
          },
          interval: (callback, ms) => {
            state.intervals.push({ callback, ms })
            return () => {}
          },
        }
      }
      return undefined
    },
    systemPrompt: {
      section(section) {
        state.sections.push(section)
        return () => {}
      },
      context(context) {
        state.contexts.push(context)
        return () => {}
      },
      getSectionOrder() {
        return 0
      },
    },
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {}
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    emit(name, ...args) {
      const list = state.events.get(name) ?? []
      return list.map((handler) => handler(...args))
    },
  }
  return { ctx, state }
}

function textOf(block) {
  return block?.type === 'text' ? block.text : ''
}

test('P10/I4：preset 插件注册人设段、记忆上下文与 5 个陪伴工具', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-preset-'))
  t.after(() => {
    resetMemoryEngineRegistry()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const { ctx, state } = createFakeCtx()
  const api = applyPreset(ctx, { dataDir })

  // 1) 人设 section：shadow deployment:persona-prefix
  const section = state.sections.find((entry) => entry.name === 'deployment:persona-prefix')
  assert.ok(section, '必须注册 deployment:persona-prefix section')
  assert.equal(typeof section.text, 'function')
  const personaText = section.text()
  assert.match(personaText, /【人设 · 始终生效】/)
  assert.match(personaText, /【说话风格】|说话风格/)
  assert.match(personaText, /【被问到才用的人设资料】/)
  const definition = api.persona.getDefinition()
  const onDemand = definition.modules.filter((module) => module.activation === 'on_demand')
  assert.equal(onDemand.length, 5)
  for (const module of onDemand) {
    assert.ok(!personaText.includes(module.content), `on_demand 模块正文不得出现在 system prompt：${module.id}`)
  }

  // 2) 记忆上下文
  const memoryContext = state.contexts.find((entry) => entry.name === 'companion:memory')
  assert.ok(memoryContext, '必须注册 companion:memory context')
  assert.match(memoryContext.text(), /记忆/)
  assert.ok(!memoryContext.text().includes('{{'), '记忆上下文必须按字面注入（interpolate: false）')

  // 3) 工具注册
  const toolNames = state.tools.map((tool) => tool.name)
  for (const expected of ['persona_lookup', 'memory_recall', 'memory_note', 'memory_status', 'persona_status']) {
    assert.ok(toolNames.includes(expected), `缺少工具：${expected}`)
  }
  for (const tool of state.tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output?.render, 'function')
    assert.equal(tool.parameters?.type, 'object')
  }

  // 4) 用户消息进入记忆（含自动抽取 + 提及去重）
  const message = {
    id: 'msg-1',
    content: [
      { type: 'text', text: '我最喜欢草莓味蛋糕了，一定要记住哦。' },
    ],
  }
  assert.equal(extractMessageText(message), '我最喜欢草莓味蛋糕了，一定要记住哦。')
  ctx.emit('agent/inbox/inserted', { agent: { id: 'session-1' }, message })
  const memoryStatus = state.tools.find((tool) => tool.name === 'memory_status')
  const statusAfterIngest = await memoryStatus.execute({}, {})
  assert.equal(statusAfterIngest.ok, true)
  assert.ok(statusAfterIngest.total >= 1, '自动抽取应至少产生 1 条记忆')
  const digest = memoryContext.text()
  assert.match(digest, /草莓/, '记忆上下文应包含刚写入的记忆')

  // 5) 工具能力：persona_lookup / memory_note / memory_recall / persona_status
  const personaLookup = state.tools.find((tool) => tool.name === 'persona_lookup')
  const lookup = await personaLookup.execute({ module: 'appearance' }, {})
  assert.equal(lookup.ok, true)
  assert.ok(lookup.content.length > 0)
  assert.match(textOf(personaLookup.output.render({ module: 'appearance' }, lookup)[0]), /外貌|发色|耳朵|尾巴/)
  const missingLookup = await personaLookup.execute({ module: '不存在的模块' }, {})
  assert.equal(missingLookup.ok, false)
  assert.ok(Array.isArray(missingLookup.available))

  const memoryNote = state.tools.find((tool) => tool.name === 'memory_note')
  const noted = await memoryNote.execute(
    { content: '主人喜欢夜里听雨声。', keywords: ['雨声', '夜晚', '喜欢'], category: '喜好' },
    {},
  )
  assert.equal(noted.ok, true)
  assert.equal(noted.item.category, '喜好')
  assert.equal(noted.item.keywords.length >= 3, true)
  const noteRender = memoryNote.output.render({}, noted)
  assert.match(textOf(noteRender[0]), /已写入记忆|已增加提及次数/)

  const memoryRecall = state.tools.find((tool) => tool.name === 'memory_recall')
  const recalled = await memoryRecall.execute({ query: '雨声' }, {})
  assert.equal(recalled.ok, true)
  assert.ok(recalled.hits.length >= 1)
  assert.ok(['short', 1, 2, 3, 4, 5, 6, 7].includes(recalled.hits[0].layer))
  assert.ok(recalled.searchedLayers.length >= 1)

  const personaStatus = state.tools.find((tool) => tool.name === 'persona_status')
  const personaStatusResult = await personaStatus.execute({}, {})
  assert.equal(personaStatusResult.ok, true)
  assert.equal(personaStatusResult.validation.ok, true)
  assert.equal(personaStatusResult.modules.length, 9)
})

test('P10：preset 插件对同一 messageId 的重复事件只计一次提及', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-dedupe-'))
  t.after(() => {
    resetMemoryEngineRegistry()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const { ctx } = createFakeCtx()
  const api = applyPreset(ctx, { dataDir })
  api.memory.remember({ content: '主人喜欢草莓味蛋糕。', keywords: ['草莓蛋糕', '喜欢', '甜品'], category: '喜好' })
  const before = api.memory.listLayer('short').find((item) => item.content.includes('草莓'))
  assert.ok(before)

  const message = { id: 'dup-1', content: [{ type: 'text', text: '我又想起草莓蛋糕了' }] }
  ctx.emit('agent/inbox/inserted', { agent: { id: 's1' }, message })
  const once = api.memory.getItem(before.id)
  assert.equal(once.mentionCount, before.mentionCount + 1)

  // 兜底监听（pre-step）对同一 messageId 再触发一次，不应重复计数
  ctx.emit('agent/pre-step', { agent: { id: 's1' }, messages: [message] }, () => Promise.resolve({}))
  const twice = api.memory.getItem(before.id)
  assert.equal(twice.mentionCount, once.mentionCount)
})

test('I4：host 插件初始化数据目录并执行每日维护（首次运行 / 窗口内）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-host-'))
  t.after(() => {
    resetMemoryEngineRegistry()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const { ctx, state } = createFakeCtx({ timer: true })
  const api = applyHost(ctx, { dataDir, checkIntervalMinutes: 5, bilibili: { enabled: false } })

  assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'meta.json')), 'Host 插件应初始化数据目录')
  assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'short-term.json')))
  assert.equal(state.intervals.length, 1)
  assert.equal(state.intervals[0].ms, 5 * 60 * 1000)
  assert.equal(typeof state.startupCheck, 'function')

  // 固定时钟 05:00（维护窗口内）→ 首次运行应执行维护
  const clock = createFixedClock('2026-11-05T05:00:00+08:00')
  api.engine.remember({ content: '主人喜欢草莓味蛋糕。', keywords: ['草莓蛋糕', '喜欢', '甜品'], category: '喜好' })
  const result = runMaintenanceCheck(api.engine, clock)
  assert.equal(result.ran, true, `首次维护应执行，实际：${JSON.stringify(result.check)}`)
  assert.ok(fs.existsSync(path.join(dataDir, 'memory', '记忆总览.md')))
  const status = api.engine.status()
  assert.equal(status.counts.short, 0, '夜间转移后短期记忆应清空')
  assert.ok(status.lastMaintenanceAt)

  // 当天再次检查不应重复维护
  const again = runMaintenanceCheck(api.engine, clock)
  assert.equal(again.ran, false)
})

test('I4：host 插件 6 点后补跑并遵守配置', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-catchup-'))
  t.after(() => {
    resetMemoryEngineRegistry()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const { ctx } = createFakeCtx()
  const api = applyHost(ctx, { dataDir, bilibili: { enabled: false } })
  const clock = createFixedClock('2026-11-05T14:00:00+08:00')
  const result = runMaintenanceCheck(api.engine, clock)
  assert.equal(result.ran, true)
  assert.match(result.check.reason, /补跑|首次/)
  assert.equal(api.engine.status().lastMaintenanceDateKey, '2026-11-05')
})

test('I4：normalizeConfig 使用可移植默认数据目录并解析相对路径', () => {
  const defaults = normalizeConfig({})
  const expectedDefaultDataDir = path.resolve(
    process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data'),
  )
  assert.equal(defaults.dataDir, expectedDefaultDataDir)
  assert.equal(defaults.checkIntervalMinutes, 10)
  const custom = normalizeConfig({ dataDir: 'D:/tmp/x', checkIntervalMinutes: 3 })
  assert.equal(custom.dataDir, path.resolve('D:/tmp/x'))
  assert.equal(custom.checkIntervalMinutes, 3)
})
