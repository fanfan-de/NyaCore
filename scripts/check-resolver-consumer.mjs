/** 在实际 tarball 消费者的嵌套 npm 项目中验证默认 Loader Resolver。 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

const pluginName = 'nya-resolver-consumer-plugin'

const sharedPlugin = `
import assert from 'node:assert/strict'
import { Context } from '@nya/core'

export function createPlugin(branch) {
  return {
    name: 'ResolverConsumerPlugin:' + branch,
    apply(ctx, config) {
      assert.equal(Context, config.CoreContext, 'plugin must share its ancestor Core instance')
      assert.ok(Context.is(ctx))
      const { id, events, resources } = config
      events.push('start:' + branch + ':' + id)
      const resource = { id, closed: false }
      resources.push(resource)
      ctx.effect(() => {
        const timer = setInterval(() => {}, 60_000)
        return () => {
          clearInterval(timer)
          assert.equal(resource.closed, false, 'resource cleanup must run exactly once')
          resource.closed = true
          events.push('stop:' + branch + ':' + id)
        }
      }, 'plugin interval')
      ctx.on('fixture/ping', () => { events.push('ping:' + branch + ':' + id) })
    },
  }
}
`

const hostScript = `
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@nya/core'
import { Loader } from '@nya/loader'

const directory = dirname(fileURLToPath(import.meta.url))
const outer = dirname(directory)
const require = createRequire(import.meta.url)
assert.notEqual(resolve(process.cwd()), directory, 'cwd must differ from the explicit host base')
assert.equal(require('${pluginName}').branch, 'require')
assert.equal(require.resolve('@nya/core'), createRequire(join(outer, 'package.json')).resolve('@nya/core'))
assert.ok(!existsSync(join(directory, 'node_modules/@nya/core')), 'nested host must not install another Core')
assert.ok(!existsSync(join(directory, 'node_modules/@nya/loader')), 'Loader must be installed outside the host')
assert.ok(!existsSync(join(outer, 'node_modules/${pluginName}')), 'plugin must exist only inside the host')

const specialFile = join(directory, '组件 # %.mjs')
const specialUrl = pathToFileURL(specialFile).href
assert.ok(specialUrl.includes('%23') && specialUrl.includes('%25') && specialUrl.includes('%20'))
const cases = [
  ['package', '${pluginName}', 'import'],
  ['subpath', '${pluginName}/feature', 'feature'],
  ['imports-package', '#fixture', 'import'],
  ['imports-file', '#local', 'import'],
  ['relative', './local.mjs', 'import'],
  ['relative-encoded', './组件%20%23%20%25.mjs', 'import'],
  ['absolute-file', specialUrl, 'import'],
]

for (const [kind, baseUrl] of [
  ['module', import.meta.url],
  ['directory', new URL('./', import.meta.url).href],
]) {
  const app = new Context()
  const events = []
  const resources = []
  try {
    await app.installComponent(Loader, { baseUrl })
    for (const [id, name, branch] of cases) {
      const config = { CoreContext: Context, id, events, resources }
      const entry = await app.loader.create({ id, name, config })
      assert.equal(entry.state, 'active', kind + ' ' + id + ': ' + String(entry.error))
      assert.equal(events.at(-1), 'start:' + branch + ':' + id)
      assert.equal(resources.at(-1).closed, false)
      app.emit('fixture/ping')
      assert.equal(events.at(-1), 'ping:' + branch + ':' + id)
      await app.loader.remove(id)
      assert.equal(app.loader.get(id), undefined)
      assert.equal(resources.at(-1).closed, true)
      assert.equal(events.at(-1), 'stop:' + branch + ':' + id)
      const afterRemoval = events.length
      app.emit('fixture/ping')
      assert.equal(events.length, afterRemoval, 'remove must revoke the plugin event listener')
    }

    const forbidden = await app.loader.create({ id: 'private', name: '${pluginName}/shared.mjs' })
    assert.equal(forbidden.state, 'failed')
    assert.equal(forbidden.error?.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED')
    await app.loader.remove('private')

    const missingName = './created-after-failure-' + kind + '.mjs'
    const missing = await app.loader.create({
      id: 'recover', name: missingName,
      config: { CoreContext: Context, id: 'recover', events, resources },
    })
    assert.equal(missing.state, 'failed')
    assert.equal(missing.error?.code, 'ERR_MODULE_NOT_FOUND')
    writeFileSync(new URL(missingName, import.meta.url), "export { default } from '${pluginName}'\\n")
    const recovered = await app.loader.resolve('recover')
    assert.equal(recovered.state, 'active', String(recovered.error))
    assert.equal(recovered.id, missing.id)
    assert.equal(events.at(-1), 'start:import:recover')
    app.emit('fixture/ping')
    assert.equal(events.at(-1), 'ping:import:recover')
    assert.equal(resources.at(-1).closed, false)
    // 保留这个实例，实际验证 Root 而非手动 remove 对整棵树的资源回收。
  } finally {
    await app.fiber.dispose()
  }
  assert.ok(resources.length > cases.length)
  assert.ok(resources.every(resource => resource.closed))
  assert.equal(events.at(-1), 'stop:import:recover')
  const afterRootCleanup = events.length
  app.emit('fixture/ping')
  assert.equal(events.length, afterRootCleanup, 'Root cleanup must revoke every plugin event listener')
  assert.equal(app.fiber.inspect().children.length, 0)
}

const withoutBase = new Context()
const resources = []
const events = []
try {
  await withoutBase.installComponent(Loader)
  const failed = await withoutBase.loader.create({ id: 'relative-without-base', name: './local.mjs' })
  assert.equal(failed.state, 'failed')
  assert.ok(failed.error instanceof TypeError)
  assert.match(failed.error.message, /baseUrl/)
  const absolute = await withoutBase.loader.create({
    id: 'absolute-without-base', name: specialUrl,
    config: { CoreContext: Context, id: 'absolute-without-base', events, resources },
  })
  assert.equal(absolute.state, 'active', String(absolute.error))
  withoutBase.emit('fixture/ping')
  assert.equal(events.at(-1), 'ping:import:absolute-without-base')
} finally {
  await withoutBase.fiber.dispose()
}
assert.equal(resources.length, 1)
assert.equal(resources[0].closed, true)
const afterCleanup = events.length
withoutBase.emit('fixture/ping')
assert.equal(events.length, afterCleanup)
console.log('resolver native consumer passed')
`

export function checkResolverConsumer(temporaryRoot, consumerRoot, runNpm) {
  const fixture = join(temporaryRoot, 'resolver-plugin-fixture')
  const installationHost = join(consumerRoot, 'resolver-install')
  const host = join(consumerRoot, 'resolver 宿主 空格 # %')
  const otherCwd = join(temporaryRoot, 'resolver-other-cwd')
  mkdirSync(fixture)
  mkdirSync(installationHost)
  mkdirSync(otherCwd)
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({
    name: pluginName,
    version: '1.0.0',
    type: 'module',
    peerDependencies: { '@nya/core': '^0.1.0-rc.1' },
    exports: {
      '.': { require: './require.cjs', import: './import.mjs', default: './fallback.mjs' },
      './feature': { require: './require.cjs', import: './feature.mjs' },
    },
    files: ['shared.mjs', 'import.mjs', 'feature.mjs', 'require.cjs', 'fallback.mjs'],
  }, null, 2))
  writeFileSync(join(fixture, 'shared.mjs'), sharedPlugin)
  for (const [file, branch] of [['import.mjs', 'import'], ['feature.mjs', 'feature']]) {
    writeFileSync(join(fixture, file), `import { createPlugin } from './shared.mjs'\nexport default createPlugin('${branch}')\n`)
  }
  writeFileSync(join(fixture, 'require.cjs'), "module.exports = { branch: 'require', apply() { throw new Error('require branch used by Loader') } }\n")
  writeFileSync(join(fixture, 'fallback.mjs'), "throw new Error('fallback branch used instead of import')\n")

  const packed = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot], fixture))
  assert.equal(packed.length, 1, 'expected one actual npm plugin tarball')
  assert.equal(basename(packed[0].filename), packed[0].filename, 'npm pack must return a filename')
  const tarball = join(temporaryRoot, packed[0].filename)
  assert.ok(existsSync(tarball), 'npm pack must create the plugin archive')

  writeFileSync(join(installationHost, 'package.json'), JSON.stringify({
    name: 'nya-resolver-nested-host',
    private: true,
    type: 'module',
    imports: {
      '#fixture': { require: `${pluginName}`, import: `${pluginName}` },
      '#local': { require: './wrong-require.cjs', import: './local.mjs' },
    },
  }, null, 2))
  // 插件的 peer 来自祖先消费者；禁止 npm 自动安装第二份 Core 或查询未发布的版本。
  // npm 10 把未编码的 cwd 拼成 file URL，带 #/% 时会算错归档路径。
  // 在普通目录真实安装后整体搬到特殊路径，仍用实际 Node 验证全部宿主解析。
  copyFileSync(tarball, join(installationHost, 'plugin.tgz'))
  runNpm(['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', './plugin.tgz'], installationHost)
  assert.ok(isAbsolute(consumerRoot), 'consumer directory must be absolute')
  assert.equal(dirname(installationHost), consumerRoot)
  assert.equal(dirname(host), consumerRoot)
  assert.equal(existsSync(host), false, 'must not overwrite an existing host directory')
  renameSync(installationHost, host)
  assert.ok(existsSync(join(host, 'node_modules', pluginName, 'import.mjs')))
  const localComponent = `export { default } from '${pluginName}'\n`
  writeFileSync(join(host, 'local.mjs'), localComponent)
  writeFileSync(join(host, '组件 # %.mjs'), localComponent)
  writeFileSync(join(host, 'wrong-require.cjs'), "throw new Error('host imports used require instead of import')\n")
  const entrypoint = join(host, 'main.mjs')
  writeFileSync(entrypoint, hostScript)

  try {
    execFileSync(process.execPath, [entrypoint], {
      cwd: otherCwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (cause) {
    throw new Error(`default Resolver consumer failed\n${cause.stdout ?? ''}${cause.stderr ?? ''}`, { cause })
  }
  // 普通宿主安装不使用 legacy-peer-deps；上面的嵌套布局只为定位宿主基址回归。
  runNpm(['install', '--ignore-scripts', '--strict-peer-deps', '--no-audit', '--no-fund', tarball], consumerRoot)
  runNpm(['ls', '--all', '--json'], consumerRoot)
  const ordinaryHost = join(consumerRoot, 'ordinary-host.mjs')
  writeFileSync(ordinaryHost, `
import assert from 'node:assert/strict'
import { Context } from '@nya/core'
import { Loader } from '@nya/loader'
const app = new Context()
const resources = []
const events = []
try {
  await app.installComponent(Loader, { baseUrl: import.meta.url })
  const entry = await app.loader.create({
    id: 'ordinary', name: '${pluginName}',
    config: { CoreContext: Context, id: 'ordinary', resources, events },
  })
  assert.equal(entry.state, 'active', String(entry.error))
  assert.equal(events.at(-1), 'start:import:ordinary')
} finally {
  await app.fiber.dispose()
}
assert.equal(resources.length, 1)
assert.equal(resources[0].closed, true)
assert.equal(events.at(-1), 'stop:import:ordinary')
assert.equal(app.fiber.inspect().children.length, 0)
`)
  execFileSync(process.execPath, [ordinaryHost], {
    cwd: otherCwd, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  console.log('默认 Resolver 消费者检查通过：真实 npm 插件、宿主基址、失败恢复与资源清理')
}
