/** 本文件管理 Component 定义身份、安装 Runtime 与只读生命周期观察。 */

import type { Context } from './context.js'
import type { Disposer } from './disposable.js'
import { Fiber, FiberState } from './fiber.js'
import type {
  Component,
  ComponentInstallOptions,
  ResolvedInject,
  ResolvedIntercept,
} from './component.js'
import {
  resolveComponent,
  resolveInject,
  resolveInjectIntercept,
} from './component.js'
import { clearServiceCallFrame } from './service.js'
import { withEffectDescriptor } from './diagnostics.js'
import {
  fiberDisposeFromOwner,
  fiberSetOwnerDisposer,
  registryNotifyFiberState,
} from './symbols.js'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { FiberStopReason } from './logger.js'

/** Registry 对外暴露的定义级 Runtime 快照。 */
export interface ComponentRuntime {
  readonly id: number
  readonly definition: Component<any>
  readonly name?: string
  readonly callback: Component.Callback<any>
  readonly kind: Component.Kind
  readonly fibers: readonly Fiber[]
  readonly Config?: StandardSchemaV1<unknown, any>
}

/** Registry 事件携带的纯观察 Runtime 快照。 */
export interface ComponentRuntimeLifecycleSnapshot {
  readonly id: number
  readonly name?: string
  readonly kind: Component.Kind
  readonly fiberIds: readonly number[]
}

/** Fiber 生命周期的不可变观察快照。 */
export interface FiberLifecycleSnapshot {
  readonly id: number
  readonly name: string
  readonly parentId: number | null
  readonly state: FiberState
  readonly stateSince: string
  readonly error: unknown
}

interface RegistryEventBase {
  readonly fiber: FiberLifecycleSnapshot
  readonly runtime: ComponentRuntimeLifecycleSnapshot
}

export type RegistryEvent =
  | (RegistryEventBase & {
    readonly type: 'snapshot'
  })
  | (RegistryEventBase & {
    readonly type: 'installed'
  })
  | (RegistryEventBase & {
    readonly type: 'state'
    readonly previousState: FiberState
    readonly stopReason?: FiberStopReason
  })
  | (RegistryEventBase & {
    readonly type: 'detached'
  })

export type RegistryListener = (event: RegistryEvent) => void

export interface RegistrySubscribeOptions {
  readonly replay?: boolean
}

/** Fiber 与 Registry 内部共享；不从 `@nya/core` 公共入口导出。 */
export interface ComponentRuntimeInternal {
  readonly id: number
  readonly definition: Component<any>
  readonly name?: string
  readonly callback: Component.Callback<any>
  readonly kind: Component.Kind
  readonly inject: ResolvedInject
  readonly intercept: ResolvedIntercept
  readonly fibers: Set<Fiber>
  readonly Config?: StandardSchemaV1<unknown, any>
}

function resolveExplicitIntercept(
  intercept?: Readonly<Record<string, unknown>>,
) {
  const result = new Map<string, unknown>()
  if (!intercept) return result

  for (const name of Object.keys(intercept)) {
    if (name.length === 0) {
      throw new TypeError(
        'invalid intercept: service names must be non-empty strings',
      )
    }
    result.set(name, intercept[name])
  }
  return result
}

/** 每棵 Root Context 独占一个 Registry。 */
export class Registry {
  #runtimeCounter = 0
  #root: Context | undefined
  #runtimes = new Map<Component<any>, ComponentRuntimeInternal>()
  #fiberRuntimes = new WeakMap<Fiber, ComponentRuntimeInternal>()
  #listeners = new Set<RegistryListener>()

  install<Definition extends Component<any>>(
    parent: Context,
    component: Definition,
    config?: Component.Config<Definition>,
    options: ComponentInstallOptions = {},
  ): Fiber {
    parent.fiber.assertActive()
    if (this.#root && this.#root !== parent.root) {
      throw new Error('cannot use one Registry across multiple Context roots')
    }
    this.#root ??= parent.root

    let runtime = this.#runtimes.get(component)
    let createdRuntime = false
    if (!runtime) {
      const definition = resolveComponent(component)
      runtime = {
        id: ++this.#runtimeCounter,
        definition: component,
        name: definition.name,
        callback: definition.callback,
        kind: definition.kind,
        inject: definition.inject,
        intercept: definition.intercept,
        fibers: new Set(),
        Config: definition.Config,
      }
      createdRuntime = true
    }

    const installInject = resolveInject(options.inject)
    const installInjectIntercept = resolveInjectIntercept(
      options.inject,
      installInject,
    )
    const explicitIntercept = resolveExplicitIntercept(options.intercept)
    const inject = new Set(runtime.inject)
    for (const name of installInject) inject.add(name)

    // Component Context 始终独立；每个覆盖继续不可变派生，保留配置层顺序。
    let context = parent.extend()
    for (const [name, label] of Object.entries(options.isolate ?? {})) {
      context = context.isolate(name, label)
    }
    for (const [name, value] of runtime.intercept) {
      context = context.intercept(name, value)
    }
    for (const [name, value] of installInjectIntercept) {
      context = context.intercept(name, value)
    }
    for (const [name, value] of explicitIntercept) {
      context = context.intercept(name, value)
    }

    // Service 方法中的 parent 可能是混合调用 Context。新组件拥有独立的
    // inject 与依赖快照，不能继续沿用 Service Provider 的调用帧。
    clearServiceCallFrame(context)
    let fiber!: Fiber
    let attached = true
    const detach = () => {
      if (!attached) return
      attached = false
      runtime!.fibers.delete(fiber)
      this.#publish(Object.freeze({
        type: 'detached',
        fiber: this.#snapshotFiber(fiber),
        runtime: this.#snapshotRuntimeLifecycle(runtime!),
      }))
      this.#fiberRuntimes.delete(fiber)
      if (runtime!.fibers.size === 0) {
        this.#runtimes.delete(runtime!.definition)
      }
    }
    fiber = Fiber.component({
      context,
      parent: parent.fiber,
      runtime,
      inject,
      config,
      detach,
    })

    // Component Context 只覆盖继承来的 Fiber，其余根级构件继续通过原型共享。
    Object.defineProperty(context, 'fiber', {
      configurable: false,
      enumerable: true,
      value: fiber,
      writable: false,
    })

    if (createdRuntime) this.#runtimes.set(component, runtime)
    runtime.fibers.add(fiber)
    this.#fiberRuntimes.set(fiber, runtime)
    this.#publish(Object.freeze({
      type: 'installed',
      fiber: this.#snapshotFiber(fiber),
      runtime: this.#snapshotRuntimeLifecycle(runtime),
    }))

    try {
      // 父 Fiber 通过一个 Effect 拥有子 Fiber，建立唯一的级联清理路径。
      const label = `ctx.installComponent(${JSON.stringify(runtime.name ?? 'anonymous')})`
      const disposeInstallation = withEffectDescriptor(
        parent.fiber,
        {
          type: 'component-install',
          label,
          childFiberId: fiber.id,
          child: fiber,
        },
        () => parent.fiber.effect(
          () => {
            fiber.start()
            return () => fiber[fiberDisposeFromOwner]()
          },
          label,
        ),
      )
      fiber[fiberSetOwnerDisposer](disposeInstallation)
    } catch (error) {
      detach()
      throw error
    }

    return fiber
  }

  /** 返回定义的只读 Runtime 快照。 */
  get<Definition extends Component<any>>(component: Definition) {
    // 保持旧 API 对无效 Component 的校验行为。
    resolveComponent(component)
    const runtime = this.#runtimes.get(component)
    return runtime ? this.#snapshotRuntime(runtime) : undefined
  }

  /** 永久销毁一个精确定义的全部安装实例，并完整聚合清理错误。 */
  async delete<Definition extends Component<any>>(component: Definition) {
    resolveComponent(component)
    const runtime = this.#runtimes.get(component)
    if (!runtime) return

    const results = await Promise.allSettled(
      [...runtime.fibers].map(fiber => fiber.dispose()),
    )
    const errors = results.flatMap(result => {
      return result.status === 'rejected' ? [result.reason] : []
    })
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'multiple component instances failed to dispose',
      )
    }
  }

  /** 订阅不可变生命周期快照；监听错误不会进入组件生命周期。 */
  subscribe(
    listener: RegistryListener,
    options: RegistrySubscribeOptions = {},
  ): Disposer {
    if (typeof listener !== 'function') {
      throw new TypeError('invalid registry listener: expected a function')
    }
    if (options.replay !== undefined && typeof options.replay !== 'boolean') {
      throw new TypeError('invalid registry replay option: expected a boolean')
    }

    this.#listeners.add(listener)
    if (options.replay) {
      const fibers = [...this.#runtimes.values()]
        .flatMap(runtime => [...runtime.fibers])
        .sort((left, right) => left.id - right.id)
      for (const fiber of fibers) {
        if (!this.#listeners.has(listener)) break
        const runtime = this.#fiberRuntimes.get(fiber)
        if (!runtime) continue
        this.#deliver(listener, Object.freeze({
          type: 'snapshot',
          fiber: this.#snapshotFiber(fiber),
          runtime: this.#snapshotRuntimeLifecycle(runtime),
        }))
      }
    }

    let active = true
    return () => {
      if (!active) return
      active = false
      this.#listeners.delete(listener)
    }
  }

  /** Fiber 状态提交后的包内通知入口。 */
  [registryNotifyFiberState](
    fiber: Fiber,
    previousState: FiberState,
    stopReason?: FiberStopReason,
  ) {
    const runtime = this.#fiberRuntimes.get(fiber)
    if (!runtime) return
    this.#publish(Object.freeze({
      type: 'state',
      fiber: this.#snapshotFiber(fiber),
      runtime: this.#snapshotRuntimeLifecycle(runtime),
      previousState,
      stopReason,
    }))
  }

  #snapshotRuntime(runtime: ComponentRuntimeInternal): ComponentRuntime {
    return Object.freeze({
      id: runtime.id,
      definition: runtime.definition,
      name: runtime.name,
      callback: runtime.callback,
      kind: runtime.kind,
      fibers: Object.freeze([...runtime.fibers]),
      Config: runtime.Config,
    })
  }

  #snapshotRuntimeLifecycle(
    runtime: ComponentRuntimeInternal,
  ): ComponentRuntimeLifecycleSnapshot {
    return Object.freeze({
      id: runtime.id,
      name: runtime.name,
      kind: runtime.kind,
      fiberIds: Object.freeze([...runtime.fibers].map(fiber => fiber.id)),
    })
  }

  #snapshotFiber(fiber: Fiber): FiberLifecycleSnapshot {
    return Object.freeze({
      id: fiber.id,
      name: fiber.name,
      parentId: fiber.parent?.id ?? null,
      state: fiber.state,
      stateSince: fiber.stateSince,
      error: fiber.error,
    })
  }

  #publish(event: RegistryEvent) {
    for (const listener of [...this.#listeners]) {
      this.#deliver(listener, event)
    }
  }

  #deliver(listener: RegistryListener, event: RegistryEvent) {
    if (!this.#listeners.has(listener)) return
    try {
      listener(event)
    } catch (error) {
      this.#listeners.delete(listener)
      this.#root?.logger.error('registry observer failed', { error })
    }
  }
}
