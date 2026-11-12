/**
 * pending-seed 机制测试：常驻记忆引擎单例在外部脚本导入后，下一次操作能吸收 pending 条目，
 * 避免旧内存态持久化时覆盖新导入的人设经历。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getMemoryEngine, resetMemoryEngineRegistry } from '../../lib/memory/index.js'
import { writeJsonSync } from '../../lib/shared/fsutil.js'

function item(index, overrides = {}) {
  return {
    id: `seed-test-${String(index).padStart(3, '0')}`,
    content: `【测试】奥菲莉亚的个人经历第 ${index} 条：闭馆夜的记录。`,
    keywords: ['闭馆夜', '记录', '测试'],
    category: '事件',
    importance: 70,
    layer: 7,
    occurredAt: `2024-01-0${Math.min(index, 9)}T20:00:00+08:00`,
    source: 'persona-history',
    ...overrides,
  }
}

function pendingFile(dataDir) {
  return path.join(dataDir, 'memory', 'pending-seed.json')
}

test('pending-seed：外部写入后由同一引擎吸收，并落盘为新记忆', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-pending-seed-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  resetMemoryEngineRegistry()
  const engine = getMemoryEngine({ dataDir: root })
  engine.remember({ content: '旧引擎里唯一的一条记忆。', at: Date.parse('2026-11-06T08:00:00+08:00') })
  assert.equal(engine.status().total, 1)

  writeJsonSync(pendingFile(root), { schemaVersion: 1, items: [item(1), item(2), item(3)] })
  const absorbed = engine.consumePendingSeedIfAny()
  assert.equal(absorbed.created, 3)
  assert.equal(fs.existsSync(pendingFile(root)), false)
  assert.equal(engine.status().total, 4)

  // 持久化文件里也是 4 条（不是旧内存态的 1 条）
  const layer7 = JSON.parse(fs.readFileSync(path.join(root, 'memory', 'long-term', 'layer-7.json'), 'utf8'))
  assert.equal(layer7.items.length, 3)
  assert.ok(layer7.items.every((entry) => entry.occurredAt && entry.source === 'persona-history'))
  const short = JSON.parse(fs.readFileSync(path.join(root, 'memory', 'short-term.json'), 'utf8'))
  assert.equal(short.items.length, 1)
})

test('pending-seed：getMemoryEngine 返回已有单例时也会吸收', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-pending-seed-factory-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  resetMemoryEngineRegistry()
  const first = getMemoryEngine({ dataDir: root })
  first.ensure()
  writeJsonSync(pendingFile(root), { schemaVersion: 1, items: [item(4), item(5)] })
  const second = getMemoryEngine({ dataDir: root })
  assert.equal(second, first)
  assert.equal(second.status().total, 2)
  assert.equal(fs.existsSync(pendingFile(root)), false)
})

test('pending-seed：损坏文件被清理且不影响既有记忆', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-pending-seed-broken-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  resetMemoryEngineRegistry()
  const engine = getMemoryEngine({ dataDir: root })
  engine.remember({ content: '保持原样的一条记忆。' })
  fs.writeFileSync(pendingFile(root), '{not json', 'utf8')
  const result = engine.consumePendingSeedIfAny()
  assert.equal(result.created, 0)
  assert.equal(engine.status().total, 1)
  assert.equal(fs.existsSync(pendingFile(root)), false)
})
