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
const temporaryRoot = mkdtempSync(join(tmpdir(), 'nya-package-check-'))
const npmCli = process.env.npm_execpath
const childEnvironment = { ...process.env }
const packageSpecifications = [
  {
    directory: 'packages/core',
    name: '@nya/core',
  },
  {
    directory: 'packages/loader',
    name: '@nya/loader',
  },
  {
    directory: 'packages/logger-console',
    name: '@nya/logger-console',
  },
]

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

function runNpm(args, cwd = repositoryRoot) {
  assert(npmCli, 'npm_execpath is unavailable; run this check through npm')
  return run(process.execPath, [npmCli, ...args], cwd)
}

try {
  const packageResults = []
  for (const specification of packageSpecifications) {
    const packageRoot = join(repositoryRoot, specification.directory)
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    )
    assert(
      packageJson.name === specification.name,
      `${specification.name} package name does not match its workspace`,
    )
    assert(
      packageJson.license === 'MIT',
      `${specification.name} package license must be MIT`,
    )
    assert(
      packageJson.engines?.node === '>=22.12.0',
      `${specification.name} must declare Node.js >=22.12.0`,
    )
    assert(
      packageJson.publishConfig?.access === 'public',
      `${specification.name} must publish with public access`,
    )

    const packed = JSON.parse(runNpm([
      'pack',
      '--workspace',
      specification.name,
      '--pack-destination',
      temporaryRoot,
      '--json',
    ]))
    assert(
      packed.length === 1,
      `expected npm pack to produce one ${specification.name} tarball`,
    )

    const result = packed[0]
    const files = new Set(result.files.map(file => file.path))
    for (const expected of [
      'LICENSE',
      'README.md',
      'lib/index.d.ts',
      'lib/index.js',
      'package.json',
    ]) {
      assert(
        files.has(expected),
        `${specification.name} package is missing ${expected}`,
      )
    }
    assert(
      ![...files].some(file => file.startsWith('src/')),
      `${specification.name} package must not contain source files`,
    )
    assert(
      ![...files].some(file => file.startsWith('tests/')),
      `${specification.name} package must not contain test files`,
    )
    packageResults.push(result)
  }

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
import { Context, FiberState, type Fiber, type LogRecord } from '@nya/core'
import { Loader, type EntrySnapshot, type LoaderResolver } from '@nya/loader'
import { ConsoleLogger, type ConsoleLoggerOptions } from '@nya/logger-console'

const context = new Context()
const fiber: Fiber = context.installComponent(() => undefined)
const options: ConsoleLoggerOptions = { timestamps: false }
const record: LogRecord | undefined = context.logger.records()[0]
const resolver: LoaderResolver = async () => {
  return () => undefined
}
const loader = context.installComponent(Loader, { resolver })
const entry: EntrySnapshot | undefined = context.loader?.get('worker')
context.installComponent(ConsoleLogger, options)
void FiberState.ACTIVE
void fiber
void record
void loader
void entry
`)

  const tarballs = packageResults.map(result => {
    return join(temporaryRoot, result.filename)
  })
  runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...tarballs,
  ], consumerRoot)
  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      import { Context, FiberState } from '@nya/core'
      import { Loader } from '@nya/loader'
      import { ConsoleLogger } from '@nya/logger-console'
      const app = new Context()
      const target = {
        debug() {},
        error() {},
        info() {},
        warn() {},
      }
      const logger = app.installComponent(ConsoleLogger, {
        replay: false,
        target,
        timestamps: false,
      })
      await logger
      const loaderFiber = app.installComponent(Loader, {
        resolver: async () => () => undefined,
      })
      await loaderFiber
      const entry = await app.loader.create({
        id: 'package-worker',
        name: 'memory:worker',
      })
      if (entry.state !== 'active') {
        throw new Error('Loader entry is not active')
      }
      await app.loader.remove(entry.id)
      app.logger.info('package check')
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

  const summary = packageResults.map(result => {
    return `${result.filename}（${result.entryCount} 个文件）`
  }).join('，')
  console.log(`npm 包检查通过：${summary}`)
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}
