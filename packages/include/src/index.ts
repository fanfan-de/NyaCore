/** 文件配置控制器。宿主先安装，再显式 refresh；所有资源随 Include Fiber 清理。 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import { Service } from '@nya/core'
import type { Context } from '@nya/core'
import type { EntrySnapshot, Loader } from '@nya/loader'
import { validateDocument } from './document.js'
import type { IncludeDocument } from './document.js'
import { checkSources, entryId, readGraph, writeSource } from './source.js'
import type { ConfigSource, SourceGraph } from './source.js'
import { planEntries } from './planner.js'
import type { IncludeOperation } from './planner.js'

export { DocumentError, validateDocument } from './document.js'
export type { IncludeDocument, IncludeEntry, JsonValue } from './document.js'
export { ConfigConflictError } from './source.js'
export type { ConfigSource } from './source.js'
export type { IncludeOperation } from './planner.js'

export interface IncludeOptions {
  /** JSON/YAML 文件绝对路径，或相对于宿主 cwd 的路径；后代从文件目录解析。 */
  readonly path: string
  /** Loader 中独占的挂载根 ID；声明条目位于这个命名空间下。 */
  readonly id: string
}
export interface IncludeFailure {
  readonly operation: IncludeOperation
  readonly error: unknown
}
export interface IncludeReport {
  readonly revision: number
  readonly saved: boolean
  readonly status: 'applied' | 'partial'
  readonly sources: readonly ConfigSource[]
  readonly entries: readonly EntrySnapshot[]
  readonly failures: readonly IncludeFailure[]
  readonly operations: readonly IncludeOperation[]
}
declare module '@nya/core' { interface Context { include: Include } }
const executions = new AsyncLocalStorage<{ token: object; active: boolean }>()

export class Include extends Service {
  static readonly provide = 'include'
  static readonly inject = ['loader']
  private readonly loader: Loader
  private readonly filename: string
  readonly namespace: string
  private readonly owned = new Set<string>()
  private readonly labels = new Map<string, symbol>()
  private readonly watched = new Set<string>()
  private graph?: SourceGraph
  private latest?: IncludeReport
  private sequence = 0
  private operation: Promise<unknown> = Promise.resolve()
  private closing = false
  private readonly owner: Context
  private readonly executionToken = {}

  constructor(context: Context, options: IncludeOptions) {
    super(context)
    if (!options || typeof options.path !== 'string' || !options.path || typeof options.id !== 'string' || !options.id) {
      throw new TypeError('Include requires path and id')
    }
    this.owner = context
    this.loader = context.loader
    this.filename = resolve(options.path)
    this.namespace = options.id
    this.watched.add(this.filename)
    context.effect(() => () => this.shutdown(), 'include controller')
  }

  /** 文件内条目到稳定 Loader 身份的映射；mounts 为 include 挂载 ID 链。 */
  entryId(id: string, mounts: readonly string[] = []): string {
    return entryId(mounts.reduce(entryId, this.namespace), id)
  }
  /** 包括失败刷新中新发现的来源，供文件监听恢复使用。 */
  watchPaths(): readonly string[] { return Object.freeze([...this.watched]) }
  document(filename = this.filename): IncludeDocument | undefined { return this.graph?.sources.get(resolve(filename))?.document }
  report(): IncludeReport | undefined { return this.latest }
  /** 已接受目标中条目的所属文件；动态条目和未知 ID 没有声明来源。 */
  source(id: string): ConfigSource | undefined {
    const filename = this.graph?.entries.find(entry => entry.input.id === id)?.source
    const source = filename && this.graph?.sources.get(filename)
    return source ? Object.freeze({ filename: source.filename, digest: source.digest, document: source.document }) : undefined
  }
  sources(): readonly ConfigSource[] {
    return Object.freeze([...(this.graph?.sources.values() ?? [])].map(({ filename, digest, document }) => Object.freeze({ filename, digest, document })))
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Include is closing'))
    if (this.selfWaiting()) return Promise.reject(new Error('Include cannot await itself during a lifecycle operation'))
    const task = this.operation.catch(() => {}).then(async () => {
      if (this.closing) throw new Error('Include is closing')
      const frame = { token: this.executionToken, active: true }
      try { return await executions.run(frame, action) } finally { frame.active = false }
    })
    this.operation = task
    return task
  }
  private selfWaiting(): boolean {
    const frame = executions.getStore()
    return frame?.token === this.executionToken && frame.active
  }
  private read(override?: { filename: string; document: IncludeDocument }) {
    return readGraph(this.filename, this.namespace, this.labels, this.watched, override)
  }
  private plan(graph: SourceGraph) {
    return planEntries(graph.entries, this.loader.entries(), this.owned, this.namespace)
  }

  /** 静态预览，不执行 Resolver 或组件 Schema；未给文档时预览当前磁盘。 */
  preview = (input?: IncludeDocument, filename = this.filename): Promise<readonly IncludeOperation[]> => {
    const override = input === undefined ? undefined : { filename: resolve(filename), document: validateDocument(input) }
    return this.enqueue(async () => this.plan(await this.read(override)))
  }
  /** 重读整个来源图。无效来源拒绝并保留上次接受的目标及运行。 */
  refresh = (): Promise<IncludeReport> => {
    return this.enqueue(async () => {
      const graph = await this.read()
      const revision = this.loader.revision
      const plan = this.plan(graph)
      await checkSources(graph.sources)
      return this.apply(graph, plan, false, revision)
    })
  }
  /** 单次仅编辑一个已挂载来源；先保存目标，再协调运行。 */
  save = (input: IncludeDocument, filename = this.filename): Promise<IncludeReport> => {
    const document = validateDocument(input)
    filename = resolve(filename)
    return this.enqueue(async () => {
      const previous = this.graph?.sources.get(filename)
      if (!previous || !this.graph) throw new Error('refresh before editing a mounted source')
      await checkSources(this.graph.sources)
      const graph = await this.read({ filename, document })
      const revision = this.loader.revision
      const plan = this.plan(graph)
      await checkSources(graph.sources)
      if (this.closing) throw new Error('Include is closing')
      graph.sources.set(filename, await writeSource(previous, document))
      return this.apply(graph, plan, true, revision)
    })
  }
  /** 明确恢复某个受管条目，不修改配置文件或恢复其他条目的清理阻断。 */
  recover = (id: string): Promise<IncludeReport> => {
    return this.enqueue(async () => {
      if (!this.owned.has(id) || !this.graph) throw new Error('entry is not owned by Include: ' + id)
      await this.loader.resolve(id)
      return this.makeReport(false, [], [])
    })
  }
  awaitIdle = async (): Promise<void> => {
    if (this.selfWaiting()) throw new Error('Include cannot await itself during a lifecycle operation')
    while (true) { const current = this.operation; await current.catch(() => {}); if (current === this.operation) return }
  }
  close = (): Promise<void> => {
    if (this.selfWaiting()) return Promise.reject(new Error('Include cannot close itself during a lifecycle operation'))
    this.closing = true
    return this.owner.fiber.dispose()
  }

  private async apply(graph: SourceGraph, operations: readonly IncludeOperation[], saved: boolean, expectedRevision: number): Promise<IncludeReport> {
    this.graph = graph
    this.sequence++
    const failures: IncludeFailure[] = []
    const attempted: IncludeOperation[] = []
    // 每一步都从最新冻结快照重新规划；队列中的外部修改由版本检查拒绝。
    while (operations.length) {
      const operation = operations[0]
      attempted.push(operation)
      try {
        if (this.closing) throw new Error('Include is closing')
        if (operation.type === 'create') {
          // 从提交到执行之间发生的外部创建不能被收编为自己的条目。
          if (this.loader.get(operation.input.id)) throw new Error('entry appeared after preview: ' + operation.input.id)
          const entry = await this.loader.create(operation.input, operation.parentId, operation.index, { expectedRevision })
          this.owned.add(entry.id)
        } else if (operation.type === 'remove') {
          await this.loader.remove(operation.id, { expectedRevision })
        } else if (operation.type === 'move') {
          const entry = await this.loader.move(operation.id, operation.parentId, operation.index, { expectedRevision })
          if (entry.state === 'failed') throw entry.error
        } else {
          const entry = await this.loader.update(operation.id, operation.patch, { expectedRevision })
          if (entry.state === 'failed') throw entry.error
        }
        operations = this.plan(graph)
        expectedRevision = this.loader.revision
      } catch (error) {
        failures.push(Object.freeze({ operation, error }))
        break
      } finally {
        for (const id of this.owned) if (!this.loader.get(id)) this.owned.delete(id)
      }
    }
    this.watched.clear()
    for (const path of graph.sources.keys()) this.watched.add(path)
    return this.makeReport(saved, Object.freeze(attempted), failures)
  }
  private makeReport(saved: boolean, operations: readonly IncludeOperation[], failures: readonly IncludeFailure[]): IncludeReport {
    const entries = Object.freeze(this.loader.entries().filter(entry => this.owned.has(entry.id)))
    this.latest = Object.freeze({
      revision: this.sequence, saved,
      status: failures.length || entries.some(entry => entry.state === 'failed') ? 'partial' : 'applied',
      sources: this.sources(), entries, failures: Object.freeze([...failures]), operations,
    })
    return this.latest
  }
  private async shutdown(): Promise<void> {
    this.closing = true
    await this.awaitIdle()
    try {
      if (this.owned.has(this.namespace) && this.loader.get(this.namespace)) await this.loader.remove(this.namespace)
    } finally {
      this.owned.clear()
      this.labels.clear()
      this.watched.clear()
      this.graph = undefined
    }
  }
}
