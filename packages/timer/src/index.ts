/** 调用方拥有的最小定时器服务；取消只停止后续调度，不等待在途回调。 */

import { Service } from '@nya/core'
import type { Context, Disposer } from '@nya/core'

export type TimerCallback = () => void | Promise<void>

declare module '@nya/core' {
  interface Context {
    timer: Timer
  }
}

type TimerKind = 'timeout' | 'interval'

function schedule(context: Context, kind: TimerKind, callback: TimerCallback, delay: number): Disposer {
  if (typeof callback !== 'function') throw new TypeError('timer callback must be a function')
  const minimum = kind === 'timeout' ? 0 : 1
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < minimum || delay > 2_147_483_647) {
    throw new RangeError(`${kind} delay must be a finite number from ${minimum} to 2147483647`)
  }

  // 预先捕获调用方 Logger，异步回调在 Provider 已卸载后失败仍可记录原错误。
  const logger = context.logger
  let active = true
  let handle: ReturnType<typeof setTimeout>
  let disposeEffect!: Disposer
  const clear = () => {
    active = false
    if (kind === 'timeout') clearTimeout(handle)
    else clearInterval(handle)
  }
  const dispose: Disposer = () => {
    // 在 Core 的异步 Effect 注销完成前，也立即阻止未来的回调。
    clear()
    return disposeEffect()
  }
  const report = (message: string, error: unknown) => {
    try { logger.error(message, error) } catch {
      // 日志观察不能让计时器任务产生未处理拒绝或改变调用方生命周期。
    }
  }
  const stop = () => {
    try {
      void Promise.resolve(dispose()).catch(error => report(`timer ${kind} cleanup failed`, error))
    } catch (error) {
      report(`timer ${kind} cleanup failed`, error)
    }
  }
  const fail = (error: unknown) => {
    stop()
    report(`timer ${kind} callback failed`, error)
  }
  const invoke = () => {
    if (!active) return
    if (kind === 'timeout') stop()
    try {
      void Promise.resolve(callback()).catch(fail)
    } catch (error) {
      fail(error)
    }
  }

  disposeEffect = context.effect(() => {
    handle = kind === 'timeout' ? setTimeout(invoke, delay) : setInterval(invoke, delay)
    return clear
  }, `ctx.timer.${kind}()`)
  return dispose
}

/** 显式安装后提供 ctx.timer；每个方法通过 Service facade 绑定调用方 Context。 */
export class Timer extends Service {
  static provide = 'timer'

  /** 一次性调用；触发时自动注销其 Effect，返回值也可用于提前取消。 */
  timeout(callback: TimerCallback, delay: number): Disposer {
    return schedule(this.ctx, 'timeout', callback, delay)
  }

  /** 原生间隔允许异步回调重叠；任意回调失败会停止之后的调度。 */
  interval(callback: TimerCallback, delay: number): Disposer {
    return schedule(this.ctx, 'interval', callback, delay)
  }
}
