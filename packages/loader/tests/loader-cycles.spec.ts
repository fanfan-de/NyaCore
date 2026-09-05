/** 本文件通过重复的完整 Entry 操作序列验证实例、活动 Effect 与业务资源回到基线。 */

import { Context } from '@nya/core'
import type { Component, FiberDiagnosticSnapshot } from '@nya/core'
import { expect, it } from 'vitest'
import { Loader, LoaderGroup } from '../src/index.js'
import type { EntrySnapshot } from '../src/index.js'

declare module '@nya/core' {
  interface Events {
    'reliability/cycle'(): void
  }
}

function countEffects(snapshot: FiberDiagnosticSnapshot): number {
  const countNodes = (effects: FiberDiagnosticSnapshot['effects']): number => {
    return effects.reduce((total, effect) => total + 1 + countNodes(effect.children), 0)
  }
  return countNodes(snapshot.effects)
    + snapshot.children.reduce((total, child) => total + countEffects(child), 0)
}

it('preserves unrelated branches and disabled snapshots when cleanup creates entries during removal', async () => {
  const app = new Context()
  const created: EntrySnapshot[] = []
  const order: string[] = []
  const target: Component.Function<void> = context => async () => {
    order.push('cleanup:start')
    created.push(await context.loader.create({ id: 'late', name: 'late' }, 'other'))
    created.push(await context.loader.create({ id: 'off', name: 'off', disabled: true }, 'other'))
    created.push(await context.loader.create({ id: 'inherited-off', name: 'off' }, 'disabled'))
    order.push('cleanup:end')
  }
  target.inject = ['loader']

  try {
    await app.installComponent(Loader, {
      resolver({ name }) {
        if (name === 'target') return target
        order.push(`resolve:${name}`)
        return () => { order.push(`start:${name}`) }
      },
    })
    const loader = app.loader
    await loader.create({ id: 'removing', type: 'group' })
    await loader.create({ id: 'other', type: 'group' })
    await loader.create({ id: 'disabled', type: 'group', disabled: true })
    await loader.create({ id: 'target', name: 'target' }, 'removing')

    await loader.remove('removing')
    expect(created.map(entry => entry.state)).toEqual(['pending', 'disabled', 'disabled'])
    expect(created.every(entry => entry.fiberId === undefined)).toBe(true)
    expect(order).toEqual(['cleanup:start', 'cleanup:end', 'resolve:late', 'start:late'])
    expect(loader.get('other')!.children).toEqual(['late', 'off'])
    expect(loader.get('disabled')!.children).toEqual(['inherited-off'])
    expect(loader.get('late')!.state).toBe('active')
    expect(loader.get('removing')).toBeUndefined()
    expect(loader.get('target')).toBeUndefined()
    expect(loader.entries().map(entry => entry.id)).toEqual([
      'other', 'late', 'off', 'disabled', 'inherited-off',
    ])
    expect((await loader.create({ id: 'target', type: 'group' })).state).toBe('active')
  } finally {
    await app.fiber.dispose()
  }
})

it('returns to the resource baseline after 100 create/update/move/disable/restore/remove cycles', async () => {
  const app = new Context()
  const installed = new Set<number>()
  const stopObserving = app.registry.subscribe(event => {
    if (event.type === 'installed') installed.add(event.fiber.id)
    if (event.type === 'detached') installed.delete(event.fiber.id)
  })
  let resources = 0
  let deliveries = 0
  const resolverFailures = new Map<string, Error>()
  const startFailures = new Map<number, Error>()
  const cleanupFailures = new Map<number, Error>()
  const sinkFailures = new Map<number, Error>()
  let cleanupFailuresObserved = 0
  let sinkFailuresObserved = 0
  const nestedChild: Component.Function<void> = context => {
    context.effect(() => {
      resources++
      return () => { resources-- }
    }, 'nested cycle resource')
  }
  const worker: Component.Object<{ value: number }> = {
    name: 'cycle-worker',
    async apply(context, config) {
      context.effect(() => {
        resources++
        return () => {
          resources--
          const failure = cleanupFailures.get(config.value)
          if (failure) {
            cleanupFailures.delete(config.value)
            cleanupFailuresObserved++
            throw failure
          }
        }
      }, 'cycle resource')
      context.on('reliability/cycle', () => { deliveries++ })
      const sinkFailure = sinkFailures.get(config.value)
      if (sinkFailure) {
        sinkFailures.delete(config.value)
        context.logger.subscribe(() => {
          sinkFailuresObserved++
          throw sinkFailure
        }, { minLevel: 'info' })
        context.logger.info('controlled cycle sink failure')
      }
      await context.installComponent(nestedChild)
      const failure = startFailures.get(config.value)
      if (failure) {
        startFailures.delete(config.value)
        throw failure
      }
    },
  }

  try {
    const loaderFiber = app.installComponent(Loader, {
      resolver({ id }) {
        const failure = resolverFailures.get(id)
        if (failure) {
          resolverFailures.delete(id)
          throw failure
        }
        return worker
      },
    })
    await loaderFiber
    const loader = app.loader
    await loader.create({ id: 'left', type: 'group', baseUrl: 'file:///left/' })
    await loader.create({ id: 'right', type: 'group', baseUrl: 'file:///right/' })
    const baselineInstances = [...installed].sort((left, right) => left - right)
    const baselineEffects = countEffects(app.fiber.inspect())
    const baselineGroups = app.registry.get(LoaderGroup)!.fibers.map(fiber => fiber.id)

    for (let cycle = 0; cycle < 100; cycle++) {
      const value = cycle * 2
      const failure = new Error(`controlled cycle failure ${cycle}`)
      if (cycle % 10 === 0) resolverFailures.set('worker', failure)
      if (cycle % 10 === 5) startFailures.set(value, failure)
      if (cycle % 10 === 3) cleanupFailures.set(value, failure)
      sinkFailures.set(value, new Error(`controlled sink failure ${cycle}`))

      let entry = await loader.create({ id: 'worker', name: 'worker', config: { value } }, 'left')
      if (cycle % 10 === 0 || cycle % 10 === 5) {
        expect(entry.state).toBe('failed')
        expect(entry.error).toBe(failure)
        expect(resources).toBe(0)
        entry = await loader.resolve('worker')
      }
      expect(entry.state).toBe('active')
      expect(resources).toBe(2)
      const initialFiber = entry.fiberId

      entry = await loader.update('worker', { config: { value: value + 1 } })
      if (cycle % 10 === 3) {
        expect(entry.state).toBe('failed')
        expect(entry.error).toBe(failure)
        expect(entry.config).toEqual({ value: value + 1 })
        expect(resources).toBe(0)
        await loader.awaitIdle()
        expect(loader.get('worker')!.error).toBe(failure)
        entry = await loader.update('worker', { config: { value: value + 1 } })
        expect(entry.state).toBe('failed')
        expect(resources).toBe(0)
        entry = await loader.resolve('worker')
      }
      expect(entry.state).toBe('active')
      expect(entry.fiberId).toBe(initialFiber)
      expect(resources).toBe(2)

      entry = await loader.move('worker', 'right')
      expect(entry.state).toBe('active')
      expect(entry.fiberId).not.toBe(initialFiber)
      expect(resources).toBe(2)

      entry = await loader.update('worker', { disabled: true })
      expect(entry.state).toBe('disabled')
      expect(entry.fiberId).toBeUndefined()
      expect(resources).toBe(0)

      entry = await loader.update('worker', { disabled: false })
      expect(entry.state).toBe('active')
      expect(resources).toBe(2)
      const beforeDelivery = deliveries
      app.emit('reliability/cycle')
      expect(deliveries).toBe(beforeDelivery + 1)

      await loader.remove('worker')
      await loader.awaitIdle()
      expect(loader.get('worker')).toBeUndefined()
      expect(loader.entries().map(item => item.id)).toEqual(['left', 'right'])
      expect(loader.get('left')!.children).toEqual([])
      expect(loader.get('right')!.children).toEqual([])
      expect(resources).toBe(0)
      app.emit('reliability/cycle')
      expect(deliveries).toBe(beforeDelivery + 1)
      expect(app.registry.get(worker)).toBeUndefined()
      expect(app.registry.get(nestedChild)).toBeUndefined()
      expect(app.registry.get(LoaderGroup)!.fibers.map(fiber => fiber.id)).toEqual(baselineGroups)
      expect([...installed].sort((left, right) => left - right)).toEqual(baselineInstances)
      expect(countEffects(app.fiber.inspect())).toBe(baselineEffects)
    }

    expect(cleanupFailuresObserved).toBe(10)
    expect(sinkFailuresObserved).toBe(100)
    await loader.remove('left')
    await loader.remove('right')
    expect(app.registry.get(LoaderGroup)).toBeUndefined()
    await loaderFiber.dispose()
    expect(installed.size).toBe(0)
    expect(resources).toBe(0)
    expect(countEffects(app.fiber.inspect())).toBe(0)
  } finally {
    stopObserving()
    await app.fiber.dispose()
  }
})
