/** 本文件集中定义 `@nya/core` 跨模块及跨包副本共享的协议 Symbol。 */

export const contextMarker = Symbol.for('@nya/core/context')

/** Service 实例在提供方 Fiber 进入 ACTIVE 前执行的初始化协议。 */
export const serviceInit: unique symbol = Symbol.for(
  '@nya/core/service.init',
) as any

/** 判断一个已经 ACTIVE 的 Service 当前是否仍可作为依赖使用。 */
export const serviceCheck: unique symbol = Symbol.for(
  '@nya/core/service.check',
) as any
