/** 来源图和磁盘提交；纯预检不导入任何组件模块。 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { EntryInput } from '@nya/loader'
import { DocumentError, parseConfig, serializeConfig } from './document.js'
import type { IncludeDocument, IncludeEntry } from './document.js'

export interface ConfigSource {
  readonly filename: string
  readonly digest: string
  readonly document: IncludeDocument
}
export interface SourceRecord extends ConfigSource { readonly text: string }
export interface TargetEntry {
  readonly input: EntryInput
  readonly parentId: string | null
  readonly index: number
  readonly source: string
}
export interface SourceGraph {
  readonly sources: Map<string, SourceRecord>
  readonly entries: TargetEntry[]
}
export const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export const entryId = (namespace: string, id: string) => namespace + '/' + encodeURIComponent(id)
export class ConfigConflictError extends Error {
  constructor(readonly filename: string) { super('configuration changed on disk: ' + filename); this.name = 'ConfigConflictError' }
}

export async function readGraph(
  filename: string, namespace: string, labels: Map<string, symbol>,
  watchPaths: Set<string>, override?: { filename: string; document: IncludeDocument },
): Promise<SourceGraph> {
  const sources = new Map<string, SourceRecord>()
  const entries: TargetEntry[] = []
  const loading = new Set<string>()
  const seen = new Set<string>()
  const load = async (file: string, prefix: string, parentId: string) => {
    file = resolve(file)
    watchPaths.add(file)
    const canonical = await realpath(file)
    if (loading.has(canonical)) throw new DocumentError(file, 'include cycle')
    if (seen.has(canonical)) throw new DocumentError(file, 'source is mounted more than once')
    seen.add(canonical)
    loading.add(canonical)
    const text = await readFile(file, 'utf8')
    const document = override?.filename === file ? override.document : parseConfig(text, file)
    sources.set(file, Object.freeze({ filename: file, digest: digest(text), text, document }))
    const sourceUrl = pathToFileURL(file)
    const directoryUrl = new URL('.', sourceUrl).href
    const visit = async (nodes: readonly IncludeEntry[], parent: string) => {
      for (const [index, node] of nodes.entries()) {
        const id = entryId(prefix, node.id)
        const isolate = node.isolate && Object.fromEntries(Object.entries(node.isolate).map(([service, label]) => {
          const key = JSON.stringify([prefix, label])
          if (!labels.has(key)) labels.set(key, Symbol(key))
          return [service, labels.get(key)!]
        }))
        const baseUrl = node.baseUrl === undefined ? undefined : new URL(node.baseUrl, sourceUrl).href
        if (baseUrl && new URL(baseUrl).protocol !== 'file:') throw new DocumentError(file + '#' + node.id, 'baseUrl must resolve to a file: URL')
        const input: EntryInput = {
          id, type: node.type === 'include' ? 'group' : node.type ?? 'component',
          name: node.name, config: node.config, disabled: node.disabled,
          inject: node.inject, intercept: node.intercept, isolate,
          baseUrl,
        } as EntryInput
        entries.push({ input, parentId: parent, index, source: file })
        if (node.type === 'include') {
          const childFile = node.path!.startsWith('file:') ? fileURLToPath(node.path!) : resolve(dirname(file), node.path!)
          // 此挂载建立子文件自己的模块基址；普通组仍继承其父组覆盖。
          entries[entries.length - 1] = { input: { ...input, baseUrl: baseUrl ?? new URL('.', pathToFileURL(childFile)).href }, parentId: parent, index, source: file }
          await load(childFile, id, id)
        } else if (node.children) await visit(node.children, id)
      }
    }
    if (parentId === namespace) entries.push({ input: { id: namespace, type: 'group', baseUrl: directoryUrl }, parentId: null, index: 0, source: file })
    await visit(document.entries, parentId)
    loading.delete(canonical)
  }
  await load(filename, namespace, namespace)
  return { sources, entries }
}

export async function checkSources(sources: ReadonlyMap<string, ConfigSource>) {
  for (const source of sources.values()) {
    let text: string
    try { text = await readFile(source.filename, 'utf8') } catch { throw new ConfigConflictError(source.filename) }
    if (digest(text) !== source.digest) throw new ConfigConflictError(source.filename)
  }
}
export async function writeSource(source: SourceRecord, document: IncludeDocument): Promise<SourceRecord> {
  const text = serializeConfig(document, source.filename, source.text)
  const temporary = source.filename + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, text, { flag: 'wx' })
    await checkSources(new Map([[source.filename, source]]))
    await rename(temporary, source.filename)
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  return Object.freeze({ filename: source.filename, text, digest: digest(text), document })
}
