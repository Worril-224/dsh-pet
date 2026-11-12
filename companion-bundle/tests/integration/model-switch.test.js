/**
 * 模型切换验收：
 *  - 回复引擎的动态路由优先级（面板切换 > 配置 > Harness 默认）；
 *  - QQ 聊天模型的保存 / 重启后恢复 / 删除覆盖；
 *  - 两个 Host 端 Web 路由的行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createReplyEngine } from '../../lib/im/reply-engine.js'
import { createQQHost } from '../../lib/qq-host.js'
import { collectModelCatalog, registerModelRoutes, attachModelRoutes, createPresetStore, normalizeSelection } from '../../lib/model-control.js'
import { registerQQModelRoutes, attachQQModelRoutes } from '../../lib/qq-model-routes.js'

function fakePersona() {
  return {
    renderPersonaSection: () => '【人设】奥菲莉亚',
    lookup: () => ({ ok: false }),
  }
}

function fakeMemory() {
  return {
    renderDigest: () => '【记忆】主人喜欢雨天。',
    ensure: () => {},
    remember: () => {},
    recordConversationTurn: () => ({ item: { id: 'm1' } }),
    organizeShortTermOverflow: () => ({}),
  }
}

function fakeLlm() {
  return {
    prepareCall: async () => ({
      config: {},
      stream: () => (async function* () {
        yield { type: 'text-delta', text: '好。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }),
  }
}

function fakeAdapter() {
  return {
    id: 'fake',
    status: () => ({ state: 'running' }),
    start: async () => ({ state: 'running' }),
    stop: async () => ({ state: 'stopped' }),
    send: async () => ({ id: 'sent' }),
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-companion-model-'))
}

function createHost(root, overrides = {}) {
  return createQQHost({
    config: {
      charactersDir: root,
      characterId: 'ophelia',
      botQQ: '123456789',
      allowUsers: ['10001'],
      provider: 'cfg-provider',
      model: 'cfg-model',
      ...overrides,
    },
    deps: {
      persona: fakePersona(),
      memory: fakeMemory(),
      llm: fakeLlm(),
      adapter: fakeAdapter(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  })
}

function fakeResponse() {
  return {
    headersSent: false,
    status: undefined,
    body: undefined,
    headers: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(body) {
      this.body = body
    },
  }
}

function fakeRequest({ method = 'GET', body, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:62991', ...headers }
  return req
}

function createFakeWebServer() {
  const handlers = new Map()
  return {
    handlers,
    register(route) {
      handlers.set(route.path, route.handler)
      return () => handlers.delete(route.path)
    },
  }
}

function createRouteContext(webServer, services = {}) {
  return {
    get(name) {
      if (name === 'webServer') return webServer
      return services[name]
    },
    effect(callback) {
      callback()
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

async function call(handler, request) {
  const response = fakeResponse()
  await handler(request, response)
  return {
    status: response.status,
    body: response.body ? JSON.parse(response.body) : undefined,
  }
}

test('回复引擎：getRoute 覆盖配置，返回 undefined 时回退配置', () => {
  let route
  const engine = createReplyEngine({
    persona: fakePersona(),
    memory: fakeMemory(),
    llm: fakeLlm(),
    config: { provider: 'cfg-provider', model: 'cfg-model', reasoningEffort: 'high' },
    getRoute: () => route,
    logger: { warn: () => {} },
  })
  assert.deepEqual(engine.resolveRoute(), {
    provider: 'cfg-provider',
    model: 'cfg-model',
    reasoningEffort: 'high',
  })
  route = { provider: 'panel-provider', model: 'panel-model' }
  assert.deepEqual(engine.resolveRoute(), {
    provider: 'panel-provider',
    model: 'panel-model',
    reasoningEffort: 'high',
  })
  route = { provider: 'panel-provider', model: 'panel-model', reasoningEffort: 'low' }
  assert.deepEqual(engine.resolveRoute(), {
    provider: 'panel-provider',
    model: 'panel-model',
    reasoningEffort: 'low',
  })
  route = undefined
  assert.equal(engine.resolveRoute().provider, 'cfg-provider')
})

test('QQ 模型：切换立即生效、写入文件、重启后恢复、可重置', () => {
  const root = tempDir()
  try {
    const host = createHost(root)
    assert.deepEqual(host.getReplyModelState().current, { provider: 'cfg-provider', model: 'cfg-model' })
    assert.equal(host.getReplyModelState().override, null)

    const state = host.setReplyModel({ provider: 'deepseek-account', model: 'deepseek-flash' })
    assert.deepEqual(state.current, { provider: 'deepseek-account', model: 'deepseek-flash' })
    assert.deepEqual(state.override, { provider: 'deepseek-account', model: 'deepseek-flash' })
    const file = path.join(root, 'ophelia', 'qq', 'reply-model.json')
    assert.ok(fs.existsSync(file))
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).provider, 'deepseek-account')

    const restarted = createHost(root)
    assert.deepEqual(restarted.getReplyModelState().current, {
      provider: 'deepseek-account',
      model: 'deepseek-flash',
    })

    const reset = restarted.resetReplyModel()
    assert.equal(reset.override, null)
    assert.deepEqual(reset.current, { provider: 'cfg-provider', model: 'cfg-model' })
    assert.equal(fs.existsSync(file), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('冷启动：webServer 尚未就绪时延迟注册模型路由', () => {
  const webServer = createFakeWebServer()
  const services = {
    llm: { listProviders: () => [], listModels: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'alpha', model: 'a1' }), saveSelection: async () => {} },
  }
  let deferred
  const ctx = {
    get(name) {
      if (name === 'webServer') return undefined
      return services[name]
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      deferred = () => callback(createRouteContext(webServer, services))
    },
    effect(callback) {
      callback()
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  attachModelRoutes(ctx, { logger: ctx.logger })
  assert.equal(webServer.handlers.size, 0)
  deferred()
  assert.ok(webServer.handlers.has('/dsh-companion/models/catalog'))
  assert.ok(webServer.handlers.has('/dsh-companion/models/default'))
})

test('冷启动：webServer 已就绪时立即注册 QQ 模型路由', () => {
  const root = tempDir()
  try {
    const webServer = createFakeWebServer()
    const services = { llm: { listProviders: () => [], listModels: async () => [] } }
    const ctx = createRouteContext(webServer, services)
    const host = createHost(root)
    attachQQModelRoutes(ctx, host, { logger: ctx.logger })
    assert.ok(webServer.handlers.has('/dsh-companion/qq/model'))
    assert.ok(webServer.handlers.has('/dsh-companion/qq/model/reset'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('快捷模型存储：保存、去重、重启后仍可读', () => {
  const root = tempDir()
  try {
    const file = path.join(root, 'models-presets.json')
    const store = createPresetStore(file)
    assert.deepEqual(store.list(), [])
    store.add({ provider: 'alpha', model: 'a1' })
    store.add({ provider: 'beta', model: 'b2' })
    assert.deepEqual(store.list(), [
      { provider: 'beta', model: 'b2' },
      { provider: 'alpha', model: 'a1' },
    ])
    store.add({ provider: 'alpha', model: 'a1' })
    assert.deepEqual(store.list(), [
      { provider: 'alpha', model: 'a1' },
      { provider: 'beta', model: 'b2' },
    ])
    const restarted = createPresetStore(file)
    assert.deepEqual(restarted.list(), [
      { provider: 'alpha', model: 'a1' },
      { provider: 'beta', model: 'b2' },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Web 路由：快捷模型的读取与保存', async () => {
  const root = tempDir()
  try {
    const webServer = createFakeWebServer()
    const services = {
      llm: { listProviders: () => [], listModels: async () => [] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'alpha', model: 'a1' }), saveSelection: async () => {} },
    }
    const ctx = createRouteContext(webServer, services)
    registerModelRoutes(ctx, {
      logger: ctx.logger,
      presetsFile: path.join(root, 'models-presets.json'),
    })
    const route = webServer.handlers.get('/dsh-companion/models/presets')
    assert.ok(route)

    const empty = await call(route, fakeRequest())
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.data.presets, [])

    const saved = await call(route, fakeRequest({
      method: 'POST',
      body: { provider: 'alpha', model: 'a1' },
    }))
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.data.presets, [{ provider: 'alpha', model: 'a1' }])

    const read = await call(route, fakeRequest())
    assert.deepEqual(read.body.data.presets, [{ provider: 'alpha', model: 'a1' }])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('模型选择规范化：拒绝空/非法输入', () => {
  assert.deepEqual(normalizeSelection({ provider: ' p ', model: ' m ' }), { provider: 'p', model: 'm' })
  assert.deepEqual(normalizeSelection({ provider: 'p', model: 'm', reasoningEffort: ' high ' }), {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  })
  assert.throws(() => normalizeSelection({ provider: '', model: 'm' }), /provider/)
  assert.throws(() => normalizeSelection({ provider: 'p', model: '' }), /model/)
  assert.throws(() => normalizeSelection(null), /对象/)
})

test('模型目录：一个提供方探测失败不影响其它提供方', async () => {
  const llm = {
    listProviders: () => [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ],
    listModels: async (provider) => {
      if (provider === 'beta') throw new Error('本地服务未启动')
      return [{ id: 'a1', name: 'A1' }]
    },
  }
  const catalog = await collectModelCatalog(llm, { timeoutMs: 1000 })
  assert.equal(catalog.providers.length, 2)
  assert.deepEqual(catalog.providers[0].models, [{ id: 'a1', name: 'A1' }])
  assert.match(catalog.providers[1].error, /本地服务未启动/)
})

test('Web 路由：模型目录、默认模型、QQ 模型切换', async () => {
  const root = tempDir()
  try {
    const webServer = createFakeWebServer()
    const llm = {
      listProviders: () => [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
      ],
      listModels: async (provider) => (provider === 'alpha' ? [{ id: 'a1', name: 'A1' }] : []),
    }
    let selection = { provider: 'alpha', model: 'a1', reasoningEffort: 'high' }
    const agentDefaultModel = {
      currentSelection: () => ({ ...selection }),
      saveSelection: async (next) => {
        selection = { ...next }
      },
    }
    const ctx = createRouteContext(webServer, { llm, agentDefaultModel })
    registerModelRoutes(ctx, { logger: ctx.logger })

    const catalogRoute = webServer.handlers.get('/dsh-companion/models/catalog')
    const defaultRoute = webServer.handlers.get('/dsh-companion/models/default')
    assert.ok(catalogRoute && defaultRoute)

    const catalog = await call(catalogRoute, fakeRequest())
    assert.equal(catalog.status, 200)
    assert.equal(catalog.body.ok, true)
    assert.equal(catalog.body.data.providers.length, 2)

    const current = await call(defaultRoute, fakeRequest())
    assert.equal(current.body.data.selection.provider, 'alpha')
    assert.equal(current.body.data.selection.reasoningEffort, 'high')

    const saved = await call(defaultRoute, fakeRequest({
      method: 'POST',
      body: { provider: 'beta', model: 'b2' },
    }))
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.data.selection, { provider: 'beta', model: 'b2' })

    const rejected = await call(defaultRoute, fakeRequest({
      method: 'POST',
      body: { provider: 'gamma', model: 'g1' },
    }))
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error.code, 'unknown-provider')

    const host = createHost(root)
    registerQQModelRoutes(ctx, host, { logger: ctx.logger })
    const qqRoute = webServer.handlers.get('/dsh-companion/qq/model')
    const resetRoute = webServer.handlers.get('/dsh-companion/qq/model/reset')
    assert.ok(qqRoute && resetRoute)

    const initial = await call(qqRoute, fakeRequest())
    assert.equal(initial.status, 200)
    assert.equal(initial.body.data.current.provider, 'cfg-provider')

    const changed = await call(qqRoute, fakeRequest({
      method: 'POST',
      body: { provider: 'alpha', model: 'a1' },
    }))
    assert.equal(changed.status, 200)
    assert.deepEqual(changed.body.data.current, { provider: 'alpha', model: 'a1' })
    assert.equal(host.getReplyModelState().current.provider, 'alpha')

    const reset = await call(resetRoute, fakeRequest({ method: 'POST', body: {} }))
    assert.equal(reset.status, 200)
    assert.equal(reset.body.data.current.provider, 'cfg-provider')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
