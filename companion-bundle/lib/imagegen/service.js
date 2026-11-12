/** 生图编排：触发判断 → 提示词格式 → ComfyUI → 图片记忆 → 空闲关闭。 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDirSync } from '../shared/fsutil.js'
import { createComfyClient } from './comfy.js'
import {
  createImagePromptPlanner,
  FIXED_IMAGE_STYLE,
  IMAGE_PROMPT_VERSION,
  withFixedImageStyle,
  withFixedNegativePrompt,
} from './prompt.js'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dateKey(now) {
  const date = new Date(now)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function createImageGenerationService(options = {}) {
  const {
    dataDir,
    settings = {},
    logger,
    llmJson,
    personaSection,
    memory,
    comfy = createComfyClient({
      url: settings.comfyUrl,
      cliPath: settings.comfyCliPath,
      workspace: settings.comfyWorkspace,
      workflowPath: settings.comfyWorkflowPath,
      startTimeoutMs: settings.comfyStartTimeoutMs,
      generationTimeoutMs: settings.imagegenTimeoutMs,
      extraArgs: settings.comfyExtraArgs,
      logger,
    }),
  } = options
  const enabled = settings.imagegenEnabled !== false
  const cooldownMs = Number.isFinite(settings.imagegenCooldownMs) ? Math.max(10000, settings.imagegenCooldownMs) : 10000
  const maxPerDay = Number.isFinite(settings.imagegenMaxPerDay)
    ? Math.max(0, Math.min(1000, Math.round(settings.imagegenMaxPerDay)))
    : 0
  const idleStopMs = Number.isFinite(settings.imagegenIdleStopMs) ? Math.max(60000, settings.imagegenIdleStopMs) : 600000
  const imageDir = path.join(dataDir, 'images', 'generated')
  const planner =
    options.planner ??
    createImagePromptPlanner({
      llmJson,
      personaSection,
      logger,
    })
  const lastTriggerAt = new Map()
  const lastSceneByUser = new Map()
  const dayCounts = new Map()
  let idleTimer
  let lastImageAt
  let lastError

  function canAttempt(userId, now = Date.now()) {
    if (!enabled) return { ok: false, reason: 'disabled' }
    const key = String(userId)
    const last = lastTriggerAt.get(key) ?? 0
    if (now - last < cooldownMs) return { ok: false, reason: 'cooldown' }
    const day = dateKey(now)
    const count = dayCounts.get(`${key}:${day}`) ?? 0
    if (maxPerDay > 0 && count >= maxPerDay) return { ok: false, reason: 'daily_limit' }
    return { ok: true }
  }

  function markAttempt(userId, now = Date.now()) {
    const key = String(userId)
    lastTriggerAt.set(key, now)
    const day = dateKey(now)
    dayCounts.set(`${key}:${day}`, (dayCounts.get(`${key}:${day}`) ?? 0) + 1)
  }

  function scheduleIdleStop() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      comfy.stopServer?.().catch((error) => logger?.warn?.(`[qq] 生图空闲关闭失败：${error?.message ?? error}`))
    }, idleStopMs)
    idleTimer.unref?.()
  }

  async function detectTrigger({ userId, userText, history = [], at = Date.now() } = {}) {
    const key = String(userId ?? '')
    if (!key) return { shouldGenerate: false, reason: 'no_user' }
    const availability = canAttempt(key, at)
    if (!availability.ok) return { shouldGenerate: false, reason: availability.reason }
    try {
      const trigger = await planner.detectTrigger({
        userText,
        history,
        lastScene: lastSceneByUser.get(key) ?? '',
      })
      if (!trigger?.shouldGenerate) return trigger ?? { shouldGenerate: false }
      markAttempt(key, at)
      if (trigger.scene) lastSceneByUser.set(key, trigger.scene)
      return trigger
    } catch (error) {
      lastError = error?.message ?? String(error)
      logger?.warn?.(`[qq] 生图触发检测失败：${lastError}`)
      return { shouldGenerate: false, reason: lastError }
    }
  }

  async function generate({ userId, userText, replyText, history = [], trigger = {}, at = Date.now() } = {}) {
    if (!enabled) throw new Error('生图功能未启用')
    const key = String(userId ?? '')
    const query = `${trigger.scene ?? ''}\n${userText ?? ''}`.trim()
    let relatedMemories = []
    let imageMemories = []
    try {
      if (typeof memory?.recall === 'function') {
        const recalled = memory.recall(query, { limit: 16 })
        relatedMemories = (recalled?.hits ?? []).map((hit) => hit.item)
      }
      if (typeof memory?.listImageMemories === 'function') {
        imageMemories = memory.listImageMemories(8)
      }
    } catch (error) {
      logger?.warn?.(`[qq] 生图参考记忆读取失败：${error?.message ?? error}`)
    }
    const planned = await planner.plan({
      userText,
      replyText,
      history,
      trigger,
      imageMemories,
      relatedMemories,
    })
    // 最终边界再锁一次画风：即使自定义 planner / 旧记忆返回写实提示词，也强制二次元画风。
    const format = {
      ...planned,
      style: FIXED_IMAGE_STYLE,
      prompt_en: withFixedImageStyle(planned.prompt_en),
      negative_prompt: withFixedNegativePrompt(planned.negative_prompt),
    }
    const seed = Math.floor(Math.random() * 1_000_000_000_000)
    const filenamePrefix = `ophelia/${dateKey(at)}-${Date.now()}`
    const result = await comfy.generate({
      prompt: format.prompt_en,
      negativePrompt: format.negative_prompt,
      seed,
      aspectRatio: format.aspect_ratio || '1:1',
      megapixels: format.megapixels || 1,
      filenamePrefix,
    })
    ensureDirSync(imageDir)
    const ext = path.extname(result.filename || '') || '.png'
    const imagePath = path.join(imageDir, `${Date.now()}-${seed}${ext}`)
    fs.writeFileSync(imagePath, result.buffer)
    const content = [
      `【生成画面】${format.title}`,
      `场景：${format.scene}`,
      format.action ? `动作：${format.action}` : '',
      format.environment ? `环境：${format.environment}` : '',
      format.mood ? `情绪：${format.mood}` : '',
      `英文提示词：${format.prompt_en}`,
    ].filter(Boolean).join('\n')
    let memoryItem
    try {
      if (typeof memory?.remember === 'function') {
        memoryItem = memory.remember({
          content,
          keywords: [
            '生成图片',
            format.title,
            format.scene,
            format.action,
            format.mood,
            ...(Array.isArray(format.keywords) ? format.keywords : []),
          ].filter(Boolean),
          category: '事件',
          summary: `【画面】${format.title}${format.scene ? `：${format.scene}` : ''}`.slice(0, 200),
          source: 'imagegen',
          metadata: {
            image: true,
            type: 'generated_image',
            promptVersion: IMAGE_PROMPT_VERSION,
            promptFormat: format,
            prompt: format.prompt_en,
            negativePrompt: format.negative_prompt,
            styleLocked: true,
            stylePrefix: FIXED_IMAGE_STYLE,
            imagePath,
            triggerType: trigger.triggerType,
            triggerScene: trigger.scene,
            seed,
            aspectRatio: format.aspect_ratio,
            megapixels: format.megapixels,
            createdAt: new Date(at).toISOString(),
            referenceMemoryIds: imageMemories.map((item) => item.id).slice(0, 8),
            llm: true,
          },
          at,
        })
      }
    } catch (error) {
      logger?.warn?.(`[qq] 生图记忆写入失败：${error?.message ?? error}`)
    }
    lastImageAt = at
    lastError = undefined
    scheduleIdleStop()
    return {
      imagePath,
      prompt: format.prompt_en,
      format,
      memory: memoryItem,
      promptId: result.promptId,
    }
  }

  async function close() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
    await comfy.stopServer?.()
  }

  /** 主人还在聊天时续上 ComfyUI 的空闲倒计时（只对本次由插件启动的实例有效）。 */
  function touchActivity() {
    if (comfy.startedByUs) scheduleIdleStop()
  }

  return {
    enabled,
    detectTrigger,
    generate,
    close,
    touchActivity,
    scheduleIdleStop,
    status: () => ({
      enabled,
      lastImageAt,
      lastError,
      idleStopMs,
      cooldownMs,
      maxPerDay,
      comfy: { url: settings.comfyUrl, startedByUs: Boolean(comfy.startedByUs) },
    }),
    comfy,
  }
}
