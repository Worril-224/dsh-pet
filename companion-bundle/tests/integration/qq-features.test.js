/**
 * 新功能验收（QQ 渠道）：
 *  QC8 图片/表情包解析与视觉附件、QC9 多气泡拆分、QC10 联网搜索、
 *  QC11 图片输入消息构造、QC12 端到端多气泡/图片、QC13 配置。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildOneBotSendAction,
  extractFaceNames,
  extractImageAttachments,
  parseOneBotMessageEvent,
} from '../../lib/im/onebot.js'
import { faceName } from '../../lib/im/qq-face.js'
import { splitBubbles } from '../../lib/im/bubbles.js'
import {
  buildReplyPrompts,
  createReplyEngine,
  detectWebSearchQuery,
  renderWebSearchContext,
} from '../../lib/im/reply-engine.js'
import {
  detectImageMediaType,
  loadImageBytes,
  prepareImageRefs,
} from '../../lib/im/vision.js'
import { createQQHost, normalizeConfig } from '../../lib/qq-host.js'

const BOT_QQ = '123456789'
const OWNER_QQ = '10001'
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

function event(overrides = {}) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: Number(BOT_QQ),
    user_id: Number(OWNER_QQ),
    message_id: 2001,
    time: 1793900000,
    raw_message: '',
    message: [],
    sender: { nickname: '主人' },
    ...overrides,
  }
}

function fakePersona() {
  return {
    renderPersonaSection: () => '【人设】奥菲莉亚',
    lookup: () => ({ ok: false }),
  }
}
function fakeMemory() {
  return { renderDigest: () => '【记忆】主人喜欢雨天。' }
}
function fakeLlm(capture) {
  return {
    prepareCall: async (config) => {
      capture.prepare = config
      return {
        config: { ...config },
        stream: (options) => {
          capture.options = options
          return (async function* () {
            yield { type: 'text-delta', text: '第一段。\n\n第二段，带 https://x.com 链接。\n第三段。' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
}
function imageSeg() {
  return { type: 'image', data: { url: 'http://127.0.0.1:9/a.png', file: 'a.png', summary: '[图片]' } }
}

test('QC8：图片/表情包解析（image/mface/face，纯图片消息不再被丢弃）', () => {
  const imageOnly = parseOneBotMessageEvent(event({ message: [imageSeg()] }), { selfId: BOT_QQ })
  assert.ok(imageOnly)
  assert.equal(imageOnly.text, '[图片]')
  assert.equal(imageOnly.meta.images.length, 1)
  assert.equal(imageOnly.meta.images[0].url, 'http://127.0.0.1:9/a.png')

  const faceOnly = parseOneBotMessageEvent(event({ message: [{ type: 'face', data: { id: 1 } }] }), { selfId: BOT_QQ })
  assert.equal(faceOnly.text, '[表情：微笑]')
  assert.deepEqual(faceOnly.meta.faces, ['微笑'])

  const sticker = parseOneBotMessageEvent(
    event({ message: [{ type: 'mface', data: { summary: '[动画表情]', url: 'http://x/s.gif' } }] }),
    { selfId: BOT_QQ },
  )
  assert.equal(sticker.meta.images.length, 1)

  const segments = [{ type: 'image', data: { url: 'u' } }, { type: 'face', data: { id: 14 } }]
  assert.equal(extractImageAttachments(segments).length, 1)
  assert.deepEqual(extractFaceNames(segments), ['呲牙'])
  assert.equal(faceName(9999), '表情#9999')
})

test('QC9：多气泡拆分（换行/空行/超长/数量上限）', () => {
  assert.deepEqual(splitBubbles('第一段\n\n第二段\n第三段'), ['第一段', '第二段', '第三段'])
  assert.deepEqual(splitBubbles('  \n \n'), [])
  const long = `${'很长的句子。'.repeat(80)}`
  const bubbles = splitBubbles(long, { maxCharsPerBubble: 100 })
  assert.ok(bubbles.length > 1)
  assert.ok(bubbles.every((bubble) => bubble.length <= 100))
  const many = splitBubbles(Array.from({ length: 10 }, (_, i) => `第${i}段`).join('\n'), { maxBubbles: 3 })
  assert.equal(many.length, 3)
  assert.match(many[2], /第2段.*第9段/)
})

test('QC10：联网搜索意图识别、结果注入、失败降级', async () => {
  assert.equal(detectWebSearchQuery('帮我查一下明天上海天气'), '明天上海天气')
  assert.equal(detectWebSearchQuery('搜索 Vue 3 组合式 API 教程'), 'Vue 3 组合式 API 教程')
  assert.equal(detectWebSearchQuery('你好呀'), undefined)
  assert.equal(detectWebSearchQuery('查一下'), undefined)
  const text = renderWebSearchContext({
    content: '摘要内容',
    sources: [{ title: '来源一', url: 'https://example.com/a', snippet: '片段一' }],
  })
  assert.match(text, /来源一/)
  assert.match(text, /片段一/)
  assert.doesNotMatch(text, /https?:\/\//)

  const capture = {}
  const searched = []
  const engine = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm(capture),
    web: {
      search: async ({ query }) => {
        searched.push(query)
        return { content: '搜索摘要', sources: [{ title: '资料甲', url: 'https://x.test', snippet: '资料片段' }] }
      },
    },
    modelSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const reply = await engine.generate({ text: '帮我搜一下 DeepSeek 最新消息' })
  assert.equal(searched.length, 1)
  assert.match(reply.system, /联网检索结果/)
  assert.match(reply.system, /资料甲/)
  assert.equal(reply.webSearchUsed, true)
  assert.doesNotMatch(reply.text, /https?:\/\//)
  assert.deepEqual(reply.text.split('\n').filter(Boolean), ['第一段。', '第二段，带  链接。', '第三段。'])

  const failing = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm({}),
    web: { search: async () => { throw new Error('network down') } },
    modelSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const failedReply = await failing.generate({ text: '帮我查一下最新新闻' })
  assert.match(failedReply.system, /检索失败\/超时/)
  assert.equal(failedReply.webSearchUsed, false)
})

test('QC11：图片字节/附件/视觉消息构造', async () => {
  assert.equal(detectImageMediaType(PNG_BYTES), 'image/png')
  const fromData = await loadImageBytes({ url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` })
  assert.equal(fromData.mediaType, 'image/png')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-vision-'))
  try {
    const file = path.join(tmp, 'x.png')
    fs.writeFileSync(file, PNG_BYTES)
    const fromFile = await loadImageBytes({ file })
    assert.equal(fromFile.mediaType, 'image/png')
    const saved = []
    const prepared = await prepareImageRefs([{ url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` }], {
      attachments: {
        saveImages: async (inputs) => {
          saved.push(...inputs)
          return [{ attachmentId: 'sha256:test', mediaType: inputs[0].mediaType }]
        },
      },
    })
    assert.equal(prepared.refs.length, 1)
    assert.equal(saved[0].mediaType, 'image/png')
    assert.ok(saved[0].data instanceof Uint8Array, '附件服务要求 Uint8Array 字节')
    assert.equal(Buffer.from(saved[0].data).subarray(0, 4).toString('hex'), '89504e47')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const capture = {}
  const ref = { attachmentId: 'sha256:abc', mediaType: 'image/png' }
  const engine = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm(capture),
    modelSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const reply = await engine.generate({ text: '看看这个', images: [ref] })
  const content = capture.options.messages[0].content
  assert.equal(content.some((block) => block.type === 'image' && block.attachment === ref), true)
  assert.match(reply.system, /附带了 1 张图片/)
  assert.match(reply.text, /第一段/)
})

test('QC12：QQ Host 多气泡发送 + 图片识别入参 + 群聊仅首条 @', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-qq-features-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sent = []
  const generateCalls = []
  const adapter = {
    id: 'fake-adapter',
    start: async () => ({ state: 'running' }),
    stop: async () => ({ state: 'stopped' }),
    send: async (outbound) => {
      sent.push(outbound)
      return { delivered: true }
    },
    status: () => ({ state: 'running' }),
  }
  const memory = { ensure() {}, renderDigest: () => 'd', ingestMessage: () => ({ created: [], mentioned: [] }) }
  const host = createQQHost({
    config: {
      charactersDir: path.join(root, 'characters'),
      characterId: 'ophelia',
      botQQ: BOT_QQ,
      allowUsers: [OWNER_QQ],
      bubbleDelayMs: 0,
      imageMaxCount: 2,
    },
    deps: {
      persona: fakePersona(),
      memory,
      adapter,
      attachments: {
        saveImages: async (inputs) => inputs.map((input, index) => ({ attachmentId: `sha256:img-${index}`, mediaType: input.mediaType })),
      },
      replyEngine: {
        generate: async (input) => {
          generateCalls.push(input)
          return { text: '第一段\n第二段\n第三段', webSearchUsed: false }
        },
      },
    },
  })
  const base = {
    id: 'm-1',
    channel: 'qq',
    adapterId: adapter.id,
    userId: OWNER_QQ,
    text: '[图片]',
    receivedAt: Date.now(),
    meta: {
      groupId: '998877',
      images: [{ buffer: PNG_BYTES, mediaType: 'image/png' }],
      faces: ['微笑'],
    },
  }
  const result = await host.handleInbound(base)
  assert.equal(result.accepted, true)
  assert.equal(result.bubbles.length, 3)
  assert.equal(sent.length, 3)
  assert.deepEqual(sent.map((item) => item.text), ['第一段', '第二段', '第三段'])
  assert.equal(sent[0].meta.mention, true)
  assert.equal(sent[1].meta.mention, false)
  assert.equal(sent[2].meta.mention, false)
  assert.equal(generateCalls[0].images.length, 1)
  assert.equal(generateCalls[0].imageCount, 1)
  assert.deepEqual(generateCalls[0].faces, ['微笑'])
  const groupActions = sent.map((item) => buildOneBotSendAction(item))
  assert.equal(groupActions[0].params.message[0].type, 'at')
  assert.equal(groupActions[1].params.message[0].type, 'text')

  // 纯文本一条：只发一个气泡
  sent.length = 0
  await host.handleInbound({ ...base, id: 'm-2', meta: {} })
  assert.equal(sent.length, 3)
})

test('QC13：新配置默认值/夹取', () => {
  const settings = normalizeConfig({ botQQ: BOT_QQ, allowUsers: [OWNER_QQ] })
  assert.equal(settings.maxBubbles, 30)
  assert.equal(settings.maxBubbleChars, 2000)
  assert.equal(settings.maxTokens, 8192)
  assert.equal(settings.maxReplyChars, 30000)
  assert.equal(settings.webContextMaxChars, 300000)
  assert.equal(settings.webFetchMaxChars, 150000)
  assert.equal(settings.bubbleDelayMs, 300)
  assert.equal(settings.webSearchEnabled, true)
  assert.equal(settings.webSearchMaxResults, 5)
  assert.equal(settings.imageMaxCount, 4)
  const clamped = normalizeConfig({ botQQ: BOT_QQ, allowUsers: [OWNER_QQ], maxBubbles: 99, webSearchMaxResults: 99, imageMaxCount: 99 })
  assert.equal(clamped.maxBubbles, 99)
  assert.equal(clamped.webSearchMaxResults, 8)
  assert.equal(clamped.imageMaxCount, 9)
})

test('QC13：QQ 可显式覆盖推理等级（reasoningEffort）', () => {
  const settings = normalizeConfig({ botQQ: BOT_QQ, allowUsers: [OWNER_QQ], reasoningEffort: 'low' })
  assert.equal(settings.reasoningEffort, 'low')
  const engine = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm({}),
    modelSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }),
    config: { reasoningEffort: 'low' },
  })
  assert.equal(engine.resolveRoute().reasoningEffort, 'low')
  const viaSettings = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm({}),
    modelSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'max' }),
    config: { reasoningEffort: settings.reasoningEffort },
  })
  assert.equal(viaSettings.resolveRoute().reasoningEffort, 'low')
})

test('QC16：搜索后抓取网页正文，避免只拿到标题', async () => {
  const fetched = []
  const engine = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm({}),
    web: {
      search: async () => ({
        sources: [
          { title: '北京天气', url: 'https://weather.test/beijing' },
          { title: '备用来源', url: 'https://backup.test/weather' },
        ],
      }),
      fetch: async ({ url }) => {
        fetched.push(url)
        return {
          url,
          statusCode: 200,
          body: {
            kind: 'html',
            content: '<html><head><script>bad()</script></head><body><h1>北京天气</h1><p>晴，气温 25℃，北风 2 级。</p></body></html>',
          },
          truncated: false,
        }
      },
    },
    modelSelection: () => ({ provider: 'p', model: 'm' }),
    config: { webFetchEnabled: true, webFetchMaxPages: 2, webFetchMaxChars: 900 },
  })
  const reply = await engine.generate({ text: '帮我查一下北京今天天气' })
  assert.deepEqual(fetched, ['https://weather.test/beijing', 'https://backup.test/weather'])
  assert.equal(reply.webFetchedPages, 2)
  assert.match(reply.system, /网页正文摘录/)
  assert.match(reply.system, /晴，气温 25℃/)
  assert.doesNotMatch(reply.system, /bad\(\)/)

  const noFetch = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm({}),
    web: { search: async () => ({ sources: [{ title: '标题', url: 'https://no-fetch.test' }] }) },
    modelSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const fallback = await noFetch.generate({ text: '帮我查一下最新新闻' })
  assert.equal(fallback.webFetchedPages, 0)
  assert.match(fallback.system, /标题/)
})
