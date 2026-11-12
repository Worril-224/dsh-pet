/**
 * 陪伴工具定义：persona_lookup / memory_recall / memory_note / memory_status / persona_status。
 *
 * 这些工具使用 Harness 的 ToolDefinition 普通对象结构（不依赖 @deepseek-ai/dsh-tools），
 * 在 preset 作用域注册后只对「情感陪伴」预设的会话可见。
 */
import { layerLabel } from '../shared/paths.js'

const TEXT = (text) => [{ type: 'text', text }]

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeKeywords(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function layerOf(item) {
  return item && item.layer !== undefined ? item.layer : '?'
}

function renderItemLine(item, index) {
  const label = layerLabel(layerOf(item))
  const keywords = Array.isArray(item.keywords) ? item.keywords.join('、') : ''
  return (
    `${index + 1}. 【${label}】${item.content ?? item.summary ?? ''}\n` +
    `   关键词：${keywords || '（无）'}｜提及 ${item.mentionCount ?? 0} 次｜重要度 ${item.importance ?? '?'}｜清晰度 ${item.clarity ?? '?'}`
  )
}

/**
 * 创建陪伴工具数组。
 * @param {{ persona: any, memory: any }} deps
 * @returns {Array<object>} ToolDefinition 数组
 */
export function createCompanionTools({ persona, memory, analyzer }) {
  const personaLookup = {
    name: 'persona_lookup',
    description:
      '读取当前角色人设中「被问到才用」的模块正文（她自己、外貌、其他 AI 角色、身份设定、个人经历）。当主人问起这些话题时，必须先调用本工具再回答；未查到的内容要诚实说记不清，绝对不要编造。',
    parameters: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          description: '模块 id 或中文名：herself / 她自己、appearance / 外貌、other_ai_characters / 其他 AI 角色、identity / 身份设定、personal_history / 个人经历（也接受 always 模块）。',
        },
      },
      required: ['module'],
      additionalProperties: false,
    },
    output: {
      schema: { description: '人设模块查询结果' },
      render(args, value) {
        if (!value || value.ok !== true) {
          const available = value && Array.isArray(value.available) ? value.available.join('、') : ''
          return TEXT(`没有找到这个模块${value && value.error ? `：${value.error}` : ''}。可用模块：${available || '（人设文件可能未加载）'}`)
        }
        const activation = value.module.activation === 'always' ? '始终生效' : '被问到才用'
        return TEXT(`【${value.module.label}】（${activation}）\n${value.content}`)
      },
    },
    async execute(args) {
      const key = typeof args?.module === 'string' ? args.module.trim() : ''
      if (!key) return { ok: false, error: '缺少 module 参数' }
      const result = persona.lookup(key)
      if (!result || result.ok !== true) {
        return {
          ok: false,
          error: result?.error ?? '未找到',
          available: persona.moduleList().map((m) => `${m.id}（${m.label}）`),
        }
      }
      return { ok: true, module: { id: result.id, label: result.label, activation: result.activation }, content: result.content }
    },
  }

  const memoryRecall = {
    name: 'memory_recall',
    description:
      '在记忆库中检索与某个话题有关的记忆。短期记忆与长期第一层会全部扫描；第二层到第七层先用关键词/分类匹配，命中后才读全文，未命中跳过。当你不确定某件事、主人问起过去的事、或需要回忆约定与细节时，调用本工具；不要凭感觉编造。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的中文关键词或话题，例如「草莓蛋糕」「主人最近的工作」' },
        limit: { type: 'integer', description: '最多返回几条记忆，默认 10，范围 1~50' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { description: '记忆检索结果' },
      render(args, value) {
        if (!value || value.ok !== true) return TEXT(`记忆检索失败：${value?.error ?? '未知错误'}`)
        if (!value.hits || value.hits.length === 0) {
          return TEXT(`没有找到与「${value.query}」相关的记忆。候选层：${(value.searchedLayers || []).map(layerLabel).join(' → ')}`)
        }
        const lines = value.hits.map((hit, index) => renderItemLine(hit.item ?? hit, index))
        const path = (value.searchedLayers || []).map(layerLabel).join(' → ')
        return TEXT(
          `【记忆检索】${value.query}\n检索路径：${path}${value.stoppedAt != null ? `（在${layerLabel(value.stoppedAt)}停止，已足够）` : '（已检索全部层级）'}\n\n` +
            lines.join('\n'),
        )
      },
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (!query) return { ok: false, error: '缺少 query 参数' }
      const limit = clampInt(args?.limit, 1, 50, 10)
      const result = memory.recall(query, { limit })
      return {
        ok: true,
        query,
        hits: (result.hits || []).map((hit) => ({
          layer: hit.layer,
          score: hit.score,
          item: {
            id: hit.item.id,
            content: hit.item.content,
            summary: hit.item.summary,
            keywords: hit.item.keywords,
            category: hit.item.category,
            mentionCount: hit.item.mentionCount,
            importance: hit.item.importance,
            clarity: hit.item.clarity,
            firstSeenAt: hit.item.firstSeenAt,
            layer: hit.item.layer,
          },
        })),
        searchedLayers: result.searchedLayers || [],
        stoppedAt: result.stoppedAt ?? null,
        exhausted: result.exhausted ?? false,
      }
    },
  }

  const memoryNote = {
    name: 'memory_note',
    description:
      '把刚刚聊天中值得长期记住的事实、情绪或约定写进记忆库。内容用中文总结成一句话；关键词交给 LLM 整理（谁/时间/地点/动作，最多 12 个）。当主人透露喜好、身份信息、重要经历、情绪转折或约定时使用。不要记录寒暄和水话。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '用中文写成的一句话记忆，例如「主人最喜欢草莓味蛋糕，生日时也会吃这个。」' },
        keywords: {
          type: 'array',
          description: '由 LLM 整理的关键词（谁/时间/地点/动作，最多 12 个）；显式给出时作为补充',
          items: { type: 'string' },
        },
        category: {
          type: 'string',
          description: '分类',
          enum: ['喜好', '身份', '人际', '事件', '情绪', '承诺', '计划', '健康', '工作学习', '其他'],
        },
        emphasis: { type: 'integer', description: '主人对这件事的强调程度 0~3，默认 0' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: { description: '记忆写入结果' },
      render(args, value) {
        if (!value || value.ok !== true) return TEXT(`记忆写入失败：${value?.error ?? '未知错误'}`)
        const item = value.item
        const action = value.action === 'updated' ? '这条记忆之前记过，已增加提及次数' : '已写入记忆'
        return TEXT(
          `${action}：${item.content}\n` +
            `关键词：${item.keywords.join('、')}｜分类：${item.category}｜层级：${layerLabel(item.layer)}｜提及 ${item.mentionCount} 次｜id：${item.id}`,
        )
      },
    },
    async execute(args) {
      const content = typeof args?.content === 'string' ? args.content.trim() : ''
      if (!content) return { ok: false, error: '缺少 content 参数' }
      let analysis
      if (analyzer && typeof analyzer.analyze === 'function') {
        try {
          analysis = await analyzer.analyze({ content, kindHint: 'auto', source: 'tool:memory_note' })
        } catch {
          analysis = undefined
        }
      }
      const keywords = normalizeKeywords([...(args?.keywords ?? []), ...(analysis?.keywords ?? [])])
      const category =
        typeof args?.category === 'string' && args.category.trim()
          ? args.category.trim()
          : analysis?.category
      const emphasis = clampInt(args?.emphasis, 0, 3, 0)
      const result = memory.remember({
        content,
        keywords,
        category,
        emphasis,
        summary: analysis?.summary,
        importance: analysis?.importance,
        source: 'tool:memory_note',
        metadata: analysis ? { ...analysis, llm: true } : undefined,
      })
      return {
        ok: true,
        action: result.action,
        item: {
          id: result.item.id,
          content: result.item.content,
          summary: result.item.summary,
          keywords: result.item.keywords,
          category: result.item.category,
          layer: result.item.layer,
          mentionCount: result.item.mentionCount,
          importance: result.item.importance,
          clarity: result.item.clarity,
          firstSeenAt: result.item.firstSeenAt,
        },
      }
    },
  }

  const memoryStatus = {
    name: 'memory_status',
    description: '查看记忆库概况：短期/各长期层的记忆条数、最近一次维护时间、数据目录。主人问起「你记得多少」「记忆怎么样」时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { description: '记忆库状态' },
      render(args, value) {
        if (!value || value.ok !== true) return TEXT(`无法读取记忆状态：${value?.error ?? '未知错误'}`)
        const layers = (value.counts?.layers || []).map((count, index) => `第${['一', '二', '三', '四', '五', '六', '七'][index] || index + 1}层 ${count} 条`)
        return TEXT(
          `【记忆库状态】\n短期记忆：${value.counts?.short ?? 0} 条\n` +
            `${layers.join('｜')}\n总计：${value.total ?? 0} 条\n` +
            `最近维护：${value.lastMaintenanceAt ?? '尚未进行'}\n数据目录：${value.dataDir ?? '（未知）'}`,
        )
      },
    },
    async execute() {
      try {
        return { ok: true, ...memory.status() }
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
  }

  const personaStatus = {
    name: 'persona_status',
    description: '查看当前人设文件状态：校验结果、模块清单、人设文件路径。主人问起「你的人设」「你能改设定吗」或需要排查人设问题时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { description: '人设状态' },
      render(args, value) {
        if (!value || value.ok !== true) return TEXT(`无法读取人设状态：${value?.error ?? '未知错误'}`)
        const errors = value.validation?.errors ?? []
        const modules = (value.modules || []).map((m) => `${m.label}（${m.activation === 'always' ? '始终生效' : '被问到才用'}）`)
        return TEXT(
          `【人设状态】${errors.length === 0 ? '校验通过' : `发现 ${errors.length} 个问题`}\n` +
            `角色：${value.characterName ?? '（未命名）'}\n` +
            `模块：${modules.join('、')}\n人设文件：${value.filePath}\n` +
            (errors.length > 0 ? `问题：${errors.join('；')}` : ''),
        )
      },
    },
    async execute() {
      try {
        const validation = persona.validate()
        return {
          ok: true,
          validation,
          modules: persona.moduleList(),
          characterName: persona.getDefinition()?.character?.name,
          filePath: persona.getFilePath(),
        }
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
  }

  return [personaLookup, memoryRecall, memoryNote, memoryStatus, personaStatus]
}
