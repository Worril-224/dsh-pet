/** 本地 ComfyUI 客户端：懒启动、提交 Qwen Image 2.1 Turbo、下载结果、空闲关闭。 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ensureDirSync, readJsonSync } from '../shared/fsutil.js'

const DEFAULT_WORKFLOW = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/u, ''),
  '../../data/comfy/ophelia_qwen_image_2_1_turbo_api.json',
)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(ms) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

export function createComfyClient(options = {}) {
  const logger = options.logger
  const url = String(options.url ?? 'http://127.0.0.1:8188').replace(/\/+$/u, '')
  const cliPath = options.cliPath
  const workspace = options.workspace
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs.map((value) => String(value)) : []
  const workflowPath = options.workflowPath ?? DEFAULT_WORKFLOW
  const startTimeoutMs = Number.isFinite(options.startTimeoutMs) ? Math.max(30000, options.startTimeoutMs) : 300000
  const generationTimeoutMs = Number.isFinite(options.generationTimeoutMs)
    ? Math.max(30000, options.generationTimeoutMs)
    : 600000
  let serverPromise
  let startedByUs = false
  let workflow

  async function isServerUp() {
    try {
      const response = await fetch(`${url}/system_stats`, { signal: withTimeout(2500) })
      return response.ok
    } catch {
      return false
    }
  }

  async function launchServer() {
    if (await isServerUp()) return
    if (!cliPath || !fs.existsSync(cliPath)) {
      throw new Error(`找不到 comfy-cli：${cliPath ?? '(未配置)'}`)
    }
    logger?.info?.(`[qq] 首次生图，启动 ComfyUI：${cliPath}`)
    const args = [
      '--json',
      ...(workspace ? [`--workspace=${workspace}`] : []),
      'launch',
      '--background',
      ...(extraArgs.length > 0 ? ['--', ...extraArgs] : []),
    ]
    try {
      const child = spawn(cliPath, args, {
        cwd: workspace || undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${path.dirname(cliPath)}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      })
      child.unref()
      startedByUs = true
    } catch (error) {
      throw new Error(`启动 ComfyUI 失败：${error?.message ?? error}`)
    }
    const deadline = Date.now() + startTimeoutMs
    while (Date.now() < deadline) {
      await sleep(2000)
      if (await isServerUp()) {
        logger?.info?.('[qq] ComfyUI 已启动')
        return
      }
    }
    throw new Error(`ComfyUI 启动超时（${Math.round(startTimeoutMs / 1000)} 秒）`)
  }

  async function ensureServer() {
    if (await isServerUp()) return
    if (!serverPromise) {
      serverPromise = launchServer().finally(() => {
        serverPromise = undefined
      })
    }
    return serverPromise
  }

  function loadWorkflow() {
    if (!workflow) workflow = readJsonSync(workflowPath, undefined)
    if (!workflow || typeof workflow !== 'object') throw new Error(`生图工作流不存在或损坏：${workflowPath}`)
    return workflow
  }

  function findNode(workflow, classType) {
    const entry = Object.entries(workflow).find(([, node]) => node && node.class_type === classType)
    if (!entry) throw new Error(`生图工作流缺少 ${classType} 节点`)
    return entry[1]
  }

  function buildPrompt({ prompt, negativePrompt, seed, aspectRatio = '1:1', megapixels = 1, filenamePrefix = 'ophelia' }) {
    const base = JSON.parse(JSON.stringify(loadWorkflow()))
    // 按 class_type 定位，而不是依赖固定 node id；这样独立工作流/节点重排都不会互相影响。
    const promptNode = findNode(base, 'TextEncodeQwenImage21')
    promptNode.inputs.prompt = String(prompt ?? '')
    promptNode.inputs.negative_prompt = String(negativePrompt ?? '')
    const noiseNode = findNode(base, 'RandomNoise')
    noiseNode.inputs.noise_seed = Number(seed)
    const resolutionNode = findNode(base, 'ResolutionSelector')
    const ratioMap = {
      '1:1': '1:1 (Square)',
      '2:3': '2:3 (Portrait Photo)',
      '3:2': '3:2 (Photo)',
      '3:4': '3:4 (Portrait Standard)',
      '4:3': '4:3 (Standard)',
      '9:16': '9:16 (Portrait Widescreen)',
      '16:9': '16:9 (Widescreen)',
      '21:9': '21:9 (Ultrawide)',
    }
    resolutionNode.inputs.aspect_ratio = ratioMap[aspectRatio] ?? '1:1 (Square)'
    resolutionNode.inputs.megapixels = Math.max(0.6, Math.min(2, Number(megapixels) || 1))
    const saveNode = findNode(base, 'SaveImageAdvanced')
    saveNode.inputs.filename_prefix = filenamePrefix
    return base
  }

  async function generate({ prompt, negativePrompt, seed, aspectRatio, megapixels, filenamePrefix } = {}) {
    await ensureServer()
    const workflowPrompt = buildPrompt({ prompt, negativePrompt, seed, aspectRatio, megapixels, filenamePrefix })
    const outputNodeId = Object.entries(workflowPrompt).find(([, node]) => node?.class_type === 'SaveImageAdvanced')?.[0]
    if (!outputNodeId) throw new Error('生图工作流缺少 SaveImageAdvanced 输出节点')
    const clientId = `ophelia-image-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const submit = await fetch(`${url}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflowPrompt, client_id: clientId }),
      signal: withTimeout(30000),
    })
    if (!submit.ok) {
      const detail = await submit.text().catch(() => '')
      throw new Error(`ComfyUI 提交失败：HTTP ${submit.status}${detail ? `：${detail.slice(0, 500)}` : ''}`)
    }
    const submitted = await submit.json()
    const promptId = submitted?.prompt_id
    if (!promptId) throw new Error('ComfyUI 没有返回 prompt_id')

    const deadline = Date.now() + generationTimeoutMs
    let item
    while (Date.now() < deadline) {
      await sleep(1200)
      const response = await fetch(`${url}/history/${encodeURIComponent(promptId)}`, { signal: withTimeout(10000) })
      if (!response.ok) continue
      const history = await response.json()
      item = history?.[promptId]
      if (item?.status?.status_str === 'error') {
        const message = item.status?.messages?.find((entry) => Array.isArray(entry) && entry[0] === 'execution_error')?.[1]
        throw new Error(`ComfyUI 生图失败：${message?.exception_message ?? '未知错误'}`)
      }
      const images = item?.outputs?.[outputNodeId]?.images
      if (Array.isArray(images) && images.length > 0) break
      item = undefined
    }
    if (!item) throw new Error(`ComfyUI 生图超时（${Math.round(generationTimeoutMs / 1000)} 秒）`)
    const imageInfo = item.outputs[outputNodeId].images[0]
    const query = new URLSearchParams({
      filename: imageInfo.filename,
      subfolder: imageInfo.subfolder ?? '',
      type: imageInfo.type ?? 'output',
    })
    const imageResponse = await fetch(`${url}/view?${query.toString()}`, { signal: withTimeout(30000) })
    if (!imageResponse.ok) throw new Error(`下载生成图失败：HTTP ${imageResponse.status}`)
    const buffer = Buffer.from(await imageResponse.arrayBuffer())
    return { promptId, buffer, filename: imageInfo.filename }
  }

  async function stopServer() {
    if (!startedByUs) return false
    startedByUs = false
    try {
      logger?.info?.('[qq] 主人暂时不用生图，关闭 ComfyUI')
      const child = spawn(cliPath, ['--json', ...(workspace ? [`--workspace=${workspace}`] : []), 'stop'], {
        cwd: workspace || undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return true
    } catch (error) {
      logger?.warn?.(`[qq] 关闭 ComfyUI 失败：${error?.message ?? error}`)
      return false
    }
  }

  return {
    ensureServer,
    generate,
    stopServer,
    isServerUp,
    get startedByUs() {
      return startedByUs
    },
    status: async () => ({ url, running: await isServerUp(), startedByUs, workflowPath }),
  }
}

export { DEFAULT_WORKFLOW }
