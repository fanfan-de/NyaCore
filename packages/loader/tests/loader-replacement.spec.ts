import { Context } from '@nya/core'
import { afterEach, expect, it } from 'vitest'
import { Loader } from '../src/index.js'
const roots: Context[] = []
afterEach(async () => { await Promise.allSettled(roots.splice(0).map(root => root.fiber.dispose())) })
async function fixture(component: () => unknown) {
  const root = new Context()
  roots.push(root)
  await root.installComponent(Loader, { resolver: () => component as () => void })
  return root
}
it('replaces a complete set before new startup, retains IDs and commits the future resolver', async () => {
  const events: string[] = []
  const previous = () => { events.push('old-start'); return () => { events.push('old-stop') } }
  const next = () => { events.push('new-start') }
  const root = await fixture(previous)
  const first = await root.loader.create({ id: 'a', name: 'worker' })
  await root.loader.create({ id: 'b', name: 'worker' })
  await root.loader.create({ id: 'disabled', name: 'worker', disabled: true })
  const report = await root.loader.replace(['a', 'b', 'disabled'].map(id => ({ id, definition: next })), {
    expectedRevision: root.loader.revision, resolver: () => next,
  })
  expect(report.status).toBe('applied')
  expect(report.committed).toBe(true)
  expect(events).toEqual(['old-start', 'old-start', 'old-stop', 'old-stop', 'new-start', 'new-start'])
  expect(root.loader.get('a')?.fiberId).not.toBe(first.fiberId)
  expect(root.loader.get('disabled')?.state).toBe('disabled')
  await root.loader.create({ id: 'future', name: 'worker' })
  await root.loader.update('disabled', { disabled: false })
  expect(events.slice(-2)).toEqual(['new-start', 'new-start'])
})
it('rejects stale plans without stopping the existing component', async () => {
  let stops = 0
  const root = await fixture(() => () => { stops++ })
  await root.loader.create({ id: 'a', name: 'worker' })
  const revision = root.loader.revision
  await root.loader.update('a', { config: 1 })
  const before = stops
  const result = await root.loader.replace([{ id: 'a', definition: () => undefined }], { expectedRevision: revision })
  expect(result.status).toBe('stale')
  expect(result.committed).toBe(false)
  expect(stops).toBe(before)
})
it('does not clear a failed cleanup or start the candidate', async () => {
  const error = new Error('cleanup')
  const root = await fixture(() => () => { throw error })
  await root.loader.create({ id: 'a', name: 'worker' })
  let starts = 0
  const replacement = [{ id: 'a', definition: () => { starts++ } }]
  const result = await root.loader.replace(replacement, { expectedRevision: root.loader.revision })
  expect(result.status).toBe('failed')
  expect(result.committed).toBe(false)
  expect(result.errors[0]).toBe(error)
  await root.loader.replace(replacement, { expectedRevision: root.loader.revision })
  expect(starts).toBe(0)
})
it('coalesces ancestor replacements and does not restart an unrelated branch', async () => {
  let stops = 0
  const root = await fixture(() => () => { stops++ })
  await root.loader.create({ id: 'parent', name: 'worker' })
  await root.loader.create({ id: 'child', name: 'worker' }, 'parent')
  const other = await root.loader.create({ id: 'other', name: 'worker' })
  const result = await root.loader.replace(['parent', 'child'].map(id => ({ id, definition: () => undefined })), { expectedRevision: root.loader.revision })
  expect(result.status).toBe('applied')
  expect(stops).toBe(2)
  expect(root.loader.get('child')?.state).toBe('active')
  expect(root.loader.get('other')?.fiberId).toBe(other.fiberId)
})

it('checks declaration revisions inside the queue and leaves stale mutations unapplied', async () => {
  const root = await fixture(() => undefined)
  await root.loader.create({ id: 'a', name: 'worker' })
  const expectedRevision = root.loader.revision
  const newer = root.loader.update('a', { config: 2 })
  const stale = root.loader.remove('a', { expectedRevision })
  await expect(stale).rejects.toThrow('stale Loader revision')
  await newer
  expect(root.loader.get('a')?.config).toBe(2)
  await expect(root.loader.create({ id: 'b', type: 'group' }, null, undefined, { expectedRevision })).rejects.toThrow('stale')
  await expect(root.loader.move('a', null, 0, { expectedRevision })).rejects.toThrow('stale')
  await expect(root.loader.update('a', { disabled: true }, { expectedRevision })).rejects.toThrow('stale')
  expect(root.loader.get('a')?.state).toBe('active')
})

it('reports failed descendants even when their parent replacement starts successfully', async () => {
  let broken = false
  const root = new Context(); roots.push(root)
  await root.installComponent(Loader, { resolver: ({ name }) => name === 'child'
    ? () => { if (broken) throw new Error('child startup failed') }
    : () => undefined })
  await root.loader.create({ id: 'parent', name: 'parent' })
  await root.loader.create({ id: 'child', name: 'child' }, 'parent')
  broken = true
  const result = await root.loader.replace([{ id: 'parent', definition: () => undefined }], { expectedRevision: root.loader.revision })
  expect(result.committed).toBe(true)
  expect(result.status).toBe('failed')
  expect(result.entries.find(entry => entry.id === 'child')?.state).toBe('failed')
})
