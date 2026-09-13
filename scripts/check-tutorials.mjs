/** 使用教程原文的配置与源码，在全新目录安装发布归档并运行 npm test。 */

import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const tutorialFile = resolve(import.meta.dirname, '../docs/tutorials/framework-basics.md')
const requiredFiles = [
  '01-component.ts', '02-service.ts', '03-effects.ts', '04-update.ts',
  '05-plugin.ts', '05-loader.ts', '06-pending.ts',
]
const supportingFiles = new Set(['05-plugin.ts'])

function extractExamples(source) {
  const examples = new Map()
  const configurations = []
  let fence
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!fence) {
      const opening = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
      if (!opening) continue
      fence = { marker: opening[1], info: opening[2].trim(), lines: [], line: index + 1 }
      continue
    }

    const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/)
    if (!closing || closing[1][0] !== fence.marker[0] || closing[1].length < fence.marker.length) {
      fence.lines.push(line)
      continue
    }

    if (/^(?:ts|typescript)(?:\s|$)/i.test(fence.info)) {
      const marked = fence.info.match(/^ts nya-check:([A-Za-z0-9][A-Za-z0-9_-]*\.ts)$/)
      assert.ok(marked, `tutorial line ${fence.line}: every TypeScript fence needs a safe nya-check filename`)
      const filename = marked[1]
      assert.ok(!examples.has(filename), `duplicate tutorial filename: ${filename}`)
      assert.ok(fence.lines.some(line => line.trim()), `empty tutorial example: ${filename}`)
      examples.set(filename, `${fence.lines.join('\n')}\n`)
    } else {
      assert.ok(!fence.info.includes('nya-check:'), `unsupported tutorial fence: ${fence.info}`)
      if (fence.info === 'json') {
        const source = `${fence.lines.join('\n')}\n`
        configurations.push({ source, value: JSON.parse(source) })
      }
    }
    fence = undefined
  }
  assert.equal(fence, undefined, 'tutorial contains an unclosed code fence')
  for (const filename of requiredFiles) assert.ok(examples.has(filename), `missing tutorial example: ${filename}`)
  assert.equal(configurations.length, 2, 'tutorial must contain package.json and tsconfig.json fences')
  return { examples, manifest: configurations[0], tsconfig: configurations[1] }
}

export function checkTutorials(consumerRoot, runNpm) {
  if (!existsSync(tutorialFile)) {
    console.log('跳过本地入门教程检查：docs/tutorials/framework-basics.md 不存在')
    return
  }

  const { examples, manifest, tsconfig } = extractExamples(readFileSync(tutorialFile, 'utf8'))
  assert.equal(manifest.value?.private, true, 'tutorial package.json must be private')
  assert.equal(manifest.value?.type, 'module', 'tutorial package.json must use ESM')
  assert.equal(manifest.value?.scripts?.build, 'tsc -p tsconfig.json')
  assert.equal(typeof manifest.value?.scripts?.test, 'string', 'tutorial must provide npm test')
  const entries = [...examples.keys()].filter(filename => !supportingFiles.has(filename))
  assert.deepEqual(
    manifest.value.scripts.test.split('&&').map(command => command.trim().replace(/\s+/g, ' ')),
    ['npm run build', ...entries.map(filename => `node dist/${filename.replace(/\.ts$/, '.js')}`)],
    'tutorial npm test must build and execute every marked entry exactly once',
  )
  assert.equal(tsconfig.value?.compilerOptions?.strict, true, 'tutorial compilation must remain strict')
  assert.equal(tsconfig.value?.compilerOptions?.module, 'NodeNext')
  assert.equal(tsconfig.value?.compilerOptions?.moduleResolution, 'NodeNext')
  assert.equal(tsconfig.value?.compilerOptions?.target, 'ES2022')
  assert.equal(tsconfig.value?.compilerOptions?.noEmitOnError, true)
  assert.deepEqual(tsconfig.value?.compilerOptions?.types, ['node'])

  const dependencies = Object.entries(manifest.value.dependencies ?? {})
  assert.deepEqual(dependencies.map(([name]) => name).sort(), [
    '@nya/core', '@nya/loader', '@nya/logger-console', '@nya/timer',
  ], 'tutorial must install the four public Nya packages')
  const tarballs = dependencies.map(([name, reference]) => {
    assert.equal(typeof reference, 'string', `tutorial dependency ${name} must reference a tarball`)
    const local = reference.match(/^file:vendor\/([A-Za-z0-9][A-Za-z0-9._-]*\.tgz)$/)
    assert.ok(local, `tutorial dependency ${name} needs a safe file:vendor/*.tgz reference`)
    return local[1]
  })
  assert.equal(new Set(tarballs).size, 4, 'tutorial dependencies must use four distinct archives')

  const directory = join(consumerRoot, 'tutorial-check')
  mkdirSync(directory)
  mkdirSync(join(directory, 'src'))
  mkdirSync(join(directory, 'vendor'))
  writeFileSync(join(directory, 'package.json'), manifest.source)
  writeFileSync(join(directory, 'tsconfig.json'), tsconfig.source)
  for (const tarball of tarballs) {
    copyFileSync(join(consumerRoot, 'vendor', tarball), join(directory, 'vendor', tarball))
  }
  for (const [filename, source] of examples) writeFileSync(join(directory, 'src', filename), source)

  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], directory)
  // 确认自己的安装完整，不能因为祖先示例恰好有依赖而误判教程可独立运行。
  for (const name of [...dependencies.map(([name]) => name), 'typescript', '@types/node']) {
    assert.ok(existsSync(join(directory, 'node_modules', name, 'package.json')), `tutorial did not install its own ${name}`)
  }
  assert.ok(existsSync(join(directory, 'node_modules/typescript/bin/tsc')), 'tutorial must use its own compiler')
  runNpm(['test'], directory)
  console.log(`教程消费者检查通过：原文配置独立安装，${examples.size} 个 TypeScript 文件，${entries.length} 个运行入口`)
}
