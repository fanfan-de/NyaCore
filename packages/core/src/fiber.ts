/** 本文件实现可由动态服务依赖反复激活的组件 Fiber，并管理每轮运行的 Effect。 */

import type { Context } from './context.js'
import { DisposableStack, EffectScope } from './disposable.js'
import type { CleanupSource, Disposer } from './disposable.js'
import type { Component, ResolvedInject } from './component.js'
import type { ComponentRuntime } from './registry.js'
import type { DependencySnapshot } from './service.js'
import { serviceInit } from './symbols.js'
import { resolveConfig } from './config.js'

export enum FiberState {
  /** 组件实例存在，但当前缺少必需依赖。 */
  PENDING = 'PENDING',
  /** 正在执行组件入口，并等待启动期间的 Effect 准备完成。 */
  LOADING = 'LOADING',
  /** 当前依赖快照对应的组件运行已经稳定。 */
  ACTIVE = 'ACTIVE',
  /** 正在撤销当前一轮运行产生的全部 Effect。 */
  UNLOADING = 'UNLOADING',
  /** 当前配置与依赖目标的校验、组件启动或资源清理失败。 */
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
  #configInput: unknown
  #config: unknown
  #hasConfigError = false
  #configError: unknown
  #configVersion = 0
  #updateRequest = 0
  #latestUpdateOperation: Promise<void> = Promise.resolve()
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

  /** 当前运行固定使用的配置版本；入口闭包持有对应的配置值。 */
  #activeConfigVersion: number | undefined

  /** 同一服务与配置目标启动失败后不空转重试；目标变化后才重新尝试。 */
  #failedTarget: string | undefined

  /** 清理失败后阻止自动通知启动新运行，直到显式 update 或 restart。 */
  #cleanupBlocked = false

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
    this.#configInput = options.config
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

  /** 当前已经通过 Schema 校验和转换的目标配置。 */
  get config(): unknown {
    return this.#config
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
    try {
      this.#config = resolveConfig(this.#runtime?.Config, this.#configInput)
      this.#configInput = undefined
    } catch (error) {
      this.#hasConfigError = true
      this.#configError = error
      this.error = error
    }
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

  /** 校验并提交新配置，经内部 waterfall 扩展点后等待运行稳定。 */
  async update(config: unknown): Promise<void> {
    if (this.isRoot) {
      throw new Error('cannot update root fiber')
    }
    this.#assertReusable()

    const resolved = resolveConfig(this.#runtime?.Config, config)
    const request = ++this.#updateRequest
    const operation = (async () => {
      // 让同一调用栈内的连续 update() 先登记请求序号，再进入扩展链。
      await Promise.resolve()
      let commitOperation: Promise<void> | undefined
      await this.context.waterfall(
        this,
        'internal/update',
        resolved,
        () => {
          return commitOperation ??= this.#commitConfig(resolved, request)
        },
      )
      // 即使同步监听器调用 next() 时没有 return / await，update() 仍等待
      // 已经进入默认终点的配置完成生命周期收敛。
      await commitOperation
    })()
    this.#latestUpdateOperation = operation
    await operation

    // 较早的 update() 也要等调用期间出现的最新请求完成，但不继承
    // 后继请求自己的扩展链错误；该错误只由对应的 update() 暴露。
    while (operation !== this.#latestUpdateOperation) {
      const latest = this.#latestUpdateOperation
      await latest.catch(() => {})
      if (latest === this.#latestUpdateOperation) break
    }
    await this.awaitStable()
  }

  /** 使用当前配置重新建立运行；根 Fiber 则清空整棵 Effect 树。 */
  async restart(): Promise<void> {
    if (this.isRoot) {
      await this.dispose()
      return
    }
    this.#assertReusable()

    if (this.#hasConfigError) {
      try {
        this.#config = resolveConfig(
          this.#runtime?.Config,
          this.#configInput,
        )
        this.#configInput = undefined
        this.#hasConfigError = false
        this.#configError = undefined
      } catch (error) {
        this.#configError = error
        this.error = error
        this.#scheduleReconcile()
        await this.awaitStable()
        return
      }
    }

    this.#configVersion++
    this.#cleanupBlocked = false
    this.#failedTarget = undefined
    this.error = undefined
    this.#scheduleReconcile()
    await this.awaitStable()
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

    if (this.#hasConfigError) return this.state === FiberState.FAILED

    if (this.#cleanupBlocked) return this.state === FiberState.FAILED

    const desired = this.#desiredSnapshot
    if (!desired) {
      return !this.#activeSnapshot && this.state === FiberState.PENDING
    }

    if (
      this.#failedTarget === this.#getTarget(desired)
      && this.state === FiberState.FAILED
    ) {
      return true
    }

    return this.#activeSnapshot?.epoch === desired.epoch
      && this.#activeConfigVersion === this.#configVersion
      && this.state === FiberState.ACTIVE
  }

  /** 收敛到最新快照：旧运行必须先卸载，缺依赖时停在 PENDING。 */
  async #reconcile() {
    while (!this.#disposeOperation) {
      if (this.#hasConfigError) {
        this.error = this.#configError
        this.#setState(FiberState.FAILED)
        throw this.#configError
      }

      // 依赖通知只能更新 desired target，不能在资源清理失败后自行恢复。
      if (this.#cleanupBlocked) {
        this.#setState(FiberState.FAILED)
        return
      }

      const desired = this.#desiredSnapshot
      const active = this.#activeSnapshot

      if (
        active
        && (
          active.epoch !== desired?.epoch
          || this.#activeConfigVersion !== this.#configVersion
        )
      ) {
        try {
          await this.#unloadRun()
        } catch (error) {
          this.#failCleanup(error)
          throw error
        }
        continue
      }

      if (!desired) {
        this.#failedTarget = undefined
        this.error = undefined
        this.#setState(FiberState.PENDING)
        return
      }

      if (
        active?.epoch === desired.epoch
        && this.#activeConfigVersion === this.#configVersion
      ) return

      const target = this.#getTarget(desired)
      if (this.#failedTarget === target) {
        this.#setState(FiberState.FAILED)
        return
      }

      try {
        await this.#startRun(
          desired,
          this.#configVersion,
          this.#config,
        )
      } catch (error) {
        // 过期启动在内部卸载时也可能清理失败；此时不能静默启动新目标。
        if (!this.#disposeOperation && this.state !== FiberState.FAILED) {
          this.#failCleanup(error)
        }
        throw error
      }
    }
  }

  async #startRun(
    snapshot: DependencySnapshot,
    configVersion: number,
    config: unknown,
  ) {
    const runtime = this.#runtime
    if (!runtime || this.#disposeOperation) return

    this.#runEffects = new DisposableStack()
    this.#activeSnapshot = snapshot
    this.#activeConfigVersion = configVersion
    this.#setState(FiberState.LOADING)
    this.error = undefined
    this.#startupScopes = []

    try {
      this.effect(
        () => this.#invoke(runtime, config),
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
        this.#cleanupBlocked = true
        failure = new AggregateError(
          [error, cleanupError],
          `component ${runtime.name ?? 'anonymous'} failed to start and roll back`,
        )
      }

      this.#runEffects = undefined
      this.#activeSnapshot = undefined
      this.#activeConfigVersion = undefined
      this.#failedTarget = this.#getTarget(snapshot, configVersion)
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
      || this.#configVersion !== configVersion
    ) {
      await this.#unloadRun()
      return
    }

    this.#failedTarget = undefined
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
      this.#activeConfigVersion = undefined
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
      this.#failedTarget = undefined

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

  #invoke(runtime: ComponentRuntime, config: unknown): CleanupSource {
    if (runtime.kind === 'function') {
      const apply = runtime.callback as Component.Function<any>
      return apply(this.context, config)
    }

    const Constructor = runtime.callback as Component.Constructor<any>
    const instance = new Constructor(this.context, config)
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

  #assertReusable() {
    if (this.#disposeOperation || this.state === FiberState.DISPOSED) {
      throw new Error('cannot update disposed fiber')
    }
  }

  #failCleanup(error: unknown) {
    this.error = error
    this.#cleanupBlocked = true
    this.#failedTarget = undefined
    this.#setState(FiberState.FAILED)
  }

  async #commitConfig(config: unknown, request: number) {
    this.#assertReusable()
    if (request !== this.#updateRequest) return

    this.#config = config
    this.#configInput = undefined
    this.#hasConfigError = false
    this.#configError = undefined
    this.#configVersion++
    this.#cleanupBlocked = false
    this.#failedTarget = undefined
    this.error = undefined
    this.#scheduleReconcile()
    await this.awaitStable()
  }

  #getTarget(
    snapshot: DependencySnapshot,
    configVersion = this.#configVersion,
  ) {
    return `${snapshot.epoch}:${configVersion}`
  }
}
