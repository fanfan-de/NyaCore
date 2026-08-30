/** 本文件实现具名服务注册、依赖快照和最小 Service 类协议。 */

import type { Context } from './context.js'
import type { Disposer } from './disposable.js'
import type { Fiber } from './fiber.js'
import { FiberState } from './fiber.js'
import type { ResolvedInject } from './component.js'
import { withEffectDescriptor } from './diagnostics.js'
import type { EffectDescriptor } from './diagnostics.js'
import type { IsolationLabel } from './symbols.js'
import {
  contextFilter,
  contextIsolations,
  fiberBeforeUnload,
  fiberGetServiceImplementation,
  fiberGetServiceSource,
  serviceCapture,
  serviceCheck,
  serviceContextFilter,
  serviceInit,
  serviceSubscribe,
} from './symbols.js'

/** 一个服务实现所在的严格解析地址。 */
export interface ServiceAddress {
  readonly name: string
  readonly label: IsolationLabel
}

/** 一次 `provide()` 产生的具体服务实现。每次重新提供都会获得新的 id。 */
export interface ServiceImplementation<Value = unknown> {
  readonly id: number
  readonly address: ServiceAddress
  readonly providerContext: Context
  readonly value: Value
  readonly owner: Fiber
  readonly check?: () => boolean
}

/** 某个 Fiber 一轮运行期间固定使用的依赖实现集合。 */
export interface DependencySnapshot {
  readonly epoch: string
  readonly services: ReadonlyMap<string, ServiceImplementation>
}

/** 一个服务名的全部当前状态；名称在首次使用后始终映射到同一个 slot。 */
interface ServiceSlot {
  readonly address: ServiceAddress
  readonly consumers: Set<Fiber>
  implementation?: ServiceImplementation
}

/** Service facade 中 caller 与 provider 两套语义的内部绑定。 */
interface ServiceCallFrame {
  readonly callerContext: Context
  readonly providerContext: Context
  readonly implementation: ServiceImplementation<Service>
}

/** Service 方法解析依赖时固定使用的 Provider run。Root 是实时来源。 */
interface ServiceDependencySource {
  readonly context: Context
  readonly snapshot: DependencySnapshot | undefined
  readonly run: number | undefined
}

/** 不暴露到公共实现对象上的调用绑定与跨 Fiber 生命周期状态。 */
interface ServiceImplementationState {
  source: ServiceDependencySource
  valid: boolean
  readable: boolean
  ownerDisposing: boolean
  finalized: boolean
  invalidationTask?: Promise<void>
  finalizationTask?: Promise<void>
  detachSource?: Disposer
  detachOwner?: Disposer
  disposeOwner?: Disposer
}

const serviceCallFrames = new WeakMap<Context, ServiceCallFrame>()
const serviceFacades = new WeakMap<
  ServiceImplementation,
  WeakMap<Context, Service>
>()
const serviceFacadeImplementations = new WeakMap<
  Service,
  ServiceImplementation<Service>
>()
const serviceImplementationStates = new WeakMap<
  ServiceImplementation,
  ServiceImplementationState
>()

function assertServiceFacadeReadable(implementation: ServiceImplementation) {
  if (!serviceImplementationStates.get(implementation)?.readable) {
    throw new Error('cannot access Service facade from inactive context')
  }
}

/** 只有实例自己的原始 Context 与规范地址才能安全复用 raw Service。 */
function canReuseProviderValue(
  callerContext: Context,
  implementation: ServiceImplementation,
) {
  if (implementation.providerContext !== callerContext) return false

  const value = implementation.value
  if (!(value instanceof Service)) return true
  const descriptor = Reflect.getOwnPropertyDescriptor(value, 'ctx')
  return value.name === implementation.address.name
    && !!descriptor
    && 'value' in descriptor
    && descriptor.value === callerContext
}

/** Context.extend() 保留 provider 来源，并把派生 Context 推进为新的 caller 视图。 */
export function inheritServiceCallFrame(parent: Context, child: Context) {
  const frame = serviceCallFrames.get(parent)
  if (!frame) return
  serviceCallFrames.set(child, {
    ...frame,
    callerContext: child,
  })
}

/** 安装独立组件时清除从调用方 Context 复制来的服务调用帧。 */
export function clearServiceCallFrame(context: Context) {
  serviceCallFrames.delete(context)
}

/** 只有 prototype 数据方法参与稳定绑定；实例函数字段与 getter 结果保持原值。 */
function isPrototypeMethod(
  target: Service,
  property: PropertyKey,
  value: Function,
) {
  if (Reflect.getOwnPropertyDescriptor(target, property)) return false

  let prototype = Reflect.getPrototypeOf(target)
  while (prototype) {
    const descriptor = Reflect.getOwnPropertyDescriptor(prototype, property)
    if (descriptor) {
      return 'value' in descriptor && descriptor.value === value
    }
    prototype = Reflect.getPrototypeOf(prototype)
  }
  return false
}

function bindServiceImplementation(
  callerContext: Context,
  implementation: ServiceImplementation,
) {
  const value = implementation.value
  if (!(value instanceof Service)) return value
  // 精确 Provider Context 只为实例自己的规范名称复用原对象。若同一实例
  // 另以 alias 或其他隔离地址注册，仍需 facade 携带真实地址供事件过滤。
  if (canReuseProviderValue(callerContext, implementation)) return value

  let callers = serviceFacades.get(implementation)
  if (!callers) {
    callers = new WeakMap()
    serviceFacades.set(implementation, callers)
  }

  const cached = callers.get(callerContext)
  if (cached) return cached

  const serviceContext = callerContext.extend()
  serviceCallFrames.set(serviceContext, {
    callerContext,
    providerContext: implementation.providerContext,
    implementation: implementation as ServiceImplementation<Service>,
  })

  const contextDescriptor = Reflect.getOwnPropertyDescriptor(value, 'ctx')
  if (!contextDescriptor || !contextDescriptor.configurable) {
    throw new TypeError(
      'cannot bind a Service whose Context property is not configurable',
    )
  }

  const methods = new WeakMap<Function, Function>()
  let facade!: Service
  facade = new Proxy(value, {
    get(target, property, receiver) {
      assertServiceFacadeReadable(implementation)
      if (property === 'ctx') return serviceContext

      const result = Reflect.get(target, property, receiver)
      if (
        property === 'constructor'
        || typeof result !== 'function'
        || !isPrototypeMethod(target, property, result)
      ) {
        return result
      }

      let bound = methods.get(result)
      if (!bound) {
        bound = (...args: unknown[]) => {
          assertServiceFacadeReadable(implementation)
          return Reflect.apply(result, facade, args)
        }
        methods.set(result, bound)
      }
      return bound
    },
    set(target, property, next, receiver) {
      assertServiceFacadeReadable(implementation)
      if (property === 'ctx') {
        throw new TypeError('cannot replace the Context of a Service facade')
      }
      return Reflect.set(target, property, next, receiver)
    },
    defineProperty(target, property, descriptor) {
      assertServiceFacadeReadable(implementation)
      if (property === 'ctx') {
        throw new TypeError('cannot redefine the Context of a Service facade')
      }
      return Reflect.defineProperty(target, property, descriptor)
    },
    deleteProperty(target, property) {
      assertServiceFacadeReadable(implementation)
      if (property === 'ctx') {
        throw new TypeError('cannot delete the Context of a Service facade')
      }
      return Reflect.deleteProperty(target, property)
    },
    getOwnPropertyDescriptor(target, property) {
      assertServiceFacadeReadable(implementation)
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
      if (property !== 'ctx' || !descriptor) return descriptor
      return {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        value: serviceContext,
        writable: false,
      }
    },
    has(target, property) {
      assertServiceFacadeReadable(implementation)
      return Reflect.has(target, property)
    },
    ownKeys(target) {
      assertServiceFacadeReadable(implementation)
      return Reflect.ownKeys(target)
    },
    preventExtensions() {
      assertServiceFacadeReadable(implementation)
      return false
    },
    setPrototypeOf(target, prototype) {
      assertServiceFacadeReadable(implementation)
      return Reflect.setPrototypeOf(target, prototype)
    },
  })
  serviceFacadeImplementations.set(
    facade,
    implementation as ServiceImplementation<Service>,
  )
  callers.set(callerContext, facade)
  return facade
}

/**
 * 根 Context 共享的服务注册表。
 *
 * 同名服务按 Context 解析出的隔离标签分配独立 slot。
 */
export class ServiceRegistry {
  #counter = 0
  #defaultLabels = new Map<string, IsolationLabel>()
  #slots = new Map<string, Map<IsolationLabel, ServiceSlot>>()
  #owned = new Map<Fiber, Set<ServiceSlot>>()

  /** 把一个 Context 中的服务名解析为 Root 内唯一的严格地址。 */
  #resolveAddress(context: Context, name: string): ServiceAddress {
    if (context.root.services !== this) {
      throw new Error('cannot resolve a service from another Context tree')
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('invalid service name: expected a non-empty string')
    }

    let label = context[contextIsolations][name]
    if (label === undefined) {
      label = this.#defaultLabels.get(name)
      if (!label) {
        label = Symbol(name)
        this.#defaultLabels.set(name, label)
      }
    }

    return { name, label }
  }

  /** 返回当前 Context 中服务名称对应的稳定 slot。 */
  #getSlot(context: Context, name: string) {
    const address = this.#resolveAddress(context, name)
    let labels = this.#slots.get(name)
    if (!labels) {
      labels = new Map()
      this.#slots.set(name, labels)
    }

    let slot = labels.get(address.label)
    if (!slot) {
      slot = {
        address: Object.freeze(address),
        consumers: new Set(),
      }
      labels.set(address.label, slot)
    }
    return slot
  }

  /** 把嵌套 Service 调用归一化为创建最外层实现时固定的 Provider run。 */
  #getDependencySource(context: Context): ServiceDependencySource {
    const frame = serviceCallFrames.get(context)
    if (frame) {
      const state = serviceImplementationStates.get(frame.implementation)
      if (!state?.readable) throw new Error('inactive Service call frame')
      return state.source
    }

    if (context.fiber.isRoot) {
      return { context, snapshot: undefined, run: undefined }
    }

    const source = context.fiber[fiberGetServiceSource]()
    if (source.run === undefined || source.snapshot === undefined) {
      throw new Error('inactive Service provider Context')
    }
    return { context, ...source }
  }

  /** Provider run 是否仍是创建实现时的同一轮运行。 */
  #isSourceCurrent(source: ServiceDependencySource, loading = false) {
    const fiber = source.context.fiber
    if (fiber.isRoot) return fiber.state === FiberState.ACTIVE
    if (
      fiber.state !== FiberState.ACTIVE
      && (!loading || fiber.state !== FiberState.LOADING)
    ) {
      return false
    }

    const current = fiber[fiberGetServiceSource]()
    return current.run === source.run
      && current.snapshot === source.snapshot
  }

  /** 普通消费者与 Root 实时读取只能观察仍有效的实现。 */
  #isImplementationAvailable(implementation: ServiceImplementation) {
    if (implementation.owner.state !== FiberState.ACTIVE) return false
    const state = serviceImplementationStates.get(implementation)
    return !!state?.valid && this.#isSourceCurrent(state.source)
  }

  /** source 或 owner 卸载的第一阶段：停止捕获新消费者并等待旧消费者清理。 */
  #beginInvalidation(
    slot: ServiceSlot,
    implementation: ServiceImplementation,
    state: ServiceImplementationState,
  ) {
    if (state.invalidationTask) return state.invalidationTask
    if (state.ownerDisposing) {
      return state.invalidationTask = Promise.resolve(state.disposeOwner?.())
    }

    state.valid = false
    const consumers = slot.implementation === implementation
      ? this.#notify(slot)
      : []
    const task = (async () => {
      const results = await Promise.allSettled(
        consumers.map(fiber => fiber.awaitStable()),
      )
      const errors = results.flatMap(result => {
        return result.status === 'rejected' ? [result.reason] : []
      })
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          'multiple service consumers failed to unload',
        )
      }
    })()
    state.invalidationTask = task
    void task.catch(() => {})
    return task
  }

  /** 第二阶段：所有消费者稳定后关闭 frame，并解除 slot 与两端 hook。 */
  #finalizeInvalidation(
    slot: ServiceSlot,
    implementation: ServiceImplementation,
    state: ServiceImplementationState,
  ) {
    if (state.finalizationTask) return state.finalizationTask

    const task = (async () => {
      await state.invalidationTask?.catch(() => {})
      if (state.finalized) return

      state.finalized = true
      state.readable = false
      if (state.source.snapshot !== undefined) {
        state.source = {
          context: state.source.context,
          snapshot: undefined,
          run: state.source.run,
        }
      }

      const crossOwner = implementation.owner !== state.source.context.fiber
      if (crossOwner || state.ownerDisposing) {
        this.#removeImplementation(slot, implementation, false)
      }
      await state.detachSource?.()
      await state.detachOwner?.()

      // 跨所有者注册不会随来源 Fiber 自动清理；关闭 slot 后主动结束
      // caller-owned 注册 Effect，释放闭包但不清理 caller 的其他资源。
      if (crossOwner && !state.ownerDisposing) {
        await state.disposeOwner?.()
      }
    })()
    state.finalizationTask = task
    void task.catch(() => {})
    return task
  }

  /** 按实现身份移除 slot，并从 owner 反向索引解除，不误删后继实现。 */
  #removeImplementation(
    slot: ServiceSlot,
    implementation: ServiceImplementation,
    notify = true,
  ) {
    if (slot.implementation !== implementation) return []

    slot.implementation = undefined
    const owned = this.#owned.get(implementation.owner)
    owned?.delete(slot)
    if (owned?.size === 0) this.#owned.delete(implementation.owner)
    return notify ? this.#notify(slot) : []
  }

  /** 当前 Context 的服务地址是否已经被依赖声明或服务注册认识。 */
  has(context: Context, name: string) {
    const frame = serviceCallFrames.get(context)
    if (frame && !serviceImplementationStates.get(frame.implementation)?.readable) {
      return false
    }
    const source = frame
      ? serviceImplementationStates.get(frame.implementation)?.source.context
      : context
    if (!source) throw new Error('invalid Service call frame')
    const address = this.#resolveAddress(source, name)
    return this.#slots.get(name)?.has(address.label) ?? false
  }

  /**
   * 注册服务，并把注册行为放入提供方 Fiber 当前运行的 Effect 树。
   * 返回的 disposer 可主动移除服务，同时仍然保证幂等。
   */
  provide<Value>(
    context: Context,
    name: string,
    value: Value,
    check?: () => boolean,
  ): Disposer {
    if (!name) {
      throw new TypeError('invalid service name: expected a non-empty string')
    }

    let state: ServiceImplementationState | undefined
    let registeredSlot: ServiceSlot | undefined
    let registeredImplementation: ServiceImplementation<Value> | undefined
    const label = `ctx.provide(${JSON.stringify(name)})`
    const descriptor: EffectDescriptor = {
      type: 'service-provider',
      label,
      serviceName: name,
      ownerFiberId: context.fiber.id,
    }
    const disposeOwner = withEffectDescriptor(
      context.fiber,
      descriptor,
      () => context.fiber.effect(() => {
      const slot = this.#getSlot(context, name)
      registeredSlot = slot
      const current = slot.implementation
      if (current) {
        const owner = current.owner.name === '<root>'
          ? '<root>'
          : `<${current.owner.name}>`
        throw new Error(
          `service "${name}" has been registered at ${owner}`,
        )
      }

      const implementation: ServiceImplementation<Value> = {
        id: ++this.#counter,
        address: slot.address,
        providerContext: context,
        value,
        owner: context.fiber,
        check,
      }
      registeredImplementation = implementation
      descriptor.implementationId = implementation.id
      const source = this.#getDependencySource(context)
      descriptor.sourceFiberId = source.context.fiber.id
      if (!this.#isSourceCurrent(source, true)) {
        throw new Error('inactive Service provider Context')
      }
      state = {
        source,
        valid: true,
        readable: true,
        ownerDisposing: false,
        finalized: false,
      }
      serviceImplementationStates.set(implementation, state)

      // source 与实际 owner 都保存同一两阶段 barrier。任一端先卸载都会
      // 等待消费者，另一端并发卸载时复用同一任务，不依赖 Effect LIFO。
      const invalidate = () => this.#beginInvalidation(
        slot,
        implementation,
        state!,
      )
      const finalize = () => this.#finalizeInvalidation(
        slot,
        implementation,
        state!,
      )
      const hookMetadata = {
        label,
        serviceName: name,
        ownerFiberId: context.fiber.id,
        sourceFiberId: source.context.fiber.id,
      }
      state.detachSource = source.context.fiber[fiberBeforeUnload](
        invalidate,
        finalize,
        hookMetadata,
      )
      if (source.context.fiber !== context.fiber) {
        try {
          state.detachOwner = context.fiber[fiberBeforeUnload](
            invalidate,
            finalize,
            hookMetadata,
          )
        } catch (error) {
          state.detachSource()
          throw error
        }
      }

      slot.implementation = implementation
      let owned = this.#owned.get(context.fiber)
      if (!owned) {
        owned = new Set()
        this.#owned.set(context.fiber, owned)
      }
      owned.add(slot)

      // 根 Fiber 等已经 ACTIVE 的提供方可以立即唤醒消费者；普通组件在
      // LOADING 阶段注册的服务要等到其状态真正进入 ACTIVE 后才会通知。
      if (context.fiber.state === FiberState.ACTIVE) {
        this.#notify(slot)
      }

      return async () => {
        state!.ownerDisposing = true
        // 两阶段失效已接管时，内部 Effect disposer 不能反向等待当前 Fiber
        // 的 barrier；公开句柄会在外层统一 join invalidation 与 finalize。
        if (state!.invalidationTask) {
          if (state!.finalized) {
            this.#removeImplementation(slot, implementation, false)
          }
          return
        }

        state!.valid = false

        const consumers = this.#removeImplementation(
          slot,
          implementation,
          true,
        )
        const results = await Promise.allSettled(
          consumers.map(fiber => fiber.awaitStable()),
        )

        state!.readable = false
        state!.finalized = true
        if (state!.source.snapshot !== undefined) {
          state!.source = {
            context: state!.source.context,
            snapshot: undefined,
            run: state!.source.run,
          }
        }
        // 消费者完全退出后才撤销两端 hook；并发 source/owner 卸载时
        // beginInvalidation 会等待当前 disposeOwner。
        await state!.detachSource?.()
        await state!.detachOwner?.()

        const errors = results.flatMap(result => {
          return result.status === 'rejected' ? [result.reason] : []
        })
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) {
          throw new AggregateError(
            errors,
            'multiple service consumers failed to unload',
          )
        }
      }
      }, label),
    )
    if (state) state.disposeOwner = disposeOwner

    // 内部 Effect disposer 需要避免 finalizer 自等待；公开句柄仍保持普通
    // provide() 的完成语义：消费者稳定、slot 释放且错误完整传播后才结束。
    let publicDisposeTask: Promise<void> | undefined
    return () => {
      if (publicDisposeTask) return publicDisposeTask

      publicDisposeTask = (async () => {
        const noFailure = Symbol('no failure')
        let ownerFailure: unknown = noFailure
        let invalidationFailure: unknown = noFailure
        let finalizationFailure: unknown = noFailure

        try {
          await disposeOwner()
        } catch (error) {
          ownerFailure = error
        }

        try {
          await state?.invalidationTask
        } catch (error) {
          invalidationFailure = error
        }

        if (state && registeredSlot && registeredImplementation) {
          try {
            await this.#finalizeInvalidation(
              registeredSlot,
              registeredImplementation,
              state,
            )
          } catch (error) {
            finalizationFailure = error
          }
        }

        const failures: unknown[] = []
        for (const failure of [
          ownerFailure,
          invalidationFailure,
          finalizationFailure,
        ]) {
          if (
            failure !== noFailure
            && !failures.some(current => Object.is(current, failure))
          ) {
            failures.push(failure)
          }
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            'service removal phases failed',
          )
        }
      })()
      void publicDisposeTask.catch(() => {})
      return publicDisposeTask
    }
  }

  /** 为一次组件运行捕获全部必需服务；任意一项不可用时返回 undefined。 */
  [serviceCapture](
    context: Context,
    inject: ResolvedInject,
  ): DependencySnapshot | undefined {
    const services = new Map<string, ServiceImplementation>()

    for (const name of inject) {
      const implementation = this.#getSlot(context, name).implementation

      if (!implementation || !this.#isImplementationAvailable(implementation)) {
        return
      }

      if (implementation.check) {
        try {
          if (!implementation.check.call(implementation.value)) return
        } catch {
          return
        }
      }

      services.set(name, implementation)
    }

    return {
      epoch: JSON.stringify(
        [...services].map(([name, implementation]) => [name, implementation.id]),
      ),
      services,
    }
  }

  /** 把 Fiber 加入所有依赖 slot 的反向索引，永久卸载时由返回函数取消。 */
  [serviceSubscribe](
    context: Context,
    fiber: Fiber,
    inject: ResolvedInject,
  ): Disposer {
    const subscriptions: ServiceSlot[] = []

    for (const name of inject) {
      const slot = this.#getSlot(context, name)
      slot.consumers.add(fiber)
      subscriptions.push(slot)
    }

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true

      for (const slot of subscriptions) {
        slot.consumers.delete(fiber)
      }
    }
  }

  /** Provider 跨越 ACTIVE 边界时，其拥有的全部服务都要重新检查依赖。 */
  onFiberStateChange(fiber: Fiber, oldState: FiberState, newState: FiberState) {
    if (
      (oldState === FiberState.ACTIVE)
      === (newState === FiberState.ACTIVE)
    ) {
      return
    }

    const owned = this.#owned.get(fiber)
    if (!owned) return
    for (const slot of owned) {
      if (slot.implementation?.owner === fiber) {
        this.#notify(slot)
      }
    }
  }

  /** Context Proxy 的读取入口：根读取实时值，普通 Fiber 读取本轮固定快照。 */
  get(context: Context, name: string): unknown {
    const frame = serviceCallFrames.get(context)
    if (frame) {
      const state = serviceImplementationStates.get(frame.implementation)
      if (!state?.readable) {
        throw new Error(
          `cannot get required service "${name}" in inactive context`,
        )
      }
      const source = state.source
      let implementation: ServiceImplementation | undefined

      if (source.context.fiber.isRoot) {
        implementation = this.#getSlot(source.context, name).implementation
        if (
          implementation
          && !this.#isImplementationAvailable(implementation)
          && !(
            source.context.fiber.state === FiberState.UNLOADING
            && serviceImplementationStates.get(implementation)?.readable
          )
        ) {
          return
        }
      } else {
        implementation = source.context.fiber[fiberGetServiceImplementation](
          name,
          this.#resolveAddress(source.context, name),
          source.snapshot,
        )
      }

      return implementation
        ? bindServiceImplementation(frame.callerContext, implementation)
        : undefined
    }

    const slot = this.#getSlot(context, name)
    const implementation = slot.implementation

    // 同一 Provider Fiber 可以在构造、初始化和清理期间读取自己的服务。
    // 精确提供 Context 复用原实例，其他派生 Context 仍获得独立 caller facade。
    if (implementation?.owner === context.fiber) {
      if (canReuseProviderValue(context, implementation)) {
        return implementation.value
      }
      if (!serviceImplementationStates.get(implementation)?.valid) return
      return bindServiceImplementation(context, implementation)
    }

    if (context.fiber.isRoot) {
      if (!implementation || !this.#isImplementationAvailable(implementation)) {
        return
      }
      return bindServiceImplementation(context, implementation)
    }

    const { snapshot } = context.fiber[fiberGetServiceSource]()
    return bindServiceImplementation(
      context,
      context.fiber[fiberGetServiceImplementation](
        name,
        slot.address,
        snapshot,
      ),
    )
  }

  /** Service 事件只对同一 Root、同一调用方服务地址中的监听器可见。 */
  [serviceContextFilter](source: Context, target: Context, name: string) {
    if (source.root.services !== this || target.root.services !== this) {
      return false
    }

    const sourceAddress = this.#resolveAddress(source, name)
    const targetAddress = this.#resolveAddress(target, name)
    return sourceAddress.label === targetAddress.label
  }

  #notify(slot: ServiceSlot) {
    const consumers = [...slot.consumers]
    for (const fiber of consumers) fiber.refreshDependencies()
    return consumers
  }
}

/**
 * 把 class 实例注册成服务，并让消费者通过绑定调用方 Context 的 facade 使用它。
 * callable、extend、intercept 和 mixin 仍属于后续协议。
 */
export abstract class Service {
  static readonly init: typeof serviceInit = serviceInit
  static readonly check: typeof serviceCheck = serviceCheck
  static provide?: string

  readonly name: string

  constructor(protected readonly ctx: Context, name?: string) {
    name ??= (this.constructor as typeof Service).provide
    if (!name) {
      throw new TypeError('service name is required')
    }

    this.name = name
    const check = this[serviceCheck]
    ctx.services.provide(
      ctx,
      name,
      this,
      typeof check === 'function' ? () => check.call(this) : undefined,
    )
  }

  /** 事件范围跟随 facade 的调用方 Context，而不是底层 Provider 地址。 */
  [contextFilter](context: Context) {
    const implementation = serviceFacadeImplementations.get(this)
    return this.ctx.root.services[serviceContextFilter](
      this.ctx,
      context,
      implementation?.address.name ?? this.name,
    )
  }

  protected [serviceCheck]?(): boolean
}
