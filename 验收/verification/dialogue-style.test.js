/**
 * 独立验收测试 · 2026-11-06 对话表达纪律（DL1–DL5）
 *
 * DL1 描写格式：对话正文直接写、神态「」、动作（）/环境、极短心声“”；尽量不写心里话/旁白。
 * DL2 收尾与追问：不以服务性追问收尾；只有确需确认事实/安全/时间地点才问。
 * DL3 明确禁止：不汇报「记下来/我记下了/记住了/已记录」；不复读用户原话；不直抒心情/大段心理。
 * DL4 去助手腔：不总结/不分点（清单除外）/不解释设定功能/不主动给下一步选项。
 * DL5 示例与兼容：16 组 speech + 8 组顶层示例均为新格式；validate ok、渲染 8902±、无 AI 词、长度规则保留。
 * 全部只读真实数据 + 临时副本校验，不联网、不写 companion-data、不改实现/数据、不重启 Harness。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPersonaService } from '../../companion-bundle/lib/persona/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE = path.join(ROOT, 'companion-data', 'characters', 'ophelia')
const PERSONA_FILE = path.join(BASE, 'persona', 'persona.json')
const MEMORY_DIR = path.join(BASE, 'memory')
const PENDING_FILE = path.join(MEMORY_DIR, 'pending-seed.json')

const AI_TERMS = ['AI', '人工智能', '语言模型', 'DeepSeek', 'deepseek', '底层模型', '平台定位', '角色扮演助手', '非官方角色', '程序', '模型', '平台', '系统']
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u
// 「记下」类汇报 + 旁白心理 + 直抒心情（注意：这些词出现在规则正文的「禁止」语境是允许的，只检查示例与示例输出）
const FORBIDDEN_IN_EXAMPLES = ['记下来', '我记下了', '记住了', '已记录', '收到，我记下了', '她心想', '她觉得', '她感到']
const SERVICE_ENDING = /(接下来要做什么|还需要我做什么|要不要我帮您|您还有什么需要|还需要我做什么)[^」]*$/u
const ASSISTANT_SPEAK = ['总的来说', '希望这对您有帮助', '希望这个回答对您有帮助', '首先，其次', '我理解了', '我将为您', '接下来可以做什么']

function readPersona() {
  const raw = fs.readFileSync(PERSONA_FILE, 'utf8')
  return { raw, definition: JSON.parse(raw) }
}

function speechOf(definition) {
  return definition.modules.find((module) => module.id === 'speech_style').content
}

function parseSpeechExamples(speech) {
  const block = (speech.split('【参考示例（借用语气与节奏，不必逐字照抄）】')[1] ?? '').split('【禁用开头】')[0]
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- 主人：「'))
    .map((line) => {
      const match = /^-\s*主人：「([\s\S]*?)」→\s*([\s\S]*)$/u.exec(line)
      return match ? { user: match[1], assistant: match[2] } : { raw: line }
    })
}

function scanAi(value) {
  const hits = []
  const walk = (item, keyPath = '') => {
    if (typeof item === 'string') {
      for (const term of AI_TERMS) {
        if (item.includes(term)) {
          hits.push(`${keyPath} 含「${term}」`)
          break
        }
      }
    } else if (Array.isArray(item)) item.forEach((entry, index) => walk(entry, `${keyPath}[${index}]`))
    else if (item && typeof item === 'object') {
      for (const [key, entry] of Object.entries(item)) walk(entry, `${keyPath}.${key}`)
    }
  }
  walk(value)
  return hits
}

function validateAndRender() {
  const { raw, definition } = readPersona()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpet-verify-dl-'))
  try {
    fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'persona', 'persona.json'), raw)
    const service = createPersonaService({ dataDir: tmp, defaultPersonaFile: path.join(tmp, 'persona', 'persona.json') })
    service.ensure()
    return { definition, validation: service.validate(), rendered: service.renderPersonaSection() }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function allExamples(definition) {
  const speech = speechOf(definition)
  return { speechExamples: parseSpeechExamples(speech), topExamples: definition.examples ?? [] }
}

// ───────────────────────────── DL1 ─────────────────────────────

test('DL1: 描写格式——对话正文直接写、神态「」、动作（）/环境、极短心声“”；不写她心想/她觉得旁白', () => {
  const { definition } = readPersona()
  const speech = speechOf(definition)
  assert.match(speech, /【描写格式（重要）】/u)
  for (const fragment of [
    '对话正文直接写',
    '神态、表情、视线用「」括起',
    '动作、身体移动、环境动作用（）括起',
    '尽量不写心里话',
    '非写不可时用“”括起',
    '不写“她心想/她觉得/她感到”的旁白',
    '不直接写心情',
  ]) {
    assert.ok(speech.includes(fragment), `描写格式规则缺少：${fragment}`)
  }
  assert.match(definition.style.sentence, /对话正文直接写/u)
  assert.match(definition.style.sentence, /神态用「」/u)
  assert.match(definition.style.sentence, /动作用（）/u)
  assert.match(definition.style.sentence, /极短心声用“”/u)

  // 示例必须实际使用格式标记；心声最多 1 处/例
  const { speechExamples, topExamples } = allExamples(definition)
  for (const entry of [...speechExamples, ...topExamples]) {
    const text = entry.assistant
    assert.ok(['「', '（', '“'].some((mark) => text.includes(mark)), `示例未使用任何描写格式标记：${text}`)
    assert.ok((text.match(/“/gu) ?? []).length <= 1, `心声“”一处示例最多一次：${text}`)
    assert.ok(!/她心想|她觉得|她感到/u.test(text), `示例不应出现旁白心理：${text}`)
  }
})

// ───────────────────────────── DL2 ─────────────────────────────

test('DL2: 收尾与追问——不以「接下来要做什么/还需要我做什么/要不要我帮您」收尾，不为续聊追问', () => {
  const { definition } = readPersona()
  const speech = speechOf(definition)
  assert.match(speech, /【收尾与追问】/u)
  for (const fragment of [
    '说完就停',
    '接下来要做什么',
    '还需要我做什么',
    '要不要我帮您',
    '您还有什么需要',
    '不为了让对话继续而提问',
    '只有确实需要确认事实、安全、时间地点时才问',
    '可以留白',
    '不重复主人的原话',
  ]) {
    assert.ok(speech.includes(fragment), `收尾规则缺少：${fragment}`)
  }
  const { speechExamples, topExamples } = allExamples(definition)
  for (const entry of [...speechExamples, ...topExamples]) {
    const text = entry.assistant
    assert.equal(SERVICE_ENDING.test(text), false, `示例不应以服务性追问收尾：${text}`)
    assert.equal(/[？?]\s*$/u.test(text), false, `示例不应以问句收尾：${text}`)
  }
})

// ───────────────────────────── DL3 ─────────────────────────────

test('DL3: 明确禁止——不汇报「记下来/我记下了/记住了/已记录」、不复读用户原话、不直抒心情/大段心理', () => {
  const { definition } = readPersona()
  const speech = speechOf(definition)
  assert.match(speech, /【明确禁止】/u)
  for (const fragment of [
    '禁止说「记下来」「我记下了」「记住了」「已记录」「收到，我记下了」',
    '禁止重复用户的原话',
    '禁止直抒心情、大段心理活动、旁白式心理分析',
    '必要的心声只用“”且极短',
    '禁止以服务性追问收尾',
  ]) {
    assert.ok(speech.includes(fragment), `明确禁止规则缺少：${fragment}`)
  }
  const { speechExamples, topExamples } = allExamples(definition)
  for (const entry of [...speechExamples, ...topExamples]) {
    const text = entry.assistant
    for (const word of FORBIDDEN_IN_EXAMPLES) assert.equal(text.includes(word), false, `示例不应含「${word}」：${text}`)
    if (entry.user && entry.user.length >= 4) {
      assert.equal(text.includes(entry.user), false, `示例不应复读用户原话：${entry.user} → ${text}`)
    }
  }
})

// ───────────────────────────── DL4 ─────────────────────────────

test('DL4: 去通用助手腔——不总结/不分点（清单除外）/不解释设定/不主动给下一步选项', () => {
  const { definition } = readPersona()
  const speech = speechOf(definition)
  assert.match(speech, /【不要像通用聊天助手】/u)
  for (const fragment of [
    '不总结、不分点',
    '不写「总的来说」',
    '希望这对您有帮助',
    '不解释自己的「设定/角色/功能」',
    '不把每件事都说成任务',
    '不汇报“我理解了/我将为您……”',
    '不主动提供“接下来可以做什么”的选项清单',
  ]) {
    assert.ok(speech.includes(fragment), `去助手腔规则缺少：${fragment.replaceAll('……', '')}：${fragment}`)
  }
  const { speechExamples, topExamples } = allExamples(definition)
  for (const entry of [...speechExamples, ...topExamples]) {
    const text = entry.assistant
    for (const word of ASSISTANT_SPEAK) assert.equal(text.includes(word), false, `示例不应含助手腔「${word}」：${text}`)
    assert.equal(/^[0-9]+[.、]/u.test(text), false, `示例不应以编号列表开头：${text}`)
  }
})

// ───────────────────────────── DL5 ─────────────────────────────

test('DL5: 示例与兼容——16 组 speech + 8 组顶层示例新格式；validate ok、渲染约 8900 字、无 AI 词、长度规则保留、记忆不变', () => {
  const { definition, validation, rendered } = validateAndRender()
  assert.deepEqual(validation, { ok: true, errors: [], warnings: [] })
  assert.equal(definition.modules.length, 9)
  assert.equal(definition.modules.filter((module) => module.activation === 'always').length, 4)
  assert.equal(definition.modules.filter((module) => module.activation === 'on_demand').length, 5)
  assert.ok(rendered.length >= 8600 && rendered.length <= 9200, `渲染长度应在 8900 字左右，实际 ${rendered.length}`)

  const { speechExamples, topExamples } = allExamples(definition)
  assert.equal(speechExamples.length, 16, 'speech 参考示例应为 16 组')
  assert.equal(topExamples.length, 8, '顶层 examples 应为 8 组')
  for (const entry of [...speechExamples, ...topExamples]) {
    assert.ok(entry.assistant && entry.assistant.trim().length > 0)
    assert.equal(EMOJI_RE.test(entry.assistant), false, `示例不应含 emoji：${entry.assistant}`)
    assert.equal(scanAi(entry.assistant).length, 0, `示例不应含 AI/技术层词：${entry.assistant}`)
    // 无追问收尾、无「记下」类汇报、无旁白心理（与 DL2/DL3 呼应，防止后续示例回退）
    assert.equal(SERVICE_ENDING.test(entry.assistant), false)
    assert.equal(/[？?]\s*$/u.test(entry.assistant.trim()), false)
    for (const word of FORBIDDEN_IN_EXAMPLES) assert.equal(entry.assistant.includes(word), false, `示例不应含「${word}」`)
  }

  // 兼容：长度、展开信号、语气词、书卷气/记录官身份、无 AI 词
  const speech = speechOf(definition)
  for (const fragment of ['10–300 字', '然后呢', '具体说说', '我在听', '主动展开', '150–300 字']) {
    assert.ok(speech.includes(fragment), `长度规则应保留：${fragment}`)
  }
  for (const word of ['呢', '吧', '了', '呀', '嘛', '啦']) {
    assert.ok(definition.style.toneWords.includes(word), `toneWords 应含「${word}」`)
  }
  assert.match(definition.style.kaomojiFrequency, /默认不用 emoji/u)
  assert.ok(speech.includes('书卷气') && speech.includes('记录官'))
  assert.equal(scanAi(definition).length, 0, `人设不应含 AI/技术层词：${JSON.stringify(scanAi(definition).slice(0, 5))}`)

  // 示例记忆状态不变
  const short = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, 'short-term.json'), 'utf8'))
  const layers = []
  for (let layer = 1; layer <= 7; layer += 1) {
    layers.push(JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, 'long-term', `layer-${layer}.json`), 'utf8')).items)
  }
  assert.equal(short.items.length + layers.flat().length, 30, '示例记忆应为 30 条')
  assert.equal(fs.existsSync(PENDING_FILE), false, '示例数据不应残留 pending-seed.json')
})
