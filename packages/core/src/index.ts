/** 本文件是 `@nya/core` 的公开入口，集中导出核心运行时 API 与类型。 */

export { Context } from './context.js'
export {
  DisposableStack,
  EffectScope,
} from './disposable.js'
export type {
  Cleanup,
  CleanupSource,
  Disposer,
} from './disposable.js'
export { EventRegistry, isBailed } from './events.js'
export type {
  DispatchMode,
  EventCallback,
  EventHook,
  EventListener,
  EventName,
  EventOptions,
  EventParameters,
  EventReturn,
  Events,
  EventThis,
  EventThisArgument,
} from './events.js'
export { Fiber, FiberState } from './fiber.js'
export type {
  Component,
} from './component.js'
export type { Inject, ResolvedInject } from './inject.js'
export { Registry } from './registry.js'
export type { ComponentRuntime } from './registry.js'
export { Service, ServiceRegistry } from './service.js'
export type {
  DependencySnapshot,
  ServiceImplementation,
} from './service.js'
export {
  contextFilter,
  contextMarker,
  serviceCheck,
  serviceInit,
} from './symbols.js'
