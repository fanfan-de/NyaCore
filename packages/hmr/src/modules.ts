/** 保留模块边界的 ESM 版本输出；不接触 Node 私有缓存。 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as resolveEsm } from 'import-meta-resolve'
import ts from 'typescript'
import type { Component } from '@nya/core'
import type { LoaderResolveRequest } from '@nya/loader'

export class ModuleBuildError extends Error {
  constructor(readonly phase: 'build' | 'typecheck' | 'unsupported', message: string) {
    super(message)
    this.name = 'ModuleBuildError'
  }
}
interface Edit { start: number; end: number; value?: string; dependency?: string }
interface ModuleFile {
  filename: string
  text: string
  edits: Edit[]
  dependencies: Set<string>
  assets: Set<string>
}
export interface ModuleGraph {
  entries: readonly string[]
  files: Map<string, ModuleFile>
  inputs: Map<string, string>
  signatures: Map<string, string>
  reachable: Map<string, Set<string>>
  fingerprint: string
  compilerOptions: ts.CompilerOptions
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const unsupported = (message: string): never => { throw new ModuleBuildError('unsupported', message) }
const exists = async (filename: string) => { try { return (await stat(filename)).isFile() } catch { return false } }

export async function sourceFile(filename: string): Promise<string> {
  if (!await exists(filename)) {
    for (const [extension, replacement] of [['.js', '.ts'], ['.mjs', '.mts']]) {
      if (filename.endsWith(extension) && await exists(filename.slice(0, -extension.length) + replacement)) {
        filename = filename.slice(0, -extension.length) + replacement
        break
      }
    }
  }
  return realpath(filename)
}
export async function requestFile(request: LoaderResolveRequest): Promise<string | undefined> {
  const { name, baseUrl } = request
  let url: URL
  try {
    if (name.startsWith('file:')) url = new URL(name)
    else if (name.startsWith('.') || name.startsWith('/')) {
      if (!baseUrl) return
      url = new URL(name, baseUrl)
    } else {
      if (!baseUrl) return
      const base = baseUrl.endsWith('/') ? new URL('__nya_hmr__.mjs', baseUrl).href : baseUrl
      url = new URL(resolveEsm(name, base))
    }
    if (url.protocol !== 'file:' || url.search || url.hash) return
    return await sourceFile(fileURLToPath(url))
  } catch { return }
}

export async function buildGraph(entryFiles: readonly string[], configPath?: string): Promise<ModuleGraph> {
  const files = new Map<string, ModuleFile>()
  const inputs = new Map<string, string>()
  const signatures = new Map<string, string>()
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true,
  }
  if (configPath) {
    const text = await readFile(configPath, 'utf8')
    inputs.set(configPath, hash(text))
    const parsed = ts.parseConfigFileTextToJson(configPath, text)
    if (parsed.error) throw new ModuleBuildError('typecheck', ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'))
    const config = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dirname(configPath))
    if (config.errors.length) throw new ModuleBuildError('typecheck', config.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
    Object.assign(compilerOptions, config.options, { strict: true, noEmit: true })
  }
  const visit = async (filename: string): Promise<void> => {
    filename = await sourceFile(filename)
    if (files.has(filename)) return
    const extension = extname(filename).toLowerCase()
    if (!['.js', '.mjs', '.ts', '.mts', '.json'].includes(extension) || filename.endsWith('.d.ts')) unsupported('unsupported local module: ' + filename)
    const text = await readFile(filename, 'utf8')
    inputs.set(filename, hash(text))
    const file: ModuleFile = { filename, text, edits: [], dependencies: new Set(), assets: new Set() }
    files.set(filename, file)
    if (extension === '.json') {
      JSON.parse(text)
      signatures.set(filename, hash(text))
      return
    }
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true)
    const imports: ts.StringLiteralLike[] = []
    const resources: ts.StringLiteralLike[] = []
    const scan = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings
        if (node.importClause?.name || !bindings || !ts.isNamedImports(bindings) || !bindings.elements.length || bindings.elements.some(element => !element.isTypeOnly)) imports.push(node.moduleSpecifier)
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        if (!node.exportClause || !ts.isNamedExports(node.exportClause) || !node.exportClause.elements.length || node.exportClause.elements.some(element => !element.isTypeOnly)) imports.push(node.moduleSpecifier)
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) unsupported('dynamic import must be a literal: ' + filename)
        imports.push(node.arguments[0] as ts.StringLiteralLike)
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['require', 'eval'].includes(node.expression.text)) unsupported('runtime require/eval is not managed: ' + filename)
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
        && node.arguments?.length === 2 && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[1].getText(source) === 'import.meta.url') resources.push(node.arguments[0])
      if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)) {
        const property = node.name.text
        const value = property === 'url' ? pathToFileURL(filename).href : property === 'dirname' ? dirname(filename) : property === 'filename' ? filename : undefined
        if (value === undefined) unsupported('unsupported import.meta property: ' + property)
        file.edits.push({ start: node.getStart(source), end: node.end, value: JSON.stringify(value) })
        return
      }
      if (ts.isMetaProperty(node)) unsupported('bare import.meta is not managed: ' + filename)
      ts.forEachChild(node, scan)
    }
    scan(source)
    for (const node of imports) {
      const specifier = node.text
      if (specifier.startsWith('node:')) continue
      const local = specifier.startsWith('.') || specifier.startsWith('file:') || specifier.startsWith('/') || specifier.startsWith('#')
      const url = local && !specifier.startsWith('#')
        ? new URL(specifier, pathToFileURL(filename))
        : new URL(resolveEsm(specifier, pathToFileURL(filename).href))
      if (!local || url.protocol === 'node:' || url.protocol === 'file:' && fileURLToPath(url).split(/[\\/]/).includes('node_modules')) {
        // 原导入者处解析外部包，避免产物目录选中另一份 Core。
        file.edits.push({ start: node.getStart(source), end: node.end, value: JSON.stringify(url.href) })
        continue
      }
      if (url.protocol !== 'file:' || url.hash || url.search) unsupported('unsupported local import URL: ' + url.href)
      const dependency = await sourceFile(fileURLToPath(url))
      file.dependencies.add(dependency)
      file.edits.push({ start: node.getStart(source), end: node.end, dependency })
      await visit(dependency)
    }
    for (const node of resources) {
      const url = new URL(node.text, pathToFileURL(filename))
      if (url.protocol !== 'file:') continue
      const asset = await realpath(fileURLToPath(url))
      const content = await readFile(asset)
      inputs.set(asset, createHash('sha256').update(content).digest('hex'))
      file.assets.add(asset)
    }
    signatures.set(filename, hash(text + JSON.stringify(file.edits)))
  }
  const entries: string[] = []
  for (const filename of entryFiles) { const canonical = await sourceFile(filename); entries.push(canonical); await visit(canonical) }
  const typescriptFiles = [...files.keys()].filter(file => /\.[m]?ts$/.test(file))
  if (typescriptFiles.length) {
    const program = ts.createProgram(typescriptFiles, compilerOptions)
    const errors = ts.getPreEmitDiagnostics(program).filter(error => error.category === ts.DiagnosticCategory.Error)
    if (errors.length) throw new ModuleBuildError('typecheck', ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n',
    }))
    for (const source of program.getSourceFiles()) {
      if (source.fileName.split(/[\\/]/).includes('node_modules')) continue
      const filename = await realpath(source.fileName)
      if (!inputs.has(filename)) inputs.set(filename, hash(source.text))
    }
  }
  const reachable = new Map<string, Set<string>>()
  for (const entry of entries) {
    const set = new Set<string>()
    const walk = (file: string) => {
      if (set.has(file)) return
      set.add(file)
      for (const asset of files.get(file)!.assets) set.add(asset)
      for (const child of files.get(file)!.dependencies) walk(child)
    }
    walk(entry)
    reachable.set(entry, set)
  }
  const fingerprint = hash(JSON.stringify([...inputs].sort()) + JSON.stringify([...signatures].sort()) + JSON.stringify(compilerOptions))
  return { entries, files, inputs, signatures, reachable, fingerprint, compilerOptions }
}

export async function graphIsFresh(graph: ModuleGraph): Promise<boolean> {
  for (const [filename, expected] of graph.inputs) {
    try { if (createHash('sha256').update(await readFile(filename)).digest('hex') !== expected) return false } catch { return false }
  }
  return true
}
export function affectedEntries(previous: ModuleGraph | undefined, next: ModuleGraph): string[] {
  if (!previous) return [...next.entries]
  const changed = new Set([...previous.inputs.keys(), ...next.inputs.keys()].filter(file =>
    previous.inputs.get(file) !== next.inputs.get(file) || previous.signatures.get(file) !== next.signatures.get(file)))
  if (JSON.stringify(previous.compilerOptions) !== JSON.stringify(next.compilerOptions)) return [...next.entries]
  const affected = new Set(next.entries.filter(entry => [...(next.reachable.get(entry) ?? [])].some(file => changed.has(file))
    || [...(previous.reachable.get(entry) ?? [])].some(file => changed.has(file))))
  // 共享本地模块连接的入口必须一起更新，保持该集合的模块身份一致。
  let expanded = true
  while (expanded) {
    expanded = false
    for (const entry of next.entries) if (!affected.has(entry)) {
      const reachable = new Set([...(next.reachable.get(entry) ?? []), ...(previous.reachable.get(entry) ?? [])])
      if ([...affected].some(other => [...(next.reachable.get(other) ?? []), ...(previous.reachable.get(other) ?? [])].some(file => reachable.has(file)))) {
        affected.add(entry); expanded = true
      }
    }
  }
  return [...affected]
}
export async function emitGeneration(graph: ModuleGraph, entries: readonly string[], directory: string): Promise<Map<string, string>> {
  await mkdir(directory, { recursive: true })
  const needed = new Set(entries.flatMap(entry => [...graph.reachable.get(entry)!]).filter(file => graph.files.has(file)))
  const paths = new Map([...needed].map(file => [file, join(directory, hash(file).slice(0, 24) + (extname(file).toLowerCase() === '.json' ? '.json' : '.mjs'))]))
  for (const filename of needed) {
    const file = graph.files.get(filename)!
    const output = paths.get(filename)!
    if (extname(filename).toLowerCase() === '.json') { await writeFile(output, file.text); continue }
    let source = file.text
    for (const edit of [...file.edits].sort((a, b) => b.start - a.start)) {
      const replacement = edit.value ?? JSON.stringify(pathToFileURL(paths.get(edit.dependency!)!).href)
      source = source.slice(0, edit.start) + replacement + source.slice(edit.end)
    }
    const result = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: { ...graph.compilerOptions, noEmit: false, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, sourceMap: true, inlineSources: true, declaration: false, declarationMap: false },
      reportDiagnostics: true,
    })
    const errors = result.diagnostics?.filter(error => error.category === ts.DiagnosticCategory.Error)
    if (errors?.length) throw new ModuleBuildError('build', errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
    const code = result.outputText.replace(/\/\/# sourceMappingURL=.*$/m, '//# sourceMappingURL=' + output.split(/[\\/]/).at(-1) + '.map')
    await writeFile(output, code)
    if (result.sourceMapText) {
      const map = JSON.parse(result.sourceMapText)
      map.sources = [pathToFileURL(filename).href]
      map.file = output.split(/[\\/]/).at(-1)
      await writeFile(output + '.map', JSON.stringify(map))
    }
  }
  return new Map(entries.map(entry => [entry, pathToFileURL(paths.get(entry)!).href]))
}
export function componentExport(namespace: unknown): Component<any> {
  const definition = namespace && typeof namespace === 'object' ? Reflect.get(namespace, 'default') : undefined
  if (typeof definition === 'function' || definition && typeof definition === 'object' && typeof Reflect.get(definition, 'apply') === 'function') return definition
  throw new TypeError('HMR module must default-export a Component')
}
export function configuredFile(name: string, baseUrl?: string): string {
  if (name.startsWith('file:')) return fileURLToPath(name)
  if (isAbsolute(name)) return resolve(name)
  if (!baseUrl) throw new TypeError('relative HMR entries require baseUrl')
  return fileURLToPath(new URL(name, baseUrl))
}
