/** B站观看模块：公开 API 客户端 + 每日随机观看调度器。 */
export {
  BilibiliError,
  cleanBilibiliText,
  createBilibiliClient,
  csrfFromCookie,
  normalizeAid,
} from './client.js'
export {
  DEFAULT_BILIBILI_CONFIG,
  createBilibiliWatcher,
  resolveBilibiliConfig,
} from './watcher.js'
