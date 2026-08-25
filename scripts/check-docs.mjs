import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const errors = []

async function collectMarkdown(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...await collectMarkdown(entryPath))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath)
    }
  }

  return files
}

async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function relative(file) {
  return path.relative(root, file) || '.'
}

function inspectMarkdown(file, content) {
  const lines = content.split(/\r?\n/)
  const visibleLines = []
  let fence = null

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*(`{3,}|~{3,})/)

    if (match) {
      const marker = match[1]

      if (!fence) {
        fence = { character: marker[0], length: marker.length, line: index + 1 }
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null
      }

      continue
    }

    if (!fence) visibleLines.push({ line, number: index + 1 })
  }

  if (fence) {
    errors.push(`${relative(file)}:${fence.line} 代码围栏未闭合`)
  }

  const headings = visibleLines.filter(({ line }) => /^#\s+\S/.test(line))
  if (headings.length !== 1) {
    errors.push(`${relative(file)} 应恰好包含一个一级标题，当前为 ${headings.length} 个`)
  }

  return visibleLines
}

function localTargets(visibleLines) {
  const targets = []
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^)]*['"])?\)/g

  for (const { line, number } of visibleLines) {
    for (const match of line.matchAll(linkPattern)) {
      targets.push({ target: match[1].replace(/^<|>$/g, ''), line: number })
    }
  }

  return targets
}

async function validateLink(file, { target, line }) {
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) {
    return
  }

  const rawPath = target.split(/[?#]/, 1)[0]
  if (!rawPath) return

  let decodedPath
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    errors.push(`${relative(file)}:${line} 链接包含无效转义：${target}`)
    return
  }

  const resolved = decodedPath.startsWith('/')
    ? path.resolve(root, `.${decodedPath}`)
    : path.resolve(path.dirname(file), decodedPath)

  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    errors.push(`${relative(file)}:${line} 链接超出仓库范围：${target}`)
    return
  }

  if (!await pathExists(resolved)) {
    errors.push(`${relative(file)}:${line} 本地链接目标不存在：${target}`)
  }
}

const requiredFiles = [path.join(root, 'README.md'), path.join(root, 'AGENTS.md')]
const files = [...requiredFiles, ...await collectMarkdown(path.join(root, 'docs'))]

for (const file of files) {
  if (!await pathExists(file)) {
    errors.push(`${relative(file)} 不存在`)
    continue
  }

  const content = await readFile(file, 'utf8')
  const visibleLines = inspectMarkdown(file, content)

  for (const link of localTargets(visibleLines)) {
    await validateLink(file, link)
  }
}

if (errors.length > 0) {
  console.error(`文档检查失败（${errors.length} 项）：`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`文档检查通过：${files.length} 个 Markdown 文件`)
}
