/** 可选监听与同进程 ESM 替换；进程退出由宿主决定。 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Service } from '@nya/core'
import type { Component, Context } from '@nya/core'
import type { DefinitionReplacement, EntrySnapshot, Loader, LoaderResolver, ReplacementReport } from '@nya/loader'
import { affectedEntries, buildGraph, componentExport, configuredFile, emitGeneration, graphIsFresh, ModuleBuildError, requestFile } from './modules.js'
import type { ModuleGraph } from './modules.js'

export interface ConfigurationController {
  refresh(): Promise<unknown>
  watchPaths(): readonly string[]
}
export interface HmrOptions {
  /** 本地组件文件；可只传 include 来启用配置监听。 */
  readonly entries?: readonly string[]
  readonly baseUrl?: string
  readonly include?: ConfigurationController
  readonly watch?: boolean
  readonly root?: string
  readonly tsconfig?: string
  readonly debounceMs?: number
  readonly maxGenerations?: number
  readonly onReport?: (report: HmrReport) => void
}
export interface HmrReport {
  readonly status: 'applied' | 'unchanged' | 'failed' | 'stale' | 'restart-required'
  readonly phase: 'config' | 'build' | 'typecheck' | 'import' | 'cleanup' | 'replace' | 'watch'
  readonly pid: number
  readonly generation: number
  readonly revision: number
  readonly files: readonly string[]
  readonly entries: readonly EntrySnapshot[]
  readonly errors: readonly unknown[]
  readonly configuration?: unknown
}
declare module '@nya/core' { interface Context { hmr: Hmr } }
interface Budget {
  count: number
  directory?: Promise<string>
  cleanup?: Promise<void>
  controllers: Set<Hmr>
}
const budgets = new WeakMap<Context, Budget>()
const execution = new AsyncLocalStorage<{ token: object; active: boolean }>()
interface Version { graph: ModuleGraph; definitions: Map<string, Component<any>> }

export class Hmr extends Service {
  static readonly provide = 'hmr'
  static readonly inject = ['loader']
  private readonly owner: Context
  private readonly loader: Loader
  private readonly fallback: LoaderResolver
  private readonly options: HmrOptions
  private readonly files: readonly string[]
  private readonly budget: Budget
  private readonly token = {}
  private readonly cancellation = new AbortController()
  private operation: Promise<unknown> = Promise.resolve()
  private readonly watchers = new Map<string, FSWatcher>()
  private timer?: ReturnType<typeof setTimeout>
  private closing = false
  private started = false
  private current?: Version
  private previous?: Version
  private attempt?: string
  private attemptReport?: HmrReport
  private restartReason?: Error
  private latest?: HmrReport
  private configuration?: unknown

  constructor(context: Context, options: HmrOptions = {}) {
    super(context)
    this.owner = context
    this.loader = context.loader
    this.fallback = this.loader.resolver
    if (options.entries !== undefined && (!Array.isArray(options.entries) || options.entries.some(entry => typeof entry !== 'string' || !entry))) throw new TypeError('invalid HMR entries')
    if (options.include && (typeof options.include.refresh !== 'function' || typeof options.include.watchPaths !== 'function')) throw new TypeError('invalid configuration controller')
    for (const [name, value, minimum] of [['debounceMs', options.debounceMs, 0], ['maxGenerations', options.maxGenerations, 1]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647)) throw new TypeError('invalid ' + name)
    }
    this.options = Object.freeze({ ...options, tsconfig: options.tsconfig && resolve(options.tsconfig) })
    this.files = Object.freeze((options.entries ?? []).map(file => configuredFile(file, options.baseUrl)))
    let budget = budgets.get(context.root)
    if (!budget) {
      budget = { count: 0, controllers: new Set() }
      budgets.set(context.root, budget)
      const owned = budget
      // 活跃版本可能在 HMR 卸载后继续供 Loader 使用，租约归 Root 生命周期。
      context.root.effect(() => () => {
        for (const controller of owned.controllers) controller.beginClose()
        budgets.delete(context.root)
        // Root 的 Effect 按 LIFO 清理，此回调可能先于 Loader 子树。
        // 不能反向等待 Root；磁盘回收在其稳定后继续，确保 cleanup 的动态导入仍可用。
        owned.cleanup = context.root.fiber.awaitStable().catch(() => {}).then(async () => {
          if (owned.directory) await rm(await owned.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
        })
        void owned.cleanup.catch(error => context.root.logger.error('HMR artifact cleanup failed', error))
      }, 'hmr version artifacts')
    }
    this.budget = budget
    budget.controllers.add(this)
    context.effect(() => () => this.shutdown(), 'hmr watcher and build queue')
  }
  report(): HmrReport | undefined { return this.latest }
  /** 在安装稳定后由宿主调用；先准备代码 Resolver，再首次读取配置。 */
  start = (): Promise<HmrReport> => {
    return this.enqueue(async () => {
      this.started = true
      try {
        const code = await this.updateCode(false)
        if (code.status === 'failed' || code.status === 'restart-required' || code.status === 'stale') return code
        await this.refreshConfiguration()
        return this.finishConfiguration(code)
      } catch (error) { return this.failure('config', error) }
      finally { await this.syncWatchers() }
    })
  }
  /** 显式重试同一候选；文件重复事件不会不断重试失败代码。 */
  reload = (): Promise<HmrReport> => this.enqueue(() => this.refresh(true))
  awaitIdle = async (): Promise<void> => {
    if (this.selfWaiting()) throw new Error('HMR cannot await itself during a lifecycle operation')
    if (this.timer !== undefined) {
      clearTimeout(this.timer); this.timer = undefined
      await this.enqueue(() => this.refresh(false))
    }
    while (true) { const task = this.operation; await task.catch(() => {}); if (task === this.operation) return }
  }
  rollback = (): Promise<HmrReport> => {
    return this.enqueue(async () => {
      if (!this.previous) throw new Error('no previous HMR version')
      const version = this.previous
      const result = await this.replace(version.definitions)
      if (result.committed) { this.previous = this.current; this.current = version }
      return this.replacementReport(result, [...version.definitions.keys()])
    })
  }
  close = (): Promise<void> => {
    if (this.selfWaiting()) return Promise.reject(new Error('HMR cannot close itself during a lifecycle operation'))
    this.beginClose()
    return this.owner.fiber.dispose()
  }
  private enqueue(action: () => Promise<HmrReport>): Promise<HmrReport> {
    if (this.closing) return Promise.reject(new Error('HMR is closing'))
    if (this.selfWaiting()) return Promise.reject(new Error('HMR cannot await itself during a lifecycle operation'))
    const task = this.operation.catch(() => {}).then(async () => {
      if (this.closing) throw new Error('HMR is closing')
      const frame = { token: this.token, active: true }
      let report: HmrReport
      try { report = await execution.run(frame, action) } finally { frame.active = false }
      return this.publish(report)
    })
    this.operation = task
    return task
  }
  private selfWaiting(): boolean {
    const frame = execution.getStore()
    return frame?.token === this.token && frame.active
  }
  private async refresh(force: boolean): Promise<HmrReport> {
    this.started = true
    try {
      await this.refreshConfiguration()
    } catch (error) { await this.syncWatchers(); return this.failure('config', error) }
    try {
      const code = await this.updateCode(force)
      // 已接受的声明可能因为旧代码启动失败；允许新代码先修复，再读取实际运行。
      if ((code.status === 'applied' || code.status === 'unchanged') && this.configurationIsPartial()) await this.refreshConfiguration()
      return this.finishConfiguration(code)
    }
    finally { await this.syncWatchers() }
  }
  private async refreshConfiguration(): Promise<void> {
    if (!this.options.include) return
    this.configuration = await this.options.include.refresh()
  }
  private configurationIsPartial(): boolean {
    return !!this.configuration && typeof this.configuration === 'object' && Reflect.get(this.configuration, 'status') === 'partial'
  }
  private finishConfiguration(code: HmrReport): HmrReport {
    if ((code.status === 'applied' || code.status === 'unchanged') && this.configurationIsPartial()) {
      return this.failure('config', new Error('configuration applied partially', { cause: this.configuration }))
    }
    return this.publish({ ...code, configuration: this.configuration })
  }
  private publish(report: HmrReport): HmrReport {
    const frozen = Object.freeze({ ...report, files: Object.freeze([...report.files]), entries: Object.freeze([...report.entries]), errors: Object.freeze([...report.errors]) })
    // 一次控制器操作只通知最终组合结果，避免构建准备成功被当成配置已运行。
    if (this.selfWaiting()) return frozen
    this.latest = frozen
    if (!this.closing) {
      try { void Promise.resolve(this.options.onReport?.(this.latest)).catch(error => this.owner.logger.error('HMR observer failed', error)) }
      catch (error) { this.owner.logger.error('HMR observer failed', error) }
    }
    return this.latest
  }
  private base(): HmrReport {
    return { status: 'applied', phase: 'replace', pid: process.pid, generation: this.budget.count, revision: this.loader.revision, files: [], entries: [], errors: [], configuration: this.configuration }
  }
  private failure(phase: HmrReport['phase'], error: unknown): HmrReport {
    return this.publish({ ...this.base(), phase, status: 'failed', errors: [error] })
  }
  private replacementReport(result: ReplacementReport, files: string[]): HmrReport {
    return this.publish({ ...this.base(), status: result.status, phase: result.status === 'failed' && !result.committed ? 'cleanup' : 'replace', files, entries: result.entries, errors: result.errors })
  }
  private async replace(definitions: ReadonlyMap<string, Component<any>>, expectedRevision = this.loader.revision): Promise<ReplacementReport> {
    const replacements: DefinitionReplacement[] = []
    for (const entry of this.loader.entries()) {
      const request = this.loader.request(entry.id)
      if (!request) continue
      const filename = await requestFile(request)
      if (filename && definitions.has(filename)) replacements.push({ id: entry.id, definition: definitions.get(filename)! })
    }
    const stable = new Map(definitions)
    const fallback = this.fallback
    return this.loader.replace(replacements, { expectedRevision, signal: this.cancellation.signal, resolver: async request => {
      const filename = await requestFile(request)
      return filename && stable.has(filename) ? stable.get(filename)! : fallback(request)
    } })
  }
  private async updateCode(force: boolean): Promise<HmrReport> {
    if (this.restartReason) return this.publish({ ...this.base(), status: 'restart-required', phase: 'watch', errors: [this.restartReason] })
    if (!this.files.length) return this.publish({ ...this.base(), phase: 'config' })
    const revision = this.loader.revision
    let graph: ModuleGraph
    try { graph = await buildGraph(this.files, this.options.tsconfig) }
    catch (error) {
      if (error instanceof ModuleBuildError && error.phase === 'unsupported') return this.publish({ ...this.base(), phase: 'build', status: 'restart-required', errors: [error] })
      return this.failure(error instanceof ModuleBuildError ? error.phase as 'build' | 'typecheck' : 'build', error)
    }
    if (!force && graph.fingerprint === this.attempt && this.attemptReport?.status === 'failed'
      && (graph.fingerprint !== this.current?.graph.fingerprint || this.attemptReport.entries.some(entry => this.loader.get(entry.id)?.state === 'failed'))) {
      return this.publish({ ...this.attemptReport, ...this.base(), status: 'failed', phase: this.attemptReport.phase, errors: this.attemptReport.errors, files: this.attemptReport.files, entries: this.attemptReport.entries })
    }
    if (!force && graph.fingerprint === this.current?.graph.fingerprint) {
      return this.publish({ ...this.base(), status: 'unchanged' })
    }
    const affected = affectedEntries(force && graph.fingerprint === this.current?.graph.fingerprint ? undefined : this.current?.graph, graph)
    if (!affected.length) return this.publish({ ...this.base(), status: 'unchanged' })
    if (this.budget.count >= (this.options.maxGenerations ?? 100)) return this.publish({
      ...this.base(), status: 'restart-required', phase: 'build', errors: [new Error('HMR generation limit reached; restart the host to release ESM caches')],
    })
    try {
      this.budget.directory ??= mkdtemp(join(tmpdir(), 'nya-hmr-'))
      const directory = join(await this.budget.directory, String(this.budget.count + 1) + '-' + graph.fingerprint.slice(0, 12))
      const modules = await emitGeneration(graph, affected, directory)
      if (this.closing || !await graphIsFresh(graph)) return this.publish({ ...this.base(), status: 'stale', phase: 'build' })
      this.attempt = graph.fingerprint
      this.budget.count++
      const definitions = new Map(this.current?.definitions)
      for (const [file, url] of modules) definitions.set(file, componentExport(await import(url)))
      if (this.closing || !await graphIsFresh(graph)) {
        this.attempt = undefined
        return this.publish({ ...this.base(), status: 'stale', phase: 'import' })
      }
      // 只有本次受影响的入口需要重装；未受影响定义仍供未来解析使用。
      const changes = new Map([...definitions].filter(([file]) => affected.includes(file)))
      const replacements: DefinitionReplacement[] = []
      for (const entry of this.loader.entries()) {
        const request = this.loader.request(entry.id)
        const file = request && await requestFile(request)
        if (file && changes.has(file)) replacements.push({ id: entry.id, definition: changes.get(file)! })
      }
      const stable = new Map(definitions)
      const fallback = this.fallback
      const result = await this.loader.replace(replacements, { expectedRevision: revision, signal: this.cancellation.signal, resolver: async request => {
        const file = await requestFile(request)
        return file && stable.has(file) ? stable.get(file)! : fallback(request)
      } })
      if (result.committed) { this.previous = this.current; this.current = { graph, definitions } }
      // 过期目标需要重新规划；同一源码并非永久失败候选。
      if (result.status === 'stale') this.attempt = undefined
      this.attemptReport = this.replacementReport(result, affected)
      return this.attemptReport
    } catch (error) {
      this.attemptReport = this.failure(error instanceof ModuleBuildError ? 'build' : 'import', error)
      return this.attemptReport
    }
  }
  private changed(filename?: string) {
    if (this.closing) return
    const configFiles = this.configurationPaths()
    if (filename && !configFiles.includes(filename)) {
      if (['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(basename(filename)) || filename === this.options.tsconfig) {
        this.restartReason = new Error('host dependency or build configuration changed: ' + filename)
        this.publish({ ...this.base(), phase: 'watch', status: 'restart-required', errors: [this.restartReason] })
        return
      }
      if (!this.current?.graph.inputs.has(filename) && filename.split(/[\\/]/).some(part => ['node_modules', '.git', 'dist', 'lib', 'data', '.nya'].includes(part))) return
    }
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.enqueue(() => this.refresh(false)).catch(error => { if (!this.closing) this.failure('watch', error) })
    }, this.options.debounceMs ?? 75)
  }
  private async syncWatchers() {
    if (this.closing || !this.started || this.options.watch === false) return
    const directories = new Set<string>()
    const desired = this.files.map(file => dirname(file))
    // 来源图和失败来源各自贡献目录，补齐文件后能够继续刷新。
    for (const file of this.configurationPaths()) desired.push(dirname(file))
    for (const file of this.current?.graph.inputs.keys() ?? []) desired.push(dirname(file))
    if (this.options.root) desired.push(resolve(this.options.root))
    if (this.options.tsconfig) desired.push(dirname(this.options.tsconfig))
    for (let directory of desired) {
      while (true) {
        try { if ((await stat(directory)).isDirectory()) break } catch {}
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
      }
      directories.add(directory)
    }
    for (const directory of directories) if (!this.watchers.has(directory)) {
      if (this.closing) return
      try {
        const watcher = watch(directory, { recursive: true }, (_event, file) => this.changed(file ? resolve(directory, String(file)) : undefined))
        watcher.on('error', error => { if (!this.closing) this.failure('watch', error) })
        this.watchers.set(directory, watcher)
      } catch (error) { this.failure('watch', error) }
    }
    for (const [directory, watcher] of this.watchers) if (!directories.has(directory)) { watcher.close(); this.watchers.delete(directory) }
  }
  private configurationPaths(): readonly string[] {
    try { return this.options.include?.watchPaths() ?? [] }
    catch (error) { if (!this.closing) this.failure('config', error); return [] }
  }
  private beginClose() {
    this.closing = true
    this.cancellation.abort()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
  private async shutdown() {
    this.beginClose()
    try { await this.awaitIdle() }
    finally { this.budget.controllers.delete(this) }
  }
}
