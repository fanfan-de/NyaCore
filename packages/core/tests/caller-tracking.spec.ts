/** 本文件验证 Service 调用方视图、提供方依赖快照和资源所有权语义。 */

import { describe, expect, it, vi } from 'vitest'
import {
  Context,
  Fiber,
  FiberState,
  Service,
} from '../src/index.js'

declare module '../src/index.js' {
  interface Events {
    'caller/resource'(value: number): void
    'caller/nested-service-event'(this: object, value: string): void
    'caller/derived-service-event'(this: object, value: string): void
    'caller/alias-service-event'(this: object, value: string): void
  }
}

function read<Value>(context: Context, name: string) {
  return context.get(name) as Value
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Service caller tracking', () => {
  it('returns stable caller facades that preserve class and member behavior', async () => {
    const app = new Context()
    const symbolicCaller = Symbol('symbolic caller')
    const setterContexts: Context[] = []
    const firstMarker = {}
    const secondMarker = {}
    let raw!: FacadeService

    class FacadeService extends Service {
      static provide = 'callerFacade'

      private storedValue = 'initial'
      readonly arrow = () => this.ctx
      readonly Widget = class Widget {
        readonly value = 42
      }

      constructor(context: Context) {
        super(context)
        raw = this
      }

      caller() {
        return this.ctx
      }

      marker() {
        return (this.ctx as Context & { callerMarker: object }).callerMarker
      }

      [symbolicCaller]() {
        return this.ctx
      }

      get callerContext() {
        return this.ctx
      }

      get value() {
        return this.storedValue
      }

      set value(value: string) {
        setterContexts.push(this.ctx)
        this.storedValue = value
      }
    }

    const provider = app.installComponent(FacadeService)
    await provider

    let firstContext!: Context
    let secondContext!: Context
    let firstProperty!: FacadeService
    let firstExplicit!: FacadeService
    let secondProperty!: FacadeService
    let destructuredContext!: Context
    let symbolicContext!: Context

    const firstParent = app.extend({ callerMarker: firstMarker })
    const secondParent = app.extend({ callerMarker: secondMarker })
    const first = firstParent.inject(['callerFacade'], (context) => {
      firstContext = context
      firstProperty = (context as Context & {
        callerFacade: FacadeService
      }).callerFacade
      firstExplicit = read<FacadeService>(context, 'callerFacade')

      const { caller } = firstProperty
      destructuredContext = caller()
      const callSymbol = firstProperty[symbolicCaller]
      symbolicContext = callSymbol()
      firstProperty.value = 'updated'
    })
    const second = secondParent.inject(['callerFacade'], (context) => {
      secondContext = context
      secondProperty = (context as Context & {
        callerFacade: FacadeService
      }).callerFacade
    })
    await Promise.all([first, second])

    expect(firstProperty).toBe(firstExplicit)
    expect(firstProperty).not.toBe(raw)
    expect(secondProperty).not.toBe(firstProperty)
    expect(firstProperty).toBeInstanceOf(FacadeService)
    expect(secondProperty).toBeInstanceOf(FacadeService)
    expect(firstProperty.caller).toBe(firstProperty.caller)
    expect(firstProperty[symbolicCaller]).toBe(firstProperty[symbolicCaller])
    expect(firstProperty.arrow).toBe(raw.arrow)
    expect(firstProperty.Widget).toBe(raw.Widget)
    expect(new firstProperty.Widget().value).toBe(42)
    const firstServiceContext = firstProperty.caller()
    const secondServiceContext = secondProperty.caller()
    expect(firstServiceContext).not.toBe(firstContext)
    expect(secondServiceContext).not.toBe(secondContext)
    expect(firstServiceContext.root).toBe(firstContext.root)
    expect(firstServiceContext.fiber).toBe(firstContext.fiber)
    expect(secondServiceContext.root).toBe(secondContext.root)
    expect(secondServiceContext.fiber).toBe(secondContext.fiber)
    expect(firstProperty.marker()).toBe(firstMarker)
    expect(secondProperty.marker()).toBe(secondMarker)
    expect(firstProperty.callerContext).toBe(firstServiceContext)
    expect(destructuredContext).toBe(firstServiceContext)
    expect(symbolicContext).toBe(firstServiceContext)
    expect(setterContexts).toHaveLength(1)
    expect(setterContexts[0]).toBe(firstServiceContext)
    expect(firstProperty.value).toBe('updated')
    expect(secondProperty.value).toBe('updated')
    expect(raw.value).toBe('updated')
    const contextDescriptor = Object.getOwnPropertyDescriptor(
      firstProperty,
      'ctx',
    )
    expect(contextDescriptor?.value).toBe(firstServiceContext)
    expect(contextDescriptor?.writable).toBe(false)
    expect(() => Object.defineProperty(firstProperty, 'ctx', {
      value: firstContext,
    })).toThrow('cannot redefine the Context of a Service facade')
    expect(() => Reflect.deleteProperty(firstProperty, 'ctx')).toThrow(
      'cannot delete the Context of a Service facade',
    )
    expect(Reflect.preventExtensions(firstProperty)).toBe(false)
    expect(Object.isExtensible(raw)).toBe(true)

    await Promise.all([first.dispose(), second.dispose()])
    await provider.dispose()
    expect(() => firstProperty.value).toThrow('inactive context')
    expect(() => {
      firstProperty.value = 'stale write'
    }).toThrow('inactive context')
    expect(() => 'value' in firstProperty).toThrow('inactive context')
    expect(() => Object.keys(firstProperty)).toThrow('inactive context')
  })

  it('preserves identity and native behavior for ordinary provided objects', async () => {
    const app = new Context()
    const key = {}
    const ordinary = new Map<object, string>([[key, 'value']])
    const remove = app.provide('callerPlain', ordinary)
    let propertyValue!: Map<object, string>
    let explicitValue!: Map<object, string>

    const consumer = app.inject(['callerPlain'], (context) => {
      propertyValue = (context as Context & {
        callerPlain: Map<object, string>
      }).callerPlain
      explicitValue = read<Map<object, string>>(context, 'callerPlain')
    })
    await consumer

    expect(propertyValue).toBe(ordinary)
    expect(explicitValue).toBe(ordinary)
    expect(propertyValue.get(key)).toBe('value')
    expect(Reflect.get(consumer, 'getInjectedImplementation')).toBeUndefined()

    if (false) {
      // @ts-expect-error Fiber 不公开返回原始 ServiceImplementation 的读取入口。
      consumer.getInjectedImplementation('callerPlain')
    }

    await consumer.dispose()
    await remove()
  })

  it('uses an alias implementation address when the Provider reads its Service', async () => {
    const app = new Context()
    const canonicalEvents: string[] = []
    const aliasEvents: string[] = []

    class AliasService extends Service {
      static provide = 'callerCanonicalService'

      publish(value: string) {
        this.ctx.emit(this, 'caller/alias-service-event', value)
      }
    }

    const raw = new AliasService(app)
    const removeAlias = app.provide('callerAliasService', raw)
    const canonicalListener = app.isolate('callerAliasService')
    const aliasListener = app.isolate('callerCanonicalService')
    const removeCanonicalListener = canonicalListener.on(
      'caller/alias-service-event',
      value => canonicalEvents.push(value),
    )
    const removeAliasListener = aliasListener.on(
      'caller/alias-service-event',
      value => aliasEvents.push(value),
    )

    const canonical = read<AliasService>(app, 'callerCanonicalService')
    const alias = read<AliasService>(app, 'callerAliasService')
    expect(canonical).toBe(raw)
    expect(alias).not.toBe(raw)

    canonical.publish('canonical')
    alias.publish('alias')
    expect(canonicalEvents).toEqual(['canonical'])
    expect(aliasEvents).toEqual(['alias'])

    await Promise.all([
      removeAliasListener(),
      removeCanonicalListener(),
      removeAlias(),
    ])
    await app.fiber.restart()
  })

  it('does not reuse a raw Service across same-named isolation addresses', async () => {
    const app = new Context()
    const isolated = app.isolate(
      'callerRepeatedService',
      Symbol('repeated service isolation'),
    )
    const defaultEvents: string[] = []
    const isolatedEvents: string[] = []

    class RepeatedService extends Service {
      static provide = 'callerRepeatedService'

      publish(value: string) {
        this.ctx.emit(this, 'caller/alias-service-event', value)
      }
    }

    const raw = new RepeatedService(app)
    const removeIsolated = isolated.provide('callerRepeatedService', raw)
    const removeDefaultListener = app.on(
      'caller/alias-service-event',
      value => defaultEvents.push(value),
    )
    const removeIsolatedListener = isolated.on(
      'caller/alias-service-event',
      value => isolatedEvents.push(value),
    )
    const isolatedView = read<RepeatedService>(
      isolated,
      'callerRepeatedService',
    )

    expect(read<RepeatedService>(app, 'callerRepeatedService')).toBe(raw)
    expect(isolatedView).not.toBe(raw)
    raw.publish('default')
    isolatedView.publish('isolated')
    expect(defaultEvents).toEqual(['default'])
    expect(isolatedEvents).toEqual(['isolated'])

    await Promise.all([
      removeIsolatedListener(),
      removeDefaultListener(),
      removeIsolated(),
    ])
    await app.fiber.restart()
  })

  it('owns effects, listeners, and installed children through the caller Fiber', async () => {
    const app = new Context()
    const effectCleanup = vi.fn()
    const childCleanup = vi.fn()
    const providerCleanup = vi.fn()
    const listener = vi.fn()
    const childOnly = { id: 1 }
    const removeChildOnly = app.provide('callerChildOnly', childOnly)
    let child!: Fiber
    let resourceContext!: Context
    let childObserved: unknown

    class ResourceService extends Service {
      static provide = 'callerResources'

      allocate() {
        const context = this.ctx
        context.effect(() => effectCleanup, 'caller-owned service resource')
        context.on('caller/resource', listener)
        child = context.installComponent({
          inject: ['callerChildOnly'],
          apply(context) {
            childObserved = context.get('callerChildOnly')
            return childCleanup
          },
        })
        return context
      }

      [Service.init]() {
        return providerCleanup
      }
    }

    const provider = app.installComponent(ResourceService)
    await provider
    const consumer = app.inject(['callerResources'], (context) => {
      resourceContext = read<ResourceService>(context, 'callerResources')
        .allocate()
    })
    await consumer
    await child

    expect(resourceContext).not.toBe(consumer.context)
    expect(resourceContext.root).toBe(consumer.context.root)
    expect(resourceContext.fiber).toBe(consumer.context.fiber)
    expect(child.state).toBe(FiberState.ACTIVE)
    expect(childObserved).toBe(childOnly)
    app.emit('caller/resource', 1)
    expect(listener).toHaveBeenCalledWith(1)

    await consumer.dispose()

    expect(effectCleanup).toHaveBeenCalledOnce()
    expect(childCleanup).toHaveBeenCalledOnce()
    expect(child.state).toBe(FiberState.DISPOSED)
    expect(provider.state).toBe(FiberState.ACTIVE)
    expect(providerCleanup).not.toHaveBeenCalled()
    app.emit('caller/resource', 2)
    expect(listener).toHaveBeenCalledOnce()

    await provider.dispose()
    expect(providerCleanup).toHaveBeenCalledOnce()
    await removeChildOnly()
  })

  it('uses provider permissions and its pinned dependency snapshot', async () => {
    const app = new Context()
    const caller = app.isolate('callerBackend', Symbol('caller backend'))
    const cleanupIds: number[] = []
    const cleanupBackendIds: number[] = []
    const observations: Array<[number, number]> = []
    const activeFacades: WorkerService[] = []
    const cleanupFacades: WorkerService[] = []

    interface Backend {
      id: number
    }

    class WorkerService extends Service {
      static provide = 'callerWorker'
      static inject = ['callerBackend']

      backendId() {
        return read<Backend>(this.ctx, 'callerBackend').id
      }

      readCallerOnly() {
        return this.ctx.get('callerOnly')
      }

      [Service.init]() {
        return () => {
          cleanupIds.push(read<Backend>(this.ctx, 'callerBackend').id)
        }
      }
    }

    const removeDefault = app.provide('callerBackend', { id: 1 })
    const removeCaller = caller.provide('callerBackend', { id: 99 })
    const removeCallerOnly = caller.provide('callerOnly', { id: 100 })
    const provider = app.installComponent(WorkerService)
    await provider

    const consumer = caller.installComponent({
      inject: ['callerWorker', 'callerBackend', 'callerOnly'],
      apply(context) {
        const worker = read<WorkerService>(context, 'callerWorker')
        activeFacades.push(worker)
        observations.push([
          worker.backendId(),
          read<Backend>(context, 'callerBackend').id,
        ])
        expect(() => worker.readCallerOnly()).toThrow(
          'cannot get service "callerOnly" without inject',
        )
        return () => {
          const cleanupFacade = read<WorkerService>(context, 'callerWorker')
          cleanupFacades.push(cleanupFacade)
          cleanupBackendIds.push(cleanupFacade.backendId())
        }
      },
    })
    await consumer

    expect(observations).toEqual([[1, 99]])
    await removeDefault()

    expect(cleanupIds).toEqual([1])
    expect(cleanupFacades).toHaveLength(1)
    expect(cleanupFacades[0]).toBe(activeFacades[0])
    expect(cleanupBackendIds).toEqual([1])
    expect(provider.state).toBe(FiberState.PENDING)
    expect(consumer.state).toBe(FiberState.PENDING)

    const removeReplacement = app.provide('callerBackend', { id: 2 })
    await Promise.all([provider, consumer])

    expect(observations).toEqual([[1, 99], [2, 99]])
    expect(activeFacades).toHaveLength(2)
    // Vitest 的 `.not.toBe()` 会在引用不同时继续深读对象以生成提示；
    // 旧 facade 已按约定拒绝属性读取，因此直接断言 Object.is 结果。
    expect(Object.is(activeFacades[1], activeFacades[0])).toBe(false)
    expect(() => activeFacades[0].backendId()).toThrow('inactive context')
    expect(activeFacades[1].backendId()).toBe(2)
    expect(provider.state).toBe(FiberState.ACTIVE)
    expect(consumer.state).toBe(FiberState.ACTIVE)

    await consumer.dispose()
    expect(cleanupFacades).toHaveLength(2)
    expect(cleanupFacades[1]).toBe(activeFacades[1])
    expect(cleanupBackendIds).toEqual([1, 2])
    await provider.dispose()
    expect(cleanupIds).toEqual([1, 2])
    await Promise.all([
      removeReplacement(),
      removeCallerOnly(),
      removeCaller(),
    ])
  })

  it('does not bypass provider isolation when validating its snapshot address', async () => {
    const app = new Context()
    const otherLabel = Symbol('provider dependency override')

    interface Dependency {
      id: number
    }

    class StrictWorkerService extends Service {
      static provide = 'callerStrictWorker'
      static inject = ['callerStrictDependency']

      constructor(context: Context) {
        super(context.isolate('callerStrictDependency', otherLabel))
      }

      dependency() {
        return read<Dependency>(this.ctx, 'callerStrictDependency')
      }
    }

    const removeDependency = app.provide(
      'callerStrictDependency',
      { id: 1 },
    )
    const provider = app.installComponent(StrictWorkerService)
    await provider
    let failure: unknown
    const consumer = app.inject(['callerStrictWorker'], (context) => {
      try {
        read<StrictWorkerService>(context, 'callerStrictWorker').dependency()
      } catch (error) {
        failure = error
      }
    })
    await consumer

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'cannot get required service "callerStrictDependency" in inactive context',
    )

    await consumer.dispose()
    await provider.dispose()
    await removeDependency()
  })

  it('uses the provider address for mixed Context has and get', async () => {
    const app = new Context()
    const dependency = { id: 1 }
    const caller = app.isolate(
      'callerMixedDependency',
      Symbol('empty caller dependency slot'),
    )

    class MixedAccessService extends Service {
      static provide = 'callerMixedAccess'
      static inject = ['callerMixedDependency']

      inspect() {
        return {
          has: 'callerMixedDependency' in this.ctx,
          value: this.ctx.get('callerMixedDependency'),
        }
      }
    }

    const removeDependency = app.provide(
      'callerMixedDependency',
      dependency,
    )
    expect('callerMixedDependency' in app).toBe(true)
    expect('callerMixedDependency' in caller).toBe(false)
    expect(caller.get('callerMixedDependency')).toBeUndefined()

    const provider = app.installComponent(MixedAccessService)
    await provider
    let observed!: { has: boolean; value: unknown }
    const consumer = caller.inject(['callerMixedAccess'], (context) => {
      observed = read<MixedAccessService>(context, 'callerMixedAccess')
        .inspect()
    })
    await consumer

    expect(observed.has).toBe(true)
    expect(observed.value).toBe(dependency)

    await consumer.dispose()
    await provider.dispose()
    await removeDependency()
  })

  it('keeps nested Service providers on the outer provider dependency frame', async () => {
    const app = new Context()
    const providerDependency = { id: 'provider' }
    const creatingCallerDependency = { id: 'creating-caller' }
    const otherCallerDependency = { id: 'other-caller' }
    const innerLabel = Symbol('shared inner service')
    const creatingCaller = app.isolate(
      'callerNestedDependency',
      Symbol('creating caller dependency'),
    ).isolate('callerNestedInner', innerLabel)
    const otherCaller = app.isolate(
      'callerNestedDependency',
      Symbol('other caller dependency'),
    ).isolate('callerNestedInner', innerLabel)
    const wrongInnerCaller = app.isolate(
      'callerNestedInner',
      Symbol('wrong inner service'),
    )
    const innerEvents: string[] = []
    const wrongInnerEvents: string[] = []

    interface Dependency {
      id: string
    }

    class InnerService extends Service {
      static provide = 'callerNestedInner'

      dependency() {
        return read<Dependency>(this.ctx, 'callerNestedDependency')
      }

      publish(value: string) {
        this.ctx.emit(this, 'caller/nested-service-event', value)
      }
    }

    class OuterService extends Service {
      static provide = 'callerNestedOuter'
      static inject = ['callerNestedDependency']

      createInner() {
        const inner = new InnerService(this.ctx)
        return {
          inner,
          dependency: inner.dependency(),
        }
      }
    }

    const removeProviderDependency = app.provide(
      'callerNestedDependency',
      providerDependency,
    )
    const removeCreatingDependency = creatingCaller.provide(
      'callerNestedDependency',
      creatingCallerDependency,
    )
    const removeOtherDependency = otherCaller.provide(
      'callerNestedDependency',
      otherCallerDependency,
    )
    const outerProvider = app.installComponent(OuterService)
    await outerProvider
    const removeInnerListener = otherCaller.on(
      'caller/nested-service-event',
      value => innerEvents.push(value),
    )
    const removeWrongInnerListener = wrongInnerCaller.on(
      'caller/nested-service-event',
      value => wrongInnerEvents.push(value),
    )

    let rawInner!: InnerService
    let rawDependency!: Dependency
    let creatingSnapshot!: Dependency
    const creator = creatingCaller.installComponent({
      inject: ['callerNestedOuter', 'callerNestedDependency'],
      apply(context) {
        creatingSnapshot = read<Dependency>(
          context,
          'callerNestedDependency',
        )
        const created = read<OuterService>(context, 'callerNestedOuter')
          .createInner()
        rawInner = created.inner
        rawDependency = created.dependency
      },
    })
    await creator

    let facadeInner!: InnerService
    let facadeDependency!: Dependency
    let otherSnapshot!: Dependency
    const otherConsumer = otherCaller.installComponent({
      inject: ['callerNestedInner', 'callerNestedDependency'],
      apply(context) {
        otherSnapshot = read<Dependency>(context, 'callerNestedDependency')
        facadeInner = read<InnerService>(context, 'callerNestedInner')
        facadeDependency = facadeInner.dependency()
      },
    })
    await otherConsumer

    expect(creatingSnapshot).toBe(creatingCallerDependency)
    expect(otherSnapshot).toBe(otherCallerDependency)
    expect(rawDependency).toBe(providerDependency)
    expect(rawInner.dependency()).toBe(providerDependency)
    expect(facadeInner).not.toBe(rawInner)
    expect(facadeDependency).toBe(providerDependency)
    rawInner.publish('raw')
    facadeInner.publish('facade')
    expect(innerEvents).toEqual(['raw', 'facade'])
    expect(wrongInnerEvents).toEqual([])

    await otherConsumer.dispose()
    await creator.dispose()
    await outerProvider.dispose()
    await Promise.all([
      removeWrongInnerListener(),
      removeInnerListener(),
      removeOtherDependency(),
      removeCreatingDependency(),
      removeProviderDependency(),
    ])
  })

  it('invalidates cross-owner Services before their source Provider cleans up', async () => {
    const app = new Context()
    const events: string[] = []
    const starts: number[] = []

    interface Dependency {
      id: number
    }

    class InnerService extends Service {
      static provide = 'callerSourceInner'

      dependencyId() {
        return read<Dependency>(this.ctx, 'callerSourceDependency').id
      }
    }

    class OuterService extends Service {
      static provide = 'callerSourceOuter'
      static inject = ['callerSourceDependency']

      createInner() {
        return new InnerService(this.ctx)
      }

      [Service.init]() {
        return () => events.push('outer:stop')
      }
    }

    const removeDependency = app.provide(
      'callerSourceDependency',
      { id: 1 },
    )
    const outerProvider = app.installComponent(OuterService)
    await outerProvider

    const inner = read<OuterService>(app, 'callerSourceOuter').createInner()
    expect(inner.dependencyId()).toBe(1)

    const consumer = app.inject(['callerSourceInner'], (context) => {
      const facade = read<InnerService>(context, 'callerSourceInner')
      starts.push(facade.dependencyId())
      return () => {
        events.push(`inner:stop:${facade.dependencyId()}`)
      }
    })
    await consumer
    expect(consumer.state).toBe(FiberState.ACTIVE)

    await removeDependency()

    expect(outerProvider.state).toBe(FiberState.PENDING)
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(events).toEqual(['inner:stop:1', 'outer:stop'])
    expect(app.get('callerSourceInner')).toBeUndefined()
    expect(() => inner.dependencyId()).toThrow('inactive context')

    const removeReplacement = app.provide(
      'callerSourceDependency',
      { id: 2 },
    )
    await outerProvider
    const replacementInner = read<OuterService>(app, 'callerSourceOuter')
      .createInner()
    await consumer

    expect(replacementInner.dependencyId()).toBe(2)
    expect(starts).toEqual([1, 2])
    expect(consumer.state).toBe(FiberState.ACTIVE)
    const replacementFacade = read<InnerService>(app, 'callerSourceInner')
    expect(replacementFacade).not.toBe(replacementInner)
    expect(replacementFacade.dependencyId()).toBe(2)

    await consumer.dispose()
    await outerProvider.dispose()
    expect(app.get('callerSourceInner')).toBeUndefined()
    await removeReplacement()
    await app.fiber.restart()
  })

  it('invalidates consumers before Provider Effects added after the source edge', async () => {
    const app = new Context()
    const events: string[] = []
    let resourceAlive = true
    let rawOuter!: OuterService

    class InnerService extends Service {
      static provide = 'callerOrderedInner'

      useProviderResource() {
        if (!resourceAlive) throw new Error('provider resource already closed')
        events.push('inner:resource-live')
      }
    }

    class OuterService extends Service {
      static provide = 'callerOrderedOuter'
      static inject = ['callerOrderedDependency']

      constructor(context: Context) {
        super(context)
        rawOuter = this
      }

      createInner() {
        return new InnerService(this.ctx)
      }

      addLateResource() {
        this.ctx.effect(() => () => {
          resourceAlive = false
          events.push('provider-resource:stop')
        })
      }

      [Service.init]() {
        return () => events.push('outer:stop')
      }
    }

    const removeDependency = app.provide(
      'callerOrderedDependency',
      true,
    )
    const provider = app.installComponent(OuterService)
    await provider
    read<OuterService>(app, 'callerOrderedOuter').createInner()
    rawOuter.addLateResource()

    const consumer = app.inject(['callerOrderedInner'], (context) => {
      const inner = read<InnerService>(context, 'callerOrderedInner')
      return () => {
        inner.useProviderResource()
        events.push('inner:stop')
      }
    })
    await consumer

    await removeDependency()

    expect(events).toEqual([
      'inner:resource-live',
      'inner:stop',
      'provider-resource:stop',
      'outer:stop',
    ])
    expect(provider.state).toBe(FiberState.PENDING)
    expect(consumer.state).toBe(FiberState.PENDING)

    await consumer.dispose()
    await provider.dispose()
    await app.fiber.restart()
  })

  it('keeps the old source readable while source and owner unload together', async () => {
    const app = new Context()
    const cleanupIds: number[] = []

    interface Dependency {
      id: number
    }

    class InnerService extends Service {
      static provide = 'callerConcurrentOwnerInner'

      dependencyId() {
        return read<Dependency>(
          this.ctx,
          'callerConcurrentOwnerDependency',
        ).id
      }
    }

    class OuterService extends Service {
      static provide = 'callerConcurrentOwnerOuter'
      static inject = ['callerConcurrentOwnerDependency']

      createInner() {
        return new InnerService(this.ctx)
      }
    }

    const removeDependency = app.provide(
      'callerConcurrentOwnerDependency',
      { id: 1 },
    )
    const provider = app.installComponent(OuterService)
    await provider

    const owner = app.inject(['callerConcurrentOwnerOuter'], (context) => {
      read<OuterService>(context, 'callerConcurrentOwnerOuter').createInner()
    })
    await owner
    const consumer = app.inject(
      ['callerConcurrentOwnerInner'],
      (context) => {
        const inner = read<InnerService>(
          context,
          'callerConcurrentOwnerInner',
        )
        return () => {
          cleanupIds.push(inner.dependencyId())
        }
      },
    )
    await consumer

    await removeDependency()

    expect(owner.state).toBe(FiberState.PENDING)
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(provider.state).toBe(FiberState.PENDING)
    expect(cleanupIds).toEqual([1])
    expect(app.get('callerConcurrentOwnerInner')).toBeUndefined()

    await Promise.all([
      consumer.dispose(),
      owner.dispose(),
      provider.dispose(),
    ])
  })

  it('waits for downstream consumers before cleaning caller-owned resources', async () => {
    const app = new Context()
    const cleanupStarted = deferred()
    const cleanupGate = deferred()
    const observedAlive: boolean[] = []
    let rawInner!: OwnedInnerService

    class OwnedInnerService extends Service {
      static provide = 'callerOwnedInner'

      alive = true

      constructor(context: Context) {
        super(context)
        rawInner = this
        context.effect(() => () => {
          this.alive = false
        }, 'caller-owned inner resource')
      }

      isAlive() {
        return this.alive
      }
    }

    class OwnerService extends Service {
      static provide = 'callerOwnedOuter'

      createInner() {
        return new OwnedInnerService(this.ctx)
      }
    }

    const provider = app.installComponent(OwnerService)
    await provider
    const owner = app.inject(['callerOwnedOuter'], (context) => {
      read<OwnerService>(context, 'callerOwnedOuter').createInner()
    })
    await owner
    const consumer = app.inject(['callerOwnedInner'], (context) => {
      const inner = read<OwnedInnerService>(context, 'callerOwnedInner')
      return async () => {
        cleanupStarted.resolve()
        await cleanupGate.promise
        observedAlive.push(inner.isAlive())
      }
    })
    await consumer

    const disposingOwner = owner.dispose()
    await cleanupStarted.promise
    expect(rawInner.alive).toBe(true)

    cleanupGate.resolve()
    await disposingOwner
    expect(observedAlive).toEqual([true])
    expect(rawInner.alive).toBe(false)
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(provider.state).toBe(FiberState.ACTIVE)

    await consumer.dispose()
    await provider.dispose()
    await app.fiber.restart()
  })

  it('joins source-first removal through consumer drain and finalization', async () => {
    const app = new Context()
    const cleanupStarted = deferred()
    const cleanupGate = deferred()
    const events: string[] = []
    let providerResourceAlive = true

    class RaceSourceService extends Service {
      static provide = 'callerRaceSource'
      static inject = ['callerRaceDependency']

      expose() {
        return this.ctx.provide('callerRaceDownstream', {})
      }

      [Service.init]() {
        return () => {
          providerResourceAlive = false
          events.push('provider:stop')
        }
      }
    }

    const removeDependency = app.provide('callerRaceDependency', {})
    const provider = app.installComponent(RaceSourceService)
    await provider
    const removeDownstream = read<RaceSourceService>(
      app,
      'callerRaceSource',
    ).expose()
    const consumer = app.inject(['callerRaceDownstream'], () => {
      return async () => {
        events.push('consumer:start')
        cleanupStarted.resolve()
        await cleanupGate.promise
        events.push(`consumer:resource:${providerResourceAlive}`)
      }
    })
    await consumer

    const removingDependency = Promise.resolve(removeDependency())
    await cleanupStarted.promise
    const removingDownstream = Promise.resolve(removeDownstream())
    let publicRemovalSettled = false
    void removingDownstream.then(
      () => {
        publicRemovalSettled = true
      },
      () => {
        publicRemovalSettled = true
      },
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(publicRemovalSettled).toBe(false)
    expect(providerResourceAlive).toBe(true)

    cleanupGate.resolve()
    await Promise.all([removingDownstream, removingDependency])
    expect(events).toEqual([
      'consumer:start',
      'consumer:resource:true',
      'provider:stop',
    ])
    expect(provider.state).toBe(FiberState.PENDING)
    expect(consumer.state).toBe(FiberState.PENDING)
    const removeReplacement = app.provide(
      'callerRaceDownstream',
      { replacement: true },
    )
    expect(app.get('callerRaceDownstream')).toEqual({ replacement: true })
    await removeReplacement()

    await consumer.dispose()
    await provider.dispose()
    await app.fiber.restart()
  })

  it('propagates a manual-first barrier failure to both removal paths', async () => {
    const app = new Context()
    const cleanupStarted = deferred()
    const cleanupGate = deferred()
    const cleanupError = new Error('downstream cleanup failed')
    const events: string[] = []
    let providerResourceAlive = true

    class FailingRaceSourceService extends Service {
      static provide = 'callerFailingRaceSource'
      static inject = ['callerFailingRaceDependency']

      expose() {
        return this.ctx.provide('callerFailingRaceDownstream', {})
      }

      [Service.init]() {
        return () => {
          providerResourceAlive = false
          events.push('provider:stop')
        }
      }
    }

    const removeDependency = app.provide(
      'callerFailingRaceDependency',
      {},
    )
    const provider = app.installComponent(FailingRaceSourceService)
    await provider
    const removeDownstream = read<FailingRaceSourceService>(
      app,
      'callerFailingRaceSource',
    ).expose()
    const consumer = app.inject(['callerFailingRaceDownstream'], () => {
      return async () => {
        cleanupStarted.resolve()
        await cleanupGate.promise
        events.push(`consumer:resource:${providerResourceAlive}`)
        throw cleanupError
      }
    })
    await consumer

    const removingDownstream = Promise.resolve(removeDownstream())
    await cleanupStarted.promise
    const removingDependency = Promise.resolve(removeDependency())
    cleanupGate.resolve()
    const results = await Promise.allSettled([
      removingDownstream,
      removingDependency,
    ])

    expect(results).toEqual([
      { status: 'rejected', reason: cleanupError },
      { status: 'rejected', reason: cleanupError },
    ])
    expect(events).toEqual(['consumer:resource:true', 'provider:stop'])
    expect(providerResourceAlive).toBe(false)
    expect(app.get('callerFailingRaceDownstream')).toBeUndefined()
    expect(provider.state).toBe(FiberState.FAILED)
    expect(consumer.state).toBe(FiberState.FAILED)
    const removeReplacement = app.provide(
      'callerFailingRaceDownstream',
      { replacement: true },
    )
    expect(app.get('callerFailingRaceDownstream')).toEqual({
      replacement: true,
    })
    await removeReplacement()

    await consumer.dispose()
    await provider.dispose()
  })

  it('returns a facade for another Context on the Provider Fiber', async () => {
    const app = new Context()
    const marker = {}
    let raw!: SelfService
    let exact!: SelfService
    let derived!: SelfService
    let derivedContext!: Context

    class SelfService extends Service {
      static provide = 'callerProviderSelf'

      constructor(context: Context) {
        super(context)
        raw = this
        exact = read<SelfService>(context, 'callerProviderSelf')
        derivedContext = context.extend({ marker })
        derived = read<SelfService>(derivedContext, 'callerProviderSelf')
      }

      caller() {
        return this.ctx
      }
    }

    const provider = app.installComponent(SelfService)
    await provider

    expect(exact).toBe(raw)
    expect(derived).not.toBe(raw)
    expect(derived).toBeInstanceOf(SelfService)
    expect(read<SelfService>(derivedContext, 'callerProviderSelf'))
      .toBe(derived)
    expect(derived.caller().fiber).toBe(provider)
    expect((derived.caller() as Context & { marker: object }).marker)
      .toBe(marker)

    await provider.dispose()
  })

  it('carries the original caller from one Service into another', async () => {
    const app = new Context()
    const callerMarker = {}
    const caller = app
      .isolate('callerB', Symbol('caller-only B label'))
      .extend({ callerMarker })

    class DownstreamService extends Service {
      static provide = 'callerB'

      caller() {
        return this.ctx
      }
    }

    class UpstreamService extends Service {
      static provide = 'callerA'
      static inject = ['callerB']

      callers() {
        const downstream = read<DownstreamService>(this.ctx, 'callerB')
        return [this.ctx, downstream.caller()] as const
      }
    }

    const downstreamProvider = app.installComponent(DownstreamService)
    await downstreamProvider
    const upstreamProvider = app.installComponent(UpstreamService)
    await upstreamProvider

    let observed!: readonly [Context, Context]
    const consumer = caller.inject(['callerA'], (context) => {
      observed = read<UpstreamService>(context, 'callerA').callers()
    })
    await consumer

    for (const context of observed) {
      expect(context).not.toBe(consumer.context)
      expect(context.root).toBe(consumer.context.root)
      expect(context.fiber).toBe(consumer.context.fiber)
      expect((context as Context & { callerMarker: object }).callerMarker)
        .toBe(callerMarker)
    }

    await consumer.dispose()
    await upstreamProvider.dispose()
    await downstreamProvider.dispose()
  })

  it('advances explicitly derived caller views while keeping Inner dependencies', async () => {
    const app = new Context()
    const innerLabel = Symbol('shared derived inner')
    const originalInnerLabel = Symbol('original caller inner')
    const callerDependencyLabel = Symbol('caller derived dependency')
    const marker = {}
    const providerDependency = { id: 'provider' }
    const callerDependency = { id: 'caller' }
    const providerScope = app.isolate('callerDerivedInner', innerLabel)
    const callerScope = app
      .isolate('callerDerivedInner', originalInnerLabel)
      .isolate('callerDerivedDependency', callerDependencyLabel)
    const wrongInnerScope = app.isolate(
      'callerDerivedInner',
      Symbol('wrong derived inner'),
    )
    const originalEvents: string[] = []
    const sharedEvents: string[] = []
    const wrongEvents: string[] = []

    interface Dependency {
      id: string
    }

    class InnerService extends Service {
      static provide = 'callerDerivedInner'
      static inject = ['callerDerivedDependency']

      dependency() {
        return read<Dependency>(this.ctx, 'callerDerivedDependency')
      }

      marker() {
        return (this.ctx as Context & { marker: object }).marker
      }

      publish(value: string) {
        this.ctx.emit(this, 'caller/derived-service-event', value)
      }
    }

    class OuterService extends Service {
      static provide = 'callerDerivedOuter'
      static inject = ['callerDerivedInner']

      derived(inner: symbol, marker: object) {
        const extended = this.ctx.extend({ marker })
        const isolated = this.ctx.isolate('callerDerivedInner', inner)
        return {
          extended: read<InnerService>(extended, 'callerDerivedInner'),
          isolated: read<InnerService>(isolated, 'callerDerivedInner'),
        }
      }
    }

    const removeProviderDependency = app.provide(
      'callerDerivedDependency',
      providerDependency,
    )
    const removeCallerDependency = callerScope.provide(
      'callerDerivedDependency',
      callerDependency,
    )
    const innerProvider = providerScope.installComponent(InnerService)
    await innerProvider
    const outerProvider = providerScope.installComponent(OuterService)
    await outerProvider

    const removeOriginalListener = callerScope.on(
      'caller/derived-service-event',
      value => originalEvents.push(value),
    )
    const removeSharedListener = providerScope.on(
      'caller/derived-service-event',
      value => sharedEvents.push(value),
    )
    const removeWrongListener = wrongInnerScope.on(
      'caller/derived-service-event',
      value => wrongEvents.push(value),
    )

    let extendedInner!: InnerService
    let isolatedInner!: InnerService
    let callerSnapshot!: Dependency
    const consumer = callerScope.installComponent({
      inject: ['callerDerivedOuter', 'callerDerivedDependency'],
      apply(context) {
        callerSnapshot = read<Dependency>(
          context,
          'callerDerivedDependency',
        )
        const result = read<OuterService>(context, 'callerDerivedOuter')
          .derived(innerLabel, marker)
        extendedInner = result.extended
        isolatedInner = result.isolated
      },
    })
    await consumer

    expect(callerSnapshot).toBe(callerDependency)
    expect(extendedInner).not.toBe(isolatedInner)
    expect(extendedInner.marker()).toBe(marker)
    expect(extendedInner.dependency()).toBe(providerDependency)
    expect(isolatedInner.dependency()).toBe(providerDependency)

    extendedInner.publish('extended')
    isolatedInner.publish('isolated')
    expect(originalEvents).toEqual(['extended'])
    expect(sharedEvents).toEqual(['isolated'])
    expect(wrongEvents).toEqual([])

    await consumer.dispose()
    await outerProvider.dispose()
    await innerProvider.dispose()
    await Promise.all([
      removeWrongListener(),
      removeSharedListener(),
      removeOriginalListener(),
      removeCallerDependency(),
      removeProviderDependency(),
    ])
  })

  it('keeps Root Service dependencies live and resets their registrations', async () => {
    const app = new Context()
    const firstDependency = { id: 1 }
    const secondDependency = { id: 2 }
    const cleanupDependencies: unknown[] = []

    class RootService extends Service {
      static provide = 'callerRootService'

      dependency() {
        return this.ctx.get('callerRootDependency')
      }
    }

    const removeFirst = app.provide(
      'callerRootDependency',
      firstDependency,
    )
    const raw = new RootService(app)
    const caller = app.extend({ marker: 'root caller' })
    const firstFacade = read<RootService>(caller, 'callerRootService')

    expect(read<RootService>(app, 'callerRootService')).toBe(raw)
    expect(firstFacade).not.toBe(raw)
    expect(read<RootService>(caller, 'callerRootService')).toBe(firstFacade)
    expect(firstFacade.dependency()).toBe(firstDependency)

    await removeFirst()
    expect(firstFacade.dependency()).toBeUndefined()
    app.provide('callerRootDependency', secondDependency)
    expect(firstFacade.dependency()).toBe(secondDependency)
    const consumer = app.inject(['callerRootService'], (context) => {
      const service = read<RootService>(context, 'callerRootService')
      return () => {
        cleanupDependencies.push(service.dependency())
      }
    })
    await consumer

    await app.fiber.restart()
    expect(cleanupDependencies).toEqual([secondDependency])
    expect(app.get('callerRootService')).toBeUndefined()
    expect(caller.get('callerRootService')).toBeUndefined()
    expect(() => firstFacade.dependency()).toThrow('inactive context')

    const replacement = new RootService(app)
    const replacementFacade = read<RootService>(caller, 'callerRootService')
    expect(read<RootService>(app, 'callerRootService')).toBe(replacement)
    expect(Object.is(replacementFacade, firstFacade)).toBe(false)
    expect(read<RootService>(caller, 'callerRootService'))
      .toBe(replacementFacade)

    await app.fiber.restart()
  })

  it('propagates Service consumer cleanup failures through Root reset', async () => {
    const app = new Context()
    const cleanupError = new Error('root Service consumer cleanup failed')

    class RootFailureService extends Service {
      static provide = 'callerRootFailureService'
    }

    new RootFailureService(app)
    const consumer = app.inject(['callerRootFailureService'], () => {
      return () => {
        throw cleanupError
      }
    })
    await consumer

    await expect(app.fiber.restart()).rejects.toBe(cleanupError)
    expect(app.fiber.state).toBe(FiberState.ACTIVE)
    expect(consumer.state).toBe(FiberState.DISPOSED)
    expect(app.get('callerRootFailureService')).toBeUndefined()
  })

  it('propagates Service consumer cleanup failures through parent disposal', async () => {
    const app = new Context()
    const cleanupError = new Error('parent Service consumer cleanup failed')
    let child!: Fiber

    class ParentFailureService extends Service {
      static provide = 'callerParentFailureService'
    }

    const parent = app.installComponent((context) => {
      new ParentFailureService(context)
      child = context.inject(['callerParentFailureService'], () => {
        return () => {
          throw cleanupError
        }
      })
    })
    await parent
    await child

    await expect(parent.dispose()).rejects.toBe(cleanupError)
    expect(parent.state).toBe(FiberState.DISPOSED)
    expect(child.state).toBe(FiberState.DISPOSED)
    expect(app.get('callerParentFailureService')).toBeUndefined()
  })

  it('keeps concurrent asynchronous calls bound to their own callers', async () => {
    const app = new Context()
    const firstGate = deferred()
    const secondGate = deferred()

    class ConcurrentService extends Service {
      static provide = 'callerConcurrent'

      async observe(gate: Promise<void>) {
        const before = this.ctx
        await gate
        return { before, after: this.ctx }
      }
    }

    const provider = app.installComponent(ConcurrentService)
    await provider
    let firstContext!: Context
    let secondContext!: Context
    let firstFacade!: ConcurrentService
    let secondFacade!: ConcurrentService
    const firstConsumer = app.inject(['callerConcurrent'], (context) => {
      firstContext = context
      firstFacade = read<ConcurrentService>(context, 'callerConcurrent')
    })
    const secondConsumer = app.inject(['callerConcurrent'], (context) => {
      secondContext = context
      secondFacade = read<ConcurrentService>(context, 'callerConcurrent')
    })
    await Promise.all([firstConsumer, secondConsumer])

    const firstCall = firstFacade.observe(firstGate.promise)
    const secondCall = secondFacade.observe(secondGate.promise)
    let firstSettled = false
    void firstCall.then(() => {
      firstSettled = true
    })

    secondGate.resolve()
    const secondResult = await secondCall
    expect(secondResult.before).toBe(secondResult.after)
    expect(secondResult.before.root).toBe(secondContext.root)
    expect(secondResult.before.fiber).toBe(secondContext.fiber)
    expect(firstSettled).toBe(false)

    firstGate.resolve()
    const firstResult = await firstCall
    expect(firstResult.before).toBe(firstResult.after)
    expect(firstResult.before.root).toBe(firstContext.root)
    expect(firstResult.before.fiber).toBe(firstContext.fiber)

    await Promise.all([firstConsumer.dispose(), secondConsumer.dispose()])
    await provider.dispose()
  })

  it('rejects resources created after the caller has been disposed', async () => {
    const app = new Context()
    const gate = deferred()
    const cleanup = vi.fn()

    class DelayedResourceService extends Service {
      static provide = 'callerDelayedResource'

      async allocateAfter(delay: Promise<void>) {
        await delay
        this.ctx.effect(() => cleanup)
      }
    }

    const provider = app.installComponent(DelayedResourceService)
    await provider
    let facade!: DelayedResourceService
    const consumer = app.inject(['callerDelayedResource'], (context) => {
      facade = read<DelayedResourceService>(context, 'callerDelayedResource')
    })
    await consumer

    const allocating = facade.allocateAfter(gate.promise)
    await consumer.dispose()
    gate.resolve()

    await expect(allocating).rejects.toThrow('inactive context')
    expect(cleanup).not.toHaveBeenCalled()
    expect(provider.state).toBe(FiberState.ACTIVE)

    await provider.dispose()
  })

  it('binds views to extended, isolated, and installed child Contexts', async () => {
    const app = new Context()
    const callerMarker = {}
    const consumerParent = app.extend({ callerMarker })

    class ScopeService extends Service {
      static provide = 'callerScope'

      caller() {
        return this.ctx
      }

      marker() {
        return (this.ctx as Context & { callerMarker: object }).callerMarker
      }

      has(name: string) {
        return name in this.ctx
      }
    }

    const provider = app.installComponent(ScopeService)
    await provider
    let baseContext!: Context
    let extendedContext!: Context
    let isolatedContext!: Context
    let childContext!: Context
    let baseFacade!: ScopeService
    let extendedFacade!: ScopeService
    let isolatedFacade!: ScopeService
    let childFacade!: ScopeService
    let child!: Fiber

    const consumer = consumerParent.installComponent({
      inject: ['callerScope'],
      apply(context) {
        baseContext = context
        extendedContext = context.extend()
        isolatedContext = context.isolate(
          'callerUnrelated',
          Symbol('unrelated label'),
        )
        isolatedContext.provide('callerUnrelated', true)
        baseFacade = read<ScopeService>(baseContext, 'callerScope')
        extendedFacade = read<ScopeService>(extendedContext, 'callerScope')
        isolatedFacade = read<ScopeService>(isolatedContext, 'callerScope')
        child = isolatedContext.installComponent({
          inject: ['callerScope'],
          apply(context) {
            childContext = context
            childFacade = read<ScopeService>(context, 'callerScope')
          },
        })
      },
    })
    await consumer
    await child

    const pairs: Array<[ScopeService, Context]> = [
      [baseFacade, baseContext],
      [extendedFacade, extendedContext],
      [isolatedFacade, isolatedContext],
      [childFacade, childContext],
    ]
    for (const [facade, callerContext] of pairs) {
      const serviceContext = facade.caller()
      expect(serviceContext).not.toBe(callerContext)
      expect(serviceContext.root).toBe(callerContext.root)
      expect(serviceContext.fiber).toBe(callerContext.fiber)
      expect(facade.marker()).toBe(callerMarker)
    }
    expect(baseFacade.has('callerUnrelated')).toBe(false)
    expect(extendedFacade.has('callerUnrelated')).toBe(false)
    expect(isolatedFacade.has('callerUnrelated')).toBe(false)
    expect(childFacade.has('callerUnrelated')).toBe(false)
    expect(read<ScopeService>(extendedContext, 'callerScope'))
      .toBe(extendedFacade)
    expect(read<ScopeService>(isolatedContext, 'callerScope'))
      .toBe(isolatedFacade)
    expect(new Set([
      baseFacade,
      extendedFacade,
      isolatedFacade,
      childFacade,
    ]).size).toBe(4)

    await consumer.dispose()
    expect(child.state).toBe(FiberState.DISPOSED)
    await provider.dispose()
  })

  it('keeps native private fields as an explicit facade limitation', async () => {
    const app = new Context()
    let rawValue: number | undefined
    let failure: unknown

    class PrivateService extends Service {
      static provide = 'callerPrivate'
      #value = 42

      read() {
        return this.#value
      }

      [Service.init]() {
        rawValue = this.read()
      }
    }

    const provider = app.installComponent(PrivateService)
    await provider
    let facade!: PrivateService
    const consumer = app.inject(['callerPrivate'], (context) => {
      facade = read<PrivateService>(context, 'callerPrivate')
      try {
        facade.read()
      } catch (error) {
        failure = error
      }
    })
    await consumer

    expect(rawValue).toBe(42)
    expect(facade).toBeInstanceOf(PrivateService)
    expect(failure).toBeInstanceOf(TypeError)

    await consumer.dispose()
    await provider.dispose()
  })
})
