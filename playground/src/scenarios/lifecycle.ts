/** 本文件通过父子 Component 场景人工验证启动、运行和级联卸载的完整生命周期。 */

import { Context, FiberState } from '@nya/core'
import type { Fiber } from '@nya/core'
import { heartbeatComponent } from '../components/heartbeat.ts'

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

export async function runLifecycleScenario() {
  console.log('\n--- lifecycle scenario ---')

  const app = new Context()
  let child!: Fiber

  const parent = app.installComponent({
    name: 'playground-parent',

    apply(context) {
      console.log('[parent] component started')
      child = context.installComponent(heartbeatComponent, {
        interval: 250,
        label: 'child',
      })

      return () => {
        console.log('[parent] component disposed')
      }
    },
  })

  await parent
  await child
  expectState(parent, FiberState.ACTIVE)
  expectState(child, FiberState.ACTIVE)

  await wait(800)
  console.log('[scenario] disposing parent')
  await parent.dispose()

  expectState(parent, FiberState.DISPOSED)
  expectState(child, FiberState.DISPOSED)
  console.log('[scenario] lifecycle verification passed\n')
}
