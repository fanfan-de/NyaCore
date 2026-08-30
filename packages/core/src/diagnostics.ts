/** 本文件维护 Fiber/Effect 的只读诊断镜像，不参与资源所有权与清理顺序。 */

import type { FiberState } from './fiber.js'
import type {
  FiberStopReason,
  LifecyclePhase,
} from './logger.js'

export type EffectDiagnosticType =
  | 'custom'
  | 'component-entry'
  | 'component-install'
  | 'event-listener'
  | 'service-provider'
  | 'logger-subscriber'

export type EffectDiagnosticState =
  | 'starting'
  | 'active'
  | 'disposing'
  | 'disposed'
  | 'setup-failed'
  | 'cleanup-failed'

export type EffectFailureStage =
  | 'setup'
  | 'cleanup'
  | 'service-invalidate'
  | 'service-finalize'

export interface EffectFailureDiagnosticSnapshot {
  readonly sequence: number
  readonly stage: EffectFailureStage
  readonly occurredAt: string
  readonly effectPath: readonly string[]
  readonly error: unknown
  readonly serviceName?: string
  readonly ownerFiberId?: number
  readonly sourceFiberId?: number
}

/** 包内结构化登记信息；公开快照只复制其中可序列观察的字段。 */
export interface EffectDescriptor {
  readonly type: EffectDiagnosticType
  readonly label: string
  readonly eventName?: string | symbol
  readonly listenerKind?: 'on' | 'once'
  readonly global?: boolean
  readonly serviceName?: string
  implementationId?: number
  readonly childFiberId?: number
  readonly child?: DiagnosticChildFiber
  readonly ownerFiberId?: number
  sourceFiberId?: number
}

const pendingDescriptors = new WeakMap<object, EffectDescriptor[]>()

/**
 * 在一次同步 effect() 调用边界内传入 Core 私有描述；effect() 一进入便消费，
 * 因而组件 setup 中再创建的嵌套 Effect 不会误继承外层类型。
 */
export function withEffectDescriptor<Result>(
  owner: object,
  descriptor: EffectDescriptor,
  callback: () => Result,
): Result {
  let descriptors = pendingDescriptors.get(owner)
  if (!descriptors) {
    descriptors = []
    pendingDescriptors.set(owner, descriptors)
  }
  descriptors.push(descriptor)
  try {
    return callback()
  } finally {
    const index = descriptors.lastIndexOf(descriptor)
    if (index >= 0) descriptors.splice(index, 1)
    if (descriptors.length === 0) pendingDescriptors.delete(owner)
  }
}

export function consumeEffectDescriptor(
  owner: object,
  label: string,
): EffectDescriptor {
  const descriptors = pendingDescriptors.get(owner)
  const descriptor = descriptors?.pop()
  if (descriptors?.length === 0) pendingDescriptors.delete(owner)
  return descriptor ?? { type: 'custom', label }
}

export interface EffectDiagnosticSnapshot {
  readonly id: number
  readonly type: EffectDiagnosticType
  readonly label: string
  readonly state: EffectDiagnosticState
  readonly createdAt: string
  readonly updatedAt: string
  readonly children: readonly EffectDiagnosticSnapshot[]
  /** 该节点直接观察到的失败；传播到包装层的同一错误仍保留在节点内。 */
  readonly failures: readonly EffectFailureDiagnosticSnapshot[]
  readonly error?: unknown
  readonly eventName?: string | symbol
  readonly listenerKind?: 'on' | 'once'
  readonly global?: boolean
  readonly serviceName?: string
  readonly implementationId?: number
  readonly childFiberId?: number
  readonly ownerFiberId?: number
  readonly sourceFiberId?: number
}

export interface FiberFailureDiagnosticSnapshot {
  readonly fiberId: number
  readonly componentName: string
  readonly state: FiberState
  readonly runId?: number
  readonly occurredAt: string
  readonly phase: LifecyclePhase
  readonly stopReason?: FiberStopReason
  readonly error: unknown
  /** 去除祖先包装层重复错误后，按具体路径优先排列的失败证据。 */
  readonly failures: readonly EffectFailureDiagnosticSnapshot[]
  readonly effectPaths: readonly (readonly string[])[]
  readonly effects: readonly EffectDiagnosticSnapshot[]
}

export interface FiberDiagnosticSnapshot {
  readonly id: number
  readonly fiberId: number
  readonly name: string
  readonly componentName: string
  readonly state: FiberState
  readonly runId?: number
  readonly stateSince: string
  readonly effects: readonly EffectDiagnosticSnapshot[]
  readonly children: readonly FiberDiagnosticSnapshot[]
  readonly lastFailure?: FiberFailureDiagnosticSnapshot
}

export interface DiagnosticFiberOwner {
  readonly id: number
  readonly name: string
  readonly state: FiberState
  readonly runId: number | undefined
  readonly stateSince: string
}

export interface DiagnosticChildFiber {
  readonly id: number
  inspect(): FiberDiagnosticSnapshot
}

interface EffectNode {
  readonly id: number
  readonly descriptor: EffectDescriptor
  readonly createdAt: string
  updatedAt: string
  state: EffectDiagnosticState
  error?: unknown
  readonly failures: EffectFailureEvidence[]
  readonly parent?: EffectNode
  readonly children: EffectNode[]
}

interface EffectFailureEvidence {
  readonly sequence: number
  readonly stage: EffectFailureStage
  readonly occurredAt: string
  readonly error: unknown
  readonly serviceName?: string
  readonly ownerFiberId?: number
  readonly sourceFiberId?: number
}

interface DetachedFailureEvidence extends EffectFailureEvidence {
  readonly effectPath: readonly string[]
}

let effectCounter = 0
let failureCounter = 0

function now() {
  return new Date().toISOString()
}

function freezeArray<T>(values: T[]): readonly T[] {
  return Object.freeze(values)
}

function failureLeaves(
  error: unknown,
  seen = new Set<AggregateError>(),
): unknown[] {
  if (!(error instanceof AggregateError) || seen.has(error)) return [error]

  seen.add(error)
  let errors: unknown
  try {
    errors = error.errors
  } catch {
    return [error]
  }
  if (!Array.isArray(errors) || errors.length === 0) return [error]
  return errors.flatMap(item => failureLeaves(item, seen))
}

function isCoveredByDescendants(
  error: unknown,
  descendants: readonly EffectFailureDiagnosticSnapshot[],
) {
  const descendantLeaves = descendants.flatMap(failure => {
    return failureLeaves(failure.error)
  })
  return failureLeaves(error).every(leaf => {
    return descendantLeaves.some(candidate => Object.is(candidate, leaf))
  })
}

function snapshotFailure(
  evidence: EffectFailureEvidence,
  effectPath: readonly string[],
): EffectFailureDiagnosticSnapshot {
  return Object.freeze({
    sequence: evidence.sequence,
    stage: evidence.stage,
    occurredAt: evidence.occurredAt,
    effectPath: Object.freeze([...effectPath]),
    error: evidence.error,
    serviceName: evidence.serviceName,
    ownerFiberId: evidence.ownerFiberId,
    sourceFiberId: evidence.sourceFiberId,
  })
}

/**
 * 子节点先于父节点返回；若父节点的错误完全由后代错误组成，它只是传播包装层，
 * 不再作为独立失败路径。兄弟节点之间不按 error identity 去重。
 */
function collectSpecificFailures(
  nodes: readonly EffectNode[],
  parentPath: readonly string[] = [],
): EffectFailureDiagnosticSnapshot[] {
  const failures: EffectFailureDiagnosticSnapshot[] = []
  for (const node of nodes) {
    const path = [...parentPath, node.descriptor.label]
    const descendants = collectSpecificFailures(node.children, path)
    failures.push(...descendants)
    for (const evidence of node.failures) {
      if (!isCoveredByDescendants(evidence.error, descendants)) {
        failures.push(snapshotFailure(evidence, path))
      }
    }
  }
  return failures
}

function snapshotEffect(
  node: EffectNode,
  activeOnly: boolean,
  parentPath: readonly string[] = [],
): EffectDiagnosticSnapshot | undefined {
  if (activeOnly && node.state === 'disposed') return
  const path = [...parentPath, node.descriptor.label]
  const children = node.children.flatMap(child => {
    const snapshot = snapshotEffect(child, activeOnly, path)
    return snapshot ? [snapshot] : []
  })
  return Object.freeze({
    id: node.id,
    type: node.descriptor.type,
    label: node.descriptor.label,
    state: node.state,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    children: freezeArray(children),
    failures: freezeArray(node.failures.map(failure => {
      return snapshotFailure(failure, path)
    })),
    error: node.error,
    eventName: node.descriptor.eventName,
    listenerKind: node.descriptor.listenerKind,
    global: node.descriptor.global,
    serviceName: node.descriptor.serviceName,
    implementationId: node.descriptor.implementationId,
    childFiberId: node.descriptor.childFiberId,
    ownerFiberId: node.descriptor.ownerFiberId,
    sourceFiberId: node.descriptor.sourceFiberId,
  })
}

export interface EffectDiagnosticHandle {
  readonly node: EffectNode
  readonly path: readonly string[]
  readonly state: EffectDiagnosticState
  setState(state: EffectDiagnosticState, error?: unknown): void
  recordFailure(stage: EffectFailureStage, error: unknown): void
  hasTransitionalAncestor(): boolean
}

export class FiberDiagnostics {
  #roots: EffectNode[] = []
  #detachedFailures: DetachedFailureEvidence[] = []
  #lastFailure: FiberFailureDiagnosticSnapshot | undefined

  beginRun() {
    this.#roots = []
    this.#detachedFailures = []
  }

  createEffect(
    descriptor: EffectDescriptor,
    parent?: EffectDiagnosticHandle,
  ): EffectDiagnosticHandle {
    const timestamp = now()
    const node: EffectNode = {
      id: ++effectCounter,
      descriptor,
      createdAt: timestamp,
      updatedAt: timestamp,
      state: 'starting',
      failures: [],
      parent: parent?.node,
      children: [],
    }
    const siblings = parent ? parent.node.children : this.#roots
    siblings.push(node)

    const path = Object.freeze([
      ...parent?.path ?? [],
      descriptor.label,
    ])
    const recordFailure = (stage: EffectFailureStage, error: unknown) => {
      if (!node.failures.some(failure => {
        return failure.stage === stage && Object.is(failure.error, error)
      })) {
        node.failures.push({
          sequence: ++failureCounter,
          stage,
          occurredAt: now(),
          error,
          serviceName: node.descriptor.serviceName,
          ownerFiberId: node.descriptor.ownerFiberId,
          sourceFiberId: node.descriptor.sourceFiberId,
        })
      }
      node.state = stage === 'setup' ? 'setup-failed' : 'cleanup-failed'
      node.updatedAt = now()
      if (node.failures.length === 1) node.error = error
    }

    return {
      node,
      path,
      get state() {
        return node.state
      },
      setState(state, error) {
        if (state === 'setup-failed') {
          recordFailure('setup', error)
          return
        }
        if (state === 'cleanup-failed') {
          recordFailure('cleanup', error)
          return
        }
        node.state = state
        node.updatedAt = now()
        if (error !== undefined) node.error = error
        if (state === 'disposed') {
          const index = siblings.indexOf(node)
          if (index >= 0) siblings.splice(index, 1)
        }
      },
      recordFailure,
      hasTransitionalAncestor() {
        let ancestor = node.parent
        while (ancestor) {
          if (ancestor.state === 'starting' || ancestor.state === 'disposing') {
            return true
          }
          ancestor = ancestor.parent
        }
        return false
      },
    }
  }

  clearRun() {
    this.#roots = []
    this.#detachedFailures = []
  }

  recordDetachedFailure(
    effectPath: readonly string[],
    stage: Extract<EffectFailureStage, 'service-invalidate' | 'service-finalize'>,
    error: unknown,
    details: {
      readonly serviceName?: string
      readonly ownerFiberId?: number
      readonly sourceFiberId?: number
    } = {},
  ) {
    this.#detachedFailures.push({
      sequence: ++failureCounter,
      stage,
      occurredAt: now(),
      effectPath: Object.freeze([...effectPath]),
      error,
      ...details,
    })
  }

  failurePaths(handle: EffectDiagnosticHandle) {
    const failures = collectSpecificFailures(
      [handle.node],
      handle.path.slice(0, -1),
    ).sort((left, right) => {
      return right.effectPath.length - left.effectPath.length
        || left.sequence - right.sequence
    })
    return freezeArray(uniquePaths(failures.map(failure => failure.effectPath)))
  }

  captureFailure(
    owner: DiagnosticFiberOwner,
    phase: LifecyclePhase,
    error: unknown,
    stopReason?: FiberStopReason,
  ) {
    const effects = this.#snapshotEffects(false)
    const failures = [
      ...collectSpecificFailures(this.#roots),
      ...this.#detachedFailures.map(failure => {
        return snapshotFailure(failure, failure.effectPath)
      }),
    ].sort((left, right) => {
      return right.effectPath.length - left.effectPath.length
        || left.sequence - right.sequence
    })
    const effectPaths = uniquePaths(failures.map(failure => failure.effectPath))

    this.#lastFailure = Object.freeze({
      fiberId: owner.id,
      componentName: owner.name,
      state: owner.state,
      runId: owner.runId,
      occurredAt: now(),
      phase,
      stopReason,
      error,
      failures: freezeArray(failures),
      effectPaths: freezeArray(effectPaths),
      effects,
    })
  }

  effectPaths() {
    return this.#lastFailure?.effectPaths ?? freezeArray([])
  }

  inspect(owner: DiagnosticFiberOwner): FiberDiagnosticSnapshot {
    const childIds = new Set<number>()
    const children: FiberDiagnosticSnapshot[] = []
    const visit = (nodes: readonly EffectNode[]) => {
      for (const node of nodes) {
        if (node.state !== 'disposed') {
          const child = node.descriptor.child
          if (child && !childIds.has(child.id)) {
            childIds.add(child.id)
            children.push(child.inspect())
          }
          visit(node.children)
        }
      }
    }
    visit(this.#roots)

    return Object.freeze({
      id: owner.id,
      fiberId: owner.id,
      name: owner.name,
      componentName: owner.name,
      state: owner.state,
      runId: owner.runId,
      stateSince: owner.stateSince,
      effects: this.#snapshotEffects(true),
      children: freezeArray(children),
      lastFailure: this.#lastFailure,
    })
  }

  #snapshotEffects(activeOnly: boolean) {
    const effects = this.#roots.flatMap(node => {
      const snapshot = snapshotEffect(node, activeOnly)
      return snapshot ? [snapshot] : []
    })
    return freezeArray(effects)
  }
}

function uniquePaths(paths: readonly (readonly string[])[]) {
  const unique: (readonly string[])[] = []
  for (const path of paths) {
    if (!unique.some(current => {
      return current.length === path.length
        && current.every((label, index) => label === path[index])
    })) {
      unique.push(Object.freeze([...path]))
    }
  }
  return unique
}
