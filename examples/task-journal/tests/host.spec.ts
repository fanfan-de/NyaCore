import { EventEmitter } from 'node:events'
import { Context } from '@nya/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateConfig } from '../src/config.js'
import { runHost } from '../src/host.js'
import type { HostOptions } from '../src/host.js'
import { ApplicationClosedError } from '../src/types.js'
import type { Application } from '../src/types.js'

function deferred<Value = void>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  const starting = deferred()
  const startEntered = deferred()
  const closing = deferred()
  const closeEntered = deferred()
  const failure = deferred<unknown>()
  const ready = deferred()
  const signals = new EventEmitter()
  const output = {
    log: vi.fn((message: string) => { if (message === 'application ready') ready.resolve() }),
    error: vi.fn(),
  }
  const application: Application = {
    context: new Context(),
    failure: failure.promise,
    start: vi.fn(() => { startEntered.resolve(); return starting.promise }),
    close: vi.fn(() => { closeEntered.resolve(); return closing.promise }),
    updateJob: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
  }
  const config = validateConfig({ startupTimeoutMs: 100, shutdownTimeoutMs: 50 })
  const options: HostOptions = {
    createApplication: () => application,
    signals,
    output,
    setExitCode: vi.fn(),
    forceExit: vi.fn(),
  }
  const expectReleased = () => {
    expect(signals.listenerCount('SIGINT')).toBe(0)
    expect(signals.listenerCount('SIGTERM')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }
  return { starting, startEntered, closing, closeEntered, failure, ready, signals, output, application, config, options, expectReleased }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('Node host lifecycle', () => {
  it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('waits for start and close on %s', async (signal, exitCode) => {
    const f = fixture()
    const running = runHost(f.config, f.options)
    await f.startEntered.promise
    expect(f.output.log).not.toHaveBeenCalled()
    f.starting.resolve()
    await f.ready.promise
    expect(vi.getTimerCount()).toBe(0)
    f.signals.emit(signal)
    await f.closeEntered.promise
    expect(f.output.log).not.toHaveBeenCalledWith('shutdown completed')
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode, reason: 'signal' })
    expect(f.application.close).toHaveBeenCalledTimes(1)
    expect(f.output.log.mock.calls.flat()).toEqual(['application ready', 'shutdown completed'])
    expect(f.options.setExitCode).toHaveBeenCalledWith(exitCode)
    expect(f.options.forceExit).not.toHaveBeenCalled()
    f.expectReleased()
  })

  it('registers signals before the application factory and skips startup after an early signal', async () => {
    const f = fixture()
    const running = runHost(f.config, {
      ...f.options,
      createApplication: () => { f.signals.emit('SIGTERM'); return f.application },
    })
    await f.closeEntered.promise
    expect(f.application.start).not.toHaveBeenCalled()
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode: 143, reason: 'signal' })
    expect(f.output.log).not.toHaveBeenCalledWith('application ready')
    f.expectReleased()
  })

  it('starts closing during pending initialization and absorbs ApplicationClosedError', async () => {
    const f = fixture()
    const running = runHost(f.config, f.options)
    await f.startEntered.promise
    f.signals.emit('SIGINT')
    await f.closeEntered.promise
    f.starting.reject(new ApplicationClosedError())
    await vi.advanceTimersByTimeAsync(0)
    expect(f.output.error).not.toHaveBeenCalled()
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode: 130, reason: 'signal' })
    expect(f.output.log).not.toHaveBeenCalledWith('application ready')
    f.expectReleased()
  })

  it('reports startup timeout, closes once and leaves the underlying startup promise intact', async () => {
    const f = fixture()
    let startupFinished = false
    void f.starting.promise.then(() => { startupFinished = true })
    const running = runHost(f.config, f.options)
    await f.startEntered.promise
    await vi.advanceTimersByTimeAsync(100)
    await f.closeEntered.promise
    expect(startupFinished).toBe(false)
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'startup-timeout' })
    expect(f.application.close).toHaveBeenCalledTimes(1)
    expect(f.options.forceExit).not.toHaveBeenCalled()
    expect(f.output.error).toHaveBeenCalledWith('startup timed out', expect.any(Error))
    expect(f.output.error).toHaveBeenCalledWith('startup diagnostic', expect.any(Object))
    f.starting.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(startupFinished).toBe(true)
    expect(f.output.log).not.toHaveBeenCalledWith('application ready')
    f.expectReleased()
  })

  it('retains one shutdown deadline across repeated signals and only forces exit on that deadline', async () => {
    const f = fixture()
    const running = runHost(f.config, f.options)
    f.starting.resolve()
    await f.ready.promise
    f.signals.emit('SIGINT')
    await f.closeEntered.promise
    await vi.advanceTimersByTimeAsync(30)
    f.signals.emit('SIGTERM')
    f.signals.emit('SIGINT')
    await vi.advanceTimersByTimeAsync(19)
    expect(f.options.forceExit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'shutdown-timeout' })
    expect(f.application.close).toHaveBeenCalledTimes(1)
    expect(f.options.forceExit).toHaveBeenCalledExactlyOnceWith(1)
    expect(f.output.error).toHaveBeenCalledWith('shutdown diagnostic', expect.any(Object))
    expect(f.output.log).not.toHaveBeenCalledWith('shutdown completed')
    f.expectReleased()
    const errors = f.output.error.mock.calls.length
    f.closing.reject(new Error('late cleanup'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.output.error).toHaveBeenCalledTimes(errors)
  })

  it('keeps shutdown timeout authoritative if public diagnostic inspection throws', async () => {
    const f = fixture()
    const inspectionError = new Error('inspection unavailable')
    vi.spyOn(f.application.context.fiber, 'inspect').mockImplementation(() => { throw inspectionError })
    const running = runHost(f.config, f.options)
    f.starting.resolve()
    await f.ready.promise
    f.signals.emit('SIGINT')
    await f.closeEntered.promise
    await vi.advanceTimersByTimeAsync(50)
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'shutdown-timeout' })
    expect(f.output.error).toHaveBeenCalledWith('shutdown timed out', expect.any(Error))
    expect(f.output.error).toHaveBeenCalledWith('shutdown diagnostic unavailable', inspectionError)
    expect(f.options.forceExit).toHaveBeenCalledExactlyOnceWith(1)
    f.closing.resolve()
    f.expectReleased()
  })

  it.each([new Error('runtime'), undefined, null, false])('preserves runtime failure %j and closes normally', async error => {
    const f = fixture()
    const running = runHost(f.config, f.options)
    f.starting.resolve()
    await f.ready.promise
    f.failure.resolve(error)
    await f.closeEntered.promise
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'failure' })
    expect(f.output.error).toHaveBeenCalledExactlyOnceWith('application failed', error)
    expect(f.options.forceExit).not.toHaveBeenCalled()
    f.expectReleased()
  })

  it('reports startup failure, closes and releases the startup deadline', async () => {
    const f = fixture()
    const error = new Error('open failed')
    const running = runHost(f.config, f.options)
    await f.startEntered.promise
    f.starting.reject(error)
    f.failure.resolve(error)
    await f.closeEntered.promise
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'failure' })
    expect(f.output.error).toHaveBeenCalledExactlyOnceWith('application failed', error)
    f.expectReleased()
  })

  it('uses error exit status when graceful signal cleanup fails', async () => {
    const f = fixture()
    const error = new Error('flush failed')
    const running = runHost(f.config, f.options)
    f.starting.resolve()
    await f.ready.promise
    f.signals.emit('SIGTERM')
    await f.closeEntered.promise
    f.closing.reject(error)
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'signal' })
    expect(f.output.error).toHaveBeenCalledWith('shutdown failed', error)
    expect(f.output.log).not.toHaveBeenCalledWith('shutdown completed')
    expect(f.options.forceExit).not.toHaveBeenCalled()
    f.expectReleased()
  })

  it('finishes a successful demo, waits for cleanup and exits zero', async () => {
    const f = fixture()
    const demo = deferred()
    const demoEntered = deferred()
    const runDemo = vi.fn(() => { demoEntered.resolve(); return demo.promise })
    const running = runHost(f.config, { ...f.options, demo: true, runDemo })
    f.starting.resolve()
    await demoEntered.promise
    expect(f.application.close).not.toHaveBeenCalled()
    demo.resolve()
    await f.closeEntered.promise
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode: 0, reason: 'demo-completed' })
    expect(f.output.log.mock.calls.flat()).toEqual(['application ready', 'demo completed', 'shutdown completed'])
    expect(runDemo).toHaveBeenCalledWith(f.application, f.config, expect.any(AbortSignal))
    f.expectReleased()
  })

  it.each([
    { signalName: 'SIGINT', exitCode: 130, applicationClosed: false },
    { signalName: 'SIGTERM', exitCode: 143, applicationClosed: true },
  ])('aborts a running demo on $signalName without reporting cancellation as runtime failure', async ({ signalName, exitCode, applicationClosed }) => {
    const f = fixture()
    const demoEntered = deferred<AbortSignal>()
    const runDemo = vi.fn((_application: Application, _config: unknown, signal: AbortSignal) => {
      demoEntered.resolve(signal)
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(applicationClosed ? new ApplicationClosedError() : signal.reason), { once: true })
      })
    })
    const running = runHost(f.config, { ...f.options, demo: true, runDemo })
    f.starting.resolve()
    const signal = await demoEntered.promise
    f.signals.emit(signalName)
    await f.closeEntered.promise
    expect(signal.aborted).toBe(true)
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode, reason: 'signal' })
    expect(f.output.log).not.toHaveBeenCalledWith('demo completed')
    expect(f.output.error).not.toHaveBeenCalled()
    f.expectReleased()
  })

  it('closes when the demo fails', async () => {
    const f = fixture()
    const error = new Error('demo failed')
    const running = runHost(f.config, {
      ...f.options, demo: true, runDemo: async () => { throw error },
    })
    f.starting.resolve()
    await f.closeEntered.promise
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'failure' })
    expect(f.output.error).toHaveBeenCalledWith('application failed', error)
    f.expectReleased()
  })

  it('reports a genuine demo cleanup failure after a signal instead of treating it as cancellation', async () => {
    const f = fixture()
    const demo = deferred()
    const demoEntered = deferred()
    const error = new Error('demo cleanup failed after signal')
    const running = runHost(f.config, {
      ...f.options,
      demo: true,
      runDemo: () => { demoEntered.resolve(); return demo.promise },
    })
    f.starting.resolve()
    await demoEntered.promise
    f.signals.emit('SIGINT')
    await f.closeEntered.promise
    demo.reject(error)
    await vi.advanceTimersByTimeAsync(0)
    f.closing.resolve()
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'signal' })
    expect(f.output.error).toHaveBeenCalledWith('application failed', error)
    expect(f.output.log).not.toHaveBeenCalledWith('demo completed')
    f.expectReleased()
  })

  it('waits for demo cleanup after application close succeeds and preserves a later demo failure', async () => {
    const f = fixture()
    const demo = deferred()
    const demoEntered = deferred()
    const error = new Error('late demo cleanup failed')
    const running = runHost(f.config, {
      ...f.options, demo: true,
      runDemo: () => { demoEntered.resolve(); return demo.promise },
    })
    let finished = false
    void running.then(() => { finished = true })
    f.starting.resolve()
    await demoEntered.promise
    f.signals.emit('SIGINT')
    await f.closeEntered.promise
    f.closing.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).toBe(false)
    expect(f.output.log).not.toHaveBeenCalledWith('shutdown completed')
    demo.reject(error)
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'signal' })
    expect(f.output.error).toHaveBeenCalledWith('application failed', error)
    expect(f.options.forceExit).not.toHaveBeenCalled()
    f.expectReleased()
  })

  it('applies the original shutdown deadline to a hanging demo cleanup after the app closes', async () => {
    const f = fixture()
    const demo = deferred()
    const demoEntered = deferred<AbortSignal>()
    const running = runHost(f.config, {
      ...f.options, demo: true,
      runDemo: (_app, _config, signal) => { demoEntered.resolve(signal); return demo.promise },
    })
    f.starting.resolve()
    const signal = await demoEntered.promise
    f.signals.emit('SIGINT')
    await f.closeEntered.promise
    f.closing.resolve()
    await vi.advanceTimersByTimeAsync(30)
    f.signals.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(19)
    expect(f.options.forceExit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'shutdown-timeout' })
    expect(f.options.forceExit).toHaveBeenCalledExactlyOnceWith(1)
    expect(f.application.close).toHaveBeenCalledOnce()
    expect(f.output.log).not.toHaveBeenCalledWith('shutdown completed')
    demo.reject(signal.reason)
    f.expectReleased()
  })

  it('keeps waiting for demo cleanup after application close fails and reports both independent errors', async () => {
    const f = fixture()
    const demo = deferred()
    const demoEntered = deferred()
    const closeError = new Error('application close failed')
    const demoError = new Error('demo cleanup failed')
    const running = runHost(f.config, {
      ...f.options, demo: true,
      runDemo: () => { demoEntered.resolve(); return demo.promise },
    })
    let finished = false
    void running.then(() => { finished = true })
    f.starting.resolve()
    await demoEntered.promise
    f.signals.emit('SIGINT')
    await f.closeEntered.promise
    f.closing.reject(closeError)
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).toBe(false)
    expect(f.output.error).toHaveBeenCalledWith('shutdown failed', closeError)
    demo.reject(demoError)
    await expect(running).resolves.toEqual({ exitCode: 1, reason: 'signal' })
    expect(f.output.error).toHaveBeenCalledWith('application failed', demoError)
    expect(f.output.error).toHaveBeenCalledTimes(2)
    f.expectReleased()
  })

  it('releases signal handlers when constructing the application fails', async () => {
    const f = fixture()
    const error = new Error('construction failed')
    await expect(runHost(f.config, {
      ...f.options, createApplication: () => { throw error },
    })).resolves.toEqual({ exitCode: 1, reason: 'failure' })
    expect(f.application.close).not.toHaveBeenCalled()
    expect(f.output.error).toHaveBeenCalledWith('application failed', error)
    expect(f.options.forceExit).not.toHaveBeenCalled()
    f.expectReleased()
  })
})
