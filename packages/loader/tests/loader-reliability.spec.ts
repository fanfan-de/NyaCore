/** 验证 Loader 清理重入、目标恢复、删除一致性和解析缓存边界。 */

import { Context, FiberState } from '@nya/core'
import type { Component, Fiber } from '@nya/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Loader } from '../src/index.js'
import type { EntrySnapshot, LoaderResolver } from '../src/index.js'

declare module '@nya/core' {
  interface Context {
    replacement: { value: number }
  }
}

const applications: Context[] = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(fulfill => { resolve = fulfill })
  return { promise, resolve }
}

afterEach(async () => {
  await Promise.allSettled(applications.splice(0).map(app => app.fiber.dispose()))
})

async function setup(resolver: LoaderResolver) {
  const app = new Context()
  applications.push(app)
  await app.installComponent(Loader, { resolver })
  return { app, loader: app.loader }
}

describe('Loader reliability', () => {
  it('re-resolves the full request after moves and inherited baseUrl changes', async () => {
    const starts: string[] = []
    const resolver = vi.fn<LoaderResolver>(request => {
      const label = `${request.parentId}:${request.baseUrl}`
      return () => { starts.push(label) }
    })
    const { loader } = await setup(resolver)
    await loader.create({ id: 'left', type: 'group', baseUrl: 'file:///left/' })
    await loader.create({ id: 'right', type: 'group', baseUrl: 'file:///right/' })
    await loader.create({ id: 'worker', name: './worker.js' }, 'left')
    await loader.move('worker', 'right')
    await loader.update('right', { baseUrl: 'file:///updated/' })
    expect(starts).toEqual(['left:file:///left/', 'right:file:///right/', 'right:file:///updated/'])
    expect(resolver).toHaveBeenCalledTimes(3)
  })

  it('keeps an overridden descendant cache but re-resolves a changed parentId', async () => {
    const resolver = vi.fn<LoaderResolver>(() => () => {})
    const { loader } = await setup(resolver)
    await loader.create({ id: 'left', type: 'group', baseUrl: 'file:///same/' })
    await loader.create({ id: 'right', type: 'group', baseUrl: 'file:///same/' })
    await loader.create({ id: 'boundary', type: 'group', baseUrl: 'file:///fixed/' }, 'left')
    await loader.create({ id: 'worker', name: './worker.js' }, 'boundary')
    await loader.update('left', { baseUrl: 'file:///new/' })
    expect(resolver).toHaveBeenCalledTimes(1)
    await loader.update('boundary', { baseUrl: undefined })
    expect(resolver).toHaveBeenLastCalledWith({
      id: 'worker', name: './worker.js', parentId: 'boundary', baseUrl: 'file:///new/',
    })
    await loader.move('worker', 'left')
    await loader.move('worker', 'right')
    expect(resolver).toHaveBeenCalledTimes(4)
    await loader.update('worker', { config: { value: 1 }, intercept: {} })
    expect(resolver).toHaveBeenCalledTimes(4)
  })

  it('re-resolves parentId changes even when an explicit baseUrl stays equal', async () => {
    const resolver = vi.fn<LoaderResolver>(() => () => {})
    const { loader } = await setup(resolver)
    await loader.create({ id: 'left', type: 'group' })
    await loader.create({ id: 'right', type: 'group' })
    await loader.create({ id: 'worker', name: './worker.js', baseUrl: 'file:///fixed/' }, 'left')
    await loader.move('worker', 'right')
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(resolver).toHaveBeenLastCalledWith({
      id: 'worker', name: './worker.js', parentId: 'right', baseUrl: 'file:///fixed/',
    })
  })

  it('reuses a successful definition when resolve recreates the same request after cleanup failure', async () => {
    const failure = new Error('cleanup failed')
    const starts = vi.fn()
    const target: Component.Function<void> = () => {
      starts()
      return () => { throw failure }
    }
    const resolver = vi.fn<LoaderResolver>(() => target)
    const { loader } = await setup(resolver)
    const first = await loader.create({ id: 'target', name: 'target' })
    await loader.update('target', { intercept: {} })
    const restored = await loader.resolve('target')
    expect(restored.state).toBe('active')
    expect(restored.fiberId).not.toBe(first.fiberId)
    expect(resolver).toHaveBeenCalledOnce()
    expect(starts).toHaveBeenCalledTimes(2)
  })

  it('retries a resolver failure without caching an unsuccessful resolution', async () => {
    const failure = new Error('resolution failed')
    const resolver = vi.fn<LoaderResolver>(() => { throw failure })
    const { loader } = await setup(resolver)
    expect((await loader.create({ id: 'target', name: 'target' })).error).toBe(failure)
    resolver.mockImplementation(() => () => {})
    expect((await loader.resolve('target')).state).toBe('active')
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('defers cleanup-created entries from deep manual Fiber descendants', async () => {
    let nested: EntrySnapshot | undefined
    let cleanupComplete = false
    const manual: Component.Function<void> = context => async () => {
      nested = await context.loader.create({ id: 'late', name: 'late' })
      cleanupComplete = true
    }
    manual.inject = ['loader']
    const target: Component.Function<void> = context => {
      context.installComponent(inner => { inner.installComponent(manual) })
    }
    const resolver = vi.fn<LoaderResolver>(({ name }) => {
      if (name === 'target') return target
      expect(cleanupComplete).toBe(true)
      return () => {}
    })
    const { loader } = await setup(resolver)
    await loader.create({ id: 'group', type: 'group' })
    await loader.create({ id: 'target', name: 'target' }, 'group')
    await loader.remove('group')
    expect(nested).toMatchObject({ state: 'pending' })
    expect(nested?.fiberId).toBeUndefined()
    expect(loader.get('late')?.state).toBe('active')
  })

  it('defers entries created by a sibling consumer during service replacement', async () => {
    const starts: number[] = []
    let nested: EntrySnapshot | undefined
    let createOnce = true
    const provider: Component.Function<{ value: number }> = (context, config) => {
      return context.provide('replacement', config)
    }
    const consumer: Component.Function<void> = context => async () => {
      if (!createOnce) return
      createOnce = false
      nested = await context.loader.create({ id: 'late', name: 'late' })
    }
    consumer.inject = ['loader', 'replacement']
    const late: Component.Function<void> = context => { starts.push(context.replacement.value) }
    late.inject = ['replacement']
    const definitions: Record<string, Component<any>> = { provider, consumer, late }
    const { loader } = await setup(({ name }) => definitions[name])
    await loader.create({ id: 'provider', name: 'provider', config: { value: 1 } })
    await loader.create({ id: 'consumer', name: 'consumer' })
    await loader.update('provider', { config: { value: 2 } })
    expect(nested?.state).toBe('pending')
    expect(starts).toEqual([2])
    expect(loader.get('late')?.state).toBe('active')
  })

  it('rejects creation under a removing subtree without leaving an orphan', async () => {
    const failures: unknown[] = []
    const target: Component.Function<void> = context => async () => {
      for (const parent of ['target', 'child']) {
        try {
          await context.loader.create({ id: `late-${parent}`, type: 'group' }, parent)
        } catch (error) { failures.push(error) }
      }
    }
    target.inject = ['loader']
    const { loader } = await setup(() => target)
    await loader.create({ id: 'target', name: 'target' })
    await loader.create({ id: 'child', type: 'group' }, 'target')
    await loader.remove('target')
    expect(failures).toHaveLength(2)
    for (const failure of failures) expect(failure).toBeInstanceOf(Error)
    expect(String(failures[0])).toContain('being removed')
    expect(loader.entries()).toEqual([])
    expect(loader.get('late-target')).toBeUndefined()
    expect(loader.get('late-child')).toBeUndefined()
    expect((await loader.create({ id: 'late-target', type: 'group' })).state).toBe('active')
  })

  it('rejects all self-waiting operations during cleanup and permits Root queuing', async () => {
    const errors: unknown[] = []
    const entered = deferred()
    const release = deferred()
    const target: Component.Function<void> = context => async () => {
      const loader = context.loader
      for (const operation of [
        () => loader.update('target', {}),
        () => loader.move('target', null),
        () => loader.remove('target'),
        () => loader.resolve('target'),
        () => loader.awaitIdle(),
      ]) {
        try { await operation() } catch (error) { errors.push(error) }
      }
      entered.resolve()
      await release.promise
    }
    target.inject = ['loader']
    const { loader } = await setup(() => target)
    await loader.create({ id: 'target', name: 'target' })
    const removing = loader.remove('target')
    await entered.promise
    const queued = loader.create({ id: 'queued', type: 'group' })
    const idle = loader.awaitIdle()
    release.resolve()
    await Promise.all([removing, queued, idle])
    expect(errors).toHaveLength(5)
    for (const error of errors) expect(String(error)).toContain('self-wait')
    expect(loader.get('queued')?.state).toBe('active')
  })

  it('rejects self-waiting operations during component startup', async () => {
    const errors: unknown[] = []
    const target: Component.Function<void> = async context => {
      const loader = context.loader
      for (const operation of [
        () => loader.update('target', {}),
        () => loader.move('target', null),
        () => loader.remove('target'),
        () => loader.resolve('target'),
        () => loader.awaitIdle(),
      ]) {
        try { await operation() } catch (error) { errors.push(error) }
      }
    }
    target.inject = ['loader']
    const { loader } = await setup(() => target)
    const entry = await loader.create({ id: 'target', name: 'target' })
    expect(entry.state).toBe('active')
    expect(errors).toHaveLength(5)
    for (const error of errors) expect(String(error)).toContain('self-wait')
  })

  it('rejects self-waits during externally triggered consumer cleanup before Loader waits exist', async () => {
    const errors: unknown[] = []
    const entered = deferred()
    const release = deferred()
    const consumer: Component.Function<void> = context => async () => {
      entered.resolve()
      await release.promise
      for (const operation of [
        () => context.loader.awaitIdle(),
        () => context.loader.update('consumer', {}),
        () => context.loader.move('consumer', null),
        () => context.loader.remove('consumer'),
        () => context.loader.resolve('consumer'),
      ]) {
        try { await operation() } catch (error) { errors.push(error) }
      }
    }
    consumer.inject = ['loader', 'replacement']
    const { app, loader } = await setup(() => consumer)
    const disposeProvider = app.provide('replacement', { value: 1 })
    await loader.create({ id: 'consumer', name: 'consumer' })
    const disposing = disposeProvider()
    await entered.promise
    release.resolve()
    await disposing
    expect(errors).toHaveLength(5)
    for (const error of errors) expect(String(error)).toContain('self-wait')
    await loader.remove('consumer')
    expect(loader.entries()).toEqual([])
  })

  it('locks external dependency cleanup failures before a later target edit', async () => {
    const failure = new Error('external dependency cleanup failed')
    const consumer: Component.Function<void> = () => () => { throw failure }
    consumer.inject = ['replacement']
    const replacement = vi.fn()
    const { app, loader } = await setup(({ name }) => name === 'consumer' ? consumer : replacement)
    const disposeProvider = app.provide('replacement', { value: 1 })
    await loader.create({ id: 'target', name: 'consumer' })
    await expect(disposeProvider()).rejects.toBe(failure)
    await loader.awaitIdle()
    const updated = await loader.update('target', { name: 'replacement' })
    expect(updated).toMatchObject({ state: 'failed', error: failure, name: 'replacement' })
    expect(replacement).not.toHaveBeenCalled()
    expect((await loader.resolve('target')).state).toBe('active')
    expect(replacement).toHaveBeenCalledOnce()
  })

  it('keeps cleanup failures across target edits and explicitly reinstalls on resolve', async () => {
    const failure = new Error('old cleanup failed')
    const old: Component.Function<void> = () => () => { throw failure }
    const starts = vi.fn()
    const resolver = vi.fn<LoaderResolver>(({ name }) => name === 'old' ? old : starts)
    const { loader } = await setup(resolver)
    await loader.create({ id: 'group', type: 'group' })
    const before = await loader.create({ id: 'target', name: 'old' })
    const failed = await loader.update('target', { name: 'new' })
    expect(failed).toMatchObject({ name: 'new', state: 'failed', error: failure })
    expect(failed.fiberId).toBeUndefined()
    await loader.move('target', 'group')
    await loader.update('target', { config: { newest: true } })
    await loader.awaitIdle()
    expect(loader.get('target')).toMatchObject({ state: 'failed', error: failure, parentId: 'group' })
    expect(starts).not.toHaveBeenCalled()
    const recovered = await loader.resolve('target')
    expect(recovered.state).toBe('active')
    expect(recovered.fiberId).not.toBe(before.fiberId)
    expect(recovered).not.toHaveProperty('error')
    expect(starts).toHaveBeenCalledOnce()
  })

  it('blocks automatic replacement when startup rollback also fails to clean up', async () => {
    const startupError = new Error('startup failed')
    const cleanupError = new Error('startup rollback cleanup failed')
    const old: Component.Function<void> = context => {
      context.effect(() => () => { throw cleanupError }, 'startup resource')
      throw startupError
    }
    const replacement = vi.fn()
    const { loader } = await setup(({ name }) => name === 'old' ? old : replacement)
    await loader.create({ id: 'destination', type: 'group' })
    const failed = await loader.create({ id: 'target', name: 'old' })
    expect(failed.state).toBe('failed')
    expect(failed.error).toBeInstanceOf(AggregateError)
    const updated = await loader.update('target', { name: 'new' })
    expect(updated).toMatchObject({ name: 'new', state: 'failed', error: failed.error })
    await loader.update('target', { config: { latest: true } })
    await loader.move('target', 'destination')
    expect(loader.get('target')).toMatchObject({ parentId: 'destination', state: 'failed' })
    expect(loader.get('target')?.error).toBe(failed.error)
    expect(replacement).not.toHaveBeenCalled()
    expect((await loader.resolve('target')).state).toBe('active')
    expect(replacement).toHaveBeenCalledOnce()
  })

  it('allows replacing an ordinary startup failure whose rollback succeeded', async () => {
    const failure = new Error('ordinary startup failure')
    const cleanup = vi.fn()
    const old: Component.Function<void> = context => {
      context.effect(() => cleanup, 'startup resource')
      throw failure
    }
    const replacement = vi.fn()
    const { loader } = await setup(({ name }) => name === 'old' ? old : replacement)
    expect((await loader.create({ id: 'target', name: 'old' })).error).toBe(failure)
    expect((await loader.update('target', { name: 'new' })).state).toBe('active')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(replacement).toHaveBeenCalledOnce()
  })

  it('prioritizes failed cleanup over disabled and acknowledges it without starting', async () => {
    const failure = new Error('disable cleanup failed')
    const starts = vi.fn()
    const target: Component.Function<void> = () => { starts(); return () => { throw failure } }
    const { loader } = await setup(() => target)
    await loader.create({ id: 'target', name: 'target' })
    const disabled = await loader.update('target', { disabled: true })
    await loader.awaitIdle()
    expect(disabled).toMatchObject({ disabled: true, state: 'failed', error: failure })
    expect(loader.get('target')?.state).toBe('failed')
    const acknowledged = await loader.resolve('target')
    expect(acknowledged).toMatchObject({ disabled: true, state: 'disabled' })
    expect(acknowledged).not.toHaveProperty('error')
    expect(starts).toHaveBeenCalledOnce()
    await loader.update('target', { disabled: false })
    expect(starts).toHaveBeenCalledTimes(2)
  })

  it('retries config cleanup failure on a reusable Fiber with the latest target config', async () => {
    const failure = new Error('config cleanup failed')
    const starts: number[] = []
    let fiber: Fiber | undefined
    const target: Component.Function<{ value: number }> = (context, config) => {
      fiber = context.fiber
      starts.push(config.value)
      return () => { if (config.value === 1) throw failure }
    }
    const { loader } = await setup(() => target)
    const before = await loader.create({ id: 'target', name: 'target', config: { value: 1 } })
    await loader.update('target', { config: { value: 2 } })
    expect(fiber?.state).toBe(FiberState.FAILED)
    await loader.update('target', { config: { value: 3 } })
    expect(starts).toEqual([1])
    expect(loader.get('target')).toMatchObject({ state: 'failed', error: failure })
    const recovered = await loader.resolve('target')
    expect(recovered.state).toBe('active')
    expect(recovered.fiberId).toBe(before.fiberId)
    expect(starts).toEqual([1, 3])
  })

  it('reinstalls a reusable failed Fiber when its queued structural target changes', async () => {
    const failure = new Error('config cleanup failed')
    const old: Component.Function<{ value: number }> = () => () => { throw failure }
    let newParent: number | undefined
    const replacement: Component.Function<void> = context => { newParent = context.fiber.parent?.id }
    const { loader } = await setup(({ name }) => name === 'old' ? old : replacement)
    const destination = await loader.create({ id: 'destination', type: 'group' })
    const before = await loader.create({ id: 'target', name: 'old', config: { value: 1 } })
    await loader.update('target', { config: { value: 2 } })
    await loader.update('target', { name: 'new' })
    await loader.move('target', 'destination')
    expect(loader.get('target')).toMatchObject({ state: 'failed', error: failure })
    const recovered = await loader.resolve('target')
    expect(recovered.state).toBe('active')
    expect(recovered.fiberId).not.toBe(before.fiberId)
    expect(newParent).toBe(destination.fiberId)
  })

  it('acknowledges a reusable failed Fiber disabled target without restarting it', async () => {
    const failure = new Error('config cleanup failed')
    const starts = vi.fn()
    const target: Component.Function<{ value: number }> = () => {
      starts()
      return () => { throw failure }
    }
    const { loader } = await setup(() => target)
    await loader.create({ id: 'target', name: 'target', config: { value: 1 } })
    await loader.update('target', { config: { value: 2 } })
    await loader.update('target', { disabled: true })
    const recovered = await loader.resolve('target')
    expect(recovered).toMatchObject({ state: 'disabled', disabled: true })
    expect(recovered.fiberId).toBeUndefined()
    expect(recovered).not.toHaveProperty('error')
    expect(starts).toHaveBeenCalledOnce()
  })

  it('ignores acknowledged cleanup history on successful external disposal but captures new failures', async () => {
    const failure = new Error('shared cleanup failure')
    let failAgain = false
    const starts: number[] = []
    const target: Component.Function<{ value: number }> = (_context, config) => {
      starts.push(config.value)
      return () => { if (config.value === 1 || failAgain) throw failure }
    }
    const { app, loader } = await setup(() => target)
    const original = await loader.create({ id: 'target', name: 'target', config: { value: 1 } })
    await loader.update('target', { config: { value: 2 } })
    const recovered = await loader.resolve('target')
    expect(recovered.fiberId).toBe(original.fiberId)
    const fiber = app.registry.get(target)!.fibers[0]
    await fiber.dispose()
    await loader.awaitIdle()
    expect(loader.get('target')?.state).toBe('active')
    expect(loader.get('target')).not.toHaveProperty('error')
    expect(starts).toEqual([1, 2, 2])
    failAgain = true
    await expect(app.registry.get(target)!.fibers[0].dispose()).rejects.toBe(failure)
    await loader.awaitIdle()
    expect(loader.get('target')).toMatchObject({ state: 'failed', error: failure })
  })

  it.each([new Error('child cleanup failed'), undefined, null, false])(
    'requires a separate resolve for descendant cleanup failures (%s)', async failure => {
      const child: Component.Function<void> = () => () => { throw failure }
      const { loader } = await setup(() => child)
      await loader.create({ id: 'group', type: 'group' })
      const original = await loader.create({ id: 'child', name: 'child' }, 'group')
      await loader.update('group', { intercept: {} })
      expect(loader.get('group')).toMatchObject({ state: 'failed', error: failure })
      expect(loader.get('child')).toMatchObject({ state: 'failed', error: failure })
      expect(Object.hasOwn(loader.get('child')!, 'error')).toBe(true)
      await loader.resolve('group')
      expect(loader.get('group')?.state).toBe('active')
      expect(loader.get('child')).toMatchObject({ state: 'failed', error: failure })
      expect(Object.hasOwn(loader.get('child')!, 'error')).toBe(true)
      const restored = await loader.resolve('child')
      expect(restored.state).toBe('active')
      expect(restored.fiberId).not.toBe(original.fiberId)
    },
  )

  it.each([undefined, null, false, 0, ''])('retains and reports a falsy cleanup failure (%s)', async failure => {
    const { loader } = await setup(() => () => () => { throw failure })
    await loader.create({ id: 'target', name: 'target' })
    const blocked = await loader.update('target', { disabled: true })
    expect(blocked.state).toBe('failed')
    expect(blocked).toHaveProperty('error', failure)
    await loader.resolve('target')
    await loader.update('target', { disabled: false })
    await expect(loader.remove('target')).rejects.toBe(failure)
    expect(loader.entries()).toEqual([])
  })

  it('deletes the complete subtree while preserving the parent cleanup aggregate', async () => {
    const failure = new Error('shared failure')
    const cleanup = vi.fn(() => { throw failure })
    const target: Component.Function<void> = () => cleanup
    const { app, loader } = await setup(() => target)
    const group = await loader.create({ id: 'group', type: 'group' })
    await loader.create({ id: 'first', name: 'target' }, 'group')
    await loader.create({ id: 'second', name: 'target' }, 'group')
    let original: unknown
    const stopObserving = app.registry.subscribe(event => {
      if (event.type === 'detached' && event.fiber.id === group.fiberId) {
        original = event.fiber.error
      }
    })
    let reported: unknown
    try { await loader.remove('group') } catch (error) { reported = error }
    stopObserving()
    expect(reported).toBe(original)
    expect(reported).toBeInstanceOf(AggregateError)
    expect((reported as AggregateError).errors).toEqual([failure, failure])
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(loader.entries()).toEqual([])
    expect(loader.get('first')).toBeUndefined()
    await expect(loader.create({ id: 'group', type: 'group' })).resolves.toMatchObject({ state: 'active' })
  })

  it('reports every distinct cleanup failure after removing all entries', async () => {
    const first = new Error('first failure')
    const second = new Error('second failure')
    const { loader } = await setup(({ name }) => () => () => { throw name === 'first' ? first : second })
    await loader.create({ id: 'group', type: 'group' })
    await loader.create({ id: 'first', name: 'first' }, 'group')
    await loader.create({ id: 'second', name: 'second' }, 'group')
    let failure: unknown
    try { await loader.remove('group') } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as AggregateError).errors).toEqual(expect.arrayContaining([first, second]))
    expect(loader.entries()).toEqual([])
  })

  it('reports unacknowledged historical cleanup errors when deleting disposed entries', async () => {
    const failure = new Error('unacknowledged cleanup failure')
    const { loader } = await setup(() => () => () => { throw failure })
    await loader.create({ id: 'target', name: 'target' })
    await loader.update('target', { disabled: true })
    expect(loader.get('target')?.fiberId).toBeUndefined()
    await expect(loader.remove('target')).rejects.toBe(failure)
    expect(loader.entries()).toEqual([])
  })

  it('preserves an original aggregate and deduplicates its descendants historical failures', async () => {
    const first = new Error('first')
    const second = new Error('second')
    const original = new AggregateError([first, second], 'original cleanup failure')
    const { loader } = await setup(() => () => () => { throw original })
    await loader.create({ id: 'group', type: 'group' })
    await loader.create({ id: 'child', name: 'child' }, 'group')
    await loader.update('group', { disabled: true })
    expect(loader.get('group')?.error).toBe(original)
    expect(loader.get('child')?.error).toBe(original)
    await expect(loader.remove('group')).rejects.toBe(original)
    expect(loader.entries()).toEqual([])
  })

  it('preserves a single original aggregate even when its own members repeat', async () => {
    const nested = new Error('same member')
    const original = new AggregateError([nested, nested], 'original cleanup failure')
    const { loader } = await setup(() => () => () => { throw original })
    await loader.create({ id: 'target', name: 'target' })
    await expect(loader.remove('target')).rejects.toBe(original)
    expect(loader.entries()).toEqual([])
  })

  it('preserves a cleanup AggregateError whose errors property cannot be inspected', async () => {
    const original = new AggregateError([], 'opaque cleanup error')
    Object.defineProperty(original, 'errors', {
      get() { throw new Error('inspection failed') },
    })
    const { loader } = await setup(() => () => () => { throw original })
    await loader.create({ id: 'target', name: 'target' })
    await expect(loader.remove('target')).rejects.toBe(original)
    expect(loader.entries()).toEqual([])
  })

  it('drains cleanup-created entries before reporting a removal failure', async () => {
    const failure = new Error('cleanup failed after creating entry')
    const target: Component.Function<void> = context => async () => {
      await context.loader.create({ id: 'late', type: 'group' })
      throw failure
    }
    target.inject = ['loader']
    const { loader } = await setup(() => target)
    await loader.create({ id: 'target', name: 'target' })
    await expect(loader.remove('target')).rejects.toBe(failure)
    expect(loader.entries()).toEqual([expect.objectContaining({ id: 'late', state: 'active' })])
  })

  it('does not install an asynchronously resolved component after Loader disposal', async () => {
    const entered = deferred()
    const release = deferred()
    const starts = vi.fn()
    const app = new Context()
    applications.push(app)
    const loaderFiber = app.installComponent(Loader, {
      async resolver() {
        entered.resolve()
        await release.promise
        return starts
      },
    })
    await loaderFiber
    const creation = app.loader.create({ id: 'late', name: 'late' })
      .then(() => 'resolved', () => 'rejected')
    await entered.promise
    await loaderFiber.dispose()
    release.resolve()
    expect(await creation).toBe('rejected')
    expect(starts).not.toHaveBeenCalled()
    expect(app.registry.get(starts)).toBeUndefined()
    expect(app.get('loader')).toBeUndefined()
  })
})
