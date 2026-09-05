/** 本文件验证主动清理经过真实资源栈的注销入口，并覆盖清理日志重入与父级并发卸载。 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, DisposableStack, FiberState } from '../src/index.js'
import type { Disposer } from '../src/index.js'

declare module '../src/index.js' {
  interface Events {
    'reliability/owned-event'(): void
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** 保留真实 add() 与摘除逻辑，只观察调用者是否使用它返回的注册句柄。 */
function observeRegistrations() {
  const originalAdd = DisposableStack.prototype.add
  const registrations: Array<{
    registered: Disposer
    exposed: ReturnType<typeof vi.fn<Disposer>>
  }> = []
  vi.spyOn(DisposableStack.prototype, 'add').mockImplementation(function (
    this: DisposableStack,
    dispose: Disposer,
  ) {
    const registered = originalAdd.call(this, dispose)
    const exposed = vi.fn(() => registered())
    registrations.push({ registered, exposed })
    return exposed
  })
  return registrations
}

const roots: Context[] = []
function createRoot() {
  const app = new Context()
  roots.push(app)
  return app
}

afterEach(async () => {
  try {
    for (const root of roots.splice(0)) {
      await root.fiber.dispose().catch(() => {})
    }
  } finally {
    vi.restoreAllMocks()
  }
})

describe('Effect ownership reliability', () => {
  it.each([undefined, null, false])('records an arbitrary cleanup rejection (%s) before detaching', async failure => {
    const app = createRoot()
    const child = app.installComponent(() => () => { throw failure })
    await child
    const observed: unknown[] = []
    const stopObserving = app.registry.subscribe(event => {
      if (event.type === 'detached' && event.fiber.id === child.id) {
        observed.push(child.inspect().lastFailure)
      }
    })

    await expect(child.dispose()).rejects.toBe(failure)
    expect(child.state).toBe(FiberState.DISPOSED)
    expect(observed).toEqual([expect.objectContaining({ phase: 'cleanup', error: failure })])
    expect(child.inspect().effects).toEqual([])
    stopObserving()
  })

  it('returns the real owner registration handle for a top-level Effect', async () => {
    const app = createRoot()
    const registrations = observeRegistrations()
    const stop = app.effect(() => undefined, 'top-level ownership')
    expect(registrations).toHaveLength(1)
    const owner = registrations[0]

    expect(stop).toBe(owner.exposed)
    await stop()
    expect(owner.exposed).toHaveBeenCalledOnce()
    await app.fiber.dispose()
    expect(owner.exposed).toHaveBeenCalledOnce()
  })

  it('returns the enclosing scope registration for a synchronous nested Effect', async () => {
    const app = createRoot()
    const registrations = observeRegistrations()
    let stopInner!: Disposer
    const stopOuter = app.effect(() => {
      stopInner = app.effect(() => undefined, 'nested ownership')
    }, 'outer ownership')
    expect(registrations).toHaveLength(2)
    const [outer, inner] = registrations

    expect(stopOuter).toBe(outer.exposed)
    expect(stopInner).toBe(inner.exposed)
    await stopInner()
    expect(inner.exposed).toHaveBeenCalledOnce()
    await stopOuter()
    expect(outer.exposed).toHaveBeenCalledOnce()
    expect(inner.exposed).toHaveBeenCalledOnce()
    await app.fiber.dispose()
  })

  it('routes event unsubscription through the owner registration and removes the hook synchronously', async () => {
    const app = createRoot()
    const registrations = observeRegistrations()
    const listener = vi.fn()
    const unsubscribe = app.on('reliability/owned-event', listener)
    const owner = registrations[0]
    app.emit('reliability/owned-event')

    const disposal = unsubscribe()
    app.emit('reliability/owned-event')
    expect(listener).toHaveBeenCalledOnce()
    await disposal
    expect(owner.exposed).toHaveBeenCalledOnce()
    await app.fiber.dispose()
    expect(owner.exposed).toHaveBeenCalledOnce()
  })

  it('routes manual child disposal through its parent installation registration', async () => {
    const app = createRoot()
    const registrations = observeRegistrations()
    const cleanup = vi.fn()
    const child = app.installComponent(() => cleanup)
    // 安装在同步调用内先登记父级 Effect，子入口随后由 Fiber 队列启动。
    const installation = registrations[0]
    await child

    await child.dispose()
    expect(child.state).toBe(FiberState.DISPOSED)
    expect(installation.exposed).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    await app.fiber.dispose()
    expect(installation.exposed).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('finishes an in-flight manual Effect cleanup before parent disposal resolves', async () => {
    const app = createRoot()
    const gate = deferred()
    const started = deferred()
    const cleanup = vi.fn(async () => {
      started.resolve()
      await gate.promise
    })
    let stop!: Disposer
    const parent = app.installComponent((context) => {
      stop = context.effect(() => cleanup, 'gated ownership')
    })
    await parent

    const manual = stop()
    await started.promise
    const owner = parent.dispose()
    let ownerFinished = false
    void owner.then(() => { ownerFinished = true })
    try {
      await Promise.resolve()
      expect(ownerFinished).toBe(false)
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      gate.resolve()
    }

    await Promise.all([manual, owner])
    expect(ownerFinished).toBe(true)
    expect(parent.state).toBe(FiberState.DISPOSED)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('reuses the public disposal task when a synchronous log sink reenters', async () => {
    const app = createRoot()
    const cleanup = vi.fn()
    const label = 'reentrant cleanup'
    const stop = app.effect(() => cleanup, label)
    let reentrant: ReturnType<Disposer> = undefined
    let entered = false
    app.logger.subscribe((record) => {
      if (record.message !== `effect ${label} is disposing` || entered) return
      entered = true
      reentrant = stop()
    }, { replay: false, minLevel: 'debug' })

    const first = stop()
    await first

    expect(reentrant).toBe(first)
    expect(cleanup).toHaveBeenCalledOnce()
    const messages = app.logger.records().map(record => record.message)
    expect(messages.filter(message => message === `effect ${label} is disposing`))
      .toHaveLength(1)
    expect(messages.filter(message => message === `effect ${label} was disposed`))
      .toHaveLength(1)
  })

  it('preserves the same failed task and error through log reentry and parent disposal', async () => {
    const app = createRoot()
    const failure = new Error('reentrant cleanup failed')
    const cleanup = vi.fn(() => { throw failure })
    const label = 'reentrant failure'
    let stop!: Disposer
    const parent = app.installComponent((context) => {
      stop = context.effect(() => cleanup, label)
    })
    await parent
    let reentrant: ReturnType<Disposer> = undefined
    let entered = false
    app.logger.subscribe((record) => {
      if (record.message !== `effect ${label} is disposing` || entered) return
      entered = true
      reentrant = stop()
    }, { replay: false, minLevel: 'debug' })

    const first = stop()
    await expect(first).rejects.toBe(failure)
    expect(reentrant).toBe(first)
    expect(stop()).toBe(first)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(app.logger.records().filter(record => {
      return record.code === 'effect/cleanup-failed' && record.fiberId === parent.id
    })).toHaveLength(1)

    await expect(parent.dispose()).rejects.toBe(failure)
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
