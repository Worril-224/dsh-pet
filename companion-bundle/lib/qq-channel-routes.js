/**
 * QQ 接入通道的 Web API。
 *
 * 模型面板通过它：
 *  - 读取当前走 NapCat 还是 QQ 官方机器人；
 *  - 切换通道（必要时保存 AppID / AppSecret 并重连）；
 *  - 批准 / 拒绝第一次私聊时发现的 QQ 官方 openid。
 *
 * 通道切换、凭据保存与适配器重连都由 companion-qq 运行时完成，
 * 因此这里只做 HTTP 参数校验和转发。
 */
import { sendJson, sendError, readJsonBody, isSameOrigin, methodNotAllowed } from './shared/http.js'

/** 本插件占用的路由前缀。 */
export const QQ_CHANNEL_ROUTE_PREFIX = '/dsh-companion/qq/channel'

/** 只接受这两个通道 id。 */
function normalizeChannelId(value) {
  return value === 'napcat' || value === 'qqbot' ? value : undefined
}

/**
 * 在 webServer 可用后注册 QQ 通道路由。
 * @param {any} ctx Host 插件上下文
 * @param {any} host createQQHost 返回的运行时
 * @param {{logger?:any, webServer?:any}} [options]
 */
export function attachQQChannelRoutes(ctx, host, options = {}) {
  const webServer = options.webServer ?? ctx?.get?.('webServer')
  if (webServer && typeof webServer.register === 'function') {
    return registerQQChannelRoutes(ctx, host, { ...options, webServer })
  }
  if (typeof ctx?.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      registerQQChannelRoutes(webCtx, host, options)
    })
  }
  return []
}

/**
 * 注册 QQ 通道路由。
 * @param {any} ctx Host 插件上下文
 * @param {any} host createQQHost 返回的运行时
 * @param {{logger?:any, webServer?:any}} [options]
 * @returns {Array<() => void>}
 */
export function registerQQChannelRoutes(ctx, host, options = {}) {
  const webServer = options.webServer ?? ctx?.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') return []
  const logger = options.logger

  async function readBody(req, res) {
    try {
      return await readJsonBody(req)
    } catch (error) {
      sendError(res, 400, error?.code ?? 'invalid-body', error?.message ?? '无效请求体')
      return undefined
    }
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
          logger?.warn?.(`[qq] 通道接口失败（${pathname}）：${error?.message ?? error}`)
          if (!res.headersSent) sendError(res, 500, 'internal', String(error?.message ?? error))
        }
      },
    })
    disposers.push(dispose)
    return dispose
  }

  route(QQ_CHANNEL_ROUTE_PREFIX, async (req, res) => {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, data: host.getChannelState() })
    }
    if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST')
    if (!isSameOrigin(req)) return sendError(res, 403, 'origin', '跨站请求被拒绝')
    const body = await readBody(req, res)
    if (body === undefined) return
    const channel = normalizeChannelId(body.channel)
    if (!channel) return sendError(res, 400, 'invalid-channel', 'channel 必须是 napcat 或 qqbot')
    try {
      const data = await host.setChannel(channel, body.qqbot !== undefined ? { qqbot: body.qqbot } : {})
      return sendJson(res, 200, { ok: true, data })
    } catch (error) {
      return sendError(res, 409, 'switch-rejected', `切换 QQ 通道失败：${error?.message ?? error}`)
    }
  }, 'qq-channel')

  route(`${QQ_CHANNEL_ROUTE_PREFIX}/allow`, async (req, res) => {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
    if (!isSameOrigin(req)) return sendError(res, 403, 'origin', '跨站请求被拒绝')
    const body = await readBody(req, res)
    if (body === undefined) return
    try {
      const data = host.allowQQBotUser(body.openid)
      return sendJson(res, 200, { ok: true, data })
    } catch (error) {
      return sendError(res, 400, 'invalid-openid', String(error?.message ?? error))
    }
  }, 'qq-channel-allow')

  route(`${QQ_CHANNEL_ROUTE_PREFIX}/deny`, async (req, res) => {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
    if (!isSameOrigin(req)) return sendError(res, 403, 'origin', '跨站请求被拒绝')
    const body = await readBody(req, res)
    if (body === undefined) return
    try {
      const data = host.denyQQBotUser(body.openid)
      return sendJson(res, 200, { ok: true, data })
    } catch (error) {
      return sendError(res, 400, 'invalid-openid', String(error?.message ?? error))
    }
  }, 'qq-channel-deny')

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          // 已释放
        }
      }
    }, 'qq: channel routes')
  }
  return disposers
}
