/**
 * 独立验收 QW4/QW5：联网搜索后抓取网页正文、无 fetch/失败降级。
 * 全部使用假 web/LLM，不联网、不读真实数据目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createReplyEngine,
  renderWebSearchContext,
  stripHtmlToText,
} from '../../companion-bundle/lib/im/reply-engine.js'

function fakePersona() {
  return { renderPersonaSection: () => '【人设】奥菲莉亚', lookup: () => ({ ok: false }) }
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
            yield { type: 'text-delta', text: '查到了，今天北京有雨夹雪。' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    },
  }
}

test('QW4：搜索后抓取网页正文，清洗 HTML 并注入，不泄露 URL', async () => {
  const fetched = []
  const engine = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm({}),
    web: {
      search: async ({ query }) => {
        assert.equal(query, '北京今天天气')
        return {
          sources: [
            { title: '北京天气', url: 'https://weather.test/beijing', snippet: '天气页面摘要' },
            { title: '备用来源', url: 'https://backup.test/weather' },
          ],
        }
      },
      fetch: async ({ url }) => {
        fetched.push(url)
        return {
          url,
          statusCode: 200,
          body: {
            kind: 'html',
            content: '<html><script>alert(1)</script><body><h1>北京天气</h1><p>今天雨夹雪，最高 2℃，北风 3 级。</p></body></html>',
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
  assert.match(reply.system, /雨夹雪/)
  assert.match(reply.system, /2℃/)
  assert.doesNotMatch(reply.system, /<script/i)
  assert.doesNotMatch(reply.system, /https:\/\//i)
  assert.equal(reply.webSearchUsed, true)
})

test('QW5：无 fetch/fetch 失败/搜索失败时降级但不中断回复', async () => {
  // 没有 fetch：保留标题/短摘录
  const noFetch = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm({}),
    web: {
      search: async () => ({
        sources: [{ title: '只有标题', url: 'https://only-title.test', snippet: '一段摘录' }],
      }),
    },
    modelSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const noFetchReply = await noFetch.generate({ text: '帮我搜一下最新新闻' })
  assert.equal(noFetchReply.webFetchedPages, 0)
  assert.match(noFetchReply.system, /只有标题/)
  assert.match(noFetchReply.system, /一段摘录/)

  // fetch 全部失败：仍有搜索标题/摘录
  const fetchFail = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm({}),
    web: {
      search: async () => ({
        sources: [{ title: '失败页', url: 'https://fail.test', snippet: '失败摘录' }],
      }),
      fetch: async () => {
        throw new Error('fetch blocked')
      },
    },
    modelSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const failReply = await fetchFail.generate({ text: '帮我搜一下最新新闻' })
  assert.equal(failReply.webFetchedPages, 0)
  assert.match(failReply.system, /失败页/)
  assert.match(failReply.system, /失败摘录/)
  assert.doesNotMatch(failReply.system, /网页正文摘录/)

  // search 失败：明确提示不要编造，仍返回正文
  const searchFail = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm({}),
    web: { search: async () => { throw new Error('network down') } },
    modelSelection: () => ({ provider: 'p', model: 'm' }),
  })
  const searchFailReply = await searchFail.generate({ text: '帮我查一下最新新闻' })
  assert.equal(searchFailReply.webSearchUsed, false)
  assert.match(searchFailReply.system, /检索失败\/超时/)

  // 纯函数清洗
  assert.equal(stripHtmlToText('<b>标题</b><script>x</script>正文'), '标题 正文')
  assert.match(renderWebSearchContext({ sources: [{ title: '标题', snippet: '片段' }] }), /标题/)
  assert.match(renderWebSearchContext({ sources: [{ title: '标题', snippet: '片段' }] }), /片段/)
})
