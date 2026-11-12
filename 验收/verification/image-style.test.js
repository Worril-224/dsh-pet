/**
 * 独立验收 · 固定二次元画风（2026-11-11 追加）
 *
 * 覆盖：
 *  - normalizeImagePromptFormat 把固定画风放到 prompt_en 最前面；
 *  - 写实/3D/摄影描述被清掉，风格前缀幂等；
 *  - 生成服务最终边界即使遇到自定义 planner 也强制固定画风。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  FIXED_IMAGE_STYLE,
  IMAGE_PROMPT_VERSION,
  normalizeImagePromptFormat,
  withFixedImageStyle,
  withFixedNegativePrompt,
} from '../../companion-bundle/lib/imagegen/prompt.js'
import { createImageGenerationService } from '../../companion-bundle/lib/imagegen/service.js'
import { cleanupTempDirs, makeTempDir } from './helpers.mjs'

test.after(cleanupTempDirs)

test('IS1: 固定画风在 prompt_en 最前面，style 字段不再由 LLM 改变', () => {
  const format = normalizeImagePromptFormat({
    title: '窗边',
    scene: '雨夜图书馆',
    style: 'photorealistic photography, cinematic',
    prompt_en: 'A photorealistic photo of Ophelia by a rainy window, 3D render, film still.',
    negative_prompt: 'blurry',
  })
  assert.equal(format.version, IMAGE_PROMPT_VERSION)
  assert.ok(format.prompt_en.startsWith(FIXED_IMAGE_STYLE), 'prompt_en 必须以固定画风开头')
  assert.equal(format.style, FIXED_IMAGE_STYLE)
  assert.doesNotMatch(format.prompt_en, /photorealistic|3D render|film still/iu)
  assert.match(format.negative_prompt, /photorealistic/u)
})

test('IS2: 风格前缀幂等，负面词去重', () => {
  const once = withFixedImageStyle('Ophelia reading in a library, cinematic lighting.')
  assert.ok(once.startsWith(FIXED_IMAGE_STYLE))
  assert.equal(withFixedImageStyle(once), once, '重复调用不应重复前缀/尾注')

  const negative = withFixedNegativePrompt('blurry, photorealistic, low quality')
  assert.equal((negative.match(/photorealistic/gu) ?? []).length, 1, 'photorealistic 只应出现一次')
  assert.match(negative, /blurry/u)
  assert.match(negative, /low quality/u)
})

test('IS3: 生成服务边界即使 planner 返回写实提示词也强制二次元画风', async () => {
  const root = makeTempDir('dshpet-verify-image-style-')
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
          title: '测试',
          scene: '图书馆',
          style: 'photorealistic',
          prompt_en: 'A photorealistic photo of Ophelia, 3D render, CGI.',
          negative_prompt: 'blurry',
          aspect_ratio: '1:1',
          megapixels: 1,
        }),
      },
      comfy: {
        generate: async (args) => {
          captured = args
          return { promptId: 'verify-p1', buffer: Buffer.from('fake'), filename: 'fake.png' }
        },
        startServer: async () => {},
        stopServer: async () => false,
        startedByUs: false,
      },
    })
    const result = await service.generate({
      userId: 'u1',
      userText: '画图',
      trigger: { triggerType: 'new_scene', scene: '图书馆' },
      at: Date.now(),
    })
    assert.ok(captured.prompt.startsWith(FIXED_IMAGE_STYLE))
    assert.doesNotMatch(captured.prompt, /photorealistic|3D render|CGI/iu)
    assert.match(captured.negativePrompt, /photorealistic/u)
    assert.equal(result.format.style, FIXED_IMAGE_STYLE)
    assert.ok(fs.existsSync(path.join(root, 'images', 'generated')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
