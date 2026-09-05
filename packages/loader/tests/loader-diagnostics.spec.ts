/** Loader 只投影 Core 依赖诊断，不另行执行检查或把父级阻塞冒充缺服务。 */

import { Context, Service } from '@nya/core'
import type { Component } from '@nya/core'
import { afterEach, expect, it, vi } from 'vitest'
import { Loader } from '../src/index.js'

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
})

it('exposes missing services and check failures through both get and entries without rerunning checks', async () => {
  const app = new Context()
  roots.push(app)
  let ready = false
  const check = vi.fn(() => ready)
  class Database extends Service {
    static provide = 'diagnosticDatabase';
    [Service.check]() { return check() }
  }
  const Consumer: Component.Object<void> = {
    inject: ['diagnosticDatabase'],
    apply() {},
  }
  await app.installComponent(Loader, { resolver: ({ name }) => name === 'database' ? Database : Consumer })
  const pending = await app.loader.create({ id: 'consumer', name: 'consumer' })
  expect(pending.dependencies).toMatchObject([
    { serviceName: 'diagnosticDatabase', status: 'blocked', reason: 'missing', providers: [] },
  ])
  await app.loader.create({ id: 'database', name: 'database' })
  await app.loader.awaitIdle()
  const count = check.mock.calls.length
  const blocked = app.loader.get('consumer')!
  expect(blocked).toMatchObject({ state: 'pending', dependencies: [
    { serviceName: 'diagnosticDatabase', status: 'blocked', reason: 'check-false', providers: [{ state: 'ACTIVE' }] },
  ] })
  expect(app.loader.entries().find(entry => entry.id === 'consumer')!.dependencies).toEqual(blocked.dependencies)
  expect(check).toHaveBeenCalledTimes(count)
  expect(Object.isFrozen(blocked.dependencies)).toBe(true)
  expect(Object.isFrozen(blocked.dependencies[0])).toBe(true)
  ready = true
  await app.registry.get(Database)!.fibers[0].restart()
  await app.loader.awaitIdle()
  expect(app.loader.get('consumer')).toMatchObject({ state: 'active', dependencies: [{ status: 'ready' }] })
  expect(blocked.dependencies[0].reason).toBe('check-false')
  await app.loader.update('consumer', { disabled: true })
  expect(app.loader.get('consumer')).toMatchObject({ state: 'disabled', dependencies: [] })
})

it('keeps parent entry blocking separate when a child has not been installed', async () => {
  const app = new Context()
  roots.push(app)
  await app.installComponent(Loader, { resolver: () => () => {} })
  await app.loader.create({ id: 'group', type: 'group', inject: ['missingParentService'] })
  const child = await app.loader.create({ id: 'child', name: 'child', inject: ['childService'] }, 'group')
  expect(child).toMatchObject({ state: 'pending', blockedBy: 'group', dependencies: [] })
  expect(app.loader.get('group')!.dependencies).toMatchObject([{ serviceName: 'missingParentService', reason: 'missing' }])
})
