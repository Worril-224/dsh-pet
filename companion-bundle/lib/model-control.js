/**
 * 模型切换 Web API（Host 侧）。
 *
 * 为 Web UI 左侧「模型」面板提供：
 *  - 已注册的模型提供方与模型目录（来自 ctx.llm，带超时与短缓存）；
 *  - Harness 默认模型的读取与保存（来自 ctx.agentDefaultModel）。
 *
 * QQ 聊天模型的读写由 companion-qq 自己注册（见 qq-model-routes.js），
 * 因为只有它持有正在运行的回复引擎。
 */
import { sendJson, sendError, readJsonBody, isSameOrigin, methodNotAllowed } from './shared/http.js'
import { readJsonSync, writeJsonSync } from './shared/fsutil.js'

/** 本插件占用的路由前缀。 */
export const MODEL_ROUTE_PREFIX = '/dsh-companion/models'

/** 快捷模型最多保存多少条。 */
export const MAX_PRESETS = 20

/** 目录缓存时长：避免每次打开面板都去探测本地模型服务。 */
export const CATALOG_TTL_MS = 30_000

/** 单个提供方模型探测超时。 */
export const MODEL_DISCOVERY_TIMEOUT_MS = 6_000

/**
 * 规范化一个模型选择。
 * @param {unknown} value
 * @returns {{provider:string, model:string, reasoningEffort?:string}}
 */
export function normalizeSelection(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型选择必须是对象')
  }
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!provider) throw new Error('provider 不能为空')
  if (!model) throw new Error('model 不能为空')
  if (provider.length > 200 || model.length > 400) throw new Error('provider/model 过长')
  const reasoningEffort =
    typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim()
      ? value.reasoningEffort.trim()
      : undefined
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
}

/** 快捷模型的去重 key。 */
function presetKey(provider, model) {
  return `${provider}\u0000${model}`
}

/** 只保留 provider/model，忽略推理等级等调用参数。 */
function cleanPreset(value) {
  try {
    const route = normalizeSelection(value)
    return { provider: route.provider, model: route.model }
  } catch {
    return undefined
  }
}

/**
 * 快捷模型存储：保存在插件数据目录，重启 Harness / 换浏览器后仍然存在。
 * @param {string} file JSON 文件路径
 */
export function createPresetStore(file) {
  let cached
  function load() {
    if (cached) return cached
    let list = []
    try {
      const raw = readJsonSync(file, undefined)
      if (raw && Array.isArray(raw.presets)) list = raw.presets.map(cleanPreset).filter(Boolean)
    } catch {
      // 损坏文件按空列表处理，下一次保存覆盖
    }
    const seen = new Set()
    cached = list.filter((entry) => {
      const key = presetKey(entry.provider, entry.model)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, MAX_PRESETS)
    return cached
  }
  function persist(list) {
    cached = list
    writeJsonSync(file, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      presets: list,
    })
  }
  return {
    file,
    list() {
      return load().map((entry) => ({ ...entry }))
    },
    add(value) {
      const route = cleanPreset(value)
      if (!route) throw new Error('provider/model 不能为空')
      const key = presetKey(route.provider, route.model)
      const next = [route, ...load().filter((entry) => presetKey(entry.provider, entry.model) !== key)].slice(0, MAX_PRESETS)
      persist(next)
      return this.list()
    },
  }
}

/** 把任意 Promise 包上超时，避免一个不可达的本地端点拖住整个目录请求。 */
function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 读取超时`)), timeoutMs)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 把一个提供方的模型列表整理成 UI 需要的形状。 */
function normalizeModels(provider, models) {
  const list = Array.isArray(models) ? models : []
  return list
    .filter((model) => model && typeof model.id === 'string' && model.id.trim())
    .map((model) => ({
      id: model.id.trim(),
      name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : model.id.trim(),
      ...(typeof model.description === 'string' && model.description.trim()
        ? { description: model.description.trim() }
        : {}),
    }))
}

/**
 * 读取全部已注册提供方及其模型。
 * 一个不可达的本地提供方只会在它自己的 error 字段里体现，不影响其它提供方。
 * @param {any} llm ctx.llm
 * @param {{timeoutMs?:number}} [options]
 */
export async function collectModelCatalog(llm, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs) : MODEL_DISCOVERY_TIMEOUT_MS
  const fetchedAt = new Date().toISOString()
  let providers = []
  try {
    providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  } catch (error) {
    return {
      fetchedAt,
      providers: [],
      error: `读取模型提供方失败：${error?.message ?? String(error)}`,
    }
  }
  if (!Array.isArray(providers)) providers = []
  const entries = []
  for (const provider of providers) {
    const id = typeof provider?.id === 'string' ? provider.id.trim() : ''
    if (!id) continue
    let models = []
    let error
    try {
      if (typeof llm?.listModels === 'function') {
        models = normalizeModels(id, await withTimeout(llm.listModels(id), timeoutMs, id))
      }
    } catch (cause) {
      error = cause?.message ?? String(cause)
    }
    entries.push({
      provider: id,
      name: typeof provider?.name === 'string' && provider.name.trim() ? provider.name.trim() : id,
      models,
      ...(error ? { error } : {}),
    })
  }
  return { fetchedAt, providers: entries }
}

/** 读取当前 Harness 默认模型；服务不存在时返回 undefined。 */
export function readDefaultSelection(ctx) {
  try {
    const service = ctx?.get?.('agentDefaultModel')
    if (!service || typeof service.currentSelection !== 'function') return undefined
    return normalizeSelection(service.currentSelection())
  } catch {
    return undefined
  }
}

/** 判断 provider 是否已注册；没有 llm 服务时不做这项校验。 */
function isRegisteredProvider(llm, provider) {
  if (!llm || typeof llm.listProviders !== 'function') return true
  try {
    const providers = llm.listProviders()
    if (!Array.isArray(providers)) return true
    return providers.some((entry) => entry && entry.id === provider)
  } catch {
    return true
  }
}

/**
 * 在 webServer 可用后注册模型路由。
 *
 * Host 插件在冷启动时可能先于 webServer 激活；直接 `ctx.get('webServer')` 会拿到
 * undefined，导致路由直到下一次插件重载才出现。webServer 已经存在时立即注册，
 * 否则用 ctx.inject 等它可用（插件热重载时仍然立即生效）。
 * @param {any} ctx Host 插件上下文
 * @param {{logger?:any, webServer?:any}} [options]
 */
export function attachModelRoutes(ctx, options = {}) {
  const webServer = options.webServer ?? ctx?.get?.('webServer')
  if (webServer && typeof webServer.register === 'function') {
    return registerModelRoutes(ctx, { ...options, webServer })
  }
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      registerModelRoutes(webCtx, options)
    })
  }
  return []
}

/**
 * 注册模型目录与默认模型路由。
 * @param {any} ctx Host 插件上下文
 * @param {{logger?:any, webServer?:any, presetsFile?:string}} [options]
 * @returns {Array<() => void>} 路由释放函数
 */
export function registerModelRoutes(ctx, options = {}) {
  const webServer = options.webServer ?? ctx?.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') return []
  const logger = options.logger
  const cache = { at: 0, value: undefined, pending: undefined }
  const presets = typeof options.presetsFile === 'string' && options.presetsFile ? createPresetStore(options.presetsFile) : undefined

  async function catalog() {
    const now = Date.now()
    if (cache.value && now - cache.at < CATALOG_TTL_MS) return cache.value
    if (cache.pending) return cache.pending
    const llm = ctx?.get?.('llm')
    if (!llm) return { fetchedAt: new Date().toISOString(), providers: [], error: 'Harness 没有可用的 llm 服务' }
    cache.pending = collectModelCatalog(llm)
      .then((value) => {
        cache.value = value
        cache.at = Date.now()
        return value
      })
      .finally(() => {
        cache.pending = undefined
      })
    return cache.pending
  }

  const disposers = []
  const route = (pathname, handler, label) => {
    const dispose = webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          logger?.warn?.(`[companion] 模型接口失败（${pathname}）：${error?.message ?? error}`)
          if (!res.headersSent) sendError(res, 500, 'internal', String(error?.message ?? error))
        }
      },
    })
    disposers.push(dispose)
    return dispose
  }

  route(`${MODEL_ROUTE_PREFIX}/catalog`, async (req, res) => {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
    const data = await catalog()
    sendJson(res, 200, { ok: true, data })
  }, 'catalog')

  route(`${MODEL_ROUTE_PREFIX}/presets`, async (req, res) => {
    if (!presets) return sendError(res, 503, 'no-presets', '未配置快捷模型存储')
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, data: { presets: presets.list() } })
    }
    if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST')
    if (!isSameOrigin(req)) return sendError(res, 403, 'origin', '跨站请求被拒绝')
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error?.code ?? 'invalid-body', error?.message ?? '无效请求体')
    }
    let route
    try {
      route = normalizeSelection(body)
    } catch (error) {
      return sendError(res, 400, 'invalid-selection', error?.message ?? String(error))
    }
    try {
      const list = presets.add(route)
      logger?.info?.(`[companion] 已保存快捷模型 ${route.provider}/${route.model}`)
      return sendJson(res, 200, { ok: true, data: { presets: list } })
    } catch (error) {
      return sendError(res, 409, 'save-rejected', `快捷模型保存失败：${error?.message ?? error}`)
    }
  }, 'presets')

  route(`${MODEL_ROUTE_PREFIX}/default`, async (req, res) => {
    if (req.method === 'GET') {
      const selection = readDefaultSelection(ctx)
      if (!selection) return sendError(res, 503, 'no-default-model', 'Harness 没有可用的默认模型服务')
      return sendJson(res, 200, { ok: true, data: { selection } })
    }
    if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST')
    if (!isSameOrigin(req)) return sendError(res, 403, 'origin', '跨站请求被拒绝')
    const service = ctx?.get?.('agentDefaultModel')
    if (!service || typeof service.saveSelection !== 'function') {
      return sendError(res, 503, 'no-default-model', 'Harness 没有可用的默认模型服务')
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return sendError(res, 400, error?.code ?? 'invalid-body', error?.message ?? '无效请求体')
    }
    let next
    try {
      next = normalizeSelection(body)
    } catch (error) {
      return sendError(res, 400, 'invalid-selection', error?.message ?? String(error))
    }
    if (!isRegisteredProvider(ctx?.get?.('llm'), next.provider)) {
      return sendError(res, 400, 'unknown-provider', `未注册的模型提供方：${next.provider}`)
    }
    const current = readDefaultSelection(ctx)
    if (!next.reasoningEffort && current && current.provider === next.provider && current.model === next.model && current.reasoningEffort) {
      next.reasoningEffort = current.reasoningEffort
    }
    try {
      await service.saveSelection(next)
    } catch (error) {
      return sendError(res, 409, 'save-rejected', `默认模型保存失败：${error?.message ?? error}`)
    }
    const selection = readDefaultSelection(ctx) ?? next
    logger?.info?.(`[companion] Harness 默认模型已切换为 ${selection.provider}/${selection.model}`)
    return sendJson(res, 200, { ok: true, data: { selection } })
  }, 'default')

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // 已释放
        }
      }
    }, 'companion: model routes')
  }
  return disposers
}
