/** 本文件实现具名服务注册、依赖快照和最小 Service 类协议。 */

import type { Context } from './context.js'
import type { Disposer } from './disposable.js'
import type { Fiber } from './fiber.js'
import { FiberState } from './fiber.js'
import type { ResolvedInject } from './component.js'
import type { IsolationLabel } from './symbols.js'
import {
  contextIsolations,
  serviceCheck,
  serviceInit,
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

  /** 当前 Context 的服务地址是否已经被依赖声明或服务注册认识。 */
  has(context: Context, name: string) {
    const address = this.#resolveAddress(context, name)
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
  capture(
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
  subscribe(
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
    const slot = this.#getSlot(context, name)
    const implementation = slot.implementation

    // 提供方在自己的构造、初始化和清理代码中可以访问自己刚提供的服务。
    if (implementation?.owner === context.fiber) {
      return implementation.value
    }

    if (context.fiber.isRoot) {
      if (implementation?.owner.state !== FiberState.ACTIVE) return
      return implementation.value
    }

    return context.fiber.getInjected(name, slot.address)
  }

  #notify(slot: ServiceSlot) {
    const consumers = [...slot.consumers]
    for (const fiber of consumers) fiber.refreshDependencies()
    return consumers
  }
}

/**
 * 把 class 实例注册成服务的最小便利基类。
 * callable、extend、intercept 和调用方 Context 追踪将在空间组合阶段加入。
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

  protected [serviceCheck]?(): boolean
}
