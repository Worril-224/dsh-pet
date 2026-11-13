/**
 * 记忆渲染：按清晰度渲染条目（SPEC 4.2）、生成「记忆总览.md」（4.11）、生成注入用记忆摘要（4.13）。
 */
import { layerLabel } from '../shared/paths.js'

/** 按字符数硬裁剪（保证 ≤ maxChars）。 */
export function clampToMaxChars(text, maxChars) {
  const max = Math.max(0, Math.floor(Number(maxChars) || 0))
  if (max === 0) return ''
  return text.length <= max ? text : text.slice(0, max)
}

/** Markdown 表格单元格转义。 */
export function escapeMarkdownCell(value) {
  return String(value ?? '')
    .replace(/\|/gu, '｜')
    .replace(/\r?\n/gu, ' ')
    .trim()
}

/** 条目是否带有事件发生时间（功能3：人设个人经历按时间导入）。 */
function hasOccurredAt(item) {
  return typeof item?.occurredAt === 'string' && item.occurredAt.trim() !== ''
}

/** 渲染事件发生时间片段（无 occurredAt 时返回空串，保证老数据输出完全不变）。 */
function occurredAtFragment(item) {
  return hasOccurredAt(item) ? `；发生：${item.occurredAt.trim()}` : ''
}

/**
 * 按清晰度渲染一条记忆（SPEC 4.2）：
 * - clarity >= 0.7：完整 content + 关键词 + 首次时间 + 提及次数（若有 occurredAt，附「发生时间」）；
 * - 0.4 <= clarity < 0.7：summary + 首个关键词 + 提及次数（若有 occurredAt，附「发生时间」）；
 * - clarity < 0.4：summary 前 12 个字符 + …（记忆有些模糊）。
 * @param {object} item 记忆条目
 * @param {{ layerLabel?: string }} [options] 传入层名时在行首标注层级（长期记忆命中用）
 */
export function renderItemByClarity(item, options = {}) {
  const clarity = Number(item.clarity) || 0
  const keywords = Array.isArray(item.keywords) ? item.keywords : []
  const firstKeyword = keywords.length > 0 ? keywords[0] : '无'
  const occurred = occurredAtFragment(item)
  const created = typeof item.createdAt === 'string' && item.createdAt.trim() ? `；生成：${item.createdAt.trim()}` : ''
  let body
  if (clarity >= 0.7) {
    body = `${item.content}（关键词：${keywords.join('、')}${created}；首次：${item.firstSeenAt}${occurred}；提及 ${item.mentionCount} 次）`
  } else if (clarity >= 0.4) {
    body = `${item.summary}（关键词：${firstKeyword}${created}${occurred}；提及 ${item.mentionCount} 次）`
  } else {
    const summary = String(item.summary || item.content || '')
    body = `${summary.slice(0, 12)}…（记忆有些模糊）`
  }
  const label = options.layerLabel ? `【${options.layerLabel}】` : ''
  return `- ${label}${body}`
}

/**
 * 生成「记忆总览.md」：中文表格，短期记忆 + 七层长期记忆 + 关键词索引。
 */
export function buildOverviewMarkdown({ shortItems = [], layers = [], meta = {}, updatedAt = '' }) {
  const totalLong = layers.reduce((sum, items) => sum + items.length, 0)
  const total = shortItems.length + totalLong
  const lines = []
  lines.push('# 记忆总览', '')
  lines.push(
    `> 自动生成于 ${updatedAt}，共 ${total} 条记忆（短期记忆 ${shortItems.length} 条，长期记忆 ${totalLong} 条）。`,
  )
  if (meta && meta.lastMaintenanceAt) {
    const reason = meta.lastMaintenanceReason ? `（${meta.lastMaintenanceReason}）` : ''
    lines.push(`> 最近一次维护：${meta.lastMaintenanceAt}${reason}。`)
  }
  lines.push('> 本文件由记忆引擎自动生成，请勿手工修改；原始 JSON 数据位于 memory 目录下。', '')

  const renderTable = (items) => {
    if (items.length === 0) return ['（本层暂无记忆）']
    // 功能3：只有该层存在带 occurredAt 的条目时才追加「发生时间」列，老数据输出保持原样。
    const showOccurredAt = items.some(hasOccurredAt)
    const rows = [
      showOccurredAt
        ? '| 编号 | 摘要 | 分类 | 关键词 | 提及次数 | 强调 | 重要度 | 清晰度 | 生成时间 | 首次出现 | 最近提及 | 发生时间 |'
        : '| 编号 | 摘要 | 分类 | 关键词 | 提及次数 | 强调 | 重要度 | 清晰度 | 生成时间 | 首次出现 | 最近提及 |',
      showOccurredAt
        ? '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
        : '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ]
    for (const item of items) {
      const occurredCell = showOccurredAt ? ` ${escapeMarkdownCell(hasOccurredAt(item) ? item.occurredAt : '')} |` : ''
      rows.push(
        `| ${escapeMarkdownCell(item.id)} | ${escapeMarkdownCell(item.summary)} | ${escapeMarkdownCell(item.category)} | ` +
          `${escapeMarkdownCell((item.keywords || []).join('、'))} | ${item.mentionCount} | ${item.emphasis} | ` +
          `${item.importance} | ${item.clarity} | ${escapeMarkdownCell(item.createdAt || '')} | ${escapeMarkdownCell(item.firstSeenAt)} | ${escapeMarkdownCell(item.lastMentionedAt)} |` +
          occurredCell,
      )
    }
    return rows
  }

  lines.push('## 短期记忆', '')
  lines.push(...renderTable(shortItems), '')
  lines.push('## 长期记忆', '')
  layers.forEach((items, index) => {
    lines.push(`### ${layerLabel(index + 1)}（${items.length} 条）`, '')
    lines.push(...renderTable(items), '')
  })

  const keywordCounts = new Map()
  const allItems = [...shortItems, ...layers.flat()]
  for (const item of allItems) {
    for (const keyword of item.keywords || []) {
      if (typeof keyword !== 'string' || !keyword || keyword.startsWith('#')) continue
      keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1)
    }
  }
  if (keywordCounts.size > 0) {
    lines.push('## 关键词索引', '')
    lines.push('| 关键词 | 出现记忆数 |', '| --- | --- |')
    // 次数降序；同次数按码位排序，保证总览输出跨平台一致（不用 localeCompare）。
    const ordered = [...keywordCounts.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )
    for (const [keyword, count] of ordered) {
      lines.push(`| ${escapeMarkdownCell(keyword)} | ${count} |`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/**
 * 生成注入 system prompt 的「记忆上下文」（SPEC 4.13）。
 * 总长度严格不超过 maxChars：超长时优先裁剪条目，保留首尾说明。
 */
export function renderDigestText({
  shortItems = [],
  longHits = [],
  layerCounts = [],
  maxChars = 1600,
  digestShortLimit = 8,
  digestLongLimit = 4,
}) {
  const max = Math.max(0, Math.floor(Number(maxChars) || 0))
  const shorts = shortItems.slice(0, digestShortLimit)
  const longs = longHits.slice(0, digestLongLimit)
  const totalLong = layerCounts.reduce((sum, count) => sum + count, 0)

  if (shorts.length === 0 && longs.length === 0 && totalLong === 0) {
    const emptyText = [
      '【记忆系统 · 自动注入】',
      '（记忆库还是空的，这是你们的第一次对话。）',
      '',
      '【检索提示】',
      '学到新事实时调用 memory_note；需要回忆更久远的记忆时调用 memory_recall。',
    ].join('\n')
    return clampToMaxChars(emptyText, max)
  }

  const build = (shortCount, longCount, compact) => {
    const lines = []
    lines.push('【记忆系统 · 自动注入】')
    if (compact) {
      lines.push('请自然使用以下记忆：不要逐条复述，不要编造记忆里没有的事，记不清就说记不清。')
    } else {
      lines.push('以下是你与主人过往记忆的摘要，请在对话中自然使用：')
      lines.push('- 自然融入对话，不要逐条复述；')
      lines.push('- 不要编造记忆里没有的事；')
      lines.push('- 记不清时就说记不清。')
    }
    const visibleShorts = shorts.slice(0, shortCount)
    if (visibleShorts.length > 0) {
      lines.push('', '【最近短期记忆】')
      for (const item of visibleShorts) lines.push(renderItemByClarity(item))
    }
    const visibleLongs = longs.slice(0, longCount)
    if (visibleLongs.length > 0) {
      lines.push('', '【长期记忆命中】')
      for (const hit of visibleLongs) {
        lines.push(renderItemByClarity(hit.item, { layerLabel: hit.layerLabel }))
      }
    }
    lines.push('', '【长期记忆概况】')
    const overviewParts = layerCounts.map((count, index) => `${layerLabel(index + 1)}：${count} 条`)
    lines.push(`${overviewParts.join('；')}；短期记忆：${shorts.length} 条`)
    lines.push('', '【检索提示】')
    lines.push('需要更久远的记忆时调用 memory_recall；学到新事实时调用 memory_note。')
    return lines.join('\n')
  }

  let shortCount = shorts.length
  let longCount = longs.length
  let text = build(shortCount, longCount, false)
  while (text.length > max && (shortCount > 0 || longCount > 0)) {
    if (shortCount > 0) shortCount -= 1
    else longCount -= 1
    text = build(shortCount, longCount, false)
  }
  if (text.length > max) text = build(0, 0, true)
  return clampToMaxChars(text, max)
}
