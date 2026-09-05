/** 本文件验证清理栈的同步重入、并发等待、清理顺序与原始失败传播。 */

import { describe, expect, it, vi } from 'vitest'
import { DisposableStack } from '../src/index.js'
import type { Disposer } from '../src/index.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('DisposableStack reliability', () => {
  it('marks disposal before cleanup can register more work', async () => {
    const stack = new DisposableStack()
    const lateCleanup = vi.fn()
    let disposedInside: boolean | undefined
    let registrationError: unknown
    stack.add(() => {
      disposedInside = stack.disposed
      try {
        stack.add(lateCleanup)
      } catch (error) {
        registrationError = error
      }
    })

    const disposal = stack.dispose()
    await disposal

    expect(disposedInside).toBe(true)
    expect(registrationError).toBeInstanceOf(Error)
    expect((registrationError as Error).message).toBe(
      'cannot add a disposer to a disposed stack',
    )
    expect(stack.dispose()).toBe(disposal)
    expect(lateCleanup).not.toHaveBeenCalled()
  })

  it('returns the cached stack task to a synchronously reentrant cleanup', async () => {
    const stack = new DisposableStack()
    let reentrant: Promise<void> | undefined
    const cleanup = vi.fn(() => { reentrant = stack.dispose() })
    stack.add(cleanup)

    const first = stack.dispose()
    await first

    expect(reentrant).toBe(first)
    expect(stack.dispose()).toBe(first)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('caches a registered disposer before its cleanup synchronously reenters', async () => {
    const stack = new DisposableStack()
    let registered!: Disposer
    let reentrant: ReturnType<Disposer> = undefined
    let entered = false
    const cleanup = vi.fn(() => {
      if (entered) return
      entered = true
      // 只观察重入句柄；清理函数不能等待它自身的完成。
      reentrant = registered()
    })
    registered = stack.add(cleanup)

    const first = registered()
    await first

    expect(reentrant).toBe(first)
    expect(registered()).toBe(first)
    expect(cleanup).toHaveBeenCalledOnce()
    await stack.dispose()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('awaits each LIFO cleanup and preserves a failure while finishing the stack', async () => {
    const stack = new DisposableStack()
    const gate = deferred()
    const started = deferred()
    const failure = new Error('middle cleanup failed')
    const order: string[] = []
    stack.add(() => { order.push('first') })
    stack.add(() => {
      order.push('second')
      throw failure
    })
    stack.add(async () => {
      order.push('third:start')
      started.resolve()
      await gate.promise
      order.push('third:end')
    })

    const disposal = stack.dispose()
    try {
      await started.promise
      expect(stack.disposed).toBe(true)
      expect(order).toEqual(['third:start'])
      expect(stack.dispose()).toBe(disposal)
    } finally {
      gate.resolve()
    }

    await expect(disposal).rejects.toBe(failure)
    expect(order).toEqual(['third:start', 'third:end', 'second', 'first'])
  })

  it('joins an in-flight manual cleanup when its owner starts disposing', async () => {
    const stack = new DisposableStack()
    const gate = deferred()
    const started = deferred()
    const cleanup = vi.fn(async () => {
      started.resolve()
      await gate.promise
    })
    const registered = stack.add(cleanup)
    const manual = registered()
    const repeated = registered()
    const owner = stack.dispose()
    let ownerFinished = false
    void owner.then(() => { ownerFinished = true })

    try {
      await started.promise
      await Promise.resolve()
      expect(repeated).toBe(manual)
      expect(ownerFinished).toBe(false)
      expect(cleanup).toHaveBeenCalledOnce()
    } finally {
      gate.resolve()
    }

    await Promise.all([manual, repeated, owner])
    expect(ownerFinished).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('retains a manually failed registration for owner cleanup without retrying it', async () => {
    const stack = new DisposableStack()
    const failure = Object.freeze({ reason: 'arbitrary cleanup failure' })
    const independent = vi.fn()
    stack.add(independent)
    const cleanup = vi.fn(() => { throw failure })
    const registered = stack.add(cleanup)

    const manual = registered()
    await expect(manual).rejects.toBe(failure)
    expect(registered()).toBe(manual)
    await expect(stack.dispose()).rejects.toBe(failure)

    expect(cleanup).toHaveBeenCalledOnce()
    expect(independent).toHaveBeenCalledOnce()
  })
})
