/**
 * 记忆模块测试公共工具（本文件不是测试文件，不会被 run-tests.mjs 收集）。
 * 所有测试只使用 fs.mkdtempSync 创建的系统临时目录，不读写默认数据目录（~/.dsh/dsh-pet/companion-data）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getMemoryEngine, resetMemoryEngineRegistry } from '../../lib/memory/index.js'
import { createFixedClock, formatLocalIso, MS_PER_DAY } from '../../lib/shared/clock.js'
import { computeClarity, computeImportance } from '../../lib/memory/model.js'

export { MS_PER_DAY }

/** 记忆分类枚举（SPEC 4.4）。 */
export const CATEGORY_ENUM = ['喜好', '身份', '人际', '事件', '情绪', '承诺', '计划', '健康', '工作学习', '其他']

/** 用本地时区构造毫秒时间戳（测试不依赖运行机器的时区）。 */
export function localMs(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  return new Date(year, month - 1, day, hour, minute, second, millisecond).getTime()
}

/** 毫秒时间戳 → 本地时区 ISO 字符串。 */
export function isoOf(ms) {
  return formatLocalIso(ms)
}

function makeCleanup(dataDir) {
  return () => {
    resetMemoryEngineRegistry()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

function describeContext(dataDir) {
  return {
    dataDir,
    memoryDir: path.join(dataDir, 'memory'),
    longTermDir: path.join(dataDir, 'memory', 'long-term'),
    cleanup: makeCleanup(dataDir),
  }
}

/** 创建临时数据目录 + 固定时钟 + 记忆引擎（已 ensure）。 */
export function createEngine({ start, config } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpet-memory-'))
  const startMs = start ?? localMs(2026, 11, 5, 10, 0)
  resetMemoryEngineRegistry()
  const clock = createFixedClock(startMs)
  const engine = getMemoryEngine({ dataDir, clock, config })
  engine.ensure()
  return { engine, clock, ...describeContext(dataDir) }
}

/** 在已有数据目录上「重启」：清空注册表后用新引擎实例重新加载。 */
export function reopenEngine(dataDir, { start, config } = {}) {
  resetMemoryEngineRegistry()
  const clock = createFixedClock(start ?? localMs(2026, 11, 5, 10, 0))
  const engine = getMemoryEngine({ dataDir, clock, config })
  engine.ensure()
  return { engine, clock }
}

/** 构造一条字段完整的记忆条目（用于直接预置数据文件）。 */
export function makeItem(overrides = {}) {
  const firstSeenAt = overrides.firstSeenAt ?? isoOf(localMs(2026, 11, 1, 10, 0))
  const base = {
    id: 'mem-000001',
    content: '主人喜欢夜里听雨声。',
    summary: '主人喜欢夜里听雨声。',
    keywords: ['雨声', '夜晚', '喜欢'],
    category: '喜好',
    mentionCount: 1,
    emphasis: 0,
    importance: 0,
    clarity: 0,
    firstSeenAt,
    lastMentionedAt: overrides.lastMentionedAt ?? firstSeenAt,
    layer: overrides.layer ?? 'short',
    mentionCountAtLastMaintenance: overrides.mentionCountAtLastMaintenance ?? overrides.mentionCount ?? 1,
    lastLayerChangeAt: null,
    history: [],
    source: 'auto_extract',
    ...overrides,
  }
  base.importance = computeImportance(base)
  base.clarity = computeClarity(base.importance)
  return base
}

/** 写 JSON 文件（2 空格缩进 + 末尾换行，与引擎持久化格式一致）。 */
export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 读 JSON 文件。 */
export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 读 UTF-8 文本文件。 */
export function readTextFile(file) {
  return fs.readFileSync(file, 'utf8')
}

/** 递归列出目录下所有文件（返回相对路径，使用 / 分隔）。 */
export function listFilesRecursive(dir) {
  const files = []
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative)
      else files.push(relative)
    }
  }
  walk(dir, '')
  return files
}

/** 预置数据文件后创建引擎（用于直接构造特定层级/时间的数据）。 */
export function seedEngine({ start, config, short = [], layers = [], meta = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpet-memory-'))
  const memoryDir = path.join(dataDir, 'memory')
  const longTermDir = path.join(memoryDir, 'long-term')
  fs.mkdirSync(longTermDir, { recursive: true })
  const startMs = start ?? localMs(2026, 11, 5, 10, 0)
  const stamp = formatLocalIso(startMs)
  writeJsonFile(path.join(memoryDir, 'short-term.json'), {
    schemaVersion: 1,
    updatedAt: stamp,
    capacity: config?.shortTermCapacity ?? 20,
    items: short,
  })
  for (let layer = 1; layer <= 7; layer += 1) {
    writeJsonFile(path.join(longTermDir, `layer-${layer}.json`), {
      schemaVersion: 1,
      layer,
      updatedAt: stamp,
      items: layers[layer - 1] ?? [],
    })
  }
  let sequence = 0
  for (const item of [...short, ...layers.flat()]) {
    const match = /^mem-(\d+)$/u.exec(String(item?.id ?? ''))
    if (match) sequence = Math.max(sequence, Number(match[1]))
  }
  writeJsonFile(path.join(memoryDir, 'meta.json'), {
    schemaVersion: 1,
    createdAt: stamp,
    updatedAt: stamp,
    lastMaintenanceAt: null,
    lastMaintenanceDateKey: null,
    lastMaintenanceReason: null,
    maintenanceHistory: [],
    processedMessageIds: [],
    sequence,
    ...meta,
  })
  resetMemoryEngineRegistry()
  const clock = createFixedClock(startMs)
  const engine = getMemoryEngine({ dataDir, clock, config })
  engine.ensure()
  return { engine, clock, ...describeContext(dataDir) }
}
