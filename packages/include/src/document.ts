/** 可往返的声明数据；与 Loader 运行快照分离。 */
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Document, Node } from 'yaml'

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export interface IncludeEntry {
  readonly id: string
  readonly type?: 'component' | 'group' | 'include'
  readonly name?: string
  readonly path?: string
  readonly config?: JsonValue
  readonly disabled?: boolean
  readonly inject?: readonly string[] | Readonly<Record<string, JsonValue>>
  readonly intercept?: Readonly<Record<string, JsonValue>>
  readonly isolate?: Readonly<Record<string, string>>
  readonly baseUrl?: string
  readonly children?: readonly IncludeEntry[]
}
export interface IncludeDocument {
  readonly version: 1
  readonly entries: readonly IncludeEntry[]
}

export class DocumentError extends TypeError {
  constructor(readonly location: string, message: string) {
    super(location + ': ' + message)
    this.name = 'DocumentError'
  }
}

/** 复制并冻结输入，拒绝 JSON 会静默改变或遗漏的数据，不执行 getter/toJSON。 */
export function jsonData(input: unknown, location = '$', ancestors = new Set<object>()): JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input !== 'object' || !input) throw new DocumentError(location, 'expected JSON data')
  if (ancestors.has(input)) throw new DocumentError(location, 'cyclic data')
  const prototype = Object.getPrototypeOf(input)
  if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) {
    throw new DocumentError(location, 'expected a plain object')
  }
  ancestors.add(input)
  try {
    if (Array.isArray(input)) {
      if (Reflect.ownKeys(input).length !== input.length + 1) throw new DocumentError(location, 'sparse or extended array')
      return Object.freeze(Array.from({ length: input.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
        if (!descriptor || !('value' in descriptor)) throw new DocumentError(location + '[' + index + ']', 'expected a data element')
        return jsonData(descriptor.value, location + '[' + index + ']', ancestors)
      }))
    }
    const result: Record<string, JsonValue> = Object.create(null)
    for (const key of Reflect.ownKeys(input)) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) {
        throw new DocumentError(location, 'expected enumerable string data properties')
      }
      result[key] = jsonData(descriptor.value, location + '.' + key, ancestors)
    }
    return Object.freeze(result)
  } finally { ancestors.delete(input) }
}

function record(value: JsonValue | undefined, path: string): asserts value is Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DocumentError(path, 'expected an object')
}
function string(value: JsonValue | undefined, path: string): asserts value is string {
  if (typeof value !== 'string' || !value) throw new DocumentError(path, 'expected a non-empty string')
}
function keys(value: Record<string, JsonValue>, allowed: readonly string[], path: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new DocumentError(path + '.' + key, 'unknown field')
}

export function validateDocument(input: unknown, source = '$'): IncludeDocument {
  const data = jsonData(input, source)
  record(data, source)
  keys(data, ['version', 'entries'], source)
  if (data.version !== 1) throw new DocumentError(source + '.version', 'unsupported document version')
  const ids = new Set<string>()
  const entries = (values: JsonValue | undefined, path: string) => {
    if (!Array.isArray(values)) throw new DocumentError(path, 'expected an entry array')
    values.forEach((entry: JsonValue, index: number) => {
      const location = path + '[' + index + ']'
      record(entry, location)
      keys(entry, ['id', 'type', 'name', 'path', 'config', 'disabled', 'inject', 'intercept', 'isolate', 'baseUrl', 'children'], location)
      string(entry.id, location + '.id')
      if (ids.has(entry.id)) throw new DocumentError(location + '.id', 'duplicate id')
      ids.add(entry.id)
      const type = 'type' in entry ? entry.type : 'component'
      if (!['component', 'group', 'include'].includes(type as string)) throw new DocumentError(location + '.type', 'invalid entry type')
      if (type === 'component') string(entry.name, location + '.name')
      if (type === 'include') {
        string(entry.path, location + '.path')
        for (const key of ['name', 'config', 'children']) if (key in entry) throw new DocumentError(location + '.' + key, 'not valid for an include mount')
      } else if ('path' in entry) throw new DocumentError(location + '.path', 'only valid for an include mount')
      if ('name' in entry) string(entry.name, location + '.name')
      if ('baseUrl' in entry) string(entry.baseUrl, location + '.baseUrl')
      if ('disabled' in entry && typeof entry.disabled !== 'boolean') throw new DocumentError(location + '.disabled', 'expected a boolean')
      if ('inject' in entry) {
        if (Array.isArray(entry.inject)) entry.inject.forEach((name, i) => string(name, location + '.inject[' + i + ']'))
        else record(entry.inject, location + '.inject')
      }
      for (const key of ['intercept', 'isolate']) if (key in entry) record(entry[key], location + '.' + key)
      for (const key of ['inject', 'intercept', 'isolate']) {
        const mapping = entry[key]
        if (mapping && !Array.isArray(mapping)) for (const name of Object.keys(mapping)) string(name, location + '.' + key + ' service name')
      }
      if (entry.isolate) for (const [key, label] of Object.entries(entry.isolate)) string(label, location + '.isolate.' + key)
      if ('children' in entry) entries(entry.children, location + '.children')
    })
  }
  entries(data.entries, source + '.entries')
  return data as unknown as IncludeDocument
}

function checkYaml(node: unknown, source: string) {
  if (isAlias(node)) throw new DocumentError(source, 'YAML aliases are not supported')
  if (isMap(node)) for (const pair of node.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new DocumentError(source, 'YAML keys must be strings')
    checkYaml(pair.value, source)
  }
  if (isSeq(node)) for (const child of node.items) checkYaml(child, source)
}
export function parseConfig(text: string, filename: string): IncludeDocument {
  if (/\.ya?ml$/i.test(filename)) {
    const doc = parseDocument(text, { uniqueKeys: true, version: '1.2' })
    if (doc.errors.length || doc.warnings.length) throw new DocumentError(filename, [...doc.errors, ...doc.warnings].map(e => e.message).join('\n'))
    checkYaml(doc.contents, filename)
    return validateDocument(doc.toJS({ maxAliasCount: 0 }), filename)
  }
  if (!filename.toLowerCase().endsWith('.json')) throw new DocumentError(filename, 'expected .json, .yaml or .yml')
  try { return validateDocument(JSON.parse(text), filename) } catch (error) {
    if (error instanceof DocumentError) throw error
    throw new DocumentError(filename, error instanceof Error ? error.message : String(error))
  }
}

// 更新 YAML 节点而非重新 dump 整棵树；条目数组按 id 配对，保留未改节点注释。
function patchNode(doc: Document, node: unknown, value: JsonValue): Node {
  if (isMap(node) && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const pair of [...node.items]) if (!Object.hasOwn(value, String(isScalar(pair.key) ? pair.key.value : ''))) node.delete(pair.key)
    for (const [key, child] of Object.entries(value)) node.set(key, patchNode(doc, node.get(key, true), child))
    return node
  }
  if (isSeq(node) && Array.isArray(value)) {
    const old = [...node.items]
    node.items = value.map((child, i) => {
      const id = child && typeof child === 'object' && !Array.isArray(child) ? Reflect.get(child, 'id') : undefined
      const previous = id === undefined ? old[i] : old.find(item => isMap(item) && item.get('id') === id)
      return patchNode(doc, previous, child)
    })
    return node
  }
  if (isScalar(node) && Object.is(node.value, value)) return node
  return doc.createNode(value)
}
export function serializeConfig(document: IncludeDocument, filename: string, previous = ''): string {
  if (!/\.ya?ml$/i.test(filename)) return JSON.stringify(document, null, 2) + '\n'
  const doc: Document = parseDocument(previous)
  doc.contents = patchNode(doc, doc.contents, document as unknown as JsonValue)
  return String(doc)
}
