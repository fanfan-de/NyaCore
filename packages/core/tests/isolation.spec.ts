/** 本文件验证服务隔离地址、Context 继承和依赖快照的组合语义。 */

import { describe, expect, it, vi } from 'vitest'
import {
  Context,
  FiberState,
  Service,
  type IsolationLabel,
} from '../src/index.js'

interface TestService {
  id: number
}

function database(context: Context) {
  return (context as Context & { database: TestService }).database
}

function cache(context: Context) {
  return (context as Context & { cache: TestService }).cache
}

describe('service isolation', () => {
  it('strictly separates default and isolated providers without fallback', async () => {
    const app = new Context()
    const scoped = app.isolate('database', Symbol('test database'))
    const defaultCalls: number[] = []
    const scopedCalls: number[] = []

    const defaultConsumer = app.inject(['database'], (context) => {
      defaultCalls.push(database(context).id)
    })
    const scopedConsumer = scoped.inject(['database'], (context) => {
      scopedCalls.push(database(context).id)
    })
    await Promise.all([defaultConsumer, scopedConsumer])

    const removeDefault = app.provide('database', { id: 1 })
    await Promise.all([defaultConsumer, scopedConsumer])

    expect(defaultConsumer.state).toBe(FiberState.ACTIVE)
    expect(scopedConsumer.state).toBe(FiberState.PENDING)
    expect(defaultCalls).toEqual([1])
    expect(scopedCalls).toEqual([])
    expect(database(app)).toEqual({ id: 1 })
    expect(database(scoped)).toBeUndefined()

    await removeDefault()
    const removeScoped = scoped.provide('database', { id: 2 })
    await Promise.all([defaultConsumer, scopedConsumer])

    expect(defaultConsumer.state).toBe(FiberState.PENDING)
    expect(scopedConsumer.state).toBe(FiberState.ACTIVE)
    expect(defaultCalls).toEqual([1])
    expect(scopedCalls).toEqual([2])
    expect(database(app)).toBeUndefined()
    expect(database(scoped)).toEqual({ id: 2 })

    await Promise.all([defaultConsumer.dispose(), scopedConsumer.dispose()])
    await removeScoped()
  })

  it('shares explicit labels and permits the same name in other labels', async () => {
    const app = new Context()
    const shared: IsolationLabel = Symbol('shared')
    const other = Symbol('other')
    const first = app.isolate('database', shared)
    const second = app
      .isolate('database', shared)
      .isolate('cache', shared)
    const third = app.isolate('database', other)

    const removeShared = first.provide('database', { id: 1 })
    const removeOther = third.provide('database', { id: 2 })
    // 同一个 Symbol 可安全用于不同服务名，因为地址同时包含 name。
    const removeCache = second.provide('cache', { id: 3 })

    expect(database(first)).toEqual({ id: 1 })
    expect(database(second)).toEqual({ id: 1 })
    expect(database(third)).toEqual({ id: 2 })
    expect(cache(second)).toEqual({ id: 3 })
    expect(() => second.provide('database', { id: 4 })).toThrow(
      'service "database" has been registered at <root>',
    )

    // 其他标签的 slot 不会让默认 Context 把该名称报告为已认识。
    expect('database' in app).toBe(false)
    expect('database' in first).toBe(true)
    expect('database' in third).toBe(true)

    await Promise.all([removeCache(), removeOther(), removeShared()])
  })

  it('creates a unique implicit label and inherits chained isolation immutably', async () => {
    const app = new Context()
    const first = app.isolate('database')
    const second = app.isolate('database')
    const chained = first.isolate('cache')
    const extended = chained.extend()

    expect(first.root).toBe(app)
    expect(first.fiber).toBe(app.fiber)
    expect(chained.fiber).toBe(app.fiber)

    const removeDefaultDatabase = app.provide('database', { id: 10 })
    const removeDefaultCache = app.provide('cache', { id: 20 })
    const removeFirst = first.provide('database', { id: 11 })
    const removeSecond = second.provide('database', { id: 12 })
    const removeChained = chained.provide('cache', { id: 21 })

    expect(database(app)).toEqual({ id: 10 })
    expect(cache(app)).toEqual({ id: 20 })
    expect(database(first)).toEqual({ id: 11 })
    expect(cache(first)).toEqual({ id: 20 })
    expect(database(second)).toEqual({ id: 12 })
    expect(cache(second)).toEqual({ id: 20 })
    expect(database(chained)).toEqual({ id: 11 })
    expect(cache(chained)).toEqual({ id: 21 })
    expect(database(extended)).toEqual({ id: 11 })
    expect(cache(extended)).toEqual({ id: 21 })

    await Promise.all([
      removeChained(),
      removeSecond(),
      removeFirst(),
      removeDefaultCache(),
      removeDefaultDatabase(),
    ])
  })

  it('notifies only consumers of the changed address and mixes scoped dependencies', async () => {
    const app = new Context()
    const first = app.isolate('database', Symbol('first'))
    const second = app.isolate('database', Symbol('second'))
    const firstStarts: string[] = []
    const secondStarts: string[] = []
    const firstCleanup = vi.fn()
    const secondCleanup = vi.fn()

    const removeCache = app.provide('cache', { id: 9 })
    const removeFirst = first.provide('database', { id: 1 })
    const removeSecond = second.provide('database', { id: 2 })
    const firstConsumer = first.installComponent({
      inject: ['database', 'cache'],
      apply(context) {
        firstStarts.push(`${database(context).id}:${cache(context).id}`)
        return firstCleanup
      },
    })
    const secondConsumer = second.installComponent({
      inject: ['database', 'cache'],
      apply(context) {
        secondStarts.push(`${database(context).id}:${cache(context).id}`)
        return secondCleanup
      },
    })
    await Promise.all([firstConsumer, secondConsumer])

    await removeFirst()

    expect(firstConsumer.state).toBe(FiberState.PENDING)
    expect(secondConsumer.state).toBe(FiberState.ACTIVE)
    expect(firstCleanup).toHaveBeenCalledOnce()
    expect(secondCleanup).not.toHaveBeenCalled()

    const removeReplacement = first.provide('database', { id: 3 })
    await firstConsumer

    expect(firstStarts).toEqual(['1:9', '3:9'])
    expect(secondStarts).toEqual(['2:9'])
    expect(secondCleanup).not.toHaveBeenCalled()

    await Promise.all([firstConsumer.dispose(), secondConsumer.dispose()])
    await Promise.all([removeReplacement(), removeSecond(), removeCache()])
  })

  it('pins an isolated implementation throughout asynchronous cleanup', async () => {
    const app = new Context()
    const scoped = app.isolate('database', Symbol('database'))
    const events: string[] = []
    let finishCleanup!: () => void
    let markCleanupStarted!: () => void
    const cleanupStarted = new Promise<void>(resolve => {
      markCleanupStarted = resolve
    })
    const cleanupGate = new Promise<void>(resolve => {
      finishCleanup = resolve
    })

    const removeFirst = scoped.provide('database', { id: 1 })
    const consumer = scoped.inject(['database'], (context) => {
      const id = database(context).id
      events.push(`start:${id}`)
      return async () => {
        events.push(`stop:${database(context).id}:begin`)
        if (id === 1) {
          markCleanupStarted()
          await cleanupGate
        }
        events.push(`stop:${database(context).id}:end`)
      }
    })
    await consumer

    const removingFirst = Promise.resolve(removeFirst())
    await cleanupStarted
    const removeSecond = scoped.provide('database', { id: 2 })

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

    await consumer.dispose()
    await removeSecond()
  })

  it('does not reuse a component snapshot through a newly isolated view', async () => {
    const app = new Context()
    const remove = app.provide('database', { id: 1 })
    const check = vi.fn()
    const consumer = app.inject(['database'], (context) => {
      expect(database(context)).toEqual({ id: 1 })
      const isolated = context.isolate('database')
      expect(() => database(isolated)).toThrow(
        'cannot get required service "database" in inactive context',
      )
      check()
    })

    await consumer
    expect(check).toHaveBeenCalledOnce()

    await consumer.dispose()
    await remove()
  })

  it('supports isolated ordinary, child, and Service class providers', async () => {
    const app = new Context()
    const scoped = app.isolate('database', Symbol('database'))
    const values: number[] = []
    const consumer = scoped.inject(['database'], (context) => {
      values.push(database(context).id)
    })
    await consumer

    const ordinary = scoped.installComponent((context) => {
      context.provide('database', { id: 1 })
    })
    await ordinary
    await consumer
    expect(values).toEqual([1])

    await ordinary.dispose()
    expect(consumer.state).toBe(FiberState.PENDING)

    const childProvider = (context: Context) => {
      context.provide('database', { id: 2 })
    }
    const parent = scoped.installComponent((context) => {
      context.installComponent(childProvider)
    })
    await parent
    await consumer
    expect(values).toEqual([1, 2])

    await parent.dispose()
    expect(consumer.state).toBe(FiberState.PENDING)

    const cleanup = vi.fn()
    let available = false
    class DatabaseService extends Service implements TestService {
      static provide = 'database'
      id = 3

      constructor(context: Context) {
        super(context)
      }

      [Service.init]() {
        return cleanup
      }

      [Service.check]() {
        return available
      }
    }

    const unavailableProvider = scoped.installComponent(DatabaseService)
    await unavailableProvider
    await consumer

    expect(values).toEqual([1, 2])
    expect(consumer.state).toBe(FiberState.PENDING)

    await unavailableProvider.dispose()
    expect(cleanup).toHaveBeenCalledOnce()

    available = true
    const serviceProvider = scoped.installComponent(DatabaseService)
    await serviceProvider
    await consumer

    expect(values).toEqual([1, 2, 3])
    expect(database(scoped)).toBeInstanceOf(DatabaseService)

    await serviceProvider.dispose()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(consumer.state).toBe(FiberState.PENDING)
    await consumer.dispose()
  })

  it('rolls back a failed isolated provider without exposing its service', async () => {
    const app = new Context()
    const scoped = app.isolate('database', Symbol('database'))
    const consumer = scoped.inject(['database'], () => {})
    const provider = scoped.installComponent({
      name: 'failed-provider',
      apply(context) {
        context.provide('database', { id: 1 })
        throw new Error('startup failed')
      },
    })

    await expect(Promise.resolve(provider)).rejects.toThrow('startup failed')
    await consumer

    expect(provider.state).toBe(FiberState.FAILED)
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(database(scoped)).toBeUndefined()

    await provider.dispose()
    await consumer.dispose()
  })

  it('keeps identical labels independent across roots and records provider metadata', async () => {
    const label = Symbol('shared across roots')
    const firstRoot = new Context()
    const secondRoot = new Context()
    const first = firstRoot.isolate('database', label)
    const second = secondRoot.isolate('database', label)
    const secondConsumer = second.inject(['database'], () => {})

    const removeFirst = first.provide('database', { id: 1 })
    await secondConsumer

    expect(secondConsumer.state).toBe(FiberState.PENDING)
    expect(database(second)).toBeUndefined()
    expect(firstRoot.services.has(first, 'database')).toBe(true)
    expect(firstRoot.services.has(firstRoot, 'database')).toBe(false)
    expect(() => firstRoot.services.has(second, 'database')).toThrow(
      'cannot resolve a service from another Context tree',
    )

    const snapshot = firstRoot.services.capture(
      first,
      new Set(['database']),
    )
    const implementation = snapshot?.services.get('database')
    expect(implementation?.address).toEqual({ name: 'database', label })
    expect(implementation?.providerContext).toBe(first)
    expect(implementation?.owner).toBe(firstRoot.fiber)

    const removeSecond = second.provide('database', { id: 2 })
    await secondConsumer
    expect(secondConsumer.state).toBe(FiberState.ACTIVE)
    expect(database(first)).toEqual({ id: 1 })
    expect(database(second)).toEqual({ id: 2 })

    await secondConsumer.dispose()
    await Promise.all([removeSecond(), removeFirst()])
  })

  it('validates service names and symbol labels at runtime and compile time', () => {
    const app = new Context()
    const label: IsolationLabel = Symbol('database')
    const scoped: Context = app.isolate('database', label)

    expect(scoped).not.toBe(app)
    expect(() => (app.isolate as any)()).toThrow(
      'invalid service name: expected a non-empty string',
    )
    expect(() => (app.isolate as any)('', label)).toThrow(
      'invalid service name: expected a non-empty string',
    )
    expect(() => (app.isolate as any)(42, label)).toThrow(
      'invalid service name: expected a non-empty string',
    )
    expect(() => (app.isolate as any)('database', 'label')).toThrow(
      'invalid isolation label: expected a symbol',
    )
    expect(() => (app.isolate as any)('database', null)).toThrow(
      'invalid isolation label: expected a symbol',
    )

    if (false) {
      // @ts-expect-error service names must be strings
      app.isolate(42, label)
      // @ts-expect-error isolation labels must be symbols
      app.isolate('database', 'label')
    }
  })
})
