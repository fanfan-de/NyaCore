/** Node 宿主拥有信号和期限；应用自己的 Core 生命周期任务不会被竞速取消。 */

import { createApplication } from './application.js'
import { runDemo } from './demo.js'
import { ApplicationClosedError } from './types.js'
import type { Application, ApplicationConfig } from './types.js'

type Signal = 'SIGINT' | 'SIGTERM'

export interface SignalSource {
  on(signal: Signal, listener: () => void): unknown
  off(signal: Signal, listener: () => void): unknown
}

export interface HostOutput {
  log(message: string): void
  error(message: string, error?: unknown): void
}

export interface HostOptions {
  readonly demo?: boolean
  readonly createApplication?: (config: ApplicationConfig) => Application
  readonly runDemo?: (application: Application, config: ApplicationConfig, signal: AbortSignal) => Promise<void>
  readonly signals?: SignalSource
  readonly output?: HostOutput
  readonly setExitCode?: (code: number) => void
  readonly forceExit?: (code: number) => void
}

type StopReason =
  | { readonly kind: 'signal'; readonly signal: Signal }
  | { readonly kind: 'demo-completed' }
  | { readonly kind: 'failure'; readonly error: unknown }
  | { readonly kind: 'startup-timeout'; readonly error: Error }

export interface HostResult {
  readonly exitCode: number
  readonly reason: StopReason['kind'] | 'shutdown-timeout'
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(fulfill => { resolve = fulfill })
  return { promise, resolve }
}

export async function runHost(config: ApplicationConfig, options: HostOptions = {}): Promise<HostResult> {
  const signals = options.signals ?? process
  const output = options.output ?? console
  const setExitCode = options.setExitCode ?? (code => { process.exitCode = code })
  const forceExit = options.forceExit ?? (code => { process.exit(code) })
  const stop = deferred<StopReason>()
  const controller = new AbortController()
  const failures: unknown[] = []
  let reason: StopReason | undefined
  let application: Application | undefined
  let demoTask: Promise<boolean> | undefined
  let finished = false
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined
  let forced = false
  let result!: HostResult

  const report = (message: string, error: unknown) => {
    if (finished || failures.some(previous => Object.is(previous, error))) return
    failures.push(error)
    output.error(message, error)
  }
  const diagnose = (phase: 'startup' | 'shutdown') => {
    if (!application) return
    // 诊断是辅助输出；读取失败不能替换期限错误或阻止清理及强制退出。
    try {
      output.error(`${phase} diagnostic`, application.context.fiber.inspect())
    } catch (error) {
      output.error(`${phase} diagnostic unavailable`, error)
    }
  }
  const requestStop = (next: StopReason) => {
    if (finished) return
    if (next.kind === 'failure' || next.kind === 'startup-timeout') {
      report(next.kind === 'startup-timeout' ? 'startup timed out' : 'application failed', next.error)
      if (next.kind === 'startup-timeout') diagnose('startup')
    }
    if (reason) return
    reason = next
    controller.abort()
    stop.resolve(next)
  }
  const onInterrupt = () => requestStop({ kind: 'signal', signal: 'SIGINT' })
  const onTerminate = () => requestStop({ kind: 'signal', signal: 'SIGTERM' })

  // 先登记信号，再调用工厂和 start；初始化尚未完成时也能进入同一个关闭流程。
  signals.on('SIGINT', onInterrupt)
  signals.on('SIGTERM', onTerminate)
  try {
    try {
      application = (options.createApplication ?? createApplication)(config)
      void application.failure.then(
        error => requestStop({ kind: 'failure', error }),
        error => requestStop({ kind: 'failure', error }),
      )
      if (!reason) {
        startupTimer = setTimeout(() => requestStop({
          kind: 'startup-timeout',
          error: new Error(`startup exceeded ${config.startupTimeoutMs} ms`),
        }), config.startupTimeoutMs)
        const starting = Promise.resolve().then(async () => {
          if (reason) return false
          await application!.start()
          return true
        }).catch(error => {
          if (!(reason && error instanceof ApplicationClosedError)) requestStop({ kind: 'failure', error })
          return false
        })
        const started = await Promise.race([starting, stop.promise.then(() => false)])
        clearTimeout(startupTimer)
        startupTimer = undefined
        if (started && !reason) {
          output.log('application ready')
          if (options.demo && !reason) {
            demoTask = Promise.resolve().then(() => (options.runDemo ?? runDemo)(application!, config, controller.signal)).then(
              () => {
                if (reason || finished) return true
                output.log('demo completed')
                requestStop({ kind: 'demo-completed' })
                return true
              },
              error => {
                if (controller.signal.aborted && (
                  Object.is(error, controller.signal.reason) || error instanceof ApplicationClosedError
                )) return true
                requestStop({ kind: 'failure', error })
                return false
              },
            )
            void demoTask.catch(error => requestStop({ kind: 'failure', error }))
          }
        }
      }
    } catch (error) {
      requestStop({ kind: 'failure', error })
    }

    const requested = reason ?? await stop.promise
    clearTimeout(startupTimer)
    startupTimer = undefined
    if (application) {
      // 应用与 demo 的收尾共用一个期限；各自失败仍继续等待另一项。
      // close 只调用一次，重复信号不会重置期限，超时后仍保留拒绝处理器。
      const closing = Promise.all([
        Promise.resolve().then(() => application!.close()).then(
          () => true,
          error => { report('shutdown failed', error); return false },
        ),
        (demoTask ?? Promise.resolve(true)).catch(error => {
          report('demo shutdown failed', error)
          return false
        }),
      ]).then(outcomes => ({ kind: outcomes.every(Boolean) ? 'closed' as const : 'failed' as const }))
      const deadline = new Promise<{ kind: 'timeout' }>(resolve => {
        shutdownTimer = setTimeout(() => resolve({ kind: 'timeout' }), config.shutdownTimeoutMs)
      })
      const closed = await Promise.race([closing, deadline])
      clearTimeout(shutdownTimer)
      shutdownTimer = undefined
      if (closed.kind === 'timeout') {
        forced = true
        report('shutdown timed out', new Error(`shutdown exceeded ${config.shutdownTimeoutMs} ms`))
        diagnose('shutdown')
      } else if (closed.kind === 'closed') {
        output.log('shutdown completed')
      }
    } else {
      output.log('shutdown completed')
    }

    const signalCode = requested.kind === 'signal' ? (requested.signal === 'SIGINT' ? 130 : 143) : 0
    result = { exitCode: failures.length ? 1 : signalCode, reason: forced ? 'shutdown-timeout' : requested.kind }
  } finally {
    finished = true
    clearTimeout(startupTimer)
    clearTimeout(shutdownTimer)
    signals.off('SIGINT', onInterrupt)
    signals.off('SIGTERM', onTerminate)
  }
  setExitCode(result.exitCode)
  if (forced) forceExit(1)
  return result
}
