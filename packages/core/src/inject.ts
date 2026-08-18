/** 本文件定义组件的服务依赖声明，并把公开写法归一化为稳定的只读映射。 */

/**
 * 组件需要的服务。
 *
 * 数组形式只声明服务名称；对象形式为后续的服务拦截配置保留每项配置值。
 * 当前动态依赖内核只关心键是否存在，但不会丢弃对象形式携带的配置。
 */
export type Inject =
  | readonly string[]
  | Readonly<Record<string, unknown>>

/** Fiber 内部使用的、不会受用户后续修改影响的依赖声明。 */
export type ResolvedInject = ReadonlyMap<string, unknown>

function assertServiceName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('invalid inject: service names must be non-empty strings')
  }
}

/** 将数组或对象形式复制为独立 Map，同时自然消除重复的服务名称。 */
export function resolveInject(inject?: Inject | null): ResolvedInject {
  const result = new Map<string, unknown>()
  if (!inject) return result

  if (Array.isArray(inject)) {
    for (const name of inject) {
      assertServiceName(name)
      result.set(name, null)
    }
    return result
  }

  for (const [name, config] of Object.entries(
    inject as Readonly<Record<string, unknown>>,
  )) {
    assertServiceName(name)
    result.set(name, config ?? null)
  }

  return result
}
