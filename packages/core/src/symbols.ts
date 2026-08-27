/** 本文件集中定义 `@nya/core` 跨模块及跨包副本共享的协议 Symbol。 */

export const contextMarker = Symbol.for('@nya/core/context')

/** 服务解析空间的身份标签。标签只在同一棵 Root Context 内参与寻址。 */
export type IsolationLabel = symbol

/** Context 内部保存按服务名继承的隔离标签映射。 */
export const contextIsolations: unique symbol = Symbol.for(
  '@nya/core/context.isolations',
) as any

/** 事件 thisArg 可以实现本协议，按订阅方 Context 过滤局部监听器。 */
export const contextFilter: unique symbol = Symbol.for(
  '@nya/core/context.filter',
) as any

/** Service 实例在提供方 Fiber 进入 ACTIVE 前执行的初始化协议。 */
export const serviceInit: unique symbol = Symbol.for(
  '@nya/core/service.init',
) as any

/** 判断一个已经 ACTIVE 的 Service 当前是否仍可作为依赖使用。 */
export const serviceCheck: unique symbol = Symbol.for(
  '@nya/core/service.check',
) as any
