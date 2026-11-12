/**
 * 2026-11-06 新增能力独立验收的共享测试替身（verifier 自写）。
 * 全部为内存/临时实现：假 LLM、假 web、假 attachments、假 adapter、假 persona/memory，
 * 不联网、不写真实数据目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { makeTempDir } from './helpers.mjs'

export { makeTempDir }

/** 把文本变成 LLM 流 chunk 数组。 */
export function textChunks(text) {
  return [
    { type: 'text-delta', text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * 假 LLM：记录 prepareCall/stream，按 responder(options) 返回文本或抛错。
 * @param {{ respond?: (options: object) => string, fail?: Error, onCall?: Function }} [options]
 */
export function makeFakeLlm({ respond = () => '好的，主人。', fail, onCall } = {}) {
  const calls = { prepare: [], stream: [] }
  return {
    calls,
    prepareCall: async (config) => {
      calls.prepare.push(config)
      onCall?.(config)
      return {
        config: { ...config },
        stream: (options) => {
          calls.stream.push(options)
          if (fail) throw fail
          const text = respond(options)
          return (async function* () {
            for (const chunk of textChunks(text)) yield chunk
          })()
        },
      }
    },
  }
}

/** 假 web 搜索：记录调用，返回结果或抛错。 */
export function makeFakeWeb({ result, error } = {}) {
  const calls = []
  return {
    calls,
    search: async (params, signal) => {
      calls.push({ params, hasSignal: Boolean(signal) })
      if (error) throw error
      if (typeof result === 'function') return result(params)
      return result ?? { content: '', sources: [] }
    },
  }
}

/** 假 Harness attachments 服务：记录 saveImages 入参并返回 refs。 */
export function makeFakeAttachments({ refs, error } = {}) {
  const calls = []
  return {
    calls,
    saveImages: async (images) => {
      calls.push(images)
      if (error) throw error
      const list = Array.isArray(images) ? images : []
      return list.map((image, index) => {
        const provided = Array.isArray(refs) ? refs[index] : undefined
        return provided ?? { type: 'image', id: `att-${calls.length}-${index}`, mediaType: image?.mediaType }
      })
    },
  }
}

/** 假 OneBot 适配器：记录 start/send/stop，可配置 send 结果或抛错。 */
export function makeFakeAdapter({ sendResult = { delivered: true }, sendError } = {}) {
  const state = { started: 0, stopped: 0, sent: [], handlers: undefined }
  const adapter = {
    id: 'fake-adapter',
    state,
    start: async (handlers) => {
      state.started += 1
      state.handlers = handlers
      return { id: 'fake-adapter', channel: 'qq', state: 'running' }
    },
    stop: async () => {
      state.stopped += 1
      return { id: 'fake-adapter', channel: 'qq', state: 'stopped' }
    },
    send: async (outbound) => {
      if (sendError) throw sendError
      state.sent.push(outbound)
      return sendResult
    },
    status: () => ({ id: 'fake-adapter', channel: 'qq', state: 'running' }),
  }
  return adapter
}

/** 假 persona（QQ/生活模块用）。 */
export function makeStubPersona() {
  return {
    renderPersonaSection: () => '【人设 · 始终生效】\n你是奥菲莉亚，白昼档案馆的记录官。',
    getDefinition: () => ({ character: { name: '奥菲莉亚', userAddress: '主人' } }),
    lookup: (moduleId) => ({ ok: true, id: moduleId, label: moduleId, content: `档案正文：${moduleId}` }),
  }
}

/** 假记忆引擎（QQ/生活模块用）。 */
export function makeStubMemory({ digest = '【记忆系统 · 自动注入】\n主人喜欢雨天。' } = {}) {
  return {
    renderDigest: () => digest,
    listLayer: () => [],
    status: () => ({ total: 0, counts: { short: 0, layers: [0, 0, 0, 0, 0, 0, 0] } }),
    ingestMessage: () => ({ created: [], mentioned: [], skipped: false }),
  }
}

/** 假会话存储（内存；接口与 qq-host createSessionStore 一致）。 */
export function makeMemorySessionStore(historyLimit = 8) {
  const users = {}
  return {
    users,
    get: (userId) => (Array.isArray(users[userId]) ? users[userId].map((entry) => ({ ...entry })) : []),
    append: (userId, role, text, atIso) => {
      const list = users[userId] ?? []
      list.push({ role, text, at: atIso })
      users[userId] = list.slice(-(historyLimit * 2))
    },
    snapshot: () => ({ users }),
    clear: (userId) => {
      delete users[userId]
    },
    load: () => {},
  }
}

// ───────────── 图片字节 ─────────────

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
export const GIF_BYTES = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
export const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP')])

/** 伪 Response 对象（供 vision.loadImageBytes 的 fetchImpl）。 */
export function makeFakeResponse(bytes, contentType = 'image/png') {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => arrayBuffer,
  }
}

/** 写一张本地 PNG 到临时目录，返回路径。 */
export function writeTempPng(name = 'image.png') {
  const dir = makeTempDir('dshpet-image-')
  const file = path.join(dir, name)
  fs.writeFileSync(file, PNG_BYTES)
  return file
}
