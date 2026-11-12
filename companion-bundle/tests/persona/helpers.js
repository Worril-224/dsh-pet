/**
 * 人设模块测试共享工具。
 *
 * - 所有测试数据都放在 `fs.mkdtempSync` 创建的操作系统临时目录中，结束后删除；
 * - 绝不读写默认数据目录（~/.dsh/dsh-pet/companion-data）；
 * - 只使用 node:* 内置模块与包内相对路径。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPersonaService } from '../../lib/persona/index.js'

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
export const BUNDLE_ROOT = path.resolve(TESTS_DIR, '../..')
export const DEFAULT_PERSONA_FILE = path.join(BUNDLE_ROOT, 'data', 'persona.default.json')

/** SPEC 3.1 规定的 9 个模块（顺序 / id / 中文名 / 生效方式）。 */
export const EXPECTED_MODULES = Object.freeze([
  ['role_definition', '角色定义', 'always'],
  ['speech_style', '说话风格', 'always'],
  ['herself', '她自己', 'on_demand'],
  ['memory_and_promises', '记忆和承诺', 'always'],
  ['rules', '规则', 'always'],
  ['appearance', '外貌', 'on_demand'],
  ['other_ai_characters', '其他 AI 角色', 'on_demand'],
  ['identity', '身份设定', 'on_demand'],
  ['personal_history', '个人经历', 'on_demand'],
])

/** 读取 bundle 内置的默认人设文件（合法 JSON）。 */
export function readDefaultPersona() {
  return JSON.parse(fs.readFileSync(DEFAULT_PERSONA_FILE, 'utf8'))
}

/** 创建临时数据目录。 */
export function makeTempDataDir(prefix = 'dshpet-persona-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 删除临时数据目录（递归、忽略不存在）。 */
export function removeTempDataDir(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true })
}

/** <dataDir>/persona/persona.json 的路径。 */
export function personaFilePath(dataDir) {
  return path.join(dataDir, 'persona', 'persona.json')
}

/** 读取临时数据目录里的人设 JSON。 */
export function readPersonaFile(dataDir) {
  return JSON.parse(fs.readFileSync(personaFilePath(dataDir), 'utf8'))
}

/** 写入临时数据目录里的人设 JSON（2 空格缩进、末尾换行，与 fsutil 一致）。 */
export function writePersonaFile(dataDir, value) {
  fs.writeFileSync(personaFilePath(dataDir), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 写入原始文本（模拟用户把 JSON 改坏）。 */
export function writeRawPersonaFile(dataDir, text) {
  fs.writeFileSync(personaFilePath(dataDir), text, 'utf8')
}

/** 创建使用临时目录、指向 bundle 默认人设文件的服务。 */
export function createTestService(dataDir, options = {}) {
  return createPersonaService({ dataDir, defaultPersonaFile: DEFAULT_PERSONA_FILE, ...options })
}

/**
 * 在已 ensure() 的临时服务上下文中执行断言回调，结束后清理临时目录。
 * @param {(context: { dataDir: string, service: import('../../lib/persona/index.js').PersonaService }) => void} fn
 */
export function withPersonaService(fn) {
  const dataDir = makeTempDataDir()
  try {
    const service = createTestService(dataDir)
    service.ensure()
    return fn({ dataDir, service })
  } finally {
    removeTempDataDir(dataDir)
  }
}

/**
 * 修改临时人设文件 → reload() → 执行断言回调，用于 validate 负向测试。
 * @param {(definition: any) => void} mutate 直接修改从文件读出的 JSON 对象
 * @param {(context: { dataDir: string, service: any, definition: any }) => void} fn
 */
export function withMutatedPersona(mutate, fn) {
  return withPersonaService(({ dataDir, service }) => {
    const definition = readPersonaFile(dataDir)
    mutate(definition)
    writePersonaFile(dataDir, definition)
    service.reload()
    return fn({ dataDir, service, definition })
  })
}

/** 按 id 取模块。 */
export function moduleOf(definition, id) {
  return Array.isArray(definition?.modules) ? definition.modules.find((module) => module.id === id) : undefined
}

/** 按 id 取模块正文，缺省为空字符串。 */
export function moduleContent(definition, id) {
  const module = moduleOf(definition, id)
  return typeof module?.content === 'string' ? module.content : ''
}
