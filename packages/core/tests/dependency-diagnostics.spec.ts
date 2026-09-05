/** 依赖诊断只观察现有解析结果和当前提供方身份，不增加用户 check 调用。 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState, Service } from '../src/index.js'
import type { DependencyDiagnosticSnapshot, Fiber } from '../src/index.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

const roots: Context[] = []
function root() {
  const context = new Context()
  roots.push(context)
  return context
}
function dependency(fiber: Fiber, name: string): DependencyDiagnosticSnapshot {
  const result = fiber.inspect().dependencies.find(item => item.serviceName === name)
  expect(result).toBeDefined()
  return result!
}

afterEach(async () => {
  for (const context of roots.splice(0)) {
    await context.fiber.dispose().catch(() => {})
    expect(context.fiber.inspect()).toMatchObject({ state: FiberState.ACTIVE, dependencies: [], effects: [], children: [] })
    const observe = vi.fn()
    const unsubscribe = context.registry.subscribe(observe, { replay: true })
    await unsubscribe()
    expect(observe).not.toHaveBeenCalled()
  }
})

describe('dependency diagnostics', () => {
  it('lists every missing service in injection order and returns stable frozen snapshots', async () => {
    const context = root()
    const consumer = context.inject(['first', 'second', 'third'], () => {})
    await consumer
    const before = consumer.inspect()
    expect(before.dependencies).toEqual(['first', 'second', 'third'].map(serviceName => ({
      serviceName, status: 'blocked', reason: 'missing', providers: [],
    })))
    expect(Object.isFrozen(before.dependencies)).toBe(true)
    for (const item of before.dependencies) {
      expect(Object.isFrozen(item)).toBe(true)
      expect(Object.isFrozen(item.providers)).toBe(true)
    }
    context.provide('first', {})
    await consumer
    const first = dependency(consumer, 'first')
    expect(first.status).toBe('ready')
    expect(first.providers).toEqual([{
      fiberId: context.fiber.id, componentName: '<root>', state: FiberState.ACTIVE,
      source: 'provided', implementationId: expect.any(Number),
    }])
    expect(Object.isFrozen(first.providers[0])).toBe(true)
    expect(before.dependencies[0]).toEqual({ serviceName: 'first', status: 'blocked', reason: 'missing', providers: [] })
    await consumer.dispose()
    expect(consumer.inspect().dependencies).toEqual([])
  })

  it('identifies an already registered implementation while its ordinary provider is LOADING', async () => {
    const context = root()
    const entered = deferred()
    const gate = deferred()
    const check = vi.fn(() => true)
    const consumer = context.inject(['loading-service'], () => {})
    const provider = context.installComponent({
      name: 'ordinary-provider',
      async apply(context) {
        context.services.provide(context, 'loading-service', {}, check)
        entered.resolve()
        await gate.promise
      },
    })
    await entered.promise
    const pending = dependency(consumer, 'loading-service')
    expect(pending).toMatchObject({
      status: 'blocked', reason: 'provider-inactive', providers: [{
        fiberId: provider.id, componentName: 'ordinary-provider', state: FiberState.LOADING, source: 'provided',
      }],
    })
    expect(check).not.toHaveBeenCalled()
    gate.resolve()
    await provider
    await consumer
    expect(dependency(consumer, 'loading-service').status).toBe('ready')
    expect(check).toHaveBeenCalledOnce()
    for (let count = 0; count < 5; count++) consumer.inspect()
    expect(check).toHaveBeenCalledOnce()
    expect(pending.providers[0].state).toBe(FiberState.LOADING)
  })

  it('caches check false until the next real dependency refresh without changing lifecycle state', async () => {
    const context = root()
    let available = false
    const check = vi.fn(() => available)
    class CheckedService extends Service {
      static provide = 'checked-service';
      [Service.check]() { return check() }
    }
    const provider = context.installComponent(CheckedService)
    await provider
    const consumer = context.inject(['checked-service'], () => {})
    await consumer
    const before = dependency(consumer, 'checked-service')
    expect(before).toMatchObject({ status: 'blocked', reason: 'check-false' })
    expect(Object.hasOwn(before, 'error')).toBe(false)
    expect(consumer.state).toBe(FiberState.PENDING)
    available = true
    expect(dependency(consumer, 'checked-service').reason).toBe('check-false')
    expect(check).toHaveBeenCalledOnce()
    consumer.refreshDependencies()
    await consumer
    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(dependency(consumer, 'checked-service')).toMatchObject({ status: 'ready' })
    expect(check).toHaveBeenCalledTimes(2)
    expect(before.reason).toBe('check-false')
  })

  it.each([new Error('check failed'), undefined, null, false])('preserves the original thrown check value (%s) without failing the consumer', async error => {
    const context = root()
    let throwing = true
    const check = vi.fn(() => { if (throwing) throw error; return true })
    context.services.provide(context, 'throwing-service', {}, check)
    const consumer = context.inject(['throwing-service'], () => {})
    await consumer
    const before = dependency(consumer, 'throwing-service')
    expect(before).toMatchObject({ status: 'blocked', reason: 'check-threw' })
    expect(Object.hasOwn(before, 'error')).toBe(true)
    expect(before.error).toBe(error)
    expect(consumer.state).toBe(FiberState.PENDING)
    for (let count = 0; count < 3; count++) consumer.inspect()
    expect(check).toHaveBeenCalledOnce()
    throwing = false
    consumer.refreshDependencies()
    await consumer
    expect(dependency(consumer, 'throwing-service').status).toBe('ready')
    expect(Object.hasOwn(dependency(consumer, 'throwing-service'), 'error')).toBe(false)
    expect(before.error).toBe(error)
  })

  it('keeps the original check short circuit while showing later metadata blockers and unchecked services', async () => {
    const context = root()
    const checkFalse = vi.fn(() => false)
    const checkThrows = vi.fn(() => { throw new Error('must not run') })
    context.services.provide(context, 'checked-second', {}, checkFalse)
    context.services.provide(context, 'checked-fourth', {}, checkThrows)
    const consumer = context.inject(['missing-first', 'checked-second', 'missing-third', 'checked-fourth'], () => {})
    await consumer
    expect(consumer.inspect().dependencies.map(item => [item.serviceName, item.status, item.reason])).toEqual([
      ['missing-first', 'blocked', 'missing'], ['checked-second', 'unchecked', undefined],
      ['missing-third', 'blocked', 'missing'], ['checked-fourth', 'unchecked', undefined],
    ])
    expect(checkFalse).not.toHaveBeenCalled()
    expect(checkThrows).not.toHaveBeenCalled()
    const remove = context.provide('missing-first', {})
    await consumer
    expect(dependency(consumer, 'checked-second').reason).toBe('check-false')
    expect(dependency(consumer, 'missing-third').reason).toBe('missing')
    expect(dependency(consumer, 'checked-fourth').status).toBe('unchecked')
    expect(checkFalse).toHaveBeenCalledOnce()
    expect(checkThrows).not.toHaveBeenCalled()
    await remove()
    expect(dependency(consumer, 'checked-second').status).toBe('unchecked')
    expect(checkFalse).toHaveBeenCalledOnce()
  })

  it('recognizes installed Service declarations through PENDING and FAILED without promising a registered value', async () => {
    const context = root()
    const failure = new Error('initialization failed')
    class DeclaredService extends Service {
      static provide = 'declared-service'
      static inject = ['bootstrap'];
      [Service.init]() { throw failure }
    }
    const provider = context.installComponent(DeclaredService)
    await provider
    // 声明诊断不能凭空创建普通 Service slot 或改变 Context.has() 的结果。
    expect(context.services.has(context, 'declared-service')).toBe(false)
    const consumer = context.inject(['declared-service'], () => {})
    await consumer
    const pending = dependency(consumer, 'declared-service')
    expect(pending).toEqual({ serviceName: 'declared-service', status: 'blocked', reason: 'provider-inactive', providers: [{
      fiberId: provider.id, componentName: 'DeclaredService', state: FiberState.PENDING, source: 'declared',
    }] })
    context.provide('bootstrap', {})
    await expect(Promise.resolve(provider)).rejects.toBe(failure)
    await consumer
    expect(dependency(consumer, 'declared-service')).toMatchObject({
      reason: 'provider-inactive', providers: [{ fiberId: provider.id, state: FiberState.FAILED, source: 'declared' }],
    })
    expect(pending.providers[0].state).toBe(FiberState.PENDING)
    await provider.dispose()
    expect(dependency(consumer, 'declared-service')).toEqual({ serviceName: 'declared-service', status: 'blocked', reason: 'missing', providers: [] })
  })

  it('does not guess ordinary component provides or evaluate static provide accessors', async () => {
    const context = root()
    const readDeclaration = vi.fn(() => 'accessor-service')
    class AccessorService extends Service {
      static inject = ['bootstrap']
      static get provide() { return readDeclaration() }
    }
    context.installComponent(AccessorService)
    context.installComponent({
      name: 'ordinary', provide: 'ordinary-service', inject: ['bootstrap'], apply() {},
    })
    const consumer = context.inject(['accessor-service', 'ordinary-service'], () => {})
    await consumer
    expect(consumer.inspect().dependencies).toEqual(['accessor-service', 'ordinary-service'].map(serviceName => ({
      serviceName, status: 'blocked', reason: 'missing', providers: [],
    })))
    expect(readDeclaration).not.toHaveBeenCalled()
  })

  it('keeps declared provider identities strictly within their isolation address', async () => {
    const context = root()
    class ScopedService extends Service {
      static provide = 'scoped-service'
      static inject = ['bootstrap']
    }
    const firstScope = context.isolate('scoped-service', Symbol('first'))
    const secondScope = context.isolate('scoped-service', Symbol('second'))
    const firstProvider = firstScope.installComponent(ScopedService)
    const secondProvider = secondScope.installComponent(ScopedService)
    const first = firstScope.inject(['scoped-service'], () => {})
    const second = secondScope.inject(['scoped-service'], () => {})
    const outside = context.inject(['scoped-service'], () => {})
    await Promise.all([firstProvider, secondProvider, first, second, outside])
    expect(dependency(first, 'scoped-service').providers.map(provider => provider.fiberId)).toEqual([firstProvider.id])
    expect(dependency(second, 'scoped-service').providers.map(provider => provider.fiberId)).toEqual([secondProvider.id])
    expect(dependency(outside, 'scoped-service').providers).toEqual([])
    await firstProvider.dispose()
    expect(dependency(first, 'scoped-service').providers).toEqual([])
    expect(dependency(second, 'scoped-service').providers.map(provider => provider.fiberId)).toEqual([secondProvider.id])
    context.provide('bootstrap', {})
    await secondProvider
    await second
    expect(dependency(second, 'scoped-service')).toMatchObject({
      status: 'ready', providers: [{ fiberId: secondProvider.id, source: 'provided' }],
    })
    expect(dependency(first, 'scoped-service').providers).toEqual([])
    expect(dependency(outside, 'scoped-service').providers).toEqual([])
  })

  it('lists multiple declared candidates without selecting one or retaining a disposed candidate', async () => {
    const context = root()
    class CandidateService extends Service {
      static provide = 'candidate-service'
      static inject = ['bootstrap']
    }
    const first = context.installComponent(CandidateService)
    const second = context.installComponent(CandidateService)
    const consumer = context.inject(['candidate-service'], () => {})
    await consumer
    const before = dependency(consumer, 'candidate-service')
    expect(before.providers.map(provider => provider.fiberId)).toEqual([first.id, second.id])
    expect(before.providers.every(provider => provider.source === 'declared')).toBe(true)
    await first.dispose()
    expect(dependency(consumer, 'candidate-service').providers.map(provider => provider.fiberId)).toEqual([second.id])
    await second.dispose()
    expect(dependency(consumer, 'candidate-service').providers).toEqual([])
    expect(before.providers.map(provider => provider.fiberId)).toEqual([first.id, second.id])
  })

  it('reflects dependency invalidation and recovery while old provider snapshots stay unchanged', async () => {
    const context = root()
    const entered = deferred()
    const gate = deferred()
    const definition = { name: 'restartable-provider', apply(context: Context) { context.provide('restartable', {}) } }
    const provider = context.installComponent(definition)
    await provider
    const consumer = context.inject(['restartable'], () => async () => { entered.resolve(); await gate.promise })
    await consumer
    const active = dependency(consumer, 'restartable')
    const closing = provider.dispose()
    await entered.promise
    expect(dependency(consumer, 'restartable')).toMatchObject({
      status: 'blocked', reason: 'provider-inactive', providers: [{ fiberId: provider.id, state: FiberState.UNLOADING }],
    })
    gate.resolve()
    await closing
    expect(dependency(consumer, 'restartable').reason).toBe('missing')
    const replacement = context.installComponent(definition)
    await replacement
    await consumer
    expect(dependency(consumer, 'restartable')).toMatchObject({ status: 'ready', providers: [{ fiberId: replacement.id }] })
    expect(active.providers[0]).toMatchObject({ fiberId: provider.id, state: FiberState.ACTIVE })
  })

  it('distinguishes an invalid implementation whose owner remains ACTIVE from a check failure', async () => {
    const context = root()
    const entered = deferred()
    const gate = deferred()
    const check = vi.fn(() => true)
    class InnerService extends Service {
      static provide = 'inner-diagnostic';
      [Service.check]() { return check() }
    }
    class OuterService extends Service {
      static provide = 'outer-diagnostic'
      createInner() { return new InnerService(this.ctx) }
    }
    const provider = context.installComponent(OuterService)
    await provider
    ;(context.get('outer-diagnostic') as OuterService).createInner()
    const consumer = context.inject(['inner-diagnostic'], () => async () => { entered.resolve(); await gate.promise })
    await consumer
    const checks = check.mock.calls.length
    const closing = provider.dispose()
    await entered.promise
    expect(dependency(consumer, 'inner-diagnostic')).toMatchObject({
      status: 'blocked', reason: 'implementation-unavailable', providers: [{
        fiberId: context.fiber.id, state: FiberState.ACTIVE, source: 'provided',
      }],
    })
    expect(check).toHaveBeenCalledTimes(checks)
    gate.resolve()
    await closing
    expect(dependency(consumer, 'inner-diagnostic').reason).toBe('missing')
  })

  it('does not attach an old check error to a replacement implementation skipped by short circuit', async () => {
    const context = root()
    const error = new Error('old implementation')
    const removeGuard = context.provide('guard', {})
    const removeOld = context.services.provide(context, 'replaceable', {}, () => { throw error })
    const consumer = context.inject(['guard', 'replaceable'], () => {})
    await consumer
    const old = dependency(consumer, 'replaceable')
    expect(old.error).toBe(error)
    await removeGuard()
    await removeOld()
    const check = vi.fn(() => true)
    context.services.provide(context, 'replaceable', {}, check)
    await consumer
    const current = dependency(consumer, 'replaceable')
    expect(current.status).toBe('unchecked')
    expect(Object.hasOwn(current, 'error')).toBe(false)
    expect(current.providers[0].implementationId).not.toBe(old.providers[0].implementationId)
    expect(check).not.toHaveBeenCalled()
    expect(old.error).toBe(error)
    await consumer.dispose()
    expect(consumer.inspect().dependencies).toEqual([])
  })
})
