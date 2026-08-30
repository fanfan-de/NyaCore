import { describe, expect, it, vi } from 'vitest'
import {
  Context,
  FiberState,
  Service,
  serviceInit,
} from '../src/index.js'
import type {
  EffectDiagnosticSnapshot,
  FiberDiagnosticSnapshot,
  LogRecord,
} from '../src/index.js'
import { fiberBeforeUnload } from '../src/symbols.js'

declare module '../src/index.js' {
  interface Events {
    diagnostic(): void
  }
}

function flattenEffects(
  effects: readonly EffectDiagnosticSnapshot[],
): EffectDiagnosticSnapshot[] {
  return effects.flatMap(effect => [
    effect,
    ...flattenEffects(effect.children),
  ])
}

function findEffect(snapshot: FiberDiagnosticSnapshot, label: string) {
  return flattenEffects(snapshot.effects).find(effect => effect.label === label)
}

describe('structured logger', () => {
  it('records all levels with caller metadata and child namespaces', async () => {
    const app = new Context()
    let workerContext!: Context
    const worker = app.installComponent({
      name: 'worker',
      apply(context) {
        workerContext = context
        context.logger.debug('debug')
        context.logger.child('database').info('connected', { port: 5432 })
        context.logger.warn('slow')
        context.logger.error(new Error('offline'))
      },
    })
    await worker

    const userRecords = app.logger.records().filter(record => record.code === 'log')
    expect(userRecords.map(record => record.level)).toEqual([
      'debug',
      'info',
      'warn',
      'error',
    ])
    expect(userRecords[1]).toMatchObject({
      name: 'worker/database',
      loggerName: 'worker/database',
      componentName: 'worker',
      fiberId: worker.id,
      runId: 1,
      fiberState: FiberState.LOADING,
      data: { port: 5432 },
    })
    expect(userRecords[3].error).toBeInstanceOf(Error)
    expect(workerContext.logger.records()).toEqual(app.logger.records())

    await worker.dispose()
  })

  it('keeps only the newest 1000 records and isolates roots', () => {
    const first = new Context()
    const second = new Context()

    for (let index = 0; index < 1005; index++) {
      first.logger.debug(`line-${index}`)
    }

    const records = first.logger.records()
    expect(records).toHaveLength(1000)
    expect(records[0].message).toBe('line-5')
    expect(records.at(-1)?.message).toBe('line-1004')
    expect(Object.isFrozen(records)).toBe(true)
    expect(second.logger.records()).toEqual([])
  })

  it('replays with level filtering and removes a sink after its first failure', async () => {
    const app = new Context()
    app.logger.debug('old-debug')
    app.logger.warn('old-warning')

    const replayed: LogRecord[] = []
    const unsubscribe = app.logger.subscribe(
      record => replayed.push(record),
      { replay: true, minLevel: 'warn' },
    )
    expect(replayed.map(record => record.message)).toEqual(['old-warning'])

    const sinkError = new Error('sink failed')
    const sink = vi.fn(() => {
      throw sinkError
    })
    app.logger.subscribe(sink, { minLevel: 'info' })
    app.logger.warn('first')
    app.logger.warn('second')

    expect(sink).toHaveBeenCalledTimes(1)
    expect(app.logger.records().find(record => {
      return record.code === 'logger/sink-failed'
    })?.error).toBe(sinkError)

    await unsubscribe()
    app.logger.warn('after-unsubscribe')
    expect(replayed.map(record => record.message)).toEqual([
      'old-warning',
      'first',
      'second',
    ])
  })

  it('attributes Service method logs to the caller Fiber', async () => {
    class WorkerService extends Service {
      static provide = 'worker'

      run() {
        this.ctx.logger.info('called through service')
      }
    }

    const app = new Context()
    const provider = app.installComponent(WorkerService)
    await provider

    const consumer = app.installComponent({
      name: 'consumer',
      inject: ['worker'],
      apply(context) {
        ;(context.get('worker') as WorkerService).run()
      },
    })
    await consumer

    const record = app.logger.records().find(entry => {
      return entry.message === 'called through service'
    })
    expect(record).toMatchObject({
      componentName: 'consumer',
      fiberId: consumer.id,
      loggerName: 'consumer',
    })

    await consumer.dispose()
    await provider.dispose()
  })

  it('protects Context.logger while keeping an explicit logger service readable', async () => {
    const app = new Context()
    expect(() => app.extend({ logger: 'invalid' })).toThrow(
      'cannot override Context.logger',
    )
    const dispose = app.provide('logger', 'service-value')
    expect(app.get('logger')).toBe('service-value')
    expect(app.logger.name).toBe('<root>')
    await dispose()
  })

  it('accepts arbitrary thrown values without letting formatting fail the caller', () => {
    const app = new Context()
    const thrown = {
      toString() {
        throw new Error('cannot format')
      },
    }

    expect(() => app.logger.error(thrown)).not.toThrow()
    expect(app.logger.records().at(-1)).toMatchObject({
      code: 'log',
      level: 'error',
      message: 'unknown error',
      error: thrown,
    })
  })
})

describe('Fiber and Effect diagnostics', () => {
  it('classifies owned effects and exposes installed child Fibers', async () => {
    const app = new Context()
    let child!: ReturnType<Context['installComponent']>
    const subscriber = vi.fn()
    const parent = app.installComponent({
      name: 'parent',
      apply(context) {
        context.effect(() => {}, 'custom resource')
        context.on('diagnostic', () => {})
        context.once('diagnostic', () => {})
        context.provide('diagnostic-service', { ready: true })
        context.logger.subscribe(subscriber, { minLevel: 'error' })
        child = context.installComponent({ name: 'child', apply() {} })
      },
    })
    await parent
    await child

    const snapshot = parent.inspect()
    const effects = flattenEffects(snapshot.effects)
    expect(effects.map(effect => effect.type)).toEqual(expect.arrayContaining([
      'component-entry',
      'custom',
      'event-listener',
      'service-provider',
      'logger-subscriber',
      'component-install',
    ]))
    expect(effects.filter(effect => effect.type === 'event-listener')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventName: 'diagnostic',
          listenerKind: 'on',
          global: false,
        }),
        expect.objectContaining({
          eventName: 'diagnostic',
          listenerKind: 'once',
          global: false,
        }),
      ]),
    )
    expect(effects.find(effect => effect.type === 'service-provider')).toMatchObject({
      serviceName: 'diagnostic-service',
      ownerFiberId: parent.id,
      sourceFiberId: parent.id,
    })
    expect(snapshot.children).toHaveLength(1)
    expect(snapshot.children[0]).toMatchObject({
      fiberId: child.id,
      componentName: 'child',
    })

    await parent.dispose()
    app.logger.error('after parent disposal')
    expect(subscriber).not.toHaveBeenCalled()
  })

  it('shows a pending asynchronous cleanup as disposing', async () => {
    const app = new Context()
    let beginCleanup!: () => void
    let finishCleanup!: () => void
    const cleanupBegan = new Promise<void>(resolve => {
      beginCleanup = resolve
    })
    const cleanupCanFinish = new Promise<void>(resolve => {
      finishCleanup = resolve
    })

    const fiber = app.installComponent({
      name: 'worker',
      apply(context) {
        context.effect(() => async () => {
          beginCleanup()
          await cleanupCanFinish
        }, 'slow cleanup')
      },
    })
    await fiber

    const disposing = fiber.dispose()
    await cleanupBegan
    expect(fiber.state).toBe(FiberState.UNLOADING)
    expect(findEffect(fiber.inspect(), 'slow cleanup')?.state).toBe('disposing')

    finishCleanup()
    await disposing
    expect(fiber.inspect().effects).toEqual([])
  })

  it('preserves the original cleanup error and a frozen failure snapshot', async () => {
    const app = new Context()
    const cleanupError = new Error('cleanup failed')
    const fiber = app.installComponent({
      name: 'worker',
      apply(context) {
        context.effect(() => () => {
          throw cleanupError
        }, 'broken cleanup')
      },
    })
    await fiber

    await expect(fiber.dispose()).rejects.toBe(cleanupError)
    const snapshot = fiber.inspect()
    expect(snapshot.state).toBe(FiberState.DISPOSED)
    expect(snapshot.runId).toBe(1)
    expect(snapshot.lastFailure).toMatchObject({
      runId: 1,
      phase: 'cleanup',
      stopReason: 'dispose',
      error: cleanupError,
    })
    expect(snapshot.lastFailure?.effectPaths).toContainEqual([
      'ctx.installComponent("worker")',
      'broken cleanup',
    ])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.lastFailure)).toBe(true)
    expect(Object.isFrozen(snapshot.lastFailure?.effects)).toBe(true)

    const summaries = app.logger.records().filter(record => {
      return record.code === 'fiber/cleanup-failed'
        && record.fiberId === fiber.id
    })
    const duplicateDetails = app.logger.records().filter(record => {
      return record.code === 'effect/cleanup-failed'
        && record.fiberId === fiber.id
    })
    expect(summaries).toHaveLength(1)
    expect(duplicateDetails).toHaveLength(0)
  })

  it('captures synchronous startup failures without changing error identity', async () => {
    const app = new Context()
    const startupError = new Error('startup failed')
    const fiber = app.installComponent({
      name: 'worker',
      apply(context) {
        context.effect(() => {
          throw startupError
        }, 'broken startup')
      },
    })

    await expect(fiber.awaitStable()).rejects.toBe(startupError)
    const snapshot = fiber.inspect()
    expect(snapshot.state).toBe(FiberState.FAILED)
    expect(snapshot.lastFailure).toMatchObject({
      runId: 1,
      phase: 'start',
      error: startupError,
    })
    expect(snapshot.lastFailure?.effectPaths).toContainEqual([
      'ctx.installComponent("worker")',
      'broken startup',
    ])
    expect(app.logger.records().filter(record => {
      return record.code === 'fiber/start-failed' && record.fiberId === fiber.id
    })).toHaveLength(1)
    expect(app.logger.records().filter(record => {
      return record.code === 'effect/setup-failed' && record.fiberId === fiber.id
    })).toHaveLength(0)

    await fiber.dispose()
  })

  it('records configuration failures without entering the component', async () => {
    const app = new Context()
    const configError = new Error('invalid configuration')
    const apply = vi.fn()
    const fiber = app.installComponent({
      Config: {
        '~standard': {
          version: 1 as const,
          vendor: 'diagnostics-test',
          validate() {
            throw configError
          },
        },
      },
      apply,
    })

    await expect(fiber.awaitStable()).rejects.toBe(configError)
    expect(apply).not.toHaveBeenCalled()
    expect(fiber.inspect().lastFailure).toMatchObject({
      phase: 'config',
      error: configError,
    })
    expect(app.logger.records().filter(record => {
      return record.code === 'fiber/config-failed' && record.fiberId === fiber.id
    })).toHaveLength(1)

    await fiber.dispose()
  })

  it('captures asynchronous function and class startup failures', async () => {
    const app = new Context()
    const functionError = new Error('async function failed')
    const functionFiber = app.installComponent({
      name: 'async-function',
      async apply() {
        await Promise.resolve()
        throw functionError
      },
    })
    await expect(functionFiber.awaitStable()).rejects.toBe(functionError)
    expect(functionFiber.inspect().lastFailure).toMatchObject({
      phase: 'start',
      error: functionError,
    })

    const classError = new Error('async class failed')
    class AsyncClassComponent {
      async [serviceInit]() {
        await Promise.resolve()
        throw classError
      }
    }
    const classFiber = app.installComponent(AsyncClassComponent)
    await expect(classFiber.awaitStable()).rejects.toBe(classError)
    expect(classFiber.inspect().lastFailure).toMatchObject({
      phase: 'start',
      error: classError,
    })

    await functionFiber.dispose()
    await classFiber.dispose()
  })

  it('keeps all cleanup leaf paths and the original AggregateError order', async () => {
    const app = new Context()
    const firstError = new Error('first cleanup failed')
    const secondError = new Error('second cleanup failed')
    const fiber = app.installComponent({
      name: 'multi-cleanup',
      apply(context) {
        context.effect(() => () => {
          throw firstError
        }, 'first cleanup')
        context.effect(() => () => {
          throw secondError
        }, 'second cleanup')
      },
    })
    await fiber

    let failure!: AggregateError
    try {
      await fiber.dispose()
    } catch (error) {
      failure = error as AggregateError
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([secondError, firstError])
    expect(fiber.inspect().lastFailure?.effectPaths).toEqual([
      ['ctx.installComponent("multi-cleanup")', 'second cleanup'],
      ['ctx.installComponent("multi-cleanup")', 'first cleanup'],
    ])
    expect(app.logger.records().filter(record => {
      return record.code === 'fiber/cleanup-failed'
        && record.fiberId === fiber.id
    })).toHaveLength(1)
  })

  it('keeps synchronous nesting but treats post-await Effects as run roots', async () => {
    const app = new Context()
    const fiber = app.installComponent({
      name: 'async-effects',
      async apply(context) {
        context.effect(() => {}, 'before await')
        await Promise.resolve()
        context.effect(() => {}, 'after await')
      },
    })
    await fiber

    const firstRun = fiber.inspect()
    const entry = firstRun.effects.find(effect => {
      return effect.type === 'component-entry'
    })
    expect(entry?.children.map(effect => effect.label)).toContain('before await')
    expect(firstRun.effects.map(effect => effect.label)).toContain('after await')
    expect(firstRun.runId).toBe(1)

    await fiber.restart()
    expect(fiber.inspect()).toMatchObject({
      runId: 2,
      lastFailure: undefined,
    })
    expect(fiber.inspect().effects).toHaveLength(2)

    await fiber.dispose()
  })

  it('records config-update, restart, dispose, dependency, stale, and root reasons', async () => {
    const app = new Context()
    const worker = app.installComponent({
      name: 'reason-worker',
      apply() {},
    }, { version: 1 })
    await worker
    await worker.update({ version: 2 })
    await worker.restart()
    await worker.dispose()

    const disposeDependency = app.provide('reason-dependency', {})
    const dependent = app.installComponent({
      name: 'dependent-worker',
      inject: ['reason-dependency'],
      apply() {},
    })
    await dependent
    await disposeDependency()
    await dependent.awaitStable()

    let finishStart!: () => void
    const canFinish = new Promise<void>(resolve => {
      finishStart = resolve
    })
    const disposeStaleDependency = app.provide('stale-dependency', {})
    const stale = app.installComponent({
      name: 'stale-worker',
      inject: ['stale-dependency'],
      async apply() {
        await canFinish
      },
    })
    await Promise.resolve()
    const removingStaleDependency = disposeStaleDependency()
    await Promise.resolve()
    finishStart()
    await removingStaleDependency
    await stale.awaitStable()

    await app.fiber.restart()

    const reasons = new Set(app.logger.records().flatMap(record => {
      return record.code === 'fiber/state' && record.stopReason
        ? [record.stopReason]
        : []
    }))
    for (const reason of [
      'config-update',
      'restart',
      'dispose',
      'dependency-change',
      'stale-start',
      'root-restart',
    ] as const) {
      expect(reasons).toContain(reason)
    }

    await dependent.dispose()
    await stale.dispose()
  })

  it('logs an independently disposed Effect failure immediately', async () => {
    const app = new Context()
    const cleanupError = new Error('manual cleanup failed')
    let dispose!: () => void | Promise<void>
    const fiber = app.installComponent({
      name: 'worker',
      apply(context) {
        dispose = context.effect(() => () => {
          throw cleanupError
        }, 'manual cleanup')
      },
    })
    await fiber

    await expect(dispose()).rejects.toBe(cleanupError)
    expect(findEffect(fiber.inspect(), 'manual cleanup')).toMatchObject({
      state: 'cleanup-failed',
      error: cleanupError,
    })
    expect(app.logger.records().filter(record => {
      return record.code === 'effect/cleanup-failed' && record.fiberId === fiber.id
    })).toHaveLength(1)

    await expect(fiber.dispose()).rejects.toBe(cleanupError)
  })

  it('reports one leaf path for a nested Effect setup failure in ACTIVE', async () => {
    const app = new Context()
    const startupError = new Error('nested startup failed')

    expect(() => app.effect(() => {
      app.effect(() => {
        throw startupError
      }, 'leaf setup')
    }, 'outer setup')).toThrow(startupError)

    const failures = app.logger.records().filter(record => {
      return record.code === 'effect/setup-failed'
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      error: startupError,
      effectPath: ['outer setup', 'leaf setup'],
      data: {
        effectPaths: [['outer setup', 'leaf setup']],
      },
    })

    await app.fiber.dispose()
  })

  it('reports one leaf-first error for a manually disposed nested Effect', async () => {
    const app = new Context()
    const cleanupError = new Error('nested cleanup failed')
    const dispose = app.effect(() => {
      app.effect(() => () => {
        throw cleanupError
      }, 'leaf cleanup')
    }, 'outer cleanup')
    await Promise.resolve()

    await expect(dispose()).rejects.toBe(cleanupError)
    const failures = app.logger.records().filter(record => {
      return record.code === 'effect/cleanup-failed'
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      error: cleanupError,
      effectPath: ['outer cleanup', 'leaf cleanup'],
      data: {
        effectPaths: [['outer cleanup', 'leaf cleanup']],
      },
    })
  })

  it('keeps separate paths when sibling Effects throw the same Error object', async () => {
    const app = new Context()
    const cleanupError = new Error('shared cleanup failure')
    const dispose = app.effect(() => {
      app.effect(() => () => {
        throw cleanupError
      }, 'first sibling')
      app.effect(() => () => {
        throw cleanupError
      }, 'second sibling')
    }, 'sibling owner')
    await Promise.resolve()

    await expect(dispose()).rejects.toBeInstanceOf(AggregateError)
    const [failure] = app.logger.records().filter(record => {
      return record.code === 'effect/cleanup-failed'
    })
    expect(failure.data).toEqual({
      effectPaths: [
        ['sibling owner', 'second sibling'],
        ['sibling owner', 'first sibling'],
      ],
    })
  })

  it('attributes Service invalidation failures to the provider Effect path', async () => {
    class RootService extends Service {
      static provide = 'diagnostic-root-service'
    }

    const app = new Context()
    const cleanupError = new Error('consumer cleanup failed')
    new RootService(app)
    const consumer = app.inject(['diagnostic-root-service'], () => {
      return () => {
        throw cleanupError
      }
    })
    await consumer

    await expect(app.fiber.restart()).rejects.toBe(cleanupError)
    expect(app.fiber.inspect().lastFailure).toMatchObject({
      phase: 'cleanup',
      stopReason: 'root-restart',
      error: cleanupError,
    })
    expect(app.fiber.inspect().lastFailure?.effectPaths).toContainEqual([
      'ctx.provide("diagnostic-root-service")',
    ])
    expect(app.fiber.inspect().lastFailure?.failures).toContainEqual(
      expect.objectContaining({
        stage: 'service-invalidate',
        serviceName: 'diagnostic-root-service',
        ownerFiberId: app.fiber.id,
        sourceFiberId: app.fiber.id,
        error: cleanupError,
      }),
    )

    app.effect(() => {}, 'new root effect')
    expect(app.fiber.inspect().effects.map(effect => effect.label)).toEqual([
      'new root effect',
    ])
    expect(app.fiber.inspect().lastFailure?.effectPaths).toEqual([
      ['ctx.provide("diagnostic-root-service")'],
    ])
  })

  it('keeps Service invalidate and finalize failures as separate stages', async () => {
    const app = new Context()
    const invalidationError = new Error('invalidation failed')
    const finalizationError = new Error('finalization failed')
    app.fiber[fiberBeforeUnload](
      () => {
        throw invalidationError
      },
      () => {
        throw finalizationError
      },
      {
        label: 'ctx.provide("staged-service")',
        serviceName: 'staged-service',
        ownerFiberId: app.fiber.id,
        sourceFiberId: app.fiber.id,
      },
    )

    let failure!: AggregateError
    try {
      await app.fiber.restart()
    } catch (error) {
      failure = error as AggregateError
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors).toEqual([invalidationError, finalizationError])
    expect(app.fiber.inspect().lastFailure?.failures).toEqual([
      expect.objectContaining({
        stage: 'service-invalidate',
        serviceName: 'staged-service',
        error: invalidationError,
      }),
      expect.objectContaining({
        stage: 'service-finalize',
        serviceName: 'staged-service',
        error: finalizationError,
      }),
    ])
  })
})
