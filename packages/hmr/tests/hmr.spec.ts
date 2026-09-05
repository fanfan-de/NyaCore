import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@nya/core'
import { Loader } from '@nya/loader'
import { Include } from '../../include/src/index.js'
import { afterEach, expect, it } from 'vitest'
import { Hmr } from '../src/index.js'
import type { HmrOptions, HmrReport } from '../src/index.js'
import { buildGraph, emitGeneration } from '../src/modules.js'

const roots: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'nya-hmr-tests-'))
  directories.push(result)
  await writeFile(join(result, 'package.json'), '{"type":"module"}')
  return result
}
async function host(entries: string[], options: HmrOptions = {}) {
  const root = new Context()
  roots.push(root)
  await root.installComponent(Loader)
  const fiber = root.installComponent(Hmr, { entries, watch: false, ...options })
  await fiber
  expect(fiber.state).toBe(FiberState.ACTIVE)
  const report = await root.hmr.start()
  expect(report.status).toBe('applied')
  return { root, hmr: root.hmr, fiber }
}
const worker = (value: string) => `export default (ctx) => {
  ctx.logger.info("start:" + ${JSON.stringify(value)});
  return () => ctx.logger.info("stop:" + ${JSON.stringify(value)});
}`

it('uses fresh transitive code in the same process while an unrelated branch stays installed', async () => {
  const dir = await directory()
  const source = join(dir, 'worker.mjs')
  const helper = join(dir, 'helper.mjs')
  const other = join(dir, 'other.mjs')
  await writeFile(helper, 'export const value = 1')
  await writeFile(source, 'import { value } from "./helper.mjs"; export default ctx => { ctx.logger.info("value:" + value); return () => ctx.logger.info("stop:" + value) }')
  await writeFile(other, worker('other'))
  const { root, hmr } = await host([source, other])
  const a = await root.loader.create({ id: 'a', name: pathToFileURL(source).href })
  const b = await root.loader.create({ id: 'b', name: pathToFileURL(other).href })
  const pid = process.pid
  await writeFile(helper, 'export const value = 2')
  const report = await hmr.reload()
  expect(report.status).toBe('applied')
  expect(report.pid).toBe(pid)
  expect(root.loader.get('a')?.fiberId).not.toBe(a.fiberId)
  expect(root.loader.get('b')?.fiberId).toBe(b.fiberId)
  expect(root.logger.records().map(record => record.message).filter(message => /^(value|stop):/.test(message))).toEqual(['value:1', 'stop:1', 'value:2'])
  await root.loader.create({ id: 'future', name: pathToFileURL(source).href })
  expect(root.logger.records().at(-1)?.message).not.toBe('value:1')
  await root.fiber.dispose()
})

it('keeps shared module identity, native cycles and source-relative resources across a generation', async () => {
  const dir = await directory()
  await writeFile(join(dir, 'asset.txt'), 'asset')
  await writeFile(join(dir, 'shared.mjs'), 'export const token = {}; export const version = 1')
  await writeFile(join(dir, 'cycle.mjs'), 'import { read } from "./a.mjs"; export const later = () => read()')
  await writeFile(join(dir, 'a.mjs'), 'import { token, version } from "./shared.mjs"; import { later } from "./cycle.mjs"; export const read = () => version; export const resource = new URL("./asset.txt", import.meta.url); export { token, later }; export default () => {}')
  await writeFile(join(dir, 'b.mjs'), 'export { token } from "./shared.mjs"; export default () => {}')
  const a = join(dir, 'a.mjs'), b = join(dir, 'b.mjs')
  const graph = await buildGraph([a, b])
  const modules = await emitGeneration(graph, [a, b], join(dir, 'output'))
  const left = await import(modules.get(a)!)
  const right = await import(modules.get(b)!)
  expect(left.token).toBe(right.token)
  expect(left.later()).toBe(1)
  expect(await readFile(left.resource, 'utf8')).toBe('asset')
})

it('keeps JSON import attributes and literal dynamic imports in the same version graph', async () => {
  const dir = await directory(), file = join(dir, 'worker.mjs')
  await writeFile(join(dir, 'value.json'), '{"value":1}')
  await writeFile(join(dir, 'later.mjs'), 'export const value = 2')
  await writeFile(file, 'import data from "./value.json" with { type: "json" }; export const read = async () => data.value + (await import("./later.mjs")).value; export default () => {}')
  const graph = await buildGraph([file])
  const modules = await emitGeneration(graph, [file], join(dir, 'output'))
  expect(await (await import(modules.get(file)!)).read()).toBe(3)
})

it('keeps lazy cleanup modules available until Root finishes disposing its components', async () => {
  const dir = await directory(), file = join(dir, 'worker.mjs')
  await writeFile(join(dir, 'cleanup.mjs'), 'export const finish = ctx => ctx.logger.info("lazy cleanup completed")')
  await writeFile(file, 'export default ctx => () => import("./cleanup.mjs").then(module => module.finish(ctx))')
  const { root } = await host([file])
  await root.loader.create({ id: 'worker', name: pathToFileURL(file).href })
  await root.fiber.dispose()
  expect(root.logger.records().some(record => record.message === 'lazy cleanup completed')).toBe(true)
  expect(root.fiber.inspect().children).toHaveLength(0)
})

it('checks TypeScript strictly and preserves old Fibers after invalid code', async () => {
  const dir = await directory(), file = join(dir, 'worker.ts')
  await writeFile(file, 'const value: number = 1; export default () => { void value }')
  const { root, hmr } = await host([file])
  const before = await root.loader.create({ id: 'worker', name: pathToFileURL(file).href })
  await writeFile(file, 'const value: number = "wrong"; export default () => { void value }')
  const failure = await hmr.reload()
  expect(failure.status).toBe('failed')
  expect(failure.phase).toBe('typecheck')
  expect(root.loader.get('worker')?.fiberId).toBe(before.fiberId)
  await writeFile(file, 'const value: number = 2; export default () => { void value }')
  expect((await hmr.reload()).status).toBe('applied')
})

it('supports explicit rollback and requests a restart at the imported generation limit', async () => {
  const dir = await directory(), file = join(dir, 'worker.mjs')
  await writeFile(file, worker('one'))
  const { root, hmr } = await host([file], { maxGenerations: 2 })
  await root.loader.create({ id: 'worker', name: pathToFileURL(file).href })
  await writeFile(file, worker('two'))
  expect((await hmr.reload()).status).toBe('applied')
  expect((await hmr.rollback()).status).toBe('applied')
  const messages = root.logger.records().map(record => record.message).filter(message => /^(start|stop):/.test(message))
  expect(messages).toEqual(['start:one', 'stop:one', 'start:two', 'stop:two', 'start:one'])
  await writeFile(file, worker('three'))
  expect((await hmr.reload()).status).toBe('restart-required')
})

it('reports candidate import and cleanup failures without starting new resources', async () => {
  const dir = await directory(), file = join(dir, 'worker.mjs')
  await writeFile(file, 'export default () => () => { throw new Error("cleanup failed") }')
  const { root, hmr } = await host([file])
  const before = await root.loader.create({ id: 'worker', name: pathToFileURL(file).href })
  await writeFile(file, 'throw new Error("import failed"); export default () => {}')
  expect((await hmr.reload()).phase).toBe('import')
  expect(root.loader.get('worker')?.fiberId).toBe(before.fiberId)
  await writeFile(file, worker('replacement'))
  const failed = await hmr.reload()
  expect(failed.phase).toBe('cleanup')
  expect(failed.status).toBe('failed')
  expect(root.logger.records().some(record => record.message === 'start:replacement')).toBe(false)
})

it('watches real config replacement, ignores own writes and survives malformed files', async () => {
  const dir = await directory(), file = join(dir, 'config.json')
  await writeFile(file, '{"version":1,"entries":[]}')
  const root = new Context(); roots.push(root)
  await root.installComponent(Loader)
  await root.installComponent(Include, { path: file, id: 'app' })
  const reports: HmrReport[] = []
  let next: ((report: HmrReport) => void) | undefined
  await root.installComponent(Hmr, { include: root.include, debounceMs: 5, onReport: report => { reports.push(report); next?.(report) } })
  await root.hmr.start()
  const observed = (predicate: (report: HmrReport) => boolean) => new Promise<HmrReport>((resolve, reject) => {
    const timer = setTimeout(() => { next = undefined; reject(new Error('watch event timed out')) }, 4000)
    next = report => { if (predicate(report)) { clearTimeout(timer); next = undefined; resolve(report) } }
  })
  let event = observed(report => report.status === 'applied')
  await writeFile(file + '.tmp', '{"version":1,"entries":[{"id":"group","type":"group"}]}')
  await rename(file + '.tmp', file)
  await event
  expect(root.loader.get('app/group')?.state).toBe('active')
  event = observed(report => report.status === 'failed' && report.phase === 'config')
  await writeFile(file, '{broken')
  await event
  expect(root.loader.get('app/group')?.state).toBe('active')
  event = observed(report => report.status === 'applied')
  await writeFile(file, '{"version":1,"entries":[]}')
  await event
  expect(root.loader.get('app/group')).toBeUndefined()
  await root.hmr.close()
  const before = reports.length
  await writeFile(file, '{broken again')
  await root.fiber.dispose()
  expect(reports).toHaveLength(before)
})

function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

it('rejects an imported candidate when the target changes during top-level await', async () => {
  const dir = await directory(), file = join(dir, 'worker.mjs')
  await writeFile(file, worker('old'))
  const { root, hmr } = await host([file])
  const entry = await root.loader.create({ id: 'worker', name: pathToFileURL(file).href })
  const entered = gate(), release = gate()
  const key = '__nya_hmr_stale_test__'
  Reflect.set(globalThis, key, { entered: entered.open, release: release.promise })
  try {
    await writeFile(file, 'globalThis.' + key + '.entered(); await globalThis.' + key + '.release; ' + worker('new'))
    const candidate = hmr.reload()
    await entered.promise
    await root.loader.update('worker', { config: { value: 2 } })
    release.open()
    expect((await candidate).status).toBe('stale')
    expect(root.loader.get('worker')?.fiberId).toBe(entry.fiberId)
    expect(root.loader.get('worker')?.config).toEqual({ value: 2 })
    expect((await hmr.reload()).status).toBe('applied')
  } finally { release.open(); Reflect.deleteProperty(globalThis, key) }
})

it('drains an in-flight import on close without installing its candidate', async () => {
  const dir = await directory(), file = join(dir, 'worker.mjs')
  await writeFile(file, worker('old'))
  const { root, hmr } = await host([file])
  const entry = await root.loader.create({ id: 'worker', name: pathToFileURL(file).href })
  const entered = gate(), release = gate()
  const key = '__nya_hmr_close_test__'
  Reflect.set(globalThis, key, { entered: entered.open, release: release.promise })
  try {
    await writeFile(file, 'globalThis.' + key + '.entered(); await globalThis.' + key + '.release; ' + worker('new'))
    const candidate = hmr.reload()
    await entered.promise
    const closing = hmr.close()
    release.open()
    expect((await candidate).status).toBe('stale')
    await closing
    expect(root.loader.get('worker')?.fiberId).toBe(entry.fiberId)
    const later = await root.loader.create({ id: 'later', name: pathToFileURL(file).href })
    expect(later.state).toBe('active')
    expect(root.logger.records().some(record => record.message === 'start:new')).toBe(false)
  } finally { release.open(); Reflect.deleteProperty(globalThis, key) }
})

it('rejects unmanaged dynamic imports and tracks type-only TypeScript dependencies', async () => {
  const dir = await directory(), file = join(dir, 'worker.ts')
  await writeFile(join(dir, 'types.d.ts'), 'export interface Config { count: number }')
  await writeFile(file, 'import { type Config } from "./types.js"; export default (_ctx: unknown, config: Config) => { void config.count }')
  const { root, hmr } = await host([file])
  const entry = await root.loader.create({ id: 'worker', name: pathToFileURL(file).href, config: { count: 1 } })
  await writeFile(join(dir, 'types.d.ts'), 'export interface Config { value: number }')
  expect((await hmr.reload()).phase).toBe('typecheck')
  expect(root.loader.get('worker')?.fiberId).toBe(entry.fiberId)
  await writeFile(file, 'export default async () => { const path = "./helper.js"; await import(path) }')
  expect((await hmr.reload()).status).toBe('restart-required')
})

it('repairs failed Include entries with new code and only reports the final combined result', async () => {
  const dir = await directory(), file = join(dir, 'worker.mjs'), config = join(dir, 'config.json')
  await writeFile(file, 'export default () => { throw new Error("startup failed") }')
  await writeFile(config, JSON.stringify({ version: 1, entries: [{ id: 'worker', name: './worker.mjs' }] }))
  const root = new Context(); roots.push(root)
  await root.installComponent(Loader)
  await root.installComponent(Include, { path: config, id: 'app' })
  const reports: HmrReport[] = []
  await root.installComponent(Hmr, { entries: [file], include: root.include, watch: false, onReport: report => { reports.push(report) } })
  expect((await root.hmr.start()).status).toBe('failed')
  expect(reports).toHaveLength(1)
  expect(root.loader.get('app/worker')?.state).toBe('failed')
  await writeFile(file, worker('fixed'))
  expect((await root.hmr.reload()).status).toBe('applied')
  expect(reports).toHaveLength(2)
  expect(root.loader.get('app/worker')?.state).toBe('active')
})
