/**
 * Bilibili 公开 API 客户端（只依赖 Node 内置 fetch）。
 *
 * 设计：
 *  - 搜索 / 视频详情 / 标签 / 字幕 / 评论分别独立方法，便于测试注入 fetchImpl；
 *  - 需要登录的能力（字幕、AI 总结、发评论）由调用方传入 Cookie + CSRF；
 *  - 所有返回值都做轻量规范化，不把 B站原始 JSON 直接交给上层。
 */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'

const execFileAsync = promisify(execFile)

export class BilibiliError extends Error {
  constructor(message, code, data) {
    super(message)
    this.name = 'BilibiliError'
    this.code = code
    this.data = data
  }
}

/** 去掉 B站搜索标题里的 <em> 高亮，压缩空白。 */
export function cleanBilibiliText(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从 Cookie 字符串里取 bili_jct（CSRF token）。 */
export function csrfFromCookie(cookie) {
  const match = /(?:^|;\s*)bili_jct=([^;]+)/u.exec(String(cookie ?? ''))
  return match ? match[1] : ''
}

/** B站 aid 可能是数字或字符串；统一成数字字符串。 */
export function normalizeAid(value) {
  if (value === null || value === undefined) return ''
  const text = String(value).trim()
  return /^\d+$/u.test(text) ? text : ''
}

/** B站 WAF 常拦截 Node 原生 fetch（HTTP 412），Windows 下用系统 curl 更稳。 */
async function curlJson(url, { method = 'GET', body, headers = {}, timeoutMs = 20000 } = {}) {
  const args = ['-sS', '--max-time', String(Math.max(3, Math.ceil(timeoutMs / 1000))), '-w', '\n%{http_code}']
  if (method !== 'GET') args.push('-X', method)
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    args.push('-H', `${key}: ${value}`)
  }
  if (body !== undefined) args.push('--data-raw', String(body))
  args.push(url)
  const command = process.platform === 'win32' ? 'curl.exe' : 'curl'
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    timeout: Math.max(5000, timeoutMs + 5000),
  })
  const text = String(stdout ?? '')
  const split = text.lastIndexOf('\n')
  const statusText = split >= 0 ? text.slice(split + 1).trim() : ''
  const jsonText = split >= 0 ? text.slice(0, split) : text
  const status = Number(statusText) || 0
  if (status < 200 || status >= 300) {
    throw new BilibiliError(`B站请求失败（HTTP ${status || '?'}）`, 'HTTP_ERROR', { status })
  }
  try {
    return JSON.parse(jsonText)
  } catch (error) {
    throw new BilibiliError(`B站返回不是 JSON：${error?.message ?? error}`, 'INVALID_JSON')
  }
}

/**
 * 创建客户端。
 * @param {object} [options]
 * @param {string} [options.cookie]
 * @param {string} [options.userAgent]
 * @param {Function} [options.fetchImpl] 测试注入；默认使用系统 curl（B站会拦 Node fetch 412）
 * @param {boolean} [options.curlFallback]
 * @param {number} [options.timeoutMs]
 */
export function createBilibiliClient({
  cookie = '',
  userAgent = DEFAULT_UA,
  fetchImpl,
  curlFallback = true,
  timeoutMs = 20000,
} = {}) {
  const anonymousBuvid = `${randomUUID()}-infoc`

  function cookieHeader() {
    const value = String(cookie ?? '').trim()
    if (/(?:^|;\s*)buvid3=/u.test(value)) return value
    return value ? `${value}; buvid3=${anonymousBuvid}` : `buvid3=${anonymousBuvid}`
  }

  function headers(extra = {}) {
    const result = {
      'User-Agent': userAgent,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...extra,
    }
    result.Cookie = cookieHeader()
    return result
  }

  async function requestJsonUrl(url, { method = 'GET', body, extraHeaders } = {}) {
    const requestHeaders = headers(extraHeaders)
    if (typeof fetchImpl === 'function') {
      try {
        const signal =
          typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(Math.max(3000, timeoutMs)) : undefined
        const response = await fetchImpl(url, { method, headers: requestHeaders, body, signal })
        if (!response || !response.ok) {
          throw new BilibiliError(`B站请求失败（HTTP ${response?.status ?? '?'}）`, 'HTTP_ERROR', {
            status: response?.status,
          })
        }
        try {
          return await response.json()
        } catch (error) {
          throw new BilibiliError(`B站返回不是 JSON：${error?.message ?? error}`, 'INVALID_JSON')
        }
      } catch (error) {
        if (!curlFallback || error?.code !== 'HTTP_ERROR' || error?.data?.status !== 412) throw error
      }
    }
    return curlJson(url, { method, body, headers: requestHeaders, timeoutMs })
  }

  async function requestJson(url, options = {}) {
    const payload = await requestJsonUrl(url, options)
    if (!payload || typeof payload !== 'object') throw new BilibiliError('B站返回为空', 'EMPTY_RESPONSE')
    if (payload.code !== 0) {
      throw new BilibiliError(
        `B站接口错误（code=${payload.code}）：${payload.message || '未知错误'}`,
        'API_ERROR',
        payload,
      )
    }
    return payload.data
  }

  /** 搜索视频（公开接口）。 */
  async function searchVideos({ keyword, page = 1, pageSize = 20 } = {}) {
    const query = String(keyword ?? '').trim()
    if (!query) return []
    const url = new URL('https://api.bilibili.com/x/web-interface/search/type')
    url.searchParams.set('search_type', 'video')
    url.searchParams.set('keyword', query)
    url.searchParams.set('page', String(Math.max(1, Math.round(page))))
    url.searchParams.set('page_size', String(Math.max(1, Math.min(50, Math.round(pageSize)))))
    const data = await requestJson(url.toString())
    const rows = Array.isArray(data?.result) ? data.result : []
    return rows
      .filter((row) => row && typeof row === 'object' && row.bvid)
      .map((row) => ({
        bvid: String(row.bvid),
        aid: normalizeAid(row.aid),
        title: cleanBilibiliText(row.title),
        description: cleanBilibiliText(row.description),
        author: cleanBilibiliText(row.author),
        mid: normalizeAid(row.mid),
        tag: cleanBilibiliText(row.tag),
        tags: cleanBilibiliText(row.tag)
          .split(/[,，]/u)
          .map((item) => item.trim())
          .filter(Boolean),
        play: Number(row.play) || 0,
        duration: cleanBilibiliText(row.duration),
        pubdate: Number(row.pubdate) || 0,
        query,
      }))
  }

  /** 视频详情（公开接口）。 */
  async function getVideo({ bvid } = {}) {
    const id = String(bvid ?? '').trim()
    if (!id) throw new BilibiliError('缺少 bvid', 'MISSING_BVID')
    const url = new URL('https://api.bilibili.com/x/web-interface/view')
    url.searchParams.set('bvid', id)
    const data = await requestJson(url.toString())
    return {
      bvid: String(data?.bvid ?? id),
      aid: normalizeAid(data?.aid),
      cid: normalizeAid(data?.cid),
      title: cleanBilibiliText(data?.title),
      description: cleanBilibiliText(data?.desc),
      author: cleanBilibiliText(data?.owner?.name),
      mid: normalizeAid(data?.owner?.mid),
      pubdate: Number(data?.pubdate) || 0,
      duration: Number(data?.duration) || 0,
      tags: [],
      tname: cleanBilibiliText(data?.tname),
      pic: typeof data?.pic === 'string' ? data.pic : '',
    }
  }

  /** 视频标签（公开接口）。 */
  async function getTags({ bvid } = {}) {
    const id = String(bvid ?? '').trim()
    if (!id) return []
    const url = new URL('https://api.bilibili.com/x/tag/archive/tags')
    url.searchParams.set('bvid', id)
    try {
      const data = await requestJson(url.toString())
      return Array.isArray(data)
        ? data
            .map((tag) => cleanBilibiliText(tag?.tag_name))
            .filter(Boolean)
            .slice(0, 20)
        : []
    } catch {
      return []
    }
  }

  /** 字幕（需要登录；没有则返回空）。 */
  async function getSubtitle({ bvid, cid } = {}) {
    if (!cookie) return { text: '', source: 'none' }
    const params = new URLSearchParams({ bvid: String(bvid ?? ''), cid: String(cid ?? '') })
    try {
      const data = await requestJson(
        `https://api.bilibili.com/x/player/v2?${params.toString()}`,
        { extraHeaders: { 'Referer': `https://www.bilibili.com/video/${bvid}` } },
      )
      const subtitles = Array.isArray(data?.subtitle?.subtitles) ? data.subtitle.subtitles : []
      if (subtitles.length === 0) return { text: '', source: 'none' }
      const preferred =
        subtitles.find((item) => String(item?.lan ?? '').startsWith('zh')) ?? subtitles[0]
      const url = typeof preferred?.subtitle_url === 'string' ? preferred.subtitle_url : ''
      if (!url) return { text: '', source: 'none' }
      const full = url.startsWith('http') ? url : `https:${url}`
      const subtitle = await requestJsonUrl(full)
      const body = Array.isArray(subtitle?.body) ? subtitle.body : []
      const text = body
        .map((item) => String(item?.content ?? '').trim())
        .filter(Boolean)
        .join('\n')
      return { text: text.slice(0, 30000), source: 'subtitle' }
    } catch {
      return { text: '', source: 'none' }
    }
  }

  /** B站 AI 总结（需要登录；失败返回空）。 */
  async function getAiSummary({ bvid, cid, upMid } = {}) {
    if (!cookie) return { text: '', source: 'none' }
    const params = new URLSearchParams({
      bvid: String(bvid ?? ''),
      cid: String(cid ?? ''),
      up_mid: String(upMid ?? ''),
    })
    try {
      const data = await requestJson(`https://api.bilibili.com/x/web-interface/view/conclusion/get?${params.toString()}`, {
        extraHeaders: { Referer: `https://www.bilibili.com/video/${bvid}` },
      })
      const summary = typeof data?.summary === 'string' ? data.summary : ''
      return summary ? { text: cleanBilibiliText(summary).slice(0, 30000), source: 'ai-summary' } : { text: '', source: 'none' }
    } catch {
      return { text: '', source: 'none' }
    }
  }

  /** 热门评论（公开接口，用作字幕不可用时的视频内容线索）。 */
  async function getComments({ aid, pageSize = 10 } = {}) {
    const oid = normalizeAid(aid)
    if (!oid) return []
    const params = new URLSearchParams({
      type: '1',
      oid,
      sort: '2',
      pn: '1',
      ps: String(Math.max(1, Math.min(20, Math.round(pageSize)))),
    })
    try {
      const data = await requestJson(`https://api.bilibili.com/x/v2/reply?${params.toString()}`)
      const replies = Array.isArray(data?.replies) ? data.replies : []
      return replies
        .map((item) => cleanBilibiliText(item?.content?.message))
        .filter(Boolean)
        .slice(0, 20)
    } catch {
      return []
    }
  }

  /** 获取完整视频素材（详情 + 标签 + 登录可用时的字幕/AI 总结 + 热门评论）。 */
  async function getVideoMaterial({ bvid } = {}) {
    const detail = await getVideo({ bvid })
    const [tags, subtitle, aiSummary, comments] = await Promise.all([
      getTags({ bvid: detail.bvid }),
      getSubtitle({ bvid: detail.bvid, cid: detail.cid }),
      getAiSummary({ bvid: detail.bvid, cid: detail.cid, upMid: detail.mid }),
      getComments({ aid: detail.aid }),
    ])
    return {
      ...detail,
      tags: tags.length > 0 ? tags : detail.tname ? [detail.tname] : [],
      subtitle: subtitle.text,
      aiSummary: aiSummary.text,
      comments,
    }
  }

  /** 发评论（必须已登录；@ 主人由调用方生成 message）。 */
  async function postComment({ aid, message, csrf = csrfFromCookie(cookie), ownerUid, ownerName } = {}) {
    const oid = normalizeAid(aid)
    const msg = String(message ?? '').trim()
    const token = String(csrf ?? '').trim()
    if (!oid) throw new BilibiliError('缺少视频 aid', 'MISSING_AID')
    if (!msg) throw new BilibiliError('评论内容为空', 'EMPTY_COMMENT')
    if (!cookie) throw new BilibiliError('未配置 B站 Cookie，无法发评论', 'NO_COOKIE')
    if (!token) throw new BilibiliError('未配置 bili_jct / csrf，无法发评论', 'NO_CSRF')
    const body = new URLSearchParams({
      oid,
      type: '1',
      message: msg,
      plat: '1',
      csrf: token,
    })
    if (ownerUid && normalizeAid(ownerUid)) {
      body.set('at_name_to_mid', JSON.stringify({ [String(ownerName || '主人')]: normalizeAid(ownerUid) }))
    }
    const data = await requestJson('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST',
      body: body.toString(),
      extraHeaders: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `https://www.bilibili.com/video/${aid}`,
        Origin: 'https://www.bilibili.com',
      },
    })
    return {
      rpid: data?.rpid_str ?? data?.rpid,
      replyId: data?.rpid,
      message: data?.message ?? 'ok',
    }
  }

  /** 检查登录状态（可选；网络失败时抛错）。 */
  async function getNav() {
    const data = await requestJson('https://api.bilibili.com/x/web-interface/nav')
    return {
      isLogin: data?.isLogin === true,
      mid: normalizeAid(data?.mid),
      uname: cleanBilibiliText(data?.uname),
    }
  }

  return {
    searchVideos,
    getVideo,
    getTags,
    getSubtitle,
    getAiSummary,
    getComments,
    getVideoMaterial,
    postComment,
    getNav,
  }
}
