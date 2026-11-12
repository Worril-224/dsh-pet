/**
 * B站扫码登录 Web 页面 + API。
 *
 * 页面：/dsh-companion/bili/login
 *  - 生成二维码（SVG data URL）
 *  - 轮询扫码状态
 *  - 登录成功后保存到角色 bilibili/account.json，并让 watcher 重新加载账号
 *  - 可填写主人 B站 UID/昵称，打开评论开关
 *
 * 只接受本机回环地址的请求；页面不会拿到 Cookie，Cookie 只写进数据目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { QrAuth, AuthError, credentialsToCookie, verifyAccount } from './auth.js'

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function html(res, value) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(value)
}

function isLocal(req) {
  const address = String(req.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>奥菲莉亚 · B站登录</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:620px;margin:40px auto;padding:0 18px}
h1{font-size:20px;margin:0 0 6px}
p,label{color:#666}
.card{border:1px solid #8884;border-radius:12px;padding:18px;margin:16px 0}
img.qr{width:240px;height:240px;display:block;margin:12px auto;background:#fff;border-radius:8px;padding:8px}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #8888;background:transparent;cursor:pointer}
button.primary{background:#2563eb;border-color:#2563eb;color:#fff}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
input[type=text]{font:inherit;padding:7px 9px;border-radius:8px;border:1px solid #8886;background:transparent;min-width:240px}
.hint{font-size:12px;color:#777}
.err{color:#c00}
.ok{color:#0a7a35}
</style>
</head>
<body>
<h1>给奥菲莉亚登录 B站</h1>
<p>用手机 B站 App 扫码，确认后账号会写入她的数据目录。二维码约 3 分钟有效。</p>
<div class="card">
  <div class="row"><button id="start" class="primary">生成登录二维码</button><span id="status">未开始</span></div>
  <div id="qrBox"></div>
  <div class="hint">如果二维码过期，点「重新生成」。</div>
</div>
<div class="card">
  <h2 style="font-size:16px;margin:0 0 6px">主人 B站账号（用于评论区 @）</h2>
  <div class="row"><label>主人 UID <input id="ownerUid" type="text" placeholder="纯数字 B站 UID"></label></div>
  <div class="row"><label>主人昵称 <input id="ownerName" type="text" placeholder="B站昵称"></label></div>
  <div class="row"><label><input id="commentEnabled" type="checkbox"> 允许她在有趣视频评论区 @ 我</label></div>
  <div class="row"><button id="save">保存主人信息</button><span id="saveStatus"></span></div>
  <div class="hint">评论会公开可见，默认关闭；确认 UID 后再打开。登录账号是“她”的 B站号，不是主人的号。</div>
</div>
<div class="card">
  <div>当前登录：<b id="self">未登录</b></div>
  <div class="hint">登录状态保存在角色目录 bilibili/account.json，页面不会显示 Cookie。</div>
</div>
<script>
const $ = (id) => document.getElementById(id)
let current = null
let timer = null
function setStatus(text, isError) { const el = $('status'); el.textContent = text; el.className = isError ? 'err' : (text.includes('成功') ? 'ok' : '') }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } })
  const data = await response.json().catch(() => ({ ok: false, error: 'invalid json' }))
  if (!response.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + response.status))
  return data
}
async function refreshAccount() {
  try {
    const data = await api('/dsh-companion/bili/api/account')
    const a = data.account || {}
    $('self').textContent = a.hasCookie ? (a.self.name ? a.self.name + '（' + a.self.mid + '）' : '已登录') : '未登录'
    $('ownerUid').value = a.ownerUid || ''
    $('ownerName').value = a.ownerName || '主人'
    $('commentEnabled').checked = a.commentEnabled === true
  } catch {}
}
async function poll() {
  if (!current) return
  try {
    const data = await api('/dsh-companion/bili/api/qr/poll', { method: 'POST', body: JSON.stringify({ id: current }) })
    const s = data.state
    if (s.status === 'waiting') setStatus('等待扫码…')
    else if (s.status === 'scanned') setStatus('已扫码，请在手机上确认…')
    else if (s.status === 'success') {
      setStatus('登录成功'); clearInterval(timer); timer = null; current = null; $('qrBox').innerHTML = ''
      await refreshAccount()
      return
    } else if (s.status === 'expired') { setStatus('二维码已过期，请重新生成', true); clearInterval(timer); timer = null; current = null; return }
    else if (s.status === 'cancelled') { setStatus('已取消'); clearInterval(timer); timer = null; current = null; return }
    else if (s.status === 'error') { setStatus(s.error || '登录失败', true); clearInterval(timer); timer = null; current = null; return }
  } catch (error) { setStatus(error.message, true); clearInterval(timer); timer = null; current = null }
}
$('start').onclick = async () => {
  try {
    setStatus('生成中…')
    const data = await api('/dsh-companion/bili/api/qr/start', { method: 'POST', body: '{}' })
    current = data.state.id
    if (data.state.image) $('qrBox').innerHTML = '<img class="qr" alt="B站登录二维码" src="' + data.state.image + '">'
    setStatus('等待扫码…')
    if (timer) clearInterval(timer)
    timer = setInterval(poll, 2000)
  } catch (error) { setStatus(error.message, true) }
}
$('save').onclick = async () => {
  try {
    $('saveStatus').textContent = '保存中…'
    await api('/dsh-companion/bili/api/account', { method: 'POST', body: JSON.stringify({
      ownerUid: $('ownerUid').value.trim(),
      ownerName: $('ownerName').value.trim(),
      commentEnabled: $('commentEnabled').checked,
    }) })
    $('saveStatus').textContent = '已保存'
    await refreshAccount()
  } catch (error) { $('saveStatus').textContent = error.message; $('saveStatus').className = 'err' }
}
refreshAccount()
</script>
</body>
</html>`

/**
 * 注册扫码登录页面与 API。
 * @param {any} ctx
 * @param {any} watcher
 * @param {object} logger
 * @returns {{qrAuth:QrAuth, routes:Function[]}|undefined}
 */
export function startBilibiliLoginServer(ctx, watcher, logger) {
  const webServer = ctx?.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    logger?.warn?.('[bilibili] 没有 webServer，扫码登录页面未挂载')
    return undefined
  }
  if (!watcher?.accountFile) return undefined

  const qrAuth = new QrAuth({
    async save(credentials) {
      const account = await verifyAccount(credentials)
      const current = readJson(watcher.accountFile, {})
      const cookie = credentialsToCookie(credentials)
      const next = {
        ...current,
        cookie,
        csrf: credentials.bili_jct || current.csrf || '',
        selfUid: account.mid,
        selfName: account.name,
        updatedAt: new Date().toISOString(),
      }
      // 保留用户已填的主人信息与评论开关；没有则给安全默认值
      if (!next.ownerName) next.ownerName = '主人'
      next.commentEnabled = current.commentEnabled === true
      writeJson(watcher.accountFile, next)
      watcher.reloadAccount?.()
      return account
    },
  })

  const routes = []
  const route = (pathname, handler) => {
    const dispose = webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        if (!isLocal(req) && !String(req.headers?.origin || '').startsWith('http://127.0.0.1:')) {
          json(res, 403, { ok: false, error: '只允许本机访问' })
          return
        }
        try {
          await handler(req, res)
        } catch (error) {
          logger?.warn?.(`[bilibili] 登录页面请求失败：${error?.message ?? error}`)
          try { json(res, 500, { ok: false, error: String(error?.message ?? error) }) } catch { /* ignore */ }
        }
      },
    })
    routes.push(dispose)
  }

  route('/dsh-companion/bili/login', async (req, res) => {
    if (req.method !== 'GET') return json(res, 405, { ok: false })
    html(res, PAGE)
  })

  route('/dsh-companion/bili/api/account', async (req, res) => {
    const current = readJson(watcher.accountFile, {})
    if (req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        account: {
          hasCookie: Boolean(current.cookie && !/在这里填/u.test(String(current.cookie))),
          self: { mid: current.selfUid ?? '', name: current.selfName ?? '' },
          ownerUid: current.ownerUid ?? '',
          ownerName: current.ownerName ?? '主人',
          commentEnabled: current.commentEnabled === true,
        },
      })
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false })
    const body = JSON.parse((await readBody(req)) || '{}')
    const ownerUid = String(body.ownerUid ?? '').trim()
    if (ownerUid && !/^\d{1,20}$/u.test(ownerUid)) return json(res, 400, { ok: false, error: '主人 UID 必须是纯数字' })
    const ownerName = String(body.ownerName ?? '').trim().slice(0, 60) || '主人'
    const currentAccount = readJson(watcher.accountFile, {})
    writeJson(watcher.accountFile, {
      ...currentAccount,
      ownerUid,
      ownerName,
      commentEnabled: body.commentEnabled === true,
    })
    watcher.reloadAccount?.()
    return json(res, 200, { ok: true })
  })

  route('/dsh-companion/bili/api/qr/start', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false })
    try {
      const state = await qrAuth.start()
      return json(res, 200, { ok: true, state })
    } catch (error) {
      return json(res, error instanceof AuthError ? 400 : 503, { ok: false, error: error?.message ?? String(error) })
    }
  })

  route('/dsh-companion/bili/api/qr/poll', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false })
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const state = await qrAuth.poll(String(body.id ?? ''))
      return json(res, 200, { ok: true, state })
    } catch (error) {
      return json(res, error instanceof AuthError ? 400 : 503, { ok: false, error: error?.message ?? String(error) })
    }
  })

  route('/dsh-companion/bili/api/qr/cancel', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false })
    const body = JSON.parse((await readBody(req)) || '{}')
    return json(res, 200, { ok: true, state: qrAuth.cancel(String(body.id ?? '')) })
  })

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      try { qrAuth.dispose() } catch { /* ignore */ }
      for (const dispose of routes) {
        try { dispose?.() } catch { /* ignore */ }
      }
    })
  }
  logger?.info?.('[bilibili] 扫码登录页面：/dsh-companion/bili/login')
  return { qrAuth, routes }
}
