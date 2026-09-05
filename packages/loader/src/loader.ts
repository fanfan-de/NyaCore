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
  FiberFailureDiagnosticSnapshot,
  Inject,
  IsolationLabel,
  RegistryEvent,
} from '@nya/core'
import {
  defaultLoaderResolver,
  normalizeLoaderResolution,
} from './resolver.js'
import type {
  DefinitionReplacement,
  EntryMutationOptions,
  ReplaceOptions,
  ReplacementReport,
  EntryInput,
  EntrySnapshot,
  EntryState,
  EntryType,
  EntryUpdate,
  LoaderConfig,
  LoaderResolveRequest,
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
  resolution?: {
    readonly request: LoaderResolveRequest
    readonly definition: Component<any>
  }
  configDirty: boolean
  installationDirty: boolean
  cleanupBlocked: boolean
  acknowledgedCleanup?: FiberFailureDiagnosticSnapshot
}

type CleanupOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown }

interface ParentTarget {
  readonly context?: Context
  readonly blockedBy?: string
  readonly disabled: boolean
}

const hasOwn = (value: object, property: PropertyKey) => {
  return Object.prototype.hasOwnProperty.call(value, property)
}

function sameResolveRequest(left: LoaderResolveRequest, right: LoaderResolveRequest) {
  return left.id === right.id
    && left.name === right.name
    && left.parentId === right.parentId
    && left.baseUrl === right.baseUrl
}

/** 同一次级联清理可能从祖先和后代报告同一错误；按身份合并，不改写错误本身。 */
function uniqueCleanupErrors(errors: readonly unknown[]) {
  const members = new Map<AggregateError, readonly unknown[]>()
  const includes = (error: unknown, target: unknown, seen = new Set<AggregateError>()): boolean => {
    if (Object.is(error, target)) return true
    if (!(error instanceof AggregateError) || seen.has(error)) return false
    seen.add(error)
    if (!members.has(error)) {
      let nested: unknown
      try { nested = error.errors } catch {}
      members.set(error, Array.isArray(nested) ? nested : [])
    }
    return members.get(error)!.some(nested => includes(nested, target, seen))
  }
  const result: unknown[] = []
  for (const error of errors) {
    if (result.some(current => includes(current, error))) continue
    for (let index = result.length - 1; index >= 0; index--) {
      if (includes(error, result[index])) result.splice(index, 1)
    }
    // 只去掉重复收集的报告，不拆解或改写用户/父 Fiber 已产生的聚合错误。
    result.push(error)
  }
  return result
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
  private componentResolver: LoaderResolver
  private targetRevision = 0
  private replacing = false
  private readonly replacementEntries = new Set<string>()
  private readonly baseUrl?: string
  private readonly records = new Map<string, EntryRecord>()
  private readonly roots: string[] = []
  private readonly fiberEntries = new Map<number, string>()
  private readonly scheduled = new Set<string>()
  private readonly awaitingFibers = new Map<number, number>()
  private readonly disposingFibers = new Set<number>()
  private readonly removingRoots = new Set<string>()
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
    this.componentResolver = config.resolver ?? defaultLoaderResolver
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
        this.disposingFibers.clear()
        this.removingRoots.clear()
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
    options: EntryMutationOptions = {},
  ): Promise<EntrySnapshot> {
    const values = normalizeEntryInput(input)
    const expectedRevision = this.captureRevision(options)
    if (parentId !== null) validateString(parentId, 'parent entry id')

    const caller = this.ctx.fiber
    const reentrant = this.isSelfWaiting(caller)
    const register = () => {
      this.assertOpen()
      this.assertRevision(expectedRevision)
      this.assertParentAvailable(parentId)
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
        installationDirty: false,
        cleanupBlocked: false,
      }
      this.records.set(record.id, record)
      this.targetRevision++
      siblings.splice(insertion, 0, record.id)
      return record
    }
    if (reentrant) {
      const record = register()
      const parent = this.resolveParent(record)
      record.state = record.disabled || parent.disabled ? 'disabled' : 'pending'
      record.blockedBy = record.disabled ? undefined : parent.blockedBy
      // 生命周期暂停点只登记条目。解析和启动不得反向等待本轮清理或新服务。
      this.schedule(record.id)
      return this.snapshot(record)
    }
    await this.enqueue(async () => {
      const record = register()
      await this.reconcileSubtree(record.id)
    })

    // 尚未被 Loader 管理的生命周期调用也不等待全树稳定；普通外部调用
    // 则等待本轮操作及 Registry 事件产生的后续协调。
    if (
      caller.state !== FiberState.LOADING
      && caller.state !== FiberState.UNLOADING
    ) {
      await this.drain()
    }
    return this.requireSnapshot(values.id)
  }

  /** 更新 Entry；纯配置变更复用 Fiber，空间或安装覆盖变更重新安装子树。 */
  async update(id: string, update: EntryUpdate, options: EntryMutationOptions = {}): Promise<EntrySnapshot> {
    this.assertNotSelfWaiting('update')
    validateString(id, 'entry id')
    const captured = captureUpdate(update)
    const expectedRevision = this.captureRevision(options)

    await this.enqueue(async () => {
      this.assertRevision(expectedRevision)
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
      this.targetRevision++
      record.installationDirty ||= structural
      if (configChanged && record.type === 'component') record.configDirty = true
      if (record.cleanupBlocked) return

      if (record.disabled) {
        await this.disposeRecordFiber(record)
        if (!record.cleanupBlocked) record.state = 'disabled'
        record.blockedBy = undefined
        await this.blockChildren(record, record.id, true)
        return
      }

      if (structural || disabledChanged) {
        await this.disposeRecordFiber(record)
        if (record.cleanupBlocked) {
          await this.blockChildren(record, record.id, false)
          return
        }
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
    options: EntryMutationOptions = {},
  ): Promise<EntrySnapshot> {
    this.assertNotSelfWaiting('move')
    validateString(id, 'entry id')
    if (parentId !== null) validateString(parentId, 'parent entry id')
    const expectedRevision = this.captureRevision(options)

    await this.enqueue(async () => {
      this.assertRevision(expectedRevision)
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
      this.targetRevision++

      if (previousParent === parentId) return

      record.installationDirty = true
      if (record.cleanupBlocked) return
      await this.disposeRecordFiber(record)
      if (record.cleanupBlocked) {
        await this.blockChildren(record, record.id, record.disabled)
        return
      }
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
  async remove(id: string, options: EntryMutationOptions = {}): Promise<void> {
    this.assertNotSelfWaiting('remove')
    validateString(id, 'entry id')
    const expectedRevision = this.captureRevision(options)

    const errors = await this.enqueue(async () => {
      this.assertRevision(expectedRevision)
      const record = this.requireRecord(id)
      const subtree = this.collectSubtree(id)
      // 删除也必须报告尚未通过 resolve 确认的历史清理失败。
      const failures = subtree.flatMap(entryId => {
        const entry = this.requireRecord(entryId)
        return entry.cleanupBlocked ? [entry.error] : []
      })
      this.removingRoots.add(id)
      try {
        const cleanup = await this.disposeRecordFiber(record)
        if (!cleanup.ok) failures.push(cleanup.error)

        // 已 DISPOSED 的后代不重复调用 dispose，避免再取得其缓存的拒绝。
        for (const childId of subtree.slice(1).reverse()) {
          const child = this.records.get(childId)
          if (!child?.fiber || child.fiber.state === FiberState.DISPOSED) continue
          const cleanup = await this.disposeRecordFiber(child)
          if (!cleanup.ok) failures.push(cleanup.error)
        }
      } finally {
        const siblings = this.getSiblings(record.parentId)
        const position = siblings.indexOf(id)
        if (position >= 0) siblings.splice(position, 1)
        for (const entryId of subtree) {
          const current = this.records.get(entryId)
          if (current?.fiber) this.fiberEntries.delete(current.fiber.id)
          this.records.delete(entryId)
          this.scheduled.delete(entryId)
        }
        this.targetRevision++
        this.removingRoots.delete(id)
      }
      return uniqueCleanupErrors(failures)
    })

    await this.drain()
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'multiple errors while removing entry subtree')
  }

  /** 显式重试解析、失败启动或尚未提交成功的配置。 */
  async resolve(id: string): Promise<EntrySnapshot> {
    this.assertNotSelfWaiting('resolve')
    validateString(id, 'entry id')

    await this.enqueue(async () => {
      const record = this.requireRecord(id)
      if (record.cleanupBlocked && record.fiber) {
        record.acknowledgedCleanup = record.fiber.inspect().lastFailure
      }
      record.cleanupBlocked = false
      this.clearError(record)
      if (record.fiber?.state === FiberState.DISPOSED) {
        this.fiberEntries.delete(record.fiber.id)
        record.fiber = undefined
      }
      if (record.disabled || record.installationDirty) {
        await this.disposeRecordFiber(record)
        if (record.cleanupBlocked) return
      }
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
    this.assertNotSelfWaiting('awaitIdle')
    this.assertOpen()
    await this.drain()
  }

  /** 声明与定义版本；单纯的 Fiber 状态变化不会递增。 */
  get revision(): number { return this.targetRevision }
  /** 捕获当前 Resolver，用于外围适配器构造保持原解析行为的包装。 */
  get resolver(): LoaderResolver { return this.componentResolver }
  private captureRevision(options: EntryMutationOptions): number | undefined {
    const revision = options.expectedRevision
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new TypeError('invalid expectedRevision')
    return revision
  }
  private assertRevision(expected: number | undefined): void {
    if (expected !== undefined && expected !== this.targetRevision) throw new Error('stale Loader revision: expected ' + expected + ', received ' + this.targetRevision)
  }
  /** 读取当前有效解析请求，不调用 Resolver。Group 没有解析请求。 */
  request(id: string): LoaderResolveRequest | undefined {
    this.assertOpen()
    const record = this.requireRecord(id)
    if (record.type === 'group') return
    return Object.freeze({ id, name: record.name!, parentId: record.parentId, baseUrl: this.effectiveBaseUrl(record) })
  }

  /** 先清理整个替换集合，再在同一队列提交定义和 Resolver；不自动解除清理阻断。 */
  async replace(replacements: readonly DefinitionReplacement[], options: ReplaceOptions): Promise<ReplacementReport> {
    this.assertNotSelfWaiting('replace')
    if (!Number.isSafeInteger(options?.expectedRevision) || options.expectedRevision < 0) throw new TypeError('expectedRevision must be a non-negative integer')
    if (options.resolver !== undefined && typeof options.resolver !== 'function') throw new TypeError('invalid replacement resolver')
    const revision = options.expectedRevision
    const resolver = options.resolver
    const signal = options.signal
    const seen = new Set<string>()
    const affected = new Set<string>()
    const prepared = replacements.map(item => {
      validateString(item.id, 'replacement id')
      if (seen.has(item.id)) throw new Error('duplicate replacement id: ' + item.id)
      seen.add(item.id)
      affected.add(item.id)
      return { id: item.id, definition: normalizeLoaderResolution(item.definition) }
    })
    const result = await this.enqueue(async () => {
      let committed = false
      const errors: unknown[] = []
      const report = (status: ReplacementReport['status']): ReplacementReport => Object.freeze({
        revision: this.targetRevision, committed, status, errors: Object.freeze([...errors]),
        entries: Object.freeze(prepared.flatMap(({ id }) => { const entry = this.get(id); return entry ? [entry] : [] })),
      })
      if (signal?.aborted || revision !== this.targetRevision) return report('stale')
      for (const { id } of prepared) {
        const record = this.requireRecord(id)
        if (record.type !== 'component') throw new Error('cannot replace a group definition: ' + id)
        const blocked = this.collectSubtree(id).map(child => this.requireRecord(child)).find(child => child.cleanupBlocked)
        if (blocked) {
          errors.push(blocked.error)
          return report('failed')
        }
      }
      const roots = prepared.filter(({ id }) => !prepared.some(other => other.id !== id && this.isDescendant(id, other.id)))
      for (const { id } of roots) for (const child of this.collectSubtree(id)) {
        this.replacementEntries.add(child)
        affected.add(child)
      }
      this.replacing = true
      try {
        for (const { id } of roots) {
          const cleanup = await this.disposeRecordFiber(this.requireRecord(id))
          if (!cleanup.ok) { errors.push(cleanup.error); return report('failed') }
        }
        // 用户清理期间允许 create() 登记声明；此时旧构建已经过期。
        if (signal?.aborted || revision !== this.targetRevision) return report('stale')
        if (resolver) this.componentResolver = resolver
        for (const { id, definition } of prepared) {
          const record = this.requireRecord(id)
          record.resolution = { request: this.request(id)!, definition }
          this.clearError(record)
          record.installationDirty = false
          record.configDirty = false
        }
        this.targetRevision++
        committed = true
        for (const { id } of roots) await this.reconcileSubtree(id, true)
        for (const { id } of prepared) {
          const record = this.requireRecord(id)
          if (record.state === 'failed') errors.push(record.error)
        }
        return report(errors.length ? 'failed' : 'applied')
      } finally {
        this.replacing = false
        this.replacementEntries.clear()
        // 清理中断时，尚无 Fiber 的条目保持已声明目标，由后续显式恢复处理。
      }
    })
    await this.drain()
    const entries = [...affected].flatMap(id => { const entry = this.get(id); return entry ? [entry] : [] })
    const errors = uniqueCleanupErrors([...result.errors, ...entries.filter(entry => entry.state === 'failed').map(entry => entry.error)])
    return Object.freeze({ ...result, revision: this.targetRevision,
      status: result.status === 'applied' && errors.length ? 'failed' : result.status,
      errors: Object.freeze(errors), entries: Object.freeze(entries) })
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

  private isSelfWaiting(caller: Fiber) {
    for (let current: Fiber | null = caller; current; current = current.parent) {
      if (this.awaitingFibers.has(current.id)) return true
      // 外部依赖失效或 Fiber.restart() 也能进入 Entry 生命周期，此时
      // Loader 尚未等待任何 Fiber；排入 awaitIdle 等操作仍会反向等待自己。
      if (
        this.fiberEntries.has(current.id)
        && (current.state === FiberState.LOADING || current.state === FiberState.UNLOADING)
      ) return true
    }
    // 服务失效可等待另一棵所有权子树中的消费者清理。只对生命周期调用
    // 使用保守判断；正常 ACTIVE Root 的并发操作仍然进入串行队列。
    return this.awaitingFibers.size > 0
      && (caller.state === FiberState.LOADING || caller.state === FiberState.UNLOADING)
  }

  private assertNotSelfWaiting(operation: string) {
    if (this.isSelfWaiting(this.ctx.fiber)) {
      throw new Error(`loader.${operation}() cannot self-wait during a lifecycle operation; only create() supports reentry`)
    }
  }

  private assertParentAvailable(parentId: string | null) {
    for (let current = parentId; current !== null;) {
      if (this.removingRoots.has(current)) {
        throw new Error(`entry "${current}" is being removed`)
      }
      current = this.requireRecord(current).parentId
    }
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
      // FAILED 事件先于 Core 完成失败诊断；稳定后再读取最终清理证据。
      const entryId = this.fiberEntries.get(fiber.id)
      const record = entryId === undefined ? undefined : this.records.get(entryId)
      if (record && !this.disposingFibers.has(fiber.id)) this.syncFromFiber(record, fiber)
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
      dependencies: record.fiber?.inspect().dependencies ?? Object.freeze([]),
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
    if (record.cleanupBlocked) return
    record.hasError = false
    record.error = undefined
  }

  private fail(record: EntryRecord, error: unknown) {
    if (record.cleanupBlocked) return
    record.hasError = true
    record.error = error
    record.state = 'failed'
    record.blockedBy = undefined
  }

  private blockCleanup(record: EntryRecord, error: unknown) {
    record.cleanupBlocked = true
    record.hasError = true
    record.error = error
    record.state = 'failed'
    record.blockedBy = undefined
  }

  private observeCleanupFailure(record: EntryRecord, fiber: Fiber) {
    if (record.cleanupBlocked) return
    if (fiber.state !== FiberState.FAILED && fiber.state !== FiberState.DISPOSED) return
    const failure = fiber.inspect().lastFailure
    if (failure === record.acknowledgedCleanup) return
    // 启动回滚失败的外层 phase 仍是 start；以公开的具体清理证据判别，
    // 保留包含启动与回滚失败的完整原错误，而不阻断普通的启动失败恢复。
    if (failure && (
      failure.phase === 'cleanup'
      || failure.failures.some(item => item.stage === 'cleanup'
        || item.stage === 'service-invalidate'
        || item.stage === 'service-finalize')
    )) this.blockCleanup(record, failure.error)
  }

  private resolveParent(record: EntryRecord): ParentTarget {
    if (record.parentId === null) {
      return this.host.fiber.state === FiberState.ACTIVE
        ? { context: this.host, disabled: false }
        : { disabled: false }
    }

    const parent = this.requireRecord(record.parentId)
    if (parent.cleanupBlocked) {
      return { blockedBy: parent.id, disabled: parent.disabled }
    }
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

    if (record.cleanupBlocked) {
      await this.blockChildren(record, record.id, record.disabled)
      return
    }

    if (record.disabled) {
      await this.disposeRecordFiber(record)
      if (!record.cleanupBlocked) record.state = 'disabled'
      record.blockedBy = undefined
      await this.blockChildren(record, record.id, true)
      return
    }

    const parent = this.resolveParent(record)
    if (!parent.context) {
      await this.disposeRecordFiber(record)
      if (!record.cleanupBlocked) {
        record.state = parent.disabled ? 'disabled' : 'pending'
        record.blockedBy = parent.blockedBy
      }
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
    if (!record.cleanupBlocked) await this.disposeRecordFiber(record)

    const disabled = ancestorDisabled || record.disabled
    if (!record.cleanupBlocked) {
      record.state = disabled ? 'disabled' : 'pending'
      record.blockedBy = record.disabled ? undefined : blockedBy
    }
    for (const childId of record.children) {
      await this.blockSubtree(childId, blockedBy, disabled)
    }
  }

  private async ensureRecord(
    record: EntryRecord,
    force: boolean,
  ) {
    if (record.cleanupBlocked) return false
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
      let definition: Component<any>
      if (record.type === 'group') {
        definition = LoaderGroup
      } else {
        const request: LoaderResolveRequest = Object.freeze({
          id: record.id,
          name: record.name!,
          parentId: record.parentId,
          baseUrl: this.effectiveBaseUrl(record),
        })
        if (!record.resolution || !sameResolveRequest(record.resolution.request, request)) {
          record.resolution = undefined
          const resolution = await this.componentResolver(request)
          if (this.disposed || this.records.get(record.id) !== record) return false
          record.resolution = { request, definition: normalizeLoaderResolution(resolution) }
        }
        definition = record.resolution.definition
      }

      const latestParent = this.resolveParent(record)
      if (!latestParent.context) {
        record.state = latestParent.disabled ? 'disabled' : 'pending'
        record.blockedBy = latestParent.blockedBy
        return false
      }

      const fiber = latestParent.context.installComponent(
        definition,
        record.type === 'group' ? undefined : record.config,
        this.installOptions(record),
      )
      record.fiber = fiber
      record.configDirty = false
      record.installationDirty = false
      record.acknowledgedCleanup = undefined
      this.fiberEntries.set(fiber.id, record.id)
      this.syncFromFiber(record, fiber)
      await this.waitForFiber(fiber, () => fiber.awaitStable())
      if (record.fiber === fiber) this.syncFromFiber(record, fiber)
    } catch (error) {
      if (record.fiber) this.observeCleanupFailure(record, record.fiber)
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
      this.observeCleanupFailure(record, fiber)
      this.fail(record, error)
    }
  }

  private async disposeRecordFiber(record: EntryRecord): Promise<CleanupOutcome> {
    const fiber = record.fiber
    if (!fiber) return { ok: true }

    this.disposingFibers.add(fiber.id)
    try {
      await this.waitForFiber(fiber, () => fiber.dispose())
      return { ok: true }
    } catch (error) {
      this.blockCleanup(record, error)
      return { ok: false, error }
    } finally {
      this.disposingFibers.delete(fiber.id)
      if (fiber.state === FiberState.DISPOSED) {
        this.fiberEntries.delete(fiber.id)
        if (record.fiber === fiber) record.fiber = undefined
      }
    }
  }

  private syncFromFiber(record: EntryRecord, fiber: Fiber) {
    if (record.fiber !== fiber) return
    this.observeCleanupFailure(record, fiber)
    if (record.cleanupBlocked) return
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
      // 本层主动 dispose 的结果以 Promise 为准；lastFailure 可能是用户
      // 刚通过 resolve 确认过的旧清理失败，不能在成功销毁时重新上锁。
      if (!this.disposingFibers.has(event.fiber.id)) {
        this.observeCleanupFailure(record, record.fiber)
      }
      this.fiberEntries.delete(event.fiber.id)
      record.fiber = undefined
      if (record.cleanupBlocked) return
      if (record.disabled) {
        record.state = 'disabled'
      } else {
        const parent = this.resolveParent(record)
        record.state = parent.disabled ? 'disabled' : 'pending'
        record.blockedBy = parent.blockedBy
      }
      if (!this.replacing || !this.replacementEntries.has(entryId)) this.schedule(entryId)
      return
    }

    if (record.cleanupBlocked) return
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
      if (event.fiber.state === FiberState.FAILED && (!this.replacing || !this.replacementEntries.has(entryId))) this.schedule(entryId)
      for (const child of record.children) if (!this.replacing || !this.replacementEntries.has(child)) this.schedule(child)
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
