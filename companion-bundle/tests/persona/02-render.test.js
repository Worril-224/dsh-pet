/**
 * 人设模块测试 02：system prompt 人设段渲染。
 * 覆盖验收编号：
 * - P2（always 注入：含 4 个 always 模块正文与说话风格细则，不含任何 on_demand 正文）
 * - P3（on_demand 索引：5 个模块名称 + 「先调用 persona_lookup、不得编造」提示）
 * 同时覆盖 SPEC 3.3 renderPersonaSection() 六条要求的第 1、3、5 条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withPersonaService } from './helpers.js'

const TITLE = '【人设 · 始终生效】'
const ON_DEMAND_TITLE = '【被问到才用的人设资料】'
const HISTORY_TITLE = '【个人经历】'

test('P2: 渲染以标题【人设 · 始终生效】开头并包含角色一句话定义', () => {
  withPersonaService(({ service }) => {
    const definition = service.getDefinition()
    const section = service.renderPersonaSection()
    assert.ok(section.startsWith(TITLE), '人设段必须以【人设 · 始终生效】开头')
    assert.ok(section.includes(definition.character.oneLiner), '必须包含 character.oneLiner')
    assert.ok(section.includes(definition.character.name), '必须包含角色名')
    assert.ok(section.includes(definition.character.userAddress), '必须包含对用户的称呼')
  })
})

test('P2: 渲染包含 4 个 always 模块正文，且顺序正确', () => {
  withPersonaService(({ service }) => {
    const always = service.getAlwaysModules()
    assert.equal(always.length, 4)
    const section = service.renderPersonaSection()
    let cursor = -1
    for (const module of always) {
      assert.ok(section.includes(module.content), `缺少 always 模块正文：${module.id}`)
      assert.ok(section.includes(`【${module.label}】`), `缺少 always 模块标题：${module.label}`)
      const at = section.indexOf(module.content)
      assert.ok(at > cursor, `always 模块顺序错误：${module.id}`)
      cursor = at
    }
  })
})

test('P2: 渲染包含说话风格细则（句式/长度/语气词/颜文字频率/禁用开头列表）', () => {
  withPersonaService(({ service }) => {
    const { style } = service.getDefinition()
    const section = service.renderPersonaSection()
    assert.ok(section.includes('【说话风格细则】'))
    assert.ok(section.includes(style.sentence), '缺少句式要求')
    assert.ok(section.includes(style.length), '缺少长度要求')
    assert.ok(section.includes(style.kaomojiFrequency), '缺少颜文字频率')
    for (const word of style.toneWords) {
      assert.ok(section.includes(word), `缺少语气词：${word}`)
    }
    assert.ok(section.includes('禁用开头'), '必须明确写出「禁用开头」')
    for (const opener of style.bannedOpeners) {
      assert.ok(section.includes(`「${opener}」`), `禁用开头列表缺少：${opener}`)
    }
  })
})

test('P2: 渲染绝不包含任何 on_demand 模块正文（整段与开头片段都不得出现）', () => {
  withPersonaService(({ service }) => {
    const onDemand = service.getOnDemandModules()
    assert.equal(onDemand.length, 5)
    const section = service.renderPersonaSection()
    for (const module of onDemand) {
      assert.ok(!section.includes(module.content), `渲染不得包含 on_demand 正文：${module.id}`)
      const head = module.content.slice(0, 24)
      assert.ok(!section.includes(head), `渲染不得包含 on_demand 正文片段：${module.id}`)
    }
  })
})

test('P3: 渲染包含【被问到才用的人设资料】，列出 5 个 on_demand 模块名称与话题提示', () => {
  withPersonaService(({ service }) => {
    const onDemand = service.getOnDemandModules()
    const section = service.renderPersonaSection()
    assert.ok(section.includes(ON_DEMAND_TITLE))
    for (const module of onDemand) {
      assert.ok(section.includes(module.label), `索引段缺少模块名称：${module.label}`)
      assert.ok(section.includes(`（${module.id}）`), `索引段缺少模块 id：${module.id}`)
    }
    // 话题提示（只提示话题，不泄露正文）
    for (const hint of ['发色', '同僚', '契约', '往事', '小毛病']) {
      assert.ok(section.includes(hint), `索引段缺少话题提示：${hint}`)
    }
  })
})

test('P3: 渲染明确要求「先调用 persona_lookup、未查到就说记不清、不得编造」', () => {
  withPersonaService(({ service }) => {
    const section = service.renderPersonaSection()
    assert.ok(section.includes('persona_lookup'))
    assert.ok(section.includes('先调用 persona_lookup'))
    assert.ok(section.includes('记不清'))
    assert.ok(section.includes('不得编造'))
  })
})

test('P3 顺序: 人设段依次为 标题 → always 正文 → 风格细则 → on_demand 索引 → 个人经历', () => {
  withPersonaService(({ service }) => {
    const section = service.renderPersonaSection()
    const indexOfTitle = section.indexOf(TITLE)
    const indexOfStyle = section.indexOf('【说话风格细则】')
    const indexOfOnDemand = section.indexOf(ON_DEMAND_TITLE)
    const indexOfHistory = section.indexOf(HISTORY_TITLE)
    assert.equal(indexOfTitle, 0)
    assert.ok(indexOfStyle > indexOfTitle)
    assert.ok(indexOfOnDemand > indexOfStyle)
    assert.ok(indexOfHistory > indexOfOnDemand)
  })
})

test('SPEC 3.3⑤: 渲染包含【个人经历】pending 状态提示，且不泄露其正文', () => {
  withPersonaService(({ service }) => {
    const definition = service.getDefinition()
    const section = service.renderPersonaSection()
    assert.ok(section.includes(HISTORY_TITLE))
    assert.ok(section.includes('pending_user_input'))
    assert.ok(section.includes('等待主人补充'))
    const historyModule = definition.modules.find((module) => module.id === 'personal_history')
    assert.ok(!section.includes(historyModule.content))
  })
})

test('P2: 渲染结果非空且为多行中文文本', () => {
  withPersonaService(({ service }) => {
    const section = service.renderPersonaSection()
    assert.ok(section.length > 500)
    assert.match(section, /[\u4e00-\u9fff]/)
    assert.ok(section.split('\n').length > 10)
  })
})
