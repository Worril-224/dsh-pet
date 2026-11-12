/**
 * 独立验收测试 · 记忆模块（M1–M14 + 边界用例）
 * 覆盖需求编号：M1 M2 M3 M4 M5 M6 M7 M8 M9 M10 M11 M12 M13 M14
 *
 * 全部测试在操作系统临时目录中运行（helpers.makeTempDir → fs.mkdtempSync），
 * 不读写仓库内 companion-data。测试由验收员 verifier 独立设计编写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { computeClarity, computeImportance } from '../../companion-bundle/lib/memory/model.js'
import { renderItemByClarity, renderDigestText } from '../../companion-bundle/lib/memory/render.js'
import { buildSummary, classifyCategory, extractMemories } from '../../companion-bundle/lib/memory/text.js'
import { DECAY_DAYS, DEFAULT_MEMORY_CONFIG } from '../../companion-bundle/lib/memory/constants.js'
import {
  cleanupTempDirs,
  countOccurrences,
  localMs,
  makeClock,
  makeSeedItem,
  makeTempDir,
  memoryPaths,
  newMemoryEngine,
  readJson,
  readText,
  resetMemoryEngineRegistry,
  seedMemoryData,
} from './helpers.mjs'

const MS_DAY = 86400000

test.after(cleanupTempDirs)

// ───────────────────────────── M1 记忆字段完整性 ─────────────────────────────

test('M1: 新建记忆字段齐全、中文内容、short 层默认、摘要按规则生成', () => {
  const { engine } = newMemoryEngine()
  const at = localMs(2026, 11, 5, 10, 0)
  const content = '主人最喜欢草莓味蛋糕，生日时也会吃这个。'
  const result = engine.remember({
    content,
    keywords: ['草莓蛋糕', '喜欢', '生日'],
    category: '喜好',
    emphasis: 2,
    at,
  })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'created')

  const item = result.item
  const required = [
    'id',
    'content',
    'summary',
    'keywords',
    'category',
    'mentionCount',
    'emphasis',
    'importance',
    'clarity',
    'firstSeenAt',
    'lastMentionedAt',
    'layer',
    'mentionCountAtLastMaintenance',
    'lastLayerChangeAt',
    'history',
    'source',
  ]
  for (const field of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(item, field), `记忆缺少字段：${field}`)
  }
  assert.match(item.content, /[\u4e00-\u9fff]/u, 'content 必须是中文')
  assert.ok(Array.isArray(item.keywords) && item.keywords.length >= 3 && item.keywords.length <= 12)
  assert.ok(item.keywords.slice(0, -1).every((word) => /[\u4e00-\u9fff#]/u.test(word)), '内容关键词应为中文')
  assert.match(item.keywords.at(-1), /^\d{4}-\d{2}-\d{2}$/u, '最后一项应为生成日期')
  assert.equal(item.category, '喜好')
  assert.equal(item.mentionCount, 1)
  assert.equal(item.emphasis, 2)
  assert.equal(item.layer, 'short')
  assert.deepEqual(item.history, [])
  assert.equal(item.firstSeenAt, item.lastMentionedAt)
  assert.equal(Date.parse(item.lastMentionedAt), at)
  assert.match(item.firstSeenAt, /[+-]\d{2}:\d{2}$/u, '时间戳应为带本地时区偏移的 ISO 8601')
  // 摘要规则（SPEC 4.7）：≤30 字符直接使用（保留原样），否则取第一个分句截断 30
  assert.ok(item.summary.length <= 30)
  assert.equal(item.summary, content, 'content <=30 字符时摘要应直接使用原文')
  assert.ok(content.startsWith(item.summary), '摘要应为内容开头')

  // 派生字段与公式一致（SPEC 4.2）：short 层 mention=1 emphasis=2 → 20+10+20=50
  assert.equal(item.importance, 50)
  assert.equal(item.clarity, 0.5)

  // 长内容摘要截断到 30 字符
  const long = engine.remember({ content: '一'.repeat(10) + '二'.repeat(10) + '三'.repeat(20) + '。后面还有内容。' })
  assert.equal(long.item.summary.length, 30)
})

// ───────────────────────────── M2 关键词规则 ─────────────────────────────

test('M2: 关键词 >5 截断、<3 自动补足、调用方顺序保留、中文关键词', () => {
  const { engine } = newMemoryEngine()

  // 超过 5 个 → 截断为前 5 个，且顺序保留（不重排）
  const many = engine.remember({
    content: '测试七个关键词的截断与顺序保留行为。',
    keywords: ['第一关键词', '第二关键词', '第三关键词', '第四关键词', '第五关键词', '第六关键词', '第七关键词'],
  })
  assert.equal(many.item.keywords.length, 6)
  assert.deepEqual(many.item.keywords.slice(0, 5), ['第一关键词', '第二关键词', '第三关键词', '第四关键词', '第五关键词'])
  assert.equal(many.item.keywords[5], many.item.createdAt.slice(0, 10))

  // 少于 3 个 → 自动补足到至少 3 个，且首个仍是调用方给出的
  const few = engine.remember({ content: '主人喜欢草莓蛋糕和热可可', keywords: ['草莓'] })
  assert.ok(few.item.keywords.length >= 3 && few.item.keywords.length <= 12)
  assert.equal(few.item.keywords[0], '草莓')
  assert.ok(few.item.keywords.every((word) => word.trim().length > 0))

  // 内容几乎无信息量 → 允许 #分类 回填标签补足到 3 个
  const empty = engine.remember({ content: '嗯', keywords: [] })
  assert.equal(empty.item.keywords.length, 4)
  assert.ok(empty.item.keywords.some((word) => word.startsWith('#')), '信息不足时应出现 # 回填标签')
  assert.match(empty.item.keywords[0], /^#/u)

  // 传入 3 个合法关键词时保持原顺序
  const ordered = engine.remember({ content: '顺序保留测试记忆', keywords: ['乙词', '甲词', '丙词'] })
  assert.deepEqual(ordered.item.keywords.slice(0, 3), ['乙词', '甲词', '丙词'])

  // 自动抽取的记忆关键词也是 3~5 个中文关键词
  const ingest = engine.ingestMessage({ text: '我喜欢蓝莓', messageId: 'kw-1', role: 'user', at: localMs(2026, 11, 5, 11, 0) })
  assert.ok(ingest.created.length >= 1)
  const created = ingest.created[0]
  assert.ok(created.keywords.length >= 3 && created.keywords.length <= 12)
  assert.equal(created.keywords[0], '蓝莓')
})

test('M2 边界: # 开头的分类回填标签不参与提及匹配', () => {
  const { engine } = newMemoryEngine()
  const created = engine.remember({
    content: '标签忽略测试内容足够长',
    keywords: ['#喜好', '甲甲甲', '乙乙乙'],
  })
  const id = created.item.id
  assert.equal(engine.getItem(id).mentionCount, 1)

  // 文本包含 #喜好 标签，但不应命中
  engine.ingestMessage({ text: '这里出现 #喜好 标签', messageId: 'tag-1', role: 'user', at: localMs(2026, 11, 5, 12, 0) })
  assert.equal(engine.getItem(id).mentionCount, 1, '#标签不应参与提及匹配')

  // 普通关键词仍可命中（正面对照）
  engine.ingestMessage({ text: '甲甲甲', messageId: 'tag-2', role: 'user', at: localMs(2026, 11, 5, 12, 5) })
  assert.equal(engine.getItem(id).mentionCount, 2)
})

// ───────────────────────────── M3 重要性 / 清晰度公式 ─────────────────────────────

test('M3: 重要度/清晰度公式与 SPEC 4.2 完全一致（含层级加成、封顶、夹取）', () => {
  const formula = (mentionCount, emphasis, layer) => {
    const bonus = layer === 'short' ? 0 : (7 - layer) * 4
    return Math.min(100, Math.max(1, Math.round(20 + 10 * Math.min(mentionCount, 6) + 10 * Math.min(emphasis, 3) + bonus)))
  }
  const cases = [
    [0, 0, 'short'],
    [1, 0, 'short'],
    [3, 1, 'short'],
    [6, 0, 'short'],
    [100, 0, 'short'],
    [1, 0, 1],
    [1, 0, 4],
    [1, 0, 7],
    [6, 3, 1],
    [2, 2, 2],
  ]
  for (const [mentionCount, emphasis, layer] of cases) {
    assert.equal(computeImportance({ mentionCount, emphasis, layer }), formula(mentionCount, emphasis, layer))
  }
  // 清晰度公式
  assert.equal(computeClarity(100), 1)
  assert.equal(computeClarity(70), 0.7)
  assert.equal(computeClarity(62), 0.62)
  assert.equal(computeClarity(30), 0.3)
  assert.equal(computeClarity(15), 0.15)
  assert.equal(computeClarity(1), 0.15, 'importante/100 小于 0.15 时夹取到 0.15')
})

test('M3: 引擎落库的重要度与公式一致，清晰度三档渲染可区分', () => {
  const { engine } = newMemoryEngine()
  const at = localMs(2026, 11, 5, 4, 30)
  const created = engine.remember({ content: '主人喜欢测试公式的条目。', at })
  assert.equal(created.item.importance, 30) // 20 + 10*1 + 10*0
  assert.equal(created.item.clarity, 0.3)
  // 维护进入第一层后层级加成 (7-1)*4=24
  engine.maintain({ at })
  const moved = engine.getItem(created.item.id)
  assert.equal(moved.layer, 1)
  assert.equal(moved.importance, 54)
  assert.equal(moved.clarity, 0.54)

  const base = { id: 'x', content: '完整内容完整内容完整内容', summary: '摘要摘要', keywords: ['首词', '次词', '末词'], firstSeenAt: '2026-11-01T10:00:00+08:00', mentionCount: 2 }
  const clear = renderItemByClarity({ ...base, clarity: 0.8 })
  assert.ok(clear.includes('完整内容完整内容完整内容'), 'clarity>=0.7 应含完整 content')
  assert.ok(clear.includes('关键词：首词、次词、末词'))
  assert.ok(clear.includes('首次：'))
  assert.ok(clear.includes('提及 2 次'))

  const normal = renderItemByClarity({ ...base, clarity: 0.5 })
  assert.ok(normal.includes('摘要摘要'), '0.4<=clarity<0.7 应使用 summary')
  assert.ok(normal.includes('关键词：首词'), '只显示首个关键词')
  assert.ok(!normal.includes('次词'), '不应显示全部关键词')
  assert.ok(normal.includes('提及 2 次'))

  const fuzzy = renderItemByClarity({ ...base, clarity: 0.2 })
  assert.ok(fuzzy.includes('…（记忆有些模糊）'))
  assert.ok(fuzzy.length < clear.length)
})

// ───────────────────────────── M4 提及次数与强调 ─────────────────────────────

test('M4: 关键词命中 → mentionCount+1、lastMentionedAt 更新；重复 messageId 不重复计数', () => {
  const { engine } = newMemoryEngine()
  const createdAt = localMs(2026, 11, 5, 10, 0)
  const created = engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['草莓蛋糕', '喜欢', '蛋糕'], at: createdAt })
  const id = created.item.id

  const at1 = localMs(2026, 11, 6, 9, 12)
  const first = engine.ingestMessage({ text: '今天又吃了草莓蛋糕', messageId: 'msg-1', role: 'user', at: at1, sessionId: 's1' })
  assert.equal(first.skipped, false)
  const mentioned = first.mentioned.find((entry) => entry.id === id)
  assert.ok(mentioned, '应记录该记忆被提及')
  assert.equal(mentioned.mentionCount, 2)
  const afterFirst = engine.getItem(id)
  assert.equal(afterFirst.mentionCount, 2)
  assert.equal(Date.parse(afterFirst.lastMentionedAt), at1)

  // 同一 messageId 第二次 → 整条消息跳过，不再计数
  const again = engine.ingestMessage({ text: '今天又吃了草莓蛋糕', messageId: 'msg-1', role: 'user', at: localMs(2026, 11, 6, 9, 20) })
  assert.equal(again.skipped, true)
  assert.equal(again.mentioned.length, 0)
  assert.equal(again.created.length, 0)
  assert.equal(engine.getItem(id).mentionCount, 2)

  // 换一个 messageId 的同文本 → 计数继续增长
  const third = engine.ingestMessage({ text: '今天又吃了草莓蛋糕', messageId: 'msg-2', role: 'user', at: localMs(2026, 11, 6, 9, 30) })
  assert.equal(third.skipped, false)
  assert.equal(engine.getItem(id).mentionCount, 3)

  // 非 user 角色不处理
  const bot = engine.ingestMessage({ text: '今天又吃了草莓蛋糕', messageId: 'msg-3', role: 'assistant', at: localMs(2026, 11, 6, 9, 40) })
  assert.equal(bot.skipped, true)
  assert.equal(engine.getItem(id).mentionCount, 3)
})

test('M4: 强调词使命中记忆 emphasis+1，同一消息每条最多 +1，上限 3', () => {
  const { engine } = newMemoryEngine()
  const created = engine.remember({ content: '主人明天要考试。', keywords: ['考试', '明天', '学习'], at: localMs(2026, 11, 5, 10, 0) })
  const id = created.item.id
  assert.equal(engine.getItem(id).emphasis, 0)

  // 一条消息同时含两个强调词，也只 +1
  engine.ingestMessage({
    text: '记住，明天的考试很重要',
    messageId: 'em-1',
    role: 'user',
    at: localMs(2026, 11, 5, 11, 0),
  })
  assert.equal(engine.getItem(id).emphasis, 1)

  engine.ingestMessage({ text: '别忘考试', messageId: 'em-2', role: 'user', at: localMs(2026, 11, 5, 12, 0) })
  assert.equal(engine.getItem(id).emphasis, 2)
  engine.ingestMessage({ text: '答应我考试', messageId: 'em-3', role: 'user', at: localMs(2026, 11, 5, 13, 0) })
  assert.equal(engine.getItem(id).emphasis, 3)
  engine.ingestMessage({ text: '一定考试', messageId: 'em-4', role: 'user', at: localMs(2026, 11, 5, 14, 0) })
  assert.equal(engine.getItem(id).emphasis, 3, 'emphasis 上限为 3')

  // 强调词只加成「被关键词命中」的记忆：未命中的记忆 emphasis 不变
  const other = engine.remember({ content: '主人喜欢安静。', keywords: ['安静', '喜欢', '环境'], at: localMs(2026, 11, 5, 10, 30) })
  engine.ingestMessage({ text: '记住考试', messageId: 'em-5', role: 'user', at: localMs(2026, 11, 5, 15, 0) })
  assert.equal(engine.getItem(other.item.id).emphasis, 0)
})

test('M4/M13: 已处理 messageId 持久化，引擎重启后同一 messageId 仍被去重', () => {
  const { engine, dataDir } = newMemoryEngine()
  const created = engine.remember({ content: '主人喜欢草莓蛋糕。', keywords: ['草莓蛋糕', '喜欢', '蛋糕'], at: localMs(2026, 11, 5, 10, 0) })
  engine.ingestMessage({ text: '草莓蛋糕真好吃', messageId: 'persist-msg-1', role: 'user', at: localMs(2026, 11, 5, 11, 0) })
  assert.equal(engine.getItem(created.item.id).mentionCount, 2)

  resetMemoryEngineRegistry()
  const { engine: restarted } = newMemoryEngine({ dataDir, clock: makeClock(localMs(2026, 11, 5, 12, 0)) })
  const replay = restarted.ingestMessage({ text: '草莓蛋糕真好吃', messageId: 'persist-msg-1', role: 'user', at: localMs(2026, 11, 5, 12, 30) })
  assert.equal(replay.skipped, true, '重启后同一 messageId 仍应去重')
  assert.equal(restarted.getItem(created.item.id).mentionCount, 2)
})

// ───────────────────────────── M5 自动抽取 ─────────────────────────────

function ingestOnce(text, messageId = `auto-${Math.random().toString(16).slice(2, 8)}`) {
  const { engine } = newMemoryEngine()
  const result = engine.ingestMessage({ text, messageId, role: 'user', at: localMs(2026, 11, 5, 20, 0) })
  return result
}

test('M5: 7 类中文模式均可自动抽取为中文记忆', () => {
  const cases = [
    { text: '我叫小明', expect: '主人叫小明。', category: '身份', matched: 'identity_name' },
    { text: '我的名字是小华', expect: '主人叫小华。', category: '身份', matched: 'identity_name' },
    { text: '我喜欢草莓蛋糕', expect: '主人喜欢草莓蛋糕。', category: '喜好', matched: 'like' },
    { text: '我很喜欢热可可', expect: '主人喜欢热可可。', category: '喜好', matched: 'like' },
    { text: '我最喜欢草莓大福', expect: '主人喜欢草莓大福。', category: '喜好', matched: 'like' },
    { text: '我超喜欢猫', expect: '主人喜欢猫。', category: '喜好', matched: 'like' },
    { text: '我不喜欢香菜', expect: '主人不喜欢香菜。', category: '喜好', matched: 'dislike' },
    { text: '我讨厌辣椒', expect: '主人不喜欢辣椒。', category: '喜好', matched: 'dislike' },
    { text: '记住，明天要考试', expect: '主人希望我记住：明天要考试。', category: '事件', matched: 'remember' },
    { text: '帮我记住答应每天早睡', expect: '主人希望我记住：答应每天早睡。', category: '承诺', matched: 'remember' },
    { text: '我的生日是5月1日', expect: '主人的生日是5月1日。', category: '身份', matched: 'profile' },
    { text: '我的宠物叫豆豆', expect: '主人的宠物是豆豆。', category: '人际', matched: 'profile' },
    { text: '我今天去公园散步了', expect: '主人今天去公园散步了。', category: '事件', matched: 'event' },
    { text: '我昨天看了电影', expect: '主人昨天看了电影。', category: '事件', matched: 'event' },
    { text: '我今天很难过', expect: '主人今天很难过。', category: '情绪', matched: 'emotion' },
  ]
  for (const item of cases) {
    const result = ingestOnce(item.text)
    assert.ok(result.created.length >= 1, `「${item.text}」应至少抽取 1 条记忆`)
    const match = result.created.find((created) => created.content === item.expect)
    assert.ok(match, `「${item.text}」应抽取为「${item.expect}」，实际：${result.created.map((c) => c.content).join(' | ')}`)
    assert.equal(match.category, item.category, `「${item.text}」分类应为 ${item.category}`)
    assert.match(match.content, /[\u4e00-\u9fff]/u)
    assert.ok(match.content.length >= 4 && match.content.length <= 120, '抽取内容长度应为 4~120 字符')
    assert.ok(match.keywords.length >= 3 && match.keywords.length <= 12)
  }
  // 规则函数本身也可直接调用（进一步确认 matched 标签）
  const raw = extractMemories('我叫小明，记住明天考试')
  assert.ok(raw.some((entry) => entry.matched === 'identity_name'))
  assert.ok(raw.some((entry) => entry.matched === 'remember'))
})

test('M5: 每条消息最多新增 3 条；重复内容改为提及而不新增', () => {
  const { engine } = newMemoryEngine()
  const longText = '我叫小红，我喜欢草莓蛋糕，我不喜欢香菜，记住明天要考试，我今天去了公园，我很难过。'
  const first = engine.ingestMessage({ text: longText, messageId: 'multi-1', role: 'user', at: localMs(2026, 11, 5, 20, 0) })
  assert.ok(first.created.length <= 3, `单条消息最多新增 3 条，实际 ${first.created.length}`)
  assert.ok(first.created.length >= 1)

  const totalBefore = engine.status().total
  const second = engine.ingestMessage({ text: longText, messageId: 'multi-2', role: 'user', at: localMs(2026, 11, 5, 20, 5) })
  assert.equal(second.created.length, 0, '重复内容不应新增记忆')
  assert.ok(second.mentioned.length >= 1, '重复内容应改为提及 +1')
  assert.equal(engine.status().total, totalBefore, '记忆总数不应因重复内容增加')
  for (const created of first.created) {
    const item = engine.getItem(created.id)
    assert.ok(item.mentionCount >= 2, `重复 ingest 后提及次数应 >=2（${item.content}）`)
  }
})

test('M5 修复复验（原 BUG-01）: 情绪自动抽取保留原文时间词（今天/昨天/最近），无时间词不补', () => {
  const cases = [
    { text: '我昨天很难过', expect: '主人昨天很难过。', timeWord: '昨天' },
    { text: '我最近有点焦虑', expect: '主人最近有点焦虑。', timeWord: '最近' },
    { text: '我今天很开心', expect: '主人今天很开心。', timeWord: '今天' },
    { text: '我很难过', expect: '主人很难过。', timeWord: null },
  ]
  for (const item of cases) {
    const { engine } = newMemoryEngine()
    const result = engine.ingestMessage({
      text: item.text,
      messageId: `emotion-fixed-${item.timeWord ?? 'none'}`,
      role: 'user',
      at: localMs(2026, 11, 5, 20, 0),
    })
    assert.ok(result.created.length >= 1, `「${item.text}」应抽取记忆`)
    assert.equal(result.created[0].content, item.expect, `「${item.text}」应保留原文时间词（原 BUG-01）`)
    if (item.timeWord) {
      assert.ok(result.created[0].keywords.includes(item.timeWord), `关键词应包含原文时间词「${item.timeWord}」`)
    } else {
      for (const extra of ['今天', '昨天', '刚才', '最近']) {
        assert.ok(!result.created[0].keywords.includes(extra), '原文没有时间词时不应补时间词')
      }
    }
  }
})

// ───────────────────────────── M6 短期记忆溢出 ─────────────────────────────

test('M6: 超过容量后最早的 floor(n/2) 条转入第一层，history 记录原因', () => {
  const { engine } = newMemoryEngine({ config: { shortTermCapacity: 5 } })
  const base = localMs(2026, 11, 5, 8, 0)
  const ids = []
  for (let index = 0; index < 6; index += 1) {
    const result = engine.remember({
      content: `第${index + 1}条独立记忆：主人喜欢编号${index + 1}的测试水果。`,
      keywords: [`编号${index + 1}`, `水果${index + 1}`, `话题${index + 1}`],
      at: base + index * 60000,
    })
    ids.push(result.item.id)
  }
  // 6 条 > 容量 5 → 移走 floor(6/2)=3 条最早的
  const shortItems = engine.listLayer('short')
  const layer1 = engine.listLayer(1)
  assert.equal(shortItems.length, 3)
  assert.equal(layer1.length, 3)
  assert.deepEqual(layer1.map((item) => item.id), ids.slice(0, 3), '应移动最早（firstSeenAt 升序）的 3 条')
  assert.deepEqual(shortItems.map((item) => item.id), ids.slice(3))
  for (const item of layer1) {
    assert.equal(item.layer, 1)
    assert.equal(item.history.length, 1)
    assert.equal(item.history[0].from, 'short')
    assert.equal(item.history[0].to, 1)
    assert.equal(item.history[0].reason, '短期记忆条数已满，最早的一半转入长期记忆第一层')
  }
  // 再追加到 9 条：第 7 条 4 条、第 8 条 5 条（不溢出）、第 9 条 6 条 → 再移 3 条
  for (let index = 6; index < 9; index += 1) {
    const result = engine.remember({
      content: `第${index + 1}条独立记忆：主人喜欢编号${index + 1}的测试水果。`,
      keywords: [`编号${index + 1}`, `水果${index + 1}`, `话题${index + 1}`],
      at: base + index * 60000,
    })
    ids.push(result.item.id)
  }
  assert.equal(engine.listLayer('short').length, 3)
  assert.equal(engine.listLayer(1).length, 6)
  assert.deepEqual(engine.listLayer('short').map((item) => item.id).sort(), ids.slice(6).sort())
})

test('DEV-01 修复复验: 自动抽取每新增一条后立即检查短期容量（SPEC 4.8 字面语义）', () => {
  // SPEC 4.8：每次新增记忆后检查 items.length > capacity，若是则取最早 floor(n/2) 条转入第一层。
  // 构造：容量 3、短期已满 3 条，一条消息自动抽取 3 条 → 按逐步检查的预期：
  //   新增 N1 → len 4 > 3，移走最早 2 条 → short [O3, N1]
  //   新增 N2 → len 3，不动
  //   新增 N3 → len 4 > 3，移走最早 2 条 [O3, N1] → short [N2, N3]，第一层 [O1, O2, O3, N1]
  const { engine } = newMemoryEngine({ config: { shortTermCapacity: 3 } })
  const base = localMs(2026, 11, 5, 20, 0)
  const oldIds = []
  for (let index = 1; index <= 3; index += 1) {
    const result = engine.remember({
      content: `旧记忆第${index}条。`,
      keywords: [`旧${index}`, '测试', '记忆'],
      at: base - (4 - index) * 60000,
    })
    oldIds.push(result.item.id)
  }
  assert.equal(engine.listLayer('short').length, 3)

  const result = engine.ingestMessage({
    text: '我叫小明，我喜欢草莓，我不喜欢香菜',
    messageId: 'dev01-overflow-1',
    role: 'user',
    at: base,
  })
  assert.equal(result.created.length, 3, '该消息应自动抽取 3 条记忆')
  const newContents = result.created.map((item) => item.content)
  assert.deepEqual(newContents, ['主人不喜欢香菜。', '主人喜欢草莓。', '主人叫小明。'])

  const shortItems = engine.listLayer('short')
  const layer1 = engine.listLayer(1)
  assert.equal(shortItems.length, 2, '逐步检查的预期：short 应剩 2 条（不是批量后检查的 3 条）')
  assert.equal(layer1.length, 4)
  assert.deepEqual(shortItems.map((item) => item.content), ['主人喜欢草莓。', '主人叫小明。'])
  assert.deepEqual(
    layer1.map((item) => item.id),
    [...oldIds, result.created[0].id],
    '第一层应为 [O1, O2, O3, N1]（N1 在新增时就触发溢出被移入）',
  )
  for (const item of layer1) {
    assert.equal(item.layer, 1)
    assert.equal(item.history.length, 1)
    assert.equal(item.history[0].reason, '短期记忆条数已满，最早的一半转入长期记忆第一层')
  }
  // 容量不变式
  assert.ok(engine.listLayer('short').length <= 3)
})

// ───────────────────────────── M7 每日夜间转移 ─────────────────────────────

test('M7: maintain 后短期记忆清空全部进入第一层，关键词/分类补齐，index/总览/meta 更新', () => {
  const dataDir = makeTempDir('dshpet-verify-m7-')
  const at = localMs(2026, 11, 6, 4, 30)
  seedMemoryData(dataDir, {
    short: [
      // 关键词只有 1 个、分类缺失，验证维护时补齐
      makeSeedItem({ id: 'mem-900001', content: '主人喜欢草莓蛋糕。', keywords: ['草莓'], category: '', layer: 'short', firstSeenAt: '2026-11-05T20:00:00+08:00', lastMentionedAt: '2026-11-05T20:00:00+08:00' }),
      makeSeedItem({ id: 'mem-900002', content: '主人养了一只叫豆豆的小猫。', keywords: ['豆豆', '猫', '宠物'], category: '人际', layer: 'short', firstSeenAt: '2026-11-05T21:00:00+08:00', lastMentionedAt: '2026-11-05T21:00:00+08:00' }),
    ],
  })
  const { engine } = newMemoryEngine({ dataDir, clock: makeClock(at) })
  const report = engine.maintain({ at })

  assert.equal(report.ok, true)
  assert.equal(report.transferred, 2)
  assert.equal(report.shortCount, 0)
  assert.equal(report.total, 2)
  assert.equal(engine.listLayer('short').length, 0)
  assert.equal(engine.listLayer(1).length, 2)
  assert.deepEqual(engine.status().counts.layers, [2, 0, 0, 0, 0, 0, 0])

  for (const item of engine.listLayer(1)) {
    assert.ok(item.keywords.length >= 3 && item.keywords.length <= 12, '转移时关键词应补齐到 3~5 个')
    assert.ok(item.category && item.category !== '', '分类应被补齐')
    assert.equal(item.layer, 1)
    assert.ok(item.history.some((entry) => entry.from === 'short' && entry.to === 1 && entry.reason === '每日夜间转移'))
    assert.equal(item.mentionCountAtLastMaintenance, item.mentionCount)
  }

  const meta = readJson(memoryPaths(dataDir).meta)
  assert.equal(meta.lastMaintenanceDateKey, '2026-11-06')
  assert.equal(meta.lastMaintenanceReason, '每日凌晨维护窗口')
  assert.equal(meta.maintenanceHistory.length, 1)
  assert.equal(meta.maintenanceHistory[0].transferred, 2)

  const index = readJson(memoryPaths(dataDir).index)
  assert.ok(Object.keys(index.keywords).length > 0, 'index.json 应生成关键词索引')
  assert.ok(Object.keys(index.categories).length > 0, 'index.json 应生成分类索引')
  assert.equal(index.layers[1], 2)
  assert.equal(index.layers.short, 0)

  const overview = readText(memoryPaths(dataDir).overview)
  assert.ok(overview.includes('主人喜欢草莓蛋糕'))
  assert.ok(overview.includes('### 第一层（2 条）'))
  assert.ok(overview.includes('| 编号 | 摘要 |'))
  assert.equal(report.indexKeywords, Object.keys(index.keywords).length)
})

// ───────────────────────────── M8 七层衰减阈值 ─────────────────────────────

test('M8: 1/3/7/14/30/140 天阈值逐一验证；恰好到期当天下沉；第 7 层不再下沉；每次最多一层', () => {
  const at = localMs(2026, 11, 10, 5, 0)
  const layers = {}
  const expected = {}
  for (let layer = 1; layer <= 6; layer += 1) {
    const threshold = DECAY_DAYS[layer - 1]
    const exactId = `mem-91${String(layer).padStart(4, '0')}`
    const earlyId = `mem-92${String(layer).padStart(4, '0')}`
    layers[layer] = [
      makeSeedItem({
        id: exactId,
        content: `第${layer}层恰好到期 ${threshold} 天的记忆。`,
        keywords: [`到期${layer}`, '阈值', '测试'],
        layer,
        lastMentionedAt: new Date(at - threshold * MS_DAY).toISOString(),
        firstSeenAt: new Date(at - (threshold + 50) * MS_DAY).toISOString(),
      }),
      makeSeedItem({
        id: earlyId,
        content: `第${layer}层未到期只差 1 小时的记忆。`,
        keywords: [`未到期${layer}`, '阈值', '测试'],
        layer,
        lastMentionedAt: new Date(at - (threshold * MS_DAY - 3600000)).toISOString(),
        firstSeenAt: new Date(at - (threshold + 50) * MS_DAY).toISOString(),
      }),
    ]
    expected[exactId] = layer + 1
    expected[earlyId] = layer
  }
  layers[7] = [
    makeSeedItem({
      id: 'mem-9300001',
      content: '第七层沉睡很久的记忆，不应继续下沉。',
      keywords: ['第七层', '不下沉', '测试'],
      layer: 7,
      lastMentionedAt: new Date(at - 999 * MS_DAY).toISOString(),
      firstSeenAt: new Date(at - 2000 * MS_DAY).toISOString(),
    }),
  ]
  expected['mem-9300001'] = 7

  const dataDir = makeTempDir('dshpet-verify-m8-')
  seedMemoryData(dataDir, { layers })
  const { engine } = newMemoryEngine({ dataDir, clock: makeClock(at) })
  const report = engine.maintain({ at })

  assert.equal(report.demoted, 6, '六个到期条目各下沉一层')
  assert.equal(report.promoted, 0)
  for (const [id, layer] of Object.entries(expected)) {
    const item = engine.getItem(id)
    assert.ok(item, `记忆应仍存在：${id}`)
    assert.equal(item.layer, layer, `${id} 应位于第 ${layer} 层（实际第 ${item.layer} 层）`)
    if (item.layer !== Number(id.slice(-1)) && id.startsWith('mem-91')) {
      assert.equal(item.history.length, 1, '一次维护最多移动一层')
      assert.match(item.history[0].reason, /^超过 \d+ 天未提及，下沉一层$/u)
    }
  }

  // 紧接第二次维护：已过一层后未到新阈值 → 不重复下沉
  const before = engine.listLayer(1).concat(engine.listLayer(2), engine.listLayer(3), engine.listLayer(4), engine.listLayer(5), engine.listLayer(6), engine.listLayer(7))
  const second = engine.maintain({ at })
  assert.equal(second.demoted, 0, '同一天重复维护不应再次移动')
  assert.equal(second.promoted, 0)
  const after = engine.listLayer(1).concat(engine.listLayer(2), engine.listLayer(3), engine.listLayer(4), engine.listLayer(5), engine.listLayer(6), engine.listLayer(7))
  assert.deepEqual(after.map((item) => `${item.id}:${item.layer}:${item.history.length}`).sort(), before.map((item) => `${item.id}:${item.layer}:${item.history.length}`).sort())
})

// ───────────────────────────── M9 提及频率增加上浮 ─────────────────────────────

test('M9: delta>=1 且 layer>1 上浮一层；提升优先于下沉；每次最多一层；转移条目不参与提升', () => {
  const at = localMs(2026, 11, 10, 5, 0)
  const daysAgo = (days) => new Date(at - days * MS_DAY).toISOString()
  const dataDir = makeTempDir('dshpet-verify-m9-')
  seedMemoryData(dataDir, {
    short: [makeSeedItem({ id: 'mem-700001', content: '刚从短期记忆转移的条目。', keywords: ['转移', '短期', '测试'], layer: 'short', mentionCount: 2, mentionCountAtLastMaintenance: 1 })],
    layers: {
      1: [makeSeedItem({ id: 'mem-700002', content: '第一层已提及但不能再上浮的条目。', keywords: ['第一层', '上浮', '测试'], layer: 1, mentionCount: 3, mentionCountAtLastMaintenance: 1, lastMentionedAt: daysAgo(5) })],
      2: [makeSeedItem({ id: 'mem-700003', content: '第二层本该下沉但提及增加应优先上浮。', keywords: ['第二层', '优先', '测试'], layer: 2, mentionCount: 2, mentionCountAtLastMaintenance: 1, lastMentionedAt: daysAgo(30) })],
      3: [makeSeedItem({ id: 'mem-700004', content: '第三层提及增加上浮。', keywords: ['第三层', '提升', '测试'], layer: 3, mentionCount: 3, mentionCountAtLastMaintenance: 1, lastMentionedAt: daysAgo(100) })],
      4: [makeSeedItem({ id: 'mem-700005', content: '第四层提及次数没变的条目。', keywords: ['第四层', '不变', '测试'], layer: 4, mentionCount: 2, mentionCountAtLastMaintenance: 2, lastMentionedAt: daysAgo(3) })],
      5: [makeSeedItem({ id: 'mem-700006', content: '第五层一次只上浮一层。', keywords: ['第五层', '一层', '测试'], layer: 5, mentionCount: 9, mentionCountAtLastMaintenance: 1, lastMentionedAt: daysAgo(1) })],
      7: [makeSeedItem({ id: 'mem-700007', content: '第七层近期提及但无变化。', keywords: ['第七层', '稳定', '测试'], layer: 7, mentionCount: 2, mentionCountAtLastMaintenance: 2, lastMentionedAt: daysAgo(1) })],
    },
  })
  const { engine } = newMemoryEngine({ dataDir, clock: makeClock(at) })
  const report = engine.maintain({ at })

  assert.equal(engine.getItem('mem-700003').layer, 1, '提升优先于下沉：第 2 层 → 第 1 层')
  assert.equal(engine.getItem('mem-700004').layer, 2, '第 3 层 → 第 2 层')
  assert.equal(engine.getItem('mem-700006').layer, 4, '第 5 层一次只上浮到第 4 层')
  assert.equal(engine.getItem('mem-700005').layer, 4, 'delta=0 且未到 14 天阈值 → 不动')
  assert.equal(engine.getItem('mem-700007').layer, 7)
  assert.equal(engine.getItem('mem-700001').layer, 1, '当天从短期转入的条目不参与上浮/下沉')
  // SPEC 字面：第 1 层无法上浮，属于“未提升”，按其自身阈值下沉（5 天 >= 1 天）
  assert.equal(engine.getItem('mem-700002').layer, 2)

  assert.equal(report.promoted, 3)
  assert.equal(report.demoted, 1)
  assert.equal(report.transferred, 1)
  const promotedHistory = engine.getItem('mem-700003').history
  assert.ok(promotedHistory.some((entry) => entry.from === 2 && entry.to === 1 && entry.reason === '提及频率增加，上浮一层'))
  for (const item of engine.listLayer(1).concat(engine.listLayer(2), engine.listLayer(3), engine.listLayer(4), engine.listLayer(5), engine.listLayer(6), engine.listLayer(7))) {
    assert.equal(item.mentionCountAtLastMaintenance, item.mentionCount, '维护后应更新维护基准')
  }
})

// ───────────────────────────── M10 分级检索 ─────────────────────────────

test('M10: 短期→L1..L7 顺序检索、达到 limit 提前停止、关键词/分类/正文命中、空 query 规则', () => {
  const at = localMs(2026, 11, 10, 5, 0)
  const dataDir = makeTempDir('dshpet-verify-m10-')
  seedMemoryData(dataDir, {
    short: [
      makeSeedItem({ id: 'mem-600001', content: '短期苹果记忆。', keywords: ['苹果', '甲甲', '乙乙'], layer: 'short', category: '其他', mentionCount: 1 }),
      makeSeedItem({ id: 'mem-600002', content: '短期高重要记忆。', keywords: ['高重要', '丙丙', '丁丁'], layer: 'short', category: '其他', mentionCount: 5 }),
      makeSeedItem({ id: 'mem-600003', content: '短期中重要记忆。', keywords: ['中重要', '戊戊', '己己'], layer: 'short', category: '其他', mentionCount: 2 }),
    ],
    layers: {
      1: [
        makeSeedItem({ id: 'mem-600010', content: '第一层苹果记忆。', keywords: ['苹果', '庚庚', '辛辛'], layer: 1, category: '其他' }),
        makeSeedItem({ id: 'mem-600011', content: '第一层香蕉记忆。', keywords: ['香蕉', '壬壬', '癸癸'], layer: 1, category: '其他' }),
        makeSeedItem({ id: 'mem-600012', content: '第一层分类喜好记忆。', keywords: ['丙丙丙', '丁丁丁', '戊戊戊'], layer: 1, category: '喜好' }),
      ],
      2: [makeSeedItem({ id: 'mem-600020', content: '第二层苹果记忆。', keywords: ['苹果', '子子', '丑丑'], layer: 2, category: '其他' })],
      3: [makeSeedItem({ id: 'mem-600030', content: '主人喜欢草莓蛋糕。', keywords: ['甲甲甲', '乙乙乙', '丙丙丙'], layer: 3, category: '其他' })],
      4: [makeSeedItem({ id: 'mem-600040', content: '纯粹内容不含查询词。', keywords: ['#特殊标签', '庚庚庚', '辛辛辛'], layer: 4, category: '其他' })],
      5: [
        makeSeedItem({ id: 'mem-600050', content: '同层权重第一。', keywords: ['苹果', '甲甲', '乙乙'], layer: 5, category: '其他', mentionCount: 1 }),
        makeSeedItem({ id: 'mem-600051', content: '同层权重第二。', keywords: ['甲甲', '苹果', '乙乙'], layer: 5, category: '其他', mentionCount: 1 }),
      ],
    },
  })
  const { engine } = newMemoryEngine({ dataDir, clock: makeClock(at) })

  // 顺序：短期 → 第一层 → 第二层 → 第五层（关键词命中逐层收集）
  const broad = engine.recall('苹果', { limit: 8 })
  assert.deepEqual(broad.hits.map((hit) => hit.layer), ['short', 1, 2, 5, 5])
  assert.deepEqual(broad.searchedLayers.slice(0, 3), ['short', 1, 2])
  assert.equal(broad.exhausted, true)

  // 达到 limit 提前停止（limit=1 → 只检索短期）
  const one = engine.recall('苹果', { limit: 1 })
  assert.equal(one.hits.length, 1)
  assert.equal(one.hits[0].layer, 'short')
  assert.equal(one.stoppedAt, 'short')
  assert.deepEqual(one.searchedLayers, ['short'])
  assert.equal(one.exhausted, false)

  // limit=2 → 检索到第一层即停止
  const two = engine.recall('苹果', { limit: 2 })
  assert.equal(two.hits.length, 2)
  assert.equal(two.stoppedAt, 1)
  assert.deepEqual(two.searchedLayers, ['short', 1])

  // 关键词命中第二层
  assert.ok(engine.recall('苹果', { limit: 20 }).hits.some((hit) => hit.item.id === 'mem-600020'))

  // 分类命中
  const byCategory = engine.recall('喜好', { limit: 8 })
  assert.ok(byCategory.hits.some((hit) => hit.item.id === 'mem-600012'), 'query 包含分类名应命中')

  // 第 3 层正文含 query，但关键词未命中：按新规则先 index 后全文，应跳过
  const byContent = engine.recall('草莓蛋糕', { limit: 8 })
  assert.ok(byContent.hits.some((hit) => hit.item.id === 'mem-600030'), '关键词未命中但 summary 命中时应读取正文并召回')

  // # 标签不参与匹配
  const byTag = engine.recall('#特殊标签', { limit: 20 })
  assert.ok(!byTag.hits.some((hit) => hit.item.id === 'mem-600040'), '# 标签不应参与检索匹配')

  // 同层内按评分降序（关键词权重按顺序递减：1 vs 0.8）
  const layer5 = engine.recall('苹果', { limit: 20 }).hits.filter((hit) => hit.layer === 5)
  assert.equal(layer5.length, 2)
  assert.equal(layer5[0].item.id, 'mem-600050')
  assert.ok(layer5[0].score > layer5[1].score)
  for (let index = 1; index < layer5.length; index += 1) assert.ok(layer5[index - 1].score >= layer5[index].score)

  // 空 query：仅短期记忆，按 importance 降序，前 limit 条
  const empty = engine.recall('', { limit: 2 })
  assert.deepEqual(empty.searchedLayers, ['short', 1], '空 query 应扫描短期+第一层，其余层跳过')
  assert.equal(empty.hits.length, 2)
  assert.deepEqual(empty.hits.map((hit) => hit.item.id), ['mem-600002', 'mem-600003'], '应按 importance 降序')

  // 返回 item 字段齐全
  const hitItem = broad.hits[0].item
  for (const field of ['content', 'summary', 'clarity', 'keywords', 'firstSeenAt', 'mentionCount', 'layer']) {
    assert.ok(Object.prototype.hasOwnProperty.call(hitItem, field), `检索结果 item 缺字段：${field}`)
  }
  assert.ok('score' in broad.hits[0] && 'layerLabel' in broad.hits[0])
})

// ───────────────────────────── M11 上下文紧张压缩 ─────────────────────────────

test('M11: 按重要度保留一半写入短期记忆，返回 kept/dropped/stored；随后触发溢出转移', () => {
  const { engine } = newMemoryEngine()
  const candidates = [
    { content: '候选十条重要度很低。', importance: 10 },
    { content: '候选九十重要度最高。', importance: 90 },
    { content: '候选二十重要度偏低。', importance: 20 },
    { content: '候选八十重要度次高。', importance: 80 },
    { content: '候选三十重要度中等。', importance: 30 },
  ]
  const result = engine.handleContextPressure(candidates, { keepRatio: 0.5, at: localMs(2026, 11, 5, 12, 0) })
  assert.equal(result.total, 5)
  assert.equal(result.kept, 3)
  assert.equal(result.dropped, 2)
  assert.equal(result.stored.length, 3)

  const shortContents = engine.listLayer('short').map((item) => item.content)
  assert.deepEqual(new Set(shortContents), new Set(['候选九十重要度最高。', '候选八十重要度次高。', '候选三十重要度中等。']))
  assert.ok(!shortContents.includes('候选十条重要度很低。'))
  for (const id of result.stored) {
    const item = engine.getItem(id)
    assert.ok(item, 'stored 中的 id 应能查到记忆')
    assert.equal(item.layer, 'short')
    assert.equal(item.source, 'context_pressure')
    assert.equal(item.category, '其他', '上下文压缩默认分类应为「其他」')
    assert.ok(item.keywords.length >= 3)
  }

  // keepRatio=0 → 至少保留 1 条
  const { engine: engine2 } = newMemoryEngine()
  const one = engine2.handleContextPressure([{ content: '保留至少一条甲。' }, { content: '保留至少一条乙。' }], { keepRatio: 0 })
  assert.equal(one.kept, 1)
  assert.equal(one.dropped, 1)

  // 写入后触发短期记忆溢出转移（容量 2，保留 6 条）
  const { engine: engine3 } = newMemoryEngine({ config: { shortTermCapacity: 2 } })
  const many = Array.from({ length: 6 }, (_, index) => ({ content: `压缩溢出候选第${index + 1}条。`, importance: 10 + index }))
  const overflow = engine3.handleContextPressure(many, { keepRatio: 1, at: localMs(2026, 11, 5, 12, 0) })
  assert.equal(overflow.kept, 6)
  assert.equal(engine3.listLayer('short').length, 2, '压缩写入后应按容量溢出转移')
  assert.equal(engine3.listLayer('1').length, 4)
  assert.equal(engine3.listLayer('short').length + engine3.listLayer(1).length, 6)
})

// ───────────────────────────── M12 维护调度 ─────────────────────────────

test('M12: 4–6 点窗口执行、6 点后补跑、当天已跑不重复、跨天再次触发', () => {
  const dataDir = makeTempDir('dshpet-verify-m12-')
  seedMemoryData(dataDir, { meta: { lastMaintenanceDateKey: '2026-11-04', lastMaintenanceAt: '2026-11-04T04:30:00+08:00' } })
  const clock = makeClock(localMs(2026, 11, 5, 3, 0))
  const { engine } = newMemoryEngine({ dataDir, clock })

  const check = (ms) => engine.checkMaintenance({ at: ms })

  assert.equal(check(localMs(2026, 11, 5, 3, 0)).shouldRun, false, '凌晨 3 点不在窗口且未到 6 点 → 不执行')
  assert.deepEqual(check(localMs(2026, 11, 5, 4, 0)), { shouldRun: true, reason: '每日凌晨维护窗口' })
  assert.deepEqual(check(localMs(2026, 11, 5, 4, 30)), { shouldRun: true, reason: '每日凌晨维护窗口' })
  assert.deepEqual(check(localMs(2026, 11, 5, 5, 59)), { shouldRun: true, reason: '每日凌晨维护窗口' })
  assert.deepEqual(check(localMs(2026, 11, 5, 6, 0)), { shouldRun: true, reason: '补跑（应用未在凌晨运行）' })
  assert.deepEqual(check(localMs(2026, 11, 5, 12, 0)), { shouldRun: true, reason: '补跑（应用未在凌晨运行）' })

  // 执行一次维护后当天不再触发
  const at = localMs(2026, 11, 5, 5, 0)
  clock.set(at)
  const report = engine.maintain({ at })
  assert.equal(report.transferred, 0)
  assert.equal(engine.checkMaintenance({ at: localMs(2026, 11, 5, 5, 30) }).shouldRun, false, '当天已维护 → 不重复')
  assert.equal(engine.checkMaintenance({ at: localMs(2026, 11, 5, 12, 0) }).shouldRun, false)

  // 跨天再次触发
  assert.deepEqual(engine.checkMaintenance({ at: localMs(2026, 11, 6, 4, 10) }), { shouldRun: true, reason: '每日凌晨维护窗口' })
  assert.deepEqual(engine.checkMaintenance({ at: localMs(2026, 11, 6, 8, 0) }), { shouldRun: true, reason: '补跑（应用未在凌晨运行）' })

  // 维护后 meta 落盘
  const meta = readJson(memoryPaths(dataDir).meta)
  assert.equal(meta.lastMaintenanceDateKey, '2026-11-05')
  assert.equal(meta.lastMaintenanceAt, report.at)
})

test('M12 边界: 首次运行（无维护记录）的调度行为（SPEC 未定义，实现扩展为 always-run）', () => {
  const { engine } = newMemoryEngine({ clock: makeClock(localMs(2026, 11, 5, 2, 0)) })
  const early = engine.checkMaintenance({ at: localMs(2026, 11, 5, 2, 0) })
  assert.equal(early.shouldRun, true, '实现选择：从未维护过时首次检查立即维护')
  assert.equal(early.reason, '首次运行初始化')
  const noon = engine.checkMaintenance({ at: localMs(2026, 11, 5, 12, 0) })
  assert.equal(noon.shouldRun, true)
  assert.equal(noon.reason, '首次运行初始化', '首次维护使用专属 reason（SPEC 只定义了两种 reason）')
})

// ───────────────────────────── M13 持久化与可读性 ─────────────────────────────

test('M13: 原子写（临时文件+rename、2 空格缩进、末尾换行）、events.jsonl、总览中文表格、重启完整', () => {
  const { engine, dataDir } = newMemoryEngine()
  const paths = memoryPaths(dataDir)
  const at = localMs(2026, 11, 5, 4, 30)
  const created = engine.remember({ content: '主人最喜欢草莓味蛋糕。', keywords: ['草莓蛋糕', '喜欢', '生日'], at: localMs(2026, 11, 5, 3, 0) })
  engine.remember({ content: '主人养了一只叫豆豆的小猫。', keywords: ['豆豆', '猫', '宠物'], at: localMs(2026, 11, 5, 3, 10) })
  engine.ingestMessage({ text: '草莓蛋糕真好吃', messageId: 'persist-1', role: 'user', at: localMs(2026, 11, 5, 3, 20) })
  engine.maintain({ at })

  // 文件存在
  for (const file of [paths.shortTerm, paths.meta, paths.index, paths.overview, paths.events]) {
    assert.ok(fs.existsSync(file), `应生成文件：${file}`)
  }
  for (let layer = 1; layer <= 7; layer += 1) assert.ok(fs.existsSync(paths.layer(layer)))

  // JSON 格式：2 空格缩进 + 末尾换行
  for (const file of [paths.shortTerm, paths.meta, paths.index, ...Array.from({ length: 7 }, (_, index) => paths.layer(index + 1))]) {
    const raw = readText(file)
    assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2) + '\n', `${file} 应为 2 空格缩进且末尾换行`)
    assert.ok(raw.includes('\n'), 'UTF-8 文本应含换行')
  }
  // 中文可读（UTF-8）
  assert.ok(readText(paths.layer(1)).includes('主人最喜欢草莓味蛋糕'))

  // 没有残留临时文件
  const leftovers = [
    ...fs.readdirSync(paths.memoryDir),
    ...fs.readdirSync(paths.longTermDir),
  ].filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '原子写不应残留临时文件')

  // events.jsonl 每行均为可解析的中文 JSON
  const eventLines = readText(paths.events).trim().split('\n').filter(Boolean)
  assert.ok(eventLines.length >= 3, '应记录创建/提及/维护事件')
  const types = new Set()
  for (const line of eventLines) {
    const event = JSON.parse(line)
    types.add(event.type)
    assert.ok(typeof event.message === 'string' && /[\u4e00-\u9fff]/u.test(event.message), '事件 message 应为中文')
  }
  assert.ok(types.has('memory_created'))
  assert.ok(types.has('maintenance'))
  assert.ok(types.has('layer_moved') || types.has('memories_mentioned'))

  // 记忆总览.md：中文表格 + 各层标题
  const overview = readText(paths.overview)
  assert.ok(overview.includes('# 记忆总览'))
  assert.ok(overview.includes('| 编号 | 摘要 | 分类 | 关键词 | 提及次数 | 强调 | 重要度 | 清晰度 | 生成时间 | 首次出现 | 最近提及 |'))
  assert.ok(overview.includes('### 第一层（2 条）'))
  assert.ok(overview.includes('## 关键词索引'))

  // 重启（新引擎实例）后数据完整
  const before = {
    status: engine.status(),
    item: engine.getItem(created.item.id),
  }
  resetMemoryEngineRegistry()
  const { engine: restarted } = newMemoryEngine({ dataDir, clock: makeClock(localMs(2026, 11, 5, 12, 0)) })
  assert.deepEqual(restarted.status().counts, before.status.counts)
  assert.equal(restarted.status().total, before.status.total)
  const reloaded = restarted.getItem(created.item.id)
  assert.equal(reloaded.content, before.item.content)
  assert.equal(reloaded.mentionCount, before.item.mentionCount)
  assert.deepEqual(reloaded.keywords, before.item.keywords)
  assert.equal(reloaded.layer, before.item.layer)

  // 编号续号不重复
  const newItem = restarted.remember({ content: '重启后新增的一条记忆。', keywords: ['重启', '编号', '测试'] })
  assert.notEqual(newItem.item.id, created.item.id)
  assert.ok(Number(newItem.item.id.replace('mem-', '')) > Number(created.item.id.replace('mem-', '')))
})

test('M13 边界: 维护历史与已处理 messageId 按上限裁剪（默认 30 / 200，可用 config 覆盖）', () => {
  const dataDir = makeTempDir('dshpet-verify-m13b-')
  seedMemoryData(dataDir, { meta: { lastMaintenanceDateKey: '2026-11-01', lastMaintenanceAt: '2026-11-01T04:30:00+08:00' } })
  const clock = makeClock(localMs(2026, 11, 2, 4, 30))
  const { engine } = newMemoryEngine({
    dataDir,
    clock,
    config: { maintenanceHistoryLimit: 3, processedMessageIdLimit: 4 },
  })
  for (let day = 2; day <= 7; day += 1) {
    const at = localMs(2026, 11, day, 4, 30)
    clock.set(at)
    engine.maintain({ at })
  }
  const meta = readJson(memoryPaths(dataDir).meta)
  assert.equal(meta.maintenanceHistory.length, 3, '维护历史只保留最近 N 次')
  for (let index = 0; index < 6; index += 1) {
    engine.ingestMessage({ text: `测试消息编号${index}，含关键词甲甲甲。`, messageId: `trim-msg-${index}`, role: 'user', at: localMs(2026, 11, 8, 10, index) })
  }
  const metaAfter = readJson(memoryPaths(dataDir).meta)
  assert.equal(metaAfter.processedMessageIds.length, 4, '已处理 messageId 只保留最近 N 个')
  assert.deepEqual(metaAfter.processedMessageIds, ['trim-msg-2', 'trim-msg-3', 'trim-msg-4', 'trim-msg-5'])
  // 默认配置值符合 SPEC
  assert.equal(DEFAULT_MEMORY_CONFIG.maintenanceHistoryLimit, 30)
  assert.equal(DEFAULT_MEMORY_CONFIG.processedMessageIdLimit, 200)
  assert.deepEqual(DECAY_DAYS, [1, 3, 7, 14, 30, 140])
})

// ───────────────────────────── M14 摘要注入 ─────────────────────────────

test('M14: renderDigest 含四大段落、层级标注、空库提示、长度不超过 maxChars', () => {
  // 空记忆库
  const { engine: emptyEngine } = newMemoryEngine()
  const emptyDigest = emptyEngine.renderDigest({ latestUserText: '' })
  assert.ok(emptyDigest.includes('（记忆库还是空的，这是你们的第一次对话。）'))
  assert.ok(emptyDigest.includes('【检索提示】'))

  // 有记忆的库
  const at = localMs(2026, 11, 10, 5, 0)
  const dataDir = makeTempDir('dshpet-verify-m14-')
  seedMemoryData(dataDir, {
    short: [
      makeSeedItem({ id: 'mem-500001', content: '短期高重要记忆。', keywords: ['高重要', '甲甲', '乙乙'], layer: 'short', mentionCount: 6 }),
      makeSeedItem({ id: 'mem-500002', content: '短期低重要记忆。', keywords: ['低重要', '丙丙', '丁丁'], layer: 'short', mentionCount: 1 }),
    ],
    layers: {
      1: [makeSeedItem({ id: 'mem-500010', content: '第一层草莓蛋糕记忆。', keywords: ['草莓蛋糕', '喜欢', '生日'], layer: 1, category: '喜好' })],
    },
  })
  const { engine } = newMemoryEngine({ dataDir, clock: makeClock(at) })
  const digest = engine.renderDigest({ latestUserText: '草莓蛋糕', at })
  assert.ok(digest.includes('【记忆系统 · 自动注入】'))
  assert.ok(digest.includes('【最近短期记忆】'))
  assert.ok(!digest.includes('【长期记忆命中】'), '长期关键词命中项应先挪回短期')
  assert.ok(digest.includes('草莓蛋糕'), '命中项应出现在短期记忆里')
  assert.ok(digest.includes('【长期记忆概况】'))
  assert.ok(digest.includes('【检索提示】'))
  assert.ok(digest.includes('memory_recall'))
  assert.ok(digest.includes('memory_note'))
  assert.ok(digest.includes('不要编造'), '应含「不要编造」约束')
  // 短期按 importance 降序
  assert.ok(digest.indexOf('短期高重要记忆') < digest.indexOf('短期低重要记忆'))
  assert.ok(digest.length <= 1600)

  // maxChars 上限（含极小值 60 / 300）
  for (const maxChars of [1600, 600, 300, 120, 60]) {
    const text = engine.renderDigest({ latestUserText: '草莓蛋糕', at, maxChars })
    assert.ok(text.length <= maxChars, `maxChars=${maxChars} 时实际长度 ${text.length}`)
    assert.ok(text.includes('【记忆系统 · 自动注入】'), `maxChars=${maxChars} 时应保留标题`)
  }
  // 空库时极小 maxChars 也不越界
  const tinyEmpty = emptyEngine.renderDigest({ latestUserText: '', maxChars: 60 })
  assert.ok(tinyEmpty.length <= 60)
  assert.ok(tinyEmpty.length > 0)

  // 纯渲染函数的空库判定
  const pureEmpty = renderDigestText({ shortItems: [], longHits: [], layerCounts: [0, 0, 0, 0, 0, 0, 0], maxChars: 1600 })
  assert.ok(pureEmpty.includes('（记忆库还是空的，这是你们的第一次对话。）'))
  // 只有长期记忆时不应误判为空库
  const longOnly = renderDigestText({
    shortItems: [],
    longHits: [{ item: { content: '很久以前的事。', summary: '很久以前的事。', keywords: ['很久'], firstSeenAt: '2026-01-01T00:00:00+08:00', mentionCount: 1, clarity: 0.3 }, layer: 3, layerLabel: '第三层' }],
    layerCounts: [0, 0, 1, 0, 0, 0, 0],
    maxChars: 1600,
  })
  assert.ok(!longOnly.includes('这是你们的第一次对话'))
})

// ───────────────────────────── M8/M9 补充：维护顺序与转移条目 ─────────────────────────────

test('维护顺序: 夜间转移→上浮→下沉；刚转移条目不被同日下沉；提升优先于下沉', () => {
  const at = localMs(2026, 11, 10, 5, 0)
  const dataDir = makeTempDir('dshpet-verify-order-')
  seedMemoryData(dataDir, {
    // 短期记忆里放一条 10 天前提到的老记忆，验证夜间转移后当天不立刻下沉
    short: [makeSeedItem({ id: 'mem-800001', content: '短期里已经放了很久的记忆。', keywords: ['很久', '短期', '测试'], layer: 'short', mentionCount: 1, lastMentionedAt: new Date(at - 10 * MS_DAY).toISOString() })],
    layers: {
      2: [makeSeedItem({ id: 'mem-800002', content: '第二层提及增加优先上浮。', keywords: ['优先', '上浮', '测试'], layer: 2, mentionCount: 3, mentionCountAtLastMaintenance: 1, lastMentionedAt: new Date(at - 100 * MS_DAY).toISOString() })],
    },
  })
  const { engine } = newMemoryEngine({ dataDir, clock: makeClock(at) })
  const report = engine.maintain({ at })
  assert.equal(report.transferred, 1)
  assert.equal(report.promoted, 1)
  assert.equal(report.demoted, 0)
  assert.equal(engine.getItem('mem-800001').layer, 1, '刚转入的条目当天不应下沉')
  assert.equal(engine.getItem('mem-800001').history[0].reason, '每日夜间转移')
  assert.equal(engine.getItem('mem-800002').layer, 1)
})

// ───────────────────────────── 文本规则补充（M1/M3/M5 相关） ─────────────────────────────

test('文本规则: 摘要按第一个分句截断、分类规则优先级、抽取内容去重与长度限制', () => {
  assert.equal(buildSummary('短内容'), '短内容', '≤30 字符直接使用')
  const longContent = '第一句。' + '第二句内容'.repeat(12) + '。'
  assert.equal(buildSummary(longContent), '第一句', '>30 字符时取第一个分句')
  const exactly30 = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十。后面还有'
  assert.equal(buildSummary(exactly30), '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'.slice(0, 30))
  assert.equal(buildSummary(exactly30).length, 30)

  assert.equal(classifyCategory('我最喜欢草莓蛋糕'), '喜好')
  assert.equal(classifyCategory('我的名字是小明'), '身份')
  assert.equal(classifyCategory('我今天很难过'), '情绪')
  assert.equal(classifyCategory('我答应你明天一定来'), '承诺')
  assert.equal(classifyCategory('我打算明天去图书馆'), '计划')
  assert.equal(classifyCategory('我今天去了公园'), '事件')
  assert.equal(classifyCategory('随便写点什么'), '其他')

  // 超长「记住」内容截断到 120 字符以内
  const longText = '记住' + '很长的内容'.repeat(40)
  const extracted = extractMemories(longText)
  assert.ok(extracted.length >= 1)
  assert.ok(extracted[0].content.length <= 120)
  // 抽取结果按内容去重
  const dup = extractMemories('我喜欢草莓蛋糕，我喜欢草莓蛋糕')
  const normalized = dup.map((entry) => entry.content)
  assert.equal(new Set(normalized).size, normalized.length)
})

// ───────────────────────────── 空记忆库边界 ─────────────────────────────

test('空记忆库: status/recall/digest/listLayer 均正常且为中文提示', () => {
  const { engine } = newMemoryEngine()
  const status = engine.status()
  assert.equal(status.total, 0)
  assert.deepEqual(status.counts, { short: 0, layers: [0, 0, 0, 0, 0, 0, 0] })
  assert.equal(engine.recall('任意查询').hits.length, 0)
  assert.deepEqual(engine.recall('任意查询').searchedLayers, ['short', 1, 2, 3, 4, 5, 6, 7])
  assert.equal(engine.listLayer(7).length, 0)
  assert.equal(engine.getItem('mem-999999'), undefined)
  const digest = engine.renderDigest({ latestUserText: '随便说点什么' })
  assert.match(digest, /[\u4e00-\u9fff]/u)
  assert.ok(engine.writeOverview().endsWith('记忆总览.md'))
  assert.ok(fs.existsSync(engine.writeOverview()))
})
