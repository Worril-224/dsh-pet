/**
 * 人设模块测试 01：模块清单与默认数据文件。
 * 覆盖验收编号：P1（8+1 模块完整，id/label/activation/顺序与 SPEC 3.1 完全一致）。
 * 另外对 P9 做静态检查：默认文件是人们可直接编辑的合法中文 JSON。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createPersonaService, PersonaService } from '../../lib/persona/index.js'
import {
  DEFAULT_PERSONA_FILE,
  EXPECTED_MODULES,
  createTestService,
  makeTempDataDir,
  readDefaultPersona,
  removeTempDataDir,
  withPersonaService,
} from './helpers.js'

const CHINESE = /[\u4e00-\u9fff]/

test('P1: 默认数据文件的 9 个模块 id/label/activation/顺序与 SPEC 3.1 完全一致', () => {
  const definition = readDefaultPersona()
  assert.ok(Array.isArray(definition.modules), 'modules 必须为数组')
  assert.equal(definition.modules.length, 9)
  assert.deepEqual(
    definition.modules.map((module) => [module.id, module.label, module.activation]),
    EXPECTED_MODULES.map(([id, label, activation]) => [id, label, activation]),
  )
})

test('P1: always 4 个、on_demand 5 个，且包含「个人经历」扩展模块', () => {
  withPersonaService(({ service }) => {
    const always = service.getAlwaysModules()
    const onDemand = service.getOnDemandModules()
    assert.deepEqual(
      always.map((module) => module.id),
      ['role_definition', 'speech_style', 'memory_and_promises', 'rules'],
    )
    assert.deepEqual(
      onDemand.map((module) => module.id),
      ['herself', 'appearance', 'other_ai_characters', 'identity', 'personal_history'],
    )
    assert.equal(always.length, 4)
    assert.equal(onDemand.length, 5)
    for (const module of [...always, ...onDemand]) {
      assert.equal(typeof module.content, 'string')
      assert.ok(module.content.trim().length > 20, `模块 ${module.id} 的正文不应为空`)
    }
  })
})

test('P1: moduleList() 返回 9 项，含 id/label/activation/summary 且顺序不变', () => {
  withPersonaService(({ service }) => {
    const list = service.moduleList()
    assert.equal(list.length, 9)
    assert.deepEqual(
      list.map((item) => item.id),
      EXPECTED_MODULES.map(([id]) => id),
    )
    for (const item of list) {
      assert.equal(typeof item.id, 'string')
      assert.equal(typeof item.label, 'string')
      assert.ok(item.activation === 'always' || item.activation === 'on_demand')
      assert.equal(typeof item.summary, 'string')
      assert.ok(item.summary.length > 0, `模块 ${item.id} 的 summary 不应为空`)
    }
  })
})

test('P1/P9: 默认文件是合法 UTF-8 JSON，9 个模块正文均为中文', () => {
  const text = fs.readFileSync(DEFAULT_PERSONA_FILE, 'utf8')
  assert.ok(text.includes('铃兰'))
  const definition = JSON.parse(text) // 解析失败会直接抛错
  assert.equal(definition.schemaVersion, 1)
  assert.equal(definition.meta.name, '铃兰')
  assert.equal(definition.character.name, '铃兰')
  assert.equal(definition.character.userAddress, '主人')
  assert.ok(definition.character.platform.includes('DeepSeek Harness'))
  assert.ok(typeof definition.meta.editableHint === 'string' && definition.meta.editableHint.length > 0)
  for (const module of definition.modules) {
    assert.ok(CHINESE.test(module.content), `模块 ${module.id} 的正文必须为中文`)
  }
})

test('P1: 数据文件中的模块 id 不重复', () => {
  const definition = readDefaultPersona()
  const ids = definition.modules.map((module) => module.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('P1: createPersonaService 返回 PersonaService 实例，缺少 dataDir 时抛出可读错误', () => {
  const dataDir = makeTempDataDir()
  try {
    const service = createTestService(dataDir)
    assert.ok(service instanceof PersonaService)
    assert.equal(typeof service.ensure, 'function')
  } finally {
    removeTempDataDir(dataDir)
  }
  assert.throws(() => createPersonaService({}), /dataDir/)
})
