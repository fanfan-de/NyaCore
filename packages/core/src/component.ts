/** 本文件定义 Component 的三种声明形式，并把它们归一化为统一的运行信息。 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Context } from './context.js'
import type { CleanupSource } from './disposable.js'
import type { Inject, ResolvedInject } from './inject.js'
import { resolveInject } from './inject.js'

/**
 * 可安装的 Component 定义。
 *
 * 与 Cordis 一致，Component 可以是函数、构造器，或带 `apply` 的对象。
 */
export type Component<Config = unknown> =
  (
    | Component.Object<Config>
    | Component.Function<Config>
    | Component.Constructor<Config>
  ) & {
    /** 为联合类型中的对象字面量保留 `apply` 参数的上下文类型。 */
    apply?: Component.Function<Config>
  }

export namespace Component {
  /** 三种 Component 形式共享的静态元数据。 */
  export interface Base<Config = unknown> {
    name?: string
    Config?: StandardSchemaV1<any, Config>
    inject?: Inject
    // provide?: string | string[]
    // intercept?: Dict<boolean>
  }

  /** 直接调用的函数 Component。 */
  export interface Function<Config = unknown> extends Base<Config> {
    (context: Context, config: Config): CleanupSource
  }

  /** 通过 `new` 启动的 class / 构造器 Component。 */
  export interface Constructor<Config = unknown> extends Base<Config> {
    new (context: Context, config: Config): any
  }

  /** 通过 `apply` 方法启动的对象 Component。 */
  export interface Object<Config = unknown> extends Base<Config> {
    apply: Function<Config>
  }

  /** Registry 保存的归一化入口引用。 */
  export type Callback<Config = unknown> =
    | Function<Config>
    | Constructor<Config>

  /** Fiber 执行归一化入口的方式。 */
  export type Kind = 'function' | 'constructor'

  /** 从具体 Component 定义中提取配置类型。 */
  export type Config<Definition> =
    Definition extends Function<infer Config>
      ? Config
      : Definition extends Constructor<infer Config>
        ? Config
        : Definition extends Object<infer Config>
          ? Config
          : never
}

export interface ResolvedComponent {
  name?: string
  kind: Component.Kind
  callback: Component.Callback<any>
  inject: ResolvedInject
}

const GeneratorFunction = function* () {}.constructor
const AsyncGeneratorFunction = async function* () {}.constructor

/**
 * 沿用 Cordis 的构造器判定：有 prototype 的普通函数按构造器执行，
 * 箭头函数、async 函数、生成器和异步生成器按函数执行。
 */
function isConstructor(
  callback: Component.Callback<any>,
): callback is Component.Constructor<any> {
  if (!callback.prototype) return false
  if (callback instanceof GeneratorFunction) return false
  if (
    AsyncGeneratorFunction !== globalThis.Function
    && callback instanceof AsyncGeneratorFunction
  ) return false
  return true
}

/** 校验 Component，并提取 Registry 和 Fiber 使用的统一运行信息。 */
export function resolveComponent(
  component: Component<any>,
): ResolvedComponent {
  let callback: Component.Callback<any> | undefined

  // 与 Cordis 一样，直接函数 / class 以自身为入口，对象则以 apply 为入口。
  // getter 或 Proxy 在读取 apply 时也可能抛错，此时统一按无效定义处理。
  try {
    if (typeof component === 'function') {
      callback = component
    } else if (component && typeof component === 'object') {
      const apply = component.apply
      if (typeof apply === 'function') callback = apply
    }
  } catch {}

  if (!callback) {
    throw new TypeError(
      'invalid component: expected a function, class, or object with an apply method',
    )
  }

  const componentName = component.name
  const name = typeof componentName === 'string' && componentName !== 'apply'
    ? componentName
    : undefined

  return {
    callback,
    kind: isConstructor(callback) ? 'constructor' : 'function',
    name,
    inject: resolveInject(component.inject),
  }
}
