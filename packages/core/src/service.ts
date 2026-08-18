/** 本文件实现具名服务注册、依赖快照和最小 Service 类协议。 */

import type { Context } from './context.js'
import type { Disposer } from './disposable.js'
import type { Fiber } from './fiber.js'
import { FiberState } from './fiber.js'
import type { ResolvedInject } from './inject.js'
import { serviceCheck, serviceInit } from './symbols.js'

/** 一次 `provide()` 产生的具体服务实现。每次重新提供都会获得新的 id。 */
export interface ServiceImplementation<Value = unknown> {
  readonly id: number
  readonly name: string
  readonly slot: symbol
  readonly value: Value
  readonly owner: Fiber
  readonly check?: () => boolean
}

/** 某个 Fiber 一轮运行期间固定使用的依赖实现集合。 */
export interface DependencySnapshot {
  readonly epoch: string
  readonly services: ReadonlyMap<string, ServiceImplementation>
}

/**
 * 根 Context 共享的服务注册表。
 *
 * 当前版本中，同名服务在整棵 Context 树内共享一个 slot。解析 API 已显式接收
 * Context，后续加入 isolate 时只需改变 name -> slot 的映射规则。
 */
export class ServiceRegistry {
  readonly root: Context

  #counter = 0
  #slots = new Map<string, symbol>()
  #implementations = new Map<symbol, ServiceImplementation>()
  #consumers = new Map<symbol, Set<Fiber>>()
  #owned = new Map<Fiber, Set<ServiceImplementation>>()

  constructor(root: Context) {
    this.root = root
  }

  /** 返回服务名称的当前默认 slot；Context 参数为后续隔离解析保留。 */
  #getSlot(context: Context, name: string) {
    void context
    let slot = this.#slots.get(name)
    if (!slot) {
      slot = Symbol(name)
      this.#slots.set(name, slot)
    }
    return slot
  }

  /** 某个名称是否已经被依赖声明或服务注册认识。 */
  has(name: string) {
    return this.#slots.has(name)
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
      const current = this.#implementations.get(slot)
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
        name,
        slot,
        value,
        owner: context.fiber,
        check,
      }

      this.#implementations.set(slot, implementation)
      let owned = this.#owned.get(context.fiber)
      if (!owned) {
        owned = new Set()
        this.#owned.set(context.fiber, owned)
      }
      owned.add(implementation)

      // 根 Fiber 等已经 ACTIVE 的提供方可以立即唤醒消费者；普通组件在
      // LOADING 阶段注册的服务要等到其状态真正进入 ACTIVE 后才会通知。
      if (context.fiber.state === FiberState.ACTIVE) {
        this.#notify(slot)
      }

      return async () => {
        // 只允许创建本实现的 disposer 删除本实现，避免旧 disposer 误删后继值。
        if (this.#implementations.get(slot) !== implementation) return

        this.#implementations.delete(slot)
        owned?.delete(implementation)
        if (owned?.size === 0) this.#owned.delete(context.fiber)

        const consumers = this.#notify(slot)
        await Promise.allSettled(
          consumers.map(fiber => fiber.awaitStable()),
        )
      }
    }, `ctx.provide(${JSON.stringify(name)})`)
  }

  /** 为一次组件运行捕获全部必需服务；任意一项不可用时返回 undefined。 */
  capture(context: Context, inject: ResolvedInject): DependencySnapshot | undefined {
    const services = new Map<string, ServiceImplementation>()

    for (const name of inject.keys()) {
      const slot = this.#getSlot(context, name)
      const implementation = this.#implementations.get(slot)

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
  subscribe(fiber: Fiber, inject: ResolvedInject): Disposer {
    const subscriptions: Array<[symbol, Set<Fiber>]> = []

    for (const name of inject.keys()) {
      const slot = this.#getSlot(fiber.context, name)
      let consumers = this.#consumers.get(slot)
      if (!consumers) {
        consumers = new Set()
        this.#consumers.set(slot, consumers)
      }
      consumers.add(fiber)
      subscriptions.push([slot, consumers])
    }

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true

      for (const [slot, consumers] of subscriptions) {
        consumers.delete(fiber)
        if (consumers.size === 0) this.#consumers.delete(slot)
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
    for (const implementation of owned) {
      if (this.#implementations.get(implementation.slot) === implementation) {
        this.#notify(implementation.slot)
      }
    }
  }

  /** Context Proxy 的读取入口：根读取实时值，普通 Fiber 读取本轮固定快照。 */
  get(context: Context, name: string): unknown {
    const slot = this.#getSlot(context, name)
    const implementation = this.#implementations.get(slot)

    // 提供方在自己的构造、初始化和清理代码中可以访问自己刚提供的服务。
    if (implementation?.owner === context.fiber) {
      return implementation.value
    }

    if (context.fiber.isRoot) {
      if (implementation?.owner.state !== FiberState.ACTIVE) return
      return implementation.value
    }

    return context.fiber.getInjected(name)
  }

  #notify(slot: symbol) {
    const consumers = [...this.#consumers.get(slot) ?? []]
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
