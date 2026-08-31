/** 本文件是 `@nya/core` 的公开入口，集中导出核心运行时 API 与类型。 */

export { Context } from './context.js'
export { ValidationError } from './config.js'
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
  EffectDiagnosticSnapshot,
  EffectDiagnosticState,
  EffectDiagnosticType,
  EffectFailureDiagnosticSnapshot,
  EffectFailureStage,
  FiberDiagnosticSnapshot,
  FiberFailureDiagnosticSnapshot,
} from './diagnostics.js'
export type {
  FiberStopReason,
  LifecyclePhase,
  Logger,
  LogEventCode,
  LogLevel,
  LogRecord,
  LogSink,
  LogSubscribeOptions,
} from './logger.js'
export type {
  Component,
  ComponentInstallOptions,
  Inject,
  ResolvedInject,
  ResolvedIntercept,
} from './component.js'
export { Registry } from './registry.js'
export type {
  ComponentRuntime,
  ComponentRuntimeLifecycleSnapshot,
  FiberLifecycleSnapshot,
  RegistryEvent,
  RegistryListener,
  RegistrySubscribeOptions,
} from './registry.js'
export { Service, ServiceRegistry } from './service.js'
export type {
  DependencySnapshot,
  ServiceImplementation,
} from './service.js'
export type { IsolationLabel } from './symbols.js'
export {
  contextFilter,
  contextMarker,
  serviceCheck,
  serviceConfig,
  serviceInit,
  serviceMergeConfig,
  serviceResolveConfig,
} from './symbols.js'
