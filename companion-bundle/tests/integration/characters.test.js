/**
 * 覆盖验收项：C1（角色目录隔离）、C2（Host 多角色维护）、C3（预设按 characterId 解析）、
 *             C4（角色创建与预设片段）、C5（旧版单目录兼容）。
 *
 * 方案 A：每个角色一个独立 dataDir = <charactersDir>/<characterId>，
 * 人设（persona/persona.json）与记忆（memory/）互不共享。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCharacterPresetSnippet,
  createCharacter,
  getCharacter,
  listCharacters,
  resolveCharactersRoot,
  suggestCharacterOrder,
} from '../../lib/characters.js'
import { createPersonaService } from '../../lib/persona/index.js'
import { getMemoryEngine, resetMemoryEngineRegistry } from '../../lib/memory/index.js'
import { createFixedClock } from '../../lib/shared/clock.js'
import { apply as applyPreset, normalizeConfig as normalizePresetConfig } from '../../lib/preset.js'
import { apply as applyHost, normalizeConfig as normalizeHostConfig, runAllMaintenance } from '../../lib/host.js'

const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const defaultTemplate = path.join(bundleDir, 'data', 'persona.default.json')

/** 最小 fake Cordis ctx。 */
function createFakeCtx() {
  const state = { sections: [], contexts: [], tools: [], events: new Map(), intervals: [], warnings: [] }
  const ctx = {
    effect(fn) {
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
    logger: {
      info() {},
      warn(message) {
        state.warnings.push(String(message))
      },
      error() {},
    },
    emit(name, ...args) {
      const list = state.events.get(name) ?? []
      return list.map((handler) => handler(...args))
    },
  }
  return { ctx, state }
}

function seedCharacters(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-characters-'))
  t.after(() => {
    resetMemoryEngineRegistry()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const charactersDir = path.join(root, 'characters')
  const alpha = createCharacter({ charactersDir, id: 'alpha', name: '小甲', defaultPersonaFile: defaultTemplate })
  const beta = createCharacter({ charactersDir, id: 'beta', name: '小乙', defaultPersonaFile: defaultTemplate })
  return { root, charactersDir, alpha, beta }
}

test('C1：两个角色各自独立的人设与记忆（互不可见）', (t) => {
  const { charactersDir, alpha, beta } = seedCharacters(t)
  assert.equal(alpha.validation.ok, true, `小甲人设校验应通过：${JSON.stringify(alpha.validation)}`)
  assert.equal(beta.validation.ok, true)

  // 目录结构：characters/<id>/{character.json, persona/persona.json, memory/}
  for (const character of [alpha, beta]) {
    assert.ok(fs.existsSync(path.join(character.dataDir, 'character.json')))
    assert.ok(fs.existsSync(path.join(character.dataDir, 'persona', 'persona.json')))
    assert.ok(fs.existsSync(path.join(character.dataDir, 'memory')))
  }
  assert.notEqual(alpha.dataDir, beta.dataDir)

  // 人设互相独立：模板换名后各自是「小甲 / 小乙」
  const personaA = createPersonaService({ dataDir: alpha.dataDir, defaultPersonaFile: defaultTemplate })
  personaA.ensure()
  const personaB = createPersonaService({ dataDir: beta.dataDir, defaultPersonaFile: defaultTemplate })
  personaB.ensure()
  assert.equal(personaA.getDefinition().character.name, '小甲')
  assert.equal(personaB.getDefinition().character.name, '小乙')
  assert.match(personaA.renderPersonaSection(), /小甲/)
  assert.match(personaB.renderPersonaSection(), /小乙/)

  // 记忆互相独立：只写小甲的记忆，小乙完全看不到
  const clock = createFixedClock('2026-11-05T20:00:00+08:00')
  const engineA = getMemoryEngine({ dataDir: alpha.dataDir, clock })
  engineA.ensure()
  const engineB = getMemoryEngine({ dataDir: beta.dataDir, clock })
  engineB.ensure()
  engineA.remember({ content: '主人只告诉小甲：他喜欢草莓味蛋糕。', keywords: ['草莓蛋糕', '喜欢', '小甲'], category: '喜好' })
  assert.ok(engineA.status().total >= 1)
  assert.equal(engineB.status().total, 0, '小乙的记忆库必须为空')
  assert.equal(engineB.recall('草莓蛋糕').hits.length, 0)
  assert.ok(engineA.recall('草莓蛋糕').hits.length >= 1)

  // 角色列表按 order 排序
  const characters = listCharacters(charactersDir)
  assert.deepEqual(characters.map((c) => c.id), ['alpha', 'beta'])
  assert.ok(characters.every((c) => typeof c.order === 'number'))
  assert.equal(getCharacter(charactersDir, 'alpha').name, '小甲')
})

test('C2：Host 插件扫描角色目录并逐角色独立维护（支持新增角色后热纳入）', (t) => {
  const { charactersDir, alpha, beta } = seedCharacters(t)
  const settings = normalizeHostConfig({ charactersDir, checkIntervalMinutes: 5 })
  assert.equal(settings.charactersDir, path.resolve(charactersDir))
  assert.equal(
    settings.dataDir,
    path.resolve(process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')),
    '多角色模式默认 dataDir 仅作 legacy 回退',
  )

  const targets = (() => {
    // 通过 apply 暴露的 targets() 获取当前目标
    const { ctx } = createFakeCtx()
    const api = applyHost(ctx, { charactersDir, checkIntervalMinutes: 5 })
    return api.targets()
  })()
  assert.deepEqual(targets.map((target) => target.id), ['alpha', 'beta'])

  const clock = createFixedClock('2026-11-05T05:00:00+08:00')
  const first = runAllMaintenance(settings, clock)
  assert.equal(first.length, 2)
  for (const result of first) {
    assert.equal(result.ran, true, `${result.id} 首次运行应执行维护：${JSON.stringify(result.check)}`)
    assert.equal(result.engine.status().counts.short, 0)
    const meta = JSON.parse(fs.readFileSync(path.join(result.dataDir, 'memory', 'meta.json'), 'utf8'))
    assert.equal(meta.lastMaintenanceDateKey, '2026-11-05')
    assert.equal(meta.lastMaintenanceReason, '首次运行初始化')
  }

  // 当天再次检查：不应重复维护
  const again = runAllMaintenance(settings, clock)
  assert.ok(again.every((result) => result.ran === false))

  // 新增角色后无需重启 Host：重新扫描即可纳入维护
  createCharacter({ charactersDir, id: 'gamma', name: '小丙', defaultPersonaFile: defaultTemplate })
  const third = runAllMaintenance(settings, clock)
  assert.deepEqual(third.map((result) => result.id), ['alpha', 'beta', 'gamma'])
  assert.equal(third.find((result) => result.id === 'gamma').ran, true, '新角色应被首次维护')
  assert.equal(third.find((result) => result.id === 'alpha').ran, false)

  // 两个角色目录各自有独立的 meta（隔离）
  const metaA = JSON.parse(fs.readFileSync(path.join(alpha.dataDir, 'memory', 'meta.json'), 'utf8'))
  const metaB = JSON.parse(fs.readFileSync(path.join(beta.dataDir, 'memory', 'meta.json'), 'utf8'))
  assert.notEqual(alpha.dataDir, beta.dataDir)
  assert.equal(metaA.lastMaintenanceDateKey, '2026-11-05')
  assert.equal(metaB.lastMaintenanceDateKey, '2026-11-05')
})

test('C3：预设按 characterId + charactersDir 解析到对应角色 dataDir，且只写自己的记忆', async (t) => {
  const { charactersDir, alpha, beta } = seedCharacters(t)
  const config = normalizePresetConfig({ charactersDir, characterId: 'alpha' })
  assert.equal(config.dataDir, alpha.dataDir)
  assert.equal(config.characterId, 'alpha')

  const { ctx, state } = createFakeCtx()
  const api = applyPreset(ctx, { charactersDir, characterId: 'alpha' })
  const section = state.sections.find((entry) => entry.name === 'deployment:persona-prefix')
  assert.match(section.text(), /小甲/)
  const memoryContext = state.contexts.find((entry) => entry.name === 'companion:memory')
  assert.ok(memoryContext)

  ctx.emit('agent/inbox/inserted', {
    agent: { id: 'session-alpha' },
    message: { id: 'msg-alpha-1', source: { kind: 'user' }, content: [{ type: 'text', text: '我最喜欢草莓味蛋糕了' }] },
  })
  assert.ok(api.memory.status().total >= 1, '小甲的会话应写入小甲的记忆')

  const engineBeta = getMemoryEngine({ dataDir: beta.dataDir, clock: createFixedClock('2026-11-05T20:00:00+08:00') })
  engineBeta.ensure()
  assert.equal(engineBeta.status().total, 0, '小乙的记忆不得被小甲的会话污染')

  // 未知 characterId：预设会按默认模板初始化，但必须发出告警（避免误以为是新人设）
  const unknown = createFakeCtx()
  applyPreset(unknown.ctx, { charactersDir, characterId: 'notcreated' })
  assert.ok(
    unknown.state.warnings.some((warning) => warning.includes('尚未初始化')),
    '未知 characterId 必须产生告警',
  )
})

test('C4：createCharacter 创建角色人设/元数据/目录并生成可直接追加的预设片段', (t) => {
  const { charactersDir } = seedCharacters(t)
  assert.equal(suggestCharacterOrder(charactersDir), 23, '已有两个角色后新角色 order 应从 23 起')

  const snippet = buildCharacterPresetSnippet({ charactersDir, id: 'alpha', name: '小甲', order: 22 })
  assert.match(snippet, /id: preset-companion-alpha/)
  assert.match(snippet, /id: companion-alpha/)
  assert.match(snippet, /name: '情感陪伴 · 小甲'/)
  assert.match(snippet, /characterId: alpha/)
  assert.match(snippet, /charactersDir: '.*characters'/)
  assert.match(snippet, /name: '@local\/dsh-companion\/preset'/)

  // 非法 id / 缺少人设源时拒绝创建
  assert.throws(() => createCharacter({ charactersDir, id: 'Bad Id', name: 'X', defaultPersonaFile: defaultTemplate }), /角色 id 非法/)
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-emptychar-'))
  t.after(() => fs.rmSync(emptyDir, { recursive: true, force: true }))
  assert.throws(
    () => createCharacter({ charactersDir: path.join(emptyDir, 'characters'), id: 'nopersona', name: '无人设' }),
    /缺少人设文件/,
  )
  assert.equal(
    fs.existsSync(path.join(emptyDir, 'characters', 'nopersona')),
    false,
    '缺少人设导致创建失败时不应残留角色目录',
  )
  assert.throws(
    () =>
      createCharacter({
        charactersDir: path.join(emptyDir, 'characters'),
        id: 'badjson',
        name: '坏人设',
        personaFile: path.join(emptyDir, 'missing.json'),
      }),
    /读取文件失败|ENOENT|人设文件不合法/u,
  )
  assert.equal(
    fs.existsSync(path.join(emptyDir, 'characters', 'badjson')),
    false,
    '人设文件读取失败时不应残留角色目录',
  )

  // 已存在时默认不覆盖用户编辑的人设
  const before = fs.readFileSync(path.join(charactersDir, 'alpha', 'persona', 'persona.json'), 'utf8')
  createCharacter({ charactersDir, id: 'alpha', name: '小甲改', defaultPersonaFile: defaultTemplate })
  const after = fs.readFileSync(path.join(charactersDir, 'alpha', 'persona', 'persona.json'), 'utf8')
  assert.equal(after, before, '重复创建不应覆盖已有人设')
  assert.equal(getCharacter(charactersDir, 'alpha').meta.name, '小甲改', 'character.json 元数据可更新')
})

test('C5：旧版单目录模式仍然可用（向后兼容）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-legacy-'))
  t.after(() => {
    resetMemoryEngineRegistry()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const dataDir = path.join(root, 'companion-data')
  const settings = normalizeHostConfig({ dataDir })
  assert.equal(settings.charactersDir, undefined)
  assert.equal(settings.dataDir, path.resolve(dataDir))

  const { ctx } = createFakeCtx()
  const api = applyHost(ctx, { dataDir })
  assert.ok(api.engine, '单目录模式应初始化 engine')
  assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'meta.json')))
  assert.deepEqual(api.targets().map((target) => target.id), ['legacy'])

  const clock = createFixedClock('2026-11-05T14:00:00+08:00')
  const results = runAllMaintenance(settings, clock)
  assert.equal(results[0].ran, true)
  assert.equal(results[0].id, 'legacy')

  // 预设侧仍支持显式 dataDir（旧配置）
  assert.equal(normalizePresetConfig({ dataDir }).dataDir, path.resolve(dataDir))
})

test('C1 边界：charactersDir 不存在时列出空角色、Host 仍可回退到 legacy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-empty-'))
  t.after(() => {
    resetMemoryEngineRegistry()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const missingRoot = path.join(root, 'characters')
  assert.deepEqual(listCharacters(missingRoot), [])
  assert.equal(resolveCharactersRoot(missingRoot), path.resolve(missingRoot))

  // legacy dataDir 有数据时，多角色模式为空 → 回退维护旧目录
  const dataDir = path.join(root, 'legacy')
  fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true })
  const settings = normalizeHostConfig({ charactersDir: missingRoot, dataDir })
  const targets = (() => {
    const { ctx } = createFakeCtx()
    return applyHost(ctx, { charactersDir: missingRoot, dataDir }).targets()
  })()
  assert.deepEqual(targets.map((target) => target.id), ['legacy'])
})
