/** 本文件验证 Service / Inject 的动态依赖、快照一致性和可重复激活语义。 */

import { describe, expect, it, vi } from 'vitest'
import { Context, FiberState, Service } from '../src/index.js'

interface Database {
  id: number
}

declare module '../src/context.js' {
  interface Context {
    database: Database
  }
}

describe('service injection', () => {
  it('keeps a consumer pending until its required service exists', async () => {
    const app = new Context()
    const database = { id: 1 }
    const apply = vi.fn()
    const dispose = vi.fn()

    const consumer = app.installComponent({
      name: 'consumer',
      inject: ['database'],
      apply(context) {
        apply(context.database)
        return dispose
      },
    })

    await consumer
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(apply).not.toHaveBeenCalled()

    const remove = app.provide('database', database)
    await consumer

    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(apply).toHaveBeenCalledWith(database)
    expect(app.database).toBe(database)

    await remove()

    expect(dispose).toHaveBeenCalledOnce()
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(app.database).toBeUndefined()
  })

  it('supports ctx.inject as a lightweight injected component', async () => {
    const app = new Context()
    const consume = vi.fn()
    const fiber = app.inject(['database'], (context) => {
      consume(context.database)
    })

    await fiber
    expect(fiber.state).toBe(FiberState.PENDING)

    const database = { id: 1 }
    const remove = app.provide('database', database)
    await fiber

    expect(consume).toHaveBeenCalledWith(database)

    await fiber.dispose()
    await remove()
  })

  it('does not expose a service before its provider becomes active', async () => {
    const app = new Context()
    const database = { id: 1 }
    let finishInit!: () => void
    let markStarted!: () => void
    const initStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const init = new Promise<void>(resolve => {
      finishInit = resolve
    })
    const apply = vi.fn()

    const consumer = app.installComponent({
      inject: ['database'],
      apply(context) {
        apply(context.database)
      },
    })

    const provider = app.installComponent({
      name: 'database-provider',
      async apply(context) {
        context.provide('database', database)
        markStarted()
        await init
      },
    })

    await initStarted
    expect(provider.state).toBe(FiberState.LOADING)
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(apply).not.toHaveBeenCalled()

    finishInit()
    await provider
    await consumer

    expect(provider.state).toBe(FiberState.ACTIVE)
    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(apply).toHaveBeenCalledWith(database)

    await provider.dispose()
    expect(consumer.state).toBe(FiberState.PENDING)
  })

  it('pins the old service snapshot through cleanup and then restarts', async () => {
    const app = new Context()
    const first = { id: 1 }
    const second = { id: 2 }
    const events: string[] = []

    const removeFirst = app.provide('database', first)
    const consumer = app.installComponent({
      inject: ['database'],
      apply(context) {
        events.push(`start:${context.database.id}`)
        return () => {
          events.push(`stop:${context.database.id}`)
        }
      },
    })

    await consumer
    await removeFirst()

    expect(events).toEqual(['start:1', 'stop:1'])
    expect(consumer.state).toBe(FiberState.PENDING)

    const removeSecond = app.provide('database', second)
    await consumer

    expect(events).toEqual(['start:1', 'stop:1', 'start:2'])
    expect(consumer.state).toBe(FiberState.ACTIVE)

    await consumer.dispose()
    await removeSecond()
    expect(events).toEqual(['start:1', 'stop:1', 'start:2', 'stop:2'])
  })

  it('serializes a replacement that arrives during asynchronous cleanup', async () => {
    const app = new Context()
    const events: string[] = []
    let finishCleanup!: () => void
    let markCleanupStarted!: () => void
    const cleanupStarted = new Promise<void>(resolve => {
      markCleanupStarted = resolve
    })
    const cleanupGate = new Promise<void>(resolve => {
      finishCleanup = resolve
    })

    const removeFirst = app.provide('database', { id: 1 })
    const consumer = app.installComponent({
      inject: ['database'],
      apply(context) {
        const id = context.database.id
        events.push(`start:${id}`)
        return async () => {
          events.push(`stop:${context.database.id}:begin`)
          if (id === 1) {
            markCleanupStarted()
            await cleanupGate
          }
          events.push(`stop:${context.database.id}:end`)
        }
      },
    })

    await consumer
    const removingFirst = Promise.resolve(removeFirst())
    await cleanupStarted

    const removeSecond = app.provide('database', { id: 2 })
    expect(events).toEqual(['start:1', 'stop:1:begin'])

    finishCleanup()
    await removingFirst
    await consumer

    expect(events).toEqual([
      'start:1',
      'stop:1:begin',
      'stop:1:end',
      'start:2',
    ])
    expect(consumer.state).toBe(FiberState.ACTIVE)

    await consumer.dispose()
    await removeSecond()
    expect(events.at(-2)).toBe('stop:2:begin')
    expect(events.at(-1)).toBe('stop:2:end')
  })

  it('rolls back a stale asynchronous startup before using a new service', async () => {
    const app = new Context()
    const starts: number[] = []
    const stops: number[] = []
    let finishFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const firstGate = new Promise<void>(resolve => {
      finishFirst = resolve
    })

    const removeFirst = app.provide('database', { id: 1 })
    const consumer = app.installComponent({
      inject: ['database'],
      async apply(context) {
        const id = context.database.id
        starts.push(id)
        if (id === 1) {
          markFirstStarted()
          await firstGate
        }
        return () => {
          stops.push(context.database.id)
        }
      },
    })

    await firstStarted
    const removingFirst = Promise.resolve(removeFirst())
    await Promise.resolve()
    finishFirst()
    await removingFirst

    expect(starts).toEqual([1])
    expect(stops).toEqual([1])
    expect(consumer.state).toBe(FiberState.PENDING)

    const removeSecond = app.provide('database', { id: 2 })
    await consumer

    expect(starts).toEqual([1, 2])
    expect(consumer.state).toBe(FiberState.ACTIVE)

    await consumer.dispose()
    await removeSecond()
    expect(stops).toEqual([1, 2])
  })

  it('keeps inject metadata on each installation instead of shared runtime', async () => {
    const app = new Context()
    const apply = vi.fn()
    const guarded = app.installComponent({
      inject: ['database'],
      apply,
    })
    const unguarded = app.installComponent({ apply })

    await Promise.all([guarded, unguarded])

    expect(guarded.state).toBe(FiberState.PENDING)
    expect(unguarded.state).toBe(FiberState.ACTIVE)
    expect(app.registry.get({ apply })?.fibers).toEqual(
      new Set([guarded, unguarded]),
    )
    expect(apply).toHaveBeenCalledOnce()
  })

  it('rejects service access that was not declared through inject', async () => {
    const app = new Context()
    const remove = app.provide('database', { id: 1 })
    const fiber = app.installComponent({
      apply(context) {
        void context.database
      },
    })

    await expect(Promise.resolve(fiber)).rejects.toThrow(
      'cannot get service "database" without inject',
    )
    expect(fiber.state).toBe(FiberState.FAILED)

    await fiber.dispose()
    await remove()
  })

  it('rejects duplicate providers without replacing the first value', async () => {
    const app = new Context()
    const first = { id: 1 }
    const remove = app.provide('database', first)

    expect(() => app.provide('database', { id: 2 })).toThrow(
      'service "database" has been registered at <root>',
    )
    expect(app.database).toBe(first)

    await remove()
  })

  it('does not revive a permanently disposed consumer', async () => {
    const app = new Context()
    const apply = vi.fn()
    const consumer = app.installComponent({
      inject: ['database'],
      apply,
    })

    await consumer
    await consumer.dispose()
    const remove = app.provide('database', { id: 1 })
    await Promise.resolve()

    expect(consumer.state).toBe(FiberState.DISPOSED)
    expect(apply).not.toHaveBeenCalled()

    await remove()
  })
})

describe('Service base class', () => {
  it('registers the instance and blocks consumers on Service.init', async () => {
    const app = new Context()
    let finishInit!: () => void
    let markInitStarted!: () => void
    const initStarted = new Promise<void>(resolve => {
      markInitStarted = resolve
    })
    const init = new Promise<void>(resolve => {
      finishInit = resolve
    })
    const cleanup = vi.fn()
    const consume = vi.fn()

    class DatabaseService extends Service implements Database {
      static provide = 'database'
      id = 42

      constructor(context: Context) {
        super(context)
      }

      async [Service.init]() {
        markInitStarted()
        await init
        return cleanup
      }
    }

    const consumer = app.installComponent({
      inject: ['database'],
      apply(context) {
        consume(context.database)
      },
    })
    const provider = app.installComponent(DatabaseService)

    await initStarted
    expect(provider.state).toBe(FiberState.LOADING)
    expect(consumer.state).toBe(FiberState.PENDING)

    finishInit()
    await provider
    await consumer

    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(consume).toHaveBeenCalledWith(expect.any(DatabaseService))

    await provider.dispose()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(consumer.state).toBe(FiberState.PENDING)
  })

  it('treats a failing Service.check as an unavailable dependency', async () => {
    const app = new Context()
    let available = false

    class CheckedDatabase extends Service implements Database {
      static provide = 'database'
      id = 1

      constructor(context: Context) {
        super(context)
      }

      [Service.check]() {
        return available
      }
    }

    const consumer = app.inject(['database'], () => {})
    const first = app.installComponent(CheckedDatabase)
    await first
    await consumer

    expect(first.state).toBe(FiberState.ACTIVE)
    expect(consumer.state).toBe(FiberState.PENDING)

    await first.dispose()
    available = true

    const second = app.installComponent(CheckedDatabase)
    await second
    await consumer

    expect(consumer.state).toBe(FiberState.ACTIVE)

    await second.dispose()
    expect(consumer.state).toBe(FiberState.PENDING)
  })
})
