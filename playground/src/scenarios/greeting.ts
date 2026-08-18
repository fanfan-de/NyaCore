/** 本文件演示问候组件的安装、启动等待和主动卸载流程。 */

import { Context, FiberState } from '@nya/core'
import type { Fiber } from '@nya/core'
import { greetingComponent } from '../components/greeting.ts'

const wait = (duration: number) => new Promise<void>(resolve => {
  setTimeout(resolve, duration)
})

function expectState(fiber: Fiber, expected: FiberState) {
  if (fiber.state !== expected) {
    throw new Error(
      `expected ${fiber.name} to be ${expected}, received ${fiber.state}`,
    )
  }
}

export async function runGreetingScenario() {
  console.log('\n--- greeting component scenario ---')

  const app = new Context()

  // 在当前 Context 中安装组件；每次调用都会创建独立的 Fiber 实例。
  const greeting = app.installComponent(greetingComponent, {
    interval: 200,
    message: '你好，NyaCore！',
  })

  // Fiber 是 thenable；等待它表示等待本次启动过程进入稳定状态。
  await greeting
  expectState(greeting, FiberState.ACTIVE)

  await wait(650)

  // 卸载 Fiber 会自动执行组件返回的清理函数以及登记的全部 Effect。
  await greeting.dispose()
  expectState(greeting, FiberState.DISPOSED)

  console.log('[scenario] greeting component verification passed\n')
}
