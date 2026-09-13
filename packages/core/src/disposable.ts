/** 本文件定义 Effect 的清理协议，并实现幂等、后进先出的资源清理和失败回滚。 */

export type Disposer = () => void | Promise<void>

export type Cleanup = void | null | Disposer

export type CleanupSource = Cleanup | PromiseLike<Cleanup> | Iterable<Cleanup> | AsyncIterable<Cleanup>

export function once(dispose: Disposer): () => Promise<void> {
  let task: Promise<void> | undefined

  return () => {
    if (task) return task

    // 必须先缓存，再进入用户清理或日志回调；Promise executor 只登记 resolver，
    // 否则同步重入仍会发生在 task 赋值之前。
    let resolveTask!: (value: void | PromiseLike<void>) => void
    let rejectTask!: (reason: unknown) => void
    task = new Promise<void>((resolve, reject) => {
      resolveTask = resolve
      rejectTask = reject
    })
    void task.catch(() => {})
    try {
      resolveTask(dispose())
    } catch (error) {
      rejectTask(error)
    }
    return task
  }
}

/** 按 LIFO 顺序执行幂等清理，单项失败后仍清理其余资源并汇总错误。 */
export class DisposableStack {
  #disposers: Disposer[] = []
  #disposeTask: Promise<void> | undefined

  /** 清理一旦开始就视为 disposed，即使异步清理尚未结束或最终失败。 */
  get disposed() {
    return this.#disposeTask !== undefined
  }

  /** 登记一个清理函数，并返回经过幂等包装的版本。 */
  add(dispose: Disposer): Disposer {
    if (this.disposed) {
      throw new Error('cannot add a disposer to a disposed stack')
    }

    const registered = once(() => Promise.resolve(dispose()).then(() => {
      // 主动清理成功后立即解除栈对资源闭包的强引用；失败项继续保留，
      // 让所属 Fiber 最终清理时仍能观察同一个拒绝结果。
      const index = this.#disposers.indexOf(registered)
      if (index >= 0) this.#disposers.splice(index, 1)
    }))
    this.#disposers.push(registered)
    return registered
  }

  /** 启动整栈清理；重复调用时始终返回第一次创建的清理任务。 */
  dispose(): Promise<void> {
    if (this.#disposeTask) return this.#disposeTask

    // 先关闭栈再进入 cleanup，使同步重入复用同一任务。
    let resolveTask!: (value: void | PromiseLike<void>) => void
    this.#disposeTask = new Promise<void>(resolve => {
      resolveTask = resolve
    })
    void this.#disposeTask.catch(() => {})
    resolveTask(this.#dispose())
    return this.#disposeTask
  }

  async #dispose() {
    const errors: unknown[] = []

    for (const dispose of this.#disposers.splice(0).reverse()) {
      try {
        // 逐个 await 可以保证前一项真正清理结束后，才开始清理下一项。
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }

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

/** 收集单个 Effect 的清理路径，初始化失败时先回滚资源，再让 ready 拒绝。 */
export class EffectScope {
  readonly label: string
  readonly dispose: Disposer
  ready: Promise<void> = Promise.resolve()
  #stack = new DisposableStack()
  #started = false
  #disposed = false

  constructor(label = 'anonymous') {
    this.label = label
    this.dispose = once(async () => {
      // 先关闭启动入口，再等待初始化结束。
      this.#disposed = true
      await this.ready.catch(() => {})
      await this.#stack.dispose()
    })
  }

  add(dispose: Disposer) {
    return this.#stack.add(dispose)
  }

  start(execute: () => CleanupSource) {
    if (this.#started) throw new Error('effect scope has already started')
    if (this.#disposed) throw new Error('cannot start a disposed effect scope')
    this.#started = true

    let source: CleanupSource
    try {
      source = execute()
    } catch (error) {
      this.ready = this.#rollback(error)
      void this.ready.catch(() => {})
      throw error
    }

    this.ready = collectCleanup(source, this.#stack).catch(error => this.#rollback(error))
    // 标记拒绝已被观察，避免调用方只使用 dispose 而未 await ready 时出现未处理拒绝；
    // 这不会改变 ready 对主动等待者的拒绝结果。
    void this.ready.catch(() => {})
  }

  async #rollback(reason: unknown): Promise<never> {
    try {
      await this.#stack.dispose()
    } catch (cleanupError) {
      throw new AggregateError([reason, cleanupError], 'effect setup and rollback both failed')
    }

    throw reason
  }
}
