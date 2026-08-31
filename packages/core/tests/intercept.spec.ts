/** 本文件验证 Service 调用配置沿调用方 Context 继承且不污染 Provider。 */

import { describe, expect, it } from 'vitest'
import { Context, FiberState, Service } from '../src/index.js'

interface ReplaceConfig {
  readonly scope: string
  readonly inherited?: boolean
}

interface MergeConfig {
  readonly base?: number
  readonly parent?: number
  readonly child?: number
  readonly head?: number
}

class ReplacingService extends Service<ReplaceConfig | undefined> {
  static provide = 'configuredReplace'

  current() {
    return this[Service.resolveConfig]()
  }
}

class MergingService extends Service<MergeConfig> {
  static provide = 'configuredMerge'

  current() {
    return this[Service.resolveConfig]()
  }

  withBounds(base: MergeConfig, head: MergeConfig) {
    return this[Service.resolveConfig](base, head)
  }

  protected [Service.mergeConfig](...configs: MergeConfig[]) {
    return Object.assign({}, ...configs)
  }
}

declare module '../src/context.js' {
  interface Context {
    configuredReplace: ReplacingService
    configuredMerge: MergingService
  }
}

describe('Context intercept', () => {
  it('derives caller-specific replacement config without mutating its parent', async () => {
    const app = new Context()
    const provider = app.installComponent(ReplacingService)
    await provider

    const parent = app.intercept('configuredReplace', {
      scope: 'parent',
      inherited: true,
    })
    const child = parent.intercept('configuredReplace', { scope: 'child' })
    const sibling = parent.extend()

    expect(app.configuredReplace.current()).toBeUndefined()
    expect(parent.configuredReplace.current()).toEqual({
      scope: 'parent',
      inherited: true,
    })
    expect(child.configuredReplace.current()).toEqual({ scope: 'child' })
    expect(sibling.configuredReplace.current()).toEqual({
      scope: 'parent',
      inherited: true,
    })
  })

  it('lets a Service explicitly merge base, inherited and head layers', async () => {
    const app = new Context()
    const provider = app.installComponent(MergingService)
    await provider

    const parent = app.intercept('configuredMerge', { parent: 2 })
    const child = parent.intercept('configuredMerge', { child: 3 })

    expect(child.configuredMerge.current()).toEqual({ parent: 2, child: 3 })
    expect(child.configuredMerge.withBounds(
      { base: 1 },
      { head: 4 },
    )).toEqual({ base: 1, parent: 2, child: 3, head: 4 })
  })

  it('turns object Inject values into component-local intercept layers', async () => {
    const app = new Context()
    const provider = app.installComponent(ReplacingService)
    await provider
    const received: Array<ReplaceConfig | undefined> = []

    const configured = app.installComponent({
      inject: { configuredReplace: { scope: 'component' } },
      apply(context) {
        received.push(context.configuredReplace.current())
      },
    })
    const dependencyOnly = app.installComponent({
      inject: { configuredReplace: undefined },
      apply(context) {
        received.push(context.configuredReplace.current())
      },
    })
    await Promise.all([configured, dependencyOnly])

    expect(received).toEqual([{ scope: 'component' }, undefined])
  })

  it('applies install Inject and explicit intercept after static metadata', async () => {
    const app = new Context()
    const provider = app.installComponent(ReplacingService)
    await provider
    let received: ReplaceConfig | undefined

    const consumer = app.installComponent({
      inject: { configuredReplace: { scope: 'static' } },
      apply(context) {
        received = context.configuredReplace.current()
      },
    }, undefined, {
      inject: { configuredReplace: { scope: 'install-inject' } },
      intercept: { configuredReplace: { scope: 'explicit' } },
    })
    await consumer

    expect(received).toEqual({ scope: 'explicit' })
    expect(consumer.inject).toEqual(new Set(['configuredReplace']))
  })

  it('applies strict isolation to a single installation', async () => {
    const app = new Context()
    const label = Symbol('configured branch')
    const isolated = app.isolate('configuredReplace', label)
    const provider = isolated.installComponent(ReplacingService)
    await provider
    let started = false

    const consumer = app.installComponent({
      apply(context) {
        started = context.configuredReplace instanceof ReplacingService
      },
    }, undefined, {
      inject: ['configuredReplace'],
      isolate: { configuredReplace: label },
    })
    await consumer

    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(started).toBe(true)
  })
})
