/** 生图模块：结构化 LLM JSON 调用（不经过回复清洗，避免 JSON 被截断/改形）。 */
export function createJsonCompleter({ llm, modelSelection, logger, maxTokens = 3200 } = {}) {
  function resolveRoute() {
    try {
      const selected = typeof modelSelection === 'function' ? modelSelection() : undefined
      if (selected && typeof selected.provider === 'string' && typeof selected.model === 'string') return selected
    } catch {
      // ignore
    }
    return undefined
  }

  async function complete({ system, user, timeoutMs = 120000 } = {}) {
    if (!llm || typeof llm.prepareCall !== 'function') throw new Error('没有可用的 llm 服务')
    const route = resolveRoute()
    if (!route) throw new Error('没有可用的模型路由')
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    const call = await llm.prepareCall({ ...route, maxTokens }, signal)
    const stream = call.stream({
      ...(call.config ?? route),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      purpose: 'image-generation',
      signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(`生图模型调用失败：${chunk.reason?.failure?.message ?? '未知错误'}`)
      }
    }
    const raw = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('生图模型没有返回 JSON')
    return JSON.parse(raw.slice(start, end + 1))
  }

  return { complete }
}
