/** 本文件实现具名服务注册、依赖快照和最小 Service 类协议。 */

import type { Context } from './context.js'
import type { Disposer } from './disposable.js'
import type { Fiber } from './fiber.js'
import { FiberState } from './fiber.js'
import type { ResolvedInject } from './component.js'
import type { IsolationLabel } from './symbols.js'
import {
  contextFilter,
  contextIsolations,
  fiberGetServiceImplementation,
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

const serviceCallFrames = new WeakMap<Context, ServiceCallFrame>()
const serviceFacades = new WeakMap<
  ServiceImplementation,
  WeakMap<Context, Service>
>()
const serviceFacadeImplementations = new WeakMap<
  Service,
  ServiceImplementation<Service>
>()

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
  if (implementation.providerContext === callerContext) return value

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
        bound = (...args: unknown[]) => Reflect.apply(result, facade, args)
        methods.set(result, bound)
      }
      return bound
    },
    set(target, property, next, receiver) {
      if (property === 'ctx') {
        throw new TypeError('cannot replace the Context of a Service facade')
      }
      return Reflect.set(target, property, next, receiver)
    },
    defineProperty(target, property, descriptor) {
      if (property === 'ctx') {
        throw new TypeError('cannot redefine the Context of a Service facade')
      }
      return Reflect.defineProperty(target, property, descriptor)
    },
    deleteProperty(target, property) {
      if (property === 'ctx') {
        throw new TypeError('cannot delete the Context of a Service facade')
      }
      return Reflect.deleteProperty(target, property)
    },
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
      if (property !== 'ctx' || !descriptor) return descriptor
      return {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        value: serviceContext,
        writable: false,
      }
    },
    preventExtensions() {
      return false
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

  /** 解开嵌套 Service 调用 Context，找到最终负责依赖权限与快照的 Context。 */
  #getDependencyContext(
    context: Context,
    seen = new Set<Context>(),
  ): Context {
    const frame = serviceCallFrames.get(context)
    if (!frame) return context
    if (seen.has(context)) {
      throw new Error('cyclic Service provider Context')
    }

    seen.add(context)
    return this.#getDependencyContext(frame.providerContext, seen)
  }

  /** 当前 Context 的服务地址是否已经被依赖声明或服务注册认识。 */
  has(context: Context, name: string) {
    const frame = serviceCallFrames.get(context)
    const source = frame
      ? this.#getDependencyContext(frame.providerContext)
      : context
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

    return context.fiber.effect(() => {
      const slot = this.#getSlot(context, name)
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
        // 只允许创建本实现的 disposer 删除本实现，避免旧 disposer 误删后继值。
        if (slot.implementation !== implementation) return

        slot.implementation = undefined
        owned?.delete(slot)
        if (owned?.size === 0) this.#owned.delete(context.fiber)

        const consumers = this.#notify(slot)
        await Promise.allSettled(
          consumers.map(fiber => fiber.awaitStable()),
        )
      }
    }, `ctx.provide(${JSON.stringify(name)})`)
  }

  /** 为一次组件运行捕获全部必需服务；任意一项不可用时返回 undefined。 */
  [serviceCapture](
    context: Context,
    inject: ResolvedInject,
  ): DependencySnapshot | undefined {
    const services = new Map<string, ServiceImplementation>()

    for (const name of inject) {
      const implementation = this.#getSlot(context, name).implementation

      if (!implementation || implementation.owner.state !== FiberState.ACTIVE) {
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
      const provider = this.#getDependencyContext(frame.providerContext)
      let implementation: ServiceImplementation | undefined

      if (provider.fiber.isRoot) {
        implementation = this.#getSlot(provider, name).implementation
        if (implementation?.owner.state !== FiberState.ACTIVE) return
      } else {
        implementation = provider.fiber[fiberGetServiceImplementation](
          name,
          this.#resolveAddress(provider, name),
        )
      }

      return implementation
        ? bindServiceImplementation(frame.callerContext, implementation)
        : undefined
    }

    const slot = this.#getSlot(context, name)
    const implementation = slot.implementation

    // 提供方在自己的构造、初始化和清理代码中可以访问自己刚提供的服务。
    if (implementation?.providerContext === context) {
      return implementation.value
    }

    if (context.fiber.isRoot) {
      if (implementation?.owner.state !== FiberState.ACTIVE) return
      return bindServiceImplementation(context, implementation)
    }

    return bindServiceImplementation(
      context,
      context.fiber[fiberGetServiceImplementation](name, slot.address),
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
