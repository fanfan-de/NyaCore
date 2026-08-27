/** 本文件演示 Service 调用方 Context、隔离事件过滤和普通 provide 值 identity 的组合语义。 */

import { Context, FiberState, Service } from '@nya/core'
import type { Fiber } from '@nya/core'

interface PlaygroundAnnouncer {
  inspectCaller(): Promise<{ fiber: Fiber; root: Context }>
  publish(message: string): void
  registerCallerCleanup(callback: () => void): void
}

declare module '@nya/core' {
  interface Context {
    announcer: PlaygroundAnnouncer
  }

  interface Events {
    'playground/announcement'(message: string): void
  }
}

class AnnouncerService extends Service implements PlaygroundAnnouncer {
  static provide = 'announcer'

  constructor(context: Context) {
    super(context)
  }

  // 需要调用方 this.ctx 的入口必须是 prototype 普通方法；箭头函数字段会
  // 词法绑定原实例，访问原生 #private 字段的方法也不能通过 Proxy 调用。
  async inspectCaller() {
    await Promise.resolve()
    return { fiber: this.ctx.fiber, root: this.ctx.root }
  }

  publish(message: string) {
    this.ctx.emit(this, 'playground/announcement', message)
  }

  registerCallerCleanup(callback: () => void) {
    this.ctx.effect(() => callback)
  }
}

function expectActive(fiber: Fiber) {
  if (fiber.state !== FiberState.ACTIVE) {
    throw new Error(`expected ${fiber.name} to be ACTIVE, received ${fiber.state}`)
  }
}

export async function runServiceCallerContextScenario() {
  console.log('\n--- service caller Context scenario ---')

  const app = new Context()
  const firstContext = app.isolate('announcer', Symbol('first announcer'))
  const secondContext = app.isolate('announcer', Symbol('second announcer'))
  const firstMessages: string[] = []
  const secondMessages: string[] = []
  const globalMessages: string[] = []
  const cleanupCounts: { first: number; second: number } = {
    first: 0,
    second: 0,
  }
  const expectCleanupCounts = (first: number, second: number) => {
    if (cleanupCounts.first !== first || cleanupCounts.second !== second) {
      throw new Error(
        `expected caller cleanup counts ${first}:${second}, received ${cleanupCounts.first}:${cleanupCounts.second}`,
      )
    }
  }

  const firstListener = firstContext.installComponent((context) => {
    context.on('playground/announcement', (message) => {
      firstMessages.push(message)
    })
  })
  const secondListener = secondContext.installComponent((context) => {
    context.on('playground/announcement', (message) => {
      secondMessages.push(message)
    })
  })
  const globalListener = app.installComponent((context) => {
    context.on('playground/announcement', (message) => {
      globalMessages.push(message)
    }, { global: true })
  })
  await Promise.all([firstListener, secondListener, globalListener])

  const firstProvider = firstContext.installComponent(AnnouncerService)
  const secondProvider = secondContext.installComponent(AnnouncerService)
  await Promise.all([firstProvider, secondProvider])

  const firstConsumer = firstContext.installComponent({
    name: 'playground-first-announcer-consumer',
    inject: ['announcer'],

    async apply(context) {
      const caller = await context.announcer.inspectCaller()
      if (caller.root !== app || caller.fiber !== context.fiber) {
        throw new Error('first Service call did not preserve its caller Context')
      }

      context.announcer.registerCallerCleanup(() => {
        cleanupCounts.first += 1
      })
      context.announcer.publish('first')
    },
  })
  const secondConsumer = secondContext.installComponent({
    name: 'playground-second-announcer-consumer',
    inject: ['announcer'],

    async apply(context) {
      const caller = await context.announcer.inspectCaller()
      if (caller.root !== app || caller.fiber !== context.fiber) {
        throw new Error('second Service call did not preserve its caller Context')
      }

      context.announcer.registerCallerCleanup(() => {
        cleanupCounts.second += 1
      })
      context.announcer.publish('second')
    },
  })
  await Promise.all([firstConsumer, secondConsumer])

  expectActive(firstConsumer)
  expectActive(secondConsumer)
  if (
    firstMessages.join() !== 'first'
    || secondMessages.join() !== 'second'
    || globalMessages.join() !== 'first,second'
  ) {
    throw new Error('Service events escaped their isolation address')
  }

  await firstConsumer.dispose()
  expectCleanupCounts(1, 0)
  await secondConsumer.dispose()
  expectCleanupCounts(1, 1)

  const ordinary = { kind: 'ordinary provide value' }
  const removeOrdinary = app.provide('ordinary', ordinary)
  if (app.get('ordinary') !== ordinary) {
    throw new Error('ordinary provide values must not be wrapped')
  }

  await removeOrdinary()
  await Promise.all([firstProvider.dispose(), secondProvider.dispose()])
  await Promise.all([
    firstListener.dispose(),
    secondListener.dispose(),
    globalListener.dispose(),
  ])

  console.log('[scenario] Service caller Context verification passed\n')
}
