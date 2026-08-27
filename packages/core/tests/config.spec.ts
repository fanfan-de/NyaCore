/** 本文件验证 Standard Schema 配置校验、Fiber 更新重启、并发收敛和更新 waterfall 扩展语义。 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import { describe, expect, it, vi } from 'vitest'
import {
  Context,
  Fiber,
  FiberState,
  ValidationError,
} from '../src/index.js'
import type { Component } from '../src/index.js'

interface NumberConfig {
  value: number
}

function createSchema<Output>(
  validate: StandardSchemaV1<unknown, Output>['~standard']['validate'],
): StandardSchemaV1<unknown, Output> {
  return {
    '~standard': {
      version: 1,
      vendor: 'nya-test',
      validate,
    },
  }
}

function createNumberSchema() {
  return createSchema<NumberConfig>((input) => {
    const value = input && typeof input === 'object'
      ? Reflect.get(input, 'value')
      : undefined
    return {
      value: {
        value: value === undefined ? 10 : Number(value),
      },
    }
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('component config schema', () => {
  it('preserves a config reference when the component has no schema', async () => {
    const app = new Context()
    const config = { value: 42 }
    const apply = vi.fn()
    const fiber = app.installComponent({ apply }, config)

    await fiber

    expect(apply).toHaveBeenCalledWith(fiber.context, config)
    expect(fiber.config).toBe(config)
  })

  it('passes defaulted and converted config to function, object, and class components', async () => {
    const app = new Context()
    const schema = createNumberSchema()
    const received: Array<[string, NumberConfig]> = []

    const functionComponent: Component.Function<NumberConfig> = (
      _context,
      config,
    ) => {
      received.push(['function', config])
    }
    functionComponent.Config = schema

    const objectComponent: Component.Object<NumberConfig> = {
      Config: schema,
      apply(_context, config) {
        received.push(['object', config])
      },
    }

    class ClassComponent {
      static Config = schema

      constructor(_context: Context, config: NumberConfig) {
        received.push(['class', config])
      }
    }

    const first = app.installComponent(functionComponent)
    const second = app.installComponent(
      objectComponent,
      { value: '20' } as unknown as NumberConfig,
    )
    const third = app.installComponent(
      ClassComponent,
      { value: '30' } as unknown as NumberConfig,
    )

    await Promise.all([first, second, third])

    expect(received).toEqual([
      ['function', { value: 10 }],
      ['object', { value: 20 }],
      ['class', { value: 30 }],
    ])
    expect(first.config).toEqual({ value: 10 })
    expect(second.config).toEqual({ value: 20 })
    expect(third.config).toEqual({ value: 30 })
  })

  it('uses the first schema stored for definitions sharing one callback', async () => {
    const app = new Context()
    const received: number[] = []
    const apply: Component.Function<NumberConfig> = (_context, config) => {
      received.push(config.value)
    }
    const firstValidate = vi.fn(() => ({ value: { value: 1 } }))
    const secondValidate = vi.fn(() => ({ value: { value: 2 } }))

    const first = app.installComponent({
      Config: createSchema(firstValidate),
      apply,
    }, {} as NumberConfig)
    await first

    const second = app.installComponent({
      Config: createSchema(secondValidate),
      apply,
    }, {} as NumberConfig)
    await second

    expect(received).toEqual([1, 1])
    expect(firstValidate).toHaveBeenCalledTimes(2)
    expect(secondValidate).not.toHaveBeenCalled()
  })

  it('reports Standard Schema issues and fails before entering the component', async () => {
    const app = new Context()
    const apply = vi.fn()
    const issues: readonly StandardSchemaV1.Issue[] = [
      {
        message: 'expected an integer',
        path: ['nested', { key: 'value' }, 0],
      },
      { message: 'missing required field' },
    ]
    const fiber = app.installComponent({
      Config: createSchema<NumberConfig>(() => ({ issues })),
      apply,
    }, { value: 1 })

    const failure = await Promise.resolve(fiber).catch(error => error)

    expect(failure).toBe(fiber.error)
    expect(failure).toBeInstanceOf(ValidationError)
    expect(failure).toBeInstanceOf(TypeError)
    expect(ValidationError.is(failure)).toBe(true)
    expect(failure.issues).toBe(issues)
    expect(failure.message).toMatch(/^invalid config:/)
    expect(failure.message).toContain('expected an integer')
    expect(failure.message).toContain('nested.value.0')
    expect(failure.message).toContain('missing required field')
    expect(Reflect.get(failure, Symbol.for('@nya/core/ValidationError'))).toBe(true)
    expect(apply).not.toHaveBeenCalled()
    expect(fiber.state).toBe(FiberState.FAILED)
  })

  it('rejects asynchronous Standard Schema validation', async () => {
    const app = new Context()
    const apply = vi.fn()
    const fiber = app.installComponent({
      Config: createSchema<NumberConfig>(async () => ({
        value: { value: 1 },
      })),
      apply,
    }, { value: 1 })

    const failure = await Promise.resolve(fiber).catch(error => error)

    expect(failure).toBe(fiber.error)
    expect(failure).toBeInstanceOf(TypeError)
    expect(failure).not.toBeInstanceOf(ValidationError)
    expect(failure.message).toBe('async config validation is not supported')
    expect(apply).not.toHaveBeenCalled()
    expect(fiber.state).toBe(FiberState.FAILED)
  })
})

describe('Fiber config lifecycle', () => {
  it('updates an active run only after disposing the old run', async () => {
    const app = new Context()
    const events: string[] = []
    const firstConfig = { value: 1 }
    const secondConfig = { value: 2 }
    const fiber = app.installComponent({
      apply(_context, config: NumberConfig) {
        events.push(`start:${config.value}`)
        return () => {
          events.push(`stop:${config.value}`)
        }
      },
    }, firstConfig)
    await fiber

    await fiber.update(secondConfig)

    expect(events).toEqual(['start:1', 'stop:1', 'start:2'])
    expect(fiber.config).toBe(secondConfig)
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('leaves the current config and run untouched after an invalid update', async () => {
    const app = new Context()
    const apply = vi.fn()
    const dispose = vi.fn()
    const initial = { value: 1 }
    const schema = createSchema<NumberConfig>((input) => {
      const value = Reflect.get(input as object, 'value')
      return typeof value === 'number'
        ? { value: { value } }
        : { issues: [{ message: 'expected a number', path: ['value'] }] }
    })
    const fiber = app.installComponent({
      Config: schema,
      apply(_context, config) {
        apply(config)
        return dispose
      },
    }, initial)
    await fiber
    const activeConfig = fiber.config

    await expect(fiber.update({ value: 'invalid' } as never)).rejects
      .toBeInstanceOf(ValidationError)

    expect(fiber.config).toBe(activeConfig)
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(apply).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('restarts with the current validated config', async () => {
    const app = new Context()
    const events: string[] = []
    const config = { value: 1 }
    const fiber = app.installComponent({
      apply(_context, received: NumberConfig) {
        events.push(`start:${received.value}`)
        return () => {
          events.push(`stop:${received.value}`)
        }
      },
    }, config)
    await fiber

    await fiber.restart()

    expect(events).toEqual(['start:1', 'stop:1', 'start:1'])
    expect(fiber.config).toBe(config)
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('recovers a failed component through restart', async () => {
    const app = new Context()
    const error = new Error('first startup failed')
    let attempts = 0
    const config = { value: 1 }
    const fiber = app.installComponent({
      apply(_context, received: NumberConfig) {
        attempts++
        if (attempts === 1) throw error
        expect(received).toBe(config)
      },
    }, config)

    await expect(Promise.resolve(fiber)).rejects.toBe(error)
    expect(fiber.state).toBe(FiberState.FAILED)

    await fiber.restart()

    expect(attempts).toBe(2)
    expect(fiber.error).toBeUndefined()
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('revalidates an initially invalid config when restarting', async () => {
    const app = new Context()
    const apply = vi.fn()
    let valid = false
    const validate = vi.fn(() => valid
      ? { value: { value: 1 } }
      : { issues: [{ message: 'not ready' }] })
    const fiber = app.installComponent({
      Config: createSchema<NumberConfig>(validate),
      apply,
    }, { value: 1 })

    await expect(Promise.resolve(fiber)).rejects.toBeInstanceOf(ValidationError)
    valid = true
    await fiber.restart()

    expect(validate).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledWith(fiber.context, { value: 1 })
    expect(fiber.config).toEqual({ value: 1 })
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('recovers an initially invalid component through a valid update', async () => {
    const app = new Context()
    const apply = vi.fn()
    const schema = createSchema<NumberConfig>((input) => {
      const value = Reflect.get(input as object, 'value')
      return typeof value === 'number'
        ? { value: { value } }
        : { issues: [{ message: 'expected a number' }] }
    })
    const fiber = app.installComponent({ Config: schema, apply }, {
      value: 'invalid',
    } as never)

    await expect(Promise.resolve(fiber)).rejects.toBeInstanceOf(ValidationError)

    await fiber.update({ value: 2 })

    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith(fiber.context, { value: 2 })
    expect(fiber.config).toEqual({ value: 2 })
    expect(fiber.error).toBeUndefined()
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('keeps a pending component dormant and starts it with the latest config', async () => {
    const app = new Context()
    const apply = vi.fn()
    const fiber = app.installComponent({
      inject: ['config-test-gate'],
      apply(_context, config: NumberConfig) {
        apply(config)
      },
    }, { value: 1 })
    await fiber

    await fiber.update({ value: 2 })

    expect(fiber.state).toBe(FiberState.PENDING)
    expect(fiber.config).toEqual({ value: 2 })
    expect(apply).not.toHaveBeenCalled()

    const remove = app.provide('config-test-gate', true)
    await fiber

    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith({ value: 2 })
    await fiber.dispose()
    await remove()
  })

  it('rejects update and restart after permanent disposal', async () => {
    const app = new Context()
    const fiber = app.installComponent(() => {})
    await fiber
    await fiber.dispose()

    await expect(fiber.update(undefined)).rejects.toThrow()
    await expect(fiber.restart()).rejects.toThrow()
    expect(fiber.state).toBe(FiberState.DISPOSED)
  })

  it('restarts the root by clearing its effects but does not allow root updates', async () => {
    const app = new Context()
    const dispose = vi.fn()
    app.effect(() => dispose)

    await app.fiber.restart()

    expect(dispose).toHaveBeenCalledOnce()
    expect(app.fiber.state).toBe(FiberState.ACTIVE)
    expect(() => app.effect(() => {})).not.toThrow()
    await expect(app.fiber.update({ value: 1 })).rejects.toThrow()
  })
})

describe('Fiber config concurrency', () => {
  it('serializes startup and makes every rapid update wait for the latest run', async () => {
    const app = new Context()
    const firstGate = deferred()
    const firstStarted = deferred()
    const latestGate = deferred()
    const latestStarted = deferred()
    const starts: number[] = []
    let concurrent = 0
    let maximumConcurrent = 0

    const fiber = app.installComponent({
      async apply(_context, config: NumberConfig) {
        starts.push(config.value)
        concurrent++
        maximumConcurrent = Math.max(maximumConcurrent, concurrent)

        if (config.value === 1) {
          firstStarted.resolve()
          await firstGate.promise
        }
        if (config.value === 3) {
          latestStarted.resolve()
          await latestGate.promise
        }

        concurrent--
      },
    }, { value: 1 })

    await firstStarted.promise
    const secondUpdate = fiber.update({ value: 2 })
    const latestUpdate = fiber.update({ value: 3 })
    let secondSettled = false
    let latestSettled = false
    void secondUpdate.then(() => {
      secondSettled = true
    })
    void latestUpdate.then(() => {
      latestSettled = true
    })

    await Promise.resolve()
    expect(starts).toEqual([1])
    firstGate.resolve()
    await latestStarted.promise

    expect(maximumConcurrent).toBe(1)
    expect(secondSettled).toBe(false)
    expect(latestSettled).toBe(false)

    latestGate.resolve()
    await Promise.all([secondUpdate, latestUpdate, fiber])

    expect(maximumConcurrent).toBe(1)
    expect(starts.at(-1)).toBe(3)
    expect(fiber.config).toEqual({ value: 3 })
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('does not start a new config until asynchronous cleanup finishes', async () => {
    const app = new Context()
    const cleanupGate = deferred()
    const cleanupStarted = deferred()
    const events: string[] = []
    const fiber = app.installComponent({
      apply(_context, config: NumberConfig) {
        events.push(`start:${config.value}`)
        return async () => {
          events.push(`stop:${config.value}:begin`)
          if (config.value === 1) {
            cleanupStarted.resolve()
            await cleanupGate.promise
          }
          events.push(`stop:${config.value}:end`)
        }
      },
    }, { value: 1 })
    await fiber

    const updating = fiber.update({ value: 2 })
    let settled = false
    void updating.then(() => {
      settled = true
    })
    await cleanupStarted.promise

    expect(events).toEqual(['start:1', 'stop:1:begin'])
    expect(settled).toBe(false)

    cleanupGate.resolve()
    await updating

    expect(events).toEqual([
      'start:1',
      'stop:1:begin',
      'stop:1:end',
      'start:2',
    ])
  })

  it('requires an explicit retry after cleanup blocks a config update', async () => {
    const app = new Context()
    const error = new Error('old config cleanup failed')
    const starts: number[] = []
    const fiber = app.installComponent({
      apply(_context, config: NumberConfig) {
        starts.push(config.value)
        if (config.value === 1) {
          return () => {
            throw error
          }
        }
      },
    }, { value: 1 })
    await fiber

    await expect(fiber.update({ value: 2 })).rejects.toBe(error)

    expect(starts).toEqual([1])
    expect(fiber.config).toEqual({ value: 2 })
    expect(fiber.error).toBe(error)
    expect(fiber.state).toBe(FiberState.FAILED)

    await fiber.restart()

    expect(starts).toEqual([1, 2])
    expect(fiber.error).toBeUndefined()
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('does not let a replacement dependency bypass a cleanup failure', async () => {
    const app = new Context()
    const error = new Error('dependency cleanup failed')
    const starts: number[] = []
    const removeFirst = app.provide('config-test-database', { id: 1 })
    const fiber = app.installComponent({
      inject: ['config-test-database'],
      apply(context) {
        const database = context.get('config-test-database') as { id: number }
        starts.push(database.id)
        if (database.id === 1) {
          return () => {
            throw error
          }
        }
      },
    })
    await fiber

    await removeFirst()
    expect(fiber.error).toBe(error)
    expect(fiber.state).toBe(FiberState.FAILED)

    const removeSecond = app.provide('config-test-database', { id: 2 })
    await fiber

    expect(starts).toEqual([1])
    expect(fiber.error).toBe(error)
    expect(fiber.state).toBe(FiberState.FAILED)

    await fiber.restart()

    expect(starts).toEqual([1, 2])
    expect(fiber.error).toBeUndefined()
    expect(fiber.state).toBe(FiberState.ACTIVE)
    await fiber.dispose()
    await removeSecond()
  })

  it('lets a valid update clear a cleanup block while dependencies are missing', async () => {
    const app = new Context()
    const error = new Error('old dependency cleanup failed')
    const starts: string[] = []
    const removeFirst = app.provide('config-test-database', { id: 1 })
    const fiber = app.installComponent({
      inject: ['config-test-database'],
      apply(context, config: NumberConfig) {
        const database = context.get('config-test-database') as { id: number }
        starts.push(`${config.value}:${database.id}`)
        if (database.id === 1) {
          return () => {
            throw error
          }
        }
      },
    }, { value: 1 })
    await fiber

    await removeFirst()
    expect(fiber.state).toBe(FiberState.FAILED)

    await fiber.update({ value: 2 })

    expect(fiber.config).toEqual({ value: 2 })
    expect(fiber.error).toBeUndefined()
    expect(fiber.state).toBe(FiberState.PENDING)
    expect(starts).toEqual(['1:1'])

    const removeSecond = app.provide('config-test-database', { id: 2 })
    await fiber

    expect(starts).toEqual(['1:1', '2:2'])
    expect(fiber.state).toBe(FiberState.ACTIVE)
    await fiber.dispose()
    await removeSecond()
  })

  it('blocks a new dependency epoch when startup rollback cleanup fails', async () => {
    const app = new Context()
    const startupError = new Error('startup failed')
    const rollbackError = new Error('startup rollback failed')
    let attempts = 0
    let shouldFail = true
    const removeFirst = app.provide('config-test-gate', { id: 1 })
    const fiber = app.installComponent({
      inject: ['config-test-gate'],
      apply(context) {
        attempts++
        if (!shouldFail) return
        context.effect(() => () => {
          throw rollbackError
        })
        throw startupError
      },
    })

    await expect(Promise.resolve(fiber)).rejects.toBeInstanceOf(AggregateError)
    expect(fiber.state).toBe(FiberState.FAILED)
    expect(attempts).toBe(1)

    await removeFirst()
    const removeSecond = app.provide('config-test-gate', { id: 2 })
    await fiber

    expect(fiber.state).toBe(FiberState.FAILED)
    expect(attempts).toBe(1)

    shouldFail = false
    await fiber.restart()

    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(attempts).toBe(2)
    await fiber.dispose()
    await removeSecond()
  })

  it('converges simultaneous config and dependency changes to both latest values', async () => {
    const app = new Context()
    const events: string[] = []
    const removeFirst = app.provide('config-test-database', { id: 1 })
    const fiber = app.installComponent({
      inject: ['config-test-database'],
      apply(context, config: NumberConfig) {
        const database = context.get('config-test-database') as { id: number }
        events.push(`start:${config.value}:${database.id}`)
        return () => {
          const active = context.get('config-test-database') as { id: number }
          events.push(`stop:${config.value}:${active.id}`)
        }
      },
    }, { value: 1 })
    await fiber

    const updating = fiber.update({ value: 2 })
    const removingFirst = Promise.resolve(removeFirst())
    while (app.get('config-test-database') !== undefined) {
      await Promise.resolve()
    }
    const removeSecond = app.provide('config-test-database', { id: 2 })
    await Promise.all([updating, removingFirst, fiber])

    expect(events[0]).toBe('start:1:1')
    expect(events).toContain('stop:1:1')
    expect(events.at(-1)).toBe('start:2:2')
    expect(fiber.config).toEqual({ value: 2 })
    expect(fiber.state).toBe(FiberState.ACTIVE)

    await fiber.dispose()
    await removeSecond()
  })
})

describe('internal/update waterfall', () => {
  it('runs async wrappers in order around the committed update', async () => {
    const app = new Context()
    const events: string[] = []
    const fiber = app.installComponent({
      apply(_context, config: NumberConfig) {
        events.push(`start:${config.value}`)
        return () => {
          events.push(`stop:${config.value}`)
        }
      },
    }, { value: 1 })
    await fiber
    events.length = 0

    app.on('internal/update', async function (
      this: Fiber,
      config,
      next,
    ) {
      expect(this).toBe(fiber)
      expect(config).toEqual({ value: 2 })
      events.push('first:before')
      await next()
      events.push('first:after')
    })
    app.on('internal/update', async function (
      this: Fiber,
      _config,
      next,
    ) {
      expect(this).toBe(fiber)
      events.push('second:before')
      await next()
      events.push('second:after')
    })

    await fiber.update({ value: 2 })

    expect(events).toEqual([
      'first:before',
      'second:before',
      'stop:1',
      'start:2',
      'second:after',
      'first:after',
    ])
  })

  it('waits when a listener calls next without returning its promise', async () => {
    const app = new Context()
    const cleanup = deferred()
    const cleanupStarted = deferred()
    const fiber = app.installComponent({
      apply(_context, config: NumberConfig) {
        return async () => {
          if (config.value === 1) {
            cleanupStarted.resolve()
            await cleanup.promise
          }
        }
      },
    }, { value: 1 })
    await fiber

    app.on('internal/update', (_config, next) => {
      void next()
    })

    const updating = fiber.update({ value: 2 })
    let settled = false
    void updating.then(() => {
      settled = true
    })
    await cleanupStarted.promise
    expect(settled).toBe(false)

    cleanup.resolve()
    await updating
    expect(fiber.config).toEqual({ value: 2 })
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('receives schema output and can transform it before committing', async () => {
    const app = new Context()
    const received: number[] = []
    const schema = createNumberSchema()
    const fiber = app.installComponent({
      Config: schema,
      apply(_context, config) {
        received.push(config.value)
      },
    }, { value: 1 })
    await fiber

    app.on('internal/update', function (this: Fiber, config, next) {
      expect(this).toBe(fiber)
      expect(config).toEqual({ value: 2 })
      ;(config as NumberConfig).value++
      return next()
    })

    await fiber.update({ value: '2' } as unknown as NumberConfig)

    expect(received).toEqual([1, 3])
    expect(fiber.config).toEqual({ value: 3 })
  })

  it('does not let a delayed older hook overwrite a newer update', async () => {
    const app = new Context()
    const olderHook = deferred()
    const olderHookStarted = deferred()
    const starts: number[] = []
    const fiber = app.installComponent({
      apply(_context, config: NumberConfig) {
        starts.push(config.value)
      },
    }, { value: 0 })
    await fiber

    app.on('internal/update', async function (config, next) {
      if ((config as NumberConfig).value === 1) {
        olderHookStarted.resolve()
        await olderHook.promise
      }
      await next()
    })

    const older = fiber.update({ value: 1 })
    await olderHookStarted.promise
    const newer = fiber.update({ value: 2 })
    await newer
    olderHook.resolve()
    await older

    expect(starts).toEqual([0, 2])
    expect(fiber.config).toEqual({ value: 2 })
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('allows a listener to cancel an update without disturbing the run', async () => {
    const app = new Context()
    const apply = vi.fn()
    const dispose = vi.fn()
    const initial = { value: 1 }
    const fiber = app.installComponent({
      apply(_context, config: NumberConfig) {
        apply(config)
        return dispose
      },
    }, initial)
    await fiber

    app.on('internal/update', function (this: Fiber, config) {
      expect(this).toBe(fiber)
      expect(config).toEqual({ value: 2 })
    })

    await fiber.update({ value: 2 })

    expect(fiber.config).toBe(initial)
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(apply).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('rejects listener failures before next without committing config', async () => {
    const app = new Context()
    const error = new Error('update hook failed')
    const apply = vi.fn()
    const initial = { value: 1 }
    const fiber = app.installComponent({ apply }, initial)
    await fiber

    app.on('internal/update', () => {
      throw error
    })

    await expect(fiber.update({ value: 2 })).rejects.toBe(error)
    expect(fiber.config).toBe(initial)
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(apply).toHaveBeenCalledOnce()
  })

  it('removes update listeners with their owning Fiber', async () => {
    const app = new Context()
    const calls: number[] = []
    const owner = app.installComponent((context) => {
      context.on('internal/update', function (
        this: Fiber,
        config,
        next,
      ) {
        calls.push((config as NumberConfig).value)
        return next()
      })
    })
    const target = app.installComponent(() => {}, { value: 0 })
    await Promise.all([owner, target])

    await target.update({ value: 1 })
    await owner.dispose()
    await target.update({ value: 2 })

    expect(calls).toEqual([1])
  })
})
