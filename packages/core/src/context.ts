/** 本文件定义组件运行上下文，负责派生作用域，并把组件安装与 Effect 登记委托给 Registry 和 Fiber。 */

import type { CleanupSource, Disposer } from './disposable.js'
import { EventRegistry } from './events.js'
import type {
  EventListener,
  EventName,
  EventOptions,
  EventParameters,
  EventReturn,
  Events,
  EventThisArgument,
} from './events.js'
import { Fiber } from './fiber.js'
import type { Component, Inject } from './component.js'
import { Registry } from './registry.js'
import {
  inheritServiceCallFrame,
  ServiceRegistry,
} from './service.js'
import type { IsolationLabel } from './symbols.js'
import {
  contextFilter,
  contextIsolations,
  contextMarker,
} from './symbols.js'

const protectedProperties = new Set<PropertyKey>([
  contextMarker,
  contextIsolations,
  'fiber',
  'events',
  'registry',
  'root',
  'services',
])

const reservedProperties = new Set(['prototype', 'then'])
const contextProxies = new WeakMap<Context, Context>()

function isSpecialProperty(property: string) {
  return reservedProperties.has(property)
    || /^(0|[1-9]\d*)$/.test(property)
    || property.startsWith('_')
}

/**
 * 不使用 `property in target`，因为父 Context 本身也是 Proxy，其 `has` trap
 * 会把已经认识的服务名称报告为存在。这里仅检查真正的对象属性描述符。
 */
function hasDefinedProperty(target: object, property: PropertyKey) {
  let current: object | null = target
  while (current) {
    if (Reflect.getOwnPropertyDescriptor(current, property)) return true
    current = Reflect.getPrototypeOf(current)
  }
  return false
}

function isServiceProperty(
  target: object,
  property: PropertyKey,
): property is string {
  return typeof property === 'string'
    && !isSpecialProperty(property)
    && !hasDefinedProperty(target, property)
}

const contextProxyHandler: ProxyHandler<Context> = {
  get(target, property, receiver) {
    if (!isServiceProperty(target, property)) {
      return Reflect.get(target, property, receiver)
    }

    const context = receiver as Context
    return context.root.services.get(context, property)
  },

  set(target, property, value, receiver) {
    if (!isServiceProperty(target, property)) {
      return Reflect.set(target, property, value, receiver)
    }

    throw new Error(`cannot set service "${property}" without provide`)
  },

  has(target, property) {
    if (!isServiceProperty(target, property)) {
      return Reflect.has(target, property)
    }

    // Proxy 的 has trap 没有 receiver；用创建时登记的代理恢复精确 Context，
    // 让 WeakMap 中的 Service 调用帧也能参与 `name in context` 判断。
    const context = contextProxies.get(target) ?? target
    return context.root.services.has(context, property)
  },
}

export class Context {
  static readonly filter: typeof contextFilter = contextFilter

  readonly [contextMarker] = true
  readonly [contextIsolations]!: Readonly<
    Record<string, IsolationLabel | undefined>
  >
  readonly root: this
  readonly fiber: Fiber
  readonly events: EventRegistry
  readonly registry: Registry
  readonly services: ServiceRegistry

  /** 创建一棵独立运行时树的根 Context；子 Context 统一通过 `extend()` 派生。 */
  constructor() {
    // 根和派生 Context 都通过同一 handler 提供服务属性访问。root 必须指向
    // Proxy 本身，确保所有后续派生 Context 共享同一个可观察运行时根节点。
    const proxy = new Proxy(this, contextProxyHandler) as this
    contextProxies.set(this, proxy)

    Object.defineProperty(this, contextIsolations, {
      configurable: false,
      enumerable: false,
      value: Object.freeze(
        Object.create(null) as Record<string, IsolationLabel>,
      ),
      writable: false,
    })

    // Registry 和根 Fiber 通过 Context 原型链共享；
    // 组件 Context 只用本次安装对应的 Fiber 覆盖 `fiber` 属性。
    this.root = proxy
    this.services = new ServiceRegistry()
    this.registry = new Registry()
    this.fiber = Fiber.root(proxy)
    this.events = new EventRegistry(proxy)

    return proxy
  }

  static is(value: unknown): value is Context {
    return typeof value === 'object'
      && value !== null
      && contextMarker in value
  }

  extend(): this
  extend<T extends object>(extension: T): this & T
  extend(extension?: object): this {
    // 派生不会再次调用构造器；通过原型派生可以保留 getter、Symbol 和后续框架扩展，
    // 同时不需要完整复制父 Context。
    const child = Object.create(this)

    if (extension) {
      for (const property of Reflect.ownKeys(extension)) {
        if (protectedProperties.has(property)) {
          throw new TypeError(`cannot override Context.${String(property)}`)
        }
      }

      Object.defineProperties(
        child,
        Object.getOwnPropertyDescriptors(extension),
      )
    }

    const context = new Proxy(child, contextProxyHandler) as this
    contextProxies.set(child, context)
    inheritServiceCallFrame(this, context)
    return context
  }

  /** 为一个服务名派生严格隔离的解析空间；原 Context 保持不变。 */
  isolate(name: string, label?: IsolationLabel): this {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('invalid service name: expected a non-empty string')
    }
    if (label !== undefined && typeof label !== 'symbol') {
      throw new TypeError('invalid isolation label: expected a symbol')
    }

    const context = this.extend()
    const isolations = Object.create(this[contextIsolations]) as Record<
      string,
      IsolationLabel
    >
    Object.defineProperty(isolations, name, {
      configurable: false,
      enumerable: true,
      value: label ?? Symbol(name),
      writable: false,
    })
    Object.freeze(isolations)
    Object.defineProperty(context, contextIsolations, {
      configurable: false,
      enumerable: false,
      value: isolations,
      writable: false,
    })
    return context
  }

  installComponent<Definition extends Component<any>>(
    component: Definition,
    config?: Component.Config<Definition>,
  ) {
    return this.registry.install(this, component, config)
  }

  /** 把一个回调安装成只在指定服务齐备时运行的轻量组件。 */
  inject(dependencies: Inject, callback: Component.Function<void>) {
    return this.installComponent({
      name: callback.name,
      inject: dependencies,
      apply: callback,
    })
  }

  /**
   * 创建一个归当前组件 Fiber 所有的 Effect。
   *
   * `setup` 会立即执行，用于创建资源或启动带副作用的业务逻辑。
   * 它可以返回清理函数；当前组件卸载时，框架会自动调用该函数。
   *
   * @example
   * ```ts
   * context.effect(() => {
   *   const timer = setInterval(runTask, 1000)
   *
   *   return () => {
   *     clearInterval(timer)
   *   }
   * }, 'task timer')
   * ```
   *
   * @param setup 创建资源或启动副作用的函数，返回对应的清理逻辑。
   * @param label 可选的诊断名称，用于标识该 Effect。
   * @returns 幂等的清理函数，可用于在组件卸载前主动清理资源。
   */
  effect(setup: () => CleanupSource, label?: string): Disposer {
    return this.fiber.effect(setup, label)
  }

  /** 注册跟随当前 Fiber 生命周期自动清理的事件监听器。 */
  on<Name extends EventName>(
    name: Name,
    listener: EventListener<Name>,
    options?: boolean | EventOptions,
  ): Disposer {
    return this.root.events.on(
      this,
      name,
      listener as (...args: any[]) => any,
      options,
    )
  }

  /** 注册首次调用前自动移除的事件监听器。 */
  once<Name extends EventName>(
    name: Name,
    listener: EventListener<Name>,
    options?: boolean | EventOptions,
  ): Disposer {
    return this.root.events.once(
      this,
      name,
      listener as (...args: any[]) => any,
      options,
    )
  }

  emit<Name extends EventName>(
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): void
  emit<Name extends EventName>(
    thisArg: NoInfer<EventThisArgument<Events[Name]>>,
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): void
  emit(...args: unknown[]): void {
    return this.root.events.emit(...args)
  }

  parallel<Name extends EventName>(
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): Promise<void>
  parallel<Name extends EventName>(
    thisArg: NoInfer<EventThisArgument<Events[Name]>>,
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): Promise<void>
  parallel(...args: unknown[]): Promise<void> {
    return this.root.events.parallel(...args)
  }

  serial<Name extends EventName>(
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): Promise<Awaited<EventReturn<Events[Name]>> | undefined>
  serial<Name extends EventName>(
    thisArg: NoInfer<EventThisArgument<Events[Name]>>,
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): Promise<Awaited<EventReturn<Events[Name]>> | undefined>
  serial(...args: unknown[]): Promise<unknown> {
    return this.root.events.serial(...args)
  }

  bail<Name extends EventName>(
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): EventReturn<Events[Name]> | undefined
  bail<Name extends EventName>(
    thisArg: NoInfer<EventThisArgument<Events[Name]>>,
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): EventReturn<Events[Name]> | undefined
  bail(...args: unknown[]): unknown {
    return this.root.events.bail(...args)
  }

  waterfall<Name extends EventName>(
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): EventReturn<Events[Name]>
  waterfall<Name extends EventName>(
    thisArg: NoInfer<EventThisArgument<Events[Name]>>,
    name: Name,
    ...args: EventParameters<Events[Name]>
  ): EventReturn<Events[Name]>
  waterfall(...args: unknown[]): unknown {
    return this.root.events.waterfall(...args)
  }

  /** 注册一个归当前 Fiber 本轮运行所有的具名服务。 */
  provide<Key extends string & keyof this>(name: Key, value: this[Key]): Disposer
  provide(name: string, value?: unknown): Disposer
  provide(name: string, value?: unknown): Disposer {
    return this.root.services.provide(this, name, value)
  }

  /** 显式读取服务；普通组件与属性代理一样仍受 inject 快照约束。 */
  get<Key extends string & keyof this>(name: Key): this[Key] | undefined
  get(name: string): unknown
  get(name: string): unknown {
    return this.root.services.get(this, name)
  }
}
