/** 本文件定义 Effect 的清理协议，并实现幂等、后进先出的资源清理和失败回滚。 */

export type Disposer = () => void | Promise<void>

export type Cleanup = void | null | Disposer

export type CleanupSource =
  | Cleanup
  | PromiseLike<Cleanup>
  | Iterable<Cleanup>
  | AsyncIterable<Cleanup>

// 清理函数属于公开 API，因此在框架边界统一保证幂等，
// 不要求每一种资源实现自行处理重复清理。
function once(dispose: Disposer): Disposer {
  let task: Promise<void> | undefined

  return () => {
    if (task) return task

    try {
      task = Promise.resolve(dispose())
    } catch (error) {
      task = Promise.reject(error)
    }

    // 调用方可能不会等待清理函数。返回的 Promise 仍可向主动等待者暴露错误，
    // 同时挂载空拒绝处理，避免产生未处理的 Promise 拒绝。
    void task.catch(() => { })
    return task
  }
}

/**
 * 保存一组资源清理函数，并负责按照安全、确定的方式执行它们。
 *
 * 上层有两种主要用法：Fiber 用它保存顶层 Effect，EffectScope 用它保存
 * 当前 Effect 返回的清理函数以及嵌套 Effect 的清理函数。因此它只关心
 * “如何清理资源”，不关心组件当前处于哪个生命周期状态。
 */
export class DisposableStack {
  // 尚未执行的清理函数。每一项在 add() 时都会被 once() 包装，
  // 所以既可以单独提前调用，也可以稍后由整个栈统一调用，而不会重复清理。
  #disposers: Disposer[] = []

  // undefined 表示仍可登记资源；Promise 表示清理已经开始。
  // 缓存清理任务还能让多次 dispose() 调用等待同一次清理过程。
  #disposeTask: Promise<void> | undefined

  /** 清理一旦开始就视为 disposed，即使异步清理尚未结束或最终失败。 */
  get disposed() {
    return this.#disposeTask !== undefined
  }

  /**
   * 登记一个清理函数，并返回经过幂等包装的版本。
   * 栈开始清理后禁止继续登记，否则新资源可能错过本轮清理而泄漏。
   */
  add(dispose: Disposer): Disposer {
    if (this.disposed) {
      throw new Error('cannot add a disposer to a disposed stack')
    }

    const cleanup = once(dispose)
    let task: Promise<void> | undefined
    const registered: Disposer = () => {
      if (task) return task

      try {
        task = Promise.resolve(cleanup()).then(() => {
          // 主动清理成功后立即解除栈对资源闭包的强引用；失败项继续保留，
          // 让所属 Fiber 最终清理时仍能观察同一个拒绝结果。
          const index = this.#disposers.indexOf(registered)
          if (index >= 0) this.#disposers.splice(index, 1)
        })
      } catch (error) {
        task = Promise.reject(error)
      }
      void task.catch(() => {})
      return task
    }
    this.#disposers.push(registered)
    return registered
  }

  /** 启动整栈清理；重复调用时始终返回第一次创建的清理任务。 */
  dispose(): Promise<void> {
    if (this.#disposeTask) return this.#disposeTask

    // 缓存内部清理 Promise，让本次调用返回后的重复或并发调用复用同一任务。
    this.#disposeTask = this.#dispose()

    // 有些调用方会直接调用 dispose() 而不 await。这里附加空的拒绝处理
    // 只为避免未处理拒绝警告；原 Promise 仍会把错误暴露给主动 await 的调用方。
    void this.#disposeTask.catch(() => { })
    return this.#disposeTask
  }

  async #dispose() {
    const errors: unknown[] = []

    // splice(0) 先取出并清空当前栈，reverse() 再实现后进先出：
    // 登记顺序 A -> B -> C，对应的清理顺序是 C -> B -> A。
    for (const dispose of this.#disposers.splice(0).reverse()) {
      try {
        // 逐个 await 可以保证前一项真正清理结束后，才开始清理下一项。
        await dispose()
      } catch (error) {
        // 单项失败不能阻止其他独立资源继续清理，错误留到最后统一报告。
        errors.push(error)
      }
    }

    // 尽量保留单个错误本身；只有多个清理同时失败时才聚合错误。
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'multiple disposers failed')
    }
  }
}

async function collectCleanup(source: CleanupSource, stack: DisposableStack): Promise<void> {
  if (source == null) return

  if (typeof source === 'function') {
    stack.add(source)
    return
  }

  if (typeof source !== 'object') {
    throw new TypeError('invalid cleanup source: expected a disposer, promise, or iterator')
  }

  if (typeof (source as PromiseLike<Cleanup>).then === 'function') {
    await collectCleanup(await source as Cleanup, stack)
    return
  }

  if (Symbol.asyncIterator in source) {
    for await (const cleanup of source as AsyncIterable<Cleanup>) {
      await collectCleanup(cleanup, stack)
    }
    return
  }

  if (Symbol.iterator in source) {
    for (const cleanup of source as Iterable<Cleanup>) {
      await collectCleanup(cleanup, stack)
    }
    return
  }

  throw new TypeError('invalid cleanup source: expected a disposer, promise, or iterator')
}

/**
 * 管理单个 Effect 从初始化到清理的完整资源边界。
 *
 * `start()` 立即执行资源创建函数，再异步收集它返回的 CleanupSource；收集到的
 * 清理函数和同步创建的嵌套 Effect 都进入同一个后进先出栈。初始化失败时，
 * scope 会先回滚栈中已经登记的资源，再通过 `ready` 保留原始失败。
 *
 * Fiber 会在调用 `start()` 前先登记本 scope 的 `dispose`，因此即使初始化
 * 同步抛错，这个 Effect 也始终处于其 owner 的清理树中。
 */
export class EffectScope {
  readonly label: string
  readonly dispose: Disposer
  ready: Promise<void> = Promise.resolve()
  #stack = new DisposableStack()
  #started = false

  constructor(label = 'anonymous') {
    this.label = label
    this.dispose = once(async () => {
      await this.ready.catch(() => { })
      await this.#stack.dispose()
    })
  }

  add(dispose: Disposer) {
    return this.#stack.add(dispose)
  }

  start(execute: () => CleanupSource) {
    if (this.#started) throw new Error('effect scope has already started')
    this.#started = true

    let source: CleanupSource
    try {
      source = execute()
    } catch (error) {
      this.ready = this.#rollback(error)
      void this.ready.catch(() => { })
      throw error
    }

    // catch 返回 #rollback 的 Promise，因此 ready 只会在收集或回滚彻底结束后稳定。
    this.ready = collectCleanup(source, this.#stack).catch(error => this.#rollback(error))
    // 标记拒绝已被观察，避免调用方只使用 dispose 而未 await ready 时出现未处理拒绝；
    // 这不会改变 ready 对主动等待者的拒绝结果。
    void this.ready.catch(() => { })
  }

  async #rollback(reason: unknown): Promise<never> {
    // Effect 可能在初始化失败前已经创建了多个资源，因此必须全部回滚；
    // 如果回滚也失败，则同时保留初始化错误与清理错误。
    try {
      await this.#stack.dispose()
    } catch (cleanupError) {
      throw new AggregateError(
        [reason, cleanupError],
        'effect setup and rollback both failed',
      )
    }

    throw reason
  }
}
