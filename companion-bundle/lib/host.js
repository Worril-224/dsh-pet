/**
 * companion-host：Host 插件。
 *
 * 职责（方案 A：每个角色一个独立 dataDir）：
 *  1. 扫描角色根目录（默认 ~/.dsh/dsh-pet/companion-data/characters，可用 DSH_PET_DATA_DIR 覆盖），
 *     为每个角色初始化独立记忆引擎；
 *  2. 每 N 分钟检查一次记忆维护窗口（本地时间 04:00–06:00），逐角色执行维护 / 补跑；
 *  3. 启动时立即检查一次；每次检查重新扫描角色目录，新建角色无需重启即可纳入维护；
 *  4. 兼容旧版单目录模式：若只配置了 dataDir（没有 charactersDir），仍按单目录维护。
 *
 * 注意：本包不依赖任何 npm 包，只使用 Node 内置模块与包内相对导入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getMemoryEngine } from './memory/index.js'
import { createSystemClock } from './shared/clock.js'
import { listCharacters, resolveCharactersRoot } from './characters.js'
import { createPersonaService } from './persona/index.js'
import { generatePlanForMaintenance } from './life/index.js'
import { createBilibiliWatcher } from './bilibili/index.js'
import { startBilibiliLoginServer } from './bilibili/login-server.js'
import { createMemoryAnalyzer } from './memory/analyzer.js'
import { attachModelRoutes } from './model-control.js'

/** Loader 插件名。 */
export const name = 'companion-host'

/** 本插件不强制依赖任何服务（timer / webServer 均按可用性使用）。 */
export const inject = []

/**
 * 默认数据目录（可移植）：优先环境变量 DSH_PET_DATA_DIR，
 * 否则使用用户主目录下的 ~/.dsh/dsh-pet/companion-data。
 */
export const DEFAULT_DATA_DIR =
  process.env.DSH_PET_DATA_DIR || path.join(os.homedir(), '.dsh', 'dsh-pet', 'companion-data')

/** 默认角色根目录（方案 A，与 characters.js 保持一致）。 */
export const DEFAULT_CHARACTERS_DIR = path.join(DEFAULT_DATA_DIR, 'characters')

/** 默认检查间隔（分钟）。 */
export const DEFAULT_CHECK_INTERVAL_MINUTES = 10

function log(ctx, level, message) {
  try {
    const logger = ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](`[companion] ${message}`)
  } catch {
    // 日志失败不影响插件运行
  }
}

/**
 * 规范化插件配置。
 * - 显式 charactersDir（或多角色默认）→ 多角色模式；
 * - 显式 dataDir 且无 charactersDir → 旧版单目录模式（向后兼容）。
 * @param {object} config Loader 行配置
 */
export function normalizeConfig(config = {}) {
  const hasCharactersDir = typeof config.charactersDir === 'string' && config.charactersDir.trim() !== ''
  const hasDataDir = typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
  const charactersDir = hasCharactersDir
    ? path.resolve(config.charactersDir.trim())
    : hasDataDir
      ? undefined
      : path.resolve(DEFAULT_CHARACTERS_DIR)
  const dataDir = hasDataDir ? path.resolve(config.dataDir.trim()) : path.resolve(DEFAULT_DATA_DIR)
  const checkIntervalMinutes = Number.isFinite(config.checkIntervalMinutes)
    ? Math.max(1, Math.round(config.checkIntervalMinutes))
    : DEFAULT_CHECK_INTERVAL_MINUTES
  return {
    charactersDir,
    dataDir,
    checkIntervalMinutes,
    memoryConfig: config.memoryConfig && typeof config.memoryConfig === 'object' ? config.memoryConfig : undefined,
    bilibili: config.bilibili && typeof config.bilibili === 'object' ? config.bilibili : {},
    lifeDeferredContent: config.lifeDeferredContent !== false,
  }
}

/** 旧版单目录是否已经有数据（用于 charactersDir 为空时的兼容回退）。 */
export function hasLegacyData(dataDir) {
  if (!dataDir) return false
  return (
    fs.existsSync(path.join(dataDir, 'persona', 'persona.json')) || fs.existsSync(path.join(dataDir, 'memory'))
  )
}

/**
 * 列出本次维护需要覆盖的角色目标。
 * @param {ReturnType<typeof normalizeConfig>} settings
 * @returns {Array<{id:string,dataDir:string,name:string,role:string}>}
 */
export function listMaintenanceTargets(settings) {
  const targets = []
  if (settings.charactersDir) {
    for (const character of listCharacters(settings.charactersDir)) {
      targets.push({ id: character.id, dataDir: character.dir, name: character.name, role: character.role })
    }
    // 方案 A 尚未迁移/没有任何角色时，回退维护旧版单目录，保证不丢维护
    if (targets.length === 0 && hasLegacyData(settings.dataDir)) {
      targets.push({ id: 'legacy', dataDir: settings.dataDir, name: '（旧版单目录）', role: '兼容' })
    }
  } else {
    targets.push({ id: 'legacy', dataDir: settings.dataDir, name: '（单目录模式）', role: '兼容' })
  }
  return targets
}

/**
 * 执行一次维护检查；返回本次报告或检查结果。
 * 供测试直接调用（不依赖 Cordis 运行时）。
 * @param {any} engine 记忆引擎
 * @param {{ now: () => number }} clock
 */
export function runMaintenanceCheck(engine, clock) {
  const at = clock.now()
  const check = engine.checkMaintenance({ at })
  if (!check || check.shouldRun !== true) return { ran: false, check }
  const report = engine.maintain({ at, reason: check.reason })
  return { ran: true, check, report }
}

/**
 * 为配置覆盖到的所有角色各执行一次维护检查（多角色入口）。
 * @param {ReturnType<typeof normalizeConfig>} settings
 * @param {{ now: () => number }} clock
 * @returns {Array<{id:string,dataDir:string,name:string,role:string,engine?:any,ran?:boolean,check?:any,report?:any,error?:string}>}
 */
export function runAllMaintenance(settings, clock) {
  const results = []
  for (const target of listMaintenanceTargets(settings)) {
    try {
      const engine = getMemoryEngine({ dataDir: target.dataDir, clock, config: settings.memoryConfig })
      engine.ensure()
      results.push({ ...target, engine, ...runMaintenanceCheck(engine, clock) })
    } catch (error) {
      results.push({ ...target, error: error?.message ?? String(error) })
    }
  }
  return results
}

/**
 * 维护完成后为各角色生成「第二天」的每日生活事件计划（功能 2）。
 * 需要 ctx.llm；web 可选。任何单个角色失败只记日志，不影响记忆维护。
 * @param {any} ctx
 * @param {ReturnType<typeof normalizeConfig>} settings
 * @param {Array<{id:string,dataDir:string,name?:string,engine?:any}>} targets
 * @param {string} origin 触发来源（启动检查/定时检查）
 * @param {{now:()=>number}} clock
 */
async function generateDayPlans(ctx, settings, targets, origin, clock) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.prepareCall !== 'function') {
    log(ctx, 'info', `跳过每日生活计划生成（${origin}）：缺少 ctx.llm 服务`)
    return
  }
  const web = ctx.get('web')
  const agentDefaultModel = ctx.get('agentDefaultModel')
  const modelSelection =
    agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function'
      ? () => agentDefaultModel.currentSelection()
      : undefined
  for (const target of targets) {
    try {
      const persona = createPersonaService({ dataDir: target.dataDir })
      persona.ensure()
      const result = await generatePlanForMaintenance({
        dataDir: target.dataDir,
        characterId: target.id,
        characterName: target.name,
        persona,
        memory: target.engine,
        llm,
        web,
        clock,
        modelSelection,
        source: 'nightly-memory-maintenance',
        deferredContent: settings.lifeDeferredContent !== false,
        logger: { warn: (message) => log(ctx, 'warn', String(message)) },
      })
      if (result.generated) {
        log(ctx, 'info', `每日生活计划已生成（${origin} / ${target.id}）：${result.dateKey}`)
      }
    } catch (error) {
      log(ctx, 'warn', `每日生活计划生成失败（${origin} / ${target.id}）：${error?.message ?? error}`)
    }
  }
}

/**
 * 启动 B站每日观看调度器（每个角色一个，独立 dataDir / 兴趣标签 / 记忆）。
 * 没有配置账号 Cookie 时仍可搜索、观看、总结、写记忆，只是不会发评论。
 * @param {any} ctx Cordis 上下文
 * @param {ReturnType<typeof normalizeConfig>} settings
 * @param {{now:()=>number}} clock
 * @param {Array<{id:string,dataDir:string,engine:any}>} engines
 */
function startBilibiliWatchers(ctx, settings, clock, engines) {
  if (settings.bilibili?.enabled === false || engines.length === 0) return []
  const llm = ctx.get('llm')
  const agentDefaultModel = ctx.get('agentDefaultModel')
  const modelSelection =
    agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function'
      ? () => agentDefaultModel.currentSelection()
      : undefined
  const watchers = []
  const memoryAnalyzer = createMemoryAnalyzer({
    llm,
    modelSelection,
    logger: {
      warn: (message) => log(ctx, 'warn', `[memory] ${message}`),
    },
    maxTokens: 2400,
  })
  for (const target of engines) {
    try {
      const persona = createPersonaService({ dataDir: target.dataDir, clock })
      persona.ensure()
      const watcher = createBilibiliWatcher({
        dataDir: target.dataDir,
        characterId: target.id,
        persona,
        memory: target.engine,
        llm,
        modelSelection,
        analyzer: memoryAnalyzer,
        clock,
        config: settings.bilibili,
        logger: {
          info: (message) => log(ctx, 'info', `[bilibili:${target.id}] ${message}`),
          warn: (message) => log(ctx, 'warn', `[bilibili:${target.id}] ${message}`),
          error: (message) => log(ctx, 'error', `[bilibili:${target.id}] ${message}`),
        },
      })
      watchers.push(watcher)
      log(ctx, 'info', `B站观看调度器已启动：[${target.id}] ${watcher.stateFile}`)
    } catch (error) {
      log(ctx, 'warn', `B站观看调度器启动失败 [${target.id}]：${error?.message ?? error}`)
    }
  }
  if (watchers.length === 0) return []

  const loginLogger = {
    info: (message) => log(ctx, 'info', message),
    warn: (message) => log(ctx, 'warn', message),
  }
  const mountLoginServer = (loginCtx) => {
    const loginServer = startBilibiliLoginServer(loginCtx, watchers[0], loginLogger)
    if (loginServer) log(ctx, 'info', 'B站扫码登录页：/dsh-companion/bili/login')
  }
  // 冷启动时 webServer 可能还没就绪；等它可用后再挂登录页。
  if (ctx.get('webServer')) mountLoginServer(ctx)
  else if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountLoginServer)

  const tickAll = async (reason) => {
    for (const watcher of watchers) {
      try {
        const result = await watcher.tick()
        if (result?.ok) log(ctx, 'info', `B站观看（${reason}）：${JSON.stringify(result)}`)
      } catch (error) {
        log(ctx, 'warn', `B站观看检查失败（${reason}）：${error?.message ?? error}`)
      }
    }
  }

  ctx.effect(() => {
    const timer = ctx.get('timer')
    if (timer && typeof timer.interval === 'function') {
      const stopInitial = timer.timeout(() => tickAll('启动检查'), 15000)
      const stopInterval = timer.interval(() => tickAll('定时检查'), 60 * 1000)
      return () => {
        try { stopInitial?.() } catch { /* ignore */ }
        try { stopInterval?.() } catch { /* ignore */ }
      }
    }
    const initial = setTimeout(() => tickAll('启动检查'), 15000)
    const interval = setInterval(() => tickAll('定时检查'), 60 * 1000)
    return () => {
      clearTimeout(initial)
      clearInterval(interval)
    }
  })
  return watchers
}

/**
 * Host 插件入口。
 * @param {any} ctx Cordis 上下文
 * @param {object} config Loader 行配置
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const clock = createSystemClock()

  // Web UI 左侧「模型」面板：模型目录 + Harness 默认模型读写。
  // 冷启动时 webServer 可能还没就绪，attach 会等它出现后再注册路由。
  attachModelRoutes(ctx, {
    logger: ctx.logger,
    presetsFile: path.join(settings.dataDir, 'models-presets.json'),
  })

  if (settings.charactersDir) {
    try {
      fs.mkdirSync(settings.charactersDir, { recursive: true })
    } catch (error) {
      log(ctx, 'error', `无法创建角色根目录 ${settings.charactersDir}：${error?.message ?? error}`)
    }
  }

  // 启动时先初始化一次引擎（创建目录/空文件），便于观测插件已激活。
  const initialEngines = []
  for (const target of listMaintenanceTargets(settings)) {
    try {
      const engine = getMemoryEngine({ dataDir: target.dataDir, clock, config: settings.memoryConfig })
      engine.ensure()
      initialEngines.push({ ...target, engine })
      log(ctx, 'info', `记忆引擎已初始化：[${target.id}] ${target.dataDir}`)
    } catch (error) {
      log(ctx, 'error', `记忆引擎初始化失败 [${target.id}]：${error?.message ?? error}`)
    }
  }

  // B站观看：每天随机时间、最多 20 个视频、每个视频写记忆；评论需账号配置。
  const bilibiliWatchers = startBilibiliWatchers(ctx, settings, clock, initialEngines)

  const checkOnce = (origin) => {
    let results = []
    try {
      results = runAllMaintenance(settings, clock)
      for (const result of results) {
        if (result.error) {
          log(ctx, 'error', `记忆维护检查失败（${origin} / ${result.id}）：${result.error}`)
        } else if (result.ran) {
          log(ctx, 'info', `记忆维护已执行（${origin} / ${result.id}）：${JSON.stringify(result.report)}`)
        }
      }
    } catch (error) {
      log(ctx, 'error', `记忆维护检查失败（${origin}）：${error?.message ?? error}`)
      return
    }
    // 维护完成后生成「第二天」的每日生活事件计划（有 llm 时；失败只记日志，不影响维护）
    const ranTargets = results.filter((result) => result.ran && !result.error)
    if (ranTargets.length > 0) {
      generateDayPlans(ctx, settings, ranTargets, origin, clock).catch((error) => {
        log(ctx, 'warn', `每日生活计划生成失败（${origin}）：${error?.message ?? error}`)
      })
    }
  }

  // 启动后立即检查一次（异步，避免阻塞插件激活）。
  ctx.effect(() => {
    const timer = ctx.get('timer')
    if (timer && typeof timer.timeout === 'function') {
      return timer.timeout(() => checkOnce('启动检查'), 0)
    }
    const handle = setTimeout(() => checkOnce('启动检查'), 0)
    return () => clearTimeout(handle)
  })

  // 周期检查。
  const intervalMs = settings.checkIntervalMinutes * 60 * 1000
  ctx.effect(() => {
    const timer = ctx.get('timer')
    if (timer && typeof timer.interval === 'function') {
      return timer.interval(() => checkOnce('定时检查'), intervalMs)
    }
    const handle = setInterval(() => checkOnce('定时检查'), intervalMs)
    return () => clearInterval(handle)
  })

  return {
    settings,
    /** 兼容旧测试：首个目标的引擎。 */
    engine: initialEngines[0]?.engine,
    /** 启动时初始化到的引擎列表（[{id, dataDir, engine}]）。 */
    engines: initialEngines,
    /** 当前应维护的目标（每次调用重新扫描角色根目录）。 */
    targets: () => listMaintenanceTargets(settings),
    /** B站观看调度器（每个已初始化角色一个）。 */
    bilibiliWatchers,
  }
}
