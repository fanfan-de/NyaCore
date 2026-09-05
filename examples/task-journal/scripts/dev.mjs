/** 开发宿主：源码变更 -> IPC 关闭旧进程 -> tsc -> 启动最新成功输出。 */

import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevelopmentSupervisor } from './dev-supervisor.mjs'

const require = createRequire(import.meta.url)

function subprocess(command, args, options) {
  const child = spawn(command, args, { windowsHide: true, ...options })
  const exited = new Promise(resolveExit => {
    child.once('error', error => resolveExit({ code: null, signal: null, error }))
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  return { child, exited }
}

async function readDevelopmentConfiguration(directory, argv, signal) {
  const { child, exited } = subprocess(process.execPath, [
    join(import.meta.dirname, 'dev-config.mjs'), directory, process.cwd(), ...argv,
  ], { cwd: directory, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  let configuration
  const receive = message => {
    if (message?.type === 'task-journal:configuration') configuration = message
  }
  const abort = () => child.kill('SIGKILL')
  child.on('message', receive)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    const result = await exited
    if (signal.aborted) return
    if (!configuration) throw result.error ?? new Error(`configuration process exited (${result.code})`)
    return configuration
  } finally {
    child.off('message', receive)
    signal.removeEventListener('abort', abort)
  }
}

export function launchApplication({ directory, args, shutdownTimeoutMs, report = console.error, onOutput }) {
  const { child, exited } = subprocess(process.execPath, [join(directory, 'dist/main.js'), ...args], {
    cwd: directory, stdio: ['inherit', onOutput ? 'pipe' : 'inherit', onOutput ? 'pipe' : 'inherit', 'ipc'],
  })
  if (onOutput) {
    const receive = chunk => onOutput(chunk.toString())
    child.stdout.on('data', receive)
    child.stderr.on('data', receive)
    void exited.then(() => {
      child.stdout.off('data', receive)
      child.stderr.off('data', receive)
    })
  }
  return ownApplicationProcess(child, exited, { shutdownTimeoutMs, report })
}

export function ownApplicationProcess(child, exited, {
  shutdownTimeoutMs, report = console.error, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let ready
  const connected = new Promise(resolveReady => { ready = resolveReady })
  const onMessage = message => {
    if (message?.type === 'task-journal:ipc-ready') ready()
  }
  child.on('message', onMessage)
  let stopping
  void exited.then(() => child.off('message', onMessage))
  return {
    exited,
    stop() {
      if (stopping) return stopping
      stopping = (async () => {
        let timer
        let forced = false
        // 给 IPC 交接留出余量；宿主自己的 shutdownTimeoutMs 始终先获得完整等待时间。
        const deadline = new Promise(resolveDeadline => {
          timer = setTimer(() => resolveDeadline('timeout'), shutdownTimeoutMs + 1000)
        })
        try {
          const readiness = await Promise.race([connected.then(() => 'ready'), exited, deadline])
          if (readiness === 'ready' && child.connected) {
            child.send({ type: 'task-journal:shutdown', signal: 'SIGTERM' }, error => {
              if (error) report('[dev] IPC shutdown request failed', error)
            })
          }
          const outcome = typeof readiness === 'object' ? readiness : await Promise.race([exited, deadline])
          if (outcome === 'timeout') {
            forced = true
            report('[dev] graceful shutdown deadline exceeded; forcing process exit and stopping dev')
            child.kill('SIGKILL')
          }
          const result = await exited
          return { ...result, forced }
        } finally {
          clearTimer(timer)
        }
      })()
      return stopping
    },
  }
}

function watchInputs(directory, configFile, changed, failed) {
  const watchers = []
  try {
    watchers.push(watch(join(directory, 'src'), { recursive: true }, (_event, filename) => {
      if (filename && String(filename).split(/[\\/]/).some(part => ['dist', 'data', 'node_modules'].includes(part))) return
      changed()
    }))
    const directories = new Map([[directory, new Set(['tsconfig.json', 'tsconfig.test.json'])]])
    const configDirectory = dirname(configFile)
    if (!directories.has(configDirectory)) directories.set(configDirectory, new Set())
    directories.get(configDirectory).add(basename(configFile))
    for (const [watched, names] of directories) {
      watchers.push(watch(watched, (_event, filename) => {
        if (!filename || names.has(String(filename))) changed()
      }))
    }
    for (const watcher of watchers) watcher.on('error', failed)
  } catch (error) {
    for (const watcher of watchers) watcher.close()
    throw error
  }
  return () => { for (const watcher of watchers) watcher.close() }
}

export async function runDevelopment({
  directory = resolve(import.meta.dirname, '..'), argv = process.argv.slice(2),
  signals = process, output = console,
} = {}) {
  const compiler = require.resolve('typescript/bin/tsc')
  let args
  let config
  let configFile = join(directory, 'config.json')
  let exitCode = 0
  let unwatch = () => {}
  const supervisor = createDevelopmentSupervisor({
    report: (...message) => output.error(...message),
    async build(signal) {
      output.log('[dev] building')
      const { child, exited } = subprocess(process.execPath, [compiler, '-p', 'tsconfig.json', '--noEmitOnError'], {
        cwd: directory, stdio: 'inherit',
      })
      const abort = () => child.kill('SIGKILL')
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      let result
      try { result = await exited } finally { signal.removeEventListener('abort', abort) }
      if (signal.aborted) return false
      if (result.code !== 0) {
        output.error('[dev] build failed; application remains stopped until the next change', result.error ?? '')
        return false
      }
      try {
        // 只读取成功构建的 CLI 模块；短命进程同时保证依赖模块更新和停止时可中止读取。
        const current = await readDevelopmentConfiguration(directory, argv, signal)
        if (signal.aborted) return false
        if (current?.helpText) {
          output.log(current.helpText)
          void supervisor.stop()
          return false
        }
        if (current?.configFile && configFile !== current.configFile) {
          const nextWatch = watchInputs(directory, current.configFile, () => supervisor.change(), error => supervisor.fail(error))
          const previousWatch = unwatch
          unwatch = nextWatch
          configFile = current.configFile
          previousWatch()
        }
        if (!current?.ok) {
          output.error('[dev] configuration failed; application remains stopped until the next change')
          return false
        }
        args = current.args
        config = current.config
      } catch (error) {
        output.error('[dev] configuration failed; application remains stopped until the next change', error)
        return false
      }
      return true
    },
    launch() {
      output.log('[dev] starting application')
      return launchApplication({ directory, args, shutdownTimeoutMs: config.shutdownTimeoutMs,
        report: (...message) => output.error(...message), onOutput: output.child,
      })
    },
  })
  const requestStop = signal => {
    if (!exitCode) exitCode = signal === 'SIGINT' ? 130 : 143
    unwatch()
    void supervisor.stop()
  }
  const onInterrupt = () => requestStop('SIGINT')
  const onTerminate = () => requestStop('SIGTERM')
  signals.on('SIGINT', onInterrupt)
  signals.on('SIGTERM', onTerminate)
  try {
    unwatch = watchInputs(directory, configFile, () => supervisor.change(), error => supervisor.fail(error))
    supervisor.change()
    const result = await supervisor.finished
    return result.failed ? 1 : exitCode
  } finally {
    unwatch()
    await supervisor.stop()
    signals.off('SIGINT', onInterrupt)
    signals.off('SIGTERM', onTerminate)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDevelopment().then(code => { process.exitCode = code }, error => {
    console.error('[dev] failed', error)
    process.exitCode = 1
  })
}
