/** 由 strict typecheck 编译，验证公开入口与 Context 模块扩展。 */
import type { Context, Disposer, Service } from '@nya/core'
import { Timer } from '../src/index.js'
import type { TimerCallback } from '../src/index.js'

function publicApi(context: Context) {
  const timer: Service = context.timer
  const callback: TimerCallback = async () => {}
  const timeout: Disposer = context.timer.timeout(callback, 0)
  const interval: Disposer = context.timer.interval(() => {}, 1)
  context.installComponent(Timer)
  // @ts-expect-error callback is required
  context.timer.timeout(10)
  // @ts-expect-error delay must be numeric
  context.timer.interval(callback, '10')
  // @ts-expect-error async callback must resolve without a value
  context.timer.timeout(async () => 1, 10)
  // @ts-expect-error there is no Context mixin
  context.timeout(callback, 10)
  return { timer, timeout, interval }
}

void publicApi
