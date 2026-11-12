/**
 * 记忆持久化层：目录布局、默认文件、原子读写（SPEC 4.11）。
 * 所有 JSON 文件均为 UTF-8、2 空格缩进、文件末尾换行；写盘由 shared/fsutil 保证原子（临时文件 + rename）。
 */
import fs from 'node:fs'
import { resolveCompanionPaths } from '../shared/paths.js'
import { ensureDirSync, readJsonSync, writeJsonSync, writeTextSync, appendJsonlSync } from '../shared/fsutil.js'
import { SCHEMA_VERSION, LONG_TERM_LAYERS } from './constants.js'

/** meta.json 默认结构。 */
export function defaultMeta(nowIso) {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastMaintenanceAt: null,
    lastMaintenanceDateKey: null,
    lastMaintenanceReason: null,
    maintenanceHistory: [],
    processedMessageIds: [],
    sequence: 0,
  }
}

/** short-term.json 默认结构。 */
export function defaultShortTerm(capacity, nowIso) {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: nowIso, capacity, items: [] }
}

/** 长期记忆层文件默认结构。 */
export function defaultLayer(layer, nowIso) {
  return { schemaVersion: SCHEMA_VERSION, layer, updatedAt: nowIso, items: [] }
}

/** index.json 默认结构。 */
export function defaultIndex(nowIso) {
  const layers = { short: 0 }
  for (let layer = 1; layer <= LONG_TERM_LAYERS; layer += 1) layers[layer] = 0
  return { schemaVersion: SCHEMA_VERSION, updatedAt: nowIso, keywords: {}, categories: {}, layers }
}

/** 记忆文件存储（同步读写，文件都很小，便于 prompt 同步渲染）。 */
export class MemoryStore {
  /** @param {string} dataDir 陪伴数据根目录（会解析为 <dataDir>/memory） */
  constructor(dataDir) {
    this.paths = resolveCompanionPaths(dataDir)
    this.dataDir = this.paths.root
  }

  /** 确保目录与默认文件存在（不覆盖已有文件）。 */
  ensureLayout({ nowIso, capacity }) {
    ensureDirSync(this.paths.memoryDir)
    ensureDirSync(this.paths.longTermDir)
    if (!fs.existsSync(this.paths.shortTermFile)) {
      writeJsonSync(this.paths.shortTermFile, defaultShortTerm(capacity, nowIso))
    }
    this.paths.layerFiles.forEach((file, index) => {
      if (!fs.existsSync(file)) writeJsonSync(file, defaultLayer(index + 1, nowIso))
    })
    if (!fs.existsSync(this.paths.metaFile)) writeJsonSync(this.paths.metaFile, defaultMeta(nowIso))
    if (!fs.existsSync(this.paths.indexFile)) writeJsonSync(this.paths.indexFile, defaultIndex(nowIso))
    if (!fs.existsSync(this.paths.eventsFile)) writeTextSync(this.paths.eventsFile, '')
    if (!fs.existsSync(this.paths.overviewFile)) writeTextSync(this.paths.overviewFile, '# 记忆总览\n')
    return this.paths
  }

  /** 读取短期记忆文件；不存在时返回默认结构。 */
  loadShortTerm(nowIso, capacity) {
    const doc = readJsonSync(this.paths.shortTermFile, null) || defaultShortTerm(capacity, nowIso)
    return {
      schemaVersion: doc.schemaVersion ?? SCHEMA_VERSION,
      updatedAt: doc.updatedAt ?? nowIso,
      capacity: Number.isFinite(Number(doc.capacity)) ? Number(doc.capacity) : capacity,
      items: Array.isArray(doc.items) ? doc.items : [],
    }
  }

  /** 读取第 layer 层长期记忆文件；不存在时返回默认结构。 */
  loadLayer(layer, nowIso) {
    const file = this.paths.layerFiles[layer - 1]
    const doc = readJsonSync(file, null) || defaultLayer(layer, nowIso)
    return {
      schemaVersion: doc.schemaVersion ?? SCHEMA_VERSION,
      layer,
      updatedAt: doc.updatedAt ?? nowIso,
      items: Array.isArray(doc.items) ? doc.items : [],
    }
  }

  /** 读取 meta.json（缺失字段用默认值补齐）。 */
  loadMeta(nowIso) {
    const stored = readJsonSync(this.paths.metaFile, {}) || {}
    return { ...defaultMeta(nowIso), ...stored }
  }

  /** 读取 index.json（供人工核验；引擎会按实际记忆重建）。 */
  loadIndex(nowIso) {
    return readJsonSync(this.paths.indexFile, null) || defaultIndex(nowIso)
  }

  /** 原子写入 short-term.json。 */
  saveShortTerm(items, capacity, updatedAt) {
    writeJsonSync(this.paths.shortTermFile, {
      schemaVersion: SCHEMA_VERSION,
      updatedAt,
      capacity,
      items,
    })
  }

  /** 原子写入第 layer 层长期记忆文件。 */
  saveLayer(layer, items, updatedAt) {
    const file = this.paths.layerFiles[layer - 1]
    writeJsonSync(file, { schemaVersion: SCHEMA_VERSION, layer, updatedAt, items })
  }

  /** 原子写入 meta.json。 */
  saveMeta(meta) {
    writeJsonSync(this.paths.metaFile, meta)
  }

  /** 原子写入 index.json。 */
  saveIndex(indexDoc) {
    writeJsonSync(this.paths.indexFile, indexDoc)
  }

  /** 原子写入「记忆总览.md」。 */
  saveOverview(text) {
    writeTextSync(this.paths.overviewFile, text)
  }

  /** 追加一行记忆事件（events.jsonl）。 */
  appendEvent(event) {
    appendJsonlSync(this.paths.eventsFile, event)
  }
}
