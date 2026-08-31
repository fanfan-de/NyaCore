/** 本文件实现内存 Entry 树，并通过 Core 公开协议协调模块解析与 Fiber 生命周期。 */

import {
  FiberState,
  Service,
} from '@nya/core'
import type {
  Component,
  ComponentInstallOptions,
  Context,
  Fiber,
  Inject,
  IsolationLabel,
  RegistryEvent,
} from '@nya/core'
import {
  defaultLoaderResolver,
  normalizeLoaderResolution,
} from './resolver.js'
import type {
  EntryInput,
  EntrySnapshot,
  EntryState,
  EntryType,
  EntryUpdate,
  LoaderConfig,
  LoaderResolver,
} from './types.js'

interface EntryValues {
  readonly id: string
  readonly type: EntryType
  readonly name?: string
  readonly config?: unknown
  readonly disabled: boolean
  readonly inject?: Inject
  readonly intercept?: Readonly<Record<string, unknown>>
  readonly isolate?: Readonly<Record<string, IsolationLabel>>
  readonly baseUrl?: string
}

interface EntryRecord extends EntryValues {
  parentId: string | null
  children: string[]
  state: EntryState
  blockedBy?: string
  hasError: boolean
  error?: unknown
  fiber?: Fiber
  definition?: Component<any>
  configDirty: boolean
}

interface ParentTarget {
  readonly context?: Context
  readonly blockedBy?: string
  readonly disabled: boolean
}

const hasOwn = (value: object, property: PropertyKey) => {
  return Object.prototype.hasOwnProperty.call(value, property)
}

function assertRecord(value: unknown, label: string): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`invalid ${label}: expected an object`)
  }
}

function cloneInject(inject: Inject | undefined): Inject | undefined {
  if (inject === undefined) return
  if (Array.isArray(inject)) return Object.freeze([...inject])
  return Object.freeze({ ...inject })
}

function cloneIntercept(
  intercept: Readonly<Record<string, unknown>> | undefined,
) {
  return intercept === undefined
    ? undefined
    : Object.freeze({ ...intercept })
}

function cloneIsolate(
  isolate: Readonly<Record<string, IsolationLabel>> | undefined,
) {
  return isolate === undefined
    ? undefined
    : Object.freeze({ ...isolate })
}

function validateString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`invalid ${label}: expected a non-empty string`)
  }
}

function validateInject(inject: Inject | undefined) {
  if (inject === undefined) return
  if (Array.isArray(inject)) {
    for (const name of inject) validateString(name, 'inject service name')
    return
  }

  assertRecord(inject, 'inject')
  for (const name of Object.keys(inject)) {
    validateString(name, 'inject service name')
  }
}

function validateIntercept(
  intercept: Readonly<Record<string, unknown>> | undefined,
) {
  if (intercept === undefined) return
  assertRecord(intercept, 'intercept')
  for (const name of Object.keys(intercept)) {
    validateString(name, 'intercept service name')
  }
}

function validateIsolate(
  isolate: Readonly<Record<string, IsolationLabel>> | undefined,
) {
  if (isolate === undefined) return
  assertRecord(isolate, 'isolate')
  for (const [name, label] of Object.entries(isolate)) {
    validateString(name, 'isolate service name')
    if (typeof label !== 'symbol') {
      throw new TypeError('invalid isolate label: expected a symbol')
    }
  }
}

function validateEntryValues(values: EntryValues) {
  validateString(values.id, 'entry id')
  if (values.type !== 'component' && values.type !== 'group') {
    throw new TypeError(
      'invalid entry type: expected "component" or "group"',
    )
  }
  if (values.type === 'component') validateString(values.name, 'entry name')
  if (values.name !== undefined) validateString(values.name, 'entry name')
  if (typeof values.disabled !== 'boolean') {
    throw new TypeError('invalid disabled flag: expected a boolean')
  }
  if (values.baseUrl !== undefined) {
    validateString(values.baseUrl, 'entry baseUrl')
  }
  validateInject(values.inject)
  validateIntercept(values.intercept)
  validateIsolate(values.isolate)
}

function normalizeEntryInput(input: EntryInput): EntryValues {
  assertRecord(input, 'entry')
  const type = input.type ?? 'component'
  const values: EntryValues = {
    id: input.id,
    type,
    name: input.name,
    config: input.config,
    disabled: input.disabled ?? false,
    inject: cloneInject(input.inject),
    intercept: cloneIntercept(input.intercept),
    isolate: cloneIsolate(input.isolate),
    baseUrl: input.baseUrl,
  }
  validateEntryValues(values)
  return values
}

function captureUpdate(update: EntryUpdate): EntryUpdate {
  assertRecord(update, 'entry update')
  return {
    ...(hasOwn(update, 'type') ? { type: update.type } : {}),
    ...(hasOwn(update, 'name') ? { name: update.name } : {}),
    ...(hasOwn(update, 'config') ? { config: update.config } : {}),
    ...(hasOwn(update, 'disabled') ? { disabled: update.disabled } : {}),
    ...(hasOwn(update, 'inject')
      ? { inject: cloneInject(update.inject) }
      : {}),
    ...(hasOwn(update, 'intercept')
      ? { intercept: cloneIntercept(update.intercept) }
      : {}),
    ...(hasOwn(update, 'isolate')
      ? { isolate: cloneIsolate(update.isolate) }
      : {}),
    ...(hasOwn(update, 'baseUrl') ? { baseUrl: update.baseUrl } : {}),
  }
}

function normalizeIndex(index: number | undefined, length: number) {
  if (index === undefined) return length
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new RangeError(`invalid entry index: expected an integer from 0 to ${length}`)
  }
  return index
}

function mapFiberState(state: FiberState): EntryState {
  switch (state) {
    case FiberState.ACTIVE:
      return 'active'
    case FiberState.FAILED:
      return 'failed'
    case FiberState.LOADING:
      return 'resolving'
    case FiberState.PENDING:
    case FiberState.UNLOADING:
    case FiberState.DISPOSED:
      return 'pending'
  }
}

/** Loader 的内建 Group 只创建 Context / Fiber 所有权边界，不执行领域逻辑。 */
export const LoaderGroup: Component.Object<unknown> = Object.freeze({
  name: 'loader-group',
  apply() {},
})

/**
 * 管理稳定 Entry 树的通用外围 Service。
 *
 * Loader 只保存内存状态；文件格式、持久化、监听与 HMR 由更上层适配器负责。
 */
export class Loader extends Service {
  static readonly provide = 'loader'

  private readonly host: Context
  private readonly resolver: LoaderResolver
  private readonly baseUrl?: string
  private readonly records = new Map<string, EntryRecord>()
  private readonly roots: string[] = []
  private readonly fiberEntries = new Map<number, string>()
  private readonly scheduled = new Set<string>()
  private readonly awaitingFibers = new Map<number, number>()
  private operation: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(context: Context, config: LoaderConfig = {}) {
    super(context)
    if (config.resolver !== undefined && typeof config.resolver !== 'function') {
      throw new TypeError('invalid loader resolver: expected a function')
    }
    if (config.baseUrl !== undefined) {
      validateString(config.baseUrl, 'loader baseUrl')
    }

    this.host = context
    this.resolver = config.resolver ?? defaultLoaderResolver
    this.baseUrl = config.baseUrl

    context.effect(() => {
      const unsubscribe = context.registry.subscribe(event => {
        this.observeRegistry(event)
      })
      return () => {
        this.disposed = true
        unsubscribe()
        this.scheduled.clear()
        this.awaitingFibers.clear()
        this.fiberEntries.clear()
        this.records.clear()
        this.roots.length = 0
      }
    }, 'loader registry observer')
  }

  /** 创建 Entry，等待当前树及观察回调产生的后续协调稳定。 */
  async create(
    input: EntryInput,
    parentId: string | null = null,
    index?: number,
  ): Promise<EntrySnapshot> {
    const values = normalizeEntryInput(input)
    if (parentId !== null) validateString(parentId, 'parent entry id')

    const caller = this.ctx.fiber
    const reentrant = this.awaitingFibers.has(caller.id)
    const operation = async () => {
      if (this.records.has(values.id)) {
        throw new Error(`entry "${values.id}" already exists`)
      }
      const siblings = this.getSiblings(parentId)
      const insertion = normalizeIndex(index, siblings.length)
      const record: EntryRecord = {
        ...values,
        parentId,
        children: [],
        state: values.disabled ? 'disabled' : 'pending',
        hasError: false,
        configDirty: false,
      }
      this.records.set(record.id, record)
      siblings.splice(insertion, 0, record.id)
      await this.reconcileSubtree(record.id)
    }
    if (reentrant) await operation()
    else await this.enqueue(operation)

    // Component 启动或清理期间可以声明新的 Entry。若当前 Fiber 正被本轮
    // Loader 操作等待，嵌套创建直接在暂停点执行，避免队列自等待。
    if (
      !reentrant
      && caller.state !== FiberState.LOADING
      && caller.state !== FiberState.UNLOADING
    ) {
      await this.drain()
    }
    return this.requireSnapshot(values.id)
  }

  /** 更新 Entry；纯配置变更复用 Fiber，空间或安装覆盖变更重新安装子树。 */
  async update(id: string, update: EntryUpdate): Promise<EntrySnapshot> {
    validateString(id, 'entry id')
    const captured = captureUpdate(update)

    await this.enqueue(async () => {
      const record = this.requireRecord(id)
      const next: EntryValues = {
        id: record.id,
        type: hasOwn(captured, 'type')
          ? captured.type as EntryType
          : record.type,
        name: hasOwn(captured, 'name') ? captured.name : record.name,
        config: hasOwn(captured, 'config') ? captured.config : record.config,
        disabled: hasOwn(captured, 'disabled')
          ? captured.disabled as boolean
          : record.disabled,
        inject: hasOwn(captured, 'inject')
          ? captured.inject
          : record.inject,
        intercept: hasOwn(captured, 'intercept')
          ? captured.intercept
          : record.intercept,
        isolate: hasOwn(captured, 'isolate')
          ? captured.isolate
          : record.isolate,
        baseUrl: hasOwn(captured, 'baseUrl')
          ? captured.baseUrl
          : record.baseUrl,
      }
      validateEntryValues(next)

      const typeChanged = next.type !== record.type
      const nameChanged = next.name !== record.name
      const baseUrlChanged = next.baseUrl !== record.baseUrl
      const structural = typeChanged
        || nameChanged
        || baseUrlChanged
        || hasOwn(captured, 'inject')
        || hasOwn(captured, 'intercept')
        || hasOwn(captured, 'isolate')
      const configChanged = hasOwn(captured, 'config')
      const disabledChanged = next.disabled !== record.disabled

      Object.assign(record, next)
      if (typeChanged || nameChanged || baseUrlChanged) {
        record.definition = undefined
      }

      if (record.disabled) {
        await this.disposeRecordFiber(record)
        record.state = 'disabled'
        record.blockedBy = undefined
        await this.blockChildren(record, record.id, true)
        return
      }

      if (structural || disabledChanged) {
        await this.disposeRecordFiber(record)
        record.configDirty = false
        this.clearError(record)
        record.state = 'pending'
        record.blockedBy = undefined
        await this.reconcileSubtree(record.id, true)
        return
      }

      if (configChanged && record.type === 'component' && record.fiber) {
        await this.updateRecordConfig(record)
        if (record.fiber?.state === FiberState.ACTIVE) {
          for (const childId of record.children) {
            await this.reconcileSubtree(childId)
          }
        } else {
          await this.blockChildren(record, record.id, false)
        }
        return
      }

      if (configChanged && record.type === 'component' && !record.fiber) {
        record.configDirty = false
        this.clearError(record)
        record.state = 'pending'
        await this.reconcileSubtree(record.id, true)
      }
    })

    await this.drain()
    return this.requireSnapshot(id)
  }

  /** 移动 Entry；同一父级内只调整顺序，跨父级时重建被移动子树。 */
  async move(
    id: string,
    parentId: string | null,
    index?: number,
  ): Promise<EntrySnapshot> {
    validateString(id, 'entry id')
    if (parentId !== null) validateString(parentId, 'parent entry id')

    await this.enqueue(async () => {
      const record = this.requireRecord(id)
      if (parentId === id || this.isDescendant(parentId, id)) {
        throw new Error(`cannot move entry "${id}" into its own subtree`)
      }
      if (parentId !== null) this.requireRecord(parentId)

      const previousParent = record.parentId
      const previousSiblings = this.getSiblings(previousParent)
      const previousIndex = previousSiblings.indexOf(id)
      const targetSiblings = this.getSiblings(parentId)
      const targetLength = targetSiblings.length
        - (previousParent === parentId ? 1 : 0)
      const insertion = normalizeIndex(index, targetLength)

      previousSiblings.splice(previousIndex, 1)
      const finalSiblings = this.getSiblings(parentId)
      finalSiblings.splice(insertion, 0, id)
      record.parentId = parentId

      if (previousParent === parentId) return

      await this.disposeRecordFiber(record)
      record.configDirty = false
      this.clearError(record)
      record.state = record.disabled ? 'disabled' : 'pending'
      record.blockedBy = undefined
      await this.reconcileSubtree(id, true)
    })

    await this.drain()
    return this.requireSnapshot(id)
  }

  /** 永久移除 Entry 子树；Core 仍负责尽可能完成全部级联清理。 */
  async remove(id: string): Promise<void> {
    validateString(id, 'entry id')

    await this.enqueue(async () => {
      const record = this.requireRecord(id)
      const subtree = this.collectSubtree(id)
      await this.disposeRecordFiber(record)

      // 理论上父 Fiber 已经级联销毁所有后代；这里处理失败或外部竞态后
      // 仍残留的实例，且每个 Fiber.dispose() 本身保持幂等。
      for (const childId of subtree.slice(1).reverse()) {
        const child = this.records.get(childId)
        if (child?.fiber) await this.disposeRecordFiber(child)
      }

      const siblings = this.getSiblings(record.parentId)
      const position = siblings.indexOf(id)
      if (position >= 0) siblings.splice(position, 1)
      for (const entryId of subtree) {
        const current = this.records.get(entryId)
        if (current?.fiber) this.fiberEntries.delete(current.fiber.id)
        this.records.delete(entryId)
        this.scheduled.delete(entryId)
      }
    })

    await this.drain()
  }

  /** 显式重试解析、失败启动或尚未提交成功的配置。 */
  async resolve(id: string): Promise<EntrySnapshot> {
    validateString(id, 'entry id')

    await this.enqueue(async () => {
      const record = this.requireRecord(id)
      if (record.disabled) return
      if (!record.fiber && record.type === 'component') {
        record.definition = undefined
      }
      this.clearError(record)
      record.state = 'pending'
      await this.reconcileSubtree(id, true)
    })

    await this.drain()
    return this.requireSnapshot(id)
  }

  /** 读取一条冻结快照；不存在时返回 undefined。 */
  get(id: string): EntrySnapshot | undefined {
    this.assertOpen()
    validateString(id, 'entry id')
    const record = this.records.get(id)
    return record ? this.snapshot(record) : undefined
  }

  /** 以根顺序和子树先序返回全部冻结快照。 */
  entries(): readonly EntrySnapshot[] {
    this.assertOpen()
    const result: EntrySnapshot[] = []
    const visit = (id: string) => {
      const record = this.records.get(id)
      if (!record) return
      result.push(this.snapshot(record))
      for (const child of record.children) visit(child)
    }
    for (const id of this.roots) visit(id)
    return Object.freeze(result)
  }

  /** 等待当前以及等待期间由 Registry 观察产生的 Loader 协调任务稳定。 */
  async awaitIdle(): Promise<void> {
    this.assertOpen()
    await this.drain()
  }

  private enqueue<Value>(operation: () => Value | PromiseLike<Value>) {
    const task = this.operation.catch(() => {}).then(async () => {
      this.assertOpen()
      return operation()
    })
    this.operation = task.then(() => undefined, () => undefined)
    return task
  }

  private async drain() {
    while (true) {
      const operation = this.operation
      await operation
      const fibers = [...this.records.values()]
        .flatMap(record => record.fiber ? [record.fiber] : [])
      await Promise.allSettled(fibers.map(fiber => {
        return this.waitForFiber(fiber, () => fiber.awaitStable())
      }))
      await Promise.resolve()
      if (operation === this.operation) return
    }
  }

  private assertOpen() {
    if (this.disposed) throw new Error('loader is disposed')
  }

  private async waitForFiber<Value>(
    fiber: Fiber,
    operation: () => Value | PromiseLike<Value>,
  ): Promise<Value> {
    this.awaitingFibers.set(
      fiber.id,
      (this.awaitingFibers.get(fiber.id) ?? 0) + 1,
    )
    try {
      return await operation()
    } finally {
      const count = this.awaitingFibers.get(fiber.id) ?? 1
      if (count === 1) this.awaitingFibers.delete(fiber.id)
      else this.awaitingFibers.set(fiber.id, count - 1)
    }
  }

  private requireRecord(id: string) {
    const record = this.records.get(id)
    if (!record) throw new Error(`entry "${id}" does not exist`)
    return record
  }

  private requireSnapshot(id: string) {
    this.assertOpen()
    return this.snapshot(this.requireRecord(id))
  }

  private getSiblings(parentId: string | null) {
    return parentId === null
      ? this.roots
      : this.requireRecord(parentId).children
  }

  private snapshot(record: EntryRecord): EntrySnapshot {
    return Object.freeze({
      id: record.id,
      type: record.type,
      name: record.name,
      parentId: record.parentId,
      children: Object.freeze([...record.children]),
      disabled: record.disabled,
      state: record.state,
      ...(record.hasError ? { error: record.error } : {}),
      ...(record.fiber ? { fiberId: record.fiber.id } : {}),
      ...(record.blockedBy ? { blockedBy: record.blockedBy } : {}),
      config: record.config,
      inject: record.inject,
      intercept: record.intercept,
      isolate: record.isolate,
      baseUrl: record.baseUrl,
    })
  }

  private isDescendant(candidate: string | null, ancestor: string) {
    let current = candidate
    while (current !== null) {
      if (current === ancestor) return true
      current = this.requireRecord(current).parentId
    }
    return false
  }

  private collectSubtree(id: string) {
    const result: string[] = []
    const visit = (entryId: string) => {
      const record = this.requireRecord(entryId)
      result.push(entryId)
      for (const child of record.children) visit(child)
    }
    visit(id)
    return result
  }

  private clearError(record: EntryRecord) {
    record.hasError = false
    record.error = undefined
  }

  private fail(record: EntryRecord, error: unknown) {
    record.hasError = true
    record.error = error
    record.state = 'failed'
    record.blockedBy = undefined
  }

  private resolveParent(record: EntryRecord): ParentTarget {
    if (record.parentId === null) {
      return this.host.fiber.state === FiberState.ACTIVE
        ? { context: this.host, disabled: false }
        : { disabled: false }
    }

    const parent = this.requireRecord(record.parentId)
    if (parent.disabled || parent.state === 'disabled') {
      return {
        blockedBy: parent.blockedBy ?? parent.id,
        disabled: true,
      }
    }
    if (parent.fiber?.state === FiberState.ACTIVE) {
      return { context: parent.fiber.context, disabled: false }
    }
    return {
      blockedBy: parent.blockedBy ?? parent.id,
      disabled: false,
    }
  }

  private effectiveBaseUrl(record: EntryRecord) {
    let current: EntryRecord | undefined = record
    while (current) {
      if (current.baseUrl !== undefined) return current.baseUrl
      current = current.parentId === null
        ? undefined
        : this.records.get(current.parentId)
    }
    return this.baseUrl
  }

  private installOptions(record: EntryRecord): ComponentInstallOptions {
    return {
      inject: record.inject,
      intercept: record.intercept,
      isolate: record.isolate,
    }
  }

  private async reconcileSubtree(id: string, force = false): Promise<void> {
    const record = this.records.get(id)
    if (!record) return

    if (record.disabled) {
      await this.disposeRecordFiber(record)
      record.state = 'disabled'
      record.blockedBy = undefined
      await this.blockChildren(record, record.id, true)
      return
    }

    const parent = this.resolveParent(record)
    if (!parent.context) {
      await this.disposeRecordFiber(record)
      record.state = parent.disabled ? 'disabled' : 'pending'
      record.blockedBy = parent.blockedBy
      await this.blockChildren(
        record,
        parent.blockedBy ?? record.parentId ?? record.id,
        parent.disabled,
      )
      return
    }

    const active = await this.ensureRecord(record, force)
    if (!active) {
      await this.blockChildren(record, record.id, false)
      return
    }

    for (const childId of record.children) {
      await this.reconcileSubtree(childId, force)
    }
  }

  private async blockChildren(
    parent: EntryRecord,
    blockedBy: string,
    disabled: boolean,
  ) {
    for (const childId of parent.children) {
      await this.blockSubtree(childId, blockedBy, disabled)
    }
  }

  private async blockSubtree(
    id: string,
    blockedBy: string,
    ancestorDisabled: boolean,
  ): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    await this.disposeRecordFiber(record)

    const disabled = ancestorDisabled || record.disabled
    record.state = disabled ? 'disabled' : 'pending'
    record.blockedBy = record.disabled ? undefined : blockedBy
    for (const childId of record.children) {
      await this.blockSubtree(childId, blockedBy, disabled)
    }
  }

  private async ensureRecord(
    record: EntryRecord,
    force: boolean,
  ) {
    const currentFiber = record.fiber
    if (currentFiber) {
      if (force && record.configDirty) {
        await this.updateRecordConfig(record)
      } else if (
        force
        && (
          currentFiber.state === FiberState.FAILED
          || record.state === 'failed'
        )
      ) {
        record.state = 'resolving'
        this.clearError(record)
        try {
          await this.waitForFiber(currentFiber, () => currentFiber.restart())
        } catch (error) {
          this.fail(record, error)
        }
      } else if (
        currentFiber.state === FiberState.LOADING
        || currentFiber.state === FiberState.UNLOADING
      ) {
        try {
          await this.waitForFiber(
            currentFiber,
            () => currentFiber.awaitStable(),
          )
        } catch (error) {
          this.fail(record, error)
        }
      }

      if (record.fiber) this.syncFromFiber(record, record.fiber)
      return record.fiber?.state === FiberState.ACTIVE
    }

    if (record.state === 'failed' && !force) return false

    record.state = 'resolving'
    record.blockedBy = undefined
    this.clearError(record)

    try {
      if (record.type === 'group') {
        record.definition = LoaderGroup
      } else if (!record.definition) {
        const resolution = await this.resolver({
          id: record.id,
          name: record.name!,
          parentId: record.parentId,
          baseUrl: this.effectiveBaseUrl(record),
        })
        if (this.disposed || !this.records.has(record.id)) return false
        record.definition = normalizeLoaderResolution(resolution)
      }

      const latestParent = this.resolveParent(record)
      if (!latestParent.context) {
        record.state = latestParent.disabled ? 'disabled' : 'pending'
        record.blockedBy = latestParent.blockedBy
        return false
      }

      const fiber = latestParent.context.installComponent(
        record.definition,
        record.type === 'group' ? undefined : record.config,
        this.installOptions(record),
      )
      record.fiber = fiber
      record.configDirty = false
      this.fiberEntries.set(fiber.id, record.id)
      this.syncFromFiber(record, fiber)
      await this.waitForFiber(fiber, () => fiber.awaitStable())
      if (record.fiber === fiber) this.syncFromFiber(record, fiber)
    } catch (error) {
      this.fail(record, error)
    }

    return record.fiber?.state === FiberState.ACTIVE
  }

  private async updateRecordConfig(record: EntryRecord) {
    const fiber = record.fiber
    if (!fiber) return

    record.configDirty = true
    record.state = 'resolving'
    record.blockedBy = undefined
    this.clearError(record)
    try {
      await this.waitForFiber(fiber, () => fiber.update(record.config))
      record.configDirty = false
      if (record.fiber === fiber) this.syncFromFiber(record, fiber)
    } catch (error) {
      this.fail(record, error)
    }
  }

  private async disposeRecordFiber(record: EntryRecord) {
    const fiber = record.fiber
    if (!fiber) return

    try {
      await this.waitForFiber(fiber, () => fiber.dispose())
    } catch (error) {
      record.hasError = true
      record.error = error
    } finally {
      this.fiberEntries.delete(fiber.id)
      if (record.fiber === fiber) record.fiber = undefined
    }
  }

  private syncFromFiber(record: EntryRecord, fiber: Fiber) {
    if (record.fiber !== fiber) return
    record.blockedBy = undefined

    if (record.configDirty && record.hasError) {
      record.state = 'failed'
      return
    }

    record.state = mapFiberState(fiber.state)
    if (fiber.state === FiberState.FAILED) {
      record.hasError = true
      record.error = fiber.error
    } else if (
      fiber.state === FiberState.ACTIVE
      || fiber.state === FiberState.PENDING
    ) {
      this.clearError(record)
    }
  }

  private observeRegistry(event: RegistryEvent) {
    const entryId = this.fiberEntries.get(event.fiber.id)
    if (!entryId) return
    const record = this.records.get(entryId)
    if (!record || record.fiber?.id !== event.fiber.id) return

    if (event.type === 'detached') {
      this.fiberEntries.delete(event.fiber.id)
      record.fiber = undefined
      if (record.disabled) {
        record.state = 'disabled'
      } else {
        const parent = this.resolveParent(record)
        record.state = parent.disabled ? 'disabled' : 'pending'
        record.blockedBy = parent.blockedBy
      }
      this.schedule(entryId)
      return
    }

    record.blockedBy = undefined
    if (!(record.configDirty && record.hasError)) {
      record.state = mapFiberState(event.fiber.state)
      if (event.fiber.state === FiberState.FAILED) {
        record.hasError = true
        record.error = event.fiber.error
      } else if (
        event.fiber.state === FiberState.ACTIVE
        || event.fiber.state === FiberState.PENDING
      ) {
        this.clearError(record)
      }
    }

    if (
      event.type === 'state'
      && (
        event.fiber.state === FiberState.ACTIVE
        || event.fiber.state === FiberState.PENDING
        || event.fiber.state === FiberState.FAILED
        || event.fiber.state === FiberState.DISPOSED
      )
    ) {
      for (const child of record.children) this.schedule(child)
    }
  }

  private schedule(id: string) {
    if (this.disposed || this.scheduled.has(id)) return
    this.scheduled.add(id)
    void this.enqueue(async () => {
      this.scheduled.delete(id)
      if (this.records.has(id)) await this.reconcileSubtree(id)
    }).catch(() => {
      this.scheduled.delete(id)
    })
  }
}

declare module '@nya/core' {
  interface Context {
    loader: Loader
  }
}
