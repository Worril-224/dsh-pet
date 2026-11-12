/**
 * 独立验收测试 · 人设卡导入与角色替换（C6）
 * 覆盖验收编号：C6（人设卡导入）
 * 背景：用户提供 persona-ophelia 人设卡，要求替换示例角色铃兰；本测试独立验证
 *       人设卡转换库 lib/persona/import.js、CLI scripts/import-persona.mjs，
 *       以及真实 companion-data/characters/ophelia 的导入产物与铃兰归档。
 *
 * 约束：除「真实产物只读核对」用例外，全部数据写入 fs.mkdtempSync 系统临时目录；
 *       只读用例不写 companion-data（人设校验用临时副本）。
 * 测试由验收员 verifier 独立设计编写，不复用开发者测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { deriveStyle, importPersonaCard } from '../../companion-bundle/lib/persona/import.js'
import { PERSONA_MODULES, createPersonaService } from '../../companion-bundle/lib/persona/index.js'
import { createCharacter, listCharacters } from '../../companion-bundle/lib/characters.js'
import { cleanupTempDirs, makeTempDir } from './helpers.mjs'

test.after(cleanupTempDirs)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLE = path.join(ROOT, 'companion-bundle')
const SCRIPTS = path.join(ROOT, 'scripts')
const DEFAULT_TEMPLATE = path.join(BUNDLE, 'data', 'persona.default.json')
const REAL_CHARACTERS_DIR = path.join(ROOT, 'companion-data', 'characters')
const REAL_OPHELIA_DIR = path.join(REAL_CHARACTERS_DIR, 'ophelia')
const SOURCE_CARD = process.env.DSH_PET_SOURCE_CARD || ''

const EXPECTED_ACTIVATION = {
  role_definition: 'always',
  speech_style: 'always',
  herself: 'on_demand',
  memory_and_promises: 'always',
  rules: 'always',
  appearance: 'on_demand',
  other_ai_characters: 'on_demand',
  identity: 'on_demand',
  personal_history: 'on_demand',
}

/**
 * 自造「8+1 模块人设卡」（modules 为对象，含 lookup 激活方式），与开发者测试 fixture 不同。
 * @param {object} [overrides]
 */
function makeCard(overrides = {}) {
  const card = {
    schema_version: '1.0.0',
    persona: {
      id: 'ingrid',
      name: '英格丽德',
      name_en: 'Ingrid',
      version: '1.0.0',
      archetype: '测试档案馆 · 校验官',
      user_address: '主人（日常）/ 您（正式）',
      tagline: '先核对，再开口。',
      built_at: '2026-11-05T21:00:00+08:00',
      builder: 'verify-builder',
      source: '英格丽德-人设卡.md',
    },
    identity_facts: { platform_positioning: '验收用内部定位文案不应进入 system prompt', model: '测试模型 X' },
    relationship: { address: '主人', boundary: '内部关系边界不应进入 system prompt' },
    system_prompt: '这段 system_prompt 不应被直接注入（验收用标记）。',
    modules: {
      role_definition: {
        label: '角色定义',
        activation: 'always',
        status: 'ready',
        content: '你是英格丽德，一名校验官。\n\n【你与主人】\n你称用户为「主人」。',
      },
      speaking_style: {
        label: '说话风格',
        activation: 'always',
        status: 'ready',
        content:
          '【基本语气】\n- 句子长短错落，一段通常 1–3 句；先给结论，再补充理由。\n\n' +
          '【长度】\n- 日常闲聊 1–3 句，约 30–100 字；只有步骤清单才用列表。\n\n' +
          '【语气词与颜文字】\n- 语气词克制：可少量用「呢、吧、了、呀」；不用「啦、嘛」等卖萌语气词。\n' +
          '- 颜文字默认不用，只有用户明确要求时才用一个简单颜文字。\n\n' +
          '【禁用开头】\n- 不用「作为一个 AI 助手」。\n- 不用「很高兴为您服务」。\n- 不用「当然可以！」。\n- 不用「让我来帮您」。\n\n' +
          '【语气标尺】\n- 主人：「今天好累。」→「辛苦了，主人。先歇一会儿吧。」\n- 主人：「你确定吗？」→「我再核一遍，主人。」',
      },
      self: { label: '她自己', activation: 'lookup', status: 'ready', content: '她做事一板一眼，喜欢尺子与咖啡。' },
      memory_and_promises: {
        label: '记忆和承诺',
        activation: 'always',
        status: 'ready',
        content: '【记忆原则】不编造没发生的事，也不虚构共同经历。\n【承诺原则】只承诺能做到的事，不做做不到的承诺。',
      },
      rules: {
        label: '规则',
        activation: 'always',
        status: 'ready',
        content:
          '【AI 身份】被认真询问时明确说明自己是 AI，不代表官方。\n【安全边界】拒绝违法与伤害自己或他人的内容。\n' +
          '【不发链接】任何情况下不输出链接、网址或 http(s) 地址。\n【处理挑衅】不辱骂、不阴阳怪气，必要时结束话题。',
      },
      appearance: { label: '外貌', activation: 'lookup', status: 'ready', content: '墨蓝色长发，戴细框眼镜，穿深色制服与白手套。' },
      other_ai: { label: '其他 AI 角色', activation: 'lookup', status: 'ready', content: '她认识白鸦、墨丘、纸鸢三位 AI 娘。' },
      identity: {
        label: '身份设定',
        activation: 'lookup',
        status: 'ready',
        content: '验收用角色；底层为测试模型；主人是当前用户；不代表任何官方。',
      },
      backstory: {
        label: '个人经历',
        activation: 'lookup',
        status: 'ready',
        content: '她在测试档案馆长大，把入馆日当作生日，后来成为校验官。',
      },
    },
  }
  const merge = (target, source) => {
    if (!source || typeof source !== 'object') return target
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
        merge(target[key], value)
      } else {
        target[key] = value
      }
    }
    return target
  }
  return merge(card, overrides)
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
  return file
}

/** 把转换结果写入临时 dataDir 并用 PersonaService 校验/渲染（不触碰真实数据）。 */
function materializePersona(definition) {
  const dataDir = makeTempDir('dshpet-verify-import-')
  const personaFile = path.join(dataDir, 'persona', 'persona.json')
  writeJson(personaFile, definition)
  const service = createPersonaService({ dataDir, defaultPersonaFile: personaFile })
  service.ensure()
  return { service, dataDir, personaFile }
}

function runCli(args) {
  return spawnSync(process.execPath, [path.join(SCRIPTS, 'import-persona.mjs'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  })
}

// ───────────────────────────── C6: 模块映射 / 激活方式 ─────────────────────────────

test('C6: 8+1 模块卡转换为 9 模块，id 映射/lookup→on_demand/always 保持/顺序正确', () => {
  const card = makeCard()
  const definition = importPersonaCard(card, { id: 'ingrid', name: '英格丽德' })

  assert.equal(definition.schemaVersion, 1)
  assert.equal(definition.modules.length, 9)
  assert.deepEqual(
    definition.modules.map((module) => module.id),
    PERSONA_MODULES.map((module) => module.id),
    '模块顺序必须与 SPEC 3.1 的 9 模块一致',
  )
  for (const module of definition.modules) {
    assert.equal(module.activation, EXPECTED_ACTIVATION[module.id], `模块 ${module.id} 激活方式错误`)
    assert.equal(typeof module.content, 'string')
    assert.ok(module.content.length > 0)
    assert.ok(!module.content.includes('铃兰'), '转换结果不得残留旧角色名')
  }

  // id 映射与正文搬运：speaking_style→speech_style、self→herself、other_ai→other_ai_characters、backstory→personal_history
  const byId = Object.fromEntries(definition.modules.map((module) => [module.id, module]))
  assert.equal(byId.speech_style.content, card.modules.speaking_style.content.trim())
  assert.equal(byId.herself.content, card.modules.self.content.trim())
  assert.equal(byId.other_ai_characters.content, card.modules.other_ai.content.trim())
  assert.equal(byId.personal_history.content, card.modules.backstory.content.trim())
  // label 使用本项目 9 模块的固定中文名
  for (const expected of PERSONA_MODULES) assert.equal(byId[expected.id].label, expected.label)

  // 顶层附加信息：identityFacts / relationship / sourceMeta 被保留作参考
  assert.equal(definition.identityFacts.platform_positioning, card.identity_facts.platform_positioning)
  assert.equal(definition.relationship.address, '主人')
  assert.equal(definition.sourceMeta.builder, 'verify-builder')
  assert.equal(definition.sourceMeta.schemaVersion, '1.0.0')
})

test('C6: style 自动推导（禁用开头/语气词/长度/颜文字/句式），不把被禁语气词当允许项', () => {
  const card = makeCard()
  const definition = importPersonaCard(card, { id: 'ingrid', name: '英格丽德' })
  const style = definition.style
  for (const field of ['sentence', 'length', 'toneWords', 'kaomojiFrequency', 'bannedOpeners', 'forbiddenPatterns']) {
    assert.ok(field in style, `style 缺少字段：${field}`)
  }
  // 禁用开头：从【禁用开头】的四条中文引号提取（≥3，不需要回退默认）
  assert.ok(style.bannedOpeners.length >= 3)
  for (const opener of ['作为一个 AI 助手', '很高兴为您服务', '当然可以！', '让我来帮您']) {
    assert.ok(style.bannedOpeners.includes(opener), `禁用开头缺失：${opener}`)
  }
  // 语气词：允许项来自「可少量用」分句；否定句中的「啦、嘛」不得被当成允许项
  assert.deepEqual(style.toneWords, ['呢', '吧', '了', '呀'])
  assert.ok(!style.toneWords.includes('啦'), '被禁用语气词「啦」不得成为允许项')
  assert.ok(!style.toneWords.includes('嘛'), '被禁用语气词「嘛」不得成为允许项')
  // 长度 / 颜文字 / 句式来自正文对应段落
  assert.ok(style.length.includes('1–3 句'), `长度推导异常：${style.length}`)
  assert.ok(style.kaomojiFrequency.includes('颜文字'))
  assert.ok(style.sentence.includes('句子长短错落'))
  assert.ok(style.forbiddenPatterns.includes('http://'))
  assert.ok(style.forbiddenPatterns.includes('https://'))

  // 正文缺少可推导段落时回退默认值（且默认值仍然合法）
  const fallback = deriveStyle({ rules: { content: '普通规则。' } })
  assert.ok(fallback.bannedOpeners.length >= 3)
  assert.ok(fallback.toneWords.length >= 1)
  assert.ok(fallback.sentence.length > 0 && fallback.length.length > 0)
  assert.ok(!fallback.toneWords.includes('啦'))

  // 调用方显式覆盖优先
  const overridden = deriveStyle(
    { speaking_style: { content: card.modules.speaking_style.content } },
    { toneWords: ['咯'], bannedOpeners: ['甲开头', '乙开头', '丙开头'], sentence: '自定义句式要求。' },
  )
  assert.deepEqual(overridden.toneWords, ['咯'])
  assert.deepEqual(overridden.bannedOpeners, ['甲开头', '乙开头', '丙开头'])
  assert.equal(overridden.sentence, '自定义句式要求。')
})

// ───────────────────────────── C6: 个人经历 ready / pending ─────────────────────────────

test('C6: backstory ready → personalHistory ready（entries≥1）；pending/缺失 → pending_user_input', () => {
  const ready = importPersonaCard(makeCard(), { id: 'ingrid', name: '英格丽德' })
  assert.equal(ready.personalHistory.status, 'ready')
  assert.ok(Array.isArray(ready.personalHistory.entries) && ready.personalHistory.entries.length >= 1)
  assert.equal(ready.personalHistory.entries[0].content, makeCard().modules.backstory.content)
  assert.match(ready.personalHistory.note, /persona_lookup|人设卡/u)

  const pendingCard = makeCard()
  pendingCard.modules.backstory = { ...pendingCard.modules.backstory, status: 'pending' }
  const pending = importPersonaCard(pendingCard, { id: 'ingrid', name: '英格丽德' })
  assert.equal(pending.personalHistory.status, 'pending_user_input')
  assert.deepEqual(pending.personalHistory.entries, [])
  assert.match(pending.personalHistory.note, /待主人补充|待补充/u)

  // 没有 status 字段时按 pending 处理（不误报 ready）
  const noStatus = makeCard()
  delete noStatus.modules.backstory.status
  assert.equal(importPersonaCard(noStatus, { id: 'ingrid2', name: '英格丽德二' }).personalHistory.status, 'pending_user_input')
})

// ───────────────────────────── C6: validate / 落盘 / 注入安全 ─────────────────────────────

test('C6: 转换结果落盘后 PersonaService.validate 通过；渲染不含 on_demand 正文与附加档案', () => {
  const definition = importPersonaCard(makeCard(), { id: 'ingrid', name: '英格丽德' })
  const { service } = materializePersona(definition)

  const validation = service.validate()
  assert.equal(validation.ok, true, `转换结果应通过校验：${JSON.stringify(validation)}`)
  assert.deepEqual(validation.errors, [])
  assert.deepEqual(validation.warnings, [])

  const rendered = service.renderPersonaSection()
  assert.ok(rendered.includes('【人设 · 始终生效】'))
  assert.ok(rendered.includes('英格丽德'))
  // 5 个 on_demand 模块正文零泄漏
  for (const module of definition.modules.filter((entry) => entry.activation === 'on_demand')) {
    assert.ok(!rendered.includes(module.content), `on_demand 正文泄漏：${module.id}`)
  }
  // personalHistory 的完整正文（backstory）不得注入 system prompt
  assert.ok(!rendered.includes(definition.personalHistory.entries[0].content))
  assert.match(rendered, /被问到才用的人设资料/u)
  // 附加档案（identity_facts / relationship / system_prompt 原文）不得注入
  assert.ok(!rendered.includes('验收用内部定位文案不应进入 system prompt'))
  assert.ok(!rendered.includes('内部关系边界不应进入 system prompt'))
  assert.ok(!rendered.includes('这段 system_prompt 不应被直接注入'))

  // persona_lookup 9 个模块全部可读
  for (const expected of PERSONA_MODULES) {
    const lookup = service.lookup(expected.id)
    assert.equal(lookup.ok, true, `persona_lookup 应可读：${expected.id}`)
    assert.ok(lookup.content.length > 0)
  }
})

// ───────────────────────────── C6: 错误输入 ─────────────────────────────

test('C6 边界: 非法来源/缺模块/正文为空/非对象 modules 均被拒绝', () => {
  for (const bad of [null, undefined, [], '卡片', 42]) {
    assert.throws(() => importPersonaCard(bad), /人设卡必须是 JSON 对象/u, `非法来源应被拒绝：${JSON.stringify(bad)}`)
  }

  // 逐个缺少 9 模块中的任一模块 → 拒绝并点名缺失模块 id
  for (const expected of PERSONA_MODULES) {
    const card = makeCard()
    delete card.modules[expected.id === 'speech_style' ? 'speaking_style' : expected.id === 'herself' ? 'self' : expected.id === 'other_ai_characters' ? 'other_ai' : expected.id === 'personal_history' ? 'backstory' : expected.id]
    assert.throws(
      () => importPersonaCard(card, { id: 'missing', name: '缺模块' }),
      /缺少模块或正文为空/u,
      `缺少模块 ${expected.id} 应被拒绝`,
    )
  }

  // 模块正文为空 / 非字符串
  const emptyCard = makeCard()
  emptyCard.modules.rules = { ...emptyCard.modules.rules, content: '   ' }
  assert.throws(() => importPersonaCard(emptyCard, { id: 'empty', name: '空正文' }), /缺少模块或正文为空：rules/u)

  const nonStringCard = makeCard()
  nonStringCard.modules.identity = { ...nonStringCard.modules.identity, content: 123 }
  assert.throws(() => importPersonaCard(nonStringCard, { id: 'badtype', name: '非字符串' }), /缺少模块或正文为空：identity/u)

  // modules 不是对象/数组（例如字符串）→ 视为无可用模块
  const broken = makeCard()
  broken.modules = 'not-an-object'
  assert.throws(() => importPersonaCard(broken, { id: 'broken', name: '坏 modules' }), /缺少模块/u)
})

// ───────────────────────────── C6: 本项目格式直通 ─────────────────────────────

test('C6 边界: 已是本项目格式（modules 为数组）可直通；缺 style/personalHistory 时补默认', () => {
  const defaultDefinition = JSON.parse(fs.readFileSync(DEFAULT_TEMPLATE, 'utf8'))
  const passthrough = importPersonaCard(defaultDefinition, { id: 'passthrough', name: '直通测试' })
  assert.equal(passthrough.schemaVersion, 1)
  assert.equal(passthrough.modules.length, 9)
  assert.equal(passthrough.character.name, '直通测试')
  assert.equal(passthrough.meta.name, '直通测试')
  assert.ok(passthrough.style.bannedOpeners.length >= 3)

  // 去掉 style / personalHistory / examples → 自动补默认，仍可通过 validate
  const bare = JSON.parse(JSON.stringify(defaultDefinition))
  delete bare.style
  delete bare.personalHistory
  delete bare.examples
  const filled = importPersonaCard(bare, { id: 'filled', name: '补全测试' })
  assert.ok(filled.style && filled.style.bannedOpeners.length >= 3)
  assert.equal(filled.personalHistory.status, 'pending_user_input')
  assert.ok(Array.isArray(filled.examples))
  const { service } = materializePersona(filled)
  assert.equal(service.validate().ok, true, `直通补全结果应通过校验：${JSON.stringify(service.validate())}`)
  // 直通不修改源对象（深拷贝）
  assert.ok(defaultDefinition.style !== undefined)
})

// ───────────────────────────── C6 边界: activation 规范化 ─────────────────────────────

test('C6 边界: activation 规范化（lookup/on-demand→on_demand；缺失/未知回退固定值）', () => {
  const card = makeCard()
  card.modules.self = { ...card.modules.self, activation: 'on-demand' }
  card.modules.appearance = { ...card.modules.appearance, activation: 'lookup' }
  card.modules.identity = { ...card.modules.identity, activation: 'whatever' }
  delete card.modules.rules.activation
  const definition = importPersonaCard(card, { id: 'norm', name: '规范化' })
  const byId = Object.fromEntries(definition.modules.map((module) => [module.id, module]))
  assert.equal(byId.herself.activation, 'on_demand')
  assert.equal(byId.appearance.activation, 'on_demand')
  assert.equal(byId.identity.activation, 'on_demand', '未知 activation 回退到 spec 固定值')
  assert.equal(byId.rules.activation, 'always', '缺失 activation 回退到 spec 固定值')
})

// ───────────────────────────── C6: CLI 导出 / 创建 / 归档 ─────────────────────────────

test('C6 脚本级: import-persona.mjs --output 导出转换结果且不改 bundle patch', () => {
  const root = makeTempDir('dshpet-verify-import-cli-output-')
  const cardFile = writeJson(path.join(root, 'card.json'), makeCard())
  const outFile = path.join(root, 'out', 'persona.json')
  const patchBefore = fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8')

  const result = runCli(['--source', cardFile, '--id', 'ingrid', '--name', '英格丽德', '--output', outFile])
  assert.equal(result.status, 0, `--output 应成功：${result.stderr || result.stdout}`)
  assert.ok(result.stdout.includes('已导出转换后的人设'))
  assert.ok(fs.existsSync(outFile))
  const exported = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  assert.equal(exported.modules.length, 9)
  assert.equal(exported.character.name, '英格丽德')
  assert.equal(exported.personalHistory.status, 'ready')
  assert.deepEqual(exported.style.toneWords, ['呢', '吧', '了', '呀'])
  const { service } = materializePersona(exported)
  assert.equal(service.validate().ok, true)
  assert.equal(fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8'), patchBefore, 'CLI 不得修改 bundle patch')
})

test('C6 脚本级: import-persona.mjs 创建角色 + --archive 归档旧角色（临时目录）', () => {
  const root = makeTempDir('dshpet-verify-import-cli-create-')
  const charactersDir = path.join(root, 'characters')
  // 先创建一个「旧示例角色」用于归档
  createCharacter({ charactersDir, id: 'oldrole', name: '旧示例角色', defaultPersonaFile: DEFAULT_TEMPLATE })
  const cardFile = writeJson(path.join(root, 'card.json'), makeCard())
  const patchBefore = fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8')

  const result = runCli([
    '--source',
    cardFile,
    '--id',
    'ingrid',
    '--name',
    '英格丽德',
    '--characters-dir',
    charactersDir,
    '--archive',
    'oldrole',
  ])
  assert.equal(result.status, 0, `导入并归档应成功：${result.stderr || result.stdout}`)
  assert.ok(result.stdout.includes('角色已创建'))
  assert.ok(result.stdout.includes('人设校验：通过'))
  assert.ok(result.stdout.includes('旧角色已归档'))
  assert.ok(result.stdout.includes('characterId: ingrid'), '应输出可直接使用的预设片段')

  const newDir = path.join(path.resolve(charactersDir), 'ingrid')
  assert.ok(fs.existsSync(path.join(newDir, 'persona', 'persona.json')))
  assert.ok(fs.existsSync(path.join(newDir, 'character.json')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(newDir, 'character.json'), 'utf8')).name, '英格丽德')
  assert.deepEqual(listCharacters(charactersDir).map((character) => character.id), ['ingrid'], '归档的旧角色不应再被扫描')
  assert.equal(fs.existsSync(path.join(charactersDir, 'oldrole')), false, '旧角色目录应被移走')
  const retired = fs.readdirSync(path.join(charactersDir, '.retired'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
  assert.equal(retired.length, 1)
  assert.ok(retired[0].name.startsWith('oldrole-'))
  for (const file of ['character.json', 'persona', 'memory']) {
    assert.ok(fs.existsSync(path.join(charactersDir, '.retired', retired[0].name, file)))
  }
  assert.equal(fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8'), patchBefore, 'CLI 不得修改 bundle patch')
})

test('C6 边界: CLI 对坏 JSON/缺模块卡非零退出且不创建角色；--style-file 可覆盖 style', () => {
  const root = makeTempDir('dshpet-verify-import-cli-bad-')
  const charactersDir = path.join(root, 'characters')

  // 坏 JSON
  const badJson = path.join(root, 'bad.json')
  fs.writeFileSync(badJson, '{ 这不是合法 JSON ', 'utf8')
  const badResult = runCli(['--source', badJson, '--id', 'bad', '--characters-dir', charactersDir])
  assert.notEqual(badResult.status, 0, '坏 JSON 应非零退出')
  assert.equal(fs.existsSync(path.join(charactersDir, 'bad')), false)

  // 缺模块卡
  const missingCard = makeCard()
  delete missingCard.modules.rules
  const missingFile = writeJson(path.join(root, 'missing.json'), missingCard)
  const missingResult = runCli(['--source', missingFile, '--id', 'missing', '--characters-dir', charactersDir])
  assert.notEqual(missingResult.status, 0, '缺模块应非零退出')
  assert.equal(fs.existsSync(path.join(charactersDir, 'missing')), false)

  // --style-file 覆盖
  const cardFile = writeJson(path.join(root, 'card.json'), makeCard())
  const styleFile = writeJson(path.join(root, 'style.json'), {
    toneWords: ['吧', '了'],
    bannedOpeners: ['覆盖开头甲', '覆盖开头乙', '覆盖开头丙'],
    sentence: '覆盖后的句式要求。',
  })
  const outFile = path.join(root, 'out.json')
  const styled = runCli(['--source', cardFile, '--id', 'styled', '--name', '覆盖测试', '--style-file', styleFile, '--output', outFile])
  assert.equal(styled.status, 0, `--style-file 应成功：${styled.stderr || styled.stdout}`)
  const exported = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  assert.deepEqual(exported.style.toneWords, ['吧', '了'])
  assert.deepEqual(exported.style.bannedOpeners, ['覆盖开头甲', '覆盖开头乙', '覆盖开头丙'])
  assert.equal(exported.style.sentence, '覆盖后的句式要求。')
})

test('C6 观察: CLI 在 PersonaService.validate 失败时仍创建角色并以 0 退出（记录现状，建议后续收紧）', () => {
  // 构造一份「结构完整但规则正文缺少必需要点」的卡片：转换本身成功，但 validate 会失败。
  const root = makeTempDir('dshpet-verify-import-cli-invalid-')
  const charactersDir = path.join(root, 'characters')
  const card = makeCard()
  card.modules.rules = { ...card.modules.rules, content: '【AI 身份】我是 AI。\n【其他】保持礼貌。' }
  const cardFile = writeJson(path.join(root, 'card.json'), card)
  const result = runCli(['--source', cardFile, '--id', 'invalidrole', '--name', '不合规角色', '--characters-dir', charactersDir])
  // 现状：CLI 打印「人设校验：失败」但仍以 0 退出并保留角色目录
  assert.equal(result.status, 0, '当前实现：校验失败仍以 0 退出')
  assert.ok(result.stdout.includes('人设校验：失败'), '应明确打印校验失败')
  assert.ok(fs.existsSync(path.join(charactersDir, 'invalidrole', 'persona', 'persona.json')), '当前实现：校验失败仍创建角色')
  const validation = createPersonaService({ dataDir: path.join(path.resolve(charactersDir), 'invalidrole') }).validate()
  assert.equal(validation.ok, false, '该角色人设应校验失败（规则缺少安全/链接/挑衅要点）')
})

// ───────────────────────────── C6: 真实产物只读核对（奥菲莉亚替换铃兰） ─────────────────────────────

test('C6 真实产物（只读）: ophelia 人设/校验/渲染/归档/patch 核对', (t) => {
  if (!fs.existsSync(REAL_OPHELIA_DIR)) {
    t.skip('真实 ophelia 角色目录不存在，跳过真实产物核对')
    return
  }
  const personaFile = path.join(REAL_OPHELIA_DIR, 'persona', 'persona.json')
  const raw = fs.readFileSync(personaFile, 'utf8')
  const definition = JSON.parse(raw)
  assert.ok(Buffer.byteLength(raw, 'utf8') > 40_000, '真实人设文件应包含完整 8+1 正文（>40KB）')
  assert.equal(definition.schemaVersion, 1)
  // 2026-11-06 新故事 canon：显示名升级为全名「奥菲莉亚·菲尼克斯」
  assert.equal(definition.meta.name, '奥菲莉亚·菲尼克斯')
  assert.equal(definition.character.name, '奥菲莉亚·菲尼克斯')
  assert.equal(definition.character.description, '白昼档案馆 · 凤凰魔法使记录官 No.14')
  assert.equal(definition.modules.length, 9)
  assert.deepEqual(
    definition.modules.map((module) => module.id),
    PERSONA_MODULES.map((module) => module.id),
  )
  for (const [id, activation] of Object.entries(EXPECTED_ACTIVATION)) {
    assert.equal(definition.modules.find((module) => module.id === id).activation, activation, `真实人设 ${id} 激活方式错误`)
  }
  // 铃兰旧名不得残留
  assert.ok(!raw.includes('铃兰'), '真实人设不得残留旧角色名「铃兰」')
  // style：2026-11-06 语言风格细化后，「啦/嘛」作为克制使用的轻快语气词被允许（配合 voice-style 验收）
  assert.ok(Array.isArray(definition.style.toneWords) && definition.style.toneWords.length > 0)
  for (const word of ['呢', '吧', '了', '呀', '啦', '嘛']) {
    assert.ok(definition.style.toneWords.includes(word), `toneWords 应含「${word}」`)
  }
  assert.ok(definition.style.bannedOpeners.length >= 3)
  assert.ok(definition.style.forbiddenPatterns.includes('http://'))
  assert.match(definition.style.kaomojiFrequency, /默认不用 emoji|颜文字极少/u)
  // personalHistory ready
  assert.equal(definition.personalHistory.status, 'ready')
  assert.ok(definition.personalHistory.entries.length >= 1)

  // 临时副本上做 PersonaService 校验与渲染（不写真实数据）
  const tmpDir = makeTempDir('dshpet-verify-ophelia-real-')
  const tmpPersona = path.join(tmpDir, 'persona', 'persona.json')
  writeJson(tmpPersona, definition)
  const service = createPersonaService({ dataDir: tmpDir, defaultPersonaFile: tmpPersona })
  service.ensure()
  const validation = service.validate()
  assert.equal(validation.ok, true, `真实人设应校验通过：${JSON.stringify(validation)}`)
  assert.deepEqual(validation.errors, [])
  const rendered = service.renderPersonaSection()
  // 2026-11-06 沉浸式 6362 → 语言风格 8050/8130 → 对话表达纪律后 8902
  assert.ok(rendered.length >= 8800 && rendered.length <= 9100, `渲染长度应在 8902 左右，实际 ${rendered.length}`)
  assert.ok(rendered.includes('【人设 · 始终生效】'))
  assert.ok(rendered.includes('菲尼克斯'), '渲染应包含新故事 canon 的菲尼克斯之名')
  assert.ok(!rendered.includes('铃兰'), '渲染不得出现旧角色名')
  for (const module of definition.modules.filter((entry) => entry.activation === 'on_demand')) {
    assert.ok(!rendered.includes(module.content), `真实人设 on_demand 正文泄漏：${module.id}`)
  }
  assert.ok(!rendered.includes(definition.personalHistory.entries[0].content), '个人经历正文不得注入 system prompt')
  // persona_lookup 可读（appearance / personal_history）
  const appearance = service.lookup('appearance')
  assert.equal(appearance.ok, true)
  assert.ok(appearance.content.length > 200)
  const history = service.lookup('personal_history')
  assert.equal(history.ok, true)
  assert.ok(history.content.length > 500)

  // character.json / memory / assets
  const meta = JSON.parse(fs.readFileSync(path.join(REAL_OPHELIA_DIR, 'character.json'), 'utf8'))
  assert.equal(meta.id, 'ophelia')
  assert.equal(meta.name, '奥菲莉亚·菲尼克斯')
  assert.equal(meta.description, '白昼档案馆 · 凤凰魔法使记录官 No.14')
  assert.equal(meta.personaSource, 'persona-file')
  const memoryMeta = JSON.parse(fs.readFileSync(path.join(REAL_OPHELIA_DIR, 'memory', 'meta.json'), 'utf8'))
  // 2026-11-06 起真实数据已执行过凌晨维护（首次维护日期会随运行日期前移），只校验格式与原因枚举
  assert.match(memoryMeta.lastMaintenanceDateKey, /^\d{4}-\d{2}-\d{2}$/u)
  assert.ok(
    ['首次运行初始化', '每日凌晨维护窗口', '补跑（应用未在凌晨运行）'].includes(memoryMeta.lastMaintenanceReason),
    `维护原因应为已知枚举：${memoryMeta.lastMaintenanceReason}`,
  )
  assert.ok(memoryMeta.lastMaintenanceAt)
  const assetPath = path.join(REAL_OPHELIA_DIR, 'assets', 'ophelia-reference.jpg')
  assert.ok(fs.existsSync(assetPath), '参考图资产应存在')
  const asset = fs.readFileSync(assetPath)
  assert.ok(asset.length > 100_000, '参考图应非空')
  assert.equal(asset[0], 0xff)
  assert.equal(asset[1], 0xd8)
  assert.equal(asset[2], 0xff, 'JPEG 魔数校验失败')

  // 旧示例角色铃兰已被奥菲莉亚替换：characters/ 下只应有 ophelia，无 linglan（归档目录不随公开仓库提供）
  assert.equal(fs.existsSync(path.join(REAL_CHARACTERS_DIR, 'linglan')), false, 'characters 下不应再有 linglan 目录')
  assert.deepEqual(
    listCharacters(REAL_CHARACTERS_DIR).map((character) => character.id),
    ['ophelia'],
    '示例角色列表应只含 ophelia',
  )

  // bundle patch 预设名已改为「情感陪伴 · 奥菲莉亚·菲尼克斯」
  const patch = fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('name: 情感陪伴 · 奥菲莉亚·菲尼克斯'))
  assert.ok(!patch.includes('name: 情感陪伴 · 奥菲莉亚\n'), '预设名不应残留旧版短名')
  assert.ok(patch.includes('characterId: ophelia'))
  assert.ok(!patch.includes('铃兰'), 'bundle patch 不应残留铃兰')
  assert.ok(!patch.includes('characterId: linglan'))

  // 若来源人设卡在本机：来源卡（v3 魔法使版）仍应可被转换器解析出与真实人设一致的模块结构。
  // 注意：2026-11-06 新故事 canon 在 v3 转换结果上追加了凤凰篇内容（名称/外貌/身份/经历），
  // 因此这里只校验「结构/activation 契约」，不再逐字比对正文。
  if (fs.existsSync(SOURCE_CARD)) {
    const source = JSON.parse(fs.readFileSync(SOURCE_CARD, 'utf8'))
    const converted = importPersonaCard(source, { id: 'ophelia', name: '奥菲莉亚' })
    assert.deepEqual(
      definition.modules.map((module) => ({ id: module.id, activation: module.activation })),
      converted.modules.map((module) => ({ id: module.id, activation: module.activation })),
      '真实人设模块 id/activation 应与来源卡转换结果的结构一致',
    )
    assert.equal(converted.personalHistory.status, 'ready')
    assert.equal(definition.personalHistory.status, 'ready')
    // 真实人设已是新版内容：允许与来源卡正文不同，但必须校验通过、正文非空
    for (const module of definition.modules) assert.ok(module.content.length > 100, `模块正文过短：${module.id}`)
  }
})
