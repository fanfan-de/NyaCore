/** 本文件实现根 Context 共享的事件注册表，以及 Cordis 风格的多种派发模式。 */

import type { Context } from './context.js'
import type { Disposer } from './disposable.js'
import type { Fiber } from './fiber.js'
import { FiberState } from './fiber.js'
import { contextFilter } from './symbols.js'
import { withEffectDescriptor } from './diagnostics.js'

/**
 * 应用可以通过模块扩展补充事件签名：
 *
 * @example
 * ```ts
 * declare module '@nya/core' {
 *   interface Events {
 *     'record/created'(record: unknown): void
 *   }
 * }
 * ```
 */
export interface Events {
  /** 配置更新在提交前经过的内部可拦截调用链。 */
  'internal/update'(
    this: Fiber,
    config: unknown,
    next: () => void | Promise<void>,
  ): void | Promise<void>
}

export type DispatchMode =
  | 'emit'
  | 'parallel'
  | 'serial'
  | 'bail'
  | 'waterfall'

export interface EventOptions {
  /** 把监听器放到当前事件队列的开头。 */
  prepend?: boolean
  /** 跳过事件 thisArg 提供的 Context 过滤。 */
  global?: boolean
}

export interface EventHook<Callback extends EventCallback = EventCallback> {
  readonly context: Context
  readonly callback: Callback
  readonly global: boolean
}

export type EventCallback = (this: any, ...args: any[]) => any
type DeclaredEventName = Extract<keyof Events, string | symbol>
export type EventName = {
  [Name in DeclaredEventName]: Events[Name] extends EventCallback ? Name : never
}[DeclaredEventName]
export type EventListener<Name extends EventName> =
  Extract<Events[Name], EventCallback>
export type EventParameters<Callback> =
  Callback extends (this: any, ...args: infer Args) => any ? Args : never
export type EventReturn<Callback> =
  Callback extends (this: any, ...args: any[]) => infer Result ? Result : never
export type EventThis<Callback> =
  Callback extends (this: infer This, ...args: any[]) => any ? This : unknown
export type EventThisArgument<Callback> =
  unknown extends EventThis<Callback>
    ? object | null
    : Extract<EventThis<Callback>, object | null>

/** `serial()` 与 `bail()` 用它判断是否已经得到应当截断派发的结果。 */
export function isBailed(value: unknown) {
  return value !== null && value !== undefined && value !== false
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null)
    || typeof value === 'function'
}

function isThisArg(value: unknown) {
  // 与 Cordis 的重载判定保持一致：事件名只能是 string / symbol，
  // 因此 object、function（包括显式 null）都可无歧义地作为 thisArg。
  return typeof value === 'object' || typeof value === 'function'
}

function formatEventName(name: string | symbol) {
  return typeof name === 'string' ? JSON.stringify(name) : name.toString()
}

/** 根 Context 共享的监听器注册表。派生 Context 只影响监听器所有权与过滤。 */
export class EventRegistry {
  #hooks = new Map<string | symbol, EventHook[]>()

  constructor(readonly root: Context) {}

  /** 注册监听器，并把注册行为放入订阅方 Fiber 当前运行的 Effect 树。 */
  on(
    context: Context,
    name: string | symbol,
    listener: EventCallback,
    options: boolean | EventOptions = {},
    listenerKind: 'on' | 'once' = 'on',
  ): Disposer {
    if (context.root !== this.root) {
      throw new Error('cannot register an event listener from another Context tree')
    }
    this.#assertName(name)
    if (typeof listener !== 'function') {
      throw new TypeError('invalid event listener: expected a function')
    }

    const resolved = typeof options === 'boolean'
      ? { prepend: options }
      : options
    if (!resolved || typeof resolved !== 'object') {
      throw new TypeError('invalid event options: expected a boolean or object')
    }
    const prepend = resolved.prepend === true
    const global = resolved.global === true

    let hook: EventHook | undefined = {
      context,
      callback: listener,
      global,
    }
    let active = false

    const unregister = () => {
      if (!active || !hook) return
      active = false
      const current = hook
      hook = undefined // 手动取消后立即释放 callback 与 context 引用。

      const hooks = this.#hooks.get(name)
      if (!hooks) return

      const index = hooks.indexOf(current)
      if (index < 0) return
      hooks.splice(index, 1)
      if (hooks.length === 0) this.#hooks.delete(name)
    }

    const label = listenerKind === 'once'
      ? `ctx.once(${formatEventName(name)})`
      : `ctx.on(${formatEventName(name)})`
    const disposeEffect = withEffectDescriptor(
      context.fiber,
      {
        type: 'event-listener',
        label,
        eventName: name,
        listenerKind,
        global,
      },
      () => context.fiber.effect(() => {
        const current = hook!
        let hooks = this.#hooks.get(name)
        if (!hooks) {
          hooks = []
          this.#hooks.set(name, hooks)
        }

        if (prepend) {
          hooks.unshift(current)
        } else {
          hooks.push(current)
        }
        active = true

        return () => {
          unregister()
        }
      }, label),
    )

    // EffectScope 的清理允许异步完成。这里先同步摘除监听器，确保手动取消、
    // once() 和监听器内部递归派发都不会在下一个微任务前再次看到旧监听器。
    return () => {
      unregister()
      return disposeEffect()
    }
  }

  /** 注册只运行一次的监听器；首次进入回调前便同步取消注册。 */
  once(
    context: Context,
    name: string | symbol,
    listener: EventCallback,
    options?: boolean | EventOptions,
  ): Disposer {
    let dispose!: Disposer
    let fired = false
    dispose = this.on(context, name, function (this: unknown, ...args) {
      if (fired) return
      fired = true
      void dispose()
      return Reflect.apply(listener, this, args)
    }, options, 'once')
    return dispose
  }

  /** 同步依次调用当前快照中的全部监听器；任意异常会立即向外传播。 */
  emit(...input: unknown[]): void {
    const { thisArg, args, hooks } = this.#resolve(input)
    for (const hook of hooks) {
      Reflect.apply(hook.callback, thisArg, args)
    }
  }

  /** 并行等待全部监听器；失败不会阻止其他监听器完成，最后统一聚合报告。 */
  async parallel(...input: unknown[]): Promise<void> {
    const { thisArg, args, hooks, name } = this.#resolve(input)
    const results = await Promise.allSettled(hooks.map(async (hook) => {
      return Reflect.apply(hook.callback, thisArg, args)
    }))
    const errors = results.flatMap(result => {
      return result.status === 'rejected' ? [result.reason] : []
    })

    if (errors.length) {
      throw new AggregateError(
        errors,
        `event ${formatEventName(name)} failed in ${errors.length} listener(s)`,
      )
    }
  }

  /** 异步依次调用监听器，并在首个有效返回值处停止。 */
  async serial(...input: unknown[]): Promise<unknown> {
    const { thisArg, args, hooks } = this.#resolve(input)
    for (const hook of hooks) {
      const result = await Reflect.apply(hook.callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  /** 同步依次调用监听器，并在首个有效返回值处停止。 */
  bail(...input: unknown[]): unknown {
    const { thisArg, args, hooks } = this.#resolve(input)
    for (const hook of hooks) {
      const result = Reflect.apply(hook.callback, thisArg, args)
      if (isBailed(result)) return result
    }
  }

  /**
   * 以最后一个参数作为终点，把监听器组合成显式 `next()` 调用链。
   * 监听器不调用 `next()` 即可截断后续链路。
   */
  waterfall(...input: unknown[]): unknown {
    const { thisArg, args, hooks } = this.#resolve(input)
    const fallback = args.pop()
    if (typeof fallback !== 'function') {
      throw new TypeError('waterfall requires a final next callback')
    }

    let index = 0
    const next = (): unknown => {
      const hook = hooks[index++]
      if (hook) return Reflect.apply(hook.callback, thisArg, [...args, next])
      return Reflect.apply(fallback, undefined, [...args, next])
    }
    return next()
  }

  #resolve(input: unknown[]) {
    const values = [...input]
    let thisArg: unknown
    if (isThisArg(values[0])) thisArg = values.shift()

    const name = values.shift()
    this.#assertName(name)

    const filter = isObject(thisArg)
      ? Reflect.get(thisArg, contextFilter)
      : undefined
    const hooks = [...this.#hooks.get(name) ?? []].filter((hook) => {
      if (
        hook.context.fiber.state !== FiberState.ACTIVE
        && hook.context.fiber.state !== FiberState.LOADING
      ) {
        return false
      }
      if (hook.global || typeof filter !== 'function') return true
      return !!Reflect.apply(filter, thisArg, [hook.context])
    })

    return { name, thisArg, args: values, hooks }
  }

  #assertName(name: unknown): asserts name is string | symbol {
    if (
      typeof name !== 'string'
      && typeof name !== 'symbol'
    ) {
      throw new TypeError('invalid event name: expected a string or symbol')
    }
  }
}
