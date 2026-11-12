/**
 * QQ 聊天模型切换 Web API。
 *
 * companion-qq 持有正在运行的回复引擎，所以由它自己注册路由：
 *  - GET  读取当前生效模型、来源（覆盖文件 / 插件配置）与回退配置；
 *  - POST 切换并立即生效（写入角色目录 qq/reply-model.json，不重载插件、不断线）；
 *  - POST reset 删除覆盖文件，回到插件配置里的模型。
 */
import { sendJson, sendError, readJsonBody, isSameOrigin, methodNotAllowed } from './shared/http.js'
import { normalizeSelection } from './model-control.js'

/** 本插件占用的路由前缀。 */
export const QQ_MODEL_ROUTE_PREFIX = '/dsh-companion/qq/model'

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
 * 在 webServer 可用后注册 QQ 模型路由。
 *
 * 冷启动时 companion-qq 可能先于 webServer 激活；此时先等 webServer，
 * 避免 QQ 面板在重启后一直 404。webServer 已存在时立即注册。
 * @param {any} ctx Host 插件上下文
 * @param {any} host createQQHost 返回的运行时
 * @param {{logger?:any, webServer?:any}} [options]
 */
export function attachQQModelRoutes(ctx, host, options = {}) {
  const webServer = options.webServer ?? ctx?.get?.('webServer')
  if (webServer && typeof webServer.register === 'function') {
    return registerQQModelRoutes(ctx, host, { ...options, webServer })
  }
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      registerQQModelRoutes(webCtx, host, options)
    })
  }
  return []
}

/**
 * 注册 QQ 模型路由。
 * @param {any} ctx Host 插件上下文
 * @param {any} host createQQHost 返回的运行时
 * @param {{logger?:any, webServer?:any}} [options]
 * @returns {Array<() => void>}
 */
export function registerQQModelRoutes(ctx, host, options = {}) {
  const webServer = options.webServer ?? ctx?.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') return []
  const logger = options.logger

  const disposers = []
  const route = (pathname, handler, label) => {
    const dispose = webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          logger?.warn?.(`[qq] 模型接口失败（${pathname}）：${error?.message ?? error}`)
          if (!res.headersSent) sendError(res, 500, 'internal', String(error?.message ?? error))
        }
      },
    })
    disposers.push(dispose)
    return dispose
  }

  route(QQ_MODEL_ROUTE_PREFIX, async (req, res) => {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, data: host.getReplyModelState() })
    }
    if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST')
    if (!isSameOrigin(req)) return sendError(res, 403, 'origin', '跨站请求被拒绝')
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
    try {
      const data = host.setReplyModel(next)
      return sendJson(res, 200, { ok: true, data })
    } catch (error) {
      return sendError(res, 409, 'save-rejected', `QQ 模型保存失败：${error?.message ?? error}`)
    }
  }, 'qq-model')

  route(`${QQ_MODEL_ROUTE_PREFIX}/reset`, async (req, res) => {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
    if (!isSameOrigin(req)) return sendError(res, 403, 'origin', '跨站请求被拒绝')
    try {
      const data = host.resetReplyModel()
      return sendJson(res, 200, { ok: true, data })
    } catch (error) {
      return sendError(res, 409, 'reset-rejected', `恢复配置模型失败：${error?.message ?? error}`)
    }
  }, 'qq-model-reset')

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // 已释放
        }
      }
    }, 'qq: model routes')
  }
  return disposers
}
