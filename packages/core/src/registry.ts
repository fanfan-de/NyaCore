/** 本文件管理组件 Runtime，并负责把组件定义安装为独立的 Context 与 Fiber。 */

import type { Context } from './context.js'
import { Fiber } from './fiber.js'
import type {
  Component,
  ResolvedComponent,
} from './component.js'
import { resolveComponent } from './component.js'

/** 同一个 Component 定义在 Registry 中共享的 Runtime 元数据。 */
export interface ComponentRuntime {
  name?: string
  callback: Component.Callback<any>
  kind: Component.Kind
  fibers: Set<Fiber>
}

export class Registry {
  readonly root: Context

  #runtimes = new Map<Component.Callback<any>, ComponentRuntime>()

  constructor(root: Context) {
    this.root = root
  }

  install<Definition extends Component<any>>(
    parent: Context,
    component: Definition,
    config?: Component.Config<Definition>,
  ): Fiber {
    // 1. 解析并校验组件定义，得到 Registry 和 Fiber 实际使用的运行信息。
    const definition: ResolvedComponent = resolveComponent(component)

    // 2. 只有 ACTIVE 或仍处于 LOADING 的父组件才能继续安装子组件。
    parent.fiber.assertActive()

    // 3. 按组件入口函数复用 Runtime 元数据；同一定义的每次安装
    //    仍然会获得相互独立的 Context 和 Fiber。
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

    // 4. 从父 Context 派生组件 Context，并创建负责本次安装生命周期的 Fiber。
    //    Fiber 卸载时，detach 会同步移除实例登记和已经空闲的 Runtime。
    const context = parent.extend()
    let fiber!: Fiber
    fiber = Fiber.component({
      context,
      parent: parent.fiber,
      runtime,
      inject: definition.inject,
      config,
      detach: () => {
        runtime.fibers.delete(fiber)
        if (runtime.fibers.size === 0) {
          this.#runtimes.delete(runtime.callback)
        }
      },
    })

    // 5. 用本次安装的 Fiber 覆盖子 Context 从原型链继承的父 Fiber，
    //    并锁定该引用，防止组件在运行期间替换自己的生命周期控制器。
    Object.defineProperty(context, 'fiber', {
      configurable: false,
      enumerable: true,
      value: fiber,
      writable: false,
    })

    // 启动前先登记实例，确保启动与卸载流程都能通过 Runtime 找到它。
    runtime.fibers.add(fiber)

    try {
      // 6. 把子组件登记为父 Fiber 的 Effect：Effect 执行时启动子 Fiber，
      //    清理时卸载子 Fiber，从而在父组件卸载时自然完成级联清理。
      parent.fiber.effect(() => {
        fiber.start()
        return () => fiber.dispose()
      }, `ctx.installComponent(${JSON.stringify(runtime.name ?? 'anonymous')})`)
    } catch (error) {
      // 父 Effect 登记同步失败时，本次安装尚未成立，需要回滚上面的 Runtime 登记。
      runtime.fibers.delete(fiber)
      if (runtime.fibers.size === 0) {
        this.#runtimes.delete(runtime.callback)
      }
      throw error
    }

    // 7. 返回 Fiber，供调用方等待启动结果或主动触发卸载。
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
