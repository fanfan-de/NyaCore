/** 本文件集中定义 Core 协议 Symbol，并区分全局互操作协议与包内协议。 */

export const contextMarker = Symbol.for('@nya/core/context')

/** 服务解析空间的身份标签。标签只在同一棵 Root Context 内参与寻址。 */
export type IsolationLabel = symbol

export const contextIsolations: unique symbol = Symbol.for('@nya/core/context.isolations') as any

export const contextIntercepts: unique symbol = Symbol.for('@nya/core/context.intercepts') as any

export const serviceCapture = Symbol('@nya/core/service.capture')

export const serviceSubscribe = Symbol('@nya/core/service.subscribe')

export const serviceInspectDependencies = Symbol('@nya/core/service.inspect-dependencies')

/** ServiceRegistry 从 Fiber 固定快照读取实现的包内协议。 */
export const fiberGetServiceImplementation = Symbol('@nya/core/fiber.get-service-implementation')

export const fiberGetServiceSource = Symbol('@nya/core/fiber.get-service-source')

export const fiberBeforeUnload = Symbol('@nya/core/fiber.before-unload')

export const fiberSetOwnerDisposer = Symbol('@nya/core/fiber.set-owner-disposer')

/** 父级安装 Effect 清理子 Fiber 时绕过公开 owner 路由，避免自等待。 */
export const fiberDisposeFromOwner = Symbol('@nya/core/fiber.dispose-from-owner')

export const registryNotifyFiberState = Symbol('@nya/core/registry.notify-fiber-state')

export const serviceContextFilter = Symbol('@nya/core/service.context-filter')

export const contextFilter: unique symbol = Symbol.for('@nya/core/context.filter') as any

export const serviceInit: unique symbol = Symbol.for('@nya/core/service.init') as any

export const serviceCheck: unique symbol = Symbol.for('@nya/core/service.check') as any

export const serviceConfig: unique symbol = Symbol.for('@nya/core/service.config') as any

export const serviceResolveConfig: unique symbol = Symbol.for('@nya/core/service.resolve-config') as any

export const serviceMergeConfig: unique symbol = Symbol.for('@nya/core/service.merge-config') as any
