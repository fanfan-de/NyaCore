/** 从公开 Application 边界验证装配、控制、真实关闭及自动演示取消。 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@nya/core'
import { createApplication } from '../src/application.js'
import { readConfig } from '../src/config.js'
import { createStorageComponent, storageComponent } from '../src/components/storage.js'
import type { JournalFile } from '../src/components/storage.js'
import { runDemo } from '../src/demo.js'
import { ApplicationClosedError } from '../src/types.js'
import type { Application, ApplicationConfig, JournalRecord } from '../src/types.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const applications: Application[] = []
const directories: string[] = []
const originalStorageApply = storageComponent.apply
const config = (file: string): ApplicationConfig => ({
  storage: { file }, job: { label: 'initial', intervalMs: 10 }, logLevel: 'error',
  startupTimeoutMs: 1000, shutdownTimeoutMs: 1000,
})
function application(input = config('memory')) {
  const app = createApplication(input)
  applications.push(app)
  return app
}
function memoryFile(overrides: Partial<JournalFile> = {}): JournalFile {
  return {
    read: vi.fn(async () => ''), append: vi.fn(async () => {}),
    flush: vi.fn(async () => {}), close: vi.fn(async () => {}), ...overrides,
  }
}
function useFile(file: JournalFile) {
  // 保留 async 入口种类；构造器形态的通用 mock 会改变 Core 的入口判定。
  storageComponent.apply = createStorageComponent(async () => file).apply
}
function nextRecord(app: Application) {
  const observed = deferred<JournalRecord>()
  const unsubscribe = app.context.on('journal/record', record => { observed.resolve(record) })
  return { promise: observed.promise.finally(() => unsubscribe()) }
}

afterEach(async () => {
  try {
    for (const app of applications.splice(0)) {
      // 成功和失败关闭都必须释放活动资源；lastFailure 与日志记录可继续用于诊断。
      await app.close().catch(() => {})
      expect(app.context.fiber.inspect()).toMatchObject({
        state: FiberState.ACTIVE, effects: [], children: [],
      })
      const observe = vi.fn()
      const unsubscribe = app.context.registry.subscribe(observe, { replay: true })
      await unsubscribe()
      expect(observe).not.toHaveBeenCalled()
    }
  } finally {
    storageComponent.apply = originalStorageApply
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  }
})

describe('application', () => {
  it.each([
    { input: null },
    { input: { ...config('memory'), unexpected: true } },
    { input: { ...config('memory'), storage: { file: '' } } },
    { input: { ...config('memory'), job: { intervalMs: 0, label: 'invalid' } } },
    { input: { ...config('memory'), logLevel: 'trace' } },
    { input: { ...config('memory'), shutdownTimeoutMs: 0 } },
  ])('rejects malformed embedded configuration synchronously before owning effects: $input', ({ input }) => {
    const effects = vi.spyOn(Context.prototype, 'effect')
    expect(() => createApplication(input as unknown as ApplicationConfig)).toThrow(TypeError)
    expect(effects).not.toHaveBeenCalled()
  })

  it('snapshots embedded inputs while preserving absolute paths produced by readConfig', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'nya-journal-config-boundary-'))
    directories.push(directory)
    const filename = join(directory, 'config.json')
    await writeFile(filename, JSON.stringify(config('./data/journal.jsonl')), 'utf8')
    const parsed = await readConfig(filename)
    const expectedFile = join(directory, 'data', 'journal.jsonl')
    expect(parsed.storage.file).toBe(expectedFile)
    const mutable = { ...parsed, storage: { ...parsed.storage }, job: { ...parsed.job } }
    const app = application(mutable)
    const changedFile = join(directory, 'changed.jsonl')
    mutable.storage.file = changedFile
    mutable.job.label = 'changed after create'
    mutable.job.intervalMs = 1000
    await app.start()
    expect(app.context.loader.get('storage')?.config).toEqual({ file: expectedFile })
    expect(app.context.loader.get('job')?.config).toEqual(parsed.job)
    const record = nextRecord(app)
    await vi.advanceTimersByTimeAsync(parsed.job.intervalMs)
    expect(await record.promise).toMatchObject({ sequence: 1, label: parsed.job.label })
    await app.close()
    expect(JSON.parse((await readFile(expectedFile, 'utf8')).trim())).toMatchObject({ sequence: 1, label: parsed.job.label })
    await expect(readFile(changedFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('starts sibling entries in a business group, writes to disk, updates and recovers dependencies', async () => {
    vi.useFakeTimers()
    const directory = await mkdtemp(join(tmpdir(), 'nya-journal-application-'))
    directories.push(directory)
    const file = join(directory, 'journal.jsonl')
    const app = application(config(file))
    await app.start()
    expect(app.context.loader.get('business')).toMatchObject({ type: 'group', state: 'active', children: ['job', 'storage'] })
    expect(app.context.loader.get('job')).toMatchObject({ state: 'active', parentId: 'business' })
    expect(app.context.loader.get('storage')).toMatchObject({ state: 'active', parentId: 'business' })
    expect(app.context.logger.records().some(record => record.message === 'job pending: waiting for journalStore')).toBe(true)
    const first = nextRecord(app)
    await vi.advanceTimersByTimeAsync(10)
    expect(await first.promise).toMatchObject({ sequence: 1, label: 'initial' })
    const beforeInvalid = app.context.loader.get('job')
    await expect(app.updateJob({ intervalMs: 0, label: 'invalid' })).rejects.toThrow('intervalMs')
    expect(app.context.loader.get('job')).toEqual(beforeInvalid)
    await app.updateJob({ intervalMs: 5, label: 'updated' })
    const updated = nextRecord(app)
    await vi.advanceTimersByTimeAsync(5)
    expect(await updated.promise).toMatchObject({ sequence: 2, label: 'updated' })
    await app.setEnabled('storage', false)
    expect(app.context.loader.get('storage')?.state).toBe('disabled')
    expect(app.context.loader.get('job')?.state).toBe('pending')
    const persisted = await readFile(file, 'utf8')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await readFile(file, 'utf8')).toBe(persisted)
    await app.setEnabled('storage', true)
    expect(app.context.loader.get('job')?.state).toBe('active')
    const restored = nextRecord(app)
    await vi.advanceTimersByTimeAsync(5)
    expect(await restored.promise).toMatchObject({ sequence: 3, label: 'updated' })
    await app.setEnabled('job', false)
    expect(app.context.loader.get('job')?.state).toBe('disabled')
    await app.setEnabled('job', true)
    expect(app.context.loader.get('job')?.state).toBe('active')
    await app.close()
    expect((await readFile(file, 'utf8')).trimEnd().split('\n')).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns the same real close task to concurrent and synchronous observer callers', async () => {
    vi.useFakeTimers()
    const gate = deferred()
    const entered = deferred()
    const file = memoryFile({ append: async () => { entered.resolve(); await gate.promise } })
    useFile(file)
    const app = application()
    await app.start()
    await vi.advanceTimersByTimeAsync(10)
    await entered.promise
    let reentered: Promise<void> | undefined
    app.context.logger.subscribe(record => {
      if (record.fiberId === app.context.fiber.id && record.fiberState === FiberState.UNLOADING) {
        reentered = app.close()
      }
    })
    const closing = app.close()
    expect(app.close()).toBe(closing)
    await expect(app.updateJob({ intervalMs: 10, label: 'late' })).rejects.toBeInstanceOf(ApplicationClosedError)
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(file.close).not.toHaveBeenCalled()
    gate.resolve()
    await closing
    expect(reentered).toBe(closing)
    expect(file.flush).toHaveBeenCalledOnce()
    expect(file.close).toHaveBeenCalledOnce()
    await expect(app.start()).rejects.toBeInstanceOf(ApplicationClosedError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases its Console sink so later root logs produce no console output', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    useFile(memoryFile())
    const app = application({ ...config('memory'), logLevel: 'info' })
    await app.start()
    expect(output).toHaveBeenCalledWith(expect.stringContaining('application started'))
    await app.close()
    output.mockClear()
    app.context.logger.info('after application close')
    expect(output).not.toHaveBeenCalled()
  })

  it('does not report readiness for corrupt persistent input', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const directory = await mkdtemp(join(tmpdir(), 'nya-journal-corrupt-'))
    directories.push(directory)
    const file = join(directory, 'journal.jsonl')
    await writeFile(file, '{broken}\n', 'utf8')
    const app = application(config(file))
    const error = await app.start().catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('not valid JSON')
    expect(await app.failure).toBe(error)
    expect(app.context.loader.get('storage')?.state).toBe('failed')
    expect(app.context.loader.get('job')?.state).toBe('pending')
    expect(app.context.logger.records().some(record => record.message === 'application started')).toBe(false)
    await app.close()
  })

  it.each([new Error('read failed while closing'), undefined])('preserves real startup failure during concurrent close (%s)', async error => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const entered = deferred()
    const gate = deferred()
    const file = memoryFile({ read: async () => {
      entered.resolve()
      await gate.promise
      throw error
    } })
    useFile(file)
    const app = application()
    const starting = app.start()
    void starting.catch(() => {})
    await entered.promise
    const closing = app.close()
    gate.resolve()
    await expect(starting).rejects.toBe(error)
    expect(await app.failure).toBe(error)
    await closing
    expect(file.flush).toHaveBeenCalledOnce()
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('treats a close before startup begins as cancellation and admits no business work', async () => {
    const file = memoryFile()
    useFile(file)
    const app = application()
    const starting = app.start()
    const closing = app.close()
    await expect(starting).rejects.toBeInstanceOf(ApplicationClosedError)
    await closing
    expect(file.read).not.toHaveBeenCalled()
    expect(file.close).not.toHaveBeenCalled()
  })

  it.each(['acquire', 'read'] as const)('cancels startup cleanly when close precedes a successful %s', async phase => {
    const entered = deferred()
    const gate = deferred()
    const file = memoryFile({ read: async () => {
      if (phase === 'read') { entered.resolve(); await gate.promise }
      return ''
    } })
    storageComponent.apply = createStorageComponent(async () => {
      if (phase === 'acquire') { entered.resolve(); await gate.promise }
      return file
    }).apply
    const app = application()
    let failed = false
    void app.failure.then(() => { failed = true })
    const starting = app.start()
    void starting.catch(() => {})
    await entered.promise
    const closing = app.close()
    gate.resolve()
    await expect(starting).rejects.toBeInstanceOf(ApplicationClosedError)
    await closing
    expect(failed).toBe(false)
    expect(file.flush).toHaveBeenCalledOnce()
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('exposes the first task failure without swallowing it during cleanup', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('write failed')
    const file = memoryFile({ append: async () => { throw error } })
    useFile(file)
    const app = application()
    await app.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(await app.failure).toBe(error)
    await expect(app.close()).rejects.toBe(error)
    expect(file.flush).toHaveBeenCalledOnce()
    expect(file.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('event-driven demo', () => {
  it('completes each update and enable stage after an actual persisted record event', async () => {
    vi.useFakeTimers()
    let contents = ''
    const file = memoryFile({
      read: async () => contents,
      append: async line => { contents += line },
    })
    useFile(file)
    const input = config('memory')
    const app = application(input)
    await app.start()
    let finished = false
    const demo = runDemo(app, input).then(() => { finished = true })
    for (let step = 0; step < 20 && !finished; step++) await vi.advanceTimersByTimeAsync(10)
    expect(finished).toBe(true)
    await demo
    const messages = app.context.logger.records().map(record => record.message)
    expect(messages).toEqual(expect.arrayContaining([
      'demo: job disabled', 'demo: job restored',
      'demo: storage disabled; job waits for its dependency', 'demo: storage restored',
    ]))
    const records = contents.trimEnd().split('\n').map(line => JSON.parse(line) as JournalRecord)
    expect(records[0].label).toBe('initial')
    expect(records.slice(1).every(record => record.label === 'initial (updated)')).toBe(true)
    expect(records.length).toBeGreaterThanOrEqual(4)
    expect(records.map(record => record.sequence)).toEqual(records.map((_record, index) => index + 1))
    await app.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes its actual event subscription on abort and stops further control operations', async () => {
    const context = new Context()
    const registered = deferred()
    const disposals: Array<{ calls: number }> = []
    const originalOn = context.events.on.bind(context.events)
    vi.spyOn(context.events, 'on').mockImplementation((...args) => {
      const dispose = originalOn(...args)
      if (args[1] !== 'journal/record') return dispose
      const count = { calls: 0 }
      disposals.push(count)
      registered.resolve()
      return () => { count.calls++; return dispose() }
    })
    const app: Application = {
      context, failure: new Promise(() => {}), start: vi.fn(async () => {}),
      updateJob: vi.fn(async () => {}), setEnabled: vi.fn(async () => {}),
      close: () => context.fiber.dispose(),
    }
    applications.push(app)
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const demo = runDemo(app, config('unused'), controller.signal)
    await registered.promise
    const reason = new Error('demo interrupted')
    controller.abort(reason)
    await expect(demo).rejects.toBe(reason)
    expect(disposals).toEqual([{ calls: 1 }])
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
    context.emit('journal/record', { sequence: 1, recordedAt: new Date().toISOString(), label: 'initial' })
    await Promise.resolve()
    expect(app.updateJob).not.toHaveBeenCalled()
    expect(app.setEnabled).not.toHaveBeenCalled()
  })

  it.each(['abort', 'failure'] as const)('cancels observation during an admitted update on %s, without starting another control', async source => {
    const context = new Context()
    const firstListener = deferred()
    const updateEntered = deferred()
    const updateGate = deferred()
    const failure = deferred<unknown>()
    const disposals: Array<{ calls: number }> = []
    const originalOn = context.events.on.bind(context.events)
    vi.spyOn(context.events, 'on').mockImplementation((...args) => {
      const dispose = originalOn(...args)
      if (args[1] !== 'journal/record') return dispose
      const count = { calls: 0 }
      disposals.push(count)
      firstListener.resolve()
      return () => { count.calls++; return dispose() }
    })
    const app: Application = {
      context, failure: failure.promise, start: vi.fn(async () => {}),
      updateJob: vi.fn(async () => { updateEntered.resolve(); await updateGate.promise }),
      setEnabled: vi.fn(async () => {}), close: () => context.fiber.dispose(),
    }
    applications.push(app)
    const controller = new AbortController()
    const demo = runDemo(app, config('unused'), controller.signal)
    await firstListener.promise
    context.emit('journal/record', { sequence: 1, recordedAt: new Date().toISOString(), label: 'initial' })
    await updateEntered.promise
    const reason = source === 'abort' ? new Error('stop during update') : undefined
    if (source === 'abort') controller.abort(reason)
    else failure.resolve(reason)
    await expect(demo).rejects.toBe(reason)
    expect(disposals).toEqual([{ calls: 1 }, { calls: 1 }])
    updateGate.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(app.updateJob).toHaveBeenCalledOnce()
    expect(app.setEnabled).not.toHaveBeenCalled()
  })
})
