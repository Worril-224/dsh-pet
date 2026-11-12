/**
 * 覆盖验收项：C6（人设卡导入）。
 * 验证外部「8+1 模块人设卡」→ 本项目 persona.json 的转换（模块映射 / 激活方式 /
 * style 推导 / 个人经历状态 / 校验通过），以及已是本项目格式时的直通。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importPersonaCard } from '../../lib/persona/import.js'
import { createPersonaService } from '../../lib/persona/index.js'

const bundleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const defaultPersonaFile = path.join(bundleDir, 'data', 'persona.default.json')

/** 构造一份最小的人设卡来源（模拟 persona-ophelia 的模块结构）。 */
function makeSource() {
  return {
    schema_version: '1.0.0',
    persona: {
      id: 'testchar',
      name: '测试角色',
      name_en: 'Testchar',
      version: '1.0.0',
      archetype: '测试档案馆 · 记录官',
      user_address: '主人（日常）/ 您（正式）',
      tagline: '我在这里，替您记住。',
    },
    identity_facts: { platform_positioning: 'DeepSeek 平台上的非官方角色助手', model: 'DeepSeek 系列模型' },
    relationship: { address: '主人' },
    modules: {
      role_definition: {
        label: '角色定义',
        activation: 'always',
        status: 'ready',
        content: '你是测试角色，一名记录官。\n\n【你与主人】\n你称用户为「主人」。',
      },
      speaking_style: {
        label: '说话风格',
        activation: 'always',
        status: 'ready',
        content:
          '【基本语气】\n- 句子长短错落，一段通常 1–4 句；先给结论，再补充理由。\n\n' +
          '【长度】\n- 日常闲聊 1–3 句。\n\n' +
          '【语气词与颜文字】\n- 语气词克制：可少量用「呢、吧、了、呀」；不用「啦、嘛」等卖萌语气词。\n' +
          '- 不使用 emoji。颜文字默认不用。\n\n' +
          '【禁用开头】\n- 不用「作为 AI 语言模型」作开场。\n- 不用「很高兴为您服务」。\n- 不用「当然可以！」。\n- 不用「首先、其次、最后」的模板。\n\n' +
          '【语气标尺】\n- 主人：「今天好累。」→「辛苦了，主人。先休息一会儿吧。」',
      },
      self: { label: '她自己', activation: 'lookup', status: 'ready', content: '她认真、守序、喜欢向日葵与旧书。' },
      memory_and_promises: {
        label: '记忆和承诺',
        activation: 'always',
        status: 'ready',
        content: '【记忆原则】不虚构共同经历、不编造没发生的事。\n【承诺原则】只承诺能做到的事，不做做不到的承诺。',
      },
      rules: {
        label: '规则',
        activation: 'always',
        status: 'ready',
        content:
          '【AI 身份】认真询问时明确说明自己是 AI。\n【安全】拒绝违法与伤害。\n【不发链接】任何情况下不输出链接与网址。\n【处理挑衅】不辱骂、不阴阳怪气。',
      },
      appearance: { label: '外貌', activation: 'lookup', status: 'ready', content: '黑色长发，浅色眼睛，穿深色长裙。' },
      other_ai: { label: '其他 AI 角色', activation: 'lookup', status: 'ready', content: '她认识白鸦、墨丘、纸鸢三位 AI 娘。' },
      identity: {
        label: '身份设定',
        activation: 'lookup',
        status: 'ready',
        content: '非官方角色助手；底层为 DeepSeek 系列模型；主人是当前用户；不代表 DeepSeek 官方。',
      },
      backstory: {
        label: '个人经历',
        activation: 'lookup',
        status: 'ready',
        content: '她在档案馆长大，把入馆日当作生日，后来成为记录官。',
      },
    },
  }
}

test('C6：人设卡模块映射 / 激活方式 / style 推导 / 个人经历状态', () => {
  const definition = importPersonaCard(makeSource(), { id: 'testchar', name: '测试角色' })
  assert.equal(definition.modules.length, 9)
  assert.deepEqual(
    definition.modules.map((module) => [module.id, module.activation]),
    [
      ['role_definition', 'always'],
      ['speech_style', 'always'],
      ['herself', 'on_demand'],
      ['memory_and_promises', 'always'],
      ['rules', 'always'],
      ['appearance', 'on_demand'],
      ['other_ai_characters', 'on_demand'],
      ['identity', 'on_demand'],
      ['personal_history', 'on_demand'],
    ],
  )
  assert.equal(definition.meta.title, '测试档案馆 · 记录官')
  assert.equal(definition.character.userAddress, '主人')
  assert.match(definition.character.oneLiner, /测试角色/)
  assert.ok(definition.style.bannedOpeners.length >= 3)
  // 语气词：允许项被提取，否定句里的「啦、嘛」不得被当成允许项
  assert.ok(definition.style.toneWords.includes('呢'))
  assert.ok(!definition.style.toneWords.includes('啦'))
  assert.ok(definition.style.forbiddenPatterns.includes('http://'))
  assert.equal(definition.personalHistory.status, 'ready')
  assert.ok(definition.personalHistory.entries.length >= 1)
  assert.equal(definition.examples.length >= 1, true)
})

test('C6：导入结果能通过 PersonaService.validate（真实落盘）', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-import-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const definition = importPersonaCard(makeSource(), { id: 'testchar', name: '测试角色' })
  fs.mkdirSync(path.join(dataDir, 'persona'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'persona', 'persona.json'), JSON.stringify(definition, null, 2) + '\n', 'utf8')
  const persona = createPersonaService({ dataDir, defaultPersonaFile: path.join(dataDir, 'persona', 'persona.json') })
  persona.ensure()
  assert.deepEqual(persona.validate(), { ok: true, errors: [], warnings: [] })
  const rendered = persona.renderPersonaSection()
  assert.match(rendered, /【人设 · 始终生效】/)
  assert.match(rendered, /测试角色/)
  for (const module of definition.modules.filter((entry) => entry.activation === 'on_demand')) {
    assert.ok(!rendered.includes(module.content), `on_demand 正文不得泄漏：${module.id}`)
  }
})

test('C6：缺少模块的人设卡被拒绝；本项目格式可直通', () => {
  const source = makeSource()
  delete source.modules.rules
  assert.throws(() => importPersonaCard(source, { id: 'broken', name: '坏卡' }), /缺少模块/u)

  const ours = JSON.parse(fs.readFileSync(defaultPersonaFile, 'utf8'))
  const passthrough = importPersonaCard(ours, { id: 'passthrough', name: '直通角色' })
  assert.equal(passthrough.modules.length, 9)
  assert.equal(passthrough.character.name, '直通角色')
  assert.ok(passthrough.style.bannedOpeners.length >= 3)
})
