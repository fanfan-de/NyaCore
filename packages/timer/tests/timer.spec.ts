import { Context, FiberState } from '@nya/core'
import type { Disposer, EffectDiagnosticSnapshot } from '@nya/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Timer } from '../src/index.js'

function deferred<Value = void>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function flatten(effects: readonly EffectDiagnosticSnapshot[]): EffectDiagnosticSnapshot[] {
  return effects.flatMap(effect => [effect, ...flatten(effect.children)])
}

const roots: Context[] = []
async function setup() {
  const context = new Context()
  roots.push(context)
  const provider = context.installComponent(Timer)
  await provider
  return { context, provider }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  for (const context of roots.splice(0)) await context.fiber.dispose()
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Timer ownership and cancellation', () => {
  it('owns consumer timers in the caller Fiber and stops them when that caller is unloaded', async () => {
    const { context, provider } = await setup()
    const callback = vi.fn()
    const consumer = context.installComponent({
      name: 'consumer', inject: ['timer'],
      apply(ctx) { ctx.timer.interval(callback, 10) },
    })
    await consumer
    expect(flatten(consumer.inspect().effects).map(effect => effect.label)).toContain('ctx.timer.interval()')
    expect(flatten(provider.inspect().effects).map(effect => effect.label)).not.toContain('ctx.timer.interval()')
    await vi.advanceTimersByTimeAsync(10)
    expect(callback).toHaveBeenCalledOnce()
    await consumer.dispose()
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenCalledOnce()
    expect(provider.state).toBe(FiberState.ACTIVE)
  })

  it('unloads dependent callers on provider removal while Root-owned timers remain with Root', async () => {
    const { context, provider } = await setup()
    const consumerCallback = vi.fn()
    const rootCallback = vi.fn()
    const consumer = context.installComponent({
      inject: ['timer'], apply(ctx) { ctx.timer.interval(consumerCallback, 10) },
    })
    await consumer
    context.timer.interval(rootCallback, 10)
    await provider.dispose()
    await consumer
    expect(consumer.state).toBe(FiberState.PENDING)
    await vi.advanceTimersByTimeAsync(20)
    expect(consumerCallback).not.toHaveBeenCalled()
    expect(rootCallback).toHaveBeenCalledTimes(2)
    await context.fiber.dispose()
    await vi.advanceTimersByTimeAsync(100)
    expect(rootCallback).toHaveBeenCalledTimes(2)
  })

  it('owns timers called from the provider Context in that provider', async () => {
    const { provider } = await setup()
    const callback = vi.fn()
    provider.context.timer.interval(callback, 10)
    expect(flatten(provider.inspect().effects).map(effect => effect.label)).toContain('ctx.timer.interval()')
    await provider.dispose()
    await vi.advanceTimersByTimeAsync(10)
    expect(callback).not.toHaveBeenCalled()
  })

  it('places timers inside the caller nested Effect and clears them with that scope', async () => {
    const { context } = await setup()
    const callback = vi.fn()
    const dispose = context.effect(() => {
      context.timer.timeout(callback, 10)
      context.timer.interval(callback, 10)
    }, 'outer')
    const outer = context.fiber.inspect().effects.find(effect => effect.label === 'outer')
    expect(outer?.children.map(effect => effect.label)).toEqual(['ctx.timer.timeout()', 'ctx.timer.interval()'])
    await dispose()
    expect(context.fiber.inspect().effects.some(effect => effect.label === 'outer')).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(callback).not.toHaveBeenCalled()
  })

  it('automatically unregisters a timeout Effect after triggering exactly once', async () => {
    const { context } = await setup()
    const callback = vi.fn()
    const baseline = context.fiber.inspect().effects.length
    const dispose = context.timer.timeout(callback, 10)
    expect(context.fiber.inspect().effects).toHaveLength(baseline + 1)
    await vi.advanceTimersByTimeAsync(10)
    expect(callback).toHaveBeenCalledOnce()
    expect(context.fiber.inspect().effects).toHaveLength(baseline)
    await dispose()
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenCalledOnce()
  })

  it.each(['timeout', 'interval'] as const)('supports immediate and repeated manual cancellation of %s', async kind => {
    const { context } = await setup()
    const callback = vi.fn()
    const dispose = context.timer[kind](callback, 10)
    const first = dispose()
    expect(dispose()).toBe(first)
    expect(vi.getTimerCount()).toBe(0)
    await first
    await vi.advanceTimersByTimeAsync(20)
    expect(callback).not.toHaveBeenCalled()
    expect(flatten(context.fiber.inspect().effects).some(effect => effect.label === `ctx.timer.${kind}()`)).toBe(false)
  })

  it.each(['timeout', 'interval'] as const)('does not wait for an already started %s callback when disposing its caller', async kind => {
    const { context } = await setup()
    const gate = deferred()
    const entered = deferred()
    const completed = deferred()
    const consumer = context.installComponent({
      inject: ['timer'],
      apply(ctx) {
        ctx.timer[kind](async () => { entered.resolve(); await gate.promise; completed.resolve() }, 10)
      },
    })
    await consumer
    await vi.advanceTimersByTimeAsync(10)
    await entered.promise
    await consumer.dispose()
    expect(consumer.state).toBe(FiberState.DISPOSED)
    expect(vi.getTimerCount()).toBe(0)
    gate.resolve()
    await completed.promise
  })

  it.each(['timeout', 'interval'] as const)('allows an async %s callback to unload its own Fiber', async kind => {
    const { context } = await setup()
    const done = deferred()
    const consumer = context.installComponent({
      inject: ['timer'],
      apply(ctx) {
        ctx.timer[kind](async () => { await ctx.fiber.dispose(); done.resolve() }, 10)
      },
    })
    await consumer
    await vi.advanceTimersByTimeAsync(10)
    await done.promise
    expect(consumer.state).toBe(FiberState.DISPOSED)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows an interval callback to cancel its own timer', async () => {
    const { context } = await setup()
    let dispose!: Disposer
    const callback = vi.fn(async () => { await dispose() })
    dispose = context.timer.interval(callback, 10)
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenCalledOnce()
  })

  it('retains native interval overlap without waiting for prior callback completion', async () => {
    const { context } = await setup()
    const gates = [deferred(), deferred(), deferred()]
    let calls = 0
    const dispose = context.timer.interval(async () => { await gates[calls++].promise }, 10)
    await vi.advanceTimersByTimeAsync(30)
    expect(calls).toBe(3)
    await dispose()
    for (const gate of gates) gate.resolve()
    await vi.advanceTimersByTimeAsync(100)
    expect(calls).toBe(3)
  })
})

describe('Timer errors and validation', () => {
  it.each(['timeout', 'interval'] as const)('observes synchronous %s errors and keeps the caller active', async kind => {
    const { context } = await setup()
    const error = new Error('callback failed')
    const callback = vi.fn(() => { throw error })
    const consumer = context.installComponent({
      name: 'failing-caller', inject: ['timer'], apply(ctx) { ctx.timer[kind](callback, 10) },
    })
    await consumer
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenCalledOnce()
    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(context.logger.records().find(record => record.message === `timer ${kind} callback failed`)).toMatchObject({
      level: 'error', fiberId: consumer.id, data: error,
    })
    expect(flatten(consumer.inspect().effects).some(effect => effect.label === `ctx.timer.${kind}()`)).toBe(false)
  })

  it.each([new Error('async failure'), undefined, null, false])('observes an async interval rejection with its original value %j', async error => {
    const { context } = await setup()
    const callback = vi.fn(async () => { throw error })
    context.timer.interval(callback, 10)
    await vi.advanceTimersByTimeAsync(100)
    expect(callback).toHaveBeenCalledOnce()
    const records = context.logger.records().filter(record => record.message === 'timer interval callback failed')
    expect(records).toHaveLength(1)
    expect(records[0].data).toBe(error)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('observes every already started callback rejection after provider and caller disposal', async () => {
    const { context, provider } = await setup()
    const gates = [deferred(), deferred()]
    const errors = [new Error('first late failure'), new Error('second late failure')]
    let calls = 0
    const consumer = context.installComponent({
      inject: ['timer'], apply(ctx) { ctx.timer.interval(async () => { await gates[calls++].promise }, 10) },
    })
    await consumer
    await vi.advanceTimersByTimeAsync(20)
    expect(calls).toBe(2)
    await provider.dispose()
    await consumer.dispose()
    gates.forEach((gate, index) => gate.reject(errors[index]))
    await vi.advanceTimersByTimeAsync(0)
    expect(context.logger.records().filter(record => record.message === 'timer interval callback failed').map(record => record.data)).toEqual(errors)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('observes a timeout async rejection after its Effect has already been removed', async () => {
    const { context } = await setup()
    const gate = deferred()
    const error = new Error('late timeout failure')
    context.timer.timeout(() => gate.promise, 10)
    await vi.advanceTimersByTimeAsync(10)
    expect(flatten(context.fiber.inspect().effects).some(effect => effect.label === 'ctx.timer.timeout()')).toBe(false)
    gate.reject(error)
    await vi.advanceTimersByTimeAsync(0)
    expect(context.logger.records().find(record => record.message === 'timer timeout callback failed')?.data).toBe(error)
  })

  it.each(['timeout', 'interval'] as const)('rejects invalid %s inputs before registering an Effect', async kind => {
    const { context } = await setup()
    const baseline = context.fiber.inspect().effects.length
    const invalidDelays = [NaN, Infinity, -Infinity, -1, 2_147_483_648, '10', null, undefined]
    if (kind === 'interval') invalidDelays.push(0, 0.5)
    for (const delay of invalidDelays) {
      expect(() => context.timer[kind](() => {}, delay as number)).toThrow(RangeError)
    }
    expect(() => context.timer[kind](null as unknown as () => void, 10)).toThrow(TypeError)
    expect(context.fiber.inspect().effects).toHaveLength(baseline)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts zero timeout, fractional delays and the Node maximum without synchronous callbacks', async () => {
    const { context } = await setup()
    const callback = vi.fn()
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const interval = vi.spyOn(globalThis, 'setInterval')
    const disposers = [
      context.timer.timeout(callback, 0), context.timer.timeout(callback, 1.5),
      context.timer.interval(callback, 1.5), context.timer.timeout(callback, 2_147_483_647),
    ]
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 0)
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1.5)
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647)
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 1.5)
    expect(callback).not.toHaveBeenCalled()
    for (const dispose of disposers) await dispose()
  })
})
