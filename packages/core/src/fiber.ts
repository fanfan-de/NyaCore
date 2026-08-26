/** 本文件实现可由动态服务依赖反复激活的组件 Fiber，并管理每轮运行的 Effect。 */

import type { Context } from './context.js'
import { DisposableStack, EffectScope } from './disposable.js'
import type { CleanupSource, Disposer } from './disposable.js'
import type { Component, ResolvedInject } from './component.js'
import type { ComponentRuntime } from './registry.js'
import type { DependencySnapshot } from './service.js'
import { serviceInit } from './symbols.js'

export enum FiberState {
  /** 组件实例存在，但当前缺少必需依赖。 */
  PENDING = 'PENDING',
  /** 正在执行组件入口，并等待启动期间的 Effect 准备完成。 */
  LOADING = 'LOADING',
  /** 当前依赖快照对应的组件运行已经稳定。 */
  ACTIVE = 'ACTIVE',
  /** 正在撤销当前一轮运行产生的全部 Effect。 */
  UNLOADING = 'UNLOADING',
  /** 当前依赖 epoch 的组件启动失败。 */
  FAILED = 'FAILED',
  /** 组件实例已永久销毁，不会再因服务变化而启动。 */
  DISPOSED = 'DISPOSED',
}

/** 管理一次组件安装，以及该实例随依赖变化产生的多轮运行。 */
export class Fiber implements PromiseLike<void> {
  readonly context: Context
  readonly parent: Fiber | null
  readonly inject: ResolvedInject

  state: FiberState
  error: unknown

  // ---------- 组件实例与安装输入 ----------

  #runtime: ComponentRuntime | null
  #config: unknown
  #detach: (() => void) | undefined

  /** start() 后建立、最终 dispose() 时撤销的服务依赖反向订阅。 */
  #unsubscribe: Disposer | undefined

  // ---------- 单轮运行与服务快照 ----------

  /** 当前一轮运行独占的 Effect 栈；依赖变化后会销毁并替换为新栈。 */
  #runEffects: DisposableStack | undefined

  /** 服务注册表最近计算出的目标快照；undefined 表示至少缺少一个依赖。 */
  #desiredSnapshot: DependencySnapshot | undefined

  /** 组件入口和清理代码当前固定使用的快照。 */
  #activeSnapshot: DependencySnapshot | undefined

  /** 同一 epoch 启动失败后不自动空转重试；依赖 epoch 改变后才重新尝试。 */
  #failedEpoch: string | undefined

  #currentScope: EffectScope | undefined
  #startupScopes: EffectScope[] | undefined

  // ---------- 生命周期任务串行化 ----------

  #currentOperation = Promise.resolve()
  #reconcileOperation: Promise<void> | undefined

  #disposeOperation: Promise<void> | undefined

  private constructor(options: {
    context: Context
    parent: Fiber | null
    runtime: ComponentRuntime | null
    inject?: ResolvedInject
    config?: unknown
    detach?: () => void
  }) {
    this.context = options.context
    this.parent = options.parent
    this.#runtime = options.runtime
    this.inject = options.inject ?? new Set()
    this.#config = options.config
    this.#detach = options.detach
    this.state = options.runtime ? FiberState.PENDING : FiberState.ACTIVE

    // 根 Fiber 本身始终是一轮可写运行；普通 Fiber 要等依赖满足后再创建栈。
    if (!options.runtime) this.#runEffects = new DisposableStack()
  }

  static root(context: Context) {
    return new Fiber({ context, parent: null, runtime: null })
  }

  static component(options: {
    context: Context
    parent: Fiber
    runtime: ComponentRuntime
    inject: ResolvedInject
    config?: unknown
    detach: () => void
  }) {
    return new Fiber(options)
  }

  get name() {
    if (this.isRoot) return '<root>'
    return this.#runtime?.name ?? 'anonymous'
  }

  get isRoot() {
    return this.#runtime === null
  }

  /** Effect 和子组件只能在根、LOADING 或 ACTIVE 的运行上下文中创建。 */
  assertActive() {
    if (this.state !== FiberState.ACTIVE && this.state !== FiberState.LOADING) {
      throw new Error('inactive context')
    }
  }

  /**
   * 挂载组件实例并开始观察依赖。无依赖组件会得到空快照并正常启动；
   * 有缺失依赖的组件保持 PENDING，直到 ServiceRegistry 发出变化通知。
   */
  start() {
    if (this.isRoot || this.#unsubscribe || this.#disposeOperation) return this

    this.#unsubscribe = this.context.root.services.subscribe(this, this.inject)
    this.refreshDependencies()
    return this
  }

  /** 服务 slot 变化时重新捕获目标快照，并让串行协调循环收敛过去。 */
  refreshDependencies() {
    if (
      this.isRoot
      || !this.#unsubscribe
      || this.#disposeOperation
      || this.state === FiberState.DISPOSED
    ) {
      return
    }

    this.#desiredSnapshot = this.context.root.services.capture(this.inject)
    this.#scheduleReconcile()
  }

  /** Context Proxy 只能从当前运行快照读取已声明的依赖。 */
  getInjected(name: string) {
    if (!this.inject.has(name)) {
      throw new Error(`cannot get service "${name}" without inject`)
    }

    const implementation = this.#activeSnapshot?.services.get(name)
    if (!implementation) {
      throw new Error(
        `cannot get required service "${name}" in inactive context`,
      )
    }

    return implementation.value
  }

  /** 创建归当前一轮运行所有的 Effect。 */
  effect(execute: () => CleanupSource, label = 'anonymous'): Disposer {
    this.assertActive()

    const effects = this.#runEffects
    if (!effects) throw new Error('inactive context')

    const scope = new EffectScope(label)
    const owner = this.#currentScope

    if (owner) {
      owner.add(scope.dispose)
    } else {
      effects.add(scope.dispose)
    }

    // 启动阶段的数组会跨 await 保持存在，因此异步入口在 await 后创建的
    // 顶层 Effect 也会被纳入本轮启动稳定性判断。
    this.#startupScopes?.push(scope)

    const previous = this.#currentScope
    this.#currentScope = scope
    try {
      scope.start(execute)
    } finally {
      this.#currentScope = previous
    }

    return scope.dispose
  }

  /** 永久销毁 Fiber；与依赖失效导致的临时 unload 不同。 */
  dispose(): Promise<void> {
    if (this.#disposeOperation) return this.#disposeOperation

    this.#desiredSnapshot = undefined
    this.#disposeOperation = this.#enqueue(() => this.#dispose())
    return this.#disposeOperation
  }

  /** 等待当前以及等待过程中被追加的生命周期转换稳定。 */
  async awaitStable(): Promise<void> {
    while (true) {
      const operation = this.#currentOperation
      try {
        await operation
      } catch (error) {
        // 旧操作失败后若已经排入了更新 epoch 的恢复操作，就继续等最新操作。
        if (operation === this.#currentOperation) throw error
        continue
      }

      // 给同一轮状态通知一个微任务机会，避免刚稳定就漏掉紧随其后的刷新。
      await Promise.resolve()
      if (operation === this.#currentOperation) return
    }
  }

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.awaitStable().then(onfulfilled, onrejected)
  }

  #enqueue(operation: () => Promise<void>) {
    const task = this.#currentOperation.catch(() => {}).then(operation)
    this.#currentOperation = task
    void task.catch(() => {})
    return task
  }

  #scheduleReconcile() {
    if (this.#reconcileOperation || this.#disposeOperation) return

    this.#reconcileOperation = this.#enqueue(async () => {
      try {
        await this.#reconcile()
      } finally {
        this.#reconcileOperation = undefined
        if (!this.#disposeOperation && !this.#isSettled()) {
          this.#scheduleReconcile()
        }
      }
    })
  }

  #isSettled() {
    if (this.#disposeOperation || this.state === FiberState.DISPOSED) return true

    const desired = this.#desiredSnapshot
    if (!desired) {
      return !this.#activeSnapshot && this.state === FiberState.PENDING
    }

    if (
      this.#failedEpoch === desired.epoch
      && this.state === FiberState.FAILED
    ) {
      return true
    }

    return this.#activeSnapshot?.epoch === desired.epoch
      && this.state === FiberState.ACTIVE
  }

  /** 收敛到最新快照：旧运行必须先卸载，缺依赖时停在 PENDING。 */
  async #reconcile() {
    while (!this.#disposeOperation) {
      const desired = this.#desiredSnapshot
      const active = this.#activeSnapshot

      if (active && active.epoch !== desired?.epoch) {
        await this.#unloadRun()
        continue
      }

      if (!desired) {
        this.#failedEpoch = undefined
        this.error = undefined
        this.#setState(FiberState.PENDING)
        return
      }

      if (active?.epoch === desired.epoch) return

      if (this.#failedEpoch === desired.epoch) {
        this.#setState(FiberState.FAILED)
        return
      }

      await this.#startRun(desired)
    }
  }

  async #startRun(snapshot: DependencySnapshot) {
    const runtime = this.#runtime
    if (!runtime || this.#disposeOperation) return

    this.#runEffects = new DisposableStack()
    this.#activeSnapshot = snapshot
    this.#setState(FiberState.LOADING)
    this.error = undefined
    this.#startupScopes = []

    try {
      this.effect(
        () => this.#invoke(runtime),
        `ctx.installComponent(${JSON.stringify(runtime.name ?? 'anonymous')})`,
      )

      for (let index = 0; index < this.#startupScopes.length; index++) {
        await this.#startupScopes[index].ready
      }
    } catch (error) {
      this.error = error
      let failure = error

      try {
        await this.#runEffects.dispose()
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          `component ${runtime.name ?? 'anonymous'} failed to start and roll back`,
        )
      }

      this.#runEffects = undefined
      this.#activeSnapshot = undefined
      this.#failedEpoch = snapshot.epoch
      this.#setState(FiberState.FAILED)
      throw failure
    } finally {
      this.#startupScopes = undefined
    }

    // 入口异步启动期间依赖可能已经失效。旧入口完成后必须直接回滚，
    // 不能短暂暴露为 ACTIVE，也不能与新入口并发。
    if (
      this.#disposeOperation
      || this.#desiredSnapshot?.epoch !== snapshot.epoch
    ) {
      await this.#unloadRun()
      return
    }

    this.#failedEpoch = undefined
    this.#setState(FiberState.ACTIVE)
  }

  /** 只撤销当前运行；保留 Fiber、Runtime 登记和依赖订阅以便再次激活。 */
  async #unloadRun() {
    if (!this.#runEffects && !this.#activeSnapshot) return

    this.#setState(FiberState.UNLOADING)
    const effects = this.#runEffects

    try {
      await effects?.dispose()
    } finally {
      // 清理函数执行期间仍能读取旧 snapshot；全部清理结束后才解除固定。
      this.#runEffects = undefined
      this.#activeSnapshot = undefined
      if (!this.#disposeOperation) this.#setState(FiberState.PENDING)
    }
  }

  async #dispose() {
    if (this.state === FiberState.DISPOSED) return

    this.#setState(FiberState.UNLOADING)

    try {
      await this.#unloadRun()
    } finally {
      this.#unsubscribe?.()
      this.#unsubscribe = undefined
      this.#desiredSnapshot = undefined
      this.#failedEpoch = undefined

      this.#detach?.()
      this.#detach = undefined

      if (this.isRoot) {
        // 根 Fiber 的 dispose 只清空整棵资源树，根 Context 之后仍可复用。
        this.#runEffects = new DisposableStack()
        this.#disposeOperation = undefined
        this.error = undefined
        this.#setState(FiberState.ACTIVE)
      } else {
        this.#setState(FiberState.DISPOSED)
      }
    }
  }

  #invoke(runtime: ComponentRuntime): CleanupSource {
    if (runtime.kind === 'function') {
      const apply = runtime.callback as Component.Function<any>
      return apply(this.context, this.#config)
    }

    const Constructor = runtime.callback as Component.Constructor<any>
    const instance = new Constructor(this.context, this.#config)
    const init = Reflect.get(instance, serviceInit)
    if (typeof init === 'function') {
      return Reflect.apply(init, instance, []) as CleanupSource
    }
  }

  #setState(state: FiberState) {
    const oldState = this.state
    if (oldState === state) return

    this.state = state
    this.context.root.services.onFiberStateChange(this, oldState, state)
  }
}
