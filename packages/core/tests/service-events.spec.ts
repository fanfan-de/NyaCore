/** 本文件验证 caller-bound Service 作为事件 thisArg 时的隔离过滤。 */

import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '../src/index.js'

interface ServiceEventSubject {
  publish(value: string): void
}

declare module '../src/index.js' {
  interface Events {
    'caller/service-event'(this: ServiceEventSubject, value: string): void
  }
}

function read<Value>(context: Context, name: string) {
  return context.get(name) as Value
}

describe('Service event isolation', () => {
  it('matches the caller label, shares explicit labels, and preserves global hooks', async () => {
    const app = new Context()
    const blueLabel = Symbol('blue service')
    const redLabel = Symbol('red service')
    const blueProviderScope = app.isolate('callerEventService', blueLabel)
    const blueListenerScope = app.isolate('callerEventService', blueLabel)
    const redListenerScope = app.isolate('callerEventService', redLabel)
    const defaultCalls: string[] = []
    const blueCalls: string[] = []
    const redCalls: string[] = []
    const globalCalls: string[] = []

    class EventService extends Service implements ServiceEventSubject {
      static provide = 'callerEventService'

      publish(value: string) {
        this.ctx.emit(this, 'caller/service-event', value)
      }
    }

    const defaultProvider = app.installComponent(EventService)
    const blueProvider = blueProviderScope.installComponent(EventService)
    await Promise.all([defaultProvider, blueProvider])

    let defaultFacade!: EventService
    let blueFacade!: EventService
    const defaultConsumer = app.inject(['callerEventService'], (context) => {
      defaultFacade = read<EventService>(context, 'callerEventService')
    })
    const blueConsumer = blueProviderScope.inject(
      ['callerEventService'],
      (context) => {
        blueFacade = read<EventService>(context, 'callerEventService')
      },
    )
    await Promise.all([defaultConsumer, blueConsumer])

    const removeDefault = app.on(
      'caller/service-event',
      function (value) {
        expect(this).toBe(defaultFacade)
        defaultCalls.push(value)
      },
    )
    const removeBlue = blueListenerScope.on(
      'caller/service-event',
      function (value) {
        expect(this).toBe(blueFacade)
        blueCalls.push(value)
      },
    )
    const removeRed = redListenerScope.on(
      'caller/service-event',
      value => redCalls.push(value),
    )
    const removeGlobal = redListenerScope.on(
      'caller/service-event',
      value => globalCalls.push(value),
      { global: true },
    )

    defaultFacade.publish('default')
    blueFacade.publish('blue')

    expect(defaultCalls).toEqual(['default'])
    expect(blueCalls).toEqual(['blue'])
    expect(redCalls).toEqual([])
    expect(globalCalls).toEqual(['default', 'blue'])

    await Promise.all([
      removeGlobal(),
      removeRed(),
      removeBlue(),
      removeDefault(),
      defaultConsumer.dispose(),
      blueConsumer.dispose(),
    ])
    await Promise.all([defaultProvider.dispose(), blueProvider.dispose()])
  })

  it('uses the original caller label when one Service dispatches through another', async () => {
    const app = new Context()
    const caller = app.isolate(
      'callerEventDownstream',
      Symbol('consumer downstream label'),
    )
    const defaultCalls = vi.fn()
    const callerCalls = vi.fn()

    class DownstreamService extends Service implements ServiceEventSubject {
      static provide = 'callerEventDownstream'

      publish(value: string) {
        this.ctx.emit(this, 'caller/service-event', value)
      }
    }

    class UpstreamService extends Service {
      static provide = 'callerEventUpstream'
      static inject = ['callerEventDownstream']

      publish(value: string) {
        read<DownstreamService>(this.ctx, 'callerEventDownstream')
          .publish(value)
      }
    }

    const downstreamProvider = app.installComponent(DownstreamService)
    await downstreamProvider
    const upstreamProvider = app.installComponent(UpstreamService)
    await upstreamProvider

    const removeDefault = app.on('caller/service-event', defaultCalls)
    const removeCaller = caller.on('caller/service-event', callerCalls)
    let upstream!: UpstreamService
    const consumer = caller.inject(['callerEventUpstream'], (context) => {
      upstream = read<UpstreamService>(context, 'callerEventUpstream')
    })
    await consumer

    upstream.publish('nested')

    expect(defaultCalls).not.toHaveBeenCalled()
    expect(callerCalls).toHaveBeenCalledOnce()
    expect(callerCalls).toHaveBeenCalledWith('nested')

    await Promise.all([
      removeCaller(),
      removeDefault(),
      consumer.dispose(),
    ])
    await upstreamProvider.dispose()
    await downstreamProvider.dispose()
  })

  it('rejects local hooks from another Root while global hooks still opt out', async () => {
    const first = new Context()
    const second = new Context()
    const local = vi.fn()
    const global = vi.fn()

    class EventService extends Service implements ServiceEventSubject {
      static provide = 'callerCrossRootEvent'

      publish(value: string) {
        this.ctx.emit(this, 'caller/service-event', value)
      }
    }

    const firstProvider = first.installComponent(EventService)
    const secondProvider = second.installComponent(EventService)
    await Promise.all([firstProvider, secondProvider])
    let foreignFacade!: EventService
    const foreignConsumer = second.inject(
      ['callerCrossRootEvent'],
      (context) => {
        foreignFacade = read<EventService>(context, 'callerCrossRootEvent')
      },
    )
    await foreignConsumer

    const removeLocal = first.on('caller/service-event', local)
    const removeGlobal = first.on(
      'caller/service-event',
      global,
      { global: true },
    )

    first.emit(foreignFacade, 'caller/service-event', 'foreign')

    expect(local).not.toHaveBeenCalled()
    expect(global).toHaveBeenCalledOnce()
    expect(global).toHaveBeenCalledWith('foreign')

    await Promise.all([
      removeGlobal(),
      removeLocal(),
      foreignConsumer.dispose(),
    ])
    await Promise.all([firstProvider.dispose(), secondProvider.dispose()])
  })
})
