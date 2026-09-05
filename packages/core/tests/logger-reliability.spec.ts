/** 本文件验证失败日志订阅的自动释放，以及它与回放和生命周期清理的竞争。 */

import { describe, expect, it, vi } from 'vitest'
import { Context, DisposableStack, FiberState } from '../src/index.js'
import type {
  Disposer,
  EffectDiagnosticSnapshot,
  Fiber,
  LogRecord,
} from '../src/index.js'

function subscriberEffects(fiber: Fiber): EffectDiagnosticSnapshot[] {
  const visit = (effects: readonly EffectDiagnosticSnapshot[]): EffectDiagnosticSnapshot[] => {
    return effects.flatMap(effect => [
      ...(effect.type === 'logger-subscriber' ? [effect] : []),
      ...visit(effect.children),
    ])
  }
  return visit(fiber.inspect().effects)
}

function sinkFailures(context: Context) {
  return context.logger.records().filter(record => record.code === 'logger/sink-failed')
}

function rejectionGate() {
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise
  })
  return { promise, reject }
}

async function expectSubscribersDisposed(fiber: Fiber) {
  // 先观察自动清理，再调用公开 stop；不能让测试自己的清理掩盖资源泄漏。
  await vi.waitFor(() => {
    expect(subscriberEffects(fiber)).toEqual([])
  })
}

describe('logger subscriber reliability', () => {
  it('automatically disposes a synchronously failed sink without redispatching its error', async () => {
    const app = new Context()
    const sinkError = new Error('synchronous sink failure')
    const observed: LogRecord[] = []
    const stopObserver = app.logger.child('observer').subscribe(record => observed.push(record))
    const sink = vi.fn(() => {
      throw sinkError
    })
    const stop = app.logger.child('failing').subscribe(sink, { minLevel: 'info' })

    expect(() => app.logger.info('first')).not.toThrow()
    app.logger.info('second')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sinkFailures(app)).toHaveLength(1)
    expect(sinkFailures(app)[0].error).toBe(sinkError)
    expect(observed.some(record => record.code === 'logger/sink-failed')).toBe(false)

    await vi.waitFor(() => {
      expect(subscriberEffects(app.fiber).map(effect => effect.label)).toEqual([
        'ctx.logger.subscribe("<root>/observer")',
      ])
    })
    expect(app.fiber.state).toBe(FiberState.ACTIVE)
    await stop()
    await stopObserver()
    await app.fiber.dispose()
  })

  it('handles replay failure before the owning Effect disposer is returned', async () => {
    const app = new Context()
    app.logger.info('first historical record')
    app.logger.info('second historical record')
    const sinkError = new Error('replay failure')
    const sink = vi.fn(() => {
      throw sinkError
    })

    const stop = app.logger.subscribe(sink, { replay: true, minLevel: 'info' })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]).toEqual([
      expect.objectContaining({ message: 'first historical record' }),
    ])
    expect(sinkFailures(app)[0].error).toBe(sinkError)

    await expectSubscribersDisposed(app.fiber)
    await stop()
    await app.fiber.dispose()
  })

  it.each([
    { replay: true, phase: 'start' },
    { replay: false, phase: 'active' },
  ] as const)('disposes a sink failing on its own $phase Effect log', async ({ replay, phase }) => {
    const app = new Context()
    const sinkError = new Error('own lifecycle log failure')
    const sink = vi.fn((record: LogRecord) => {
      if (record.code === 'effect/state' && record.phase === phase) throw sinkError
    })

    const stop = app.logger.subscribe(sink, { replay })
    await expectSubscribersDisposed(app.fiber)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0][0]).toMatchObject({
      code: 'effect/state',
      phase,
      effectPath: ['ctx.logger.subscribe("<root>")'],
    })
    expect(sinkFailures(app)).toHaveLength(1)
    expect(sinkFailures(app)[0].error).toBe(sinkError)
    await stop()
    await app.fiber.dispose()
  })

  it('does not await asynchronous sinks and disposes them after the first rejection', async () => {
    const app = new Context()
    const first = rejectionGate()
    const second = rejectionGate()
    const sinkError = new Error('first async failure')
    const sink = vi.fn((record: LogRecord) => {
      if (record.message === 'first pending delivery') return first.promise
      if (record.message === 'second pending delivery') return second.promise
    })
    const worker = app.installComponent({
      name: 'async-sink-worker',
      apply(context) {
        context.logger.subscribe(sink, { minLevel: 'info' })
        context.logger.info('first pending delivery')
        context.logger.info('second pending delivery')
      },
    })

    await worker
    expect(worker.state).toBe(FiberState.ACTIVE)
    expect(subscriberEffects(worker)).toHaveLength(1)
    const deliveriesBeforeRejection = sink.mock.calls.length
    first.reject(sinkError)
    second.reject(new Error('later async failure'))

    await expectSubscribersDisposed(worker)
    app.logger.info('after rejection')
    expect(sink).toHaveBeenCalledTimes(deliveriesBeforeRejection)
    expect(sink.mock.calls.filter(([record]) => record.code === 'log')).toHaveLength(2)
    expect(sinkFailures(app)).toHaveLength(1)
    expect(sinkFailures(app)[0].error).toBe(sinkError)
    expect(worker.state).toBe(FiberState.ACTIVE)
    await worker.dispose()
    await app.fiber.dispose()
  })

  it('does not reenter manual disposal when a sink fails on its disposing log', async () => {
    const app = new Context()
    const sinkError = new Error('disposing log failure')
    const sink = vi.fn((record: LogRecord) => {
      if (record.code === 'effect/state' && record.phase === 'cleanup') throw sinkError
    })
    const stop = app.logger.subscribe(sink)

    const stopping = stop()
    expect(stop()).toBe(stopping)
    await stopping
    await stop()

    expect(subscriberEffects(app.fiber)).toEqual([])
    expect(sink.mock.calls.filter(([record]) => record.phase === 'cleanup')).toHaveLength(1)
    expect(sinkFailures(app)).toHaveLength(1)
    expect(sinkFailures(app)[0].error).toBe(sinkError)
    const disposingLogs = app.logger.records().filter(record => {
      return record.code === 'effect/state' && record.message.endsWith(' is disposing')
    })
    expect(disposingLogs).toHaveLength(1)
    await app.fiber.dispose()
  })

  it('shares manual cleanup with a previously scheduled failure cleanup', async () => {
    const app = new Context()
    const sinkError = new Error('failed before manual stop')
    const stop = app.logger.subscribe(() => {
      throw sinkError
    }, { minLevel: 'info' })

    app.logger.info('trigger failure')
    const stopping = stop()
    expect(stop()).toBe(stopping)
    await stopping

    expect(subscriberEffects(app.fiber)).toEqual([])
    expect(sinkFailures(app)).toHaveLength(1)
    expect(sinkFailures(app)[0].error).toBe(sinkError)
    expect(app.logger.records().filter(record => {
      return record.code === 'effect/state' && record.message.endsWith(' was disposed')
    })).toHaveLength(1)
    await app.fiber.dispose()
  })

  it.each([true, false])('handles pending rejection racing manual stop (reject first: %s)', async (rejectFirst) => {
    const app = new Context()
    const pending = rejectionGate()
    const sinkError = new Error('racing rejection')
    const sink = vi.fn(() => pending.promise)
    const stop = app.logger.subscribe(sink, { minLevel: 'info' })
    app.logger.info('pending delivery')

    if (rejectFirst) pending.reject(sinkError)
    const stopping = stop()
    if (!rejectFirst) pending.reject(sinkError)
    await stopping
    await pending.promise.catch(() => {})
    await stop()

    expect(subscriberEffects(app.fiber)).toEqual([])
    expect(sinkFailures(app).length).toBeLessThanOrEqual(1)
    for (const record of sinkFailures(app)) expect(record.error).toBe(sinkError)
    app.logger.info('after both operations')
    expect(sink).toHaveBeenCalledTimes(1)
    await app.fiber.dispose()
  })

  it('ignores a pending rejection after manual cleanup has completed', async () => {
    const app = new Context()
    const pending = rejectionGate()
    const stop = app.logger.subscribe(() => pending.promise, { minLevel: 'info' })
    app.logger.info('pending delivery')
    await stop()

    pending.reject(new Error('late rejection'))
    await pending.promise.catch(() => {})
    expect(sinkFailures(app)).toEqual([])
    expect(subscriberEffects(app.fiber)).toEqual([])
    await app.fiber.dispose()
  })

  it('preserves the original component error when its sink also fails', async () => {
    const app = new Context()
    const componentError = new Error('component failed')
    const sinkError = new Error('sink failed')
    const worker = app.installComponent({
      name: 'failing-worker',
      apply(context) {
        context.logger.subscribe(() => {
          throw sinkError
        }, { minLevel: 'info' })
        context.logger.info('before component failure')
        throw componentError
      },
    })

    await expect(worker.awaitStable()).rejects.toBe(componentError)
    expect(worker.state).toBe(FiberState.FAILED)
    expect(worker.inspect().lastFailure?.error).toBe(componentError)
    expect(sinkFailures(app)).toHaveLength(1)
    expect(sinkFailures(app)[0].error).toBe(sinkError)
    await expectSubscribersDisposed(worker)
    await worker.dispose()
    await app.fiber.dispose()
  })

  it.each([false, true])('releases repeated failed subscriptions under a persistent owner (nested: %s)', async (nested) => {
    const app = new Context()
    const subscribeAndFail = () => {
      for (let index = 0; index < 8; index++) {
        app.logger.subscribe(() => {
          throw new Error(`failed sink ${index}`)
        }, { minLevel: 'info' })
        app.logger.info(`delivery ${index}`)
      }
    }
    if (nested) {
      app.effect(subscribeAndFail, 'persistent owner')
    } else {
      subscribeAndFail()
    }

    await expectSubscribersDisposed(app.fiber)
    expect(sinkFailures(app)).toHaveLength(8)
    expect(app.fiber.inspect().effects.map(effect => effect.label)).toEqual(
      nested ? ['persistent owner'] : [],
    )
    expect(app.fiber.state).toBe(FiberState.ACTIVE)
    await app.fiber.dispose()
  })

  it.each([false, true])('automatically uses the owning stack registration (nested: %s)', async (nested) => {
    const app = new Context()
    const originalAdd = DisposableStack.prototype.add
    const registrations: Array<ReturnType<typeof vi.fn<Disposer>>> = []
    // 保留真实登记和成功摘除，仅观察自动释放是否调用 add() 返回的句柄。
    const add = vi.spyOn(DisposableStack.prototype, 'add').mockImplementation(function (
      this: DisposableStack,
      dispose: Disposer,
    ) {
      const registered = originalAdd.call(this, dispose)
      const exposed = vi.fn(() => registered())
      registrations.push(exposed)
      return exposed
    })

    try {
      let stop!: Disposer
      const subscribe = () => {
        stop = app.logger.subscribe(() => {
          throw new Error('owned sink failure')
        }, { minLevel: 'info' })
      }
      if (nested) {
        app.effect(subscribe, 'persistent subscriber owner')
      } else {
        subscribe()
      }
      // 嵌套场景先登记外层 Effect，随后才登记订阅 Effect 的所有权。
      const ownerRegistration = registrations[nested ? 1 : 0]
      expect(stop).toBe(ownerRegistration)

      app.logger.info('trigger automatic cleanup')
      await vi.waitFor(() => {
        expect(ownerRegistration).toHaveBeenCalledOnce()
      })
      // 等待自动调用产生的真实任务，不通过手动 stop 补做清理。
      await ownerRegistration.mock.results[0].value
      expect(subscriberEffects(app.fiber)).toEqual([])
      expect(app.fiber.inspect().effects.map(effect => effect.label)).toEqual(
        nested ? ['persistent subscriber owner'] : [],
      )
      await app.fiber.dispose()
      expect(ownerRegistration).toHaveBeenCalledOnce()
    } finally {
      try {
        await app.fiber.dispose()
      } finally {
        add.mockRestore()
      }
    }
  })
})
