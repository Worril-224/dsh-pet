/**
 * 独立验收测试 · 2026-11-06 新增能力（三）：个人经历 occurredAt 与 seedMemories 导入
 * 覆盖验收编号：QM1 QM2 QM3
 *
 * 全部使用临时目录/临时角色目录；真实 ophelia 记忆与人设只读核对；
 * 不写 companion-data、不联网、不发真实 QQ 消息。
 * 测试由验收员 verifier 独立设计编写，不复用开发者测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { getMemoryEngine, resetMemoryEngineRegistry } from '../../companion-bundle/lib/memory/index.js'
import { estimateLayerByOccurredAt } from '../../companion-bundle/lib/memory/model.js'
import { renderItemByClarity } from '../../companion-bundle/lib/memory/render.js'
import {
  PERSONA_HISTORY_SOURCE,
  PERSONA_HISTORY_TIMELINE,
  buildSeedItems,
  buildSeedItemsFromFile,
  loadPersonaFile,
  parseArgs,
  resolveCharacterPaths,
} from '../../scripts/seed-persona-memories.mjs'
import {
  cleanupTempDirs,
  localMs,
  makeClock,
  makeSeedItem,
  makeTempDir,
  memoryPaths,
  newMemoryEngine,
  readJson,
  readText,
  seedMemoryData,
} from './helpers.mjs'

test.after(cleanupTempDirs)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REAL_MEMORY = path.join(ROOT, 'companion-data', 'characters', 'ophelia', 'memory')
const REAL_PERSONA = path.join(ROOT, 'companion-data', 'characters', 'ophelia', 'persona', 'persona.json')
const SEED_SCRIPT = path.join(ROOT, 'scripts', 'seed-persona-memories.mjs')
const NOW_MS = localMs(2026, 11, 6, 10, 0, 0)
const DAY_MS = 24 * 60 * 60 * 1000

function isoDaysAgo(days) {
  return new Date(NOW_MS - days * DAY_MS).toISOString()
}

function readRealMemoryItems() {
  const short = readJson(path.join(REAL_MEMORY, 'short-term.json'))
  const layers = []
  for (let layer = 1; layer <= 7; layer += 1) {
    layers.push(readJson(path.join(REAL_MEMORY, 'long-term', `layer-${layer}.json`)).items)
  }
  return { shortItems: short.items, layers, all: [...short.items, ...layers.flat()] }
}

// ───────────────────────────── QM1 occurredAt 兼容 ─────────────────────────────

test('QM1: estimateLayerByOccurredAt 边界（1/7/14/30/60/90/140 天）', () => {
  assert.equal(estimateLayerByOccurredAt(undefined, NOW_MS), 'short')
  assert.equal(estimateLayerByOccurredAt(null, NOW_MS), 'short')
  assert.equal(estimateLayerByOccurredAt('', NOW_MS), 'short')
  assert.equal(estimateLayerByOccurredAt('不是时间', NOW_MS), 'short')
  assert.equal(estimateLayerByOccurredAt(new Date(NOW_MS - DAY_MS).toISOString(), NOW_MS), 'short')
  assert.equal(estimateLayerByOccurredAt(NOW_MS + DAY_MS, NOW_MS), 'short', '未来时间按短期处理')
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(2), NOW_MS), 1)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(7), NOW_MS), 1)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(8), NOW_MS), 2)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(14), NOW_MS), 2)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(15), NOW_MS), 3)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(30), NOW_MS), 3)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(31), NOW_MS), 4)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(60), NOW_MS), 4)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(61), NOW_MS), 5)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(90), NOW_MS), 5)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(91), NOW_MS), 6)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(140), NOW_MS), 6)
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(141), NOW_MS), 7)
  // 数值毫秒 / Date 也接受
  assert.equal(estimateLayerByOccurredAt(NOW_MS - 10 * DAY_MS, NOW_MS), 2)
  assert.equal(estimateLayerByOccurredAt(new Date(NOW_MS - 200 * DAY_MS), NOW_MS), 7)
})

test('QM1: 老记忆（无 occurredAt）完全兼容——加载/检索/总览/摘要不出现发生时间', () => {
  const dataDir = makeTempDir('dshpet-verify-qm-legacy-')
  seedMemoryData(dataDir, {
    short: [makeSeedItem({ id: 'mem-legacy-short', content: '主人喜欢喝温热的红茶。', layer: 'short' })],
    layers: { 1: [makeSeedItem({ id: 'mem-legacy-l1', content: '主人上周提过想看海。' })] },
  })
  resetMemoryEngineRegistry()
  const engine = getMemoryEngine({ dataDir, clock: makeClock(NOW_MS) })
  engine.ensure()
  const shortItem = engine.getItem('mem-legacy-short')
  assert.ok(shortItem)
  assert.equal(shortItem.occurredAt, undefined, '老数据不应凭空产生 occurredAt')
  const l1 = engine.getItem('mem-legacy-l1')
  assert.equal(l1.layer, 1)
  assert.ok(!('occurredAt' in l1) || l1.occurredAt === undefined)

  // 检索/摘要/总览不出现「发生」
  const recalled = engine.recall('红茶', { limit: 5 })
  assert.ok(recalled.hits.length >= 1)
  const digest = engine.renderDigest({ latestUserText: '红茶' })
  assert.ok(!digest.includes('发生：'))
  engine.writeOverview()
  const overview = readText(memoryPaths(dataDir).overview)
  assert.ok(!overview.includes('发生时间'), '没有 occurredAt 时总览不应增加发生时间列')
  assert.ok(overview.includes('红茶'))
  assert.equal(renderItemByClarity(shortItem).includes('发生：'), false)
})

test('QM1: 新条目 occurredAt 原样保存；渲染/总览显示发生时间', () => {
  const { engine, dataDir } = newMemoryEngine({ clock: makeClock(NOW_MS) })
  const result = engine.seedMemories(
    [
      {
        id: 'seed-qm1-a',
        content: '我十二岁那年在抄录院过生日，院长送了我一支旧钢笔。',
        occurredAt: '2018-11-07T09:00:00+08:00',
        layer: 5,
        importance: 88,
        keywords: ['生日', '抄录院', '钢笔'],
      },
    ],
    {},
  )
  assert.equal(result.created, 1)
  const item = engine.getItem('seed-qm1-a')
  assert.ok(item)
  assert.equal(item.occurredAt, '2018-11-07T09:00:00+08:00', 'occurredAt 应原样保存')
  assert.equal(item.layer, 5)
  assert.equal(item.importance, 88, 'importance 应覆盖公式结果')
  assert.equal(item.source, PERSONA_HISTORY_SOURCE)
  assert.ok(item.history.some((entry) => String(entry.reason).startsWith('seed')))
  // 清晰度渲染含发生时间
  const rendered = renderItemByClarity(item)
  assert.match(rendered, /发生：2018-11-07T09:00:00\+08:00/u)
  // 总览追加发生时间列
  engine.writeOverview()
  const overview = readText(memoryPaths(dataDir).overview)
  assert.match(overview, /发生时间/u)
  assert.match(overview, /2018-11-07T09:00:00\+08:00/u)
  // 检索结果保留 occurredAt
  const recalled = engine.recall('钢笔', { limit: 5 })
  assert.ok(recalled.hits.some((hit) => hit.item.occurredAt === '2018-11-07T09:00:00+08:00'))
})

// ───────────────────────────── QM2 seedMemories ─────────────────────────────

test('QM2: seedMemories 按 id/content 去重、幂等、持久化、events 记一条 seed', () => {
  const { engine, dataDir } = newMemoryEngine({ clock: makeClock(NOW_MS) })
  const items = [
    { id: 'seed-qm2-a', content: '我记得小时候的窗台有一盆薄荷。', occurredAt: '2020-06-01T09:00:00+08:00' },
    { id: 'seed-qm2-b', content: '我记得小时候的窗台有一盆薄荷。' }, // 内容重复（不同 id）→ 跳过
    { id: 'seed-qm2-c', content: '薇拉转学来那天，把禁书藏在裙撑里。', occurredAt: '2022-09-01T09:00:00+08:00' },
  ]
  const first = engine.seedMemories(items)
  assert.equal(first.created, 2, '批内 content 去重')
  assert.equal(first.skipped, 1)
  assert.deepEqual(first.createdIds.sort(), ['seed-qm2-a', 'seed-qm2-c'].sort())
  assert.ok(first.skippedItems[0].reason.includes('重复') || first.skippedItems[0].reason.includes('已存在'))

  const second = engine.seedMemories(items)
  assert.equal(second.created, 0, '第二次导入应全部跳过（幂等）')
  assert.equal(second.skipped, 3)

  // 持久化：重启后仍在
  resetMemoryEngineRegistry()
  const reloaded = getMemoryEngine({ dataDir, clock: makeClock(NOW_MS) })
  reloaded.ensure()
  assert.equal(reloaded.status().total, 2)
  assert.ok(reloaded.getItem('seed-qm2-a'))
  // events.jsonl 只记一条 seed 事件
  const events = readText(memoryPaths(dataDir).events).trim().split(/\r?\n/).filter(Boolean)
  const seedEvents = events.filter((line) => line.includes('"type":"seed"'))
  assert.equal(seedEvents.length, 1, '一次 seedMemories 应只追加一条 seed 事件')
})

test('QM2: 显式/估算层级、importance/source/firstSeenAt、非法条目跳过、全部跳过不落盘', () => {
  const { engine, dataDir } = newMemoryEngine({ clock: makeClock(NOW_MS) })
  const result = engine.seedMemories([
    { id: 'seed-explicit', content: '显式层级：我整理过闭馆夜的登记簿。', layer: 2, keywords: ['闭馆夜', '登记簿'] },
    {
      id: 'seed-estimated',
      content: '估算层级：两百年前档案馆刚建成时，第一批卷宗运进长廊。',
      occurredAt: isoDaysAgo(200),
      importance: 12,
      source: 'custom-source',
    },
    { id: 'seed-bad-layer', content: '层级非法条目。', layer: 'layer-3' },
    { id: 'seed-bad-time', content: '时间非法条目。', occurredAt: '不是时间' },
    { id: 'seed-empty', content: '   ' },
    null,
    { id: 'seed-trunc', content: '关键词自动补齐的条目，内容够长可以生成摘要与标签。' },
  ])
  assert.equal(result.created, 3)
  assert.equal(result.skipped, 4)
  const explicit = engine.getItem('seed-explicit')
  assert.equal(explicit.layer, 2)
  assert.ok(explicit.keywords.length >= 3 && explicit.keywords.length <= 12, '关键词应补齐到 3~5')
  const estimated = engine.getItem('seed-estimated')
  assert.equal(estimated.layer, 7, '200 天前应估算到第 7 层')
  assert.equal(estimateLayerByOccurredAt(isoDaysAgo(100), NOW_MS), 6, '100 天属于第 6 层（<=140）')
  assert.equal(estimated.importance, 12)
  assert.equal(estimated.source, 'custom-source')
  assert.equal(estimated.firstSeenAt, estimated.occurredAt)
  assert.equal(estimated.lastMentionedAt, estimated.occurredAt)
  const truncated = engine.getItem('seed-trunc')
  assert.equal(truncated.layer, 'short', '无 occurredAt 默认写短期记忆')
  const reasons = result.skippedItems.map((entry) => entry.reason).join('|')
  assert.match(reasons, /层级/u)
  assert.match(reasons, /occurredAt|时间/u)

  // 全部跳过 → 不写盘（内存与磁盘均不变）
  const paths = memoryPaths(dataDir)
  const beforeShort = fs.readFileSync(paths.shortTerm, 'utf8')
  const beforeEvents = fs.readFileSync(paths.events, 'utf8')
  const allSkipped = engine.seedMemories([{ content: '' }, { id: 'x', content: '层级错误', layer: 9 }])
  assert.equal(allSkipped.created, 0)
  assert.equal(allSkipped.skipped, 2)
  assert.equal(fs.readFileSync(paths.shortTerm, 'utf8'), beforeShort, '全部跳过不应重写短期记忆文件')
  assert.equal(fs.readFileSync(paths.events, 'utf8'), beforeEvents, '全部跳过不应追加事件')
})

test('QM2: force 覆盖同 id 旧条目（内容/重要度/层级更新，数量不变）', () => {
  const { engine } = newMemoryEngine({ clock: makeClock(NOW_MS) })
  engine.seedMemories([{ id: 'seed-force', content: '旧版本的个人经历内容。', layer: 3, importance: 20 }])
  assert.equal(engine.status().total, 1)
  const skipped = engine.seedMemories([{ id: 'seed-force', content: '新版本的个人经历内容。', layer: 6, importance: 90 }])
  assert.equal(skipped.created, 0)
  assert.equal(skipped.skipped, 1)
  const forced = engine.seedMemories([{ id: 'seed-force', content: '新版本的个人经历内容。', layer: 6, importance: 90 }], { force: true })
  assert.equal(forced.created, 1)
  assert.equal(engine.status().total, 1, 'force 不应产生重复条目')
  const item = engine.getItem('seed-force')
  assert.equal(item.content, '新版本的个人经历内容。')
  assert.equal(item.layer, 6)
  assert.equal(item.importance, 90)
})

// ───────────────────────────── QM3 真实经历导入 ─────────────────────────────

test('QM3: 示例 ophelia 记忆只读核对——30 条 / persona-history 6 条 / 层字段合法 / 总览含发生时间', () => {
  const { shortItems, layers, all } = readRealMemoryItems()
  // 公开版示例数据：short 8 + 长层 22（L1=6/L2=4/L3=3/L4=1/L5=2/L6=3/L7=3）
  assert.equal(all.length, 30, `示例记忆应为 30 条，实际 ${all.length}`)
  assert.equal(shortItems.length + layers.flat().length, all.length, '短期 + 长期条数应等于总数')
  assert.equal(shortItems.length, 8)
  assert.deepEqual(layers.map((items) => items.length), [6, 4, 3, 1, 2, 3, 3])
  for (const [index, items] of layers.entries()) {
    for (const item of items) assert.equal(item.layer, index + 1, `长期层条目 layer 应与文件层一致：${item.id}`)
  }
  for (const item of shortItems) assert.equal(item.layer, 'short', `短期条目的 layer 应为 short：${item.id}`)
  const personaItems = all.filter((item) => item.source === PERSONA_HISTORY_SOURCE)
  assert.equal(personaItems.length, 6, '示例 persona-history 来源应为 6 条')
  // 公开示例数据不含故事集/长篇小说来源（原项目私有数据集，未随仓库提供）
  assert.equal(all.filter((item) => String(item.source || '').startsWith('story:')).length, 0, '示例数据不应含 story:* 私有故事来源')

  const ids = new Set()
  for (const item of personaItems) {
    assert.match(item.id, /^seed-ophelia-\d{3}$/u, `id 应稳定可复现：${item.id}`)
    assert.ok(!ids.has(item.id), `id 不应重复：${item.id}`)
    ids.add(item.id)
    assert.ok(item.content.length > 0 && item.summary.length > 0)
    assert.ok(item.keywords.length >= 3 && item.keywords.length <= 12, `关键词应 3~12：${item.id}`)
    assert.ok(item.importance >= 1 && item.importance <= 100)
    assert.ok(Number.isFinite(Date.parse(item.occurredAt)), `occurredAt 应可解析：${item.id}`)
    assert.match(item.occurredAt, /\+08:00$/u, 'occurredAt 应为 +08:00 本地时区 ISO')
    // firstSeenAt 应等于 occurredAt；lastMentionedAt 可能因后续示例对话提及而前移
    assert.equal(item.firstSeenAt, item.occurredAt)
    assert.ok(Number.isFinite(Date.parse(item.lastMentionedAt)), `lastMentionedAt 应可解析：${item.id}`)
    assert.ok(Date.parse(item.lastMentionedAt) >= Date.parse(item.occurredAt), `lastMentionedAt 不应早于 occurredAt：${item.id}`)
    assert.ok(item.history.some((entry) => String(entry.reason).startsWith('seed')))
    assert.ok(['short', 1, 2, 3, 4, 5, 6, 7].includes(item.layer), `layer 应合法：${item.id}`)
  }
  // 总览
  const overview = readText(path.join(REAL_MEMORY, '记忆总览.md'))
  assert.match(overview, /发生时间/u, '总览应包含「发生时间」列')
  assert.match(overview, new RegExp(`共 ${all.length} 条记忆`, 'u'))
  assert.equal(
    overview.split(/\r?\n/).filter((line) => line.startsWith('| mem-') || line.startsWith('| seed-') || line.startsWith('| story-')).length,
    all.length,
  )
  // seed 事件已记录
  const events = readText(path.join(REAL_MEMORY, 'events.jsonl')).trim().split(/\r?\n/).filter(Boolean)
  assert.ok(events.some((line) => line.includes('"type":"seed"')), 'events.jsonl 应记录 seed 事件')
})

test('QM3: 脚本从真实人设解析出 20 条（occurredAt/来源/层估算/关键词）', () => {
  const persona = loadPersonaFile(REAL_PERSONA)
  const built = buildSeedItems({ persona, characterId: 'ophelia', nowMs: localMs(2026, 11, 6, 8, 33, 0) })
  assert.equal(built.items.length, 20, '人设个人经历应解析出 20 条')
  assert.equal(built.items.length, PERSONA_HISTORY_TIMELINE.length)
  for (const item of built.items) {
    assert.match(item.id, /^seed-ophelia-\d{3}$/u)
    assert.ok(item.content.length > 0)
    assert.equal(item.source, PERSONA_HISTORY_SOURCE)
    assert.ok(Number.isFinite(Date.parse(item.occurredAt)))
    assert.equal(item.layer, estimateLayerByOccurredAt(item.occurredAt, localMs(2026, 11, 6, 8, 33, 0)))
    assert.ok(item.keywords.length >= 3 && item.keywords.length <= 12)
    assert.ok(item.importance >= 1 && item.importance <= 100)
  }
  // 与示例记忆库中已有的 persona-history 条目 id 一致（示例库为 20 条时间线的子集）
  const { all } = readRealMemoryItems()
  const realIds = new Set(all.filter((item) => item.source === PERSONA_HISTORY_SOURCE).map((item) => item.id))
  assert.ok(realIds.size >= 1, '示例记忆库应含 persona-history 条目')
  for (const id of realIds) assert.ok(
    built.items.some((item) => item.id === id),
    `示例记忆库中的 ${id} 应能由时间线脚本生成`,
  )
})

test('QM3: CLI dry-run 只读；--write 导入 20 条；重复导入 skipped=20；--force 覆盖', () => {
  const charactersDir = path.join(makeTempDir('dshpet-verify-qm-cli-'), 'characters')
  const roleDir = path.join(charactersDir, 'testx')
  fs.mkdirSync(path.join(roleDir, 'persona'), { recursive: true })
  fs.copyFileSync(REAL_PERSONA, path.join(roleDir, 'persona', 'persona.json'))
  const run = (args) => {
    const result = spawnSync(process.execPath, [SEED_SCRIPT, '--character-id', 'testx', '--characters-dir', charactersDir, ...args], {
      encoding: 'utf8',
      timeout: 120000,
    })
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  // dry-run：不写任何文件
  const dry = run(['--dry-run'])
  assert.equal(dry.status, 0, dry.output)
  assert.match(dry.output, /DRY-RUN/u)
  assert.match(dry.output, /未写入任何文件/u)
  assert.ok(!fs.existsSync(path.join(roleDir, 'memory')), 'dry-run 不应创建记忆目录')

  // --write：导入 20 条
  const write = run(['--write'])
  assert.equal(write.status, 0, write.output)
  assert.match(write.output, /created=20/u)
  assert.match(write.output, /共 20 条/u)
  const memoryDir = path.join(roleDir, 'memory')
  assert.ok(fs.existsSync(path.join(memoryDir, 'short-term.json')))
  const short = readJson(path.join(memoryDir, 'short-term.json'))
  const layers = []
  for (let layer = 1; layer <= 7; layer += 1) layers.push(readJson(path.join(memoryDir, 'long-term', `layer-${layer}.json`)).items)
  const total = short.items.length + layers.flat().length
  assert.equal(total, 20)
  assert.ok(readText(path.join(memoryDir, '记忆总览.md')).includes('发生时间'))

  // 重复导入：幂等
  const again = run(['--write'])
  assert.equal(again.status, 0, again.output)
  assert.match(again.output, /created=0/u)
  assert.match(again.output, /skipped=20/u)

  // --force：覆盖但不重复
  const forced = run(['--write', '--force'])
  assert.equal(forced.status, 0, forced.output)
  assert.match(forced.output, /created=20/u)
  const shortAfter = readJson(path.join(memoryDir, 'short-term.json'))
  const layersAfter = []
  for (let layer = 1; layer <= 7; layer += 1) layersAfter.push(readJson(path.join(memoryDir, 'long-term', `layer-${layer}.json`)).items)
  assert.equal(shortAfter.items.length + layersAfter.flat().length, 20)

  // 未知参数 → 非零退出
  const bad = run(['--not-a-real-option'])
  assert.notEqual(bad.status, 0)
  assert.match(bad.output, /未知参数/u)
})

test('QM3: CLI 参数解析与角色路径校验', () => {
  const defaults = parseArgs([])
  assert.equal(defaults.characterId, 'ophelia')
  assert.equal(defaults.dryRun, true, '默认 dry-run')
  assert.equal(defaults.force, false)
  assert.equal(parseArgs(['--write']).dryRun, false)
  assert.equal(parseArgs(['--apply']).dryRun, false)
  assert.equal(parseArgs(['--force']).force, true)
  assert.equal(parseArgs(['--character-id', 'gamma']).characterId, 'gamma')
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs(['--character-id']), /缺少取值/u)
  assert.throws(() => parseArgs(['--wat']), /未知参数/u)

  const paths = resolveCharacterPaths({ characterId: 'ophelia', charactersDir: 'D:/x/characters' })
  // resolveCharacterPaths 内部用 path.resolve 规范化角色根目录；在 POSIX 上 'D:/x/...' 是相对路径，
  // 会被拼到 cwd 下，因此断言也要用同样的方式推导，避免跨平台差异。
  const expectedRoot = path.resolve('D:/x/characters')
  assert.equal(paths.personaFile, path.join(expectedRoot, 'ophelia', 'persona', 'persona.json'))
  assert.throws(() => resolveCharacterPaths({ characterId: '../evil', charactersDir: 'D:/x/characters' }), /非法/u)
  // buildSeedItemsFromFile 只读人设文件
  const built = buildSeedItemsFromFile({ personaFile: REAL_PERSONA, characterId: 'ophelia', nowMs: NOW_MS })
  assert.equal(built.items.length, 20)
  assert.ok(personalHistoryParseCount(built) === 20)
})

function personalHistoryParseCount(built) {
  return built.items.filter((item) => item.source === PERSONA_HISTORY_SOURCE).length
}
