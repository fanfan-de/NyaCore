/** 本文件验证定义身份、安装身份和 Runtime 只读快照。 */

import { describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '../src/index.js'

describe('Component identity', () => {
  it('keeps object definitions separate when they share one apply callback', async () => {
    const app = new Context()
    const starts: string[] = []
    const apply = (context: Context) => {
      starts.push(context.fiber.name)
    }
    const firstDefinition = { name: 'first', apply }
    const secondDefinition = { name: 'second', apply }

    const first = app.installComponent(firstDefinition)
    const second = app.installComponent(secondDefinition)
    await Promise.all([first, second])

    expect(starts).toEqual(['first', 'second'])
    expect(app.registry.get(firstDefinition)).toMatchObject({
      definition: firstDefinition,
      callback: apply,
      name: 'first',
    })
    expect(app.registry.get(secondDefinition)).toMatchObject({
      definition: secondDefinition,
      callback: apply,
      name: 'second',
    })

    await app.registry.delete(firstDefinition)
    expect(first.state).toBe(FiberState.DISPOSED)
    expect(second.state).toBe(FiberState.ACTIVE)
    expect(app.registry.get(secondDefinition)?.fibers.map(fiber => fiber.id))
      .toEqual([second.id])
  })

  it('shares definition metadata but keeps every installation independent', async () => {
    const app = new Context()
    const component = { name: 'shared', apply() {} }
    const first = app.installComponent(component)
    const second = app.installComponent(component)
    await Promise.all([first, second])

    const runtime = app.registry.get(component)!
    expect(runtime.definition).toBe(component)
    expect(runtime.fibers.map(fiber => fiber.id)).toEqual([
      first.id,
      second.id,
    ])
    expect(first).not.toBe(second)
    expect(first.context).not.toBe(second.context)
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Object.isFrozen(runtime.fibers)).toBe(true)
    expect(() => {
      ;(runtime.fibers as typeof first[]).push(first)
    }).toThrow(TypeError)
  })

  it('snapshots install override containers before later caller mutation', async () => {
    const app = new Context()
    const extraInject = ['database']
    const isolate = { database: Symbol('database') }
    const component = { apply() {} }
    const fiber = app.installComponent(component, undefined, {
      inject: extraInject,
      isolate,
    })

    extraInject.push('cache')
    isolate.database = Symbol('changed')

    expect(fiber.inject).toEqual(new Set(['database']))
    expect(fiber.inject.has('cache')).toBe(false)
    await fiber.dispose()
  })

  it('does not retain an empty Runtime when install overrides are invalid', () => {
    const app = new Context()
    const component = { apply() {} }

    expect(() => app.installComponent(component, undefined, {
      inject: [''],
    })).toThrow('service names must be non-empty strings')
    expect(app.registry.get(component)).toBeUndefined()
  })

  it('waits for every instance and aggregates Registry deletion failures', async () => {
    const app = new Context()
    const cleanups = [
      vi.fn(() => {
        throw new Error('first cleanup')
      }),
      vi.fn(() => {
        throw new Error('second cleanup')
      }),
    ]
    let index = 0
    const component = () => cleanups[index++]
    const first = app.installComponent(component)
    const second = app.installComponent(component)
    await Promise.all([first, second])

    await expect(app.registry.delete(component)).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error), expect.any(Error)],
    })
    expect(cleanups[0]).toHaveBeenCalledOnce()
    expect(cleanups[1]).toHaveBeenCalledOnce()
    expect(first.state).toBe(FiberState.DISPOSED)
    expect(second.state).toBe(FiberState.DISPOSED)
    expect(app.registry.get(component)).toBeUndefined()
  })
})
