import { describe, expect, it, vi } from 'vitest'
import type {
  Context,
  Disposer,
  LogRecord,
  LogSink,
  Logger,
} from '@nya/core'
import { Context as CoreContext } from '@nya/core'
import {
  ConsoleLogger,
} from '../src/index.js'
import type {
  ConsoleLoggerOptions,
  ConsoleTarget,
} from '../src/index.js'

function createTarget(): ConsoleTarget {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function createRecord(
  overrides: Partial<LogRecord> = {},
): LogRecord {
  return {
    sequence: 1,
    timestamp: '2026-08-30T12:00:00.000Z',
    level: 'info',
    code: 'log',
    event: 'log',
    name: 'worker',
    loggerName: 'worker',
    message: 'ready',
    fiberId: 3,
    componentName: 'worker',
    fiberState: 'ACTIVE',
    runId: 2,
    ...overrides,
  } as LogRecord
}

function install(options: ConsoleLoggerOptions = {}) {
  let sink: LogSink | undefined
  const dispose = vi.fn() as unknown as Disposer
  const subscribe = vi.fn((received: LogSink) => {
    sink = received
    return dispose
  })
  const context = {
    logger: { subscribe } as unknown as Logger,
  } as unknown as Context

  const cleanup = ConsoleLogger(context, options)

  return {
    cleanup,
    dispose,
    emit(record: LogRecord) {
      if (!sink) throw new Error('ConsoleLogger did not subscribe')
      sink(record)
    },
    subscribe,
  }
}

describe('ConsoleLogger', () => {
  it('uses info, replay, timestamps, and global console by default', () => {
    const { subscribe } = install()

    expect(subscribe).toHaveBeenCalledWith(
      expect.any(Function),
      { minLevel: 'info', replay: true },
    )
  })

  it('passes explicit filtering and replay options to Core', () => {
    const target = createTarget()
    const { subscribe } = install({
      level: 'debug',
      replay: false,
      target,
    })

    expect(subscribe).toHaveBeenCalledWith(
      expect.any(Function),
      { minLevel: 'debug', replay: false },
    )
  })

  it('routes every level to the corresponding console method', () => {
    const target = createTarget()
    const { emit } = install({ target, timestamps: false })

    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      emit(createRecord({ level, message: `${level} message` }))
      expect(target[level]).toHaveBeenCalledWith(
        expect.stringContaining(`${level} message`),
      )
    }
  })

  it('includes fiber, run, phase, reason, and effect path metadata', () => {
    const target = createTarget()
    const { emit } = install({ target, timestamps: false })

    emit(createRecord({
      level: 'error',
      message: 'cleanup failed',
      phase: 'cleanup',
      stopReason: 'dependency-change',
      effectPath: ['worker', 'ctx.on("record/created")'],
    }))

    expect(target.error).toHaveBeenCalledWith(
      'ERROR [worker#3/run-2] [cleanup] cleanup failed (dependency-change) at worker > ctx.on("record/created")',
    )
  })

  it('renders an ISO timestamp when enabled', () => {
    const target = createTarget()
    const { emit } = install({ target })

    emit(createRecord())

    expect(target.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^2026-08-30T[0-9:.]+Z INFO  \[worker#3\/run-2\]/,
      ),
    )
  })

  it('keeps structured data and Error as separate console arguments', () => {
    const target = createTarget()
    const error = new Error('boom')
    const data = { attempt: 2 }
    const { emit } = install({ target, timestamps: false })

    emit(createRecord({ level: 'error', error, data }))

    expect(target.error).toHaveBeenCalledWith(
      expect.stringContaining('ready'),
      data,
      error,
    )
  })

  it('returns the subscription disposer so component unload stops output', () => {
    const { cleanup, dispose } = install()

    expect(cleanup).toBe(dispose)
  })

  it('replays buffered info, filters debug, and stops after real Fiber disposal', async () => {
    const app = new CoreContext()
    const target = createTarget()
    app.logger.debug('early debug')
    app.logger.info('early info')

    const loggerFiber = app.installComponent(ConsoleLogger, {
      target,
      timestamps: false,
    })
    await loggerFiber

    expect(target.debug).not.toHaveBeenCalled()
    expect(vi.mocked(target.info).mock.calls.some(([message]) => {
      return String(message).includes('early info')
    })).toBe(true)
    expect(vi.mocked(target.info).mock.calls.some(([message]) => {
      return String(message).includes('early debug')
    })).toBe(false)

    vi.clearAllMocks()
    app.logger.debug('live debug')
    app.logger.warn('live warning')
    expect(target.debug).not.toHaveBeenCalled()
    expect(target.warn).toHaveBeenCalledWith(
      expect.stringContaining('live warning'),
    )

    await loggerFiber.dispose()
    vi.clearAllMocks()
    app.logger.error('after logger disposal')
    expect(target.error).not.toHaveBeenCalled()

    await app.fiber.dispose()
  })
})
