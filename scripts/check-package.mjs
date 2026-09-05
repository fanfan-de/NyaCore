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
import { checkExample } from './check-example.mjs'
import { checkResolverConsumer } from './check-resolver-consumer.mjs'
import { checkIncludeHmrConsumer } from './check-include-hmr-consumer.mjs'
import { createReleaseBundle } from './pack-release.mjs'
import { createHash } from 'node:crypto'

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
  { directory: 'packages/include', name: '@nya/include' },
  { directory: 'packages/hmr', name: '@nya/hmr' },
  {
    directory: 'packages/logger-console',
    name: '@nya/logger-console',
  },
  {
    directory: 'packages/timer',
    name: '@nya/timer',
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
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
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
    assert(packageJson.version === '0.1.0-rc.1', `${specification.name} must match the current release candidate`)
    if (specification.name !== '@nya/core') {
      assert(packageJson.peerDependencies?.['@nya/core'] === '^0.1.0-rc.1',
        `${specification.name} must require the supported Core series`)
    }
    if (['@nya/include', '@nya/hmr'].includes(specification.name)) {
      assert(packageJson.peerDependencies?.['@nya/loader'] === '^0.1.0-rc.1',
        specification.name + ' must require the supported Loader series')
    }

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
import { Timer, type TimerCallback } from '@nya/timer'
import { Include, type IncludeDocument } from '@nya/include'
import { Hmr, type HmrReport } from '@nya/hmr'

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
context.installComponent(Timer)
const callback: TimerCallback = async () => {}
const cancel = context.timer.timeout(callback, 0)
const dependencies = fiber.inspect().dependencies
void cancel
void dependencies
void FiberState.ACTIVE
void fiber
void record
void loader
void entry
const document: IncludeDocument = { version: 1, entries: [] }
const report: HmrReport | undefined = context.hmr?.report()
void document
void report
void Include
void Hmr
`)

  const tarballs = packageResults.map(result => {
    return join(temporaryRoot, result.filename)
  })
  runNpm([
    'install',
    '--strict-peer-deps',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    ...tarballs,
  ], consumerRoot)
  runNpm(['ls', '--all', '--json'], consumerRoot)
  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      import { Context, FiberState } from '@nya/core'
      import { Loader } from '@nya/loader'
      import { ConsoleLogger } from '@nya/logger-console'
      import { Timer } from '@nya/timer'
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
      await app.installComponent(Timer)
      let ticks = 0
      let written
      const observed = new Promise(resolve => { written = resolve })
      const ticker = app.installComponent({
        inject: ['timer'],
        apply(ctx) {
          ctx.timer.timeout(() => { ticks++; written() }, 0)
          ctx.timer.interval(() => { throw new Error('cancelled interval ran') }, 10000)
        },
      })
      await ticker
      await observed
      await ticker.dispose()
      if (ticks !== 1 || ticker.inspect().effects.length) throw new Error('Timer ownership was not released')
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

  // 默认 Resolver 必须面对真实宿主文件与安装的 npm 插件，而不只测试内存定义。
  checkResolverConsumer(temporaryRoot, consumerRoot, runNpm)

  runNpm(['run', 'build', '--workspace', '@nya/example-task-journal'])
  const releaseDirectory = createReleaseBundle(join(temporaryRoot, 'release-candidate'),
    packageSpecifications.map((specification, index) => ({
      name: specification.name, tarball: tarballs[index],
    })))
  const release = JSON.parse(readFileSync(join(releaseDirectory, 'RELEASE.json'), 'utf8'))
  assert(release.version === '0.1.0-rc.1' && release.packages.length === packageSpecifications.length,
    'candidate manifest must identify all RC packages')
  for (const entry of release.packages) {
    const digest = createHash('sha256').update(readFileSync(join(releaseDirectory, entry.path))).digest('hex')
    assert(digest === entry.sha256, `candidate digest does not match ${entry.name}`)
  }
  const sums = readFileSync(join(releaseDirectory, 'SHA256SUMS'), 'utf8')
  for (const entry of release.packages) assert(sums.includes(`${entry.sha256}  ${entry.path}`),
    `candidate SHA256SUMS is missing ${entry.name}`)

  // 使用与分发命令相同的示例产物，不从 monorepo 源码路径运行教程。
  checkExample(temporaryRoot, packageSpecifications.map((specification, index) => ({
    name: specification.name,
    tarball: tarballs[index],
  })), runNpm)
  checkIncludeHmrConsumer(temporaryRoot, consumerRoot, releaseDirectory, runNpm)

  const summary = packageResults.map(result => {
    return `${result.filename}（${result.entryCount} 个文件）`
  }).join('，')
  console.log(`npm 包检查通过：${summary}`)
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}
