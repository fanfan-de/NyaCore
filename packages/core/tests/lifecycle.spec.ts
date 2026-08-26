/** 本文件验证组件启动、Effect 回收、失败回滚和父子组件级联卸载等基础生命周期语义。 */

import { describe, expect, it, vi } from 'vitest'
import { Context, Fiber, FiberState } from '../src/index.js'
import type { Component } from '../src/index.js'

describe('component lifecycle', () => {
  it('starts an object component with its config', async () => {
    const app = new Context()
    const apply = vi.fn()
    const config = { value: 42 }

    const fiber = app.installComponent({
      name: 'configured-worker',
      apply(context, received) {
        apply(context, received)
      },
    }, config)

    await fiber

    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith(fiber.context, config)
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(Context.is(fiber.context)).toBe(true)
    expect(fiber.context.root).toBe(app)
  })

  it('starts an object component', async () => {
    const app = new Context()
    const apply = vi.fn()

    const fiber = app.installComponent({ name: 'worker', apply })
    await fiber

    expect(apply).toHaveBeenCalledOnce()
    expect(fiber.name).toBe('worker')
  })

  it('starts a function component with its config and disposer', async () => {
    const app = new Context()
    const start = vi.fn()
    const dispose = vi.fn()
    const config = { value: 42 }
    const functionComponent: Component.Function<typeof config> = (context, received) => {
      start(context, received)
      return dispose
    }

    const fiber = app.installComponent(functionComponent, config)
    await fiber

    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(fiber.context, config)
    expect(fiber.name).toBe('functionComponent')
    expect(app.registry.get(functionComponent)).toMatchObject({
      callback: functionComponent,
      kind: 'function',
      name: 'functionComponent',
    })

    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('starts a class component with its config and owned effects', async () => {
    const app = new Context()
    const start = vi.fn()
    const dispose = vi.fn()
    const config = { value: 42 }

    class ClassComponent {
      constructor(context: Context, received: typeof config) {
        start(context, received)
        context.effect(() => dispose)
      }
    }

    const component: Component.Constructor<typeof config> = ClassComponent
    const fiber = app.installComponent(component, config)
    await fiber

    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(fiber.context, config)
    expect(fiber.name).toBe('ClassComponent')
    expect(app.registry.get(component)).toMatchObject({
      callback: ClassComponent,
      kind: 'constructor',
      name: 'ClassComponent',
    })

    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('runs generators as function components', async () => {
    const app = new Context()
    const start = vi.fn()
    const dispose = vi.fn()

    function* generatorComponent(context: Context) {
      start(context)
      yield dispose
    }

    const fiber = app.installComponent(generatorComponent)
    await fiber

    expect(start).toHaveBeenCalledWith(fiber.context)
    expect(app.registry.get(generatorComponent)?.kind).toBe('function')

    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('runs async generators as function components', async () => {
    const app = new Context()
    const start = vi.fn()
    const dispose = vi.fn()

    async function* asyncGeneratorComponent(context: Context) {
      start(context)
      yield dispose
    }

    const fiber = app.installComponent(asyncGeneratorComponent)
    await fiber

    expect(start).toHaveBeenCalledWith(fiber.context)
    expect(app.registry.get(asyncGeneratorComponent)?.kind).toBe('function')

    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('uses the constructor path for prototype-bearing functions', async () => {
    const app = new Context()
    const start = vi.fn()
    const dispose = vi.fn()
    const config = { value: 42 }

    function LegacyComponent(context: Context, received: typeof config) {
      start(new.target, context, received)
      context.effect(() => dispose)
    }

    const fiber = app.installComponent(LegacyComponent, config)
    await fiber

    expect(start).toHaveBeenCalledWith(LegacyComponent, fiber.context, config)
    expect(app.registry.get(LegacyComponent)?.kind).toBe('constructor')

    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('accepts an unnamed object component', async () => {
    const app = new Context()
    const apply = vi.fn()
    const component = { apply }

    const fiber = app.installComponent(component)
    await fiber

    expect(apply).toHaveBeenCalledWith(fiber.context, undefined)
    expect(fiber.name).toBe('anonymous')
  })

  it('deletes every instance of a function component through its definition', async () => {
    const app = new Context()
    const dispose = vi.fn()
    const component = () => dispose

    const first = app.installComponent(component)
    const second = app.installComponent(component)
    await Promise.all([first, second])

    expect(app.registry.get(component)?.fibers).toEqual(new Set([first, second]))

    await app.registry.delete(component)

    expect(dispose).toHaveBeenCalledTimes(2)
    expect(first.state).toBe(FiberState.DISPOSED)
    expect(second.state).toBe(FiberState.DISPOSED)
    expect(app.registry.get(component)).toBeUndefined()
  })

  it('owns effects registered while an object component starts', async () => {
    const app = new Context()
    const start = vi.fn()
    const dispose = vi.fn()
    const config = { value: 42 }

    const fiber = app.installComponent({
      name: 'worker',
      apply(context, received) {
        start(context, received)
        context.effect(() => dispose)
      },
    }, config)
    await fiber

    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(fiber.context, config)
    expect(fiber.name).toBe('worker')
    expect(fiber.state).toBe(FiberState.ACTIVE)

    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes a component exactly once', async () => {
    const app = new Context()
    const dispose = vi.fn()
    const fiber = app.installComponent({
      name: 'disposable',
      apply: () => dispose,
    })

    await fiber
    await fiber.dispose()
    await fiber.dispose()

    expect(dispose).toHaveBeenCalledOnce()
    expect(fiber.state).toBe(FiberState.DISPOSED)
  })

  it('disposes effects in reverse registration order', async () => {
    const app = new Context()
    const sequence: number[] = []

    const fiber = app.installComponent({
      name: 'ordered-effects',
      apply(context) {
        context.effect(() => () => {
          sequence.push(1)
        })
        context.effect(() => () => {
          sequence.push(2)
        })
      },
    })

    await fiber
    await fiber.dispose()

    expect(sequence).toEqual([2, 1])
  })

  it('finishes permanent disposal after a cleanup failure', async () => {
    const app = new Context()
    const error = new Error('cleanup failed')
    const sequence: number[] = []
    const component = (context: Context) => {
      context.effect(() => () => {
        sequence.push(1)
        throw error
      })
      context.effect(() => () => {
        sequence.push(2)
      })
    }

    const fiber = app.installComponent(component)
    await fiber

    await expect(fiber.dispose()).rejects.toBe(error)
    expect(sequence).toEqual([2, 1])
    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(app.registry.get(component)).toBeUndefined()
  })

  it('disposes child components with their parent', async () => {
    const app = new Context()
    const parentDispose = vi.fn()
    const childDispose = vi.fn()
    let child!: Fiber

    const parent = app.installComponent({
      name: 'parent',
      apply(context) {
        child = context.installComponent({
          name: 'child',
          apply: () => childDispose,
        })
        return parentDispose
      },
    })

    await parent
    await child
    await parent.dispose()

    expect(parentDispose).toHaveBeenCalledOnce()
    expect(childDispose).toHaveBeenCalledOnce()
    expect(child.state).toBe(FiberState.DISPOSED)
  })

  it('rolls back effects when component startup fails', async () => {
    const app = new Context()
    const dispose = vi.fn()
    const error = new Error('startup failed')

    const fiber = app.installComponent({
      name: 'failing-startup',
      apply(context) {
        context.effect(() => dispose)
        throw error
      },
    })

    await expect(Promise.resolve(fiber)).rejects.toBe(error)

    expect(dispose).toHaveBeenCalledOnce()
    expect(fiber.error).toBe(error)
    expect(fiber.state).toBe(FiberState.FAILED)
  })

  it('rolls back effects when a class component constructor fails', async () => {
    const app = new Context()
    const dispose = vi.fn()
    const error = new Error('constructor failed')

    class FailingComponent {
      constructor(context: Context) {
        context.effect(() => dispose)
        throw error
      }
    }

    const fiber = app.installComponent(FailingComponent)

    await expect(Promise.resolve(fiber)).rejects.toBe(error)
    expect(dispose).toHaveBeenCalledOnce()
    expect(fiber.error).toBe(error)
    expect(fiber.state).toBe(FiberState.FAILED)
  })

  it('waits for asynchronous startup and collects its disposer', async () => {
    const app = new Context()
    const dispose = vi.fn()
    let finishStartup!: () => void
    const startup = new Promise<void>(resolve => {
      finishStartup = resolve
    })

    const fiber = app.installComponent({
      name: 'async-startup',
      async apply() {
        await startup
        return dispose
      },
    })

    expect(fiber.state).toBe(FiberState.PENDING)
    finishStartup()
    await fiber

    expect(fiber.state).toBe(FiberState.ACTIVE)
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rejects invalid components immediately', () => {
    const app = new Context()

    expect(() => app.installComponent(undefined as never)).toThrow('invalid component')
    expect(() => app.installComponent(null as never)).toThrow('invalid component')
    expect(() => app.installComponent({} as never)).toThrow('invalid component')
    expect(() => app.installComponent({ apply: 1 } as never)).toThrow('invalid component')
    expect(() => app.installComponent(42 as never)).toThrow('invalid component')
    expect(() => app.installComponent(Object.defineProperty({}, 'apply', {
      get() {
        throw new Error('getter failed')
      },
    }) as never)).toThrow('invalid component')
  })
})
