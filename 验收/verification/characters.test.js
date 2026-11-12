/**
 * 独立验收测试 · 方案 A 多角色（C1–C5）
 * 覆盖验收编号：C1（角色目录隔离）、C2（Host 多角色维护）、C3（预设按 characterId 解析）、
 *             C4（新增角色脚本/创建）、C5（旧版单目录兼容）
 * 另含边界：非法角色 id / 路径穿越、缺人设、重复创建不覆盖、charactersDir 不存在、
 *           legacy 回退、多角色热纳入、跨 charactersDir 同名角色隔离、脚本级 add/migrate。
 *
 * 测试由验收员 verifier 独立设计编写，不复用开发者测试；
 * 全部数据写入 fs.mkdtempSync 系统临时目录，不读写仓库内 companion-data。
 * 依据：docs/SPEC.md 第 8 节、验收/验收标准.md D 节（C1–C5）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_CHARACTERS_DIR,
  DEFAULT_CHARACTER_ID,
  DEFAULT_DATA_DIR,
  buildCharacterPresetSnippet,
  createCharacter,
  getCharacter,
  listCharacters,
  readCharacterMeta,
  resolveCharactersRoot,
  suggestCharacterOrder,
} from '../../companion-bundle/lib/characters.js'
import { characterDataDir, isValidCharacterId } from '../../companion-bundle/lib/shared/paths.js'
import { createPersonaService } from '../../companion-bundle/lib/persona/index.js'
import { getMemoryEngine, resetMemoryEngineRegistry } from '../../companion-bundle/lib/memory/index.js'
import { apply as applyPreset, normalizeConfig as normalizePresetConfig } from '../../companion-bundle/lib/preset.js'
import {
  apply as applyHost,
  hasLegacyData,
  listMaintenanceTargets,
  normalizeConfig as normalizeHostConfig,
  runAllMaintenance,
} from '../../companion-bundle/lib/host.js'
import { cleanupTempDirs, localMs, makeClock, makeTempDir } from './helpers.mjs'

test.after(cleanupTempDirs)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLE = path.join(ROOT, 'companion-bundle')
const SCRIPTS = path.join(ROOT, 'scripts')
const DEFAULT_TEMPLATE = path.join(BUNDLE, 'data', 'persona.default.json')
const PATCH_FILE = path.join(BUNDLE, 'cordis.patch.yml')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 极简 fake Cordis ctx（自写，不复用开发者测试）。 */
function createFakeCtx() {
  const state = { sections: [], contexts: [], tools: [], events: new Map(), timerHandlers: [], logs: [] }
  const ctx = {
    logger: {
      info: (message) => state.logs.push({ level: 'info', message }),
      warn: (message) => state.logs.push({ level: 'warn', message }),
      error: (message) => state.logs.push({ level: 'error', message }),
    },
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
      if (name !== 'timer') return undefined
      return {
        timeout: (fn) => {
          state.timerHandlers.push({ kind: 'timeout', fn })
          return () => {}
        },
        interval: (fn, ms) => {
          state.timerHandlers.push({ kind: 'interval', fn, ms })
          return () => {}
        },
      }
    },
    systemPrompt: {
      getSectionOrder: () => -50,
      section: (section) => {
        state.sections.push(section)
        return () => {}
      },
      context: (context) => {
        state.contexts.push(context)
        return () => {}
      },
    },
    tools: {
      register: (definition) => {
        state.tools.push(definition)
        return () => {}
      },
    },
    emit(name, ...args) {
      for (const handler of state.events.get(name) ?? []) handler(...args)
    },
  }
  return { ctx, state }
}

/** 创建两个隔离角色（alpha 小甲 / beta 小乙）。 */
function seedTwoCharacters() {
  const root = makeTempDir('dshpet-verify-chars-')
  const charactersDir = path.join(root, 'characters')
  const alpha = createCharacter({ charactersDir, id: 'alpha', name: '小甲', defaultPersonaFile: DEFAULT_TEMPLATE })
  const beta = createCharacter({ charactersDir, id: 'beta', name: '小乙', defaultPersonaFile: DEFAULT_TEMPLATE })
  return { root, charactersDir, alpha, beta }
}

// ───────────────────────────── C1 角色目录隔离 ─────────────────────────────

test('C1: 两角色目录/人设/记忆完全隔离，A 的记忆 B 检索不到', () => {
  const { charactersDir, alpha, beta } = seedTwoCharacters()
  assert.notEqual(alpha.dataDir, beta.dataDir)
  assert.equal(alpha.dataDir, path.join(path.resolve(charactersDir), 'alpha'))
  assert.equal(beta.dataDir, path.join(path.resolve(charactersDir), 'beta'))

  for (const character of [alpha, beta]) {
    assert.ok(fs.existsSync(path.join(character.dataDir, 'character.json')), '缺少 character.json')
    assert.ok(fs.existsSync(path.join(character.dataDir, 'persona', 'persona.json')), '缺少 persona/persona.json')
    assert.ok(fs.existsSync(path.join(character.dataDir, 'memory')), '缺少 memory/')
    const meta = readJson(path.join(character.dataDir, 'character.json'))
    for (const field of ['id', 'name', 'role', 'order', 'createdAt']) {
      assert.ok(Object.prototype.hasOwnProperty.call(meta, field), `character.json 缺字段：${field}`)
    }
  }
  assert.equal(readJson(path.join(alpha.dataDir, 'character.json')).name, '小甲')
  assert.equal(readJson(path.join(beta.dataDir, 'character.json')).name, '小乙')

  // 人设互相独立：模板换名后各自只含自己的名字
  const personaA = createPersonaService({ dataDir: alpha.dataDir, defaultPersonaFile: DEFAULT_TEMPLATE })
  personaA.ensure()
  const personaB = createPersonaService({ dataDir: beta.dataDir, defaultPersonaFile: DEFAULT_TEMPLATE })
  personaB.ensure()
  assert.equal(personaA.getDefinition().character.name, '小甲')
  assert.equal(personaB.getDefinition().character.name, '小乙')
  const sectionA = personaA.renderPersonaSection()
  const sectionB = personaB.renderPersonaSection()
  assert.ok(sectionA.includes('小甲'))
  assert.ok(!sectionA.includes('小乙'), '小甲的人设不得出现小乙的名字')
  assert.ok(sectionB.includes('小乙'))
  assert.ok(!sectionB.includes('小甲'))

  // 记忆互相不可见
  const clock = makeClock(localMs(2026, 11, 5, 20, 0))
  const engineA = getMemoryEngine({ dataDir: alpha.dataDir, clock })
  engineA.ensure()
  const engineB = getMemoryEngine({ dataDir: beta.dataDir, clock })
  engineB.ensure()
  assert.notEqual(engineA, engineB, '不同角色必须是不同的记忆引擎实例（不同 dataDir）')
  engineA.remember({ content: '主人只告诉小甲：他最喜欢草莓味蛋糕。', keywords: ['草莓蛋糕', '喜欢', '小甲'] })
  assert.ok(engineA.status().total >= 1)
  assert.equal(engineB.status().total, 0, '小乙的记忆库必须为空')
  assert.equal(engineB.recall('草莓蛋糕').hits.length, 0, '小乙检索不到小甲的记忆')
  assert.ok(engineA.recall('草莓蛋糕').hits.length >= 1)

  // 反向：小乙写入后小甲也看不到
  engineB.remember({ content: '主人只告诉小乙：他养了一只叫豆豆的猫。', keywords: ['豆豆', '猫', '小乙'] })
  assert.equal(engineA.recall('豆豆').hits.length, 0, '小甲检索不到小乙的记忆')
  assert.equal(engineA.status().total, 1)

  // 人设文件编辑互不影响
  const definitionA = readJson(path.join(alpha.dataDir, 'persona', 'persona.json'))
  definitionA.character.name = '小甲改名'
  definitionA.modules.find((module) => module.id === 'role_definition').content = '这是小甲专属的角色定义。'
  fs.writeFileSync(path.join(alpha.dataDir, 'persona', 'persona.json'), JSON.stringify(definitionA, null, 2) + '\n', 'utf8')
  personaA.reload()
  assert.equal(personaA.getDefinition().character.name, '小甲改名')
  const personaBAfter = createPersonaService({ dataDir: beta.dataDir, defaultPersonaFile: DEFAULT_TEMPLATE })
  personaBAfter.ensure()
  assert.equal(personaBAfter.getDefinition().character.name, '小乙', '修改小甲人设不得影响小乙')
  assert.ok(!personaBAfter.renderPersonaSection().includes('小甲专属'))
})

test('C1 边界: 不同 charactersDir 下的同名角色也完全隔离；非法目录名不被扫描', () => {
  const root = makeTempDir('dshpet-verify-chars-edge-')
  const dir1 = path.join(root, 'characters-a')
  const dir2 = path.join(root, 'characters-b')
  const one = createCharacter({ charactersDir: dir1, id: 'same', name: '角色一', defaultPersonaFile: DEFAULT_TEMPLATE })
  const two = createCharacter({ charactersDir: dir2, id: 'same', name: '角色二', defaultPersonaFile: DEFAULT_TEMPLATE })
  assert.notEqual(one.dataDir, two.dataDir)
  assert.equal(readJson(path.join(one.dataDir, 'character.json')).name, '角色一')
  assert.equal(readJson(path.join(two.dataDir, 'character.json')).name, '角色二')

  // 非法目录名 / 空目录 / 非角色目录不应被扫描
  fs.mkdirSync(path.join(dir1, 'Bad Dir'), { recursive: true })
  fs.mkdirSync(path.join(dir1, '中文角色'), { recursive: true })
  fs.mkdirSync(path.join(dir1, '.hidden'), { recursive: true })
  fs.mkdirSync(path.join(dir1, 'emptyrole'), { recursive: true })
  assert.deepEqual(
    listCharacters(dir1).map((character) => character.id),
    ['same'],
    '只应扫描合法 id 且含角色文件的目录',
  )

  // 只有 persona 没有 character.json 的合法目录仍会被列出（name 缺省为目录名）
  const personaOnly = path.join(dir1, 'personaonly')
  fs.mkdirSync(path.join(personaOnly, 'persona'), { recursive: true })
  fs.copyFileSync(DEFAULT_TEMPLATE, path.join(personaOnly, 'persona', 'persona.json'))
  const listed = listCharacters(dir1).find((character) => character.id === 'personaonly')
  assert.ok(listed, '只有人设的合法目录应被扫描到')
  assert.equal(listed.name, 'personaonly')
  assert.equal(listed.hasPersona, true)
  assert.equal(listed.hasMemory, false)
})

// ───────────────────────────── C2 Host 多角色维护 ─────────────────────────────

test('C2: Host 扫描 charactersDir 逐角色独立维护；新增角色热纳入；维护状态互不共享', () => {
  const { charactersDir, alpha, beta } = seedTwoCharacters()
  const settings = normalizeHostConfig({ charactersDir })
  assert.equal(settings.charactersDir, path.resolve(charactersDir))
  assert.equal(settings.dataDir, path.resolve(DEFAULT_DATA_DIR), '多角色模式默认 dataDir 仅作 legacy 回退')

  const { ctx } = createFakeCtx()
  const api = applyHost(ctx, { charactersDir })
  assert.ok(Array.isArray(api.engines) && api.engines.length === 2)
  assert.deepEqual(api.targets().map((target) => target.id), ['alpha', 'beta'])

  const clock = makeClock(localMs(2026, 11, 5, 5, 0))
  const first = runAllMaintenance(settings, clock)
  assert.deepEqual(first.map((result) => result.id), ['alpha', 'beta'])
  for (const result of first) {
    assert.equal(result.ran, true, `${result.id} 首次运行应维护：${JSON.stringify(result.check)}`)
    assert.equal(result.check.reason, '首次运行初始化')
    const meta = readJson(path.join(result.dataDir, 'memory', 'meta.json'))
    assert.equal(meta.lastMaintenanceDateKey, '2026-11-05')
    assert.equal(meta.lastMaintenanceReason, '首次运行初始化')
  }

  // 当天再次检查：逐角色都不重复维护
  const again = runAllMaintenance(settings, clock)
  assert.ok(again.every((result) => result.ran === false), '当天已维护后不应重复维护')

  // 新增角色：无需重启，下一次扫描即热纳入
  createCharacter({ charactersDir, id: 'gamma', name: '小丙', defaultPersonaFile: DEFAULT_TEMPLATE })
  const third = runAllMaintenance(settings, clock)
  assert.deepEqual(third.map((result) => result.id), ['alpha', 'beta', 'gamma'])
  assert.equal(third.find((result) => result.id === 'gamma').ran, true, '新角色应被首次维护')
  assert.equal(third.find((result) => result.id === 'gamma').check.reason, '首次运行初始化')
  assert.equal(third.find((result) => result.id === 'alpha').ran, false, '老角色当天不应被重复维护')
  assert.equal(third.find((result) => result.id === 'beta').ran, false)

  // 逐角色维护内容隔离：只给小甲写短期记忆，次日维护只转移小甲的
  const engineA = getMemoryEngine({ dataDir: alpha.dataDir, clock })
  engineA.ensure()
  engineA.remember({ content: '只属于小甲的维护隔离记忆。', keywords: ['小甲', '隔离', '维护'] })
  const engineAStatusBefore = engineA.status()
  assert.equal(engineAStatusBefore.counts.short, 1)

  clock.set(localMs(2026, 11, 6, 5, 0))
  const nextDay = runAllMaintenance(settings, clock)
  const alphaResult = nextDay.find((result) => result.id === 'alpha')
  const betaResult = nextDay.find((result) => result.id === 'beta')
  assert.equal(alphaResult.report.transferred, 1, '小甲的短期记忆应在小甲自己的维护中转移')
  assert.equal(betaResult.report.transferred, 0, '小乙的维护不应转移小甲的记忆')
  assert.equal(engineA.status().counts.short, 0)
  assert.equal(engineA.status().counts.layers[0], 1)
  assert.equal(getMemoryEngine({ dataDir: beta.dataDir, clock }).status().total, 0)

  // 每个角色各自独立 meta
  const metaA = readJson(path.join(alpha.dataDir, 'memory', 'meta.json'))
  const metaB = readJson(path.join(beta.dataDir, 'memory', 'meta.json'))
  assert.equal(metaA.lastMaintenanceDateKey, '2026-11-06')
  assert.equal(metaB.lastMaintenanceDateKey, '2026-11-06')
  assert.notEqual(metaA.updatedAt, undefined)
})

test('C2/C5 边界: charactersDir 不存在时扫描为空且可创建；空角色 + 有旧数据时回退 legacy', () => {
  const root = makeTempDir('dshpet-verify-chars-empty-')
  const missingDir = path.join(root, 'missing-characters')
  assert.deepEqual(listCharacters(missingDir), [], 'charactersDir 不存在时应返回空列表')
  assert.equal(resolveCharactersRoot(missingDir), path.resolve(missingDir))
  assert.equal(hasLegacyData(path.join(root, 'none')), false)

  // applyHost 会创建角色根目录
  const { ctx } = createFakeCtx()
  const api = applyHost(ctx, { charactersDir: missingDir })
  assert.ok(fs.existsSync(missingDir), 'applyHost 应创建角色根目录')
  assert.deepEqual(api.targets(), [], '空角色目录不应产生维护目标')

  // 多角色目录为空 + 旧目录有数据 → 回退维护旧目录
  const dataDir = path.join(root, 'legacy-data')
  fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true })
  assert.equal(hasLegacyData(dataDir), true)
  const settings = normalizeHostConfig({ charactersDir: missingDir, dataDir })
  assert.deepEqual(listMaintenanceTargets(settings).map((target) => target.id), ['legacy'])

  // 只要多角色目录里有角色，就不再维护旧目录
  createCharacter({ charactersDir: missingDir, id: 'alpha', name: '小甲', defaultPersonaFile: DEFAULT_TEMPLATE })
  assert.deepEqual(listMaintenanceTargets(settings).map((target) => target.id), ['alpha'])
})

// ───────────────────────────── C3 预设按 characterId 解析 ─────────────────────────────

test('C3: preset characterId + charactersDir → 对应角色 dataDir；人设段与消息写入只作用于该角色', () => {
  const { charactersDir, alpha, beta } = seedTwoCharacters()
  const config = normalizePresetConfig({ charactersDir, characterId: 'alpha' })
  assert.equal(config.dataDir, alpha.dataDir)
  assert.equal(config.characterId, 'alpha')
  assert.equal(config.charactersDir, path.resolve(charactersDir))

  const { ctx, state } = createFakeCtx()
  const api = applyPreset(ctx, { charactersDir, characterId: 'alpha' })
  const section = state.sections.find((entry) => entry.name === 'deployment:persona-prefix')
  assert.ok(section, '应注册 deployment:persona-prefix section')
  const sectionText = section.text()
  assert.ok(sectionText.includes('【人设 · 始终生效】'))
  assert.ok(sectionText.includes('小甲'), '预设应使用 alpha 角色的人设文件')
  assert.ok(!sectionText.includes('小乙'), '预设不得使用 beta 的人设')
  assert.ok(!sectionText.includes('铃兰'), '预设不得回退到 bundle 默认模板的人设')
  const memoryContext = state.contexts.find((entry) => entry.name === 'companion:memory')
  assert.ok(memoryContext && memoryContext.order === 130)
  // 已初始化角色不应产生「尚未初始化」告警（OBS-C2 修复的反向断言）
  assert.ok(
    !state.logs.some((entry) => entry.level === 'warn' && entry.message.includes('尚未初始化')),
    '已初始化角色不应产生未知 characterId 告警',
  )

  // 会话消息只写入该角色记忆
  ctx.emit('agent/inbox/inserted', {
    agent: { id: 'session-alpha' },
    message: { id: 'alpha-msg-1', source: { kind: 'user' }, content: [{ type: 'text', text: '我最喜欢草莓味蛋糕了' }] },
  })
  assert.ok(api.memory.status().total >= 1, '小甲的会话应写入小甲记忆')
  const engineBeta = getMemoryEngine({ dataDir: beta.dataDir, clock: makeClock(localMs(2026, 11, 5, 20, 0)) })
  engineBeta.ensure()
  assert.equal(engineBeta.status().total, 0, '小乙记忆不得被小甲会话污染')

  // 反过来：beta 预设只写 beta
  const { ctx: ctxBeta, state: stateBeta } = createFakeCtx()
  const apiBeta = applyPreset(ctxBeta, { charactersDir, characterId: 'beta' })
  assert.ok(stateBeta.sections[0].text().includes('小乙'))
  ctxBeta.emit('agent/inbox/inserted', {
    agent: { id: 'session-beta' },
    message: { id: 'beta-msg-1', source: { kind: 'user' }, content: [{ type: 'text', text: '我最喜欢蓝莓了' }] },
  })
  assert.ok(apiBeta.memory.status().total >= 1)
  assert.equal(getMemoryEngine({ dataDir: alpha.dataDir }).recall('蓝莓').hits.length, 0, '小甲检索不到小乙的记忆')
})

test('C3 边界: dataDir 显式覆盖 characterId（旧配置兼容）；缺省 characterId 时 dataDir 为默认单目录', () => {
  const { charactersDir } = seedTwoCharacters()
  const overrideDir = path.join(makeTempDir('dshpet-verify-chars-override-'), 'custom-data')
  const config = normalizePresetConfig({ charactersDir, characterId: 'alpha', dataDir: overrideDir })
  assert.equal(config.dataDir, path.resolve(overrideDir), 'dataDir 应覆盖 characterId 解析结果（SPEC 8.3）')
  assert.equal(config.characterId, 'alpha')

  const legacy = normalizePresetConfig({ dataDir: overrideDir })
  assert.equal(legacy.dataDir, path.resolve(overrideDir))
  assert.equal(legacy.characterId, undefined)
  assert.equal(normalizePresetConfig({}).dataDir, path.resolve(DEFAULT_DATA_DIR))
})

test('C3 边界: 未知 characterId 会按默认模板占位初始化并发出「尚未初始化」告警（OBS-C2 修复后）', () => {
  const root = makeTempDir('dshpet-verify-chars-unknown-')
  const charactersDir = path.join(root, 'characters')
  const { ctx, state } = createFakeCtx()
  const api = applyPreset(ctx, { charactersDir, characterId: 'notcreated' })
  const unknownDir = path.join(path.resolve(charactersDir), 'notcreated')
  // 行为不变：preset 会按需初始化该目录，人设来自 bundle 默认模板（未改名）
  assert.ok(fs.existsSync(path.join(unknownDir, 'persona', 'persona.json')))
  assert.ok(fs.existsSync(path.join(unknownDir, 'memory', 'meta.json')))
  const definition = readJson(path.join(unknownDir, 'persona', 'persona.json'))
  assert.equal(definition.meta.name, '铃兰', '未知角色使用默认模板人设占位')
  assert.ok(!fs.existsSync(path.join(unknownDir, 'character.json')), 'preset 初始化不会写 character.json（需用 add-character 创建）')
  // OBS-C2 修复：必须通过 logger.warn 发出明确告警，提示先运行 add-character 脚本
  const warnings = state.logs.filter((entry) => entry.level === 'warn').map((entry) => entry.message)
  assert.ok(warnings.length >= 1, '未知 characterId 必须产生告警')
  assert.ok(
    warnings.some((message) => message.includes('尚未初始化')),
    `告警应包含「尚未初始化」，实际：${JSON.stringify(warnings)}`,
  )
  assert.ok(
    warnings.some((message) => message.includes('add-character')),
    `告警应提示 add-character 脚本，实际：${JSON.stringify(warnings)}`,
  )
  // 仍能正常渲染与写入（不崩溃）
  assert.ok(state.sections[0].text().includes('【人设 · 始终生效】'))
  assert.ok(api.memory)
})

// ───────────────────────────── C4 新增角色创建 ─────────────────────────────

test('C4: createCharacter 建目录/人设/元数据并校验；非法 id 与缺人设被拒绝；重复创建不覆盖人设', () => {
  const root = makeTempDir('dshpet-verify-chars-create-')
  const charactersDir = path.join(root, 'characters')

  const created = createCharacter({ charactersDir, id: 'alpha', name: '小甲', defaultPersonaFile: DEFAULT_TEMPLATE, order: 21 })
  assert.equal(created.ok, true, `默认模板创建应通过校验：${JSON.stringify(created.validation)}`)
  assert.equal(created.validation.ok, true)
  assert.deepEqual(created.validation.errors, [])
  assert.equal(created.dataDir, path.join(path.resolve(charactersDir), 'alpha'))
  assert.ok(fs.existsSync(path.join(created.dataDir, 'character.json')))
  assert.ok(fs.existsSync(path.join(created.dataDir, 'persona', 'persona.json')))
  assert.ok(fs.existsSync(path.join(created.dataDir, 'memory')))
  const meta = readJson(created.metaFile)
  assert.equal(meta.schemaVersion, 1)
  assert.equal(meta.id, 'alpha')
  assert.equal(meta.name, '小甲')
  assert.equal(meta.order, 21)
  assert.equal(meta.personaSource, 'template')
  assert.ok(meta.createdAt && meta.updatedAt)
  // 模板换名：人设中不应残留「铃兰」
  const personaText = fs.readFileSync(created.personaFile, 'utf8')
  assert.ok(personaText.includes('小甲'))
  assert.ok(!personaText.includes('铃兰'), '模板换名后不应残留旧角色名')

  assert.deepEqual(listCharacters(charactersDir).map((character) => character.id), ['alpha'])
  assert.equal(getCharacter(charactersDir, 'alpha').name, '小甲')

  // 非法角色 id（含路径穿越）
  for (const badId of ['', 'Bad Id', 'UPPER', '中文角色', '../evil', '../../etc/passwd', 'a'.repeat(33), '-lead', 'a b']) {
    assert.throws(
      () => createCharacter({ charactersDir, id: badId, name: 'X', defaultPersonaFile: DEFAULT_TEMPLATE }),
      /角色 id 非法/u,
      `非法 id 应被拒绝：${JSON.stringify(badId)}`,
    )
    assert.equal(isValidCharacterId(badId), false)
    assert.throws(() => characterDataDir(charactersDir, badId), /角色 id 非法/u)
  }

  // 缺人设源被拒绝
  assert.throws(
    () => createCharacter({ charactersDir, id: 'nopersona', name: '无人设' }),
    /缺少人设文件/u,
  )
  assert.throws(
    () => createCharacter({ charactersDir, id: 'badjson', name: '坏人设', personaFile: path.join(root, 'missing.json') }),
    /人设文件不合法|ENOENT|读取文件失败|JSON/u,
  )

  // OBS-C1 修复复验：异常失败时不残留本次新建的角色目录（已存在角色不受影响）
  assert.equal(fs.existsSync(path.join(charactersDir, 'nopersona')), false, '缺人设失败后不应残留角色目录')
  assert.equal(fs.existsSync(path.join(charactersDir, 'badjson')), false, 'personaFile 读取失败后不应残留角色目录')
  const brokenJsonFile = path.join(root, 'broken-persona.json')
  fs.writeFileSync(brokenJsonFile, '{ 这不是合法 JSON ', 'utf8')
  assert.throws(
    () => createCharacter({ charactersDir, id: 'brokenjson', name: '坏 JSON', personaFile: brokenJsonFile }),
    /JSON|读取文件失败/u,
  )
  assert.equal(fs.existsSync(path.join(charactersDir, 'brokenjson')), false, '非法 JSON 失败后不应残留角色目录')
  assert.throws(
    () => createCharacter({ charactersDir, id: 'baddefault', name: '坏模板', defaultPersonaFile: path.join(root, 'missing-template.json') }),
    /默认人设模板不合法/u,
  )
  assert.equal(fs.existsSync(path.join(charactersDir, 'baddefault')), false, '坏模板失败后不应残留角色目录')
  // 已存在角色不受清理影响：同 id 用坏 personaFile 创建失败后，目录与人设原样保留
  const alphaPersonaBefore = fs.readFileSync(created.personaFile, 'utf8')
  assert.throws(
    () => createCharacter({ charactersDir, id: 'alpha', name: '不应生效', personaFile: brokenJsonFile }),
    /JSON|读取文件失败/u,
  )
  assert.ok(fs.existsSync(created.dataDir), '已存在角色目录不应被清理')
  assert.equal(fs.readFileSync(created.personaFile, 'utf8'), alphaPersonaBefore, '已存在角色人设不应被修改/删除')

  // 重复创建：默认不覆盖用户编辑的人设，但更新 character.json 元数据
  const editedPath = path.join(created.dataDir, 'persona', 'persona.json')
  const editedDefinition = readJson(editedPath)
  editedDefinition.modules.find((module) => module.id === 'role_definition').content = '这是主人手改过的小甲角色定义。'
  fs.writeFileSync(editedPath, JSON.stringify(editedDefinition, null, 2) + '\n', 'utf8')
  const beforeBytes = fs.readFileSync(editedPath, 'utf8')
  const again = createCharacter({ charactersDir, id: 'alpha', name: '小甲改名', defaultPersonaFile: DEFAULT_TEMPLATE })
  assert.equal(fs.readFileSync(editedPath, 'utf8'), beforeBytes, '重复创建不得覆盖用户编辑的人设')
  const metaAfter = readJson(again.metaFile)
  assert.equal(metaAfter.name, '小甲改名', 'character.json 元数据允许更新')
  assert.equal(metaAfter.createdAt, meta.createdAt, 'createdAt 应保留')
  assert.equal(again.meta.personaSource, 'existing')

  // overwrite=true 才允许覆盖人设
  const overwritten = createCharacter({ charactersDir, id: 'alpha', name: '小甲覆盖', defaultPersonaFile: DEFAULT_TEMPLATE, overwrite: true })
  assert.ok(fs.readFileSync(overwritten.personaFile, 'utf8').includes('小甲覆盖'))
  assert.ok(!fs.readFileSync(overwritten.personaFile, 'utf8').includes('主人手改过的小甲角色定义'))

  // 现成人设文件：复制并校验
  const customDefinition = readJson(DEFAULT_TEMPLATE)
  customDefinition.meta.name = '自定义甲'
  customDefinition.character.name = '自定义甲'
  const customFile = path.join(root, 'custom-persona.json')
  fs.writeFileSync(customFile, JSON.stringify(customDefinition, null, 2) + '\n', 'utf8')
  const customCreated = createCharacter({ charactersDir, id: 'custom', name: '自定义甲', personaFile: customFile })
  assert.equal(customCreated.ok, true)
  assert.equal(readJson(customCreated.personaFile).character.name, '自定义甲')
  assert.equal(readJson(customCreated.metaFile).personaSource, 'persona-file')

  // 现成人设不合法（modules 非数组）被拒绝，异常路径同样不残留角色目录（OBS-C1 修复）
  const invalidFile = path.join(root, 'invalid-persona.json')
  fs.writeFileSync(invalidFile, JSON.stringify({ modules: 'not-array' }), 'utf8')
  assert.throws(
    () => createCharacter({ charactersDir, id: 'invalid', name: '不合法', personaFile: invalidFile }),
    /人设文件不合法/u,
  )
  assert.equal(fs.existsSync(path.join(charactersDir, 'invalid')), false, '人设不合法失败后不应残留角色目录')

  // order 建议：已有角色时从最大 order+1 起
  const orderRoot = path.join(makeTempDir('dshpet-verify-chars-order-'), 'characters')
  assert.equal(suggestCharacterOrder(orderRoot), 21, '空目录下建议 order 从 21 起')
  createCharacter({ charactersDir: orderRoot, id: 'one', name: '一', defaultPersonaFile: DEFAULT_TEMPLATE })
  createCharacter({ charactersDir: orderRoot, id: 'two', name: '二', defaultPersonaFile: DEFAULT_TEMPLATE })
  assert.equal(suggestCharacterOrder(orderRoot), 23)
})

test('C4: 预设 YAML 片段字段正确、可追加；非法/不完整人设返回校验失败而不静默通过', () => {
  const root = makeTempDir('dshpet-verify-chars-snippet-')
  const charactersDir = path.join(root, 'characters')
  const snippet = buildCharacterPresetSnippet({ charactersDir, id: 'alpha', name: "小甲 O'Neil", order: 22 })
  assert.ok(snippet.includes('- insert:'))
  assert.ok(snippet.includes('id: preset-companion-alpha'))
  assert.ok(snippet.includes("name: '@deepseek-ai/dsh-agent-preset'"))
  assert.ok(snippet.includes('id: companion-alpha'))
  assert.ok(snippet.includes("name: '情感陪伴 · 小甲 O''Neil'"), '中文名与单引号应被正确引用/转义')
  assert.ok(snippet.includes('order: 22'))
  assert.ok(snippet.includes("name: '@local/dsh-companion/preset'"))
  assert.ok(snippet.includes('characterId: alpha'))
  const expectedDir = path.resolve(charactersDir).replaceAll('\\', '/')
  assert.ok(snippet.includes(`charactersDir: '${expectedDir}'`), 'charactersDir 应统一为 / 分隔')
  assert.ok(snippet.trimEnd().split('\n').length > 8)

  // 不完整人设（modules 为空）→ 返回 ok:false + 校验错误（不抛出、不静默通过）
  const emptyModules = { meta: { name: '残缺角色' }, character: { name: '残缺角色', oneLiner: '一句话' }, modules: [] }
  const badFile = path.join(root, 'bad-persona.json')
  fs.writeFileSync(badFile, JSON.stringify(emptyModules, null, 2) + '\n', 'utf8')
  const badResult = createCharacter({ charactersDir, id: 'badrole', name: '残缺角色', personaFile: badFile })
  assert.equal(badResult.ok, false, '不完整人设应返回校验失败')
  assert.ok(badResult.validation.errors.length > 0)
  assert.match(badResult.validation.errors.join('\n'), /模块数量应为 9|缺少模块/u)
  // 残余行为（OBS-C1 异常路径已修复；ok:false 为「已创建但校验失败」，不抛错故不触发清理）：
  // 校验失败的角色目录仍被创建并可被 listCharacters 扫描到，调用方应依据 ok:false 处理。
  assert.deepEqual(listCharacters(charactersDir).map((character) => character.id), ['badrole'])
})

test('C4 脚本级: scripts/add-character.mjs 在临时 charactersDir 创建可扫描角色并输出预设片段（不改 bundle patch）', () => {
  const root = makeTempDir('dshpet-verify-chars-script-')
  const charactersDir = path.join(root, 'characters')
  const patchBefore = fs.readFileSync(PATCH_FILE, 'utf8')
  const result = spawnSync(
    process.execPath,
    [
      path.join(SCRIPTS, 'add-character.mjs'),
      '--id',
      'scriptchar',
      '--name',
      '脚本角色',
      '--characters-dir',
      charactersDir,
    ],
    { encoding: 'utf8', cwd: ROOT },
  )
  assert.equal(result.status, 0, `add-character 脚本应成功：${result.stderr || result.stdout}`)
  assert.ok(result.stdout.includes('角色目录已创建'), '脚本应输出中文成功提示')
  assert.ok(result.stdout.includes('preset-companion-scriptchar'), '脚本应输出预设片段')
  assert.ok(result.stdout.includes('人设校验：通过'), '脚本应输出人设校验结果')

  const characterDir = path.join(charactersDir, 'scriptchar')
  assert.ok(fs.existsSync(path.join(characterDir, 'character.json')))
  assert.ok(fs.existsSync(path.join(characterDir, 'persona', 'persona.json')))
  assert.ok(fs.existsSync(path.join(characterDir, 'memory')))
  assert.equal(readJson(path.join(characterDir, 'character.json')).name, '脚本角色')
  assert.equal(readJson(path.join(characterDir, 'persona', 'persona.json')).character.name, '脚本角色')
  assert.deepEqual(listCharacters(charactersDir).map((character) => character.id), ['scriptchar'])

  // 未加 --write-patch 时不得修改 bundle patch
  assert.equal(fs.readFileSync(PATCH_FILE, 'utf8'), patchBefore, '脚本不得修改 bundle cordis.patch.yml')
})

// ───────────────────────────── C5 旧版单目录兼容 ─────────────────────────────

test('C5: 只配置 dataDir 时按单目录维护；预设 dataDir 兼容；legacy 工具函数正确', () => {
  const root = makeTempDir('dshpet-verify-chars-legacy-')
  const dataDir = path.join(root, 'companion-data')
  const settings = normalizeHostConfig({ dataDir })
  assert.equal(settings.charactersDir, undefined, '只给 dataDir 时应为旧版单目录模式')
  assert.equal(settings.dataDir, path.resolve(dataDir))
  assert.deepEqual(listMaintenanceTargets(settings).map((target) => target.id), ['legacy'])

  const { ctx } = createFakeCtx()
  const api = applyHost(ctx, { dataDir })
  assert.ok(api.engine, '单目录模式应初始化 engine')
  assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'meta.json')))
  assert.deepEqual(api.targets().map((target) => target.id), ['legacy'])

  const clock = makeClock(localMs(2026, 11, 5, 14, 0))
  const results = runAllMaintenance(settings, clock)
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'legacy')
  assert.equal(results[0].ran, true)
  assert.equal(results[0].check.reason, '首次运行初始化')
  assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'short-term.json')))

  // 预设侧旧配置仍可用
  assert.equal(normalizePresetConfig({ dataDir }).dataDir, path.resolve(dataDir))
  // 默认值：无任何配置时 host 用 characters 模式，preset 用默认单目录
  const defaultHost = normalizeHostConfig({})
  assert.equal(defaultHost.charactersDir, path.resolve(DEFAULT_CHARACTERS_DIR))
  assert.equal(DEFAULT_CHARACTERS_DIR, path.join(DEFAULT_DATA_DIR, 'characters'))
  assert.equal(DEFAULT_CHARACTER_ID, 'linglan')
})

test('C5 脚本级: scripts/migrate-to-characters.mjs 迁移 legacy → characters/<id>（move 与 --copy 两种模式）', () => {
  // move 模式
  const root = makeTempDir('dshpet-verify-chars-migrate-')
  const dataDir = path.join(root, 'companion-data')
  fs.mkdirSync(path.join(dataDir, 'persona'), { recursive: true })
  fs.copyFileSync(DEFAULT_TEMPLATE, path.join(dataDir, 'persona', 'persona.json'))
  fs.mkdirSync(path.join(dataDir, 'memory', 'long-term'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'memory', 'short-term.json'), JSON.stringify({ schemaVersion: 1, updatedAt: '2026-11-05T18:34:17+08:00', capacity: 20, items: [] }, null, 2) + '\n', 'utf8')

  const moved = spawnSync(
    process.execPath,
    [path.join(SCRIPTS, 'migrate-to-characters.mjs'), '--data-dir', dataDir, '--id', 'moved', '--name', '迁移角色'],
    { encoding: 'utf8', cwd: ROOT },
  )
  assert.equal(moved.status, 0, `迁移脚本应成功：${moved.stderr || moved.stdout}`)
  assert.ok(moved.stdout.includes('迁移完成'), '脚本应输出中文迁移完成提示')
  assert.ok(moved.stdout.includes('人设校验：通过'))
  const movedDir = path.join(dataDir, 'characters', 'moved')
  assert.ok(fs.existsSync(path.join(movedDir, 'persona', 'persona.json')))
  assert.ok(fs.existsSync(path.join(movedDir, 'memory', 'short-term.json')))
  const movedMeta = readJson(path.join(movedDir, 'character.json'))
  assert.equal(movedMeta.id, 'moved')
  assert.equal(movedMeta.name, '迁移角色')
  assert.equal(movedMeta.personaSource, 'migrated')
  assert.equal(fs.existsSync(path.join(dataDir, 'persona')), false, 'move 模式应清理旧 persona 目录')
  assert.equal(fs.existsSync(path.join(dataDir, 'memory')), false, 'move 模式应清理旧 memory 目录')
  assert.deepEqual(listCharacters(path.join(dataDir, 'characters')).map((character) => character.id), ['moved'])

  // --copy 模式：旧数据保留
  const root2 = makeTempDir('dshpet-verify-chars-migrate-copy-')
  const dataDir2 = path.join(root2, 'companion-data')
  fs.mkdirSync(path.join(dataDir2, 'persona'), { recursive: true })
  fs.copyFileSync(DEFAULT_TEMPLATE, path.join(dataDir2, 'persona', 'persona.json'))
  fs.mkdirSync(path.join(dataDir2, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(dataDir2, 'memory', 'short-term.json'), '{}\n', 'utf8')
  const copied = spawnSync(
    process.execPath,
    [path.join(SCRIPTS, 'migrate-to-characters.mjs'), '--data-dir', dataDir2, '--id', 'copied', '--name', '复制角色', '--copy'],
    { encoding: 'utf8', cwd: ROOT },
  )
  assert.equal(copied.status, 0, `--copy 迁移应成功：${copied.stderr || copied.stdout}`)
  assert.ok(fs.existsSync(path.join(dataDir2, 'persona', 'persona.json')), '--copy 应保留旧 persona')
  assert.ok(fs.existsSync(path.join(dataDir2, 'memory', 'short-term.json')), '--copy 应保留旧 memory')
  assert.ok(fs.existsSync(path.join(dataDir2, 'characters', 'copied', 'persona', 'persona.json')))

  // 无旧数据：脚本安全退出，不创建角色
  const emptyData = path.join(root, 'empty-data')
  fs.mkdirSync(emptyData, { recursive: true })
  const none = spawnSync(
    process.execPath,
    [path.join(SCRIPTS, 'migrate-to-characters.mjs'), '--data-dir', emptyData, '--id', 'none', '--name', '空'],
    { encoding: 'utf8', cwd: ROOT },
  )
  assert.equal(none.status, 0)
  assert.ok(none.stdout.includes('没有可迁移的数据'))
  assert.equal(fs.existsSync(path.join(emptyData, 'characters', 'none')), false)
})

// ───────────────────────────── 配置/文档一致性（C 章节） ─────────────────────────────

test('配置链路: bundle patch / SPEC 第 8 节 / README 多角色章节与方案 A 实现一致', () => {
  const patch = fs.readFileSync(PATCH_FILE, 'utf8')
  // 公开版 patch 是安装模板：charactersDir 以注释示例形式给出，默认走 DSH_PET_DATA_DIR / ~/.dsh/dsh-pet
  assert.match(patch, /#\s*charactersDir: '\/absolute\/path\/to\/companion-data\/characters'/, 'patch 应给出 charactersDir 注释示例')
  assert.match(patch, /DSH_PET_DATA_DIR/, 'patch 注释应说明 DSH_PET_DATA_DIR')
  assert.doesNotMatch(patch, /^\s*charactersDir:/m, 'patch 不应保留活动的 charactersDir 绝对路径')
  assert.ok(patch.includes('characterId: ophelia'), '示例预设应指向 ophelia 角色')
  assert.ok(patch.includes('name: 情感陪伴 · 奥菲莉亚'))
  assert.ok(!patch.includes('characterId: linglan'), '示例角色铃兰已被奥菲莉亚替换，patch 不应再指向 linglan')
  assert.match(patch, /DSH_PET_DATA_DIR|\.dsh\/dsh-pet/, 'patch 应说明默认数据目录来源')

  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'SPEC.md'), 'utf8')
  const section8 = spec.slice(spec.indexOf('## 8. 多角色与数据隔离（方案 A）'))
  assert.ok(section8.length > 0, 'SPEC 应有第 8 节')
  for (const fragment of ['<charactersDir>/<characterId>', 'character.json', 'persona/persona.json', 'memory/', 'characterId', 'C1', 'C5']) {
    assert.ok(section8.includes(fragment), `SPEC 第 8 节缺少说明：${fragment}`)
  }

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const sectionIndex = readme.indexOf('### 7. 多角色：独立人设 + 独立记忆')
  assert.ok(sectionIndex >= 0, 'README 应有多角色章节')
  const section4 = readme.slice(sectionIndex, readme.indexOf('## 快速开始', sectionIndex))
  for (const fragment of ['独立记忆', 'dataDir', 'add-character.mjs', '隔离']) {
    assert.ok(section4.includes(fragment), `README 多角色章节缺少说明：${fragment}`)
  }

  // 脚本存在且可执行（本测试只读文件系统）
  for (const script of ['add-character.mjs', 'migrate-to-characters.mjs']) {
    assert.ok(fs.existsSync(path.join(SCRIPTS, script)), `缺少脚本：${script}`)
  }
})
