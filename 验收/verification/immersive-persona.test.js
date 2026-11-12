/**
 * 独立验收测试 · 2026-11-06 沉浸式人设 + 输出长度（PE1–PE4 / PL1–PL3 / PP1）
 *
 * 真实数据只读核对：persona/persona.json（沉浸式）、memory（48 条、pending 已吸收）、
 * bundle patch、README/SPEC 文档；校验规则/默认模板/pending 机制在临时目录验证。
 * 不联网、不写 companion-data、不改实现/预设、不重启 Harness。
 * 测试由验收员 verifier 独立设计编写，不复用开发者测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createPersonaService } from '../../companion-bundle/lib/persona/index.js'
import { createReplyEngine, sanitizeReply } from '../../companion-bundle/lib/im/reply-engine.js'
import { splitBubbles } from '../../companion-bundle/lib/im/bubbles.js'
import { normalizeConfig } from '../../companion-bundle/lib/qq-host.js'
import { MemoryEngine } from '../../companion-bundle/lib/memory/engine.js'
import { writeJsonSync } from '../../companion-bundle/lib/shared/fsutil.js'
import { makeFakeLlm, makeStubMemory, makeStubPersona } from './feature-helpers.mjs'
import { cleanupTempDirs, makeTempDir } from './helpers.mjs'

test.after(cleanupTempDirs)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REAL_DIR = path.join(ROOT, 'companion-data', 'characters', 'ophelia')
const PERSONA_FILE = path.join(REAL_DIR, 'persona', 'persona.json')
const MEMORY_DIR = path.join(REAL_DIR, 'memory')
const PENDING_FILE = path.join(MEMORY_DIR, 'pending-seed.json')
const PATCH_FILE = path.join(ROOT, 'companion-bundle', 'cordis.patch.yml')
const DEFAULT_PERSONA = path.join(ROOT, 'companion-bundle', 'data', 'persona.default.json')
const APPLY_SCRIPT = path.join(ROOT, 'scripts', 'apply-ophelia-story-canon.mjs')
const README_FILE = path.join(ROOT, 'README.md')
const SPEC_FILE = path.join(ROOT, 'docs', 'SPEC.md')

// PE1 全字段扫描词表（含任务要求 + 更严格的「模型/平台/系统」）
const AI_TERMS = ['AI', '人工智能', '语言模型', 'DeepSeek', 'deepseek', '底层模型', '平台定位', '角色扮演助手', '非官方角色', '程序', '模型', '平台', '系统']

function readRealPersona() {
  const raw = fs.readFileSync(PERSONA_FILE, 'utf8')
  return { raw, definition: JSON.parse(raw) }
}

function readRealMemory() {
  const short = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, 'short-term.json'), 'utf8'))
  const layers = []
  for (let layer = 1; layer <= 7; layer += 1) {
    layers.push(JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, 'long-term', `layer-${layer}.json`), 'utf8')).items)
  }
  return { shortItems: short.items, layers, all: [...short.items, ...layers.flat()] }
}

function scanStrings(value, visitor, keyPath = '') {
  if (typeof value === 'string') visitor(value, keyPath)
  else if (Array.isArray(value)) value.forEach((item, index) => scanStrings(item, visitor, `${keyPath}[${index}]`))
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) scanStrings(item, visitor, `${keyPath}.${key}`)
  }
}

function findAiHits(definition) {
  const hits = []
  scanStrings(definition, (text, keyPath) => {
    for (const term of AI_TERMS) {
      if (text.includes(term)) hits.push({ term, keyPath, context: text.replace(/\s+/gu, ' ').slice(0, 120) })
    }
  })
  return hits
}

function moduleContent(definition, id) {
  const module = definition.modules.find((entry) => entry.id === id)
  return module ? module.content : ''
}

/** 临时副本上校验（可修改 definition 后再校验）。 */
function validateDefinition(definition) {
  const tmp = makeTempDir('dshpet-verify-immersive-')
  fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'persona', 'persona.json'), JSON.stringify(definition, null, 2), 'utf8')
  const service = createPersonaService({ dataDir: tmp, defaultPersonaFile: path.join(tmp, 'persona', 'persona.json') })
  service.ensure()
  return { service, validation: service.validate(), rendered: service.renderPersonaSection() }
}

// ───────────────────────────── PE1–PE4 人设 ─────────────────────────────

test('PE1: 全字段扫描无 AI/技术层自我认知，身份就是奥菲莉亚·菲尼克斯（人类魔法使）', () => {
  const { definition } = readRealPersona()
  const hits = findAiHits(definition)
  assert.deepEqual(hits, [], `人设仍含 AI/技术层词：${JSON.stringify(hits.slice(0, 10))}`)
  const role = moduleContent(definition, 'role_definition')
  assert.match(role, /你是奥菲莉亚·菲尼克斯/u)
  assert.match(role, /人类魔法使|全职助手/u)
  assert.match(role, /不是别人写好的说明/u)
  assert.equal(definition.meta.note.includes('沉浸式'), true)
  assert.match(definition.meta.editableHint, /不要运行会覆盖人设的导入脚本/u)
  // 不存在常见的「现实层/官方/程序」元叙述
  const raw = JSON.stringify(definition)
  for (const term of ['官方拟人', '底层模型', '平台定位', '语言模型', '角色扮演助手']) {
    assert.ok(!raw.includes(term), `不应出现：${term}`)
  }
})

test('PE2: 模块改写——other_ai 为「其他同僚」、identityFacts 清理、appearance/personal_history 保留', () => {
  const { definition } = readRealPersona()
  const other = definition.modules.find((module) => module.id === 'other_ai_characters')
  assert.equal(other.label, '其他同僚')
  assert.equal(other.activation, 'on_demand')
  for (const keyword of ['白鸦', '墨丘', '纸鸢', '同僚']) assert.ok(other.content.includes(keyword), `其他同僚内容缺少：${keyword}`)
  assert.ok(!other.content.includes('AI 娘') && !other.content.includes('AI娘'))

  const identity = moduleContent(definition, 'identity')
  assert.ok(identity.includes('【她是谁】'))
  assert.ok(identity.includes('【她从哪来】'))
  assert.ok(identity.includes('菲尼克斯之名与凤凰祝福'))

  // identityFacts 删除现实层键
  for (const removed of ['platform_positioning', 'model', 'deepseek_official_relationship']) {
    assert.equal(removed in (definition.identityFacts || {}), false, `identityFacts 不应保留 ${removed}`)
  }
  assert.ok(definition.identityFacts.true_name && definition.identityFacts.academy && definition.identityFacts.phoenix_blessing)

  // character 字段改叙事层
  assert.equal(definition.character.platform, '白昼档案馆 · 第七阅览室')
  assert.match(definition.character.role, /人类魔法使/u)
  assert.equal(definition.character.description, '白昼档案馆 · 凤凰魔法使记录官 No.14')

  // appearance / personal_history 保留且有内容
  const appearance = moduleContent(definition, 'appearance')
  const history = moduleContent(definition, 'personal_history')
  assert.ok(appearance.length > 800, `外貌正文应保留：${appearance.length}`)
  assert.ok(appearance.includes('火纹') && appearance.includes('橙红'))
  assert.ok(history.length > 3000, `个人经历应保留：${history.length}`)
  for (const keyword of ['闭馆之夜', '薇拉', '旧钢笔', '剪报本', '月牙岛', '菲尼克斯']) {
    assert.ok(history.includes(keyword), `个人经历应保留：${keyword}`)
  }
  // memory/rules 已重写：无系统/跨会话/AI 身份披露
  const memory = moduleContent(definition, 'memory_and_promises')
  const rules = moduleContent(definition, 'rules')
  assert.ok(!memory.includes('系统') && !memory.includes('跨会话'))
  assert.ok(!rules.includes('身份披露') && !rules.includes('AI'))
  assert.ok(rules.includes('安全') && rules.includes('链接') && rules.includes('挑衅'))
})

test('PE3: validate {ok:true}；渲染 8902 左右且不含 AI 词；9 模块 4 always + 5 on_demand', () => {
  const { definition } = readRealPersona()
  const { service, validation, rendered } = validateDefinition(definition)
  assert.deepEqual(validation, { ok: true, errors: [], warnings: [] })
  assert.equal(definition.modules.length, 9)
  assert.equal(definition.modules.filter((module) => module.activation === 'always').length, 4)
  assert.equal(definition.modules.filter((module) => module.activation === 'on_demand').length, 5)
  assert.ok(rendered.length >= 8800 && rendered.length <= 9100, `渲染长度应在 8902 左右，实际 ${rendered.length}`)
  for (const term of ['AI', '人工智能', '语言模型', 'DeepSeek', '模型', '平台', '程序', '系统']) {
    assert.ok(!rendered.includes(term), `渲染段不应含「${term}」`)
  }
  assert.ok(rendered.includes('【人设 · 始终生效】'))
  assert.ok(rendered.includes('菲尼克斯'))
  for (const module of definition.modules.filter((entry) => entry.activation === 'on_demand')) {
    assert.ok(!rendered.includes(module.content), `on_demand 正文不应注入渲染：${module.id}`)
  }
  assert.equal(service.lookup('other_ai_characters').label, '其他同僚')
  assert.equal(service.lookup('rules').ok, true)
})

test('PE4: 校验规则兼容——RULES 不再要求 AI、label 别名「其他同僚」、默认模板仍通过', () => {
  const { definition } = readRealPersona()
  // 真实人设（rules 无 AI）通过
  assert.deepEqual(validateDefinition(definition).validation, { ok: true, errors: [], warnings: [] })
  // rules 无 AI 关键字仍通过（RULES_KEYWORDS 只要求 安全/链接/挑衅）
  const noAi = JSON.parse(JSON.stringify(definition))
  const noAiRules = noAi.modules.find((module) => module.id === 'rules')
  noAiRules.content = noAiRules.content.replace(/AI/gu, '同行')
  assert.deepEqual(validateDefinition(noAi).validation, { ok: true, errors: [], warnings: [] })
  // label 别名「其他同僚」与旧名「其他 AI 角色」都能过校验
  for (const label of ['其他同僚', '其他 AI 角色']) {
    const clone = JSON.parse(JSON.stringify(definition))
    clone.modules.find((module) => module.id === 'other_ai_characters').label = label
    assert.equal(validateDefinition(clone).validation.ok, true, `label「${label}」应可过校验`)
  }
  // 任意其它 label 不通过（防止 label 漂移）
  const badLabel = JSON.parse(JSON.stringify(definition))
  badLabel.modules.find((module) => module.id === 'other_ai_characters').label = '神秘同僚'
  const badValidation = validateDefinition(badLabel).validation
  assert.equal(badValidation.ok, false)
  assert.ok(badValidation.errors.some((line) => line.includes('label') || line.includes('other_ai')), JSON.stringify(badValidation.errors))

  // 默认模板仍可校验通过（P1–P9 回归）
  const defaultRaw = fs.readFileSync(DEFAULT_PERSONA, 'utf8')
  const tmp = makeTempDir('dshpet-verify-immersive-default-')
  fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'persona', 'persona.json'), defaultRaw)
  const service = createPersonaService({ dataDir: tmp, defaultPersonaFile: path.join(tmp, 'persona', 'persona.json') })
  service.ensure()
  assert.equal(service.validate().ok, true, `默认模板应仍通过：${JSON.stringify(service.validate())}`)

  // rules 缺「安全」→ 校验失败
  const unsafe = JSON.parse(JSON.stringify(definition))
  const rules = unsafe.modules.find((module) => module.id === 'rules')
  rules.content = rules.content.replaceAll('安全', '稳妥')
  const unsafeValidation = validateDefinition(unsafe).validation
  assert.equal(unsafeValidation.ok, false)
  assert.ok(unsafeValidation.errors.some((line) => line.includes('安全')), JSON.stringify(unsafeValidation.errors))
})

// ───────────────────────────── PL1–PL3 输出长度 ─────────────────────────────

test('PL1: style.length 与 speech_style【长度】写明日常 10–300 字、按情境灵活', () => {
  const { definition } = readRealPersona()
  assert.match(definition.style.length, /10–300 字/u)
  assert.match(definition.style.length, /按情境灵活/u)
  const speech = moduleContent(definition, 'speech_style')
  assert.match(speech, /【长度】/u)
  assert.match(speech, /10–300 字/u)
  assert.match(speech, /按情境灵活/u)
  assert.match(speech, /10–60 字/u)
  assert.match(speech, /100–300 字/u)
  assert.ok(!speech.includes('20–80 字'), '不应残留旧长度规则')
})

test('PL2: 主动展开信号（然后呢/具体说说/为什么/我在听）与 2–6 句/150–300 字', () => {
  const { definition } = readRealPersona()
  const speech = moduleContent(definition, 'speech_style')
  for (const signal of ['然后呢', '具体说说', '为什么', '我在听']) {
    assert.ok(speech.includes(signal), `【长度】应包含展开信号：${signal}`)
  }
  assert.match(speech, /主动展开/u)
  assert.match(speech, /2–6 句/u)
  assert.match(speech, /150–300 字/u)
  assert.match(speech, /不必等「详细说说」|不要等到「详细说说」/u)
  // style.length 同步包含
  for (const signal of ['然后呢', '具体说说', '我在听']) assert.ok(definition.style.length.includes(signal))
  assert.match(definition.style.length, /2–6 句（150–300 字）/u)
})

test('PL3: QQ maxReplyChars=30000 足够容纳长回复 + 多气泡，不截断到过短', () => {
  const patch = fs.readFileSync(PATCH_FILE, 'utf8')
  assert.match(patch, /maxReplyChars: 30000/u, 'companion-qq 配置应保持 maxReplyChars: 30000')
  const settings = normalizeConfig({ charactersDir: 'D:/x/characters', botQQ: '123456789', allowUsers: ['10001'] })
  assert.equal(settings.maxReplyChars, 30000)
  const engine = createReplyEngine({ persona: makeStubPersona(), memory: makeStubMemory(), llm: makeFakeLlm(), modelSelection: () => ({ provider: 'p', model: 'm' }) })
  assert.equal(engine.config.maxReplyChars, 30000)

  // 300 字回复不应被截断
  const text300 = '啊'.repeat(300)
  assert.equal(sanitizeReply(text300, 30000).length, 300)
  // 超上限才截断（<=30001 且带省略号）
  const text40000 = '啊'.repeat(40000)
  const cut = sanitizeReply(text40000, 30000)
  assert.ok(cut.length <= 30001, `超长截断异常：${cut.length}`)
  assert.ok(cut.endsWith('…'))
  // 300 字可被气泡拆分容纳（单条 ≤ maxBubbleChars 或正常拆条）
  const bubbles = splitBubbles(text300, { maxBubbles: 30, maxCharsPerBubble: 2000 })
  assert.ok(bubbles.length >= 1 && bubbles.length <= 30)
  assert.ok(bubbles.every((bubble) => bubble.length <= 2001))
  assert.ok(text300.length < 30000, '日常 300 字上限应低于 QQ 30000 字上限')
})

// ───────────────────────────── PP1 人设保护 ─────────────────────────────

test('PP1: 人设修改说明（README/数据修改指南/SPEC）与「不覆盖已存在人设」行为', () => {
  const readme = fs.readFileSync(README_FILE, 'utf8')
  for (const fragment of ['persona/persona.json', '可直接编辑', '一个角色一个目录']) {
    assert.ok(readme.includes(fragment), `README 缺少人设说明：${fragment}`)
  }
  // 完整的「哪些文件能改、为什么会被重置」在数据修改指南里
  const guide = fs.readFileSync(path.join(ROOT, 'docs', '数据修改指南.md'), 'utf8')
  for (const fragment of ['唯一生效的人设', '不会覆盖', '备份', '重启 Harness', 'import-persona.mjs --overwrite']) {
    assert.ok(guide.includes(fragment), `数据修改指南缺少人设保护说明：${fragment}`)
  }

  const spec = fs.readFileSync(SPEC_FILE, 'utf8')
  const specIndex = spec.indexOf('### 12.3 人设修改不被覆盖')
  const specSection = specIndex >= 0 ? spec.slice(specIndex) : ''
  assert.ok(specSection.length > 0, 'SPEC 应保留 §12.3 人设修改不被覆盖')
  for (const fragment of ['唯一运行时文件', '不会覆盖已存在文件', '备份', '重启']) {
    assert.ok(specSection.includes(fragment), `SPEC 12.3 缺少：${fragment}`)
  }

  // 行为：已编辑的人设文件在 ensure 时不会被默认模板覆盖
  const tmp = makeTempDir('dshpet-verify-persona-protect-')
  const personaFile = path.join(tmp, 'persona', 'persona.json')
  fs.mkdirSync(path.dirname(personaFile), { recursive: true })
  const edited = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'))
  edited.meta.note = '用户手动编辑过的人设，不应被覆盖'
  fs.writeFileSync(personaFile, JSON.stringify(edited, null, 2), 'utf8')
  const service = createPersonaService({ dataDir: tmp, defaultPersonaFile: DEFAULT_PERSONA })
  service.ensure()
  const after = JSON.parse(fs.readFileSync(personaFile, 'utf8'))
  assert.equal(after.meta.note, '用户手动编辑过的人设，不应被覆盖', 'ensure 不得覆盖已存在的人设文件')
})

// ───────────────────────────── 真实记忆 / pending 吸收 ─────────────────────────────

test('示例记忆：30 条示例数据、层级/来源/occurredAt 合法、无 pending-seed、总览与 events 一致', () => {
  const { shortItems, layers, all } = readRealMemory()
  // 公开版示例数据：short 8 + 长层 22（L1=6/L2=4/L3=3/L4=1/L5=2/L6=3/L7=3）
  assert.equal(all.length, 30, `示例记忆应为 30 条，实际 ${all.length}`)
  assert.equal(shortItems.length + layers.flat().length, all.length, '短期 + 长期条数应等于总数')
  assert.equal(shortItems.length, 8)
  assert.deepEqual(layers.map((items) => items.length), [6, 4, 3, 1, 2, 3, 3])
  for (const [index, items] of layers.entries()) {
    for (const item of items) assert.equal(item.layer, index + 1, `长期层条目 layer 应与文件层一致：${item.id}`)
  }
  for (const item of shortItems) assert.equal(item.layer, 'short', `短期条目的 layer 应为 short：${item.id}`)
  const sources = {}
  for (const item of all) sources[item.source || '(none)'] = (sources[item.source || '(none)'] || 0) + 1
  assert.equal(sources['qq-conversation'], 23)
  assert.equal(sources['persona-history'], 6)
  assert.equal(sources['life-share'], 1)
  assert.equal(Object.values(sources).reduce((sum, value) => sum + value, 0), all.length)
  const background = all.filter((item) => item.source === 'persona-history' || String(item.source).startsWith('story:'))
  assert.equal(background.length, 6, '示例背景记忆（persona-history）应为 6 条')
  assert.equal(background.filter((item) => item.occurredAt).length, background.length, '背景记忆均应带 occurredAt')
  assert.equal(all.filter((item) => item.occurredAt).length, all.length, '示例记忆应全部带 occurredAt')
  assert.equal(fs.existsSync(PENDING_FILE), false, '示例数据不应残留 pending-seed.json')
  const overview = fs.readFileSync(path.join(MEMORY_DIR, '记忆总览.md'), 'utf8')
  assert.match(overview, new RegExp(`共 ${all.length} 条记忆`, 'u'))
  assert.match(overview, /发生时间/u)
  const events = fs.readFileSync(path.join(MEMORY_DIR, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean)
  assert.ok(events.some((line) => line.includes('"type":"maintenance"')), 'events 应有维护记录')
  assert.ok(events.some((line) => line.includes('"type":"seed"')), 'events 应有 seed 记录')
  assert.ok(events.some((line) => line.includes('"type":"memory_created"')), 'events 应有记忆创建记录')
  assert.ok(!events.some((line) => line.includes('pending-seed')), 'events 不应残留 pending-seed 记录')
})

test('pending-seed 吸收机制在改动后仍正常（临时目录：吸收/幂等/不覆盖）', () => {
  const dataDir = makeTempDir('dshpet-verify-immersive-pending-')
  const engine = new MemoryEngine({ dataDir })
  engine.ensure()
  engine.remember({ content: '宿主引擎已有的一条记忆，不能被覆盖。', at: '2026-11-06T08:00:00+08:00' })
  const existing = engine.listLayer('short')[0]
  const pendingFile = path.join(dataDir, 'memory', 'pending-seed.json')
  const makeItem = (index, overrides = {}) => ({
    id: `immersive-pending-${index}`,
    content: `【测试】pending 吸收条目 ${index}。`,
    keywords: ['测试', '吸收', '闭馆夜'],
    category: '事件',
    importance: 70,
    layer: 7,
    occurredAt: '2024-01-01T20:00:00+08:00',
    source: 'persona-history',
    ...overrides,
  })
  writeJsonSync(pendingFile, {
    schemaVersion: 1,
    source: 'story-canon',
    items: [
      makeItem(1),
      makeItem(2, { source: 'story:ophelia-phoenix' }),
      makeItem(3, { id: existing.id, content: '试图覆盖旧记忆的内容。', layer: 'short' }),
      makeItem(4, { content: existing.content }),
    ],
  })
  const result = engine.consumePendingSeedIfAny()
  assert.equal(result.created, 2, '只应新增 2 条（同 id/同内容跳过）')
  assert.equal(result.skipped, 2)
  assert.equal(fs.existsSync(pendingFile), false, '吸收成功后应删除 pending 文件')
  assert.equal(engine.status().total, 3)
  assert.equal(engine.getItem(existing.id).content, existing.content, '旧记忆不应被覆盖')
  assert.equal(engine.consumePendingSeedIfAny().created, 0, '第二次吸收应为幂等 0')
})
