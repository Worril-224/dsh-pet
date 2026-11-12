/**
 * QQ 图片 / 表情包 → Harness 附件（多模态输入）准备。
 *
 * OneBot 11 的 image 段通常带 http(s) url（NapCat 提供）或本地 file 路径；
 * 这里把图片下载/读取为字节，校验类型，再通过 ctx.attachments.saveImages()
 * 换成 durable image attachment，供调用支持视觉的模型（如 deepseek-flash）使用。
 */
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** 单张图片大小上限（字节）。 */
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 允许的图片类型。 */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * 根据文件头判断图片类型。
 * @param {Buffer} bytes
 * @returns {string|undefined}
 */
export function detectImageMediaType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return undefined
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

function mediaTypeFromHint(hint) {
  if (typeof hint !== 'string' || !hint) return undefined
  const value = hint.toLowerCase().split(';')[0].trim()
  if (IMAGE_MEDIA_TYPES.includes(value)) return value
  if (value.endsWith('.png')) return 'image/png'
  if (value.endsWith('.jpg') || value.endsWith('.jpeg')) return 'image/jpeg'
  if (value.endsWith('.webp')) return 'image/webp'
  if (value.endsWith('.gif')) return 'image/gif'
  return undefined
}

function decodeDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value)
  if (!match) return undefined
  const mediaType = mediaTypeFromHint(match[1])
  const body = match[3]
  const bytes = match[2] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8')
  return { bytes, mediaType }
}

/**
 * 把 OneBot image 段转成字节。
 * @param {object} image { url?, file?, path?, base64?, mediaType?, buffer? }
 * @param {{ fetchImpl?: Function, maxBytes?: number }} [options]
 * @returns {Promise<{ bytes: Buffer, mediaType: string }>}
 */
export async function loadImageBytes(image, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, options.maxBytes) : DEFAULT_MAX_IMAGE_BYTES
  if (image && Buffer.isBuffer(image.buffer)) {
    if (image.buffer.byteLength > maxBytes) throw new Error('图片超过大小限制')
    const mediaType = mediaTypeFromHint(image.mediaType) ?? detectImageMediaType(image.buffer)
    if (!mediaType) throw new Error('无法识别的图片格式')
    return { bytes: image.buffer, mediaType }
  }
  const candidates = [image?.url, image?.file, image?.path].filter((value) => typeof value === 'string' && value.trim())
  const base64 = typeof image?.base64 === 'string' ? image.base64 : undefined
  if (base64) {
    const bytes = Buffer.from(base64, 'base64')
    const mediaType = mediaTypeFromHint(image.mediaType) ?? detectImageMediaType(bytes)
    if (!mediaType) throw new Error('无法识别的图片格式')
    return { bytes, mediaType }
  }
  for (const candidate of candidates) {
    const value = candidate.trim()
    if (value.startsWith('data:')) {
      const decoded = decodeDataUrl(value)
      if (!decoded) continue
      if (decoded.bytes.byteLength > maxBytes) throw new Error('图片超过大小限制')
      return { bytes: decoded.bytes, mediaType: decoded.mediaType ?? detectImageMediaType(decoded.bytes) ?? 'image/jpeg' }
    }
    if (value.startsWith('http://') || value.startsWith('https://')) {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch
      if (typeof fetchImpl !== 'function') throw new Error('当前环境没有 fetch，无法下载图片')
      const response = await fetchImpl(value)
      if (!response || !response.ok) throw new Error(`图片下载失败（HTTP ${response?.status ?? '?'}）`)
      const arrayBuffer = await response.arrayBuffer()
      const bytes = Buffer.from(arrayBuffer)
      if (bytes.byteLength > maxBytes) throw new Error('图片超过大小限制')
      const mediaType =
        mediaTypeFromHint(response.headers?.get?.('content-type')) ?? detectImageMediaType(bytes) ?? mediaTypeFromHint(value)
      if (!mediaType) throw new Error('无法识别的图片格式')
      return { bytes, mediaType }
    }
    if (value.startsWith('file://')) {
      const bytes = await fs.readFile(fileURLToPath(value))
      if (bytes.byteLength > maxBytes) throw new Error('图片超过大小限制')
      const mediaType = detectImageMediaType(bytes) ?? mediaTypeFromHint(value)
      if (!mediaType) throw new Error('无法识别的图片格式')
      return { bytes, mediaType }
    }
    // 绝对/相对本地路径
    try {
      const bytes = await fs.readFile(value)
      if (bytes.byteLength > maxBytes) throw new Error('图片超过大小限制')
      const mediaType = detectImageMediaType(bytes) ?? mediaTypeFromHint(value)
      if (!mediaType) throw new Error('无法识别的图片格式')
      return { bytes, mediaType }
    } catch {
      // 尝试下一个候选
    }
  }
  throw new Error('没有可用的图片地址（url/file/base64 均为空或不可读）')
}

/**
 * 把 QQ 图片附件保存为 Harness durable image attachment。
 * @param {object[]} images OneBot 图片元数据数组
 * @param {object} deps
 * @param {any} deps.attachments ctx.get('attachments') 服务（必须有 saveImages）
 * @param {Function} [deps.fetchImpl] 测试注入
 * @param {number} [deps.maxImages] 最多识别几张（默认 4）
 * @param {number} [deps.maxBytes] 单张大小上限
 * @param {any} [deps.logger]
 * @returns {Promise<{ refs: object[], errors: string[], total: number }>}
 */
export async function prepareImageRefs(images, deps = {}) {
  const list = Array.isArray(images) ? images : []
  const result = { refs: [], errors: [], total: list.length }
  if (list.length === 0) return result
  const attachments = deps.attachments
  if (!attachments || typeof attachments.saveImages !== 'function') {
    result.errors.push('attachments 服务不可用，无法保存图片')
    return result
  }
  const maxImages = Number.isFinite(deps.maxImages) ? Math.max(1, Math.round(deps.maxImages)) : 4
  const picked = list.filter((image) => image && typeof image === 'object').slice(0, maxImages)
  for (const image of picked) {
    try {
      const { bytes, mediaType } = await loadImageBytes(image, { fetchImpl: deps.fetchImpl, maxBytes: deps.maxBytes })
      const refs = await attachments.saveImages([
        {
          data: new Uint8Array(bytes),
          mediaType,
          ...(typeof image.name === 'string' && image.name ? { name: image.name.slice(0, 64) } : {}),
        },
      ])
      if (Array.isArray(refs) && refs.length > 0) result.refs.push(...refs)
      else result.errors.push('附件保存未返回引用')
    } catch (error) {
      const message = error?.message ?? String(error)
      result.errors.push(message)
      deps.logger?.warn?.(`[qq] 图片处理失败：${message}`)
    }
  }
  return result
}
