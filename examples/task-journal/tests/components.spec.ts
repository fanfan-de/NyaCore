/** 用真实文件和显式 gate 验证业务资源的持久化、串行执行与关闭顺序。 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@nya/core'
import { Timer } from '@nya/timer'
import { createStorageComponent } from '../src/components/storage.js'
import type { JournalFile } from '../src/components/storage.js'
import { jobComponent } from '../src/components/job.js'
import type { JournalRecord } from '../src/types.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const roots: Context[] = []
const directories: string[] = []
const root = () => {
  const context = new Context()
  roots.push(context)
  return context
}
function memoryFile(overrides: Partial<JournalFile> = {}): JournalFile {
  return {
    read: vi.fn(async () => ''),
    append: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  }
}

afterEach(async () => {
  for (const context of roots.splice(0)) await context.fiber.dispose().catch(() => {})
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('JSONL storage', () => {
  it('persists complete records and continues their sequence when reopened', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nya-journal-components-'))
    directories.push(directory)
    const file = join(directory, 'nested', 'records.jsonl')
    const context = root()
    const first = context.installComponent(createStorageComponent(), { file })
    await first
    const one = await context.journalStore.append('first')
    const two = await context.journalStore.append('second')
    await first.dispose()
    const second = context.installComponent(createStorageComponent(), { file })
    await second
    const three = await context.journalStore.append('third')
    await second.dispose()
    const contents = await readFile(file, 'utf8')
    expect(contents.endsWith('\n')).toBe(true)
    expect(contents.trimEnd().split('\n').map(line => JSON.parse(line))).toEqual([one, two, three])
    expect([one.sequence, two.sequence, three.sequence]).toEqual([1, 2, 3])
  })

  it('serializes writes, then drains, flushes and closes in that order', async () => {
    const gate = deferred()
    const entered = deferred()
    const order: string[] = []
    const file = memoryFile({
      append: vi.fn(async line => {
        const record = JSON.parse(line) as JournalRecord
        order.push(`write ${record.sequence}`)
        if (record.sequence === 1) { entered.resolve(); await gate.promise }
      }),
      flush: vi.fn(async () => { order.push('flush') }),
      close: vi.fn(async () => { order.push('close') }),
    })
    const context = root()
    const fiber = context.installComponent(createStorageComponent(async () => file), { file: 'memory' })
    await fiber
    const store = context.journalStore
    const first = store.append('one')
    const second = store.append('two')
    await entered.promise
    const closing = fiber.dispose()
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(order).toEqual(['write 1'])
    gate.resolve()
    await Promise.all([first, second, closing])
    expect(order).toEqual(['write 1', 'write 2', 'flush', 'close'])
    await expect(store.append('too late')).rejects.toThrow('journal is closing')
    await fiber.dispose()
    expect(file.close).toHaveBeenCalledOnce()
  })

  it.each([new Error('write failed'), undefined, false])('preserves a failed write (%s) and still flushes and closes', async error => {
    const file = memoryFile({ append: vi.fn(async () => { throw error }) })
    const context = root()
    const fiber = context.installComponent(createStorageComponent(async () => file), { file: 'memory' })
    await fiber
    const store = context.journalStore
    await expect(store.append('first')).rejects.toBe(error)
    await expect(store.append('second')).rejects.toBe(error)
    await expect(fiber.dispose()).rejects.toBe(error)
    expect(file.append).toHaveBeenCalledOnce()
    expect(file.flush).toHaveBeenCalledOnce()
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('retains independent write, flush and close errors in order', async () => {
    const errors = [new Error('write'), new Error('flush'), new Error('close')]
    const file = memoryFile({
      append: async () => { throw errors[0] },
      flush: async () => { throw errors[1] },
      close: async () => { throw errors[2] },
    })
    const context = root()
    const fiber = context.installComponent(createStorageComponent(async () => file), { file: 'memory' })
    await fiber
    await expect(context.journalStore.append('record')).rejects.toBe(errors[0])
    const outcome = await fiber.dispose().catch(error => error)
    expect(outcome).toBeInstanceOf(AggregateError)
    expect(outcome.errors).toEqual(errors)
    outcome.errors.forEach((error: unknown, index: number) => expect(error).toBe(errors[index]))
  })

  it('rejects corrupt input and closes the acquired resource during rollback', async () => {
    const file = memoryFile({ read: async () => '{"sequence":1}' })
    const context = root()
    const fiber = context.installComponent(createStorageComponent(async () => file), { file: 'memory' })
    await expect(Promise.resolve(fiber)).rejects.toThrow('incomplete JSONL record')
    expect(fiber.state).toBe(FiberState.FAILED)
    expect(file.flush).toHaveBeenCalledOnce()
    expect(file.close).toHaveBeenCalledOnce()
  })

  it.each(['acquire', 'read'] as const)('closes an acquired file when disposal starts during %s', async phase => {
    const gate = deferred()
    const entered = deferred()
    const file = memoryFile({ read: async () => {
      if (phase === 'read') { entered.resolve(); await gate.promise }
      return ''
    } })
    const context = root()
    const fiber = context.installComponent(createStorageComponent(async () => {
      if (phase === 'acquire') { entered.resolve(); await gate.promise }
      return file
    }), { file: 'memory' })
    const starting = Promise.resolve(fiber)
    void starting.catch(() => {})
    await entered.promise
    const closing = context.fiber.dispose()
    expect(file.close).not.toHaveBeenCalled()
    gate.resolve()
    await Promise.allSettled([starting, closing])
    expect(file.flush).toHaveBeenCalledOnce()
    expect(file.close).toHaveBeenCalledOnce()
    expect(fiber.state).toBe(FiberState.DISPOSED)
  })
})

describe('serial job', () => {
  it('waits for the triggered write when timer auto-disposal logs synchronously unload the job', async () => {
    vi.useFakeTimers()
    const gate = deferred<JournalRecord>()
    const entered = deferred()
    const order: string[] = []
    const append = vi.fn(() => {
      order.push('write entered')
      entered.resolve()
      return gate.promise
    })
    const context = root()
    context.provide('journalStore', { append })
    await context.installComponent(Timer)
    const fiber = context.installComponent(jobComponent, { intervalMs: 10, label: 'reentrant-close' })
    await fiber
    let closing: Promise<void> | undefined
    let closed = false
    const unsubscribe = context.logger.subscribe(record => {
      if (
        closing || record.fiberId !== fiber.id
        || record.message !== 'effect ctx.timer.timeout() is disposing'
      ) return
      order.push('close requested')
      closing = fiber.dispose()
      void closing.then(() => { closed = true })
    })
    const record = { sequence: 1, recordedAt: new Date().toISOString(), label: 'reentrant-close' }
    try {
      await vi.advanceTimersByTimeAsync(10)
      await entered.promise
      expect(order).toEqual(['close requested', 'write entered'])
      expect(closing).toBeDefined()
      expect(closed).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(closed).toBe(false)
      expect(append).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      // 断言失败也释放真实业务 gate，保证 afterEach 可以完成 Root 清理。
      gate.resolve(record)
    }
    await closing
    expect(closed).toBe(true)
    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(fiber.inspect().effects).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(append).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await unsubscribe()
    await context.fiber.dispose()
    expect(context.fiber.inspect().effects).toEqual([])
  })

  it('never overlaps ticks and waits for the active write before disposal resolves', async () => {
    vi.useFakeTimers()
    const gate = deferred<JournalRecord>()
    const append = vi.fn(() => gate.promise)
    const context = root()
    context.provide('journalStore', { append })
    await context.installComponent(Timer)
    const records: JournalRecord[] = []
    context.on('journal/record', record => { records.push(record) })
    const fiber = context.installComponent(jobComponent, { intervalMs: 10, label: 'gated' })
    await fiber
    expect(fiber.state).toBe(FiberState.ACTIVE)
    await vi.advanceTimersByTimeAsync(10)
    expect(append).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(append).toHaveBeenCalledOnce()
    const closing = fiber.dispose()
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    const record = { sequence: 1, recordedAt: new Date().toISOString(), label: 'gated' }
    gate.resolve(record)
    await closing
    expect(records).toEqual([record])
    await vi.advanceTimersByTimeAsync(1000)
    expect(append).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports the original write error, stops scheduling, and rejects cleanup with it', async () => {
    vi.useFakeTimers()
    const error = new Error('disk unavailable')
    const append = vi.fn(async () => { throw error })
    const context = root()
    context.provide('journalStore', { append })
    await context.installComponent(Timer)
    const failed = vi.fn()
    context.on('journal/failure', failed)
    const fiber = context.installComponent(jobComponent, { intervalMs: 10, label: 'failure' })
    await fiber
    await vi.advanceTimersByTimeAsync(1000)
    expect(append).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledExactlyOnceWith(error)
    await expect(fiber.dispose()).rejects.toBe(error)
    expect(vi.getTimerCount()).toBe(0)
  })
})
