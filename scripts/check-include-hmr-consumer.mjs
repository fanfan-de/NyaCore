/** 实际 tarball + 原生 ESM 消费者；与 Vitest 的模块处理隔离。 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const worker = `
import { Context } from '@nya/core'
import { token, value } from './shared.mjs'
export default {
  inject: ['probe'],
  apply(ctx, config) {
    ctx.probe.start(Context, token, value, config.label)
    ctx.on('fixture/ping', () => ctx.probe.ping(value))
    ctx.effect(() => {
      const interval = setInterval(() => {}, 60000)
      ctx.probe.open()
      return () => { clearInterval(interval); ctx.probe.close(value) }
    }, 'consumer interval')
  }
}
`
const host = `
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { dirname, join } from 'node:path'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@nya/core'
import { Loader } from '@nya/loader'
import { Include, ConfigConflictError } from '@nya/include'
import { Hmr } from '@nya/hmr'

const filename = name => join(dirname(fileURLToPath(import.meta.url)), name)
const source = filename('./组件 # %.mjs')
const config = filename('./config.json')
const jobs = filename('./jobs.json')
const helper = filename('./shared.mjs')
const lazy = filename('./lazy.mjs')
const events = []
const tokens = []
let active = 0
let pings = 0
const app = new Context()
app.provide('probe', {
  start(Core, token, value, label) {
    assert.equal(Core, Context, 'candidate must retain exactly the host Core identity')
    events.push('start:' + value + ':' + label)
    tokens.push(token)
  },
  open() { active++ },
  close(value) { active--; events.push('stop:' + value) },
  ping() { pings++ },
})
let nextReport
function observed(predicate) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { nextReport = undefined; reject(new Error('native watcher timed out')) }, 8000)
    nextReport = report => {
      if (predicate(report)) {
        clearTimeout(deadline)
        nextReport = undefined
        resolve(report)
      }
    }
  })
}
try {
  await app.installComponent(Loader)
  await app.installComponent(Include, { path: config, id: 'app' })
  await app.installComponent(Hmr, {
    entries: [source, lazy], include: app.include, debounceMs: 20,
    onReport(report) { nextReport?.(report) },
  })
  const started = await app.hmr.start()
  assert.equal(started.status, 'applied', inspect(started, { depth: 7 }))
  assert.equal(active, 2)
  assert.equal(tokens[0], tokens[1], 'two Entry instances must share a native module')
  assert.equal(app.loader.get('app/jobs/a').state, 'active')
  const baseline = app.loader.get('app/jobs/a').fiberId
  const other = await app.loader.create({ id: 'unrelated', type: 'group' })
  const before = events.length
  const event = observed(report => report.status === 'applied' && report.files.includes(source) && report.generation > 1)
  await writeFile(helper + '.tmp', 'export const token = {}; export const value = 2')
  await rename(helper + '.tmp', helper)
  const report = await event
  assert.equal(report.pid, process.pid)
  assert.notEqual(app.loader.get('app/jobs/a').fiberId, baseline)
  assert.equal(app.loader.get('unrelated').fiberId, other.fiberId)
  assert.deepEqual(events.slice(before), ['stop:1', 'stop:1', 'start:2:a', 'start:2:b'])
  assert.equal(tokens.at(-1), tokens.at(-2))
  assert.equal(active, 2)
  for (let version = 3; version <= 7; version++) {
    await writeFile(helper, 'export const token = {}; export const value = ' + version)
    assert.equal((await app.hmr.reload()).status, 'applied')
    assert.equal(active, 2, 'resources may not accumulate over versions')
    const beforePing = pings
    app.emit('fixture/ping')
    assert.equal(pings, beforePing + 2, 'old listeners must be removed')
  }
  const stable = app.loader.get('app/jobs/a').fiberId
  await writeFile(source, 'throw new Error("candidate rejected"); export default () => {}')
  assert.equal((await app.hmr.reload()).phase, 'import')
  assert.equal(app.loader.get('app/jobs/a').fiberId, stable)
  assert.equal(active, 2)
  // 关闭监听后继续使用 Include 和已提交的代码版本。
  await app.hmr.close()
  const changed = { version: 1, entries: [
    { id: 'b', name: './组件%20%23%20%25.mjs', config: { label: 'saved' }, disabled: true },
    { id: 'a', name: './组件%20%23%20%25.mjs', config: { label: 'a' } },
  ] }
  const saved = await app.include.save(changed, jobs)
  assert.equal(saved.saved, true)
  assert.equal(saved.status, 'applied')
  assert.equal(active, 1)
  const json = await readFile(jobs, 'utf8')
  assert.deepEqual(JSON.parse(json), changed)
  assert.ok(!json.includes('fiberId'))
  assert.equal(JSON.parse(await readFile(config, 'utf8')).entries[0].path, './jobs.json')
  await app.include.close()
  assert.equal(active, 0)
  await app.installComponent(Include, { path: config, id: 'restored' })
  assert.equal((await app.include.refresh()).status, 'applied')
  assert.equal(app.loader.get('restored/jobs/b').state, 'disabled')
  assert.deepEqual(app.loader.get('restored/jobs').children, ['restored/jobs/b', 'restored/jobs/a'])
  assert.equal(active, 1)
  await writeFile(jobs, '{broken')
  await assert.rejects(app.include.save(changed, jobs), ConfigConflictError)
  assert.equal(active, 1)
  await unlink(jobs)
  await assert.rejects(app.include.refresh())
  assert.equal(active, 1)
  await writeFile(jobs, json)
  assert.equal((await app.include.refresh()).operations.length, 0)
  await app.loader.create({ id: 'lazy-cleanup', name: pathToFileURL(lazy).href })
} finally {
  await app.fiber.dispose()
}
assert.equal(active, 0)
const beforePing = pings
app.emit('fixture/ping')
assert.equal(pings, beforePing)
assert.equal(app.fiber.inspect().children.length, 0)
assert.ok(app.logger.records().some(record => record.message === 'native lazy cleanup completed'))
console.log('Include/HMR native consumer passed')
`

export function checkIncludeHmrConsumer(temporaryRoot, consumerRoot, releaseDirectory, runNpm) {
  const directory = join(consumerRoot, '配置 宿主 # %')
  const otherCwd = join(temporaryRoot, 'include-hmr-other-cwd')
  mkdirSync(directory)
  mkdirSync(otherCwd)
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
  writeFileSync(join(directory, 'main.mjs'), host)
  writeFileSync(join(directory, '组件 # %.mjs'), worker)
  writeFileSync(join(directory, 'shared.mjs'), 'export const token = {}; export const value = 1')
  writeFileSync(join(directory, 'lazy.mjs'), 'export default ctx => () => import("./lazy-cleanup.mjs").then(module => module.finish(ctx))')
  writeFileSync(join(directory, 'lazy-cleanup.mjs'), 'export const finish = ctx => ctx.logger.info("native lazy cleanup completed")')
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ version: 1, entries: [
    { id: 'jobs', type: 'include', path: './jobs.json' },
  ] }))
  writeFileSync(join(directory, 'jobs.json'), JSON.stringify({ version: 1, entries:
    ['a', 'b'].map(id => ({ id, name: './组件%20%23%20%25.mjs', config: { label: id } })),
  }))
  try {
    const output = execFileSync(process.execPath, [join(directory, 'main.mjs')], {
      cwd: otherCwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    })
    assert.match(output, /native consumer passed/)
  } catch (cause) {
    throw new Error('Include/HMR consumer failed\n' + (cause.stdout ?? '') + (cause.stderr ?? ''), { cause })
  }
  const example = join(releaseDirectory, 'include-hmr')
  runNpm(['install', '--ignore-scripts', '--strict-peer-deps', '--no-audit', '--no-fund'], example)
  const output = execFileSync(process.execPath, [join(example, 'main.mjs'), '--once'], {
    cwd: otherCwd, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  })
  assert.match(output, /message v1: hello/)
  assert.match(output, /worker stopped/)
  console.log('Include/HMR 消费者检查通过：特殊路径、单份 Core、真实监听、资源清理、保存恢复与独立示例')
}
