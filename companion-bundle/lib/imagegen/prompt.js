/**
 * 生图提示词规划 / 触发判断。
 *
 * 提示词格式固定在 `ophelia-image-prompt/2`：
 *   scene / characters / action / environment / mood / composition / lighting /
 *   palette / style / aspect_ratio / megapixels / negative_prompt / prompt_en
 * 其中 prompt_en 是最终交给 Qwen Image 2.1 Turbo 的英文画面描述。
 */

export const IMAGE_PROMPT_VERSION = 'ophelia-image-prompt/2'

/**
 * 固定画风（2026-11-11）。
 * 以角色参考图 companion-data/characters/ophelia/assets/ophelia-reference.jpg 的画风为准：
 * 2D 日系动漫画、干净线稿、赛璐璐上色（柔和渐变阴影）、维多利亚幻想服饰细节。
 * 每次生图都必须原样放在 prompt_en 最前面，不再让画面导演/旧记忆自由改画风。
 */
export const FIXED_IMAGE_STYLE =
  '2D Japanese anime illustration, anime key visual, clean crisp line art, cel shading with soft gradient shadows, flat anime colors, detailed hand-drawn Victorian fantasy costume, expressive anime eyes, elegant gothic-romantic atmosphere, warm ivory black and copper-orange palette'

/** 固定在 prompt_en 末尾的短句，进一步把画面拉回二次元。 */
export const FIXED_IMAGE_STYLE_TAIL = 'Consistent 2D Japanese anime illustration style.'

/** 固定负面词：阻止 Qwen Image 漂成写实摄影/3D/CG。 */
export const FIXED_NEGATIVE_PROMPT =
  'photorealistic, realistic, hyperrealistic, realistic photo, photography, film still, live-action, 3D render, CGI, octane render, unreal engine, realistic skin texture'

export const DEFAULT_NEGATIVE_PROMPT =
  'blurry, low quality, worst quality, watermark, signature, text, letters, logo, extra fingers, bad anatomy, deformed hands'

/** 把逗号分隔的负面词去重合并。 */
function mergeNegativeTerms(...values) {
  const seen = new Set()
  const terms = []
  for (const value of values) {
    for (const part of String(value ?? '').split(',')) {
      const term = part.trim()
      if (!term) continue
      const key = term.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      terms.push(term)
    }
  }
  return terms.join(', ')
}

/** 在调用方给出的负面词前补上固定「反写实」负面词。 */
export function withFixedNegativePrompt(value) {
  return mergeNegativeTerms(FIXED_NEGATIVE_PROMPT, normalizeString(value, DEFAULT_NEGATIVE_PROMPT))
}

/**
 * 去掉可能把画风带向写实/3D/摄影的描述词。
 * 保留 cinematic / soft light 等可用于动漫画面的词。
 */
export function stripNonAnimeStyleTerms(value) {
  return String(value ?? '')
    .replace(
      /\b(?:photorealistic|photo-realistic|hyperrealistic|hyper-realistic|realistic|3d\s*render|3d|cgi|live-action|photography|photographic|(?:photo|photograph)\s+of|film still|octane render|unreal engine|painterly|oil painting)\b/giu,
      '',
    )
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/gu, ', ')
    .replace(/(?:,\s*)+/gu, ', ')
    .replace(/,\s*([.!?])/gu, '$1')
    .replace(/^[\s,;:]+|[\s,;:]+$/gu, '')
    .trim()
}

/**
 * 把固定画风放到 prompt_en 最前面，并在末尾补一句风格锚点。
 * 重复调用不会重复添加。
 */
export function withFixedImageStyle(value) {
  const body = stripNonAnimeStyleTerms(value)
  const style = FIXED_IMAGE_STYLE
  const tail = FIXED_IMAGE_STYLE_TAIL
  if (!body) return `${style}. ${tail}`
  const startsWithStyle = body.toLowerCase().startsWith(style.toLowerCase())
  const endsWithTail = body.toLowerCase().endsWith(tail.toLowerCase())
  if (startsWithStyle) return endsWithTail ? body : `${body} ${tail}`
  return `${style}. ${body}${endsWithTail ? '' : ` ${tail}`}`
}

/**
 * 奥菲莉亚的固定外观（以 companion-data/characters/ophelia/assets/ophelia-reference.jpg 为准）。
 * 生图时必须优先于任何旧记忆/模型自由发挥。
 */
export const OPHELIA_APPEARANCE = Object.freeze({
  name: '奥菲莉亚',
  appearance: '橙红色（铜橙色）长直发、金色/琥珀色眼睛、白皙皮肤；成年年轻女性，神情安静克制',
  clothing:
    '白色维多利亚式高领泡泡袖衬衫、黑色束腰胸衣、白色多层长裙配黑色侧片与橙色饰带，黑色蝴蝶结配向日葵/橙色雏菊发饰与胸针，金色刺绣，白色系带短靴，常拿一本深色旧书',
  english:
    'adult young woman with long copper-orange hair and golden amber eyes, pale skin, wearing a white Victorian high-neck puff-sleeve blouse, black corset overlay, long white layered skirt with black side panels and orange accents, orange sash, black bows with sunflower and orange daisy hair ornament and brooches, gold embroidery, white lace-up heeled boots, often holding a dark antique book, calm reserved expression',
  englishHairEyes: 'long copper-orange hair and golden amber eyes',
  englishOutfit:
    'a white Victorian high-neck puff-sleeve blouse, black corset overlay, long white layered skirt with black side panels and orange accents, orange sash, black bows with sunflower and orange daisy hair ornament and brooches, gold embroidery, white lace-up heeled boots, holding a dark antique book',
})

function enforceCanonicalAppearance(value) {
  let text = String(value ?? '').trim()
  if (!text) return text
  text = text
    .replace(/silver(?:\s*[- ]?\s*white)?\s+hair/giu, 'long copper-orange hair')
    .replace(/silver\s+hair/giu, 'long copper-orange hair')
    .replace(/phoenix[-\s]*red\s+eyes/giu, 'golden amber eyes')
    .replace(/crimson\s+eyes/giu, 'golden amber eyes')
    .replace(/red\s+eyes/giu, 'golden amber eyes')
  if (!/(copper[- ]?orange|orange|copper)\s+hair/iu.test(text)) {
    text = `Ophelia has ${OPHELIA_APPEARANCE.englishHairEyes}. ${text}`
  } else if (!/(golden|amber|gold)\s+(colou?red\s+)?eyes/iu.test(text)) {
    text = `Ophelia has golden amber eyes. ${text}`
  }
  if (!/(victorian|white dress|white gown|corset|sunflower|daisy)/iu.test(text)) {
    text = `${text} She wears ${OPHELIA_APPEARANCE.englishOutfit}.`
  }
  return text.trim()
}

function historyText(history, limit = 10) {
  return (Array.isArray(history) ? history : [])
    .slice(-limit)
    .map((item) => `${item.role === 'assistant' ? '奥菲莉亚' : '主人'}：${item.text}`)
    .join('\n')
}

function parseJson(text) {
  const raw = String(text ?? '').trim()
  try {
    return JSON.parse(raw)
  } catch {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1))
    throw new Error('不是 JSON')
  }
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => normalizeString(item)).filter(Boolean) : []
}

export function normalizeImagePromptFormat(raw = {}, fallback = {}) {
  const characters = Array.isArray(raw.characters)
    ? raw.characters
        .map((character) => {
          if (typeof character === 'string') return { name: character }
          return {
            name: normalizeString(character?.name, '奥菲莉亚'),
            appearance: normalizeString(character?.appearance),
            expression: normalizeString(character?.expression),
            pose: normalizeString(character?.pose),
            clothing: normalizeString(character?.clothing),
          }
        })
        .filter((character) => character.name)
    : []
  if (characters.length === 0) {
    characters.push({
      name: OPHELIA_APPEARANCE.name,
      appearance: OPHELIA_APPEARANCE.appearance,
      expression: '安静克制',
      pose: '',
      clothing: OPHELIA_APPEARANCE.clothing,
    })
  }
  const ophelia = characters.find((character) => /奥菲莉亚|ophelia/iu.test(character.name))
  if (ophelia) {
    ophelia.appearance = OPHELIA_APPEARANCE.appearance
    ophelia.clothing = ophelia.clothing || OPHELIA_APPEARANCE.clothing
  }
  return {
    version: IMAGE_PROMPT_VERSION,
    title: normalizeString(raw.title, fallback.title ?? '无题画面'),
    scene: normalizeString(raw.scene, fallback.scene ?? ''),
    characters,
    action: normalizeString(raw.action),
    environment: normalizeString(raw.environment),
    mood: normalizeString(raw.mood),
    composition: normalizeString(raw.composition),
    lighting: normalizeString(raw.lighting),
    palette: normalizeString(raw.palette),
    style: FIXED_IMAGE_STYLE,
    aspect_ratio: normalizeString(raw.aspect_ratio, '1:1'),
    megapixels: Math.max(0.6, Math.min(2, Number.isFinite(Number(raw.megapixels)) ? Number(raw.megapixels) : 1)),
    negative_prompt: withFixedNegativePrompt(raw.negative_prompt),
    prompt_en: withFixedImageStyle(
      enforceCanonicalAppearance(normalizeString(raw.prompt_en, fallback.prompt_en ?? '')),
    ),
    keywords: normalizeStringArray(raw.keywords).slice(0, 12),
    reference_memory_ids: normalizeStringArray(raw.reference_memory_ids).slice(0, 8),
  }
}

/**
 * @param {object} options
 * @param {{complete:Function}} options.llmJson
 * @param {string} options.personaSection
 * @param {Function} [options.logger]
 */
export function createImagePromptPlanner({ llmJson, personaSection, logger } = {}) {
  async function detectTrigger({ userText, history = [], lastScene = '' } = {}) {
    if (!llmJson || typeof llmJson.complete !== 'function') return { shouldGenerate: false, reason: '没有 LLM' }
    try {
      const raw = await llmJson.complete({
        system: [
          '你是一个画面导演，只判断「现在是否值得为奥菲莉亚画一张图」，只输出 JSON。',
          '触发条件只允许三类：',
          '1. new_scene：进入了一个新的地点/场景/章节；',
          '2. special_action：互动中发生了有画面感的特殊动作（拥抱、奔跑、递东西、摔倒、雨中共伞、开门等）；',
          '3. emotional_peak：奥菲莉亚的情绪明显激动、脆弱、害羞或关系出现明显升温。',
          '普通日常寒暄、重复的聊天、没有画面感的抽象情绪，一律不要触发。',
          '宁可少触发，也不要每轮都画；判断要保守。',
          '输出 JSON：{"shouldGenerate":true|false,"triggerType":"new_scene|special_action|emotional_peak|none","scene":"...","title":"...","reason":"...","confidence":0-1}',
        ].join('\n'),
        user: [
          personaSection,
          lastScene ? `【当前场景参考】${lastScene}` : '',
          '【最近对话】',
          historyText(history),
          `【主人刚刚说】${userText}`,
          '请判断这一轮是否值得生成一张画面，并输出 JSON。',
        ].filter(Boolean).join('\n\n'),
      })
      const shouldGenerate = raw?.shouldGenerate === true && Number(raw?.confidence ?? 1) >= 0.55
      const triggerType = ['new_scene', 'special_action', 'emotional_peak'].includes(raw?.triggerType) ? raw.triggerType : 'none'
      if (!shouldGenerate || triggerType === 'none') return { shouldGenerate: false, reason: normalizeString(raw?.reason) }
      return {
        shouldGenerate: true,
        triggerType,
        scene: normalizeString(raw?.scene, normalizeString(lastScene)),
        title: normalizeString(raw?.title, normalizeString(raw?.scene, '这一刻')),
        reason: normalizeString(raw?.reason),
        confidence: Math.max(0, Math.min(1, Number(raw?.confidence ?? 0.6))),
      }
    } catch (error) {
      logger?.warn?.(`[qq] 生图触发判断失败：${error?.message ?? error}`)
      return { shouldGenerate: false, reason: error?.message ?? String(error) }
    }
  }

  async function plan({ userText, replyText, history = [], trigger = {}, imageMemories = [], relatedMemories = [] } = {}) {
    const imageReferenceText = imageMemories
      .slice(0, 6)
      .map((item, index) => {
        const format = item.metadata?.promptFormat
        return [
          `参考图${index + 1}（id=${item.id}）：${item.summary || item.content?.slice(0, 120) || ''}`,
          format?.characters?.length ? `角色外观：${format.characters.map((c) => [c.name, c.appearance, c.clothing].filter(Boolean).join('，')).join('；')}` : '',
          format?.prompt_en ? `当时的英文提示词：${String(format.prompt_en).slice(0, 700)}` : '',
        ].filter(Boolean).join('\n')
      })
      .join('\n\n')
    const relatedText = relatedMemories
      .slice(0, 8)
      .map((item) => `- ${item.summary || item.content?.slice(0, 160) || ''}`)
      .join('\n')
    const fallback = {
      title: trigger.title || trigger.scene || '这一刻',
      scene: trigger.scene || userText,
      prompt_en: `Ophelia, ${OPHELIA_APPEARANCE.english}, in a quiet library scene. ${trigger.scene || userText}. Cinematic lighting, detailed background, no text, no watermark.`,
    }
    if (!llmJson || typeof llmJson.complete !== 'function') return normalizeImagePromptFormat({}, fallback)
    try {
      const raw = await llmJson.complete({
        system: [
          '你是奥菲莉亚的专属画面导演和提示词工程师，只输出 JSON。',
          '先按固定格式设计画面，再写 prompt_en。prompt_en 是给 Qwen Image 2.1 Turbo 的英文提示词，只描述画面，不要指令口吻。',
          `【固定画风，最高优先级，禁止修改】${FIXED_IMAGE_STYLE}。所有画面都必须是二次元动漫画风，prompt_en 必须以这段固定画风英文开头，style 字段固定为这段；禁止写 photorealistic / realistic / 3D render / CGI / 摄影 / 真人影视。`,
          '固定格式字段：title, scene, characters[{name,appearance,expression,pose,clothing}], action, environment, mood, composition, lighting, palette, style, aspect_ratio, megapixels, negative_prompt, prompt_en, keywords, reference_memory_ids。',
          `【奥菲莉亚固定外观，必须严格遵守，不能改成银发/红眼/兽耳】${OPHELIA_APPEARANCE.appearance}；${OPHELIA_APPEARANCE.clothing}。`,
          'characters 里奥菲莉亚的 appearance/clothing 必须使用上面这套固定外观；示例图片只补充当前动作、表情、场景和氛围，不得改变发色、瞳色、服装主色。',
          '角色一致性：奥菲莉亚是成年年轻女性，橙红色长直发、金色/琥珀色眼睛；如果参考图记忆里有她的外观，必须优先沿用。',
          '参考图记忆是最高优先级的外观/风格参考；相关记忆提供事件和场景细节；当前上下文决定这一刻的动作和表情。',
          '不要画文字、字幕、水印、logo；不要让画面出现现代手机/电脑/AI 标识。',
          `prompt_en 必须是一段完整英文画面描述，约 80–180 个英文单词，包含主体、服装、动作、环境、光线、构图；最前面必须是固定画风：${FIXED_IMAGE_STYLE}。`,
          'aspect_ratio 只能是 1:1、2:3、3:2、3:4、4:3、9:16、16:9 之一；根据画面主体和构图单独选择，默认 1:1。',
          'megapixels 按画面复杂度单独选择：特写/单人 0.8–1.2，多人或需要环境细节 1.2–1.6，宽幅场景最多 2.0；默认 1.0。不要固定尺寸。',
        ].join('\n'),
        user: [
          personaSection,
          `【奥菲莉亚固定外观】${OPHELIA_APPEARANCE.appearance}；${OPHELIA_APPEARANCE.clothing}`,
          `【固定画风】${FIXED_IMAGE_STYLE}（prompt_en 必须以这段开头，不得改写）`,
          `【触发类型】${trigger.triggerType || 'special_action'}`,
          `【场景】${trigger.scene || ''}`,
          `【最近对话】\n${historyText(history)}`,
          `【主人刚刚说】${userText}`,
          `【奥菲莉亚刚刚回复】${replyText}`,
          imageReferenceText ? `【优先参考：之前的生成图记忆】（只参考动作/表情/场景，画风一律使用固定画风）\n${imageReferenceText}` : '',
          relatedText ? `【相关记忆】\n${relatedText}` : '',
          '请输出固定格式 JSON。',
        ].filter(Boolean).join('\n\n'),
      })
      return normalizeImagePromptFormat(raw, fallback)
    } catch (error) {
      logger?.warn?.(`[qq] 生图提示词规划失败，使用兜底：${error?.message ?? error}`)
      return normalizeImagePromptFormat({}, fallback)
    }
  }

  return { detectTrigger, plan }
}
