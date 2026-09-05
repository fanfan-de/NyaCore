/** 示例应用仅通过公开 Component、Loader 和 Logger 协议装配及关闭业务。 */

import { Context, FiberState } from '@nya/core'
import type { Fiber } from '@nya/core'
import { Loader } from '@nya/loader'
import type { EntrySnapshot } from '@nya/loader'
import { ConsoleLogger } from '@nya/logger-console'
import { Timer } from '@nya/timer'
import { validateConfig, validateJobConfig } from './config.js'
import { jobComponent } from './components/job.js'
import { storageComponent } from './components/storage.js'
import { ApplicationClosedError } from './types.js'
import type { Application, ApplicationConfig, JobConfig } from './types.js'

export { ApplicationClosedError } from './types.js'

function requireActive(fiber: Fiber) {
  if (fiber.state !== FiberState.ACTIVE) {
    if (fiber.state === FiberState.FAILED) throw fiber.error
    throw new Error(`required component ${fiber.name} is ${fiber.state}`, { cause: fiber.inspect() })
  }
}

function requireEntry(entry: EntrySnapshot | undefined, expected?: EntrySnapshot['state']) {
  if (!entry) throw new Error('required Loader entry is missing')
  if (entry.state === 'failed') throw entry.error
  if (expected && entry.state !== expected) {
    throw new Error(`required entry ${entry.id} is ${entry.state}, expected ${expected}`, { cause: entry })
  }
}

export function createApplication(input: ApplicationConfig): Application {
  // 嵌入式调用和 CLI 共用同一边界；先校验并复制配置，再创建任何资源所有者。
  const config = validateConfig(input)
  const context = new Context()
  let state: 'new' | 'starting' | 'running' | 'closing' | 'closed' = 'new'
  let startup: Promise<void> | undefined
  let shutdown: Promise<void> | undefined
  let controls: Promise<void> = Promise.resolve()
  let reportFailure!: (error: unknown) => void
  let firstFailure: { error: unknown } | undefined
  const failure = new Promise<unknown>((resolve) => {
    reportFailure = error => {
      if (firstFailure) return
      firstFailure = { error }
      resolve(error)
    }
  })
  context.on('journal/failure', reportFailure)
  context.effect(() => context.registry.subscribe(event => {
    if (event.type === 'state' && event.fiber.state === FiberState.FAILED) {
      reportFailure(event.fiber.error)
    }
  }), 'application lifecycle failures')

  const assertOpen = () => {
    if (state === 'closing' || state === 'closed') throw new ApplicationClosedError()
  }
  const assertRunning = () => {
    assertOpen()
    if (state !== 'running') throw new Error('application has not started')
  }
  const control = (operation: () => Promise<void>) => {
    assertRunning()
    const task = controls.catch(() => {}).then(async () => {
      assertRunning()
      try {
        await operation()
        assertRunning()
      } catch (error) {
        if (state === 'closing' || state === 'closed') {
          if (firstFailure) throw firstFailure.error
          throw new ApplicationClosedError()
        }
        if (!(error instanceof ApplicationClosedError)) reportFailure(error)
        throw error
      }
    })
    controls = task
    void task.catch(() => {})
    return task
  }

  return {
    context,
    failure,
    start() {
      try { assertOpen() } catch (error) { return Promise.reject(error) }
      if (startup) return startup
      state = 'starting'
      startup = Promise.resolve().then(async () => {
        assertOpen()
        const logger = context.installComponent(ConsoleLogger, {
          level: config.logLevel,
          replay: true,
        })
        await logger
        assertOpen()
        requireActive(logger)
        const timer = context.installComponent(Timer)
        await timer
        assertOpen()
        requireActive(timer)
        const loaderFiber = context.installComponent(Loader, {
          resolver: ({ name }) => {
            if (name === 'storage') return storageComponent
            if (name === 'job') return jobComponent
            throw new Error(`unknown example component ${name}`)
          },
        })
        await loaderFiber
        assertOpen()
        requireActive(loaderFiber)
        requireEntry(await context.loader.create({ id: 'business', type: 'group' }), 'active')
        assertOpen()
        // 先登记消费者，真实展示缺依赖 PENDING，再由存储激活它。
        requireEntry(await context.loader.create({
          id: 'job', name: 'job', config: validateJobConfig(config.job),
        }, 'business'), 'pending')
        context.logger.info('job pending: waiting for journalStore')
        assertOpen()
        requireEntry(await context.loader.create({
          id: 'storage', name: 'storage', config: config.storage,
        }, 'business'))
        assertOpen()
        await context.loader.awaitIdle()
        assertOpen()
        requireEntry(context.loader.get('storage'), 'active')
        requireEntry(context.loader.get('job'), 'active')
        state = 'running'
        context.logger.info('application started')
      }).catch((error: unknown) => {
        // Registry 先保留真实组件失败；并发关闭不能用取消错误覆盖它。
        if (firstFailure) throw firstFailure.error
        if (state === 'closing' || state === 'closed') throw new ApplicationClosedError()
        if (!(error instanceof ApplicationClosedError)) reportFailure(error)
        throw error
      })
      void startup.catch(() => {})
      return startup
    },
    async updateJob(input: JobConfig) {
      assertRunning()
      // 控制面输入错误不进入运行失败通道，也不会改动已有 Entry。
      const next = validateJobConfig(input)
      await control(async () => {
        requireEntry(await context.loader.update('job', { config: next }))
      })
    },
    async setEnabled(id, enabled) {
      if (id !== 'job' && id !== 'storage') throw new TypeError('unknown application entry')
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
      await control(async () => {
        requireEntry(await context.loader.update(id, { disabled: !enabled }))
      })
    },
    close() {
      if (shutdown) return shutdown
      state = 'closing'
      // 先缓存任务，再进入 Core；同步日志观察者重入 close() 仍取得同一 Promise。
      shutdown = Promise.resolve().then(() => context.fiber.dispose()).then(
        () => { state = 'closed' },
        (error: unknown) => {
          state = 'closed'
          reportFailure(error)
          throw error
        },
      )
      void shutdown.catch(() => {})
      return shutdown
    },
  }
}
