/**
 * 独立验收测试 · 2026-11-06 记忆层级压缩（LM1–LM5）
 *
 * 规则：背景故事（source=persona-history / 以 story: 开头）不压缩；其他记忆从第 3 层开始，
 * 每次下沉进入下一层压缩为上一次的 75%；上浮不扩张；compaction 元数据持久化、可配置。
 *
 * 全部使用 fs.mkdtempSync 临时目录 + 可注入假时钟；不写真实 companion-data、不联网、不改实现、不重启 Harness。
 * 测试由验收员 verifier 独立设计编写，不复用开发者测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_MEMORY_CONFIG, LONG_TERM_LAYERS, resolveConfig } from '../../companion-bundle/lib/memory/constants.js'
import { compactText } from '../../companion-bundle/lib/memory/text.js'
import { cloneItem } from '../../companion-bundle/lib/memory/model.js'
import {
  cleanupTempDirs,
  localMs,
  makeClock,
  makeSeedItem,
  makeTempDir,
  memoryPaths,
  newMemoryEngine,
  readJson,
  seedMemoryData,
} from './helpers.mjs'

test.after(cleanupTempDirs)

const REAL_DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), 'companion-data', 'characters', 'ophelia')
const REAL_OVERVIEW = `${REAL_DIR}/memory/记忆总览.md`
const DAY = 24 * 60 * 60 * 1000

function isoLocal(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+08:00`
}

function longContent(label = '非背景') {
  const sentence = `${label}记忆会记录主人说过的话、当时的天气、桌上的茶和没说完的半句话。`
  return Array.from({ length: 6 }, () => sentence).join('')
}

function seedItem(overrides = {}) {
  return makeSeedItem({
    content: longContent(overrides.label ?? '非背景'),
    source: 'auto_extract',
    ...overrides,
  })
}

/** 预置 layers 后建引擎；返回 engine/dataDir。 */
function scenario({ layers = {}, short = [], config, atMs }) {
  const dataDir = makeTempDir('dshpet-verify-lm-')
  seedMemoryData(dataDir, { short, layers })
  const clock = makeClock(atMs)
  const { engine } = newMemoryEngine({ dataDir, clock, config })
  return { engine, dataDir, clock }
}

function layerItem(engine, layer, id) {
  return engine.listLayer(layer).find((item) => item.id === id)
}

// ───────────────────────────── LM1 ─────────────────────────────

test('LM1: 背景故事保护——persona-history / story:*（及 backgroundStory 标记）下沉不压缩', () => {
  const atMs = localMs(2026, 11, 5, 10, 0)
  const lastMentioned = isoLocal(localMs(2026, 10, 30, 10, 0)) // 6 天前，满足 L2 下沉阈值 3 天
  const { engine } = scenario({
    atMs,
    layers: {
      2: [
        seedItem({ id: 'lm1-persona', label: '人设', source: 'persona-history', layer: 2, lastMentionedAt: lastMentioned }),
        seedItem({ id: 'lm1-story1', label: '故事集', source: 'story:ophelia-stories', layer: 2, lastMentionedAt: lastMentioned }),
        seedItem({ id: 'lm1-story2', label: '小说', source: 'story:ophelia-phoenix', layer: 2, lastMentionedAt: lastMentioned }),
        seedItem({ id: 'lm1-flag', label: '标记', source: 'auto_extract', layer: 2, lastMentionedAt: lastMentioned, backgroundStory: true }),
        seedItem({ id: 'lm1-auto', label: '自动', source: 'auto_extract', layer: 2, lastMentionedAt: lastMentioned }),
      ],
    },
  })
  const lengths = new Map(engine.listLayer(2).map((item) => [item.id, item.content.length]))
  const report = engine.maintain({ at: atMs, reason: '每日凌晨维护窗口' })
  assert.equal(report.demoted, 5)
  assert.equal(report.compacted, 1, '只有非背景记忆应被压缩')
  assert.ok(report.savedChars > 0)

  const auto = layerItem(engine, 3, 'lm1-auto')
  assert.ok(auto)
  assert.ok(auto.content.length <= Math.floor(lengths.get('lm1-auto') * 0.75))
  assert.equal(auto.compaction.count, 1)
  for (const [id, len] of [
    ['lm1-persona', lengths.get('lm1-persona')],
    ['lm1-story1', lengths.get('lm1-story1')],
    ['lm1-story2', lengths.get('lm1-story2')],
    ['lm1-flag', lengths.get('lm1-flag')],
  ]) {
    const item = layerItem(engine, 3, id)
    assert.ok(item, `${id} 应在第 3 层`)
    assert.equal(item.content.length, len, `${id} 背景故事不应被压缩`)
    assert.equal(item.compaction, undefined, `${id} 不应写入 compaction`)
  }

  // 再下沉到第 4 层：背景仍完整；非背景继续压缩
  const previousAuto = auto.content.length
  const second = engine.maintain({ at: localMs(2026, 11, 14, 10, 0), reason: '每日凌晨维护窗口' })
  assert.equal(second.compacted, 1)
  assert.equal(layerItem(engine, 4, 'lm1-persona').content.length, lengths.get('lm1-persona'))
  assert.equal(layerItem(engine, 4, 'lm1-story1').content.length, lengths.get('lm1-story1'))
  const auto4 = layerItem(engine, 4, 'lm1-auto')
  assert.ok(auto4.content.length <= Math.floor(previousAuto * 0.75))
  assert.equal(auto4.compaction.count, 2)
})

// ───────────────────────────── LM2 ─────────────────────────────

test('LM2: 起始层——非背景 1→2 不压缩、2→3 压缩；自定义 startLayer=4 时 3→4 才压缩', () => {
  const atMs = localMs(2026, 11, 5, 10, 0)
  const old = isoLocal(localMs(2026, 11, 1, 10, 0))
  const { engine } = scenario({
    atMs,
    layers: {
      1: [seedItem({ id: 'lm2-l1', label: '一层', layer: 1, lastMentionedAt: old })],
      2: [seedItem({ id: 'lm2-l2', label: '二层', layer: 2, lastMentionedAt: old })],
    },
  })
  const l1Before = layerItem(engine, 1, 'lm2-l1').content.length
  const l2Before = layerItem(engine, 2, 'lm2-l2').content.length
  const report = engine.maintain({ at: atMs, reason: '每日凌晨维护窗口' })
  assert.equal(report.demoted, 2)
  assert.equal(report.compacted, 1, '只有 2→3 这条触发压缩')
  // 1→2：不压缩
  const l1Now = layerItem(engine, 2, 'lm2-l1')
  assert.equal(l1Now.content.length, l1Before, '1→2 不压缩')
  assert.equal(l1Now.compaction, undefined)
  // 2→3：压缩
  assert.ok(layerItem(engine, 3, 'lm2-l2').compaction)
  assert.ok(layerItem(engine, 3, 'lm2-l2').content.length <= Math.floor(l2Before * 0.75))

  // 自定义起始层 4：L2→L3 不压缩，L3→L4 才压缩
  const day1 = localMs(2026, 11, 5, 10, 0)
  const custom = scenario({
    atMs: day1,
    config: { layerCompactionStartLayer: 4 },
    layers: { 2: [seedItem({ id: 'lm2-custom', label: '自定义', layer: 2, lastMentionedAt: isoLocal(localMs(2026, 11, 1, 10, 0)) })] },
  })
  const customBefore = custom.engine.listLayer(2)[0].content.length
  const first = custom.engine.maintain({ at: day1, reason: '每日凌晨维护窗口' })
  assert.equal(first.demoted, 1)
  assert.equal(first.compacted, 0, '进入第 3 层时尚未到起始层 4')
  assert.equal(custom.engine.listLayer(3)[0].content.length, customBefore)
  // 8 天后：lastMentioned 11-01 → 超过 L3 阈值 7 天，L3→L4 压缩
  const second = custom.engine.maintain({ at: localMs(2026, 11, 9, 10, 0), reason: '每日凌晨维护窗口' })
  assert.equal(second.demoted, 1)
  assert.equal(second.compacted, 1)
  const layer4 = custom.engine.listLayer(4)[0]
  assert.ok(layer4.content.length <= Math.floor(customBefore * 0.75))
  assert.equal(layer4.compaction.fromLayer, 3)
  assert.equal(layer4.compaction.toLayer, 4)
})

// ───────────────────────────── LM3 ─────────────────────────────

test('LM3: 每次 75%——2→3 后 ≤75%、3→4 再 ≤75%；自定义 0.5 生效；compactText 目标/句末/最短保留', () => {
  // compactText 单元行为
  const text = '甲'.repeat(40)
  const compacted = compactText(text)
  assert.ok(compacted.length <= Math.floor(text.length * 0.75), `应 ≤75%，实际 ${compacted.length}`)
  assert.ok(compacted.length >= Math.floor(text.length * 0.75) - 1, `应接近 75% 目标，实际 ${compacted.length}`)
  assert.ok(compacted.endsWith('…') || compacted.endsWith('。'), '非句末截断应以省略号收尾')
  const sentence = `${'甲'.repeat(29)}。${'乙'.repeat(10)}`
  assert.ok(compactText(sentence).endsWith('。'), '切点正好在句末时应保留句号')
  assert.equal(compactText('甲'.repeat(20), { ratio: 0.1, minChars: 12 }).length, 12, '应保留最短字数')
  assert.equal(compactText(''), '')

  // 默认 0.75：2→3 与 3→4 连续压缩
  const atMs = localMs(2026, 11, 5, 10, 0)
  const lastMentioned = isoLocal(localMs(2026, 11, 1, 10, 0))
  const { engine } = scenario({
    atMs,
    layers: { 2: [seedItem({ id: 'lm3-default', label: '默认', layer: 2, lastMentionedAt: lastMentioned })] },
  })
  const original = engine.listLayer(2)[0].content.length
  const first = engine.maintain({ at: atMs, reason: '每日凌晨维护窗口' })
  assert.equal(first.compacted, 1)
  const at3 = engine.listLayer(3)[0]
  assert.ok(at3.content.length <= Math.floor(original * 0.75))
  assert.equal(at3.compaction.ratio, 0.75)
  const second = engine.maintain({ at: localMs(2026, 11, 9, 10, 0), reason: '每日凌晨维护窗口' })
  assert.equal(second.compacted, 1)
  const at4 = engine.listLayer(4)[0]
  assert.ok(at4.content.length <= Math.floor(at3.content.length * 0.75))
  assert.equal(at4.compaction.count, 2)

  // 自定义 0.5
  const custom = scenario({
    atMs,
    config: { layerCompactionRatio: 0.5 },
    layers: { 2: [seedItem({ id: 'lm3-half', label: '半量', layer: 2, lastMentionedAt: lastMentioned })] },
  })
  const halfOriginal = custom.engine.listLayer(2)[0].content.length
  const halfFirst = custom.engine.maintain({ at: atMs, reason: '每日凌晨维护窗口' })
  assert.equal(halfFirst.compacted, 1)
  const halfAt3 = custom.engine.listLayer(3)[0]
  assert.ok(halfAt3.content.length <= Math.floor(halfOriginal * 0.5))
  assert.equal(halfAt3.compaction.ratio, 0.5)
  const halfSecond = custom.engine.maintain({ at: localMs(2026, 11, 9, 10, 0), reason: '每日凌晨维护窗口' })
  assert.equal(halfSecond.compacted, 1)
  assert.ok(custom.engine.listLayer(4)[0].content.length <= Math.floor(halfAt3.content.length * 0.5))
})

// ───────────────────────────── LM4 ─────────────────────────────

test('LM4: 上浮不扩张——3→2 正文原样保留、compaction 不新增、不追加压缩事件', () => {
  const atMs = localMs(2026, 11, 5, 10, 0)
  const compactedContent = `${'已压缩正文。'.repeat(8)}`
  const compaction = {
    count: 1,
    ratio: 0.75,
    fromLayer: 2,
    toLayer: 3,
    at: isoLocal(localMs(2026, 10, 30, 10, 0)),
    originalLength: compactedContent.length + 100,
    compactedLength: compactedContent.length,
  }
  const { engine, dataDir } = scenario({
    atMs,
    layers: {
      3: [
        seedItem({
          id: 'lm4-promote',
          content: compactedContent,
          layer: 3,
          mentionCount: 2,
          mentionCountAtLastMaintenance: 1,
          lastMentionedAt: isoLocal(localMs(2026, 9, 1, 10, 0)),
          compaction,
        }),
      ],
    },
  })
  const report = engine.maintain({ at: atMs, reason: '每日凌晨维护窗口' })
  assert.equal(report.promoted, 1)
  assert.equal(report.compacted, 0)
  const promoted = layerItem(engine, 2, 'lm4-promote')
  assert.ok(promoted)
  assert.equal(promoted.content, compactedContent, '上浮不应扩张/改写正文')
  assert.deepEqual(promoted.compaction, compaction, '上浮不应新增/修改 compaction')
  const events = fs
    .readFileSync(memoryPaths(dataDir).events, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(events.filter((event) => event.type === 'memory_compacted').length, 0)
})

// ───────────────────────────── LM5 ─────────────────────────────

test('LM5: 元数据/持久化/重启/配置——compaction 字段、报告/事件、重启可读、配置生效、真实数据只读', () => {
  const atMs = localMs(2026, 11, 5, 10, 0)
  const lastMentioned = isoLocal(localMs(2026, 11, 1, 10, 0))
  const { engine, dataDir } = scenario({
    atMs,
    layers: { 2: [seedItem({ id: 'lm5-persist', label: '持久化', layer: 2, lastMentionedAt: lastMentioned })] },
  })
  const originalLength = engine.listLayer(2)[0].content.length
  const report = engine.maintain({ at: atMs, reason: '每日凌晨维护窗口' })
  assert.equal(report.compacted, 1)
  assert.ok(report.savedChars > 0)

  const at3 = engine.listLayer(3).find((item) => item.id === 'lm5-persist')
  assert.ok(at3.compaction)
  for (const field of ['count', 'ratio', 'fromLayer', 'toLayer', 'at', 'originalLength', 'compactedLength']) {
    assert.ok(field in at3.compaction, `compaction 缺少字段 ${field}`)
  }
  assert.equal(at3.compaction.count, 1)
  assert.equal(at3.compaction.ratio, 0.75)
  assert.equal(at3.compaction.fromLayer, 2)
  assert.equal(at3.compaction.toLayer, 3)
  assert.match(at3.compaction.at, /\+08:00$/)
  assert.equal(at3.compaction.originalLength, originalLength)
  assert.equal(at3.compaction.compactedLength, at3.content.length)
  assert.equal(report.savedChars, originalLength - at3.content.length)

  // 磁盘 JSON 也持久化
  const disk = readJson(memoryPaths(dataDir).layer(3))
  const diskItem = disk.items.find((item) => item.id === 'lm5-persist')
  assert.ok(diskItem.compaction)
  assert.equal(diskItem.compaction.count, 1)

  // 事件
  const events = fs
    .readFileSync(memoryPaths(dataDir).events, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const compactEvents = events.filter((event) => event.type === 'memory_compacted')
  assert.equal(compactEvents.length, 1)
  assert.equal(compactEvents[0].itemId, 'lm5-persist')
  assert.equal(compactEvents[0].originalLength, originalLength)
  assert.equal(compactEvents[0].compactedLength, at3.content.length)
  assert.equal(compactEvents[0].savedChars, originalLength - at3.content.length)
  assert.equal(compactEvents[0].count, 1)

  // 重启后仍可读（compaction/backgroundStory 通过 normalizeLoadedItem/clone 保留）
  const reopened = newMemoryEngine({ dataDir, clock: makeClock(localMs(2026, 11, 6, 10, 0)) })
  const loaded = reopened.engine.listLayer(3).find((item) => item.id === 'lm5-persist')
  assert.ok(loaded)
  assert.equal(loaded.content, at3.content)
  assert.deepEqual(loaded.compaction, at3.compaction)
  const cloned = cloneItem(loaded)
  assert.deepEqual(cloned.compaction, loaded.compaction)
  assert.notEqual(cloned.compaction, loaded.compaction, 'clone 应为新对象')

  // 配置默认值与夹取
  assert.equal(DEFAULT_MEMORY_CONFIG.layerCompactionRatio, 0.75)
  assert.equal(DEFAULT_MEMORY_CONFIG.layerCompactionStartLayer, 3)
  assert.equal(DEFAULT_MEMORY_CONFIG.layerCompactionMinChars, 12)
  assert.deepEqual([...DEFAULT_MEMORY_CONFIG.backgroundStorySources], ['persona-history'])
  assert.deepEqual([...DEFAULT_MEMORY_CONFIG.backgroundStorySourcePrefixes], ['story:'])
  const clamped = resolveConfig({ layerCompactionRatio: 5, layerCompactionStartLayer: 99, layerCompactionMinChars: 0 })
  assert.equal(clamped.layerCompactionRatio, 1)
  assert.equal(clamped.layerCompactionStartLayer, LONG_TERM_LAYERS)
  assert.equal(clamped.layerCompactionMinChars, 1)

  // 自定义 backgroundStorySources/Prefixes 生效
  const custom = scenario({
    atMs,
    config: {
      backgroundStorySources: ['custom:story'],
      backgroundStorySourcePrefixes: ['lore:'],
      layerCompactionRatio: 0.5,
      layerCompactionMinChars: 8,
    },
    layers: {
      2: [
        seedItem({ id: 'lm5-custom-src', label: '自定义源', source: 'custom:story', layer: 2, lastMentionedAt: lastMentioned }),
        seedItem({ id: 'lm5-custom-prefix', label: '自定义前缀', source: 'lore:demo', layer: 2, lastMentionedAt: lastMentioned }),
        seedItem({ id: 'lm5-persona', label: '人设', source: 'persona-history', layer: 2, lastMentionedAt: lastMentioned }),
        seedItem({ id: 'lm5-story', label: '故事', source: 'story:demo', layer: 2, lastMentionedAt: lastMentioned }),
      ],
    },
  })
  const lens = new Map(custom.engine.listLayer(2).map((item) => [item.id, item.content.length]))
  const customReport = custom.engine.maintain({ at: atMs, reason: '每日凌晨维护窗口' })
  assert.equal(customReport.compacted, 2, '自定义源/前缀受保护；persona-history/story: 不再受保护')
  assert.equal(custom.engine.listLayer(3).find((item) => item.id === 'lm5-custom-src').content.length, lens.get('lm5-custom-src'))
  assert.equal(custom.engine.listLayer(3).find((item) => item.id === 'lm5-custom-prefix').content.length, lens.get('lm5-custom-prefix'))
  const personaCompacted = custom.engine.listLayer(3).find((item) => item.id === 'lm5-persona')
  assert.ok(personaCompacted.compaction)
  assert.equal(personaCompacted.compaction.ratio, 0.5)
  assert.ok(personaCompacted.content.length <= Math.floor(lens.get('lm5-persona') * 0.5))

  // 示例数据只读核对（不写入；未跑真实维护）
  const realShort = readJson(`${REAL_DIR}/memory/short-term.json`)
  const realLayers = []
  for (let layer = 1; layer <= 7; layer += 1) realLayers.push(readJson(`${REAL_DIR}/memory/long-term/layer-${layer}.json`).items)
  const realAll = [...realShort.items, ...realLayers.flat()]
  const realSources = {}
  for (const item of realAll) realSources[item.source || '(none)'] = (realSources[item.source || '(none)'] || 0) + 1
  assert.ok(realAll.length >= 20, `示例数据应含足量记忆，实际 ${realAll.length}`)
  assert.ok(realSources['persona-history'] >= 1, '示例数据应含 persona-history 背景记忆')
  assert.ok(realSources['qq-conversation'] >= 1, '示例数据应含 qq-conversation 会话记忆')
  // 背景故事（persona-history / story:*）在公共示例数据中一律带 occurredAt 且不压缩
  const background = realAll.filter((item) => item.source === 'persona-history' || String(item.source || '').startsWith('story:'))
  for (const item of background) {
    assert.ok(item.occurredAt, `背景故事应带 occurredAt：${item.id}`)
    assert.ok(!item.compaction, `背景故事不应被压缩：${item.id}`)
  }
  assert.ok(fs.existsSync(REAL_OVERVIEW))
  assert.match(fs.readFileSync(REAL_OVERVIEW, 'utf8'), new RegExp(`共 ${realAll.length} 条记忆`, 'u'))
  // 未跑真实维护：所有示例条目均无 compaction（若未来运行维护后出现，则检查字段合法性）
  for (const item of realAll) {
    if (item.compaction) {
      for (const field of ['count', 'ratio', 'fromLayer', 'toLayer', 'at']) assert.ok(field in item.compaction)
    }
  }
})
