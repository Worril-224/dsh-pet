/**
 * 浏览器 HTTP 路由共用的最小工具：JSON 响应、JSON 请求体、同源校验。
 * 仅依赖 Node 内置能力，供 Host 侧插件注册 webServer 路由时使用。
 */

/** 默认请求体上限（64 KiB）。 */
export const DEFAULT_BODY_LIMIT = 64 * 1024

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 * @param {Record<string,string>} [extraHeaders]
 */
export function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * 读取并解析 JSON 请求体；空请求体返回 {}。
 * 解析失败抛出带 `code='invalid-json'` 的错误。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 */
export function readJsonBody(req, limit = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('请求体过大')
        error.code = 'body-too-large'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        const error = new Error('请求体不是合法 JSON')
        error.code = 'invalid-json'
        reject(error)
      }
    })
    req.on('error', (error) => reject(error))
  })
}

/**
 * 拒绝跨站写操作；没有 Origin（本机 curl / 测试）视为同源。
 * @param {import('node:http').IncomingMessage} req
 */
export function isSameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers?.host
  } catch {
    return false
  }
}

/**
 * 仅允许本机回环访问（用于不经过浏览器、直接访问 API 的场景）。
 * @param {import('node:http').IncomingMessage} req
 */
export function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 统一的错误响应结构。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
export function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } })
}

/**
 * 方法不允许。
 * @param {import('node:http').ServerResponse} res
 * @param {string} allow
 */
export function methodNotAllowed(res, allow) {
  sendError(res, 405, 'method', `method not allowed; use ${allow}`)
}
