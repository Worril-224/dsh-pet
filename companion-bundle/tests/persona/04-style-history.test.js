/**
 * 人设模块测试 04：说话风格与个人经历占位。
 * 覆盖验收编号：
 * - P7（说话风格：style 字段齐全；bannedOpeners 非空且至少 3 个；颜文字频率与长度要求存在）
 * - P8（个人经历占位：personalHistory.status = pending_user_input，模块存在且标注待补充）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { moduleOf, moduleContent, withMutatedPersona, withPersonaService } from './helpers.js'

const CHINESE = /[\u4e00-\u9fff]/

test('P7: style 字段齐全（sentence/length/toneWords/kaomojiFrequency/bannedOpeners/forbiddenPatterns）', () => {
  withPersonaService(({ service }) => {
    const style = service.getDefinition().style
    assert.ok(style && typeof style === 'object')
    assert.ok(typeof style.sentence === 'string' && style.sentence.trim().length > 0, '缺少句式要求')
    assert.ok(typeof style.length === 'string' && style.length.trim().length > 0, '缺少长度要求')
    assert.ok(typeof style.kaomojiFrequency === 'string' && style.kaomojiFrequency.trim().length > 0, '缺少颜文字频率')
    assert.ok(Array.isArray(style.toneWords) && style.toneWords.length >= 3, '语气词至少 3 个')
    for (const word of style.toneWords) assert.match(word, CHINESE)
    assert.ok(Array.isArray(style.bannedOpeners), 'bannedOpeners 必须为数组')
    assert.ok(style.bannedOpeners.length >= 3, 'bannedOpeners 至少 3 个')
    assert.ok(style.bannedOpeners.includes('作为一个AI'))
    assert.ok(Array.isArray(style.forbiddenPatterns) && style.forbiddenPatterns.length > 0)
    assert.ok(style.forbiddenPatterns.includes('http://'))
    assert.ok(style.forbiddenPatterns.includes('https://'))
    // 长度与颜文字频率要求必须是中文说明
    assert.match(style.length, CHINESE)
    assert.match(style.kaomojiFrequency, CHINESE)
  })
})

test('P7: 风格细则进入渲染（禁用开头列表、语气词、长度、颜文字频率）', () => {
  withPersonaService(({ service }) => {
    const style = service.getDefinition().style
    const section = service.renderPersonaSection()
    assert.ok(section.includes('【说话风格细则】'))
    assert.ok(section.includes(style.length))
    assert.ok(section.includes(style.kaomojiFrequency))
    for (const word of style.toneWords) assert.ok(section.includes(word))
    for (const opener of style.bannedOpeners) assert.ok(section.includes(`「${opener}」`))
  })
})

test('P7: validate() 对默认风格数据通过', () => {
  withPersonaService(({ service }) => {
    const result = service.validate()
    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  })
})

test('P7: validate() 能发现 bannedOpeners 被清空', () => {
  withMutatedPersona(
    (definition) => {
      definition.style.bannedOpeners = []
    },
    ({ service }) => {
      const result = service.validate()
      assert.equal(result.ok, false)
      assert.ok(result.errors.some((message) => message.includes('bannedOpeners')))
    },
  )
})

test('P8: personalHistory.status = pending_user_input，entries 为空且 note 说明等待补充', () => {
  withPersonaService(({ service }) => {
    const definition = service.getDefinition()
    assert.equal(definition.personalHistory.status, 'pending_user_input')
    assert.deepEqual(definition.personalHistory.entries, [])
    assert.ok(typeof definition.personalHistory.note === 'string' && definition.personalHistory.note.trim().length > 0)
    assert.match(definition.personalHistory.note, /补充/)
  })
})

test('P8: 个人经历模块存在、为 on_demand 且正文标注待补充', () => {
  withPersonaService(({ service }) => {
    const definition = service.getDefinition()
    const module = moduleOf(definition, 'personal_history')
    assert.ok(module, '缺少 personal_history 模块')
    assert.equal(module.label, '个人经历')
    assert.equal(module.activation, 'on_demand')
    assert.match(moduleContent(definition, 'personal_history'), /补充/)
    assert.match(moduleContent(definition, 'personal_history'), /pending_user_input/)

    const lookupResult = service.lookup('personal_history')
    assert.equal(lookupResult.ok, true)
    assert.match(lookupResult.content, /补充/)
  })
})

test('P8: 渲染中的【个人经历】段说明等待主人补充且不包含正文', () => {
  withPersonaService(({ service }) => {
    const definition = service.getDefinition()
    const section = service.renderPersonaSection()
    const historyModule = moduleOf(definition, 'personal_history')
    assert.ok(section.includes('【个人经历】'))
    assert.ok(section.includes('pending_user_input'))
    assert.match(section, /等待主人补充|待补充/)
    assert.ok(!section.includes(historyModule.content))
  })
})

test('P8: personalHistory.entries 可以承载后续补充的个人经历', () => {
  withMutatedPersona(
    (definition) => {
      definition.personalHistory.status = 'ready'
      definition.personalHistory.entries = [
        {
          at: '2026-11-05T20:00:00+08:00',
          title: '第一次见面',
          content: '主人在 11 月 5 日晚上第一次打开铃兰的聊天窗口。',
        },
      ]
    },
    ({ service }) => {
      const definition = service.getDefinition()
      assert.equal(definition.personalHistory.status, 'ready')
      assert.equal(definition.personalHistory.entries.length, 1)
      const result = service.validate()
      assert.equal(result.ok, true)
      assert.deepEqual(result.errors, [])
    },
  )
})
