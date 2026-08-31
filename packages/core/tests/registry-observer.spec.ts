/** 本文件验证 Registry 生命周期事件是只读且不参与生命周期结果。 */

import { describe, expect, it, vi } from 'vitest'
import {
  Context,
  FiberState,
  type RegistryEvent,
} from '../src/index.js'

describe('Registry lifecycle observation', () => {
  it('publishes install, committed state and detach snapshots in order', async () => {
    const app = new Context()
    const events: RegistryEvent[] = []
    const unsubscribe = app.registry.subscribe(event => events.push(event))
    const component = { name: 'observed', apply() {} }

    const fiber = app.installComponent(component)
    await fiber
    await fiber.dispose()
    await unsubscribe()

    expect(events.map(event => [event.type, event.fiber.state])).toEqual([
      ['installed', FiberState.PENDING],
      ['state', FiberState.LOADING],
      ['state', FiberState.ACTIVE],
      ['state', FiberState.UNLOADING],
      ['state', FiberState.DISPOSED],
      ['detached', FiberState.DISPOSED],
    ])
    expect(events.every(event => Object.isFrozen(event))).toBe(true)
    expect(events.every(event => Object.isFrozen(event.fiber))).toBe(true)
    expect(events.every(event => Object.isFrozen(event.runtime))).toBe(true)
    expect(events.every(event => Object.isFrozen(event.runtime.fiberIds))).toBe(true)
  })

  it('replays current installations as snapshots', async () => {
    const app = new Context()
    const component = { name: 'replayed', apply() {} }
    const fiber = app.installComponent(component)
    await fiber
    const events: RegistryEvent[] = []

    const unsubscribe = app.registry.subscribe(
      event => events.push(event),
      { replay: true },
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'snapshot',
      fiber: {
        id: fiber.id,
        state: FiberState.ACTIVE,
      },
    })
    await unsubscribe()
    await fiber.dispose()
  })

  it('removes a throwing observer without changing component lifecycle', async () => {
    const app = new Context()
    const listener = vi.fn(() => {
      throw new Error('observer failed')
    })
    app.registry.subscribe(listener)

    const first = app.installComponent({ name: 'first', apply() {} })
    const second = app.installComponent({ name: 'second', apply() {} })
    await Promise.all([first, second])

    expect(listener).toHaveBeenCalledOnce()
    expect(first.state).toBe(FiberState.ACTIVE)
    expect(second.state).toBe(FiberState.ACTIVE)
    expect(app.logger.records()).toContainEqual(expect.objectContaining({
      level: 'error',
      message: 'registry observer failed',
    }))
  })

  it('returns an idempotent disposer and exposes readonly Fiber state', async () => {
    const app = new Context()
    const listener = vi.fn()
    const unsubscribe = app.registry.subscribe(listener)
    await unsubscribe()
    await unsubscribe()

    const fiber = app.installComponent({ apply() {} })
    await fiber
    expect(listener).not.toHaveBeenCalled()

    if (false) {
      // @ts-expect-error Fiber state is committed only by its lifecycle machine.
      fiber.state = FiberState.FAILED
      // @ts-expect-error Fiber errors are readonly observations.
      fiber.error = new Error('external mutation')
    }
    await fiber.dispose()
  })
})
