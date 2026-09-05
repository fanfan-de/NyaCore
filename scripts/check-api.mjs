/** 从构建声明生成可审查的 API 基线；不把可达内部声明变成公开子路径。 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import ts from 'typescript'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageNames = ['core', 'loader', 'logger-console', 'timer']
const declarationPattern = /\.d\.[cm]?ts$/

function portable(path) {
  return path.replaceAll('\\', '/')
}

function within(directory, filename) {
  const difference = relative(directory, filename)
  return difference !== '..' && !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(difference)
}

function parseDeclaration(source, filename) {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  if (parsed.parseDiagnostics.length) {
    throw new Error(`${filename}: ${ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, '\n')}`)
  }
  return parsed
}

/** 注释及实现私有成员不制造漂移；构造器可见性和 protected API 仍保留。 */
export function normalizeDeclaration(source, filename = 'index.d.ts') {
  const parsed = parseDeclaration(source, filename)
  const result = ts.transform(parsed, [context => root => {
    const visit = node => {
      if (ts.isEmptyStatement(node)) return undefined
      if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text)
      if (
        ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
      ) {
        const privateName = node.name && ts.isPrivateIdentifier(node.name)
        const privateModifier = ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword)
        if (privateName || privateModifier) return undefined
      }
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(root, visit)
  }])
  try {
    return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
      .printFile(result.transformed[0]).trimEnd() + '\n'
  } finally {
    result.dispose()
  }
}

function strings(value) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object') return []
  return Object.values(value).flatMap(strings)
}

function declarationCandidate(filename) {
  if (declarationPattern.test(filename)) return filename
  if (filename.endsWith('.mjs')) return filename.slice(0, -4) + '.d.mts'
  if (filename.endsWith('.cjs')) return filename.slice(0, -4) + '.d.cts'
  if (filename.endsWith('.js')) return filename.slice(0, -3) + '.d.ts'
}

function localReferences(source) {
  const references = new Set(source.referencedFiles.map(reference => reference.fileName))
  const visit = node => {
    let specifier
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
    if (ts.isExternalModuleReference(node)) specifier = node.expression
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) specifier = node.name
    if (specifier && ts.isStringLiteralLike(specifier) && (specifier.text.startsWith('.') || specifier.text.startsWith('#'))) {
      references.add(specifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...references]
}

/** 收集 exports/types 入口可达的本包声明文件；不递归外部依赖的 node_modules。 */
export async function createApiSnapshot(packageDirectory) {
  const root = resolve(packageDirectory)
  const library = join(root, 'lib')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const targets = new Set([
    ...strings(manifest.exports), ...strings(manifest.types), ...strings(manifest.typings),
  ])
  const entries = new Set()
  for (const target of targets) {
    const candidate = declarationCandidate(target)
    if (!candidate) continue
    if (candidate.includes('*')) throw new Error(`${manifest.name}: wildcard declaration exports require explicit baseline support`)
    const filename = resolve(root, candidate)
    if (!within(library, filename)) throw new Error(`${manifest.name}: declaration entry is outside published lib: ${target}`)
    if (ts.sys.fileExists(filename)) entries.add(filename)
    else if (declarationPattern.test(target)) throw new Error(`${manifest.name}: missing ${target}; run npm run build first`)
  }
  if (!entries.size) throw new Error(`${manifest.name}: no built declaration entry; run npm run build first`)

  const declarations = new Map()
  const pending = [...entries]
  while (pending.length) {
    const filename = pending.pop()
    if (declarations.has(filename)) continue
    const normalized = normalizeDeclaration(await readFile(filename, 'utf8'), filename)
    const source = parseDeclaration(normalized, filename)
    declarations.set(filename, normalized)
    for (const specifier of localReferences(source)) {
      const direct = resolve(dirname(filename), specifier)
      const resolved = declarationPattern.test(direct) && ts.sys.fileExists(direct)
        ? direct
        : ts.resolveModuleName(specifier, filename, {
          module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        }, ts.sys).resolvedModule?.resolvedFileName
      if (!resolved || !declarationPattern.test(resolved) || !within(library, resolved)) {
        throw new Error(`${manifest.name}: ${portable(relative(root, filename))} references an unshipped declaration: ${specifier}`)
      }
      pending.push(resolved)
    }
  }

  const contract = {
    name: manifest.name,
    exports: manifest.exports,
    imports: manifest.imports,
    types: manifest.types,
    typings: manifest.typings,
    typesVersions: manifest.typesVersions,
  }
  const sections = [
    'Generated by node scripts/check-api.mjs --update; do not edit by hand.',
    'Scope: declaration files reachable from published type entries, including internal type references.',
    'Only package exports define importable subpaths; this snapshot does not publish internal modules.',
    'Comments and implementation-private members are omitted; constructor visibility is retained.',
    '',
    '=== package contract ===',
    JSON.stringify(contract, null, 2),
  ]
  for (const [filename, text] of [...declarations].sort(([left], [right]) => portable(relative(root, left)).localeCompare(portable(relative(root, right)), 'en'))) {
    sections.push('', `=== ${portable(relative(root, filename))} ===`, text.trimEnd())
  }
  return sections.join('\n') + '\n'
}

/** 只读比较为默认行为；显式 --update 才会写基线。 */
export async function checkApi({ root = repositoryRoot, update = false, output = console } = {}) {
  const snapshots = await Promise.all(packageNames.map(async name => ({
    name,
    path: join(root, 'api', `${name}.api.txt`),
    text: await createApiSnapshot(join(root, 'packages', name)),
  })))
  if (update) {
    await mkdir(join(root, 'api'), { recursive: true })
    await Promise.all(snapshots.map(snapshot => writeFile(snapshot.path, snapshot.text, 'utf8')))
    output.log(`已更新 API 基线：${snapshots.length} 个包。提交前请审查兼容性和迁移说明。`)
    return true
  }

  const differences = []
  for (const snapshot of snapshots) {
    let previous
    try { previous = (await readFile(snapshot.path, 'utf8')).replaceAll('\r\n', '\n') } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (previous === snapshot.text) continue
    const lines = previous?.split('\n') ?? []
    const line = snapshot.text.split('\n').findIndex((text, index) => text !== lines[index]) + 1
    differences.push(`${portable(relative(root, snapshot.path))}:${line || lines.length + 1}`)
  }
  if (differences.length) {
    output.error(`API 基线漂移或缺失：${differences.join(', ')}`)
    output.error('有意变更请先审查兼容性和迁移说明，再运行 node scripts/check-api.mjs --update 并提交基线。')
    return false
  }
  output.log(`API 基线检查通过（${snapshots.length} 个包）。`)
  return true
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args.length === 1 && args[0] !== '--update')) {
      throw new Error('Usage: node scripts/check-api.mjs [--update]')
    }
    if (!await checkApi({ update: args[0] === '--update' })) process.exitCode = 1
  } catch (error) {
    console.error(`API 基线检查失败：${error.message}`)
    process.exitCode = 1
  }
}
