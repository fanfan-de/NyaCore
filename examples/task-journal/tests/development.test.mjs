/** 开发循环使用显式 Promise gate 验证顺序，并用真实 tsc/IPC 子进程覆盖文件保存重启。 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { watch } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { createDevelopmentSupervisor } from '../scripts/dev-supervisor.mjs'
import { launchApplication, ownApplicationProcess, runDevelopment } from '../scripts/dev.mjs'

function deferred() {
  let resolveValue
  let rejectValue
  const promise = new Promise((resolve, reject) => { resolveValue = resolve; rejectValue = reject })
  return { promise, resolve: resolveValue, reject: rejectValue }
}

function queue() {
  const values = []
  const waiting = []
  return {
    push(value) {
      if (waiting.length) waiting.shift()(value)
      else values.push(value)
    },
    next() {
      return values.length ? Promise.resolve(values.shift()) : new Promise(resolve => waiting.push(resolve))
    },
  }
}

function clock() {
  const jobs = new Map()
  let sequence = 0
  return {
    jobs,
    setTimer(callback, milliseconds) {
      const id = ++sequence
      jobs.set(id, { callback, milliseconds })
      return id
    },
    clearTimer(id) { jobs.delete(id) },
    fire() {
      assert.equal(jobs.size, 1)
      const [id, { callback }] = jobs.entries().next().value
      jobs.delete(id)
      callback()
    },
  }
}

function fixture() {
  const builds = queue()
  const launches = queue()
  const closing = queue()
  const history = []
  const timing = clock()
  const supervisor = createDevelopmentSupervisor({
    ...timing,
    build(signal) {
      history.push('build')
      const done = deferred()
      builds.push({ ...done, signal })
      return done.promise
    },
    launch() {
      history.push('launch')
      const exited = deferred()
      const handle = {
        exited: exited.promise,
        stop() {
          history.push('close')
          closing.push(exited)
          return exited.promise
        },
      }
      launches.push(handle)
      return handle
    },
    report(...message) { history.push(message) },
  })
  const firstApplication = async () => {
    supervisor.change()
    timing.fire()
    ;(await builds.next()).resolve(true)
    const application = await launches.next()
    await supervisor.settled()
    return application
  }
  return { supervisor, builds, launches, closing, history, timing, firstApplication }
}

test('coalesces rapid saves and never overlaps closing, building or starting', async () => {
  const f = fixture()
  f.supervisor.change()
  f.supervisor.change()
  f.supervisor.change()
  assert.equal(f.timing.jobs.size, 1)
  f.timing.fire()
  ;(await f.builds.next()).resolve(true)
  await f.launches.next()
  await f.supervisor.settled()
  f.supervisor.change()
  f.timing.fire()
  const old = await f.closing.next()
  f.supervisor.change()
  f.supervisor.change()
  assert.deepEqual(f.history, ['build', 'launch', 'close'])
  old.resolve({ code: 143 })
  const rebuilding = await f.builds.next()
  f.supervisor.change()
  f.supervisor.change()
  rebuilding.resolve(true)
  const latest = await f.builds.next()
  assert.deepEqual(f.history, ['build', 'launch', 'close', 'build', 'build'])
  latest.resolve(true)
  await f.launches.next()
  const stopped = f.supervisor.stop()
  ;(await f.closing.next()).resolve({ code: 143 })
  assert.equal((await stopped).error, undefined)
  assert.equal(f.timing.jobs.size, 0)
})

test('a failed compilation stays stopped and the next successful change can recover', async () => {
  const f = fixture()
  await f.firstApplication()
  f.supervisor.change()
  f.timing.fire()
  ;(await f.closing.next()).resolve({ code: 143 })
  ;(await f.builds.next()).resolve(false)
  await f.supervisor.settled()
  assert.deepEqual(f.history, ['build', 'launch', 'close', 'build'])
  f.supervisor.change()
  f.timing.fire()
  ;(await f.builds.next()).resolve(true)
  await f.launches.next()
  const stopped = f.supervisor.stop()
  ;(await f.closing.next()).resolve({ code: 143 })
  await stopped
})

test('stopping during compilation aborts its owner and prevents any later launch', async () => {
  const f = fixture()
  f.supervisor.change()
  f.timing.fire()
  const building = await f.builds.next()
  const stopped = f.supervisor.stop()
  assert.equal(f.supervisor.stop(), stopped)
  assert.equal(building.signal.aborted, true)
  f.supervisor.change()
  building.resolve(true)
  await stopped
  f.supervisor.change()
  assert.deepEqual(f.history, ['build'])
  assert.equal(f.timing.jobs.size, 0)
})

test('stopping during old-process cleanup shares that cleanup and does not build', async () => {
  const f = fixture()
  await f.firstApplication()
  f.supervisor.change()
  f.timing.fire()
  const closing = await f.closing.next()
  const stopped = f.supervisor.stop()
  assert.equal(f.supervisor.stop(), stopped)
  f.supervisor.change()
  closing.resolve({ code: 143 })
  await stopped
  assert.deepEqual(f.history, ['build', 'launch', 'close'])
})

test('forced or unsuccessful cleanup terminates supervision instead of restarting', async () => {
  for (const outcome of [{ code: null, forced: true }, { code: 1 }]) {
    const f = fixture()
    await f.firstApplication()
    f.supervisor.change()
    f.timing.fire()
    ;(await f.closing.next()).resolve(outcome)
    const result = await f.supervisor.finished
    assert.ok(result.error instanceof Error)
    f.supervisor.change()
    assert.equal(f.history.filter(event => event === 'build').length, 1)
    assert.equal(f.timing.jobs.size, 0)
  }
})

test('IPC cleanup waits for readiness, preserves one deadline and only force-kills after it', async () => {
  const timing = clock()
  const exited = deferred()
  const sent = queue()
  const killed = queue()
  const child = new EventEmitter()
  child.connected = true
  child.send = (message, callback) => { sent.push(message); callback() }
  child.kill = signal => { killed.push(signal); return true }
  const owned = ownApplicationProcess(child, exited.promise, {
    ...timing, shutdownTimeoutMs: 100, report() {},
  })
  const stopping = owned.stop()
  assert.equal(owned.stop(), stopping)
  assert.equal(timing.jobs.size, 1)
  assert.equal([...timing.jobs.values()][0].milliseconds, 1100)
  child.emit('message', { type: 'task-journal:ipc-ready' })
  assert.deepEqual(await sent.next(), { type: 'task-journal:shutdown', signal: 'SIGTERM' })
  assert.equal(owned.stop(), stopping)
  assert.equal(timing.jobs.size, 1)
  timing.fire()
  assert.equal(await killed.next(), 'SIGKILL')
  exited.resolve({ code: null, signal: 'SIGKILL' })
  assert.equal((await stopping).forced, true)
  assert.equal(child.listenerCount('message'), 0)
  assert.equal(timing.jobs.size, 0)
})

test('normal IPC cleanup clears its watchdog without sending an OS signal', async () => {
  const timing = clock()
  const exited = deferred()
  const sent = queue()
  const child = new EventEmitter()
  child.connected = true
  child.send = (message, callback) => { sent.push(message); callback() }
  child.kill = () => { assert.fail('graceful cleanup must not call child.kill') }
  const owned = ownApplicationProcess(child, exited.promise, {
    ...timing, shutdownTimeoutMs: 100, report() {},
  })
  child.emit('message', { type: 'task-journal:ipc-ready' })
  const stopping = owned.stop()
  await sent.next()
  exited.resolve({ code: 143, signal: null })
  assert.deepEqual(await stopping, { code: 143, signal: null, forced: false })
  assert.equal(timing.jobs.size, 0)
})

test('a falsy thrown value still fails development and removes its watchers and signals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nya-development-falsy-'))
  const signals = new EventEmitter()
  try {
    await mkdir(join(directory, 'src'))
    const code = await runDevelopment({ directory, signals, output: {
      log() { throw undefined }, error() {},
    } })
    assert.equal(code, 1)
    assert.equal(signals.listenerCount('SIGINT'), 0)
    assert.equal(signals.listenerCount('SIGTERM'), 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function observeFile(filename, expected) {
  const done = deferred()
  void done.promise.catch(() => {})
  let checking = false
  let dirty = false
  let closed = false
  const check = () => {
    dirty = true
    if (checking) return
    checking = true
    void (async () => {
      while (dirty && !closed) {
        dirty = false
        try {
          const contents = await readFile(filename, 'utf8')
          if (contents.includes(expected)) done.resolve(contents)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    })().catch(done.reject).finally(() => { checking = false })
  }
  const watcher = watch(dirname(filename), check)
  watcher.on('error', done.reject)
  check()
  return { promise: done.promise, close() {
    closed = true
    watcher.close()
    done.reject(new Error('file observation closed'))
  } }
}

test('real task-journal source edits compile, stop on errors and restart through its actual IPC bridge', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nya-development-'))
  const signals = new EventEmitter()
  let running
  const firstWritten = deferred()
  const secondWritten = deferred()
  void firstWritten.promise.catch(() => {})
  void secondWritten.promise.catch(() => {})
  t.signal.addEventListener('abort', () => {
    signals.emit('SIGINT')
    firstWritten.reject(t.signal.reason)
    secondWritten.reject(t.signal.reason)
  }, { once: true })
  try {
    const require = createRequire(import.meta.url)
    const modules = resolve(dirname(require.resolve('typescript/package.json')), '..')
    await symlink(modules, join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    await cp(resolve(import.meta.dirname, '../src'), join(directory, 'src'), { recursive: true })
    await cp(resolve(import.meta.dirname, '../tsconfig.json'), join(directory, 'tsconfig.json'))
    const configFile = join(directory, 'config.json')
    const journal = join(directory, 'journal.jsonl')
    await writeFile(configFile, JSON.stringify({
      storage: { file: journal }, job: { intervalMs: 25, label: 'fixture' },
      shutdownTimeoutMs: 1000, logLevel: 'info',
    }))
    await writeFile(join(directory, 'src/version.ts'), "export const label = 'version-one'\n")
    const jobFile = join(directory, 'src/components/job.ts')
    const jobSource = await readFile(jobFile, 'utf8')
    assert.ok(jobSource.includes('validateJobConfig(input)'))
    await writeFile(jobFile, "import { label } from '../version.js'\n" + jobSource.replace(
      'validateJobConfig(input)', 'validateJobConfig({ ...input, label })',
    ))
    const errors = []
    const buildFailed = deferred()
    let starts = 0
    let phaseOutput = ''
    running = runDevelopment({ directory, argv: ['--config', configFile], signals, output: {
      log(message) {
        if (message === '[dev] starting application') { starts++; phaseOutput = '' }
      },
      // 真实应用只在 append 完成后记录这条日志；不依赖 Windows 对开放文件的通知时机。
      child(chunk) {
        phaseOutput += chunk
        if (!phaseOutput.includes('journal record written')) return
        if (starts === 1) firstWritten.resolve()
        if (starts === 2) secondWritten.resolve()
      },
      error(...message) {
        errors.push(message)
        if (String(message[0]).includes('build failed')) buildFailed.resolve()
      },
    } })
    const stoppedEarly = running.then(code => { throw new Error(`development stopped early (${code}): ${JSON.stringify(errors)}`) })
    await Promise.race([firstWritten.promise, stoppedEarly])
    await writeFile(join(directory, 'src/version.ts'), 'export const label: string = 1\n')
    await Promise.race([buildFailed.promise, stoppedEarly])
    assert.equal(starts, 1, 'failed compilation must not launch old output')
    await writeFile(join(directory, 'src/version.ts'), "export const label = 'version-two'\n")
    await Promise.race([secondWritten.promise, stoppedEarly])
    signals.emit('SIGINT')
    assert.equal(await running, 130)

    const written = deferred()
    let directOutput = ''
    const direct = launchApplication({ directory, args: ['--config', configFile], shutdownTimeoutMs: 1000,
      onOutput(chunk) {
        directOutput += chunk
        if (directOutput.includes('journal record written')) written.resolve()
      },
    })
    try {
      await Promise.race([written.promise, direct.exited.then(result => {
        throw new Error(`real CLI exited before writing: ${JSON.stringify(result)}\n${directOutput}`)
      })])
    } finally {
      assert.deepEqual(await direct.stop(), { code: 143, signal: null, forced: false })
    }
    const records = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const secondStart = records.findIndex(record => record.label === 'version-two')
    assert.ok(secondStart > 0)
    assert.ok(records.slice(0, secondStart).every(record => record.label === 'version-one'))
    assert.ok(records.slice(secondStart).every(record => record.label === 'version-two'))
    assert.deepEqual(records.map(record => record.sequence), records.map((_, index) => index + 1))
    assert.equal(starts, 2)
    assert.ok(errors.length > 0)
    assert.ok(errors.every(([message]) => message.includes('build failed')))
    assert.equal(signals.listenerCount('SIGINT'), 0)
    assert.equal(signals.listenerCount('SIGTERM'), 0)
  } finally {
    signals.emit('SIGINT')
    await running
    await rm(directory, { recursive: true, force: true })
  }
})

test('stopping a blocked configuration probe terminates it without starting an application', { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nya-development-probe-'))
  const signals = new EventEmitter()
  let running
  let observation
  t.signal.addEventListener('abort', () => {
    signals.emit('SIGINT')
    observation?.close()
  }, { once: true })
  try {
    const require = createRequire(import.meta.url)
    const modules = resolve(dirname(require.resolve('typescript/package.json')), '..')
    await symlink(modules, join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await mkdir(join(directory, 'src'))
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    await cp(resolve(import.meta.dirname, '../tsconfig.json'), join(directory, 'tsconfig.json'))
    await writeFile(join(directory, 'src/main.ts'), 'export {}\n')
    await writeFile(join(directory, 'src/config.ts'), `
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
export function parseArguments() { return { configFile: resolve('config.json'), help: false, demo: false } }
export async function readConfig() {
  await writeFile('probe-entered', 'ready')
  return new Promise<never>(() => { setInterval(() => {}, 5000) })
}
`)
    observation = observeFile(join(directory, 'probe-entered'), 'ready')
    const messages = []
    running = runDevelopment({ directory, signals, output: {
      log(message) { messages.push(message) }, error(...message) { messages.push(message) },
    } })
    await Promise.race([observation.promise, running.then(code => { throw new Error(`probe stopped early (${code})`) })])
    signals.emit('SIGINT')
    assert.equal(await running, 130)
    assert.equal(messages.includes('[dev] starting application'), false)
    assert.equal(signals.listenerCount('SIGINT'), 0)
    assert.equal(signals.listenerCount('SIGTERM'), 0)
  } finally {
    signals.emit('SIGINT')
    await running
    observation?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
