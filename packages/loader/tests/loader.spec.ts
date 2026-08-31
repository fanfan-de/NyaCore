/** 本文件验证 Loader Entry 树、解析失败隔离、空间继承与 Fiber 生命周期协调。 */

import {
  Context,
  FiberState,
} from '@nya/core'
import type {
  Component,
} from '@nya/core'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  Loader,
  LoaderGroup,
} from '../src/index.js'
import type {
  LoaderResolveRequest,
  LoaderResolver,
} from '../src/index.js'

interface Database {
  readonly id: string
}

declare module '@nya/core' {
  interface Context {
    database: Database
  }
}

const applications: Context[] = []

afterEach(async () => {
  const current = applications.splice(0)
  await Promise.allSettled(current.map(app => app.fiber.dispose()))
})

async function createLoader(
  definitions = new Map<string, Component<any> | Error>(),
  config: { baseUrl?: string } = {},
) {
  const app = new Context()
  applications.push(app)
  const resolver = vi.fn(async ({ name }: LoaderResolveRequest) => {
    const definition = definitions.get(name)
    if (definition instanceof Error) throw definition
    if (!definition) throw new Error(`missing test component: ${name}`)
    return definition
  }) satisfies LoaderResolver
  const loaderFiber = app.installComponent(Loader, {
    ...config,
    resolver,
  })
  await loaderFiber
  return {
    app,
    definitions,
    loader: app.loader,
    loaderFiber,
    resolver,
  }
}

describe('Loader', () => {
  it('keeps a component pending until another Entry provides its dependency', async () => {
    const consume = vi.fn()
    const disposeConsumer = vi.fn()
    const consumer: Component.Function<void> = context => {
      consume(context.database)
      return disposeConsumer
    }
    consumer.inject = ['database']
    const database = { id: 'primary' }
    const provider: Component.Function<void> = context => {
      return context.provide('database', database)
    }
    const definitions = new Map<string, Component<any>>([
      ['consumer', consumer],
      ['provider', provider],
    ])
    const { loader } = await createLoader(definitions)

    const waiting = await loader.create({ id: 'consumer', name: 'consumer' })
    expect(waiting.state).toBe('pending')
    expect(consume).not.toHaveBeenCalled()

    await loader.create({ id: 'provider', name: 'provider' })
    await loader.awaitIdle()

    expect(loader.get('consumer')?.state).toBe('active')
    expect(consume).toHaveBeenCalledWith(database)

    await loader.remove('provider')
    expect(loader.get('consumer')?.state).toBe('pending')
    expect(disposeConsumer).toHaveBeenCalledOnce()
  })

  it('allows a starting component to declare a nested Entry without queue deadlock', async () => {
    let nestedState: string | undefined
    const childStart = vi.fn()
    const parent: Component.Function<void> = async context => {
      const nested = await context.loader.create(
        { id: 'nested', name: 'child' },
        'parent',
      )
      nestedState = nested.state
    }
    parent.inject = ['loader']
    const definitions = new Map<string, Component<any>>([
      ['parent', parent],
      ['child', childStart],
    ])
    const { loader } = await createLoader(definitions)

    const parentEntry = await loader.create({ id: 'parent', name: 'parent' })

    expect(nestedState).toBe('pending')
    expect(parentEntry.state).toBe('active')
    expect(loader.get('nested')).toMatchObject({
      parentId: 'parent',
      state: 'active',
    })
    expect(childStart).toHaveBeenCalledOnce()
  })

  it('uses fiber.update for a pure config change and leaves siblings untouched', async () => {
    const starts: number[] = []
    const stops: number[] = []
    const siblingStart = vi.fn()
    const target: Component.Function<{ value: number }> = (_context, config) => {
      starts.push(config.value)
      return () => {
        stops.push(config.value)
      }
    }
    const sibling: Component.Function<void> = () => {
      siblingStart()
    }
    const definitions = new Map<string, Component<any>>([
      ['target', target],
      ['sibling', sibling],
    ])
    const { loader } = await createLoader(definitions)
    const before = await loader.create({
      id: 'target',
      name: 'target',
      config: { value: 1 },
    })
    const siblingBefore = await loader.create({
      id: 'sibling',
      name: 'sibling',
    })

    const after = await loader.update('target', { config: { value: 2 } })
    const siblingAfter = loader.get('sibling')!

    expect(after.fiberId).toBe(before.fiberId)
    expect(siblingAfter.fiberId).toBe(siblingBefore.fiberId)
    expect(starts).toEqual([1, 2])
    expect(stops).toEqual([1])
    expect(siblingStart).toHaveBeenCalledOnce()
  })

  it('disables and restores a Group as one reversible ownership subtree', async () => {
    const starts = vi.fn()
    const stops = vi.fn()
    const child: Component.Function<void> = () => {
      starts()
      return stops
    }
    const definitions = new Map<string, Component<any>>([['child', child]])
    const { loader } = await createLoader(definitions)
    const group = await loader.create({
      id: 'group',
      type: 'group',
      name: 'workers',
    })
    const childBefore = await loader.create(
      { id: 'child', name: 'child' },
      'group',
    )

    await loader.update('group', { disabled: true })
    const disabledGroup = loader.get('group')!
    const disabledChild = loader.get('child')!
    expect(disabledGroup.state).toBe('disabled')
    expect(disabledGroup.fiberId).toBeUndefined()
    expect(disabledChild.state).toBe('disabled')
    expect(disabledChild.blockedBy).toBe('group')
    expect(disabledChild.fiberId).toBeUndefined()
    expect(stops).toHaveBeenCalledOnce()

    const restoredGroup = await loader.update('group', { disabled: false })
    const restoredChild = loader.get('child')!
    expect(restoredGroup.id).toBe(group.id)
    expect(restoredChild.id).toBe(childBefore.id)
    expect(restoredGroup.state).toBe('active')
    expect(restoredChild.state).toBe('active')
    expect(restoredGroup.fiberId).not.toBe(group.fiberId)
    expect(restoredChild.fiberId).not.toBe(childBefore.fiberId)
    expect(starts).toHaveBeenCalledTimes(2)
  })

  it('reinstalls only a moved subtree and inherits the destination isolation', async () => {
    const leftLabel = Symbol('left database')
    const rightLabel = Symbol('right database')
    const starts: string[] = []
    const provider: Component.Function<{ id: string }> = (context, config) => {
      return context.provide('database', { id: config.id })
    }
    const consumer: Component.Function<{ id: string }> = (context, config) => {
      starts.push(`${config.id}:${context.database.id}`)
    }
    consumer.inject = ['database']
    const definitions = new Map<string, Component<any>>([
      ['provider', provider],
      ['consumer', consumer],
    ])
    const { loader } = await createLoader(definitions)

    await loader.create({
      id: 'left',
      type: 'group',
      isolate: { database: leftLabel },
    })
    await loader.create({
      id: 'right',
      type: 'group',
      isolate: { database: rightLabel },
    })
    await loader.create({
      id: 'left-provider',
      name: 'provider',
      config: { id: 'left' },
    }, 'left')
    await loader.create({
      id: 'right-provider',
      name: 'provider',
      config: { id: 'right' },
    }, 'right')
    const movingBefore = await loader.create({
      id: 'moving',
      name: 'consumer',
      config: { id: 'moving' },
    }, 'left')
    const siblingBefore = await loader.create({
      id: 'sibling',
      name: 'consumer',
      config: { id: 'sibling' },
    }, 'left')

    const movingAfter = await loader.move('moving', 'right')
    const siblingAfter = loader.get('sibling')!

    expect(movingAfter.parentId).toBe('right')
    expect(movingAfter.fiberId).not.toBe(movingBefore.fiberId)
    expect(siblingAfter.fiberId).toBe(siblingBefore.fiberId)
    expect(starts).toEqual([
      'moving:left',
      'sibling:left',
      'moving:right',
    ])
  })

  it('captures resolver failure, keeps siblings active, and retries explicitly', async () => {
    const failure = new Error('module is temporarily unavailable')
    const healthy = vi.fn()
    const definitions = new Map<string, Component<any> | Error>([
      ['broken', failure],
      ['healthy', healthy],
    ])
    const { loader } = await createLoader(definitions)

    const broken = await loader.create({ id: 'broken', name: 'broken' })
    const healthyEntry = await loader.create({ id: 'healthy', name: 'healthy' })
    expect(broken.state).toBe('failed')
    expect(broken.error).toBe(failure)
    expect(healthyEntry.state).toBe('active')
    expect(healthy).toHaveBeenCalledOnce()

    const recovered = vi.fn()
    definitions.set('broken', recovered)
    const retried = await loader.resolve('broken')
    expect(retried.state).toBe('active')
    expect(recovered).toHaveBeenCalledOnce()
    expect(loader.get('healthy')?.fiberId).toBe(healthyEntry.fiberId)
  })

  it('retries a failed component run without changing its installation identity', async () => {
    const failure = new Error('startup failed')
    let shouldFail = true
    const unstable: Component.Function<void> = () => {
      if (shouldFail) throw failure
    }
    const definitions = new Map<string, Component<any>>([
      ['unstable', unstable],
    ])
    const { loader } = await createLoader(definitions)

    const failed = await loader.create({ id: 'unstable', name: 'unstable' })
    expect(failed.state).toBe('failed')
    expect(failed.error).toBe(failure)

    shouldFail = false
    const recovered = await loader.resolve('unstable')
    expect(recovered.state).toBe('active')
    expect(recovered.fiberId).toBe(failed.fiberId)
  })

  it('inherits baseUrl through Group entries and returns disconnected snapshots', async () => {
    const component = vi.fn()
    const definitions = new Map<string, Component<any>>([
      ['./worker.js', component],
    ])
    const { loader, resolver } = await createLoader(definitions, {
      baseUrl: 'file:///root/',
    })
    await loader.create({
      id: 'group',
      type: 'group',
      baseUrl: 'file:///workspace/plugins/',
    })
    const entry = await loader.create({
      id: 'worker',
      name: './worker.js',
    }, 'group')

    expect(resolver).toHaveBeenLastCalledWith({
      id: 'worker',
      name: './worker.js',
      parentId: 'group',
      baseUrl: 'file:///workspace/plugins/',
    })
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.children)).toBe(true)
    expect(Reflect.set(entry, 'state', 'failed')).toBe(false)
    expect(loader.get('worker')?.state).toBe('active')
  })

  it('rejects duplicate identities, missing parents, and tree cycles atomically', async () => {
    const { loader } = await createLoader()
    await loader.create({ id: 'root', type: 'group' })
    await loader.create({ id: 'child', type: 'group' }, 'root')

    await expect(loader.create({ id: 'root', type: 'group' }))
      .rejects.toThrow('already exists')
    await expect(loader.create(
      { id: 'orphan', type: 'group' },
      'missing',
    )).rejects.toThrow('does not exist')
    await expect(loader.move('root', 'child'))
      .rejects.toThrow('own subtree')

    expect(loader.entries().map(entry => entry.id)).toEqual(['root', 'child'])
    expect(loader.get('root')?.parentId).toBeNull()
    expect(loader.get('child')?.parentId).toBe('root')
  })

  it('removes all runtime instances and disposes the Loader-owned tree', async () => {
    const cleanup = vi.fn()
    const child: Component.Function<void> = () => cleanup
    const definitions = new Map<string, Component<any>>([['child', child]])
    const { app, loader, loaderFiber } = await createLoader(definitions)
    await loader.create({ id: 'group', type: 'group' })
    await loader.create({ id: 'child', name: 'child' }, 'group')

    expect(loaderFiber.inspect().children).toHaveLength(1)
    await loader.remove('group')
    expect(loader.entries()).toEqual([])
    expect(loaderFiber.inspect().children).toHaveLength(0)
    expect(app.registry.get(LoaderGroup)).toBeUndefined()
    expect(app.registry.get(child)).toBeUndefined()
    expect(cleanup).toHaveBeenCalledOnce()

    await loader.create({ id: 'next', name: 'child' })
    await loaderFiber.dispose()
    expect(app.get('loader')).toBeUndefined()
    expect(app.registry.get(child)).toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(() => loader.entries()).toThrow('inactive context')
    expect(loaderFiber.state).toBe(FiberState.DISPOSED)
  })
})
