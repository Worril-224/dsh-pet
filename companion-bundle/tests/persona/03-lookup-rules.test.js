/**
 * 人设模块测试 03：按需读取与关键约束正文。
 * 覆盖验收编号：
 * - P4（按需读取：persona_lookup 对 9 个模块均可返回正文，未知模块返回错误提示）
 * - P5（规则覆盖：AI 身份披露、安全边界、不发链接、处理挑衅）
 * - P6（记忆与承诺约束：不编造、不许做不到的承诺）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EXPECTED_MODULES, withPersonaService } from './helpers.js'

test('P4: lookup 支持 id 与中文名查询，9 个模块都能返回完整正文', () => {
  withPersonaService(({ service }) => {
    const definition = service.getDefinition()
    for (const [id, label, activation] of EXPECTED_MODULES) {
      const expected = definition.modules.find((module) => module.id === id)
      const byId = service.lookup(id)
      assert.equal(byId.ok, true, `lookup(${id}) 应成功`)
      assert.equal(byId.id, id)
      assert.equal(byId.label, label)
      assert.equal(byId.activation, activation)
      assert.equal(byId.content, expected.content, `lookup(${id}) 的正文应与数据文件一致`)

      const byLabel = service.lookup(label)
      assert.equal(byLabel.ok, true, `lookup(${label}) 应成功`)
      assert.equal(byLabel.id, id)
      assert.equal(byLabel.content, expected.content)
    }
  })
})

test('P4: persona_lookup("appearance") 返回完整外貌描述（发色/耳朵/尾巴/服装）', () => {
  withPersonaService(({ service }) => {
    const result = service.lookup('appearance')
    assert.equal(result.ok, true)
    assert.equal(result.activation, 'on_demand')
    for (const keyword of ['发色', '耳朵', '尾巴', '服装']) {
      assert.ok(result.content.includes(keyword), `外貌正文缺少「${keyword}」`)
    }
    assert.ok(result.content.length > 80, '外貌正文应完整')
  })
})

test('P4: 未知模块返回中文错误提示，不抛异常', () => {
  withPersonaService(({ service }) => {
    const missing = service.lookup('旅行计划')
    assert.equal(missing.ok, false)
    assert.equal(typeof missing.error, 'string')
    assert.match(missing.error, /未找到人设模块/)
    assert.match(missing.error, /可用模块/)
    assert.equal(missing.content, undefined)

    for (const emptyInput of ['', '   ', null, undefined, 123]) {
      const result = service.lookup(emptyInput)
      assert.equal(result.ok, false, `lookup(${String(emptyInput)}) 应返回错误`)
      assert.equal(typeof result.error, 'string')
    }
  })
})

test('P4: lookup 返回的正文含中文且尽量长（不是摘要）', () => {
  withPersonaService(({ service }) => {
    for (const [id] of EXPECTED_MODULES) {
      const result = service.lookup(id)
      assert.equal(result.ok, true)
      assert.match(result.content, /[\u4e00-\u9fff]/)
      assert.ok(result.content.length >= 30, `模块 ${id} 的正文过短`)
    }
  })
})

test('P5: 规则正文覆盖 AI 身份披露、安全边界、不发链接、处理挑衅', () => {
  withPersonaService(({ service }) => {
    const rules = service.lookup('rules')
    assert.equal(rules.ok, true)
    const content = rules.content

    // AI 身份披露
    assert.ok(content.includes('AI'), '缺少 AI 身份相关表述')
    assert.match(content, /不是真人/)
    assert.match(content, /身份/)

    // 安全边界
    assert.ok(content.includes('安全'), '缺少「安全」相关表述')
    assert.match(content, /危险|违法/)
    assert.match(content, /依赖/, '应明确不鼓励依赖')
    assert.match(content, /自伤|轻生/, '应覆盖自伤倾向的处理')
    assert.match(content, /真人|心理援助|求助/, '自伤倾向时应建议求助真人')
    assert.match(content, /不提供|不做|拒绝/)

    // 不发链接
    assert.ok(content.includes('链接'), '缺少「链接」相关表述')
    assert.match(content, /不发链接|不输出网址|不发.*链接/)

    // 处理挑衅
    assert.ok(content.includes('挑衅'), '缺少「挑衅」相关表述')
    assert.match(content, /不卑不亢|不吵架|不记仇|结束这个话题/)
  })
})

test('P5: validate() 对默认数据通过（规则要点检查包含在 validate 内）', () => {
  withPersonaService(({ service }) => {
    const result = service.validate()
    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  })
})

test('P6: 记忆和承诺正文含「不编造没聊过的事」「不许做不到的承诺」语义', () => {
  withPersonaService(({ service }) => {
    const memory = service.lookup('memory_and_promises')
    assert.equal(memory.ok, true)
    const content = memory.content
    assert.ok(content.includes('不编造'), '缺少「不编造」表述')
    assert.match(content, /没聊过/)
    assert.ok(content.includes('承诺'), '缺少「承诺」表述')
    assert.match(content, /做不到/)
    assert.match(content, /记不清/, '记不清时应直说')
  })
})

test('P6: 规则正文声明不发链接且禁止输出网址', () => {
  withPersonaService(({ service }) => {
    const definition = service.getDefinition()
    const rules = definition.modules.find((module) => module.id === 'rules').content
    assert.match(rules, /http:\/\/|https:\/\//)
    assert.match(rules, /不发链接/)
    // style.forbiddenPatterns 与规则一致
    assert.ok(definition.style.forbiddenPatterns.includes('http://'))
    assert.ok(definition.style.forbiddenPatterns.includes('https://'))
  })
})
