/**
 * 记忆模块公共入口（SPEC 4.12）。
 * 导出面严格为：getMemoryEngine / resetMemoryEngineRegistry / DEFAULT_MEMORY_CONFIG。
 * 仅依赖 node:* 内置模块与包内相对路径（bundle 不能依赖任何 npm 包）。
 */
import path from 'node:path'
import { DEFAULT_DATA_DIR, DEFAULT_MEMORY_CONFIG } from './constants.js'
import { MemoryEngine } from './engine.js'

/** @type {Map<string, MemoryEngine>} dataDir → 记忆引擎单例 */
const registry = new Map()

/**
 * 取得指定数据目录的记忆引擎；同一 dataDir 返回同一实例。
 * @param {{ dataDir?: string, clock?: { now: () => number }, config?: object }} [options]
 * @returns {MemoryEngine}
 */
export function getMemoryEngine({ dataDir, clock, config } = {}) {
  const root = path.resolve(dataDir || DEFAULT_DATA_DIR)
  const existing = registry.get(root)
  if (existing) {
    // 若导入脚本在进程运行期间写入了 pending-seed，这里吸收，避免旧内存态覆盖新记忆
    try {
      existing.consumePendingSeedIfAny()
    } catch {
      // 吸收失败不影响正常使用
    }
    return existing
  }
  const engine = new MemoryEngine({ dataDir: root, clock, config })
  registry.set(root, engine)
  try {
    engine.consumePendingSeedIfAny()
  } catch {
    // 首次加载失败由调用方 ensure() 处理
  }
  return engine
}

/** 清空记忆引擎注册表（测试用）。 */
export function resetMemoryEngineRegistry() {
  registry.clear()
}

export { DEFAULT_MEMORY_CONFIG }
