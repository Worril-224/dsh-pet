/**
 * 独立验收测试 · 2026-11-06 推理等级 low（RL1–RL3）
 *
 * RL1：QQ bundle 配置与真实 qq/status.json 均为 low；
 * RL2：reply-engine resolveRoute 显式覆盖/默认选择/configured provider-model 三条路径都正确携带 effort；
 * RL3：全局默认 profile 配置 low，README/SPEC/验收标准写明 Web GUI 模型选择器优先级与重启要求。
 * 全部只读文件 + 假 LLM/内存替身，不联网、不写 companion-data、不改实现/数据、不重启 Harness。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createReplyEngine } from '../../companion-bundle/lib/im/reply-engine.js'
import { normalizeConfig } from '../../companion-bundle/lib/qq-host.js'
import { makeFakeLlm, makeStubMemory, makeStubPersona } from './feature-helpers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROFILE_PATCH = process.env.DSH_PET_PROFILE_PATCH || ''
const BUNDLE_PATCH = path.join(ROOT, 'companion-bundle', 'cordis.patch.yml')
const STATUS_FILE = path.join(ROOT, 'companion-data', 'characters', 'ophelia', 'qq', 'status.example.json')
const PERSONA_FILE = path.join(ROOT, 'companion-data', 'characters', 'ophelia', 'persona', 'persona.json')
const README_FILE = path.join(ROOT, 'README.md')
const SPEC_FILE = path.join(ROOT, 'docs', 'SPEC.md')
const CRITERIA_FILE = path.join(ROOT, '验收', '验收标准.md')
const QQ_HOST_FILE = path.join(ROOT, 'companion-bundle', 'lib', 'qq-host.js')
const REPLY_ENGINE_FILE = path.join(ROOT, 'companion-bundle', 'lib', 'im', 'reply-engine.js')

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function makeEngine({ config = {}, modelSelection } = {}) {
  return createReplyEngine({
    persona: makeStubPersona(),
    memory: makeStubMemory(),
    llm: makeFakeLlm({ respond: () => '好的，主人。' }),
    modelSelection,
    config,
  })
}

/** 取 YAML 中某 id 的配置块文本（到下一个顶层 `- ` 条目为止）。 */
function yamlBlock(text, id) {
  const start = text.indexOf(`- id: ${id}`)
  if (start < 0) return ''
  const rest = text.slice(start + 1)
  const next = rest.search(/\n-\s/)
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next)
}

// ───────────────────────────── RL1 ─────────────────────────────

test('RL1: QQ 聊天模型可配置（公开模板不锁死 provider/model），utility 仍由 Harness 默认大模型负责', () => {
  // bundle patch：companion-qq 的 provider/model 以注释示例形式提供，避免把本机模型写死
  const bundle = readText(BUNDLE_PATCH)
  const qqBlock = yamlBlock(bundle, 'companion-qq')
  assert.ok(qqBlock.length > 0, 'bundle patch 应含 companion-qq')
  assert.match(qqBlock, /#\s*provider:/u, 'companion-qq 应给出 provider 注释示例')
  assert.match(qqBlock, /#\s*model:/u, 'companion-qq 应给出 model 注释示例')
  assert.equal(/^\s{8}provider:\s*\S/mu.test(qqBlock), false, '公开模板不应锁死聊天 provider')
  assert.equal(/^\s{8}model:\s*\S/mu.test(qqBlock), false, '公开模板不应锁死聊天 model')
  assert.ok(qqBlock.includes('Harness 默认模型'), '应说明留空时沿用 Harness 默认模型')

  // normalizeConfig 透传/去空白；未配置时不硬编码 low
  assert.equal(normalizeConfig({ botQQ: '1', allowUsers: ['1'], reasoningEffort: 'low' }).reasoningEffort, 'low')
  assert.equal(normalizeConfig({ botQQ: '1', allowUsers: ['1'], reasoningEffort: '  low  ' }).reasoningEffort, 'low')
  assert.equal(normalizeConfig({ botQQ: '1', allowUsers: ['1'], reasoningEffort: 'max' }).reasoningEffort, 'max')
  assert.equal(normalizeConfig({ botQQ: '1', allowUsers: ['1'] }).reasoningEffort, undefined)

  // 示例 status：replyModel 结构完整、可由面板/配置覆盖，且不残留 max
  const status = readJson(STATUS_FILE)
  assert.equal(status.plugin, 'companion-qq')
  assert.equal(typeof status.started, 'boolean')
  assert.ok(['running', 'failed', 'starting', 'stopped'].includes(status.adapter.state), `adapter 状态非法：${status.adapter.state}`)
  assert.equal(typeof status.replyModel.provider, 'string')
  assert.equal(typeof status.replyModel.model, 'string')
  assert.ok(status.replyModel.provider.length > 0 && status.replyModel.model.length > 0)
  assert.ok(
    status.replyModel.reasoningEffort === undefined || ['low', 'high', 'max'].includes(status.replyModel.reasoningEffort),
    `reasoningEffort 取值非法：${status.replyModel.reasoningEffort}`,
  )
  assert.ok(!JSON.stringify(status.replyModel).includes('max'), '示例 replyModel 不应残留 max')
  assert.match(status.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/u)

  // qq-host 状态写入路径：replyModel 来自 currentReplyModel()（route 带 effort）
  const hostSource = readText(QQ_HOST_FILE)
  assert.match(hostSource, /function currentReplyModel\(\)/u)
  assert.match(hostSource, /route\.reasoningEffort/u)
  assert.match(hostSource, /replyModel:\s*currentReplyModel\(\)/u)
})

// ───────────────────────────── RL2 ─────────────────────────────

test('RL2: reply-engine resolveRoute——config low 覆盖 modelSelection max；configured 路径带 effort；显式 max 仍尊重', () => {
  // a) 默认选择路径：modelSelection=max + config low → low（显式覆盖，不能静默回落 max）
  const overridden = makeEngine({
    modelSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }),
    config: { reasoningEffort: 'low' },
  })
  assert.deepEqual(overridden.resolveRoute(), { provider: 'p', model: 'm', reasoningEffort: 'low' })

  // b) 默认选择路径：config 未设 → 沿用 modelSelection 的 effort（当前 max，属选择器优先级）
  const inherited = makeEngine({
    modelSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }),
    config: {},
  })
  assert.deepEqual(inherited.resolveRoute(), { provider: 'p', model: 'm', reasoningEffort: 'max' })

  // c) configured provider/model 路径：config low → 带 effort
  const configured = makeEngine({
    modelSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }),
    config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' },
  })
  assert.deepEqual(configured.resolveRoute(), {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  })

  // d) configured provider/model 但未设 effort → 不伪造 effort 字段（不静默写 low/max）
  const configuredNoEffort = makeEngine({
    modelSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }),
    config: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  const route = configuredNoEffort.resolveRoute()
  assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal('reasoningEffort' in route, false)

  // e) 显式 max 仍尊重（不能硬编码 low）
  const explicitMax = makeEngine({
    modelSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }),
    config: { reasoningEffort: 'max' },
  })
  assert.equal(explicitMax.resolveRoute().reasoningEffort, 'max')

  // f) 无 modelSelection 且无 configured → 无路由（错误路径由调用方处理）
  const noRoute = makeEngine({ config: {} })
  assert.equal(noRoute.resolveRoute(), undefined)

  // 代码路径核对：resolveRoute 被 generateWithPrompt/回复共用且导出
  const source = readText(REPLY_ENGINE_FILE)
  assert.match(source, /function resolveRoute\(\)/u)
  assert.match(source, /const route = resolveRoute\(\)/u)
  assert.match(source, /resolveRoute,/u)
})

// ───────────────────────────── RL3 ─────────────────────────────

test('RL3: README/SPEC/验收标准写明模型选择与重启要求；persona 无 effort 污染', () => {
  // README：模型 / Web GUI / 重启要求
  const readme = readText(README_FILE)
  for (const fragment of ['模型', 'Web UI', '重启 Harness']) {
    assert.ok(readme.includes(fragment), `README 缺少模型说明：${fragment}`)
  }

  // SPEC §12.4：模型分工、QQ 走 replyEngine、Web GUI 模型选择器与重启
  const spec = readText(SPEC_FILE)
  const specSection = spec.slice(spec.indexOf('### 12.4 模型分工与推理等级（reasoningEffort）'))
  assert.ok(specSection.length > 0, 'SPEC 应有 12.4 推理等级')
  for (const fragment of ['模型分工', 'companion-qq', 'Web GUI', '模型选择器', '重启 Harness', '新的']) {
    assert.ok(specSection.includes(fragment), `SPEC 12.4 缺少：${fragment}`)
  }

  // 验收标准 K 节 RL1–RL3
  const criteria = readText(CRITERIA_FILE)
  const criteriaSection = criteria.slice(criteria.indexOf('## K. 模型分工与推理等级'))
  assert.ok(criteriaSection.length > 0, '验收标准应有 K. 推理等级 low')
  for (const id of ['RL1', 'RL2', 'RL3']) assert.ok(criteriaSection.includes(id), `验收标准缺少 ${id}`)
  assert.match(criteriaSection, /模型/u)
  assert.match(criteriaSection, /Web GUI 模型选择器优先级与重启要求/u)

  // 如果本机存在 Harness profile patch，则顺带核对默认模型配置（外部文件，不在仓库内）
  if (PROFILE_PATCH && fs.existsSync(PROFILE_PATCH)) {
    const profile = readText(PROFILE_PATCH)
    const defaultModel = yamlBlock(profile, 'agent-default-model')
    assert.ok(defaultModel.length > 0, 'profile patch 应含 agent-default-model')
    assert.match(defaultModel, /provider:\s*deepseek-(?:official|account)/u)
    assert.match(defaultModel, /model:\s*deepseek-flash/u)
    assert.equal(/reasoningEffort:\s*max/u.test(defaultModel), false, 'profile 默认不应残留 max')
  }

  // persona 不应被 effort/技术层配置污染
  const persona = readText(PERSONA_FILE)
  for (const term of ['reasoningEffort', 'reasoning_effort', 'deepseek-flash', 'agent-default-model']) {
    assert.equal(persona.includes(term), false, `persona 不应出现推理配置字段：${term}`)
  }
})
