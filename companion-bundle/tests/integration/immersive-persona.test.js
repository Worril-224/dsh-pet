/**
 * 2026-11-06 沉浸式人设验收（真实 ophelia 人物，只读）：
 *  - 人设中不再包含 AI / 模型 / 平台 / DeepSeek 官方等现实技术层自我认知；
 *  - 9 模块 label/activation 合法，validate 通过；
 *  - 说话长度：日常 10–300 字，出现「想多听」类信号时主动展开；
 *  - 渲染段不含 on_demand 正文、不出现 AI 相关词；
 *  - 其他同僚模块 label 为「其他同僚」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createPersonaService } from '../../lib/persona/index.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..')
const CHAR_DIR = path.join(ROOT, 'companion-data', 'characters', 'ophelia')
const PERSONA_FILE = path.join(CHAR_DIR, 'persona', 'persona.json')
const AI_TERMS = ['AI', '人工智能', '语言模型', 'DeepSeek', 'deepseek', '底层模型', '平台定位', '角色扮演助手', '非官方角色', '程序']

function walkStrings(value, visitor, keyPath = '') {
  if (typeof value === 'string') visitor(value, keyPath)
  else if (Array.isArray(value)) value.forEach((item, index) => walkStrings(item, visitor, `${keyPath}[${index}]`))
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walkStrings(item, visitor, `${keyPath}.${key}`)
  }
}

test('沉浸式人设：真实 ophelia 数据不含 AI 自我认知，validate 通过', { skip: !fs.existsSync(PERSONA_FILE) && '真实 ophelia 人设不存在' }, () => {
  const definition = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'))
  const hits = []
  walkStrings(definition, (text, keyPath) => {
    for (const term of AI_TERMS) {
      if (text.includes(term)) {
        hits.push(`${keyPath} 含「${term}」`)
        break
      }
    }
  })
  assert.deepEqual(hits, [], `人设仍含 AI/现实技术层内容：${hits.join('；')}`)

  const service = createPersonaService({ dataDir: CHAR_DIR })
  service.ensure()
  assert.deepEqual(service.validate(), { ok: true, errors: [], warnings: [] })
  const rendered = service.renderPersonaSection()
  assert.ok(rendered.length > 5000, `渲染长度异常：${rendered.length}`)
  for (const term of AI_TERMS) assert.ok(!rendered.includes(term), `渲染段仍含「${term}」`)

  const other = service.lookup('other_ai_characters')
  assert.equal(other.ok, true)
  assert.equal(other.label, '其他同僚')

  const speech = service.lookup('speech_style')
  assert.match(speech.content, /10–300 字/u)
  assert.match(speech.content, /然后呢/u)
  assert.match(speech.content, /主动展开/u)
  assert.match(speech.content, /参考示例/u)
  assert.match(speech.content, /青春感/u)
  assert.match(speech.content, /像真人说话/u)
  assert.match(speech.content, /描写格式/u)
  assert.match(speech.content, /收尾与追问/u)
  assert.match(speech.content, /明确禁止/u)
  assert.match(speech.content, /禁止说「记下来」/u)
  assert.match(speech.content, /禁止重复用户的原话/u)
  assert.match(speech.content, /必要的心声只用“”/u)
  assert.match(speech.content, /不要像通用聊天助手/u)
  const speechExamples = speech.content.split('【参考示例')[1] ?? ''
  assert.ok(!/→[^\n]*？/u.test(speechExamples), '参考示例的回复不应以追问收尾')
  assert.ok(service.getDefinition().examples.every((item) => !item.assistant.trim().endsWith('？')), '顶层示例不应以追问收尾')
  assert.ok(service.getDefinition().examples.length >= 8, '参考示例应至少 8 组')
  assert.ok(service.getDefinition().examples.length >= 8, '参考示例应至少 8 组')
  assert.ok((service.getDefinition().style.toneWords ?? []).includes('啦'), '语气词应包含轻快的「啦」')
  assert.match(service.getDefinition().style.length, /10–300 字/u)
  assert.ok(rendered.length >= 7500, `渲染应包含完整语言风格参考示例，实际 ${rendered.length}`)

  const rules = service.lookup('rules')
  for (const keyword of ['安全', '链接', '挑衅']) assert.ok(rules.content.includes(keyword), `规则缺少「${keyword}」`)
  assert.equal(rules.content.includes('AI'), false)

  const identity = service.lookup('identity')
  for (const term of ['模型', '平台', 'DeepSeek', 'AI']) assert.equal(identity.content.includes(term), false)
})
