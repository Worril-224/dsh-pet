/**
 * B站观看：客户端 / 调度器测试（假 fetch、假 LLM、临时目录，不联网、不写真实数据）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanBilibiliText,
  createBilibiliClient,
  csrfFromCookie,
} from '../../lib/bilibili/client.js'
import {
  createBilibiliWatcher,
  resolveBilibiliConfig,
} from '../../lib/bilibili/watcher.js'
import { startBilibiliLoginServer } from '../../lib/bilibili/login-server.js'

function response(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return json
    },
  }
}

function fakeBiliFetch(overrides = {}) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const text = String(url)
    calls.push({ url: text, options })
    if (text.includes('/x/web-interface/search/type')) {
      const keyword = new URL(text).searchParams.get('keyword')
      return response({
        code: 0,
        data: {
          result: [
            {
              bvid: 'BV1aa411c7de',
              aid: '123',
              title: `<em class="keyword">图书馆</em>的一天`,
              description: '关于图书馆的纪录片',
              author: '档案UP',
              mid: '456',
              tag: '图书馆,读书,纪录片',
              play: 1000,
              duration: '10:00',
              pubdate: 1700000000,
              query: keyword,
            },
          ],
        },
      })
    }
    if (text.includes('/x/web-interface/view?')) {
      return response({
        code: 0,
        data: {
          bvid: 'BV1aa411c7de',
          aid: 123,
          cid: 789,
          title: '图书馆的一天',
          desc: '关于图书馆的纪录片',
          owner: { name: '档案UP', mid: 456 },
          pubdate: 1700000000,
          duration: 600,
          tname: '纪录片',
          pic: '',
        },
      })
    }
    if (text.includes('/x/tag/archive/tags')) {
      return response({ code: 0, data: [{ tag_name: '图书馆' }, { tag_name: '读书' }] })
    }
    if (text.includes('/x/player/v2')) {
      return response({
        code: 0,
        data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://sub.test/1.json' }] } },
      })
    }
    if (text === 'https://sub.test/1.json') {
      return response({ body: [{ content: '这是字幕内容，讲的是图书馆的一天。' }] })
    }
    if (text.includes('/view/conclusion/get')) {
      return response({ code: -403, message: '访问权限不足' })
    }
    if (text.includes('/x/v2/reply/add')) {
      return response({ code: 0, data: { rpid: 999, rpid_str: '999' } })
    }
    throw new Error(`未预期的 URL: ${text}`)
  }
  return { fetchImpl, calls, ...overrides }
}

test('B1：B站客户端搜索/详情/标签/字幕/评论参数', async () => {
  const { fetchImpl, calls } = fakeBiliFetch()
  const client = createBilibiliClient({ cookie: 'SESSDATA=abc; bili_jct=csrf123', fetchImpl })
  assert.equal(csrfFromCookie('SESSDATA=abc; bili_jct=csrf123'), 'csrf123')
  assert.equal(cleanBilibiliText('<em class="keyword">图书馆</em>&amp;档案'), '图书馆&档案')

  const rows = await client.searchVideos({ keyword: '图书馆', page: 1 })
  assert.equal(rows[0].bvid, 'BV1aa411c7de')
  assert.equal(rows[0].title, '图书馆的一天')
  assert.deepEqual(rows[0].tags, ['图书馆', '读书', '纪录片'])

  const material = await client.getVideoMaterial({ bvid: 'BV1aa411c7de' })
  assert.equal(material.aid, '123')
  assert.equal(material.cid, '789')
  assert.deepEqual(material.tags, ['图书馆', '读书'])
  assert.match(material.subtitle, /图书馆的一天/)

  const comment = await client.postComment({
    aid: '123',
    message: '@主人 讲得很有意思，推荐你看看',
    csrf: 'csrf123',
    ownerUid: '789',
    ownerName: '主人',
  })
  assert.equal(comment.replyId, 999)
  const addCall = calls.find((call) => call.url.includes('/x/v2/reply/add'))
  assert.equal(addCall.options.method, 'POST')
  assert.match(String(addCall.options.body), /csrf=csrf123/)
  assert.match(String(addCall.options.body), /message=%40/)
})

test('B2：配置夹取与调度器默认', () => {
  const config = resolveBilibiliConfig({
    dailyLimit: 999,
    sessionSize: 9,
    maxSessions: 0,
    startHour: 25,
    endHour: 3,
    commentEnabled: true,
    commentMinChars: 20,
    commentMaxChars: 10,
  })
  assert.equal(config.dailyLimit, 100)
  assert.equal(config.sessionSize, 9)
  assert.equal(config.maxSessions, 1)
  assert.equal(config.startHour, 23)
  assert.ok(config.endHour > config.startHour)
  assert.equal(config.commentEnabled, true)
  assert.ok(config.commentMaxChars >= config.commentMinChars)
})

test('B3：每次 5 个视频、写入短期记忆、评论限次、兴趣标签扩展', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-bilibili-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'characters', 'ophelia')
  const biliDir = path.join(dataDir, 'bilibili')
  fs.mkdirSync(biliDir, { recursive: true })
  fs.writeFileSync(
    path.join(biliDir, 'account.json'),
    JSON.stringify({
      cookie: 'SESSDATA=abc; bili_jct=csrf123',
      csrf: 'csrf123',
      ownerUid: '789',
      ownerName: '主人',
      commentEnabled: true,
    }),
    'utf8',
  )
  const remembered = []
  const comments = []
  const client = {
    async searchVideos({ keyword }) {
      return Array.from({ length: 8 }, (_, index) => ({
        bvid: `BV1${String(index).padStart(2, '0')}test`,
        aid: String(100 + index),
        title: `${keyword}纪录片 ${index}`,
        tag: `${keyword},纪录片`,
        tags: [keyword, '纪录片'],
        author: '测试UP',
      }))
    },
    async getVideoMaterial({ bvid }) {
      return {
        bvid,
        aid: '123',
        cid: '789',
        title: '图书馆的一天',
        description: '关于图书馆的纪录片',
        author: '测试UP',
        tags: ['图书馆', '读书'],
        subtitle: '字幕内容',
        aiSummary: '',
      }
    },
    async postComment({ aid, message }) {
      comments.push({ aid, message })
      return { replyId: comments.length }
    },
  }
  const llm = {
    prepareCall: async (config) => ({
      config: { ...config },
      stream: (options) => {
        const system = String(options.system ?? '')
        let text = '好的。'
        if (system.includes('感兴趣标签')) text = '["图书馆","读书","历史"]'
        else if (system.includes('整理成记忆')) text = '今天在B站看了一个关于图书馆的纪录片，讲得很安静。'
        else if (system.includes('是否让角色觉得有趣')) text = '{"interesting":true,"tags":["纪录片"],"reason":"节奏很舒服"}'
        else if (system.includes('评论区')) text = '讲得很有意思，推荐你看看'
        return (async function* () {
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }),
  }
  const watcher = createBilibiliWatcher({
    dataDir,
    persona: { renderPersonaSection: () => '【人设】奥菲莉亚' },
    memory: {
      renderDigest: () => '【记忆】主人喜欢雨天。',
      remember: (input) => remembered.push(input),
    },
    llm,
    clock: { now: () => new Date('2026-11-08T00:01:00+08:00').getTime() },
    config: {
      enabled: true,
      dailyLimit: 20,
      sessionSize: 5,
      maxSessions: 4,
      commentEnabled: true,
      commentMaxPerDay: 2,
      startHour: 0,
      endHour: 24,
      summaryMaxChars: 30000,
    },
    client,
  })
  const result = await watcher.runSession()
  assert.equal(result.ok, true)
  assert.equal(result.watched, 5)
  assert.equal(remembered.length, 5)
  assert.equal(remembered[0].source, 'bilibili')
  assert.equal(remembered[0].category, '事件')
  assert.match(remembered[0].content, /【我自己在B站刷到并分享给主人/)
    assert.equal(remembered[0].metadata.viewedBy, 'self')
  assert.ok(remembered[0].keywords.includes('奥菲莉亚'))
  assert.ok(remembered[0].keywords.includes('主人'))
  assert.deepEqual(remembered[0].metadata.who, ['奥菲莉亚', '主人'])
  assert.match(remembered[0].metadata.segments[0].who, /奥菲莉亚/u)
  assert.ok(remembered[0].content.length <= 30000)
  assert.equal(comments.length, 2, '评论应受每日上限约束')
  assert.match(comments[0].message, /^@主人 /)
  assert.ok(watcher.state().interests.includes('纪录片'))
  assert.equal(watcher.state().watchedToday.length, 5)
  assert.ok(watcher.state().nextSessionAt)
})
