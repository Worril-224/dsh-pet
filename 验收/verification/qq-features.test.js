/**
 * 独立验收测试 · 2026-11-06 新增能力（一）：联网搜索 / 多气泡 / 识图与表情包
 * 覆盖验收编号：QW1 QW2 QW3、QB1 QB2、QV1 QV2 QV3
 *
 * 全部使用假 web / 假 LLM / 假 attachments / 假 adapter / 临时目录；
 * 不联网、不写 companion-data、不向真实 QQ 发消息。
 * 测试由验收员 verifier 独立设计编写，不复用开发者测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  buildReplyPrompts,
  createReplyEngine,
  detectWebSearchQuery,
  renderWebSearchContext,
  sanitizeReply,
} from '../../companion-bundle/lib/im/reply-engine.js'
import { splitBubbles } from '../../companion-bundle/lib/im/bubbles.js'
import { faceName } from '../../companion-bundle/lib/im/qq-face.js'
import {
  detectImageMediaType,
  loadImageBytes,
  prepareImageRefs,
} from '../../companion-bundle/lib/im/vision.js'
import {
  buildOneBotSendAction,
  extractFaceNames,
  extractImageAttachments,
  parseOneBotMessageEvent,
} from '../../companion-bundle/lib/im/onebot.js'
import { createQQHost, normalizeConfig } from '../../companion-bundle/lib/qq-host.js'
import {
  GIF_BYTES,
  JPEG_BYTES,
  PNG_BYTES,
  WEBP_BYTES,
  makeFakeAdapter,
  makeFakeAttachments,
  makeFakeLlm,
  makeFakeResponse,
  makeFakeWeb,
  makeStubMemory,
  makeStubPersona,
  makeTempDir,
  textChunks,
  writeTempPng,
} from './feature-helpers.mjs'
import { cleanupTempDirs } from './helpers.mjs'

test.after(cleanupTempDirs)

const BOT_QQ = '123456789'
const OWNER_QQ = '10001'
const ROUTE = () => ({ provider: 'fake-provider', model: 'fake-model' })

function makeEngine({ llm, web, config } = {}) {
  return createReplyEngine({
    persona: makeStubPersona(),
    memory: makeStubMemory(),
    llm: llm ?? makeFakeLlm(),
    web,
    modelSelection: ROUTE,
    config,
  })
}

function makeQQHost({ replyEngine, llm, web, attachments, fetchImpl, config = {} } = {}) {
  const charactersDir = path.join(makeTempDir('dshpet-verify-qf-'), 'characters')
  const adapter = makeFakeAdapter()
  const host = createQQHost({
    config: {
      charactersDir,
      characterId: 'ophelia',
      botQQ: BOT_QQ,
      allowUsers: [OWNER_QQ],
      provider: 'fake-provider',
      model: 'fake-model',
      bubbleDelayMs: 0,
      ...config,
    },
    deps: {
      persona: makeStubPersona(),
      memory: makeStubMemory(),
      replyEngine,
      llm,
      web,
      attachments,
      fetchImpl,
      adapter,
    },
  })
  return { host, adapter, charactersDir }
}

function makeInbound(overrides = {}) {
  return {
    id: 'm-1',
    channel: 'qq',
    adapterId: 'fake-adapter',
    userId: OWNER_QQ,
    text: '今天好累',
    receivedAt: 1762400000000,
    meta: {},
    ...overrides,
  }
}

// ───────────────────────────── QW1 联网搜索意图 ─────────────────────────────

test('QW1: 联网搜索意图识别（搜/查/找资料/最新/新闻/天气），普通寒暄不触发', () => {
  assert.equal(detectWebSearchQuery('你好'), undefined)
  assert.equal(detectWebSearchQuery('今天好累啊'), undefined)
  assert.equal(detectWebSearchQuery('在吗'), undefined)
  assert.equal(detectWebSearchQuery(''), undefined)
  assert.equal(detectWebSearchQuery(null), undefined)
  assert.equal(detectWebSearchQuery('查一下'), undefined, '空命令不触发')
  assert.equal(detectWebSearchQuery('你是什么'), undefined, '「你是什么」不应触发')

  const weather = detectWebSearchQuery('帮我查一下明天北京的天气')
  assert.equal(typeof weather, 'string')
  assert.ok(weather.includes('明天北京'))
  assert.ok(!weather.startsWith('帮我'), '命令词应从 query 中去掉')

  const news = detectWebSearchQuery('搜一下今天的科技新闻')
  assert.equal(typeof news, 'string')
  assert.ok(news.includes('科技新闻'))

  assert.equal(typeof detectWebSearchQuery('最新显卡价格是多少'), 'string')
  assert.equal(typeof detectWebSearchQuery('帮我找资料：档案馆历史'), 'string')
  assert.equal(typeof detectWebSearchQuery('今天天气怎么样'), 'string')
  assert.ok(detectWebSearchQuery('搜'.repeat(300)).length <= 200, 'query 应限长 200')
})

test('QW1 修复复验（原 OBS-W1）: 普通对话不再触发搜索，命令式请求仍触发', () => {
  // 修复：WEB_SEARCH_HINTS 移除「是谁/是什么」，保留搜索/查/找资料/最新/新闻/天气/价格等。
  assert.equal(detectWebSearchQuery('你今天是什么心情呀'), undefined, '普通对话不应触发搜索')
  assert.equal(detectWebSearchQuery('你是谁'), undefined)
  assert.equal(detectWebSearchQuery('你是什么模型'), undefined)
  assert.equal(detectWebSearchQuery('你好呀'), undefined)
  // 正向用例：命令式请求/明确检索对象仍触发
  const weather = detectWebSearchQuery('帮我查一下明天上海天气')
  assert.equal(typeof weather, 'string')
  assert.ok(weather.includes('明天上海'))
  const tutorial = detectWebSearchQuery('搜索 Vue3 教程')
  assert.equal(typeof tutorial, 'string')
  assert.ok(tutorial.includes('Vue3'))
  assert.equal(typeof detectWebSearchQuery('今天天气怎么样'), 'string', '天气仍属检索意图')
})

// ───────────────────────────── QW2 检索注入（无 URL） ─────────────────────────────

test('QW2: 检索结果注入 system（标题/片段/无来源 URL），回复链接被清洗', async () => {
  const web = makeFakeWeb({
    result: {
      content: '明天北京多云，气温 12-20 度。',
      sources: [
        { title: '北京天气预报', snippet: '明天多云，适合出门。', url: 'https://weather.example/x' },
        { title: '气象台提示', snippet: '早晚温差较大。', url: 'https://y.example/z' },
      ],
    },
  })
  const llm = makeFakeLlm({ respond: () => '明天北京多云，12-20 度，早晚有点凉，主人记得加件外套。详见 https://weather.example/x' })
  const engine = makeEngine({ llm, web })
  const result = await engine.generate({ text: '帮我查一下明天北京的天气' })

  // web 调用参数
  assert.equal(web.calls.length, 1)
  assert.equal(web.calls[0].params.maxResults, 5)
  assert.equal(typeof web.calls[0].params.query, 'string')
  // system 内容
  assert.match(result.system, /【联网检索结果/u)
  assert.match(result.system, /北京天气预报/u)
  assert.match(result.system, /早晚温差较大/u)
  assert.match(result.system, /外部网页资料/u)
  assert.ok(!result.system.includes('https://weather.example/x'), 'system 不应注入来源 URL')
  assert.ok(!result.system.includes('https://y.example/z'))
  // 模型输出链接被清洗
  assert.ok(!/https?:\/\//u.test(result.text), `回复中不应有链接：${result.text}`)
  assert.equal(result.webSearchUsed, true)
  assert.equal(typeof result.webSearchQuery, 'string')
  // 内部 webSources 可携带 url（不进入 system；仅返回给调用方）
  assert.ok(Array.isArray(result.webSources))
  assert.equal(result.webSources.length, 2)
})

test('QW2 观察（低风险）: 外部结果正文/片段里自带的 URL 未被清洗（OBS-W2）', () => {
  const context = renderWebSearchContext({
    content: '参考 https://leak.example/a 这篇文章。',
    sources: [{ title: '资料', snippet: '见 https://leak.example/b' }],
  })
  assert.ok(context.includes('【联网检索结果'), '应包含检索段标题')
  // 当前实现不清洗 content/snippet 中的 URL；最终回复仍会被 sanitizeReply 清洗。
  assert.ok(context.includes('https://leak.example/a'), '记录现状：正文 URL 会进入 system（低风险观察）')
})

test('QW2: 注入段边界（空结果/截断标记/来源数上限/content 截断）', () => {
  assert.equal(renderWebSearchContext(undefined), '')
  assert.equal(renderWebSearchContext('x'), '')
  const empty = renderWebSearchContext({ content: '', sources: [] })
  assert.match(empty, /没有找到可用结果/u)
  const truncated = renderWebSearchContext({
    content: 'x'.repeat(5000),
    sources: Array.from({ length: 10 }, (_, index) => ({ title: `T${index}`, snippet: 's'.repeat(500) })),
    truncated: true,
  })
  assert.match(truncated, /结果被截断/u)
  assert.ok(!truncated.includes('T9'), '来源数量应受上限限制')
  assert.ok(truncated.length < 3000, '注入段应有长度上限')

  // buildReplyPrompts 直接传 webContext 也能进入 system
  const prompts = buildReplyPrompts({
    text: '帮我查天气',
    persona: makeStubPersona(),
    memory: makeStubMemory(),
    webContext: renderWebSearchContext({ content: '晴', sources: [{ title: '天气', snippet: '晴' }] }),
  })
  assert.match(prompts.system, /【联网检索结果/u)
})

// ───────────────────────────── QW3 搜索失败降级 ─────────────────────────────

test('QW3: web 抛错/超时降级——明确提示不要编造，仍正常生成回复', async () => {
  for (const error of [new Error('搜索服务超时'), Object.assign(new Error('aborted'), { name: 'AbortError' })]) {
    const web = makeFakeWeb({ error })
    const llm = makeFakeLlm({ respond: () => '这个我暂时查不到，主人别急。' })
    const engine = makeEngine({ llm, web })
    const result = await engine.generate({ text: '帮我查一下明天的航班信息' })
    assert.match(result.system, /检索失败/u)
    assert.match(result.system, /不要编造/u)
    assert.ok(!result.system.includes('【联网检索结果（外部网页资料'), '失败时不应注入检索结果段')
    assert.equal(result.webSearchUsed, false)
    assert.ok(result.text.length > 0)
  }
})

test('QW3: webSearchEnabled=false 时不发起搜索；web 服务缺失时正常聊天', async () => {
  const web = makeFakeWeb({ result: { content: 'x', sources: [] } })
  const disabled = makeEngine({ web, config: { webSearchEnabled: false } })
  const result = await disabled.generate({ text: '帮我查一下最新新闻' })
  assert.equal(web.calls.length, 0, '关闭后不应调用 web.search')
  assert.equal(result.webSearchUsed, false)

  const noWeb = makeEngine({ web: undefined })
  const normal = await noWeb.generate({ text: '帮我查一下最新新闻' })
  assert.equal(normal.webSearchUsed, false)
  assert.ok(normal.text.length > 0)

  // maxResults 夹取 1~8
  const clampedWeb = makeFakeWeb({ result: { content: 'x', sources: [{ title: 'a', snippet: 'b' }] } })
  const clamped = makeEngine({ web: clampedWeb, config: { webSearchMaxResults: 99 } })
  await clamped.generate({ text: '搜索 测试' })
  assert.equal(clampedWeb.calls[0].params.maxResults, 8)
})

// ───────────────────────────── QB1 多气泡拆分 ─────────────────────────────

test('QB1: 气泡拆分（换行/空行/超长按标点/空文本/上限合并）', () => {
  assert.deepEqual(splitBubbles(''), [])
  assert.deepEqual(splitBubbles('   \n\n  '), [])
  assert.deepEqual(splitBubbles('第一段\n第二段\n第三段'), ['第一段', '第二段', '第三段'])
  assert.deepEqual(splitBubbles('第一段\n\n\n第二段'), ['第一段', '第二段'])
  assert.deepEqual(splitBubbles('  只有一段  '), ['只有一段'])

  const long = '第一句话。第二句话。第三句话。第四句话。'
  const pieces = splitBubbles(long, { maxCharsPerBubble: 60 })
  assert.equal(pieces.length, 1, '不超过上限不应拆分')
  const more = splitBubbles(long.repeat(8), { maxCharsPerBubble: 60, maxBubbles: 8 })
  assert.ok(more.length > 1, '超长段落应按句末标点再拆')
  assert.ok(more.every((piece) => piece.length <= 61), `每段不应超长：${JSON.stringify(more.map((p) => p.length))}`)

  const capped = splitBubbles(Array.from({ length: 10 }, (_, index) => `第${index + 1}段`).join('\n'), { maxBubbles: 3 })
  assert.equal(capped.length, 3, '气泡数量应受 maxBubbles 限制')
  assert.ok(capped[2].includes('第10段'), '多出的段落应合并进最后一个气泡')

  assert.equal(splitBubbles('一段', { maxBubbles: 1 }).length, 1)
  // 无标点超长文本也应有兜底切分
  const noPunct = splitBubbles('啊'.repeat(500), { maxCharsPerBubble: 100 })
  assert.ok(noPunct.length >= 5)
})

// ───────────────────────────── QB2 群聊首条 @ / 多气泡发送 ─────────────────────────────

test('QB2: 私聊逐条发送无 @；群聊仅首条 @（QQ Host 端到端，假 adapter）', async () => {
  const replyEngine = { generate: async () => ({ text: '第一段\n第二段\n第三段', onDemandModules: [] }) }
  const { host, adapter } = makeQQHost({ replyEngine })

  // 私聊：三条气泡，均无 groupId/mention
  const privateResult = await host.handleInbound(makeInbound({ id: 'p-1' }))
  assert.equal(privateResult.accepted, true)
  assert.equal(privateResult.bubbles.length, 3)
  assert.equal(adapter.state.sent.length, 3)
  for (const outbound of adapter.state.sent) {
    assert.equal(outbound.text.length > 0, true)
    assert.equal(outbound.meta?.groupId, undefined)
  }

  // 群聊：首条 mention=true、后续 false；groupId 透传
  const groupResult = await host.handleInbound(makeInbound({ id: 'g-1', meta: { groupId: '998877' } }))
  assert.equal(groupResult.bubbles.length, 3)
  const groupOutbounds = adapter.state.sent.slice(3)
  assert.equal(groupOutbounds.length, 3)
  assert.equal(groupOutbounds[0].meta.groupId, '998877')
  assert.equal(groupOutbounds[0].meta.mention, true)
  assert.equal(groupOutbounds[1].meta.mention, false)
  assert.equal(groupOutbounds[2].meta.mention, false)

  // onebot action：mention 默认带 @；mention=false 时无 @ 段、文本无前导空格
  const withMention = buildOneBotSendAction({ text: '在的', userId: OWNER_QQ, meta: { groupId: '42' } })
  assert.deepEqual(withMention.params.message[0], { type: 'at', data: { qq: Number(OWNER_QQ) } })
  assert.equal(withMention.params.message[1].data.text, ' 在的')
  const withoutMention = buildOneBotSendAction({ text: '第二段', userId: OWNER_QQ, meta: { groupId: '42', mention: false } })
  assert.equal(withoutMention.params.message.length, 1)
  assert.equal(withoutMention.params.message[0].data.text, '第二段')
  const privateAction = buildOneBotSendAction({ text: '私聊', userId: OWNER_QQ })
  assert.equal(privateAction.action, 'send_private_msg')
})

test('QB1/QB2 配置边界: maxBubbles/maxBubbleChars/bubbleDelayMs 夹取', () => {
  const defaults = normalizeConfig({ charactersDir: 'D:/x/characters', botQQ: BOT_QQ, allowUsers: [OWNER_QQ] })
  assert.equal(defaults.maxBubbles, 30)
  assert.equal(defaults.maxBubbleChars, 2000)
  assert.equal(defaults.bubbleDelayMs, 300)
  const clamped = normalizeConfig({
    charactersDir: 'D:/x/characters',
    botQQ: BOT_QQ,
    allowUsers: [OWNER_QQ],
    maxBubbles: -3,
    maxBubbleChars: 1,
    bubbleDelayMs: -5,
  })
  assert.equal(clamped.maxBubbles, 1)
  assert.equal(clamped.maxBubbleChars, 80)
  assert.equal(clamped.bubbleDelayMs, 0)
})

// ───────────────────────────── QV1 图片/表情解析 ─────────────────────────────

test('QV1: image/mface 收集 url/file/path；face id→中文名；纯图片/纯表情不丢弃', () => {
  const segments = [
    { type: 'image', data: { url: 'https://img.example/a.png', file: 'a.png', summary: '[图片]', file_size: 1234, sub_type: 0 } },
    { type: 'mface', data: { url: 'https://img.example/b.gif', summary: '[动画表情]' } },
    { type: 'mface', data: { summary: '猫猫表情包' } },
    { type: 'face', data: { id: 1 } },
    { type: 'face', data: { id: 9999 } },
    { type: 'text', data: { text: '看图' } },
  ]
  const images = extractImageAttachments(segments)
  assert.equal(images.length, 2, '带 url/file/path 的 image/mface 才收集')
  assert.equal(images[0].url, 'https://img.example/a.png')
  assert.equal(images[0].file, 'a.png')
  assert.equal(images[0].fileSize, 1234)
  assert.equal(images[1].kind, 'mface')
  const faces = extractFaceNames(segments)
  assert.deepEqual(faces, ['猫猫表情包', '微笑', '表情#9999'])
  assert.equal(faceName(1), '微笑')
  assert.equal(faceName('1'), '微笑')
  assert.equal(faceName(9999), '表情#9999')

  // 纯图片消息：text 回退为 [图片]，meta.images 保留
  const imageEvent = parseOneBotMessageEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: Number(BOT_QQ),
    user_id: Number(OWNER_QQ),
    message_id: 5001,
    time: 1762400000,
    message: [{ type: 'image', data: { url: 'https://img.example/x.png' } }],
    sender: { nickname: '主人' },
  })
  assert.ok(imageEvent)
  assert.equal(imageEvent.text, '[图片]')
  assert.equal(imageEvent.meta.images.length, 1)

  // 纯表情消息：text 回退为 [表情：微笑]
  const faceEvent = parseOneBotMessageEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: Number(BOT_QQ),
    user_id: Number(OWNER_QQ),
    message_id: 5002,
    time: 1762400000,
    message: [{ type: 'face', data: { id: 1 } }],
    sender: {},
  })
  assert.ok(faceEvent)
  assert.equal(faceEvent.text, '[表情：微笑]')
  assert.deepEqual(faceEvent.meta.faces, ['微笑'])

  // 群聊图片消息：需 @，解析后仍带 images
  const groupImage = parseOneBotMessageEvent(
    {
      post_type: 'message',
      message_type: 'group',
      self_id: Number(BOT_QQ),
      user_id: Number(OWNER_QQ),
      group_id: 998877,
      message_id: 5003,
      message: [
        { type: 'at', data: { qq: Number(BOT_QQ) } },
        { type: 'image', data: { url: 'https://img.example/g.png' } },
      ],
      raw_message: `[CQ:at,qq=${BOT_QQ}][CQ:image,url=https://img.example/g.png]`,
    },
    { selfId: BOT_QQ },
  )
  assert.ok(groupImage)
  assert.equal(groupImage.meta.images.length, 1)
  assert.equal(groupImage.meta.groupId, '998877')
})

// ───────────────────────────── QV2 附件保存与多模态消息 ─────────────────────────────

test('QV2: 图片类型识别与字节加载（buffer/base64/data URL/http/file/大小/非法）', async () => {
  assert.equal(detectImageMediaType(PNG_BYTES), 'image/png')
  assert.equal(detectImageMediaType(JPEG_BYTES), 'image/jpeg')
  assert.equal(detectImageMediaType(GIF_BYTES), 'image/gif')
  assert.equal(detectImageMediaType(WEBP_BYTES), 'image/webp')
  assert.equal(detectImageMediaType(Buffer.from('not an image')), undefined)

  // buffer
  const fromBuffer = await loadImageBytes({ buffer: PNG_BYTES })
  assert.equal(fromBuffer.mediaType, 'image/png')
  assert.deepEqual(fromBuffer.bytes, PNG_BYTES)
  // base64
  const fromBase64 = await loadImageBytes({ base64: JPEG_BYTES.toString('base64') })
  assert.equal(fromBase64.mediaType, 'image/jpeg')
  // data URL
  const dataUrl = await loadImageBytes({ url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` })
  assert.equal(dataUrl.mediaType, 'image/png')
  // http（假 fetch）
  const fromHttp = await loadImageBytes(
    { url: 'https://img.example/a.png' },
    { fetchImpl: async () => makeFakeResponse(PNG_BYTES, 'image/png') },
  )
  assert.equal(fromHttp.mediaType, 'image/png')
  // 本地文件
  const localFile = writeTempPng('local.png')
  const fromFile = await loadImageBytes({ file: localFile })
  assert.equal(fromFile.mediaType, 'image/png')

  // 超大小限制：HTTP / data URL 路径会校验（buffer 路径见下方观察项）
  const big = Buffer.concat([PNG_BYTES, Buffer.alloc(4000, 0)])
  await assert.rejects(
    () => loadImageBytes({ url: 'https://img.example/big.png' }, { fetchImpl: async () => makeFakeResponse(big), maxBytes: 1024 }),
    /超过大小限制/u,
  )
  await assert.rejects(
    () => loadImageBytes({ url: `data:image/png;base64,${big.toString('base64')}` }, { maxBytes: 1024 }),
    /超过大小限制/u,
  )
  // HTTP 失败
  await assert.rejects(
    () => loadImageBytes({ url: 'https://img.example/x.png' }, { fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /下载失败|HTTP/u,
  )
  // 无可用地址
  await assert.rejects(() => loadImageBytes({}), /没有可用的图片地址/u)
  // 非图片字节
  await assert.rejects(() => loadImageBytes({ buffer: Buffer.from('plain text data') }), /无法识别的图片格式/u)
})

test('QV2 修复复验（原 OBS-V1）: buffer 直传也受 maxBytes 限制，正常 buffer 通过', async () => {
  // 修复：image.buffer 分支先检查 maxBytes，超限抛「图片超过大小限制」。
  const big = Buffer.concat([PNG_BYTES, Buffer.alloc(4000, 0)])
  await assert.rejects(() => loadImageBytes({ buffer: big }, { maxBytes: 1024 }), /图片超过大小限制/u)
  const loaded = await loadImageBytes({ buffer: PNG_BYTES }, { maxBytes: 1024 })
  assert.equal(loaded.mediaType, 'image/png')
  assert.deepEqual(loaded.bytes, PNG_BYTES, '正常 buffer 仍应加载')
  // 带 mediaType 提示的超限 buffer 同样拒绝
  await assert.rejects(() => loadImageBytes({ buffer: big, mediaType: 'image/png' }, { maxBytes: 1024 }), /图片超过大小限制/u)
})

test('QV2: prepareImageRefs 保存附件、失败记录、服务缺失；多模态 image block 进入 user 消息', async () => {
  // 服务缺失
  const missing = await prepareImageRefs([{ url: 'https://img.example/a.png' }], {})
  assert.deepEqual(missing.refs, [])
  assert.equal(missing.errors.length, 1)
  assert.match(missing.errors[0], /attachments/u)

  // 正常保存（buffer 可直接用，不需要网络）
  const attachments = makeFakeAttachments()
  const prepared = await prepareImageRefs(
    [{ buffer: PNG_BYTES, mediaType: 'image/png', name: 'a.png' }, { buffer: JPEG_BYTES }],
    { attachments, maxImages: 1 },
  )
  assert.equal(prepared.total, 2)
  assert.equal(prepared.refs.length, 1, 'maxImages 应限制识别数量')
  assert.equal(attachments.calls.length, 1)
  assert.equal(attachments.calls[0][0].mediaType, 'image/png')
  assert.ok(attachments.calls[0][0].data instanceof Uint8Array, '附件服务要求 Uint8Array 字节')
  assert.equal(attachments.calls[0][0].name, 'a.png')

  // 部分失败：第一张下载失败，第二张成功
  const partial = await prepareImageRefs(
    [{ url: 'https://img.example/bad.png' }, { buffer: JPEG_BYTES }],
    {
      attachments: makeFakeAttachments(),
      fetchImpl: async () => ({ ok: false, status: 500 }),
    },
  )
  assert.equal(partial.refs.length, 1, '单张失败不应影响其他图片')
  assert.equal(partial.errors.length, 1)

  // 多模态：replyEngine.generate 生成 image block
  const llm = makeFakeLlm({ respond: () => '图片里是一只猫，很可爱。' })
  const engine = makeEngine({ llm })
  const refs = [{ type: 'image', id: 'att-1' }, { type: 'image', id: 'att-2' }]
  const result = await engine.generate({ text: '看看这两张图', images: refs, imageCount: 2 })
  const userContent = llm.calls.stream[0].messages[0].content
  assert.equal(userContent[0].type, 'text')
  const imageBlocks = userContent.filter((block) => block.type === 'image')
  assert.equal(imageBlocks.length, 2, '每张图片应生成一个 image block')
  assert.deepEqual(imageBlocks.map((block) => block.attachment), refs)
  assert.match(result.system, /附带了 2 张图片/u)
})

test('QV2: QQ Host 端到端——图片经假 fetch/attachments 转 refs 后进入多模态 LLM', async () => {
  const llm = makeFakeLlm({ respond: () => '我看见图里的草莓蛋糕了。' })
  const web = makeFakeWeb({ result: { content: '', sources: [] } })
  const attachments = makeFakeAttachments()
  const { host, adapter } = makeQQHost({
    llm,
    web,
    attachments,
    fetchImpl: async () => makeFakeResponse(PNG_BYTES, 'image/png'),
  })
  const result = await host.handleInbound(
    makeInbound({ id: 'img-1', text: '[图片]', meta: { images: [{ url: 'https://img.example/cake.png' }] } }),
  )
  assert.equal(result.accepted, true)
  assert.equal(result.imageCount, 1)
  assert.equal(result.imageRefs, 1)
  assert.deepEqual(result.imageErrors, [])
  assert.equal(adapter.state.sent.length, 1)
  const userContent = llm.calls.stream[0].messages[0].content
  assert.equal(userContent.filter((block) => block.type === 'image').length, 1)
  assert.match(llm.calls.stream[0].system, /图片/u)
})

test('QV3: 视觉失败降级——附件缺失/下载失败仍用文字回复，白名单与去重不受影响', async () => {
  // 没有 attachments 服务
  const replyEngine = { generate: async ({ text, imageCount }) => ({ text: `收到：${text}（图片${imageCount}张没看清）`, onDemandModules: [] }) }
  const { host, adapter } = makeQQHost({ replyEngine })
  const result = await host.handleInbound(
    makeInbound({ id: 'v-1', text: '[图片]', meta: { images: [{ url: 'https://img.example/a.png' }] } }),
  )
  assert.equal(result.accepted, true)
  assert.equal(result.imageRefs, 0)
  assert.equal(result.imageErrors.length, 1, '附件服务缺失应记录错误')
  assert.equal(adapter.state.sent.length, 1, '仍应发送文字回复')

  // 同 messageId 重复 → duplicate（视觉失败不影响去重）
  const dup = await host.handleInbound(makeInbound({ id: 'v-1', text: '[图片]', meta: { images: [] } }))
  assert.equal(dup.reason, 'duplicate')
  // 非白名单仍拒绝
  const stranger = await host.handleInbound(makeInbound({ id: 'v-2', userId: '999999', meta: { images: [] } }))
  assert.equal(stranger.reason, 'not_allowed')

  // 下载失败（假 fetch 500）也降级为文字回复
  const llm = makeFakeLlm({ respond: () => '图我没看清，主人再说说？' })
  const failing = makeQQHost({ llm, attachments: makeFakeAttachments(), fetchImpl: async () => ({ ok: false, status: 500 }) })
  const failedImage = await failing.host.handleInbound(
    makeInbound({ id: 'v-3', text: '[图片]', meta: { images: [{ url: 'https://img.example/broken.png' }] } }),
  )
  assert.equal(failedImage.accepted, true)
  assert.equal(failedImage.imageRefs, 0)
  assert.ok(failedImage.imageErrors.length >= 1)
  assert.equal(failing.adapter.state.sent.length, 1)
})
