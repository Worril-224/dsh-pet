/**
 * 独立验收测试 · 文档与实现一致性（修复后复验）
 * 覆盖需求编号：DEV-02（SPEC 4.9 首次运行初始化分支）、DEV-04（SPEC 6 QQ payload 形态）、
 *                DEV-05（README 配置项与实际能力一致）
 *
 * 用于核对 Lead 修复后「文档描述」与「实现行为」是否一致。
 * 全部测试只读文档/源码，引擎测试使用系统临时目录。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildQQReplyPayload } from '../../companion-bundle/lib/im/qq-bot.js'
import { DECAY_DAYS, DEFAULT_MEMORY_CONFIG } from '../../companion-bundle/lib/memory/constants.js'
import { cleanupTempDirs, localMs, makeClock, newMemoryEngine } from './helpers.mjs'

test.after(cleanupTempDirs)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SPEC_TEXT = fs.readFileSync(path.join(ROOT, 'docs', 'SPEC.md'), 'utf8')
const README_TEXT = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const SCHEDULER_SOURCE = fs.readFileSync(path.join(ROOT, 'companion-bundle', 'lib', 'memory', 'scheduler.js'), 'utf8')

test('DEV-02 修复复验: SPEC 4.9 已补充「首次运行初始化」分支，且与 scheduler/引擎行为一致', () => {
  assert.ok(SPEC_TEXT.includes('首次运行初始化'), 'SPEC 4.9 应说明首次运行初始化分支')
  assert.ok(SPEC_TEXT.includes('lastMaintenanceDateKey` 缺失'), 'SPEC 应说明触发条件（lastMaintenanceDateKey 缺失）')
  assert.ok(SCHEDULER_SOURCE.includes('首次运行初始化'), 'scheduler.js 应实现该分支')

  // 行为核对：全新数据目录、本地凌晨 2 点（不在 4–6 窗口）→ 仍返回应维护 + 专属 reason
  const { engine } = newMemoryEngine({ clock: makeClock(localMs(2026, 11, 5, 2, 0)) })
  const check = engine.checkMaintenance({ at: localMs(2026, 11, 5, 2, 0) })
  assert.deepEqual(check, { shouldRun: true, reason: '首次运行初始化' })
  // 首次维护后应按常规规则判断（当天不在窗口/未补跑 → 不再触发）
  engine.maintain({ at: localMs(2026, 11, 5, 2, 0) })
  assert.equal(engine.checkMaintenance({ at: localMs(2026, 11, 5, 2, 30) }).shouldRun, false)
})

test('DEV-04 修复复验: SPEC 第 6 节描述的 QQ 回复 payload 形态与 buildQQReplyPayload 实现一致', () => {
  assert.ok(SPEC_TEXT.includes('{ endpoint, method, body'), 'SPEC 6 应描述 buildReplyPayload 返回 {endpoint, method, body}')
  assert.ok(SPEC_TEXT.includes('msg_type: 0'), 'SPEC 6 应说明 body 内含 msg_type: 0')

  const payload = buildQQReplyPayload({ text: '晚安呀', userId: 'openid-1', replyTo: 'msg-1' })
  assert.equal(payload.endpoint, '/v2/users/openid-1/messages')
  assert.equal(payload.method, 'POST')
  assert.deepEqual(payload.body, { content: '晚安呀', msg_type: 0, msg_id: 'msg-1' })
  assert.equal(payload.body.msg_type, 0)
  assert.equal(payload.body.msg_id, 'msg-1')
})

test('DEV-05 修复复验: README 不再声称可配置 decayDays，并说明衰减阈值固定', () => {
  assert.ok(!README_TEXT.includes('decayDays'), 'README 不应再声称 memoryConfig 可覆盖 decayDays')
  assert.ok(README_TEXT.includes('1 / 3 / 7 / 14 / 30 / 140 天'), 'README 应说明衰减阈值固定')
  assert.ok(README_TEXT.includes('第 1 层 → 第 2 层'), 'README 应给出七层衰减对照表')
  // 可配置项仍应在 SPEC 中说明
  assert.ok(SPEC_TEXT.includes('shortTermCapacity'), 'SPEC 应继续说明可配置项 shortTermCapacity')
  assert.ok(SPEC_TEXT.includes('digestMaxChars'), 'SPEC 应继续说明可配置项 digestMaxChars')

  // 实现侧核对：默认配置里没有 decayDays；衰减阈值是常量且与 SPEC 一致
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_MEMORY_CONFIG, 'decayDays'), false)
  assert.deepEqual(DECAY_DAYS, [1, 3, 7, 14, 30, 140])
})

test('SPEC 文档自洽性: 第 4.9 节首次运行分支与 M12 常规调度规则并存且无矛盾表述', () => {
  const section = SPEC_TEXT.slice(SPEC_TEXT.indexOf('### 4.9'), SPEC_TEXT.indexOf('### 4.10'))
  assert.ok(section.includes('首次运行初始化'))
  assert.ok(section.includes('每日凌晨维护窗口'))
  assert.ok(section.includes('补跑（应用未在凌晨运行）'))
  // 三种 reason 均被文档化
  for (const reason of ['首次运行初始化', '每日凌晨维护窗口', '补跑（应用未在凌晨运行）']) {
    assert.ok(section.includes(reason), `SPEC 4.9 缺少 reason 说明：${reason}`)
  }
})
