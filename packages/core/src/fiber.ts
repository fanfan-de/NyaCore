/** 本文件实现可由动态服务依赖反复激活的组件 Fiber，并管理每轮运行的 Effect。 */

import type { Context } from './context.js'
import { DisposableStack, EffectScope } from './disposable.js'
import type { CleanupSource, Disposer } from './disposable.js'
import type { Component, ResolvedInject } from './component.js'
import type { ComponentRuntime } from './registry.js'
import type { DependencySnapshot, ServiceAddress } from './service.js'
import {
  fiberBeforeUnload,
  fiberGetServiceImplementation,
  fiberGetServiceSource,
  serviceCapture,
  serviceInit,
  serviceSubscribe,
} from './symbols.js'
import { resolveConfig } from './config.js'
import {
  consumeEffectDescriptor,
  FiberDiagnostics,
  withEffectDescriptor,
} from './diagnostics.js'
import type {
  EffectDiagnosticHandle,
  FiberDiagnosticSnapshot,
} from './diagnostics.js'
import { logRuntime } from './logger.js'
import type {
  FiberStopReason,
  LifecyclePhase,
} from './logger.js'

let fiberCounter = 0

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

/** 判断一个失败是否已经由 AggregateError 递归包含，避免重复报告同一原因。 */
function includesFailure(
  container: unknown,
  target: unknown,
  seen = new Set<AggregateError>(),
): boolean {
  if (Object.is(container, target)) return true
  if (!(container instanceof AggregateError) || seen.has(container)) {
    return false
  }

  seen.add(container)
  let errors: unknown
  try {
    errors = container.errors
  } catch {
    return false
  }
  if (!Array.isArray(errors)) return false
  return errors.some(error => includesFailure(error, target, seen))
}

/** 合并清理失败时只去掉被新错误完整包含的项，不丢失部分重叠的原因。 */
function addFailure(errors: unknown[], candidate: unknown) {
  if (errors.some(error => includesFailure(error, candidate))) return

  for (let index = errors.length - 1; index >= 0; index--) {
    if (includesFailure(candidate, errors[index])) errors.splice(index, 1)
  }
  errors.push(candidate)
}

interface BeforeUnloadHook {
  readonly invalidate: Disposer
  readonly finalize?: Disposer
  readonly path: readonly string[]
  readonly diagnostic?: EffectDiagnosticHandle
  readonly serviceName?: string
  readonly ownerFiberId?: number
  readonly sourceFiberId?: number
}

interface BeforeUnloadMetadata {
  readonly label: string
  readonly serviceName?: string
  readonly ownerFiberId?: number
  readonly sourceFiberId?: number
}

/** 管理一次组件安装，以及该实例随依赖变化产生的多轮运行。 */
export class Fiber implements PromiseLike<void> {
  /** 在当前进程内稳定且单调递增的 Fiber 身份。 */
  readonly id = ++fiberCounter
  readonly context: Context
  readonly parent: Fiber | null
  readonly inject: ResolvedInject

  state: FiberState
  stateSince = new Date().toISOString()
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

  /** 必须先于本轮任何 Effect 清理完成的内部失效工作。 */
  #beforeUnload: Set<BeforeUnloadHook> | undefined

  /** 服务注册表最近计算出的目标快照；undefined 表示至少缺少一个依赖。 */
  #desiredSnapshot: DependencySnapshot | undefined

  /** 组件入口和清理代码当前固定使用的快照。 */
  #activeSnapshot: DependencySnapshot | undefined

  /** 每次成功进入启动流程都会使用新的 run 身份，防止旧 facade 复用新快照。 */
  #runCounter = 0
  #activeRun: number | undefined
  #diagnosticRun: number | undefined

  /** 当前运行固定使用的配置版本；入口闭包持有对应的配置值。 */
  #activeConfigVersion: number | undefined

  /** 同一服务与配置目标启动失败后不空转重试；目标变化后才重新尝试。 */
  #failedTarget: string | undefined

  /** 清理失败后阻止自动通知启动新运行，直到显式 update 或 restart。 */
  #cleanupBlocked = false

  #currentScope: EffectScope | undefined
  #currentDiagnostic: EffectDiagnosticHandle | undefined
  #startupScopes: EffectScope[] | undefined

  /** 诊断状态完全旁路于真正的 DisposableStack。 */
  #diagnostics = new FiberDiagnostics()
  #pendingStopReason: FiberStopReason | undefined
  #lastCleanupReason: FiberStopReason | undefined
  #disposeReason: FiberStopReason | undefined

  // ---------- 生命周期任务串行化 ----------

  #currentOperation = Promise.resolve()
  #reconcileOperation: Promise<void> | undefined

  #disposeOperation: Promise<void> | undefined

  /** dispose() 已登记后发生的清理错误，最终在完成永久卸载后统一抛出。 */
  #disposeErrors: unknown[] | undefined

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
    if (!options.runtime) {
      this.#runEffects = new DisposableStack()
      this.#beforeUnload = new Set()
    }
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

  /** 当前活动 run；失败后保留最近失败 run 的身份，直到下一轮运行开始。 */
  get runId() {
    return this.#activeRun ?? this.#diagnosticRun
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

    this.#unsubscribe = this.context.root.services[serviceSubscribe](
      this.context,
      this,
      this.inject,
    )
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

    this.#desiredSnapshot = this.context.root.services[serviceCapture](
      this.context,
      this.inject,
    )
    this.#scheduleReconcile()
  }

  /** 包内读取当前运行快照中的实现，并强制校验捕获时的服务地址。 */
  [fiberGetServiceImplementation](
    name: string,
    address: ServiceAddress,
    snapshot: DependencySnapshot | undefined,
  ) {
    if (!this.inject.has(name)) {
      throw new Error(`cannot get service "${name}" without inject`)
    }

    const implementation = snapshot?.services.get(name)
    if (
      !implementation
      || implementation.address.name !== address.name
      || implementation.address.label !== address.label
    ) {
      throw new Error(
        `cannot get required service "${name}" in inactive context`,
      )
    }

    return implementation
  }

  /** 返回当前 Provider run 的不可伪造内部身份与固定依赖快照。 */
  [fiberGetServiceSource]() {
    return {
      run: this.#activeRun,
      snapshot: this.#activeSnapshot,
    }
  }

  /** 登记当前 run 的卸载前工作；返回函数只撤销登记，不执行回调。 */
  [fiberBeforeUnload](
    invalidate: Disposer,
    finalize?: Disposer,
    metadata: BeforeUnloadMetadata = { label: 'before-unload' },
  ): Disposer {
    this.assertActive()
    const hooks = this.#beforeUnload
    if (!hooks) throw new Error('inactive context')

    const diagnostic = this.#currentDiagnostic
    const hook = {
      invalidate,
      finalize,
      path: diagnostic?.path ?? Object.freeze([metadata.label]),
      diagnostic,
      serviceName: metadata.serviceName,
      ownerFiberId: metadata.ownerFiberId,
      sourceFiberId: metadata.sourceFiberId,
    }
    hooks.add(hook)
    let active = true
    return () => {
      if (!active) return
      active = false
      hooks.delete(hook)
    }
  }

  /** 创建归当前一轮运行所有的 Effect。 */
  effect(execute: () => CleanupSource, label = 'anonymous'): Disposer {
    this.assertActive()

    const effects = this.#runEffects
    if (!effects) throw new Error('inactive context')

    const scope = new EffectScope(label)
    const owner = this.#currentScope
    const diagnostic = this.#diagnostics.createEffect(
      consumeEffectDescriptor(this, label),
      this.#currentDiagnostic,
    )
    logRuntime(
      this.context,
      'debug',
      'effect/state',
      `effect ${label} is starting`,
      { phase: 'start', effectPath: diagnostic.path },
    )

    let disposeTask: Promise<void> | undefined
    const dispose: Disposer = () => {
      if (disposeTask) return disposeTask

      const preserveFailure = diagnostic.state === 'setup-failed'
        || diagnostic.state === 'cleanup-failed'
      if (!preserveFailure) {
        diagnostic.setState('disposing')
        logRuntime(
          this.context,
          'debug',
          'effect/state',
          `effect ${label} is disposing`,
          { phase: 'cleanup', effectPath: diagnostic.path },
        )
      }

      disposeTask = Promise.resolve(scope.dispose()).then(
        () => {
          if (!preserveFailure) {
            diagnostic.setState('disposed')
            logRuntime(
              this.context,
              'debug',
              'effect/state',
              `effect ${label} was disposed`,
              { phase: 'cleanup', effectPath: diagnostic.path },
            )
          }
        },
        (error: unknown) => {
          diagnostic.setState('cleanup-failed', error)
          if (
            this.state === FiberState.ACTIVE
            && !diagnostic.hasTransitionalAncestor()
          ) {
            const effectPaths = this.#diagnostics.failurePaths(diagnostic)
            logRuntime(
              this.context,
              'error',
              'effect/cleanup-failed',
              `effect ${label} failed to clean up`,
              {
                data: { effectPaths },
                error,
                phase: 'cleanup',
                effectPath: effectPaths[0] ?? diagnostic.path,
              },
            )
          }
          throw error
        },
      )
      void disposeTask.catch(() => {})
      return disposeTask
    }

    if (owner) {
      owner.add(dispose)
    } else {
      effects.add(dispose)
    }

    // 启动阶段的数组会跨 await 保持存在，因此异步入口在 await 后创建的
    // 顶层 Effect 也会被纳入本轮启动稳定性判断。
    this.#startupScopes?.push(scope)

    const previous = this.#currentScope
    const previousDiagnostic = this.#currentDiagnostic
    this.#currentScope = scope
    this.#currentDiagnostic = diagnostic
    let setupFailureLogged = false
    try {
      scope.start(execute)
    } catch (error) {
      diagnostic.setState('setup-failed', error)
      setupFailureLogged = true
      if (
        this.state === FiberState.ACTIVE
        && !diagnostic.hasTransitionalAncestor()
      ) {
        const effectPaths = this.#diagnostics.failurePaths(diagnostic)
        logRuntime(
          this.context,
          'error',
          'effect/setup-failed',
          `effect ${label} failed to start`,
          {
            data: { effectPaths },
            error,
            phase: 'start',
            effectPath: effectPaths[0] ?? diagnostic.path,
          },
        )
      }
      throw error
    } finally {
      this.#currentScope = previous
      this.#currentDiagnostic = previousDiagnostic
    }

    void scope.ready.then(
      () => {
        if (diagnostic.state === 'starting') {
          diagnostic.setState('active')
          logRuntime(
            this.context,
            'debug',
            'effect/state',
            `effect ${label} is active`,
            { phase: 'active', effectPath: diagnostic.path },
          )
        }
      },
      (error: unknown) => {
        diagnostic.setState('setup-failed', error)
        if (
          !setupFailureLogged
          && this.state === FiberState.ACTIVE
          && !diagnostic.hasTransitionalAncestor()
        ) {
          const effectPaths = this.#diagnostics.failurePaths(diagnostic)
          logRuntime(
            this.context,
            'error',
            'effect/setup-failed',
            `effect ${label} failed to start`,
            {
              data: { effectPaths },
              error,
              phase: 'start',
              effectPath: effectPaths[0] ?? diagnostic.path,
            },
          )
        }
      },
    )

    return dispose
  }

  /** 返回与运行时断开的冻结快照；修改快照不会反向影响 Fiber。 */
  inspect(): FiberDiagnosticSnapshot {
    return this.#diagnostics.inspect(this)
  }

  /** 校验并提交新配置，经内部 waterfall 扩展点后等待运行稳定。 */
  async update(config: unknown): Promise<void> {
    if (this.isRoot) {
      throw new Error('cannot update root fiber')
    }
    this.#assertReusable()

    let resolved: unknown
    try {
      resolved = resolveConfig(this.#runtime?.Config, config)
    } catch (error) {
      this.#recordFailure('config', error)
      throw error
    }
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
      this.#disposeReason = 'root-restart'
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

    this.#pendingStopReason = 'restart'
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

    this.#disposeReason ??= 'dispose'
    this.#desiredSnapshot = undefined
    this.#disposeErrors = []
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
        this.#recordFailure('config', this.#configError)
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
        const stopReason: FiberStopReason = active.epoch !== desired?.epoch
          ? 'dependency-change'
          : this.#pendingStopReason ?? 'config-update'
        try {
          await this.#unloadRun(stopReason)
          this.#pendingStopReason = undefined
        } catch (error) {
          this.#failCleanup(error, stopReason)
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
        if (this.state !== FiberState.FAILED) {
          this.#failCleanup(error, this.#lastCleanupReason)
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
    this.#diagnostics.beginRun()
    this.#beforeUnload = new Set()
    this.#activeSnapshot = snapshot
    this.#activeRun = ++this.#runCounter
    this.#diagnosticRun = this.#activeRun
    this.#activeConfigVersion = configVersion
    this.#setState(FiberState.LOADING)
    this.error = undefined
    this.#startupScopes = []

    try {
      const label = `ctx.installComponent(${JSON.stringify(runtime.name ?? 'anonymous')})`
      withEffectDescriptor(
        this,
        {
          type: 'component-entry',
          label,
        },
        () => this.effect(() => this.#invoke(runtime, config), label),
      )

      for (let index = 0; index < this.#startupScopes.length; index++) {
        await this.#startupScopes[index].ready
      }
    } catch (error) {
      let failure = error

      try {
        await this.#disposeRunEffects()
      } catch (cleanupError) {
        this.#cleanupBlocked = true
        if (includesFailure(error, cleanupError)) {
          failure = error
        } else if (includesFailure(cleanupError, error)) {
          failure = cleanupError
        } else {
          failure = new AggregateError(
            [error, cleanupError],
            `component ${runtime.name ?? 'anonymous'} failed to start and roll back`,
          )
        }
        this.#recordDisposeError(failure)
      }

      this.error = failure
      this.#runEffects = undefined
      this.#beforeUnload = undefined
      this.#activeSnapshot = undefined
      this.#activeRun = undefined
      this.#activeConfigVersion = undefined
      this.#failedTarget = this.#getTarget(snapshot, configVersion)
      this.#setState(FiberState.FAILED)
      this.#recordFailure('start', failure)
      this.#diagnostics.clearRun()
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
      await this.#unloadRun('stale-start')
      return
    }

    this.#failedTarget = undefined
    this.#setState(FiberState.ACTIVE)
  }

  /** 只撤销当前运行；保留 Fiber、Runtime 登记和依赖订阅以便再次激活。 */
  async #unloadRun(stopReason: FiberStopReason) {
    if (!this.#runEffects && !this.#activeSnapshot && !this.#beforeUnload) {
      return
    }

    this.#lastCleanupReason = stopReason
    this.#setState(FiberState.UNLOADING, stopReason)
    let succeeded = false
    try {
      await this.#disposeRunEffects()
      succeeded = true
    } finally {
      // 清理函数执行期间仍能读取旧 snapshot；全部清理结束后才解除固定。
      this.#runEffects = undefined
      this.#beforeUnload = undefined
      this.#activeSnapshot = undefined
      this.#activeRun = undefined
      this.#activeConfigVersion = undefined
      if (succeeded) {
        this.#diagnosticRun = undefined
        this.#diagnostics.clearRun()
      }
    }

    if (!this.#disposeOperation) {
      this.#setState(FiberState.PENDING, stopReason)
    }
  }

  async #dispose() {
    if (this.state === FiberState.DISPOSED) return

    const stopReason = this.#disposeReason ?? 'dispose'
    this.#setState(FiberState.UNLOADING, stopReason)

    let cleanupFailure: unknown
    try {
      await this.#unloadRun(stopReason)
    } catch (error) {
      cleanupFailure = error
      this.#recordDisposeError(error)
      if (this.isRoot) {
        // Root 会立刻建立一个可复用的新运行。必须在 ACTIVE 状态日志派发前
        // 冻结并清空旧树，避免同步日志订阅器创建的新 Effect 混入失败快照。
        this.#recordFailure('cleanup', error, stopReason)
        this.#diagnostics.clearRun()
      }
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
        if (!cleanupFailure) this.#diagnostics.clearRun()
        this.#beforeUnload = new Set()
        this.#disposeOperation = undefined
        this.#disposeReason = undefined
        this.error = undefined
        this.#setState(FiberState.ACTIVE, stopReason)
      } else {
        this.#setState(FiberState.DISPOSED, stopReason)
      }
    }

    if (cleanupFailure !== undefined && !this.isRoot) {
      this.#recordFailure('cleanup', cleanupFailure, stopReason)
      this.#diagnostics.clearRun()
    }

    const errors = this.#disposeErrors ?? []
    this.#disposeErrors = undefined
    if (errors.length === 0) return

    const failure = errors.length === 1
      ? errors[0]
      : new AggregateError(errors, 'multiple errors while disposing fiber')
    this.error = failure
    throw failure
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

  /** 先完成依赖失效，再清理 Effect；任一阶段失败都不跳过另一阶段。 */
  async #disposeRunEffects() {
    const errors: unknown[] = []
    const hooks = [...this.#beforeUnload ?? []]
    this.#beforeUnload?.clear()

    const invalidationResults = await Promise.allSettled(
      hooks.map(async hook => hook.invalidate()),
    )
    for (let index = 0; index < invalidationResults.length; index++) {
      const result = invalidationResults[index]
      if (result.status === 'rejected') {
        const hook = hooks[index]
        if (hook.diagnostic) {
          hook.diagnostic.recordFailure('service-invalidate', result.reason)
        } else {
          this.#diagnostics.recordDetachedFailure(
            hook.path,
            'service-invalidate',
            result.reason,
            {
              serviceName: hook.serviceName,
              ownerFiberId: hook.ownerFiberId,
              sourceFiberId: hook.sourceFiberId,
            },
          )
        }
        addFailure(errors, result.reason)
      }
    }

    // 即使消费者清理失败，也必须关闭旧 frame/slot 后再进入 Effect 清理。
    const finalizationResults = await Promise.allSettled(
      hooks.map(async hook => hook.finalize?.()),
    )
    for (let index = 0; index < finalizationResults.length; index++) {
      const result = finalizationResults[index]
      if (result.status === 'rejected') {
        const hook = hooks[index]
        if (hook.diagnostic) {
          hook.diagnostic.recordFailure('service-finalize', result.reason)
        } else {
          this.#diagnostics.recordDetachedFailure(
            hook.path,
            'service-finalize',
            result.reason,
            {
              serviceName: hook.serviceName,
              ownerFiberId: hook.ownerFiberId,
              sourceFiberId: hook.sourceFiberId,
            },
          )
        }
        addFailure(errors, result.reason)
      }
    }

    try {
      await this.#runEffects?.dispose()
    } catch (error) {
      addFailure(errors, error)
    }

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'multiple run cleanup phases failed')
    }
  }

  #setState(state: FiberState, stopReason?: FiberStopReason) {
    const oldState = this.state
    if (oldState === state) return

    this.state = state
    this.stateSince = new Date().toISOString()
    this.context.root.services.onFiberStateChange(this, oldState, state)
    const phase: LifecyclePhase = state === FiberState.LOADING
      ? 'start'
      : state === FiberState.ACTIVE
        ? 'active'
        : state === FiberState.DISPOSED
          ? 'dispose'
          : state === FiberState.UNLOADING
            ? 'cleanup'
            : stopReason
              ? 'cleanup'
              : 'active'
    logRuntime(
      this.context,
      'info',
      'fiber/state',
      `${oldState} -> ${state}`,
      {
        data: { oldState, newState: state },
        phase,
        stopReason,
      },
    )
  }

  #assertReusable() {
    if (this.#disposeOperation || this.state === FiberState.DISPOSED) {
      throw new Error('cannot update disposed fiber')
    }
  }

  #failCleanup(error: unknown, stopReason?: FiberStopReason) {
    this.error = error
    this.#cleanupBlocked = true
    this.#failedTarget = undefined
    this.#recordDisposeError(error)
    this.#setState(FiberState.FAILED, stopReason)
    this.#recordFailure('cleanup', error, stopReason)
    this.#diagnostics.clearRun()
  }

  #recordDisposeError(error: unknown) {
    this.#disposeErrors?.push(error)
  }

  #recordFailure(
    phase: Extract<LifecyclePhase, 'config' | 'start' | 'cleanup'>,
    error: unknown,
    stopReason?: FiberStopReason,
  ) {
    this.#diagnostics.captureFailure(
      this,
      phase,
      error,
      stopReason,
    )
    const effectPaths = this.#diagnostics.effectPaths()
    const code = phase === 'config'
      ? 'fiber/config-failed'
      : phase === 'start'
        ? 'fiber/start-failed'
        : 'fiber/cleanup-failed'
    const message = phase === 'config'
      ? `component ${this.name} configuration failed`
      : phase === 'start'
        ? `component ${this.name} failed to start`
        : `component ${this.name} failed to clean up`
    logRuntime(this.context, 'error', code, message, {
      data: { effectPaths },
      error,
      phase,
      stopReason,
      effectPath: effectPaths[0],
    })
  }

  async #commitConfig(config: unknown, request: number) {
    this.#assertReusable()
    if (request !== this.#updateRequest) return

    this.#config = config
    this.#configInput = undefined
    this.#hasConfigError = false
    this.#configError = undefined
    this.#pendingStopReason = 'config-update'
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
