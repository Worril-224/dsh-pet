/**
 * 共享文件工具：原子写、JSON 读写、目录创建。
 * 仅依赖 Node 内置模块（bundle 不能解析 DSH 私有包）。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 递归创建目录。 */
export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 路径是否存在。 */
export function existsSync(p) {
  return fs.existsSync(p)
}

/** 读取 UTF-8 文本；不存在时返回 fallback。 */
export function readTextSync(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw new Error(`读取文件失败：${file}：${error.message}`)
  }
}

/** 读取 JSON；不存在时返回 fallback；解析失败抛出可读错误。 */
export function readJsonSync(file, fallback = undefined) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw new Error(`读取文件失败：${file}：${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`JSON 解析失败：${file}：${error.message}`)
  }
}

function tempName(file) {
  return `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

/** 原子写入 UTF-8 文本（临时文件 + rename）。 */
export function writeTextSync(file, text) {
  ensureDirSync(path.dirname(file))
  const tmp = tempName(file)
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** 原子写入 JSON（2 空格缩进、末尾换行）。 */
export function writeJsonSync(file, value) {
  writeTextSync(file, JSON.stringify(value, null, 2) + '\n')
}

/** 追加一行 JSONL（中文内容按 UTF-8 写入）。 */
export function appendJsonlSync(file, value) {
  ensureDirSync(path.dirname(file))
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
}

/** 复制文件（目标已存在时跳过），返回是否复制。 */
export function copyFileIfMissingSync(src, dest) {
  if (fs.existsSync(dest)) return false
  ensureDirSync(path.dirname(dest))
  fs.copyFileSync(src, dest)
  return true
}
