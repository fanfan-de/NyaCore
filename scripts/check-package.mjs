/** 本文件构建 npm tarball，并从外部消费者视角验证发布文件、运行时导入与类型声明。 */

import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const repositoryRoot = resolve(import.meta.dirname, '..')
const packageRoot = join(repositoryRoot, 'packages/core')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'nya-package-check-'))
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const childEnvironment = { ...process.env }

// `npm publish --dry-run` 会把 dry-run 配置传给生命周期子进程；本检查必须
// 真正生成并安装临时 tarball，才能验证发布产物，而不是只读取模拟清单。
delete childEnvironment.npm_config_dry_run
delete childEnvironment.NPM_CONFIG_DRY_RUN

function run(command, args, cwd = repositoryRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  )
  assert(packageJson.license === 'MIT', 'package license must be MIT')
  assert(
    packageJson.engines?.node === '>=22.12.0',
    'package must declare Node.js >=22.12.0',
  )
  assert(
    packageJson.publishConfig?.access === 'public',
    'scoped package must publish with public access',
  )

  const packed = JSON.parse(run(npmCommand, [
    'pack',
    '--workspace',
    '@nya/core',
    '--pack-destination',
    temporaryRoot,
    '--json',
  ]))
  assert(packed.length === 1, 'expected npm pack to produce one tarball')

  const result = packed[0]
  const files = new Set(result.files.map(file => file.path))
  for (const expected of [
    'LICENSE',
    'README.md',
    'lib/index.d.ts',
    'lib/index.js',
    'package.json',
  ]) {
    assert(files.has(expected), `package is missing ${expected}`)
  }
  assert(
    ![...files].some(file => file.startsWith('src/')),
    'package must not contain source files',
  )
  assert(
    ![...files].some(file => file.startsWith('tests/')),
    'package must not contain test files',
  )

  const consumerRoot = join(temporaryRoot, 'consumer')
  mkdirSync(consumerRoot)
  writeFileSync(join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'nya-package-consumer',
    private: true,
    type: 'module',
  }, null, 2))
  writeFileSync(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2022',
    },
    files: ['index.ts'],
  }, null, 2))
  writeFileSync(join(consumerRoot, 'index.ts'), `
import { Context, FiberState, type Fiber } from '@nya/core'

const context = new Context()
const fiber: Fiber = context.installComponent(() => undefined)
void FiberState.ACTIVE
void fiber
`)

  const tarball = join(temporaryRoot, result.filename)
  run(npmCommand, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ], consumerRoot)
  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      import { Context, FiberState } from '@nya/core'
      const app = new Context()
      if (app.fiber.state !== FiberState.ACTIVE) {
        throw new Error('root Fiber is not ACTIVE')
      }
      await app.fiber.dispose()
    `,
  ], consumerRoot)
  run(process.execPath, [
    join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
    '--project',
    join(consumerRoot, 'tsconfig.json'),
  ], consumerRoot)

  console.log(
    `npm 包检查通过：${result.filename}，共 ${result.entryCount} 个文件`,
  )
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}
