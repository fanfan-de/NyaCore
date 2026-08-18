/** 本文件验证事件派发模式、Context 过滤和监听器的 Fiber 生命周期所有权。 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '../src/index.js'
import type { Disposer } from '../src/index.js'

const symbolEvent = Symbol('test/symbol')

interface EventSubject {
  id: number
  [Context.filter](context: Context): unknown
}

declare module '../src/index.js' {
  interface Events {
    'test/emit'(value: number): void
    'test/error'(): void
    'test/result'(value: number): number | false | null | undefined
    'test/async-result'(value: number): Promise<number | false | undefined>
    'test/waterfall'(value: number, next: () => number): number
    'test/subject'(this: EventSubject, value: string): void
    'test/recursive'(): void
    'test/once-overlap'(): void | Promise<void>
    'test/primitive-this'(this: string): void
    invalidEventDeclaration: number
    [symbolEvent](): void
  }
}

describe('events', () => {
  it('provides typed listeners and dispatch arguments through the public entry', () => {
    const app = new Context()
    app.on('test/emit', (value) => {
      expectTypeOf(value).toEqualTypeOf<number>()
    })

    expectTypeOf(app.emit).toBeFunction()
    app.emit('test/emit', 42)

    // @ts-expect-error Events 中的非函数字段不是可派发事件。
    app.emit('invalidEventDeclaration')
    // @ts-expect-error 运行时只支持 object / function / null 类型的 thisArg。
    app.emit('subject', 'test/primitive-this')
  })

  it('registers, prepends, manually removes, and dispatches symbol listeners', async () => {
    const app = new Context()
    const calls: string[] = []

    const removeTail = app.on('test/emit', value => {
      calls.push(`tail:${value}`)
    })
    const removeHead = app.on('test/emit', value => {
      calls.push(`head:${value}`)
    }, true)
    const symbolListener = vi.fn()
    const removeSymbol = app.on(symbolEvent, symbolListener)

    expectTypeOf(removeTail).toEqualTypeOf<Disposer>()
    app.emit('test/emit', 1)
    app.emit(symbolEvent)
    expect(calls).toEqual(['head:1', 'tail:1'])
    expect(symbolListener).toHaveBeenCalledOnce()

    const removingHead = removeHead()
    // 手动 disposer 必须在异步 Effect 清理完成前就让监听器不可见。
    app.emit('test/emit', 2)
    expect(calls).toEqual(['head:1', 'tail:1', 'tail:2'])

    await removingHead
    await removeTail()
    await removeSymbol()
  })

  it('removes once listeners before recursive dispatch', async () => {
    const app = new Context()
    const callback = vi.fn(() => {
      app.emit('test/recursive')
    })
    const remove = app.once('test/recursive', callback)

    app.emit('test/recursive')
    app.emit('test/recursive')

    expect(callback).toHaveBeenCalledOnce()
    await remove()
  })

  it('keeps a once listener removed when its callback throws', () => {
    const app = new Context()
    const callback = vi.fn(() => {
      throw new Error('once failed')
    })
    app.once('test/error', callback)

    expect(() => app.emit('test/error')).toThrow('once failed')
    expect(() => app.emit('test/error')).not.toThrow()
    expect(callback).toHaveBeenCalledOnce()
  })

  it('runs a once listener at most once across overlapping snapshots', async () => {
    const app = new Context()
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const callback = vi.fn()

    app.on('test/once-overlap', async () => {
      markStarted()
      await gate
    })
    app.once('test/once-overlap', callback)

    const serial = app.serial('test/once-overlap')
    await started
    app.emit('test/once-overlap')
    release()
    await serial

    expect(callback).toHaveBeenCalledOnce()
  })

  it('automatically removes listeners when their owning Fiber unloads', async () => {
    const app = new Context()
    const callback = vi.fn()
    const fiber = app.installComponent((context) => {
      context.on('test/emit', callback)
    })

    await fiber
    app.emit('test/emit', 1)
    expect(callback).toHaveBeenCalledOnce()

    await fiber.dispose()
    app.emit('test/emit', 2)
    expect(callback).toHaveBeenCalledOnce()
  })

  it('rolls listeners back after startup failure', async () => {
    const app = new Context()
    const callback = vi.fn()
    const fiber = app.installComponent((context) => {
      context.on('test/emit', callback)
      throw new Error('startup failed')
    })

    await expect(fiber).rejects.toThrow('startup failed')
    app.emit('test/emit', 1)
    expect(callback).not.toHaveBeenCalled()
  })

  it('removes and recreates listeners across dependency-driven restarts', async () => {
    const app = new Context()
    const calls: string[] = []
    let run = 0
    const consumer = app.installComponent({
      inject: ['event-gate'],
      apply(context) {
        const current = ++run
        context.on('test/emit', value => {
          calls.push(`${current}:${value}`)
        })
      },
    })

    await consumer
    const removeFirst = app.provide('event-gate', true)
    await consumer
    app.emit('test/emit', 1)

    await removeFirst()
    app.emit('test/emit', 2)

    const removeSecond = app.provide('event-gate', true)
    await consumer
    app.emit('test/emit', 3)

    expect(calls).toEqual(['1:1', '2:3'])
    await consumer.dispose()
    await removeSecond()
  })

  it('clears root listeners on dispose and keeps the root reusable', async () => {
    const app = new Context()
    const oldListener = vi.fn()
    const newListener = vi.fn()

    app.on('test/emit', oldListener)
    await app.fiber.dispose()
    app.emit('test/emit', 1)
    expect(oldListener).not.toHaveBeenCalled()

    app.on('test/emit', newListener)
    app.emit('test/emit', 2)
    expect(newListener).toHaveBeenCalledOnce()
  })

  it('emits synchronously in order and stops at the first thrown error', () => {
    const app = new Context()
    const calls: string[] = []

    app.on('test/error', () => {
      calls.push('first')
    })
    app.on('test/error', () => {
      calls.push('error')
      throw new Error('emit failed')
    })
    app.on('test/error', () => {
      calls.push('last')
    })

    expect(() => app.emit('test/error')).toThrow('emit failed')
    expect(calls).toEqual(['first', 'error'])
  })

  it('waits for all parallel listeners and aggregates every failure', async () => {
    const app = new Context()
    const calls: string[] = []

    app.on('test/error', () => {
      calls.push('sync')
      throw new Error('sync failure')
    })
    app.on('test/error', async () => {
      await Promise.resolve()
      calls.push('async')
      throw new Error('async failure')
    })
    app.on('test/error', async () => {
      await Promise.resolve()
      calls.push('success')
    })

    const error = await app.parallel('test/error').catch(reason => reason)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: 'sync failure' }),
      expect.objectContaining({ message: 'async failure' }),
    ])
    expect(calls).toEqual(['sync', 'async', 'success'])
  })

  it('serializes listeners and stops at the first effective result', async () => {
    const app = new Context()
    const calls: string[] = []

    app.on('test/async-result', async (value) => {
      calls.push('false')
      return false
    })
    app.on('test/async-result', async (value) => {
      calls.push('value')
      await Promise.resolve()
      return value * 2
    })
    app.on('test/async-result', async () => {
      calls.push('last')
      return 100
    })

    await expect(app.serial('test/async-result', 3)).resolves.toBe(6)
    expect(calls).toEqual(['false', 'value'])
  })

  it('bails synchronously while treating zero as an effective result', () => {
    const app = new Context()
    const last = vi.fn(() => 10)

    app.on('test/result', () => null)
    app.on('test/result', () => false)
    app.on('test/result', () => 0)
    app.on('test/result', last)

    expect(app.bail('test/result', 1)).toBe(0)
    expect(last).not.toHaveBeenCalled()
  })

  it('builds an interceptable waterfall chain', () => {
    const app = new Context()
    const calls: string[] = []

    app.on('test/waterfall', (value, next) => {
      calls.push('first')
      return value + next()
    })
    app.on('test/waterfall', (value, next) => {
      calls.push('second')
      return value + next()
    })

    const fallback = vi.fn(() => 2)
    expect(app.waterfall('test/waterfall', 1, fallback)).toBe(4)
    expect(calls).toEqual(['first', 'second'])
    expect(fallback).toHaveBeenCalledWith(1, expect.any(Function))

    app.on('test/waterfall', (value) => {
      calls.push('stop')
      return value
    }, true)
    calls.length = 0

    expect(app.waterfall('test/waterfall', 1, () => 2)).toBe(1)
    expect(calls).toEqual(['stop'])
  })

  it('binds an explicit thisArg and filters listeners by subscription Context', () => {
    const app = new Context()
    const allowed = app.extend()
    const blocked = app.extend()
    const local = vi.fn(function (this: EventSubject, value: string) {
      expect(this).toBe(subject)
      expect(value).toBe('payload')
    })
    const filtered = vi.fn()
    const global = vi.fn()
    const subject: EventSubject = {
      id: 1,
      [Context.filter](context) {
        return context === allowed ? 1 : 0
      },
    }

    allowed.on('test/subject', local)
    blocked.on('test/subject', filtered)
    blocked.on('test/subject', global, { global: true })

    app.emit(subject, 'test/subject', 'payload')

    expect(local).toHaveBeenCalledOnce()
    expect(filtered).not.toHaveBeenCalled()
    expect(global).toHaveBeenCalledOnce()
  })

  it('uses a stable listener snapshot during dispatch', async () => {
    const app = new Context()
    const calls: string[] = []
    let removeSecond!: Disposer

    app.on('test/error', () => {
      calls.push('first')
      void removeSecond()
    })
    removeSecond = app.on('test/error', () => {
      calls.push('second')
    })

    app.emit('test/error')
    app.emit('test/error')
    expect(calls).toEqual(['first', 'second', 'first'])

    await removeSecond()
  })

  it('keeps independent roots isolated and disposes duplicate callbacks exactly', async () => {
    const first = new Context()
    const second = new Context()
    const callback = vi.fn()
    const removeFirst = first.on('test/emit', callback)
    const removeDuplicate = first.on('test/emit', callback)
    second.on('test/emit', callback)

    await removeFirst()
    first.emit('test/emit', 1)
    expect(callback).toHaveBeenCalledOnce()

    second.emit('test/emit', 2)
    expect(callback).toHaveBeenCalledTimes(2)
    await removeDuplicate()
  })

  it('rejects malformed runtime registrations and waterfall calls', () => {
    const app = new Context()

    expect(() => app.events.on(app, 1 as any, () => {})).toThrow('invalid event name')
    expect(() => app.events.on(app, 'test', null as any)).toThrow(
      'invalid event listener',
    )
    expect(() => app.events.waterfall('test/waterfall', 1, null)).toThrow(
      'waterfall requires a final next callback',
    )

    const foreign = new Context()
    expect(() => app.events.on(foreign, 'test', () => {})).toThrow(
      'another Context tree',
    )
  })
})
