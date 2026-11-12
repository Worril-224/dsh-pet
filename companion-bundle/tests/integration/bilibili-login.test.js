/**
 * B站扫码登录页面/API 的路由注册测试（不发起真实 B站请求）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startBilibiliLoginServer } from '../../lib/bilibili/login-server.js'
import { QrAuth } from '../../lib/bilibili/auth.js'

function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers || {}
    },
    end(text) {
      state.body = String(text ?? '')
    },
  }
}

test('B4：扫码登录页面/账号 API 路由可注册且不泄露 Cookie', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-bili-login-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'characters', 'ophelia')
  const biliDir = path.join(dataDir, 'bilibili')
  fs.mkdirSync(biliDir, { recursive: true })
  const accountFile = path.join(biliDir, 'account.json')
  fs.writeFileSync(
    accountFile,
    JSON.stringify({
      cookie: 'SESSDATA=secret; bili_jct=secretcsrf',
      csrf: 'secretcsrf',
      selfUid: '123',
      selfName: '她的B站号',
      ownerUid: '789',
      ownerName: '主人',
      commentEnabled: false,
    }),
    'utf8',
  )

  const routes = []
  const webServer = {
    register(definition) {
      routes.push(definition)
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(fn) {
      const cleanup = fn()
      return () => cleanup?.()
    },
  }
  const watcher = { accountFile, reloadAccount: () => {} }
  const server = startBilibiliLoginServer(ctx, watcher, { info: () => {}, warn: () => {} })
  assert.ok(server)
  assert.ok(routes.length >= 5)

  const loginRoute = routes.find((route) => route.path === '/dsh-companion/bili/login')
  assert.ok(loginRoute)
  const pageRes = fakeResponse()
  await loginRoute.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, pageRes)
  assert.equal(pageRes.state.status, 200)
  assert.match(pageRes.state.body, /给奥菲莉亚登录 B站/)
  assert.doesNotMatch(pageRes.state.body, /secretcsrf/)

  const accountRoute = routes.find((route) => route.path === '/dsh-companion/bili/api/account')
  const accountRes = fakeResponse()
  await accountRoute.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, accountRes)
  const accountBody = JSON.parse(accountRes.state.body)
  assert.equal(accountBody.ok, true)
  assert.equal(accountBody.account.hasCookie, true)
  assert.equal(accountBody.account.self.mid, '123')
  assert.equal(accountBody.account.ownerUid, '789')
  assert.doesNotMatch(accountRes.state.body, /secret/)

  // 非本机请求拒绝
  const denied = fakeResponse()
  await loginRoute.handler({ method: 'GET', socket: { remoteAddress: '10.0.0.8' }, headers: {} }, denied)
  assert.equal(denied.state.status, 403)
})


test('B5：QR 登录生成/轮询/保存凭据（假 B站响应）', async () => {
  let now = 0
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/qrcode/generate')) {
      return {
        ok: true,
        headers: { getSetCookie: () => [] },
        async json() {
          return {
            code: 0,
            data: {
              url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc',
              qrcode_key: 'abc',
            },
          }
        },
      }
    }
    if (String(url).includes('/qrcode/poll')) {
      return {
        ok: true,
        headers: {
          getSetCookie: () => [
            'SESSDATA=sess-value; Path=/; HttpOnly',
            'bili_jct=jct-value; Path=/',
            'buvid3=buvid-value; Path=/',
          ],
        },
        async json() {
          return { code: 0, data: { code: 0 } }
        },
      }
    }
    throw new Error('unexpected ' + url)
  }
  let saved
  const auth = new QrAuth({
    fetch: fetchImpl,
    now: () => now,
    render: () => 'data:image/svg+xml;base64,PHN2Zw==',
    async save(credentials) {
      saved = credentials
      return { mid: '12345', name: '她的B站号' }
    },
  })
  const started = await auth.start()
  assert.equal(started.status, 'waiting')
  assert.match(started.image, /^data:image\/svg\+xml;base64,/)
  now = 3000
  const polled = await auth.poll(started.id)
  assert.equal(polled.status, 'success')
  assert.equal(polled.account.mid, '12345')
  assert.equal(saved.sessdata, 'sess-value')
  assert.equal(saved.bili_jct, 'jct-value')
  assert.equal(saved.buvid3, 'buvid-value')
  assert.ok(calls.some((url) => url.includes('/qrcode/poll')))
  auth.dispose()
})
