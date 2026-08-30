/** 本文件演示结构化控制台日志与 Fiber 失败快照如何定位启动和清理阶段的原始错误及 Effect 路径。 */

import {
  Context,
  FiberState,
} from '@nya/core'
import type {
  FiberDiagnosticSnapshot,
  LifecyclePhase,
} from '@nya/core'
import { ConsoleLogger } from '@nya/logger-console'

async function captureRejection(
  operation: PromiseLike<void>,
  description: string,
): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }

  throw new Error(`${description} should reject`)
}

function verifyFailure(
  snapshot: FiberDiagnosticSnapshot,
  expectedPhase: LifecyclePhase,
  expectedError: unknown,
  effectLabel: string,
): readonly string[] {
  const failure = snapshot.lastFailure
  if (!failure) {
    throw new Error(`${snapshot.name} should retain its latest failure`)
  }
  if (failure.phase !== expectedPhase) {
    throw new Error(
      `expected ${snapshot.name} failure phase to be ${expectedPhase}, received ${failure.phase}`,
    )
  }
  if (failure.error !== expectedError) {
    throw new Error(`${snapshot.name} did not retain the original error object`)
  }

  const effectPath = failure.effectPaths.find(path => (
    path.includes(effectLabel)
  ))
  if (!effectPath) {
    throw new Error(
      `${snapshot.name} failure did not identify Effect ${effectLabel}`,
    )
  }
  return effectPath
}

export async function runDiagnosticsScenario() {
  console.log('\n--- logger and diagnostics scenario ---')

  const app = new Context()
  const startupEffect = 'playground startup resource'
  const cleanupEffect = 'playground cleanup resource'
  const startupError = new Error('playground component failed to start')
  const cleanupError = new Error('playground resource failed to clean up')
  let allowedRootCleanupError: unknown

  try {
    // ConsoleLogger 是普通组件；只有显式安装后才会订阅当前 Root 的日志流。
    const consoleLogger = app.installComponent(ConsoleLogger, {
      level: 'debug',
      replay: true,
      timestamps: false,
    })
    await consoleLogger

    const startupFailure = app.installComponent({
      name: 'playground-startup-failure',

      apply(context) {
        context.effect(() => {
          throw startupError
        }, startupEffect)
      },
    })

    const observedStartupError = await captureRejection(
      startupFailure,
      'startup failure component',
    )
    if (observedStartupError !== startupError) {
      throw new Error('startup rejection did not preserve the original error')
    }

    const startupPath = verifyFailure(
      startupFailure.inspect(),
      'start',
      startupError,
      startupEffect,
    )
    console.log(
      `[diagnostics] startup failure located at ${startupPath.join(' > ')}`,
    )

    const cleanupFailure = app.installComponent({
      name: 'playground-cleanup-failure',

      apply(context) {
        context.effect(() => {
          return () => {
            throw cleanupError
          }
        }, cleanupEffect)
      },
    })
    await cleanupFailure

    // 由 Root 触发级联卸载，既演示清理失败，也验证其他组件仍被完整清理。
    allowedRootCleanupError = cleanupError
    const observedCleanupError = await captureRejection(
      app.fiber.dispose(),
      'root cleanup containing a failed component cleanup',
    )
    if (observedCleanupError !== cleanupError) {
      throw new Error('cleanup rejection did not preserve the original error')
    }

    const cleanupPath = verifyFailure(
      cleanupFailure.inspect(),
      'cleanup',
      cleanupError,
      cleanupEffect,
    )
    console.log(
      `[diagnostics] cleanup failure located at ${cleanupPath.join(' > ')}`,
    )

    if (
      cleanupFailure.state !== FiberState.DISPOSED
      || consoleLogger.state !== FiberState.DISPOSED
      || app.fiber.state !== FiberState.ACTIVE
    ) {
      throw new Error('root cleanup did not leave the runtime in a safe state')
    }

    console.log('[scenario] logger and diagnostics verification passed\n')
  } finally {
    // Root 可以重复安全清理；若场景提前退出，只忽略本例刻意制造的那个错误。
    try {
      await app.fiber.dispose()
    } catch (error) {
      if (error !== allowedRootCleanupError) throw error
    }
  }
}
