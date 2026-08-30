/** 本文件定义 Component 的三种声明形式，并把它们归一化为统一的运行信息。 */
import type { Context } from './context.js'
import type { CleanupSource } from './disposable.js'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/** 组件需要的服务；对象形式当前同样只读取键。 */
export type Inject =
  | readonly string[]
  | Readonly<Record<string, unknown>>

/** Fiber 内部使用的、不会受用户后续修改影响的依赖名称集合。 */
export type ResolvedInject = ReadonlySet<string>

/** 把公开声明复制为独立 Set，同时校验并消除重复名称。 */
export function resolveInject(inject?: Inject | null): ResolvedInject {
  const result = new Set<string>()
  const names = Array.isArray(inject)
    ? inject
    : Object.keys(inject ?? {})

  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(
        'invalid inject: service names must be non-empty strings',
      )
    }
    result.add(name)
  }

  return result
}

export type Component<TConfig = unknown> =
  (
    | Component.Object<TConfig>
    | Component.Function<TConfig>
    | Component.Constructor<TConfig>
  ) & {
    apply?: Component.Function<TConfig>
  }

export namespace Component {
  /** 三种 Component 形式共享的静态元数据。 */
  export interface Base<TConfig = unknown> {
    name?: string
    inject?: Inject
    Config?: StandardSchemaV1<unknown, TConfig>
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
  Config?: StandardSchemaV1<unknown, any>
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
    Config: component.Config,
  }
}