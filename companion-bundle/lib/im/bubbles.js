/**
 * QQ 气泡拆分：把模型输出按换行/段落拆成多条消息，一条一段（一个气泡）。
 * 需求：QQ 生成文段时不要忽略换行，每一段单开一个气泡。
 */

/**
 * 把长文本按句末标点拆成不超过 maxChars 的片段（保持顺序）。
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitLongSegment(text, maxChars) {
  const value = text.trim()
  if (!value) return []
  if (value.length <= maxChars) return [value]
  const pieces = []
  let rest = value
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const boundaries = ['。', '！', '？', '；', '，', '、', ' ']
    let cut = -1
    for (const punctuation of boundaries) {
      cut = Math.max(cut, window.lastIndexOf(punctuation))
    }
    if (cut < maxChars * 0.4) cut = maxChars - 1
    pieces.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) pieces.push(rest)
  return pieces.filter(Boolean)
}

/**
 * 把回复文本拆成气泡数组。
 * - 以换行（含空行）为段落边界；
 * - 丢掉空段；
 * - 对超长段落按句末标点再拆；
 * - 限制气泡数量，多出的段落合并进最后一个气泡（用空格连接）。
 *
 * @param {string} text 模型输出（已做链接清洗）
 * @param {{ maxBubbles?: number, maxCharsPerBubble?: number }} [options]
 * @returns {string[]} 至少一项；全空时返回 []
 */
export function splitBubbles(text, options = {}) {
  const maxBubbles = Number.isFinite(options.maxBubbles) ? Math.max(1, Math.round(options.maxBubbles)) : 8
  const maxCharsPerBubble = Number.isFinite(options.maxCharsPerBubble)
    ? Math.max(50, Math.round(options.maxCharsPerBubble))
    : 400
  const raw = String(text ?? '')
    .replace(/\r/g, '')
    .trim()
  if (!raw) return []
  const paragraphs = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const bubbles = []
  for (const paragraph of paragraphs) {
    bubbles.push(...splitLongSegment(paragraph, maxCharsPerBubble))
  }
  if (bubbles.length <= maxBubbles) return bubbles
  const head = bubbles.slice(0, maxBubbles - 1)
  const tail = bubbles.slice(maxBubbles - 1).join(' ')
  return [...head, tail]
}
