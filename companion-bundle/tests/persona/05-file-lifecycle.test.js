/**
 * 人设模块测试 05：可编辑数据文件的生命周期与 validate() 负向检查。
 * 覆盖验收编号：P9（数据文件可编辑：persona/persona.json 生成；修改后 reload 生效；
 * 默认文件为合法中文 JSON）、以及 P1/P5/P6/P7/P8 的校验负向路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createPersonaService } from '../../lib/persona/index.js'
import {
  DEFAULT_PERSONA_FILE,
  createTestService,
  makeTempDataDir,
  moduleContent,
  personaFilePath,
  readDefaultPersona,
  readPersonaFile,
  removeTempDataDir,
  withMutatedPersona,
  withPersonaService,
  writePersonaFile,
  writeRawPersonaFile,
} from './helpers.js'

test('P9: ensure() 从默认文件复制生成 <dataDir>/persona/persona.json（目录自动创建）', () => {
  const dataDir = makeTempDataDir()
  try {
    const service = createTestService(dataDir)
    assert.equal(service.getFilePath(), personaFilePath(dataDir))
    assert.ok(path.isAbsolute(service.getFilePath()))
    assert.equal(fs.existsSync(service.getFilePath()), false, 'ensure 前不应存在人设文件')

    service.ensure()
    assert.ok(fs.existsSync(service.getFilePath()), 'ensure 后应生成人设文件')
    assert.ok(fs.statSync(path.dirname(service.getFilePath())).isDirectory())
    assert.deepEqual(readPersonaFile(dataDir), readDefaultPersona())
    assert.ok(typeof service.getLoadedAt() === 'string')
  } finally {
    removeTempDataDir(dataDir)
  }
})

test('P9: 未传 defaultPersonaFile 时使用 bundle 内置默认人设文件', () => {
  const dataDir = makeTempDataDir()
  try {
    const service = createPersonaService({ dataDir })
    service.ensure()
    assert.deepEqual(readPersonaFile(dataDir), readDefaultPersona())
    assert.ok(service.renderPersonaSection().includes('【人设 · 始终生效】'))
  } finally {
    removeTempDataDir(dataDir)
  }
})

test('P9: ensure() 幂等，不会覆盖用户编辑过的人设文件', () => {
  withPersonaService(({ dataDir, service }) => {
    const edited = readPersonaFile(dataDir)
    edited.character.oneLiner = '一只被主人改过一句话人设的猫耳看板娘。'
    writePersonaFile(dataDir, edited)

    service.ensure() // 再次 ensure 不应覆盖
    assert.equal(readPersonaFile(dataDir).character.oneLiner, edited.character.oneLiner)
    assert.equal(service.getDefinition().character.oneLiner, edited.character.oneLiner)
  })
})

test('P9: 修改 persona.json 后 reload() 生效（render/lookup/getDefinition 同步更新）', () => {
  withPersonaService(({ dataDir, service }) => {
    const before = service.getDefinition()
    assert.ok(service.renderPersonaSection().includes(before.character.oneLiner))

    const edited = readPersonaFile(dataDir)
    edited.character.oneLiner = '一只改过一句话人设的猫耳看板娘，擅长陪主人熬夜。'
    edited.modules.find((module) => module.id === 'herself').content =
      '我的口味：我最喜欢抹茶味大福，也喜欢热牛奶。'
    writePersonaFile(dataDir, edited)

    // 未 reload 时仍为旧数据
    assert.equal(service.getDefinition().character.oneLiner, before.character.oneLiner)

    service.reload()
    assert.equal(service.getDefinition().character.oneLiner, edited.character.oneLiner)
    const section = service.renderPersonaSection()
    assert.ok(section.includes(edited.character.oneLiner))
    assert.equal(service.lookup('herself').content, edited.modules[2].content)
    // on_demand 正文仍不会进入渲染
    assert.ok(!section.includes(edited.modules[2].content))
  })
})

test('P9: getDefinition() 返回深拷贝，外部修改不会影响服务', () => {
  withPersonaService(({ service }) => {
    const first = service.getDefinition()
    const originalOneLiner = first.character.oneLiner
    first.character.oneLiner = '被篡改的一句话'
    first.modules[0].content = '被篡改的正文'
    const second = service.getDefinition()
    assert.equal(second.character.oneLiner, originalOneLiner)
    assert.notEqual(second.modules[0].content, '被篡改的正文')
    assert.ok(service.renderPersonaSection().includes(originalOneLiner))
  })
})

test('P9: 人设 JSON 被改坏时 reload() 抛出可读错误，旧数据仍可用', () => {
  withPersonaService(({ dataDir, service }) => {
    writeRawPersonaFile(dataDir, '{ 这不是合法 JSON')
    assert.throws(() => service.reload(), /人设文件无法读取|JSON/)
    // 旧数据仍然可用，渲染不崩溃
    assert.ok(service.renderPersonaSection().includes('【人设 · 始终生效】'))
  })
})

test('P9: 未 ensure() 前调用渲染抛出明确错误', () => {
  const dataDir = makeTempDataDir()
  try {
    const service = createTestService(dataDir)
    assert.throws(() => service.renderPersonaSection(), /ensure|reload|尚未加载/)
    assert.throws(() => service.getDefinition(), /ensure|reload|尚未加载/)
  } finally {
    removeTempDataDir(dataDir)
  }
})

test('validate 负向: 缺少模块时 ok=false 并报告缺失的 id', () => {
  withMutatedPersona(
    (definition) => {
      definition.modules = definition.modules.filter((module) => module.id !== 'identity')
    },
    ({ service }) => {
      const result = service.validate()
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((message) => message.includes('identity')))
      assert.ok(result.errors.some((message) => message.includes('模块数量')))
    },
  )
})

test('validate 负向: 模块顺序错误时 ok=false', () => {
  withMutatedPersona(
    (definition) => {
      const modules = definition.modules
      const indexOfHerself = modules.findIndex((module) => module.id === 'herself')
      const indexOfAppearance = modules.findIndex((module) => module.id === 'appearance')
      ;[modules[indexOfHerself], modules[indexOfAppearance]] = [modules[indexOfAppearance], modules[indexOfHerself]]
    },
    ({ service }) => {
      const result = service.validate()
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((message) => message.includes('顺序错误')))
    },
  )
})

test('validate 负向: 生效方式错误时 ok=false', () => {
  withMutatedPersona(
    (definition) => {
      definition.modules.find((module) => module.id === 'herself').activation = 'always'
    },
    ({ service }) => {
      const result = service.validate()
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((message) => message.includes('生效方式')))
    },
  )
})

test('validate 负向: 模块正文为空或非中文时 ok=false', () => {
  withMutatedPersona(
    (definition) => {
      definition.modules.find((module) => module.id === 'appearance').content = ''
      definition.modules.find((module) => module.id === 'identity').content = 'English only content.'
    },
    ({ service }) => {
      const result = service.validate()
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((message) => message.includes('appearance') && message.includes('content')))
      assert.ok(result.errors.some((message) => message.includes('identity') && message.includes('中文')))
    },
  )
})

test('validate 负向: 规则正文缺少「挑衅」等要点时 ok=false', () => {
  withMutatedPersona(
    (definition) => {
      definition.modules.find((module) => module.id === 'rules').content = '我始终记得自己是 AI，注意安全，也不发链接。'
    },
    ({ service }) => {
      const result = service.validate()
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((message) => message.includes('挑衅')))
    },
  )
})

test('validate 负向: 记忆和承诺正文缺少「做不到」时 ok=false', () => {
  withMutatedPersona(
    (definition) => {
      definition.modules.find((module) => module.id === 'memory_and_promises').content =
        '我不编造没聊过的事，也遵守承诺。'
    },
    ({ service }) => {
      const result = service.validate()
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((message) => message.includes('做不到')))
    },
  )
})

test('validate 负向: 缺少 personalHistory 或 oneLiner 时 ok=false', () => {
  withMutatedPersona(
    (definition) => {
      delete definition.personalHistory
      definition.character.oneLiner = ''
    },
    ({ service }) => {
      const result = service.validate()
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((message) => message.includes('personalHistory')))
      assert.ok(result.errors.some((message) => message.includes('oneLiner')))
    },
  )
})

test('validate 负向: style 缺失关键字段时 ok=false', () => {
  withMutatedPersona(
    (definition) => {
      definition.style.length = ''
      delete definition.style.kaomojiFrequency
      definition.style.forbiddenPatterns = []
    },
    ({ service }) => {
      const result = service.validate()
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((message) => message.includes('style.length')))
      assert.ok(result.errors.some((message) => message.includes('kaomojiFrequency')))
      assert.ok(result.errors.some((message) => message.includes('forbiddenPatterns')))
    },
  )
})

test('validate: 默认数据 ok=true 且 errors 为空', () => {
  withPersonaService(({ service }) => {
    const result = service.validate()
    assert.deepEqual(result, { ok: true, errors: [], warnings: [] })
  })
})

test('P9: 默认文件与复制后数据完全一致，且默认文件路径存在', () => {
  assert.ok(fs.existsSync(DEFAULT_PERSONA_FILE))
  withPersonaService(({ dataDir }) => {
    const copied = readPersonaFile(dataDir)
    assert.deepEqual(copied, readDefaultPersona())
    assert.ok(copied.modules.every((module) => typeof module.content === 'string' && module.content.length > 20))
    assert.ok(copied.modules.every((module) => moduleContent(copied, module.id) === module.content))
  })
})
