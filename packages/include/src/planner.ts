/** 只基于声明和冻结快照模拟树操作，不导入模块或执行用户代码。 */
import type { EntryInput, EntrySnapshot, EntryUpdate } from '@nya/loader'
import type { TargetEntry } from './source.js'

export type IncludeOperation =
  | { readonly type: 'create'; readonly input: EntryInput; readonly parentId: string | null; readonly index?: number }
  | { readonly type: 'update'; readonly id: string; readonly patch: EntryUpdate }
  | { readonly type: 'move'; readonly id: string; readonly parentId: string | null; readonly index: number }
  | { readonly type: 'remove'; readonly id: string; readonly cascade: readonly string[] }

const fields = ['type', 'name', 'config', 'disabled', 'inject', 'intercept', 'isolate', 'baseUrl'] as const
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && equal(Reflect.get(left, key), Reflect.get(right, key)))
}
export function planEntries(
  targets: readonly TargetEntry[], snapshots: readonly EntrySnapshot[],
  owned: ReadonlySet<string>, namespace: string,
): readonly IncludeOperation[] {
  const existing = new Map(snapshots.map(entry => [entry.id, entry]))
  for (const { input } of targets) {
    if (existing.has(input.id) && !owned.has(input.id)) throw new Error('entry is not owned by this Include: ' + input.id)
  }
  const parents = new Map(snapshots.map(entry => [entry.id, entry.parentId]))
  const children = new Map<string | null, string[]>([[null, snapshots.filter(entry => entry.parentId === null).map(entry => entry.id)]])
  for (const entry of snapshots) children.set(entry.id, [...entry.children])
  const desired = new Set(targets.map(target => target.input.id))
  const result: IncludeOperation[] = []
  const reposition = (id: string, parent: string | null, index: number) => {
    for (let ancestor = parent; ancestor !== null; ancestor = parents.get(ancestor) ?? null) {
      if (ancestor === id) throw new Error('cannot plan cyclic move: ' + id)
    }
    const previous = parents.get(id) ?? null
    const before = children.get(previous)!
    before.splice(before.indexOf(id), 1)
    children.get(parent)!.splice(index, 0, id)
    parents.set(id, parent)
  }
  for (const target of targets) {
    const { input, parentId } = target
    if (parentId !== null && !parents.has(parentId)) throw new Error('missing planned parent: ' + parentId)
    const siblings = children.get(parentId)!
    if (!parents.has(input.id)) {
      const index = input.id === namespace ? siblings.length : Math.min(target.index, siblings.length)
      result.push(Object.freeze({ type: 'create', input: Object.freeze(input), parentId, index }))
      parents.set(input.id, parentId)
      siblings.splice(index, 0, input.id)
      children.set(input.id, [])
    } else if (input.id !== namespace && (parents.get(input.id) !== parentId || siblings.indexOf(input.id) !== target.index)) {
      const index = Math.min(target.index, siblings.length - (parents.get(input.id) === parentId ? 1 : 0))
      result.push(Object.freeze({ type: 'move', id: input.id, parentId, index }))
      reposition(input.id, parentId, index)
    }
  }
  // 先迁出保留条目，再改变安装覆盖或删除旧祖先。
  for (const { input } of targets) {
    const current = existing.get(input.id)
    if (!current) continue
    const patch: Record<string, unknown> = {}
    for (const field of fields) {
      const value = field === 'disabled' ? input.disabled ?? false : input[field]
      if (!equal(current[field], value)) patch[field] = value
    }
    if (Object.keys(patch).length) result.push(Object.freeze({ type: 'update', id: input.id, patch: Object.freeze(patch) }))
  }
  const collect = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(collect)]
  for (const id of owned) {
    if (!parents.has(id) || desired.has(id)) continue
    let covered = false
    for (let parent = parents.get(id); parent != null; parent = parents.get(parent)) {
      if (owned.has(parent) && !desired.has(parent)) { covered = true; break }
    }
    if (!covered) result.push(Object.freeze({ type: 'remove', id, cascade: Object.freeze(collect(id)) }))
  }
  return Object.freeze(result)
}
