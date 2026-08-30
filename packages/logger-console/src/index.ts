/** 把 Core 的结构化日志流显式输出到一个 Console 风格的目标。 */

import type {
  Component,
  LogLevel,
  LogRecord,
} from '@nya/core'

/** ConsoleLogger 使用的最小输出接口，便于浏览器、Node.js 和测试替换目标。 */
export interface ConsoleTarget {
  debug(...data: unknown[]): void
  info(...data: unknown[]): void
  warn(...data: unknown[]): void
  error(...data: unknown[]): void
}

export interface ConsoleLoggerOptions {
  /** 最低输出级别；默认忽略 Effect 的 debug 明细。 */
  level?: LogLevel
  /** 安装时是否回放 Core 已缓冲的日志。 */
  replay?: boolean
  /** 是否在每行前显示 ISO 时间戳。 */
  timestamps?: boolean
  /** 接收输出的 Console 风格对象。 */
  target?: ConsoleTarget
}

function formatTimestamp(timestamp: LogRecord['timestamp']): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.valueOf()) ? String(timestamp) : date.toISOString()
}

function formatRunId(runId: LogRecord['runId']): string | undefined {
  if (runId === undefined || runId === null) return undefined
  const value = String(runId)
  return value.startsWith('run-') ? value : `run-${value}`
}

function formatEffectPath(effectPath: LogRecord['effectPath']): string | undefined {
  if (effectPath === undefined || effectPath === null) return undefined
  if (Array.isArray(effectPath)) return effectPath.join(' > ')
  return String(effectPath)
}

/**
 * 生成稳定、单行的日志前缀。结构化 data 与 Error 不在这里字符串化，
 * 而是作为独立 Console 参数传递，以保留对象检查能力和完整 stack。
 */
function formatRecord(record: LogRecord, timestamps: boolean): string {
  const prefix = timestamps ? `${formatTimestamp(record.timestamp)} ` : ''
  const level = record.level.toUpperCase().padEnd(5, ' ')
  const component = record.componentName || record.loggerName || 'anonymous'
  const runId = formatRunId(record.runId)
  const scope = `${component}#${String(record.fiberId)}${runId ? `/${runId}` : ''}`
  const phase = record.phase ? ` [${record.phase}]` : ''
  const state = !record.phase && record.fiberState
    ? ` [${record.fiberState}]`
    : ''
  const stopReason = record.stopReason ? ` (${record.stopReason})` : ''
  const effectPath = formatEffectPath(record.effectPath)
  const effect = effectPath ? ` at ${effectPath}` : ''

  return `${prefix}${level} [${scope}]${phase}${state} ${record.message}${stopReason}${effect}`
}

function writeRecord(
  target: ConsoleTarget,
  record: LogRecord,
  timestamps: boolean,
): void {
  const details: unknown[] = []

  if (record.data !== undefined) details.push(record.data)
  if (record.error !== undefined && record.error !== record.data) {
    details.push(record.error)
  }

  target[record.level](formatRecord(record, timestamps), ...details)
}

/**
 * 显式安装的控制台日志组件。导入此模块不会订阅日志或写入控制台。
 * 返回 Logger subscription disposer，使组件卸载后立即停止输出。
 */
export const ConsoleLogger: Component.Function<ConsoleLoggerOptions> = (
  context,
  options = {},
) => {
  const {
    level = 'info',
    replay = true,
    timestamps = true,
    target = globalThis.console,
  } = options

  return context.logger.subscribe(
    record => writeRecord(target, record, timestamps),
    { minLevel: level, replay },
  )
}
