/**
 * 独立验收测试的共享工具（verifier 自写，不复制开发者测试）。
 *
 * 约定：
 *  - 所有测试数据都写在 fs.mkdtempSync 创建的系统临时目录里，结束统一清理；
 *  - 引擎统一通过公共入口 getMemoryEngine 创建，并用 resetMemoryEngineRegistry 隔离单例；
 *  - 时间统一由可注入的假时钟控制，避免依赖真实日期。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getMemoryEngine, resetMemoryEngineRegistry } from '../../companion-bundle/lib/memory/index.js'

const tempDirs = []

export function makeTempDir(prefix = 'dshpet-verify-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言结果
    }
  }
}

/** 本地时区构造时间戳（与实现一致：维护窗口按本地小时判定）。 */
export function localMs(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime()
}

/** 可注入时钟。 */
export function makeClock(startMs = localMs(2026, 11, 5, 5, 0, 0)) {
  let now = startMs
  return {
    now: () => now,
    set(nextMs) {
      now = nextMs
      return now
    },
    advance(ms) {
      now += ms
      return now
    },
  }
}

/**
 * 创建一个使用临时目录的记忆引擎。
 * @param {{ config?: object, clock?: { now: () => number }, dataDir?: string }} [options]
 */
export function newMemoryEngine({ config, clock, dataDir } = {}) {
  const dir = dataDir || makeTempDir('dshpet-verify-mem-')
  resetMemoryEngineRegistry()
  const engine = getMemoryEngine({ dataDir: dir, clock: clock || makeClock(), config })
  engine.ensure()
  return { engine, dataDir: dir, clock: engine.clock }
}

export function memoryPaths(dataDir) {
  const memoryDir = path.join(dataDir, 'memory')
  return {
    dataDir,
    memoryDir,
    longTermDir: path.join(memoryDir, 'long-term'),
    shortTerm: path.join(memoryDir, 'short-term.json'),
    meta: path.join(memoryDir, 'meta.json'),
    index: path.join(memoryDir, 'index.json'),
    overview: path.join(memoryDir, '记忆总览.md'),
    events: path.join(memoryDir, 'events.jsonl'),
    layer: (layer) => path.join(memoryDir, 'long-term', `layer-${layer}.json`),
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

/** 一条可被引擎正常加载的「长期记忆」种子条目。 */
export function makeSeedItem(overrides = {}) {
  const mentionCount = overrides.mentionCount ?? 1
  const content = overrides.content ?? '主人喜欢测试用的种子记忆。'
  // 摘要默认按 SPEC 4.7 从 content 推导，避免调用方只改 content 时摘要不匹配
  const derivedSummary = (() => {
    const text = String(content).trim()
    if (text.length <= 30) return text
    const firstClause = (text.split(/[。！？；\n]/u)[0] || text).trim()
    return firstClause.length <= 30 ? firstClause : firstClause.slice(0, 30)
  })()
  const defaults = {
    id: 'mem-900001',
    content,
    summary: derivedSummary,
    keywords: ['种子记忆', '测试', '主人'],
    category: '喜好',
    mentionCount,
    emphasis: 0,
    firstSeenAt: '2026-10-01T10:00:00+08:00',
    lastMentionedAt: '2026-10-01T10:00:00+08:00',
    layer: 1,
    mentionCountAtLastMaintenance: mentionCount,
    lastLayerChangeAt: null,
    history: [],
    source: 'test:seed',
  }
  return { ...defaults, ...overrides }
}

/**
 * 在创建引擎前预置磁盘数据（用于构造七层维护、检索、调度等场景）。
 * @param {string} dataDir
 * @param {{ short?: object[], layers?: Record<number, object[]>, meta?: object }} [seed]
 */
export function seedMemoryData(dataDir, { short = [], layers = {}, meta = {} } = {}) {
  const paths = memoryPaths(dataDir)
  fs.mkdirSync(paths.longTermDir, { recursive: true })
  const nowIso = '2026-11-01T00:00:00+08:00'
  fs.writeFileSync(
    paths.shortTerm,
    JSON.stringify({ schemaVersion: 1, updatedAt: nowIso, capacity: 20, items: short }, null, 2) + '\n',
    'utf8',
  )
  for (let layer = 1; layer <= 7; layer += 1) {
    fs.writeFileSync(
      paths.layer(layer),
      JSON.stringify({ schemaVersion: 1, layer, updatedAt: nowIso, items: layers[layer] || [] }, null, 2) + '\n',
      'utf8',
    )
  }
  fs.writeFileSync(
    paths.meta,
    JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastMaintenanceAt: null,
        lastMaintenanceDateKey: null,
        lastMaintenanceReason: null,
        maintenanceHistory: [],
        processedMessageIds: [],
        sequence: 0,
        ...meta,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  fs.writeFileSync(
    paths.index,
    JSON.stringify({ schemaVersion: 1, updatedAt: nowIso, keywords: {}, categories: {}, layers: {} }, null, 2) + '\n',
    'utf8',
  )
  fs.writeFileSync(paths.events, '', 'utf8')
  fs.writeFileSync(paths.overview, '# 记忆总览\n', 'utf8')
  return paths
}

/** 统计文本中某个子串出现次数。 */
export function countOccurrences(text, needle) {
  if (!needle) return 0
  let count = 0
  let index = 0
  while (true) {
    const found = text.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

export { resetMemoryEngineRegistry }
