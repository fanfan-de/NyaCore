/** 本文件管理组件 Runtime，并负责把组件定义安装为独立的 Context 与 Fiber。 */

import type { Context } from './context.js'
import { Fiber } from './fiber.js'
import type { Component } from './component.js'
import { resolveComponent } from './component.js'

/** 同一个 Component 定义在 Registry 中共享的 Runtime 元数据。 */
export interface ComponentRuntime {
  name?: string
  callback: Component.Callback<any>
  kind: Component.Kind
  fibers: Set<Fiber>
}

export class Registry {
  #runtimes = new Map<Component.Callback<any>, ComponentRuntime>()

  install<Definition extends Component<any>>(
    parent: Context,
    component: Definition,
    config?: Component.Config<Definition>,
  ): Fiber {
    const definition = resolveComponent(component)
    parent.fiber.assertActive()

    // Runtime 属于定义；Context 和 Fiber 属于本次安装。
    let runtime = this.#runtimes.get(definition.callback)
    if (!runtime) {
      runtime = {
        name: definition.name,
        callback: definition.callback,
        kind: definition.kind,
        fibers: new Set(),
      }
      this.#runtimes.set(definition.callback, runtime)
    }

    const context = parent.extend()
    let fiber!: Fiber
    const detach = () => {
      runtime.fibers.delete(fiber)
      if (runtime.fibers.size === 0) {
        this.#runtimes.delete(runtime.callback)
      }
    }
    fiber = Fiber.component({
      context,
      parent: parent.fiber,
      runtime,
      inject: definition.inject,
      config,
      detach,
    })

    // 组件 Context 只覆盖继承来的 Fiber，其余根级构件继续通过原型共享。
    Object.defineProperty(context, 'fiber', {
      configurable: false,
      enumerable: true,
      value: fiber,
      writable: false,
    })

    runtime.fibers.add(fiber)

    try {
      // 父 Fiber 通过一个 Effect 拥有子 Fiber，建立唯一的级联清理路径。
      parent.fiber.effect(() => {
        fiber.start()
        return () => fiber.dispose()
      }, `ctx.installComponent(${JSON.stringify(runtime.name ?? 'anonymous')})`)
    } catch (error) {
      detach()
      throw error
    }

    return fiber
  }

  get<Definition extends Component<any>>(component: Definition) {
    const { callback } = resolveComponent(component)
    return this.#runtimes.get(callback)
  }

  async delete<Definition extends Component<any>>(component: Definition) {
    const runtime = this.get(component)
    if (!runtime) return
    await Promise.all([...runtime.fibers].map(fiber => fiber.dispose()))
  }
}
