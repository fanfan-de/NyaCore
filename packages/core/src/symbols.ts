/** 本文件集中定义 Core 协议 Symbol，并区分全局互操作协议与包内协议。 */

export const contextMarker = Symbol.for('@nya/core/context')

/** 服务解析空间的身份标签。标签只在同一棵 Root Context 内参与寻址。 */
export type IsolationLabel = symbol

/** Context 内部保存按服务名继承的隔离标签映射。 */
export const contextIsolations: unique symbol = Symbol.for(
  '@nya/core/context.isolations',
) as any

/** Fiber 捕获服务快照的包内协议，不从公共入口导出。 */
export const serviceCapture = Symbol('@nya/core/service.capture')

/** Fiber 订阅服务地址变化的包内协议，不从公共入口导出。 */
export const serviceSubscribe = Symbol('@nya/core/service.subscribe')

/** ServiceRegistry 从 Fiber 固定快照读取实现的包内协议。 */
export const fiberGetServiceImplementation = Symbol(
  '@nya/core/fiber.get-service-implementation',
)

/** ServiceRegistry 捕获 Fiber 当前 Provider run 身份的包内协议。 */
export const fiberGetServiceSource = Symbol(
  '@nya/core/fiber.get-service-source',
)

/** ServiceRegistry 在 Provider Effect 清理前登记依赖失效工作的包内协议。 */
export const fiberBeforeUnload = Symbol(
  '@nya/core/fiber.before-unload',
)

/** Service 按调用方服务地址过滤事件的包内协议，不从公共入口导出。 */
export const serviceContextFilter = Symbol(
  '@nya/core/service.context-filter',
)

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
