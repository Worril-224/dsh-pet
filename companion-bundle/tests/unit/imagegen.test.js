/** 生图提示词格式 / 触发判断单元测试。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FIXED_IMAGE_STYLE,
  FIXED_NEGATIVE_PROMPT,
  IMAGE_PROMPT_VERSION,
  normalizeImagePromptFormat,
  createImagePromptPlanner,
  withFixedImageStyle,
  withFixedNegativePrompt,
} from '../../lib/imagegen/prompt.js'
import { createImageGenerationService } from '../../lib/imagegen/service.js'
import { getMemoryEngine } from '../../lib/memory/index.js'
import { buildOneBotSendAction } from '../../lib/im/onebot.js'

test('IG1：固定提示词格式规范化，缺省字段有安全默认值', () => {
  const format = normalizeImagePromptFormat({
    title: '雨夜',
    scene: '旧图书馆的窗边',
    characters: [{ name: '奥菲莉亚', appearance: '银白长发、金红眼瞳', expression: '安静', pose: '望向窗外' }],
    action: '把伞收起来',
    prompt_en: 'An anime illustration of Ophelia by a rainy window.',
    aspect_ratio: '2:3',
    megapixels: 1.2,
  })
  assert.equal(format.version, IMAGE_PROMPT_VERSION)
  assert.equal(format.title, '雨夜')
  assert.equal(format.characters[0].name, '奥菲莉亚')
  assert.ok(format.prompt_en.startsWith(FIXED_IMAGE_STYLE), '固定画风必须在 prompt_en 最前面')
  assert.match(format.prompt_en, /rainy window/u)
  assert.equal(format.style, FIXED_IMAGE_STYLE)
  assert.ok(format.negative_prompt.includes('photorealistic'))
  assert.ok(format.negative_prompt.length > 0)
  assert.equal(format.aspect_ratio, '2:3')
  assert.equal(format.megapixels, 1.2)
})

test('IG2：触发判断只接受三类事件，并输出场景', async () => {
  const calls = []
  const llmJson = {
    complete: async () => ({
      shouldGenerate: true,
      triggerType: 'emotional_peak',
      scene: '第七阅览室的雨夜',
      title: '她有点撑不住了',
      confidence: 0.9,
    }),
  }
  const planner = createImagePromptPlanner({ llmJson, personaSection: '【人设】奥菲莉亚' })
  const trigger = await planner.detectTrigger({ userText: '我在这里', history: [] })
  assert.equal(trigger.shouldGenerate, true)
  assert.equal(trigger.triggerType, 'emotional_peak')
  assert.equal(trigger.scene, '第七阅览室的雨夜')
})

test('IG3：提示词规划会优先带上生成图记忆里的角色外观', async () => {
  const seen = []
  const llmJson = {
    complete: async (input) => {
      seen.push(input.user)
      return {
        title: '窗边',
        scene: '雨夜的窗边',
        prompt_en: 'An anime illustration of Ophelia with silver hair and phoenix-red eyes.',
        aspect_ratio: '1:1',
      }
    },
  }
  const planner = createImagePromptPlanner({ llmJson, personaSection: '【人设】' })
  const imageMemories = [{
    id: 'img-1',
    summary: '【画面】之前的窗边',
    metadata: {
      promptFormat: {
        characters: [{ name: '奥菲莉亚', appearance: '银白长发、金红眼瞳', clothing: '黑色长裙' }],
        prompt_en: 'old prompt',
      },
    },
  }]
  const format = await planner.plan({
    userText: '看窗外',
    replyText: '嗯。',
    history: [{ role: 'user', text: '看窗外' }],
    trigger: { triggerType: 'new_scene', scene: '窗边' },
    imageMemories,
  })
  assert.ok(seen[0].includes('银白长发'))
  assert.equal(format.aspect_ratio, '1:1')
  assert.match(format.characters[0].appearance, /橙红色/u)
  assert.match(format.prompt_en, /copper-orange hair/u)
  assert.match(format.prompt_en, /golden amber eyes/u)
  assert.doesNotMatch(format.prompt_en, /silver hair|phoenix-red eyes/u)
})


test('IG4：生成图记忆可按特殊类型列出，供后续提示词优先参考', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ophelia-image-memory-'))
  try {
    const engine = getMemoryEngine({ dataDir: path.join(root, 'ophelia') })
    engine.ensure()
    engine.remember({
      content: '【生成画面】雨夜窗边',
      keywords: ['生成图片', '雨夜', '窗边'],
      category: '事件',
      summary: '【画面】雨夜窗边',
      source: 'imagegen',
      metadata: { image: true, type: 'generated_image', imagePath: 'D:/tmp/a.png', prompt: 'rainy window' },
    })
    const images = engine.listImageMemories(5)
    assert.equal(images.length, 1)
    assert.equal(images[0].metadata.image, true)
    assert.equal(images[0].metadata.type, 'generated_image')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})


test('IG5：生成的本地图片作为 OneBot image 段发出', () => {
  const imageFile = path.join('companion-data', 'characters', 'ophelia', 'images', 'generated', 'a.png')
  const action = buildOneBotSendAction({
    text: '（把刚画好的画面递过来）',
    userId: '10001',
    channel: 'qq',
    images: [imageFile],
  })
  assert.equal(action.action, 'send_private_msg')
  assert.equal(action.params.message[0].type, 'text')
  assert.equal(action.params.message[1].type, 'image')
  assert.equal(action.params.message[1].data.file, imageFile)
})

test('IG6：固定二次元画风会压掉写实/3D/摄影描述，且不重复加前缀', () => {
  const raw = 'A photorealistic photo of Ophelia in a library, 3D render, CGI, film still, cinematic lighting.'
  const styled = withFixedImageStyle(raw)
  assert.ok(styled.startsWith(FIXED_IMAGE_STYLE))
  assert.match(styled, /cinematic lighting/u)
  assert.doesNotMatch(styled, /photorealistic|photo of|3D render|CGI|film still/iu)
  assert.equal(withFixedImageStyle(styled), styled, '重复调用不应重复加风格前缀')

  const negative = withFixedNegativePrompt('blurry, photorealistic, custom negative')
  for (const term of FIXED_NEGATIVE_PROMPT.split(',')) assert.ok(negative.includes(term.trim()))
  assert.equal(negative.match(/photorealistic/gu)?.length, 1, '负面词应去重')
})

test('IG7：生成服务边界强制固定画风（即使 planner 返回写实提示词）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ophelia-image-style-'))
  let captured
  try {
    const service = createImageGenerationService({
      dataDir: root,
      settings: {
        imagegenEnabled: true,
        imagegenCooldownMs: 10000,
        imagegenMaxPerDay: 0,
        imagegenIdleStopMs: 600000,
        comfyUrl: 'http://127.0.0.1:8188',
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      planner: {
        detectTrigger: async () => ({ shouldGenerate: false }),
        plan: async () => ({
          title: '测试画面',
          scene: '图书馆',
          style: 'photorealistic photography',
          prompt_en: 'A photorealistic photo of Ophelia in a rainy library, 3D render, film still.',
          negative_prompt: 'blurry',
          aspect_ratio: '1:1',
          megapixels: 1,
        }),
      },
      comfy: {
        generate: async (args) => {
          captured = args
          return { promptId: 'p1', buffer: Buffer.from('fake-image'), filename: 'fake.png' }
        },
        startServer: async () => {},
        stopServer: async () => false,
        startedByUs: false,
      },
    })
    const result = await service.generate({
      userId: 'u1',
      userText: '画一张',
      trigger: { triggerType: 'new_scene', scene: '图书馆' },
      at: Date.now(),
    })
    assert.ok(captured.prompt.startsWith(FIXED_IMAGE_STYLE))
    assert.doesNotMatch(captured.prompt, /photorealistic|3D render|film still/iu)
    assert.match(captured.negativePrompt, /photorealistic/u)
    assert.equal(result.format.style, FIXED_IMAGE_STYLE)
    assert.ok(result.prompt.startsWith(FIXED_IMAGE_STYLE))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
