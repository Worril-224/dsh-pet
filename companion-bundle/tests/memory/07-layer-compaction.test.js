/**
 * 记忆层级压缩（2026-11-06）：非背景故事记忆从第 3 层开始，每次下沉进入下一层压缩为原来的 75%；
 * 背景故事（persona-history / story:*）不压缩；上浮不扩张；压缩元数据持久化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localMs, isoOf, seedEngine, makeItem, reopenEngine } from './_helpers.mjs'

const DAY = 24 * 60 * 60 * 1000

function longContent(label = '非背景') {
  const sentence = `${label}记忆会记录主人说过的话、当时的天气、桌上的茶和没说完的半句话。`
  return Array.from({ length: 8 }, () => sentence).join('')
}

function item(overrides) {
  return makeItem({
    content: longContent(overrides.label ?? '非背景'),
    summary: '摘要',
    source: 'auto_extract',
    lastMentionedAt: isoOf(localMs(2026, 10, 20, 10, 0)),
    ...overrides,
  })
}

test('层级压缩：非背景记忆进入第 3 层压缩为 75%，背景故事不压缩', () => {
  const ctx = seedEngine({
    start: localMs(2026, 11, 5, 10, 0),
    layers: [
      [],
      [
        item({ id: 'mem-000001', content: longContent('非背景'), lastMentionedAt: isoOf(localMs(2026, 10, 20, 10, 0)) }),
        item({
          id: 'mem-000002',
          content: longContent('背景'),
          source: 'persona-history',
          lastMentionedAt: isoOf(localMs(2026, 10, 20, 10, 0)),
        }),
        item({
          id: 'mem-000003',
          content: longContent('故事'),
          source: 'story:ophelia-phoenix',
          lastMentionedAt: isoOf(localMs(2026, 10, 20, 10, 0)),
        }),
      ],
    ],
  })
  try {
    const before = new Map(ctx.engine.listLayer(2).map((entry) => [entry.id, entry.content.length]))
    const report = ctx.engine.maintain({ at: localMs(2026, 11, 5, 10, 0), reason: '每日凌晨维护窗口' })
    assert.equal(report.demoted, 3)
    assert.equal(report.compacted, 1, '只有非背景记忆应被压缩')
    assert.ok(report.savedChars > 0)

    const layer3 = new Map(ctx.engine.listLayer(3).map((entry) => [entry.id, entry]))
    const compacted = layer3.get('mem-000001')
    const background = layer3.get('mem-000002')
    const story = layer3.get('mem-000003')
    assert.ok(compacted && background && story)
    const target = Math.floor(before.get('mem-000001') * 0.75)
    assert.equal(compacted.content.length, target, `应精确压缩到 ${target} 字，实际 ${compacted.content.length}`)
    assert.equal(compacted.compaction.count, 1)
    assert.equal(compacted.compaction.fromLayer, 2)
    assert.equal(compacted.compaction.toLayer, 3)
    assert.equal(background.content.length, before.get('mem-000002'), '背景故事不压缩')
    assert.equal(story.content.length, before.get('mem-000003'), '故事导入不压缩')

    // 第二天下沉到第 4 层：在上一轮基础上再压缩 25%
    const previousLength = compacted.content.length
    const second = ctx.engine.maintain({ at: localMs(2026, 11, 6, 10, 0), reason: '每日凌晨维护窗口' })
    assert.equal(second.compacted, 1)
    const layer4 = ctx.engine.listLayer(4).find((entry) => entry.id === 'mem-000001')
    assert.equal(layer4.content.length, Math.floor(previousLength * 0.75))
    assert.equal(layer4.compaction.count, 2)
    assert.equal(layer4.compaction.fromLayer, 3)
    assert.equal(layer4.compaction.toLayer, 4)
  } finally {
    ctx.cleanup()
  }
})

test('层级压缩：可配置起始层与比例（从第 4 层起、50%）', () => {
  const ctx = seedEngine({
    start: localMs(2026, 11, 5, 10, 0),
    config: { layerCompactionStartLayer: 4, layerCompactionRatio: 0.5 },
    layers: [[], [item({ id: 'mem-000010', content: longContent('自定义'), lastMentionedAt: isoOf(localMs(2026, 10, 1, 10, 0)) })]],
  })
  try {
    const originalLength = ctx.engine.listLayer(2)[0].content.length
    const first = ctx.engine.maintain({ at: localMs(2026, 11, 5, 10, 0), reason: '每日凌晨维护窗口' })
    assert.equal(first.demoted, 1)
    assert.equal(first.compacted, 0, '进入第 3 层时尚未到起始层')
    const layer3Length = ctx.engine.listLayer(3)[0].content.length
    assert.equal(layer3Length, originalLength)

    const second = ctx.engine.maintain({ at: localMs(2026, 11, 6, 10, 0), reason: '每日凌晨维护窗口' })
    assert.equal(second.demoted, 1)
    assert.equal(second.compacted, 1)
    const layer4 = ctx.engine.listLayer(4)[0]
    assert.ok(layer4.content.length <= Math.floor(layer3Length * 0.5))
    assert.equal(layer4.compaction.ratio, 0.5)
  } finally {
    ctx.cleanup()
  }
})

test('层级压缩：上浮不扩张，压缩正文原样保留', () => {
  const compactedContent = longContent('已压缩').slice(0, 80)
  const ctx = seedEngine({
    start: localMs(2026, 11, 5, 10, 0),
    layers: [
      [],
      [],
      [
        item({
          id: 'mem-000020',
          content: compactedContent,
          mentionCount: 2,
          mentionCountAtLastMaintenance: 1,
          lastMentionedAt: isoOf(localMs(2026, 11, 4, 10, 0)),
        }),
      ],
    ],
  })
  try {
    const report = ctx.engine.maintain({ at: localMs(2026, 11, 5, 10, 0), reason: '每日凌晨维护窗口' })
    assert.equal(report.promoted, 1)
    assert.equal(report.compacted, 0)
    const promoted = ctx.engine.listLayer(2).find((entry) => entry.id === 'mem-000020')
    assert.equal(promoted.content, compactedContent)
  } finally {
    ctx.cleanup()
  }
})

test('层级压缩：compaction 元数据持久化，重启后仍可读取', () => {
  const ctx = seedEngine({
    start: localMs(2026, 11, 5, 10, 0),
    layers: [[], [item({ id: 'mem-000030', content: longContent('持久化'), lastMentionedAt: isoOf(localMs(2026, 10, 20, 10, 0)) })]],
  })
  let reopened
  try {
    ctx.engine.maintain({ at: localMs(2026, 11, 5, 10, 0), reason: '每日凌晨维护窗口' })
    const persisted = ctx.engine.listLayer(3)[0]
    reopened = reopenEngine(ctx.dataDir, { start: localMs(2026, 11, 6, 10, 0) })
    const loaded = reopened.engine.listLayer(3).find((entry) => entry.id === 'mem-000030')
    assert.ok(loaded)
    assert.equal(loaded.content, persisted.content)
    assert.equal(loaded.compaction.count, 1)
    assert.equal(loaded.compaction.fromLayer, 2)
    assert.equal(loaded.compaction.toLayer, 3)
    assert.ok(loaded.compaction.at)
  } finally {
    if (reopened) reopened.cleanup?.()
    ctx.cleanup()
  }
})
