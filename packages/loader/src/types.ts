/** 本文件定义 Loader 的公开 Entry、解析器、状态与配置协议。 */

import type {
  Component,
  Inject,
  IsolationLabel,
} from '@nya/core'

export type Awaitable<Value> = Value | PromiseLike<Value>

export type EntryType = 'component' | 'group'

export type EntryState =
  | 'disabled'
  | 'resolving'
  | 'pending'
  | 'active'
  | 'failed'

interface EntryInputBase {
  /** Loader 树中稳定且唯一的身份，不等同于 Fiber ID。 */
  readonly id: string
  /** 传给 Component 的原始配置；Loader 不负责解释或转换。 */
  readonly config?: unknown
  /** 禁用本条目及其整棵子树，但保留树结构和原始配置。 */
  readonly disabled?: boolean
  /** 只作用于本次安装的额外依赖与 Service 调用配置。 */
  readonly inject?: Inject
  /** 只作用于本次安装的 Context intercept。 */
  readonly intercept?: Readonly<Record<string, unknown>>
  /** 只作用于本次安装的严格 Service 隔离标签。 */
  readonly isolate?: Readonly<Record<string, IsolationLabel>>
  /** 相对模块名使用的 URL 基址；子条目会继承最近的祖先值。 */
  readonly baseUrl?: string
}

export interface ComponentEntryInput extends EntryInputBase {
  readonly type?: 'component'
  /** 交给 LoaderResolver 的模块名或其他稳定解析名。 */
  readonly name: string
}

export interface GroupEntryInput extends EntryInputBase {
  readonly type: 'group'
  /** 可选的人类可读标签；Group 不会交给 LoaderResolver。 */
  readonly name?: string
}

export type EntryInput = ComponentEntryInput | GroupEntryInput

/** 更新不允许替换稳定 Entry ID；显式传入 undefined 可清除可选字段。 */
export interface EntryUpdate {
  readonly type?: EntryType
  readonly name?: string
  readonly config?: unknown
  readonly disabled?: boolean
  readonly inject?: Inject
  readonly intercept?: Readonly<Record<string, unknown>>
  readonly isolate?: Readonly<Record<string, IsolationLabel>>
  readonly baseUrl?: string
}

/** 与 Loader 内部可变记录断开的冻结观察快照。 */
export interface EntrySnapshot {
  readonly id: string
  readonly type: EntryType
  readonly name?: string
  readonly parentId: string | null
  readonly children: readonly string[]
  readonly disabled: boolean
  readonly state: EntryState
  readonly error?: unknown
  readonly fiberId?: number
  readonly blockedBy?: string
  readonly config?: unknown
  readonly inject?: Inject
  readonly intercept?: Readonly<Record<string, unknown>>
  readonly isolate?: Readonly<Record<string, IsolationLabel>>
  readonly baseUrl?: string
}

export interface LoaderResolveRequest {
  readonly id: string
  readonly name: string
  readonly parentId: string | null
  readonly baseUrl?: string
}

/** Resolver 可以直接返回 Component，也可以返回带 default Component 的模块命名空间。 */
export type LoaderResolution =
  | Component<any>
  | Readonly<{ default: Component<any> }>

export type LoaderResolver = (
  request: LoaderResolveRequest,
) => Awaitable<LoaderResolution>

export interface LoaderConfig {
  /** 默认使用动态 import；测试、注册表和宿主环境可以提供自己的解析器。 */
  readonly resolver?: LoaderResolver
  /** 没有 Entry / 祖先覆盖时，相对模块名使用的 URL 基址。 */
  readonly baseUrl?: string
}
