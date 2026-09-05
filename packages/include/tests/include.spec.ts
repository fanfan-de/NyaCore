import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context, FiberState } from '@nya/core'
import type { Component } from '@nya/core'
import { Loader } from '@nya/loader'
import { afterEach, expect, it } from 'vitest'
import { Include, ConfigConflictError, validateDocument } from '../src/index.js'
import type { IncludeDocument } from '../src/index.js'

const roots: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.allSettled(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
async function fixture(document: IncludeDocument = { version: 1, entries: [] }, definitions = new Map<string, Component<any>>()) {
  const directory = await mkdtemp(join(tmpdir(), 'nya-include-'))
  directories.push(directory)
  const path = join(directory, '配置 #%.json')
  await writeFile(path, JSON.stringify(document))
  const root = new Context()
  roots.push(root)
  await root.installComponent(Loader, { resolver: ({ name }) => {
    const component = definitions.get(name)
    if (!component) throw new Error('unknown module: ' + name)
    return component
  } })
  const fiber = root.installComponent(Include, { path, id: 'app' })
  await fiber
  expect(fiber.state).toBe(FiberState.ACTIVE)
  return { root, path, directory, include: root.include, fiber }
}

it('persists raw config, avoids unchanged restarts, clears fields and restores after shutdown', async () => {
  const starts: unknown[] = []
  let stops = 0
  const worker: Component.Function<any> = (_ctx, config) => { starts.push(config); return () => { stops++ } }
  const doc: IncludeDocument = { version: 1, entries: [{ id: 'job', name: 'worker', config: { count: 1 }, intercept: { foo: { bar: 1 } } }] }
  const definitions = new Map([['worker', worker]])
  const { root, include, path } = await fixture(doc, definitions)
  const first = await include.refresh()
  expect(first.status).toBe('applied')
  const id = include.entryId('job')
  const before = root.loader.get(id)!
  expect((await include.refresh()).operations).toEqual([])
  const next: IncludeDocument = { version: 1, entries: [{ id: 'job', name: 'worker', config: { count: 2 } }] }
  const preview = await include.preview(next)
  expect(preview).toHaveLength(1)
  expect(starts).toHaveLength(1)
  const saved = await include.save(next)
  expect(saved.saved).toBe(true)
  expect(root.loader.get(id)?.intercept).toBeUndefined()
  expect(root.loader.get(id)?.fiberId).not.toBe(before.fiberId) // clearing installation override
  const latestFiber = root.loader.get(id)?.fiberId
  await include.save({ version: 1, entries: [{ id: 'job', name: 'worker', config: null }] })
  expect(root.loader.get(id)?.fiberId).toBe(latestFiber)
  expect(starts.at(-1)).toBe(null)
  const file = JSON.parse(await readFile(path, 'utf8'))
  expect(file.entries[0]).not.toHaveProperty('fiberId')
  await include.close()
  expect(root.loader.entries()).toEqual([])
  expect(stops).toBe(3)
  const restoredFiber = root.installComponent(Include, { path, id: 'restored' })
  await restoredFiber
  await root.include.refresh()
  expect(root.loader.get('restored/job')?.config).toBe(null)
  await root.fiber.dispose()
  expect(stops).toBe(4)
})

it('rejects invalid data and external changes before altering the running tree', async () => {
  const { root, include, path } = await fixture({ version: 1, entries: [{ id: 'worker', name: 'worker' }] }, new Map([['worker', () => undefined]]))
  await include.refresh()
  const id = root.loader.get('app/worker')?.fiberId
  await writeFile(path, '{ broken')
  await expect(include.refresh()).rejects.toThrow()
  expect(root.loader.get('app/worker')?.fiberId).toBe(id)
  await expect(include.save({ version: 1, entries: [] })).rejects.toBeInstanceOf(ConfigConflictError)
  expect(await readFile(path, 'utf8')).toBe('{ broken')
  expect(() => validateDocument({ version: 2, entries: [] })).toThrow('version')
  expect(() => validateDocument({ version: 1, entries: [{ id: 'x', name: 'x', config: { a: undefined } }] })).toThrow('.config.a')
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  expect(() => validateDocument({ version: 1, entries: [{ id: 'x', name: 'x', config: cyclic }] })).toThrow('cyclic')
  expect(() => validateDocument({ version: 1, entries: [{ id: 'x', name: 'x' }, { id: 'x', name: 'x' }] })).toThrow('duplicate')
})

it('migrates surviving descendants before deleting ancestors and preserves undeclared siblings', async () => {
  const { root, include } = await fixture({
    version: 1, entries: [{ id: 'group', type: 'group', children: [{ id: 'keep', name: 'worker' }] }],
  }, new Map([['worker', () => undefined]]))
  await include.refresh()
  await root.loader.create({ id: 'outside', type: 'group' })
  await root.loader.create({ id: 'dynamic', type: 'group' }, 'app/group')
  const next: IncludeDocument = { version: 1, entries: [{ id: 'keep', name: 'worker' }] }
  const preview = await include.preview(next)
  const removal = preview.find(step => step.type === 'remove')
  expect(removal?.type === 'remove' && removal.cascade).toEqual(['app/group', 'dynamic'])
  await include.save(next)
  expect(root.loader.get('app/keep')?.parentId).toBe('app')
  expect(root.loader.get('dynamic')).toBeUndefined()
  expect(root.loader.get('outside')?.state).toBe('active')
  await root.fiber.dispose()
})

it('reads YAML include mounts, writes to the owning source and keeps YAML comments', async () => {
  const { directory, path, root, include } = await fixture()
  const yaml = join(directory, 'tasks.yml')
  await writeFile(yaml, '# tasks\nversion: 1\nentries:\n  - id: worker # identity\n    name: missing\n    disabled: true\n')
  await writeFile(path, JSON.stringify({ version: 1, entries: [{ id: 'tasks', type: 'include', path: './tasks.yml' }] }))
  const report = await include.refresh()
  expect(report.sources).toHaveLength(2)
  expect(include.source(include.entryId('worker', ['tasks']))?.filename).toBe(yaml)
  expect(root.loader.get(include.entryId('worker', ['tasks']))?.state).toBe('disabled')
  await include.save({ version: 1, entries: [{ id: 'worker', name: 'missing', disabled: true, config: 3 }] }, yaml)
  const updated = await readFile(yaml, 'utf8')
  expect(updated).toContain('# tasks')
  expect(updated).toContain('# identity')
  expect(JSON.parse(await readFile(path, 'utf8')).entries[0].path).toBe('./tasks.yml')
  await writeFile(yaml, 'version: 1\nentries:\n  - id: cycle\n    type: include\n    path: "./' + '配置 #%.json' + '"\n')
  await expect(include.refresh()).rejects.toThrow('cycle')
  expect(root.loader.get('app/tasks/worker')?.state).toBe('disabled')
})

it('rejects ownership conflicts before saving, and separates successful save from failed startup', async () => {
  const { include, root, path } = await fixture()
  await root.loader.create({ id: 'app/conflict', type: 'group' })
  await include.refresh()
  const content = await readFile(path, 'utf8')
  await expect(include.save({ version: 1, entries: [{ id: 'conflict', type: 'group' }] })).rejects.toThrow('not owned')
  expect(await readFile(path, 'utf8')).toBe(content)
  const report = await include.save({ version: 1, entries: [{ id: 'bad', name: 'missing' }] })
  expect(report.saved).toBe(true)
  expect(report.status).toBe('partial')
  expect(root.loader.get('app/bad')?.state).toBe('failed')
})

it('retains cleanup failures after target save and reports removal even when cleanup rejects', async () => {
  const failure = new Error('cannot release')
  const worker = () => () => { throw failure }
  const { include, root } = await fixture({ version: 1, entries: [{ id: 'worker', name: 'worker' }] }, new Map([['worker', worker]]))
  await include.refresh()
  const saved = await include.save({ version: 1, entries: [{ id: 'worker', name: 'worker', disabled: true }] })
  expect(saved.saved).toBe(true)
  expect(saved.failures[0]?.error).toBe(failure)
  expect(root.loader.get('app/worker')?.state).toBe('failed')
  const removed = await include.save({ version: 1, entries: [] })
  expect(removed.status).toBe('partial')
  expect(root.loader.get('app/worker')).toBeUndefined()
})

it('rejects lifecycle self-waits and shuts down without keeping the Loader alive', async () => {
  let nested: Promise<unknown> | undefined
  let include: Include
  const worker = async () => {
    nested = include.refresh()
    await expect(nested).rejects.toThrow('itself')
  }
  const fixtureValue = await fixture({ version: 1, entries: [{ id: 'worker', name: 'worker' }] }, new Map([['worker', worker]]))
  include = fixtureValue.include
  await include.refresh()
  expect(nested).toBeDefined()
  await fixtureValue.root.fiber.dispose()
  expect(fixtureValue.fiber.state).toBe(FiberState.DISPOSED)
})

it('rejects ambiguous YAML and duplicate sources while retaining stable isolation labels', async () => {
  const { include, root, path, directory } = await fixture({ version: 1, entries: [
    { id: 'a', type: 'group', isolate: { clock: 'private' } },
    { id: 'b', type: 'group', isolate: { clock: 'private' } },
  ] })
  await include.refresh()
  const first = root.loader.get('app/a')!
  expect(first.isolate?.clock).toBe(root.loader.get('app/b')?.isolate?.clock)
  expect((await include.refresh()).operations).toEqual([])
  const yaml = join(directory, 'bad.yml')
  await writeFile(path, JSON.stringify({ version: 1, entries: [
    { id: 'one', type: 'include', path: './bad.yml' },
    { id: 'two', type: 'include', path: './bad.yml' },
  ] }))
  await writeFile(yaml, 'version: 1\nentries: []\n')
  await expect(include.refresh()).rejects.toThrow('more than once')
  await writeFile(yaml, 'version: 1\nentries: &items []\nextra: *items\n')
  await expect(include.refresh()).rejects.toThrow('aliases')
  expect(root.loader.get('app/a')?.fiberId).toBe(first.fiberId)
  const invalid = [
    { version: 1, entries: [{ id: 'x', type: null }] },
    { version: 1, entries: [{ id: 'x', type: 'group', isolate: { '': 'label' } }] },
    { version: 1, entries: [{ id: 'x', name: 'x', config: [1, , 3] }] },
  ]
  for (const document of invalid) expect(() => validateDocument(document)).toThrow()
})
