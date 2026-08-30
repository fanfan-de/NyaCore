/** 本文件定义根 Context 共享的结构化日志流，以及绑定调用方 Context 的 Logger。 */

import type { Context } from './context.js'
import type { Disposer } from './disposable.js'
import type { FiberState } from './fiber.js'
import { withEffectDescriptor } from './diagnostics.js'
import type { EffectDescriptor } from './diagnostics.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogEventCode =
  | 'log'
  | 'fiber/state'
  | 'fiber/config-failed'
  | 'fiber/start-failed'
  | 'fiber/cleanup-failed'
  | 'effect/state'
  | 'effect/setup-failed'
  | 'effect/cleanup-failed'
  | 'logger/sink-failed'

export type LifecyclePhase =
  | 'config'
  | 'start'
  | 'active'
  | 'cleanup'
  | 'dispose'

export type FiberStopReason =
  | 'dependency-change'
  | 'config-update'
  | 'restart'
  | 'stale-start'
  | 'dispose'
  | 'root-restart'

export interface LogRecord {
  readonly sequence: number
  readonly timestamp: string
  readonly level: LogLevel
  /** 结构化事件代码；`event` 是面向日志消费者的同值别名。 */
  readonly code: LogEventCode
  readonly event: LogEventCode
  readonly name: string
  readonly loggerName: string
  readonly message: string
  readonly data?: unknown
  readonly error?: unknown
  readonly fiberId: number
  readonly componentName: string
  readonly fiberState: FiberState
  readonly runId?: number
  readonly phase?: LifecyclePhase
  readonly stopReason?: FiberStopReason
  readonly effectPath?: readonly string[]
}

export type LogSink = (record: LogRecord) => void

export interface LogSubscribeOptions {
  readonly replay?: boolean
  readonly minLevel?: LogLevel
}

export interface Logger {
  readonly name: string

  child(name: string): Logger

  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void

  error(error: unknown): void
  error(message: string, data?: unknown): void

  records(): readonly LogRecord[]
  subscribe(sink: LogSink, options?: LogSubscribeOptions): Disposer
}

export interface RuntimeLogDetails {
  readonly data?: unknown
  readonly error?: unknown
  readonly phase?: LifecyclePhase
  readonly stopReason?: FiberStopReason
  readonly effectPath?: readonly string[]
}

const levelWeights: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

interface Subscriber {
  readonly sink: LogSink
  readonly minLevel: LogLevel
  active: boolean
}

/** 每棵 Context 树独占一个 Hub，避免 Root 间互相观察日志。 */
class LoggerHub {
  #sequence = 0
  #records: LogRecord[] = []
  #subscribers = new Set<Subscriber>()

  publish(
    context: Context,
    name: string,
    level: LogLevel,
    code: LogEventCode,
    message: string,
    details: RuntimeLogDetails = {},
    dispatch = true,
  ) {
    const fiber = context.fiber
    const effectPath = details.effectPath
      ? Object.freeze([...details.effectPath])
      : undefined
    const record = Object.freeze({
      sequence: ++this.#sequence,
      timestamp: new Date().toISOString(),
      level,
      code,
      event: code,
      name,
      loggerName: name,
      message,
      data: details.data,
      error: details.error,
      fiberId: fiber.id,
      componentName: fiber.name,
      fiberState: fiber.state,
      runId: fiber.runId,
      phase: details.phase,
      stopReason: details.stopReason,
      effectPath,
    }) satisfies LogRecord

    this.#records.push(record)
    if (this.#records.length > 1000) {
      this.#records.splice(0, this.#records.length - 1000)
    }

    if (!dispatch) return
    for (const subscriber of [...this.#subscribers]) {
      if (
        subscriber.active
        && levelWeights[level] >= levelWeights[subscriber.minLevel]
      ) {
        this.#deliver(context, subscriber, record)
      }
    }
  }

  records(): readonly LogRecord[] {
    return Object.freeze([...this.#records])
  }

  subscribe(
    context: Context,
    sink: LogSink,
    options: LogSubscribeOptions,
  ): Disposer {
    if (typeof sink !== 'function') {
      throw new TypeError('invalid log sink: expected a function')
    }
    const minLevel = options.minLevel ?? 'debug'
    if (!(minLevel in levelWeights)) {
      throw new TypeError(`invalid log level: ${String(minLevel)}`)
    }

    const subscriber: Subscriber = { sink, minLevel, active: true }
    this.#subscribers.add(subscriber)

    if (options.replay) {
      for (const record of [...this.#records]) {
        if (!subscriber.active) break
        if (levelWeights[record.level] >= levelWeights[minLevel]) {
          this.#deliver(context, subscriber, record)
        }
      }
    }

    return () => {
      if (!subscriber.active) return
      subscriber.active = false
      this.#subscribers.delete(subscriber)
    }
  }

  #deliver(context: Context, subscriber: Subscriber, record: LogRecord) {
    try {
      const result = subscriber.sink(record) as unknown
      if (
        result
        && (typeof result === 'object' || typeof result === 'function')
        && typeof Reflect.get(result, 'then') === 'function'
      ) {
        void Promise.resolve(result).catch(error => {
          this.#failSink(context, subscriber, error)
        })
      }
    } catch (error) {
      this.#failSink(context, subscriber, error)
    }
  }

  #failSink(context: Context, subscriber: Subscriber, error: unknown) {
    if (!subscriber.active) return
    subscriber.active = false
    this.#subscribers.delete(subscriber)
    this.publish(
      context,
      '<logger>',
      'error',
      'logger/sink-failed',
      'log sink failed and was removed',
      { error, phase: 'active' },
      false,
    )
  }
}

const rootHubs = new WeakMap<Context, LoggerHub>()
const contextLoggers = new WeakMap<Context, Logger>()

function getHub(context: Context) {
  const root = context.root
  let hub = rootHubs.get(root)
  if (!hub) {
    hub = new LoggerHub()
    rootHubs.set(root, hub)
  }
  return hub
}

class ContextLogger implements Logger {
  constructor(
    readonly context: Context,
    readonly name: string,
  ) {}

  child(name: string): Logger {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('invalid logger name: expected a non-empty string')
    }
    return new ContextLogger(this.context, `${this.name}/${name}`)
  }

  debug(message: string, data?: unknown) {
    this.#log('debug', message, data)
  }

  info(message: string, data?: unknown) {
    this.#log('info', message, data)
  }

  warn(message: string, data?: unknown) {
    this.#log('warn', message, data)
  }

  error(error: unknown): void
  error(message: string, data?: unknown): void
  error(messageOrError: unknown, data?: unknown) {
    if (typeof messageOrError === 'string') {
      this.#log('error', messageOrError, data)
      return
    }

    let message = 'unknown error'
    try {
      message = messageOrError instanceof Error
        ? messageOrError.message
        : String(messageOrError)
    } catch {
      // error(unknown) 必须能记录任意抛出值，包括带有异常 toString 的对象。
    }
    try {
      getHub(this.context).publish(
        this.context,
        this.name,
        'error',
        'log',
        message,
        { error: messageOrError },
      )
    } catch {
      // Logger 是观察旁路，不能让记录失败进入组件生命周期。
    }
  }

  records() {
    return getHub(this.context).records()
  }

  subscribe(sink: LogSink, options: LogSubscribeOptions = {}): Disposer {
    const descriptor: EffectDescriptor = {
      type: 'logger-subscriber',
      label: `ctx.logger.subscribe(${JSON.stringify(this.name)})`,
    }
    return withEffectDescriptor(
      this.context.fiber,
      descriptor,
      () => this.context.fiber.effect(
        () => getHub(this.context).subscribe(this.context, sink, options),
        descriptor.label,
      ),
    )
  }

  #log(level: LogLevel, message: string, data?: unknown) {
    if (typeof message !== 'string') {
      throw new TypeError('invalid log message: expected a string')
    }
    getHub(this.context).publish(
      this.context,
      this.name,
      level,
      'log',
      message,
      { data },
    )
  }
}

/** 返回绑定当前调用方 Fiber 的 Logger；Service facade 因此自然归属 caller。 */
export function getContextLogger(context: Context): Logger {
  let logger = contextLoggers.get(context)
  if (!logger) {
    logger = new ContextLogger(context, context.fiber.name)
    contextLoggers.set(context, logger)
  }
  return logger
}

/** Core 内部事件入口。日志系统的任何异常都不得进入生命周期控制流。 */
export function logRuntime(
  context: Context,
  level: LogLevel,
  code: Exclude<LogEventCode, 'log' | 'logger/sink-failed'>,
  message: string,
  details: RuntimeLogDetails = {},
) {
  try {
    getHub(context).publish(
      context,
      context.fiber.name,
      level,
      code,
      message,
      details,
    )
  } catch {
    // 日志是观察旁路，不能改变被观察对象的语义。
  }
}
