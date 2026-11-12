/**
 * B站扫码登录（迁移自 dsh-bili-whale 的 QR 登录流程，MIT）。
 *
 * - 二维码内容只在服务端生成，前端拿到的是 SVG data URL；
 * - 登录成功后把 SESSDATA / bili_jct / buvid3 写入本角色 bilibili/account.json；
 * - 不把 Cookie 回传给页面；页面只显示 B 站昵称/UID。
 */
import { randomUUID } from 'node:crypto'
import qrcode from './qrcode-generator.js'

const PASSPORT = 'https://passport.bilibili.com'
const INTERVAL = 2000
const TTL = 180000
const terminal = new Set(['success', 'expired', 'cancelled', 'error'])

export class AuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthError'
  }
}

async function request(fetcher, url, { signal, credentials } = {}) {
  try {
    const response = await fetcher(url, {
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      headers: {
        'user-agent': 'Mozilla/5.0',
        referer: `${PASSPORT}/login`,
        ...(credentials
          ? {
              cookie: `SESSDATA=${credentials.sessdata}; bili_jct=${credentials.bili_jct}${
                credentials.buvid3 ? `; buvid3=${credentials.buvid3}` : ''
              }`,
            }
          : {}),
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    if (body.code !== 0) throw new Error(`code=${body.code}`)
    return { data: body.data, response }
  } catch (error) {
    throw new AuthError(signal?.aborted ? '登录已取消。' : 'B站登录请求失败，请稍后重试。')
  }
}

export function parseManualCookie(input = {}) {
  const raw = typeof input === 'string' ? input : String(input.cookie ?? input.raw ?? '')
  const values = {}
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) values[name] = value
  }
  return {
    sessdata: String(input.sessdata ?? values.SESSDATA ?? ''),
    bili_jct: String(input.bili_jct ?? values.bili_jct ?? ''),
    buvid3: String(input.buvid3 ?? values.buvid3 ?? ''),
  }
}

export function credentialsToCookie(credentials) {
  return [
    credentials.sessdata ? `SESSDATA=${credentials.sessdata}` : '',
    credentials.bili_jct ? `bili_jct=${credentials.bili_jct}` : '',
    credentials.buvid3 ? `buvid3=${credentials.buvid3}` : '',
  ]
    .filter(Boolean)
    .join('; ')
}

export async function verifyAccount(input, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  const credentials = parseManualCookie(input)
  const { data } = await request(fetcher, 'https://api.bilibili.com/x/web-interface/nav', { credentials, signal })
  if (data?.isLogin !== true || !/^[1-9]\d{0,19}$/u.test(String(data?.mid ?? ''))) {
    throw new AuthError('登录验证失败，旧登录态未替换。')
  }
  let name = typeof data.uname === 'string' ? data.uname.slice(0, 200) : ''
  for (const secret of Object.values(credentials)) {
    if (secret) name = name.split(secret).join('[redacted]')
  }
  return { mid: String(data.mid), name }
}

function renderQrDataUrl(url) {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  const svg = qr.createSvgTag({ cellSize: 6, margin: 4 })
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/** 一次只维护一个未完成扫码会话。 */
export class QrAuth {
  constructor({ save, fetch = globalThis.fetch, now = Date.now, render = renderQrDataUrl } = {}) {
    this.save = save
    this.fetch = fetch
    this.now = now
    this.render = render
    this.current = null
    this.nextStart = 0
    this.disposed = false
  }

  state(session) {
    return {
      id: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      ...(session.status === 'waiting' || session.status === 'scanned' ? { image: session.image } : {}),
      ...(session.account ? { account: session.account } : {}),
      ...(session.error ? { error: session.error } : {}),
    }
  }

  check(session) {
    if (this.disposed || this.current !== session || session.controller.signal.aborted) {
      throw new AuthError('登录流程已失效，请重新扫码。')
    }
    if (this.now() >= session.expiresAt) {
      session.status = 'expired'
      throw new AuthError('二维码已过期，请重新生成。')
    }
  }

  async start() {
    if (this.disposed) throw new AuthError('登录服务已关闭。')
    if (this.now() < this.nextStart) throw new AuthError('请稍等两秒后再生成二维码。')
    this.nextStart = this.now() + INTERVAL
    this.cancel()
    const session = {
      id: randomUUID(),
      status: 'waiting',
      controller: new AbortController(),
      expiresAt: this.now() + TTL,
      nextPoll: this.now() + INTERVAL,
    }
    this.current = session
    try {
      const { data } = await request(this.fetch, `${PASSPORT}/x/passport-login/web/qrcode/generate`, {
        signal: session.controller.signal,
      })
      this.check(session)
      let url
      try {
        url = new URL(data?.url)
      } catch {
        throw new AuthError('二维码响应无效，请稍后重试。')
      }
      if (
        ![PASSPORT, 'https://account.bilibili.com'].includes(url.origin) ||
        url.username ||
        url.password ||
        typeof data?.qrcode_key !== 'string' ||
        !/^[A-Za-z0-9_-]{1,256}$/u.test(data.qrcode_key)
      ) {
        throw new AuthError('二维码响应无效，请稍后重试。')
      }
      session.key = data.qrcode_key
      session.image = await this.render(url.href)
      this.check(session)
      return this.state(session)
    } catch (error) {
      session.status = session.controller.signal.aborted ? 'cancelled' : 'error'
      delete session.key
      delete session.image
      throw error instanceof AuthError ? error : new AuthError('二维码生成失败，请重试。')
    }
  }

  async poll(id) {
    const session = this.current
    if (!session || session.id !== id) throw new AuthError('登录流程已失效，请重新扫码。')
    if (terminal.has(session.status)) return this.state(session)
    if (this.now() >= session.expiresAt) {
      session.status = 'expired'
      session.controller.abort()
      delete session.key
      delete session.image
      return this.state(session)
    }
    if (session.flight) return session.flight
    if (this.now() < session.nextPoll) return this.state(session)
    session.nextPoll = this.now() + INTERVAL
    session.flight = this.pollOnce(session).finally(() => {
      session.flight = null
    })
    return session.flight
  }

  async pollOnce(session) {
    try {
      const url = new URL('/x/passport-login/web/qrcode/poll', PASSPORT)
      url.searchParams.set('qrcode_key', session.key)
      const { data, response } = await request(this.fetch, url, { signal: session.controller.signal })
      this.check(session)
      if (data?.code === 86101) session.status = 'waiting'
      else if (data?.code === 86090) session.status = 'scanned'
      else if (data?.code === 86038) session.status = 'expired'
      else if (data?.code === 0) {
        const values = {}
        const setCookies =
          typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : String(response.headers.get('set-cookie') ?? '').split(/,(?=[^;,]+=)/u)
        for (const cookie of setCookies) {
          const pair = cookie.split(';', 1)[0]
          const split = pair.indexOf('=')
          if (split <= 0) continue
          const name = pair.slice(0, split).trim()
          if (['SESSDATA', 'bili_jct', 'buvid3'].includes(name)) {
            values[name] = pair.slice(split + 1).trim()
          }
        }
        const credentials = parseManualCookie({
          sessdata: values.SESSDATA,
          bili_jct: values.bili_jct,
          buvid3: values.buvid3,
        })
        session.account = await this.save(credentials, {
          signal: session.controller.signal,
          check: () => this.check(session),
        })
        session.status = 'success'
      } else {
        throw new AuthError('无法识别登录状态，请重新扫码。')
      }
    } catch (error) {
      if (!terminal.has(session.status)) {
        session.status = session.controller.signal.aborted ? 'cancelled' : 'error'
        session.error = error instanceof AuthError ? error.message : '登录未保存，请重新扫码。'
      }
    }
    if (terminal.has(session.status)) {
      delete session.key
      delete session.image
    }
    return this.state(session)
  }

  cancel(id) {
    const session = this.current
    if (!session || (id && session.id !== id)) return { status: 'cancelled' }
    if (!terminal.has(session.status)) session.status = 'cancelled'
    session.controller.abort()
    delete session.key
    delete session.image
    return this.state(session)
  }

  dispose() {
    this.disposed = true
    this.cancel()
  }
}
