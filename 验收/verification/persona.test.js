/**
 * 独立验收测试 · 人设模块（P1–P9 + 健壮性边界）
 * 覆盖需求编号：P1 P2 P3 P4 P5 P6 P7 P8 P9
 *
 * 全部测试使用操作系统临时目录（fs.mkdtempSync），不会修改仓库内 companion-data。
 * 测试由验收员 verifier 独立设计编写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_PERSONA_FILE,
  PERSONA_MODULES,
  createPersonaService,
} from '../../companion-bundle/lib/persona/index.js'
import { cleanupTempDirs, makeTempDir } from './helpers.mjs'

test.after(cleanupTempDirs)

// SPEC 3.1 的 9 个模块（独立抄录，用于交叉核对实现）
const EXPECTED_MODULES = [
  { id: 'role_definition', label: '角色定义', activation: 'always' },
  { id: 'speech_style', label: '说话风格', activation: 'always' },
  { id: 'herself', label: '她自己', activation: 'on_demand' },
  { id: 'memory_and_promises', label: '记忆和承诺', activation: 'always' },
  { id: 'rules', label: '规则', activation: 'always' },
  { id: 'appearance', label: '外貌', activation: 'on_demand' },
  { id: 'other_ai_characters', label: '其他 AI 角色', activation: 'on_demand' },
  { id: 'identity', label: '身份设定', activation: 'on_demand' },
  { id: 'personal_history', label: '个人经历', activation: 'on_demand' },
]
const ON_DEMAND_IDS = EXPECTED_MODULES.filter((module) => module.activation === 'on_demand').map((module) => module.id)
const ALWAYS_IDS = EXPECTED_MODULES.filter((module) => module.activation === 'always').map((module) => module.id)

function newPersona(dataDir) {
  const dir = dataDir || makeTempDir('dshpet-verify-persona-')
  const service = createPersonaService({ dataDir: dir })
  service.ensure()
  return { service, dataDir: service.dataDir }
}

function readPersonaFile(service) {
  return JSON.parse(fs.readFileSync(service.getFilePath(), 'utf8'))
}

function writePersonaFile(service, definition) {
  fs.writeFileSync(service.getFilePath(), JSON.stringify(definition, null, 2) + '\n', 'utf8')
}

// ───────────────────────────── P1 8+1 模块完整 ─────────────────────────────

test('P1: 9 个模块的 id/label/activation 与 SPEC 3.1 完全一致且顺序正确', () => {
  const { service } = newPersona()
  const modules = service.moduleList()
  assert.equal(modules.length, 9, '必须有 8+1 = 9 个模块')
  assert.deepEqual(
    modules.map(({ id, label, activation }) => ({ id, label, activation })),
    EXPECTED_MODULES,
  )
  assert.deepEqual(
    service.getAlwaysModules().map((module) => module.id),
    ALWAYS_IDS,
    'always 模块应恰好是 4 个：角色定义/说话风格/记忆和承诺/规则',
  )
  assert.deepEqual(
    service.getOnDemandModules().map((module) => module.id),
    ON_DEMAND_IDS,
    'on_demand 模块应恰好是 5 个',
  )
  for (const module of service.getAlwaysModules()) assert.ok(module.content.length > 0)
  // 实现导出的常量也应为 9 项
  assert.equal(PERSONA_MODULES.length, 9)
})

// ───────────────────────────── P2 always 注入 ─────────────────────────────

test('P2: renderPersonaSection 含 4 个 always 正文与说话风格细则，不含任何 on_demand 正文', () => {
  const { service } = newPersona()
  const definition = service.getDefinition()
  const section = service.renderPersonaSection()

  assert.ok(section.includes('【人设 · 始终生效】'), '缺少标题')
  assert.ok(section.includes(definition.character.oneLiner), '缺少角色一句话定义')
  assert.ok(section.includes(definition.character.name), '缺少角色名')

  for (const module of service.getAlwaysModules()) {
    assert.ok(section.includes(module.content), `always 模块正文缺失：${module.id}`)
  }
  const style = definition.style
  assert.ok(section.includes('【说话风格细则】'))
  assert.ok(section.includes(style.sentence), '缺句式要求')
  assert.ok(section.includes(style.length), '缺长度要求')
  assert.ok(section.includes(style.kaomojiFrequency), '缺颜文字频率')
  assert.ok(section.includes('禁用开头'), '缺禁用开头的说明')
  for (const word of style.toneWords) assert.ok(section.includes(word), `缺语气词：${word}`)
  for (const opener of style.bannedOpeners) assert.ok(section.includes(opener), `缺禁用开头：${opener}`)
  for (const pattern of style.forbiddenPatterns) assert.ok(section.includes(pattern), `缺禁止输出模式：${pattern}`)

  // 关键：不得包含任何 on_demand 模块正文
  for (const moduleId of ON_DEMAND_IDS) {
    const module = definition.modules.find((entry) => entry.id === moduleId)
    assert.ok(module && module.content.length > 10)
    assert.ok(!section.includes(module.content), `ON_DEMAND 正文泄漏进 system prompt：${moduleId}`)
  }
})

// ───────────────────────────── P3 on_demand 索引 ─────────────────────────────

test('P3: 段落列出 5 个 on_demand 模块名称并明确要求先 persona_lookup、未查到说记不清、不得编造', () => {
  const { service } = newPersona()
  const section = service.renderPersonaSection()
  assert.ok(section.includes('【被问到才用的人设资料】'), '缺少 on_demand 索引段')

  for (const module of service.getOnDemandModules()) {
    assert.ok(section.includes(module.label), `索引段缺少模块名称：${module.label}`)
    assert.ok(section.includes(module.id), `索引段缺少模块 id：${module.id}`)
  }
  assert.ok(section.includes('persona_lookup'), '缺少 persona_lookup 工具指引')
  assert.ok(section.includes('不得编造'), '缺少「不得编造」约束')
  assert.ok(section.includes('记不清'), '缺少「记不清」要求')
  assert.ok(section.includes('未查到'), '缺少「未查到」的处理要求')
})

// ───────────────────────────── P4 按需读取 ─────────────────────────────

test('P4: persona_lookup 对 9 个模块均可返回正文，未知模块返回错误提示', () => {
  const { service } = newPersona()
  const definition = service.getDefinition()

  for (const expected of EXPECTED_MODULES) {
    const result = service.lookup(expected.id)
    assert.equal(result.ok, true, `模块 ${expected.id} 应可查询`)
    assert.equal(result.id, expected.id)
    assert.equal(result.label, expected.label)
    assert.equal(result.activation, expected.activation)
    const module = definition.modules.find((entry) => entry.id === expected.id)
    assert.equal(result.content, module.content)

    // 中文名也可以查询
    const byLabel = service.lookup(expected.label)
    assert.equal(byLabel.ok, true, `中文名 ${expected.label} 应可查询`)
    assert.equal(byLabel.id, expected.id)
  }

  // 大小写不敏感（id）
  assert.equal(service.lookup('APPEARANCE').ok, true)

  const unknown = service.lookup('不存在的模块')
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /未找到|可用模块/u)
  assert.match(unknown.error, /角色定义|appearance/u, '错误提示应列出可用模块')

  const empty = service.lookup('')
  assert.equal(empty.ok, false)
  assert.match(empty.error, /模块/u)
})

// ───────────────────────────── P5/P6/P7 内容覆盖 ─────────────────────────────

test('P5: 规则正文覆盖 AI 身份披露、安全边界、不发链接、处理挑衅', () => {
  const { service } = newPersona()
  const rules = service.lookup('rules')
  assert.equal(rules.ok, true)
  for (const keyword of ['AI', '安全', '链接', '挑衅']) {
    assert.ok(rules.content.includes(keyword), `规则正文缺少「${keyword}」`)
  }
  assert.ok(rules.content.includes('https://') || rules.content.includes('http://'), '规则中应明确禁止链接')
  const validation = service.validate()
  assert.equal(validation.ok, true)
  assert.deepEqual(validation.errors, [])
})

test('P6: memory_and_promises 正文含「不编造」「不承诺做不到的事」语义', () => {
  const { service } = newPersona()
  const memory = service.lookup('memory_and_promises')
  assert.equal(memory.ok, true)
  assert.ok(memory.content.includes('编造'), '缺少「不编造」语义')
  assert.ok(memory.content.includes('承诺'), '缺少承诺约束')
  assert.ok(memory.content.includes('做不到'), '缺少「做不到的事不承诺」语义')
  assert.equal(service.validate().ok, true)
})

test('P7: style 字段齐全、bannedOpeners >=3、颜文字频率与长度要求存在并注入渲染', () => {
  const { service } = newPersona()
  const style = service.getDefinition().style
  assert.equal(typeof style.sentence, 'string')
  assert.ok(style.sentence.length > 0)
  assert.equal(typeof style.length, 'string')
  assert.ok(style.length.length > 0)
  assert.equal(typeof style.kaomojiFrequency, 'string')
  assert.ok(style.kaomojiFrequency.length > 0)
  assert.ok(Array.isArray(style.toneWords) && style.toneWords.length > 0)
  assert.ok(Array.isArray(style.bannedOpeners) && style.bannedOpeners.length >= 3, 'bannedOpeners 至少 3 条')
  assert.ok(Array.isArray(style.forbiddenPatterns) && style.forbiddenPatterns.length > 0)
  assert.equal(service.validate().ok, true)
})

// ───────────────────────────── P8 个人经历占位 ─────────────────────────────

test('P8: personalHistory.status = pending_user_input，模块存在且渲染中标注等待补充', () => {
  const { service } = newPersona()
  const definition = service.getDefinition()
  assert.equal(definition.personalHistory.status, 'pending_user_input')
  assert.deepEqual(definition.personalHistory.entries, [])
  assert.ok(definition.personalHistory.note.length > 0)

  const module = service.lookup('personal_history')
  assert.equal(module.ok, true)
  assert.equal(module.activation, 'on_demand')
  assert.ok(module.content.includes('pending_user_input'))
  assert.ok(!module.content.includes('已经补充完成'))

  const section = service.renderPersonaSection()
  assert.ok(section.includes('【个人经历】'))
  assert.match(section, /等待主人补充|待补充|等主人补充/u)
  assert.ok(!section.includes(module.content), '个人经历模块正文不应注入 system prompt')
  assert.equal(service.validate().ok, true)
})

// ───────────────────────────── P9 数据文件可编辑 ─────────────────────────────

test('P9: ensure 生成 persona.json（与默认文件一致），编辑后 reload 生效，且不覆盖用户编辑', () => {
  const { service, dataDir } = newPersona()
  const filePath = service.getFilePath()
  assert.equal(filePath, path.join(dataDir, 'persona', 'persona.json'))
  assert.ok(fs.existsSync(filePath), '应生成 persona/persona.json')
  assert.equal(fs.readFileSync(filePath, 'utf8'), fs.readFileSync(DEFAULT_PERSONA_FILE, 'utf8'), '首次生成应与默认文件一致')

  // 编辑：改角色名 + 一个 always 模块正文
  const definition = readPersonaFile(service)
  definition.character.name = '验收测试角色名'
  const roleModule = definition.modules.find((module) => module.id === 'role_definition')
  roleModule.content = '这是验收员修改后的角色定义正文，必须出现在渲染结果里。'
  writePersonaFile(service, definition)

  service.reload()
  assert.equal(service.getDefinition().character.name, '验收测试角色名')
  assert.ok(service.renderPersonaSection().includes('这是验收员修改后的角色定义正文'))
  assert.ok(service.lookup('role_definition').content.includes('验收员修改后'))

  // 再次 ensure（模拟插件重启）不得覆盖用户编辑
  const again = createPersonaService({ dataDir })
  again.ensure()
  assert.equal(again.getDefinition().character.name, '验收测试角色名')

  // 默认文件本身为合法中文 JSON
  const defaultDefinition = JSON.parse(fs.readFileSync(DEFAULT_PERSONA_FILE, 'utf8'))
  assert.equal(defaultDefinition.modules.length, 9)
  for (const module of defaultDefinition.modules) {
    assert.match(module.content, /[\u4e00-\u9fff]/u, `默认模块正文应为中文：${module.id}`)
  }
})

// ───────────────────────────── P9 边界：坏 JSON / 缺文件 / 顶层类型错误 ─────────────────────────────

test('P9 边界: persona.json 损坏时 reload 报错且旧数据仍可用', () => {
  const { service } = newPersona()
  const goodName = service.getDefinition().character.name
  fs.writeFileSync(service.getFilePath(), '{ 这不是合法 JSON ', 'utf8')

  assert.throws(
    () => service.reload(),
    (error) => error instanceof Error && /人设文件无法读取|JSON/u.test(error.message),
    '损坏的 JSON 必须抛出可读错误',
  )
  // 旧数据仍在（不会因一次坏文件把服务清空）
  assert.equal(service.getDefinition().character.name, goodName)
  assert.ok(service.renderPersonaSection().includes('【人设 · 始终生效】'))

  // 顶层不是对象（数组）也应报错
  writePersonaFile(service, [1, 2, 3])
  assert.throws(
    () => service.reload(),
    (error) => error instanceof Error && /顶层必须为 JSON 对象/u.test(error.message),
  )

  // 文件缺失时 reload 报错
  fs.rmSync(service.getFilePath())
  assert.throws(
    () => service.reload(),
    (error) => error instanceof Error && /人设文件不存在/u.test(error.message),
  )
})

test('P9 边界: 未 ensure 时服务抛出明确错误；构造参数缺失时报错', () => {
  const dataDir = makeTempDir('dshpet-verify-persona-')
  const service = createPersonaService({ dataDir })
  assert.throws(() => service.getDefinition(), /尚未加载|ensure/u)
  assert.throws(() => service.renderPersonaSection(), /尚未加载|ensure/u)
  assert.throws(() => createPersonaService({}), /dataDir/u)
})

// ───────────────────────────── validate 负向用例（P1/P5/P6/P7/P8 的防线） ─────────────────────────────

test('validate 负向: 模块缺失/顺序错误/生效方式错误/正文非中文/规则缺要点/风格被清空均能报错', () => {
  const cases = [
    {
      name: '缺少模块',
      mutate: (definition) => definition.modules.splice(3, 1),
      pattern: /模块数量应为 9|缺少模块/u,
    },
    {
      name: '模块顺序错误',
      mutate: (definition) => definition.modules.reverse(),
      pattern: /模块顺序错误/u,
    },
    {
      name: '生效方式错误',
      mutate: (definition) => {
        definition.modules.find((module) => module.id === 'herself').activation = 'always'
      },
      pattern: /生效方式应为|activation/u,
    },
    {
      name: '模块正文改为英文',
      mutate: (definition) => {
        definition.modules.find((module) => module.id === 'rules').content = 'Only ASCII content here.'
      },
      pattern: /必须包含中文/u,
    },
    {
      name: '规则缺少挑衅要点',
      mutate: (definition) => {
        definition.modules.find((module) => module.id === 'rules').content = '我要做 AI，注意安全，不发链接。'
      },
      pattern: /挑衅/u,
    },
    {
      name: '记忆和承诺缺少做不到',
      mutate: (definition) => {
        definition.modules.find((module) => module.id === 'memory_and_promises').content = '我不编造，我遵守承诺。'
      },
      pattern: /做不到/u,
    },
    {
      name: '禁用开头被清空',
      mutate: (definition) => {
        definition.style.bannedOpeners = []
      },
      pattern: /bannedOpeners/u,
    },
    {
      name: '缺少 oneLiner',
      mutate: (definition) => {
        definition.character.oneLiner = ''
      },
      pattern: /oneLiner/u,
    },
    {
      name: '缺少 personalHistory',
      mutate: (definition) => {
        delete definition.personalHistory
      },
      pattern: /personalHistory/u,
    },
  ]

  for (const item of cases) {
    const { service } = newPersona()
    const definition = readPersonaFile(service)
    item.mutate(definition)
    writePersonaFile(service, definition)
    service.reload()
    const validation = service.validate()
    assert.equal(validation.ok, false, `篡改「${item.name}」后 validate 应失败`)
    assert.ok(validation.errors.length > 0, `「${item.name}」应给出错误信息`)
    assert.match(validation.errors.join('\n'), item.pattern, `「${item.name}」错误信息应匹配 ${item.pattern}`)
  }
})
