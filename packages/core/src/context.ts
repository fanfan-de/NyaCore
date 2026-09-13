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
import type { Component, ComponentInstallOptions, Inject } from './component.js'
import { Registry } from './registry.js'
import { inheritServiceCallFrame, ServiceRegistry } from './service.js'
import type { IsolationLabel } from './symbols.js'
import { getContextLogger } from './logger.js'
import type { Logger } from './logger.js'
import {
  contextFilter,
  contextIntercepts,
  contextIsolations,
  contextMarker,
  serviceConfig,
} from './symbols.js'

const protectedProperties = new Set<PropertyKey>([
  contextMarker,
  contextIntercepts,
  contextIsolations,
  'fiber',
  'events',
  'registry',
  'root',
  'services',
  'logger',
])

const reservedProperties = new Set(['prototype', 'then'])
const contextProxies = new WeakMap<Context, Context>()

function isSpecialProperty(property: string) {
  return reservedProperties.has(property)
    || /^(0|[1-9]\d*)$/.test(property)
    || property.startsWith('_')
}

/** 只查真实属性描述符，避免父 Context Proxy 的 has trap 将服务误判为自身属性。 */
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
  /** @internal Context 派生使用的隔离地址映射。 */
  readonly [contextIsolations]!: Readonly<
    Record<string, IsolationLabel | undefined>
  >
  /** @internal Context 派生使用的调用配置映射。 */
  readonly [contextIntercepts]!: Readonly<Record<string, unknown>>
  readonly root: this
  readonly fiber: Fiber
  readonly events: EventRegistry
  readonly registry: Registry
  readonly services: ServiceRegistry

  /** 绑定当前调用方 Fiber、写入当前 Root 全局日志流的结构化 Logger。 */
  get logger(): Logger {
    return getContextLogger(this)
  }

  /** 创建一棵独立运行时树的根 Context；子 Context 统一通过 `extend()` 派生。 */
  constructor() {
    const proxy = new Proxy(this, contextProxyHandler) as this
    contextProxies.set(this, proxy)

    Object.defineProperty(this, contextIsolations, {
      configurable: false,
      enumerable: false,
      value: Object.freeze(Object.create(null) as Record<string, IsolationLabel>),
      writable: false,
    })
    Object.defineProperty(this, contextIntercepts, {
      configurable: false,
      enumerable: false,
      value: Object.freeze(Object.create(null) as Record<string, unknown>),
      writable: false,
    })

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
    const child = Object.create(this)

    if (extension) {
      for (const property of Reflect.ownKeys(extension)) {
        if (protectedProperties.has(property)) {
          throw new TypeError(`cannot override Context.${String(property)}`)
        }
      }

      Object.defineProperties(child, Object.getOwnPropertyDescriptors(extension))
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

  /** 为一个 Service 派生调用配置；配置按调用方 Context 解析。 */
  intercept<Key extends string & keyof this>(
    name: Key,
    config: this[Key] extends { readonly [serviceConfig]: infer Config }
      ? Config
      : unknown,
  ): this
  intercept(name: string, config: unknown): this
  intercept(name: string, config: unknown): this {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('invalid service name: expected a non-empty string')
    }

    const context = this.extend()
    const intercepts = Object.create(this[contextIntercepts]) as Record<
      string,
      unknown
    >
    Object.defineProperty(intercepts, name, {
      configurable: false,
      enumerable: true,
      value: config,
      writable: false,
    })
    Object.freeze(intercepts)
    Object.defineProperty(context, contextIntercepts, {
      configurable: false,
      enumerable: false,
      value: intercepts,
      writable: false,
    })
    return context
  }

  installComponent<Definition extends Component<any>>(
    component: Definition,
    config?: Component.Config<Definition>,
    options?: ComponentInstallOptions,
  ) {
    return this.registry.install(this, component, config, options)
  }

  /** 把一个回调安装成只在指定服务齐备时运行的轻量组件。 */
  inject(dependencies: Inject, callback: Component.Function<void>) {
    return this.installComponent({ name: callback.name, inject: dependencies, apply: callback })
  }

  /** 立即创建归当前 Fiber 所有的 Effect，返回可提前调用的幂等清理函数。 */
  effect(setup: () => CleanupSource, label?: string): Disposer {
    return this.fiber.effect(setup, label)
  }

  /** 注册跟随当前 Fiber 生命周期自动清理的事件监听器。 */
  on<Name extends EventName>(
    name: Name,
    listener: EventListener<Name>,
    options?: boolean | EventOptions,
  ): Disposer {
    return this.root.events.on(this, name, listener as (...args: any[]) => any, options)
  }

  /** 注册首次调用前自动移除的事件监听器。 */
  once<Name extends EventName>(
    name: Name,
    listener: EventListener<Name>,
    options?: boolean | EventOptions,
  ): Disposer {
    return this.root.events.once(this, name, listener as (...args: any[]) => any, options)
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
