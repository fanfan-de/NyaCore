/** 自动演示以持久化成功事件推进配置更新和启停，中止后撤销观察并停止发起控制操作。 */

import type { Disposer } from '@nya/core'
import { ApplicationClosedError } from './types.js'
import type { Application, ApplicationConfig, JournalRecord } from './types.js'

export async function runDemo(
  application: Application,
  config: ApplicationConfig,
  signal?: AbortSignal,
): Promise<void> {
  let rejectCancelled!: (reason: unknown) => void
  let cancellation: { reason: unknown } | undefined
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject })
  const cancel = (reason: unknown) => {
    if (cancellation) return
    cancellation = { reason }
    rejectCancelled(reason)
  }
  void cancelled.catch(() => {})
  const abort = () => cancel(signal?.reason ?? new ApplicationClosedError())
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  let finished = false
  void application.failure.then(error => { if (!finished) cancel(error) })
  const disposers = new Set<Disposer>()
  const assertContinuing = () => {
    if (cancellation) throw cancellation.reason
  }
  const execute = async (operation: () => Promise<void>) => {
    assertContinuing()
    await Promise.race([operation(), cancelled])
    assertContinuing()
  }
  const nextRecord = async (label: string, operation?: () => Promise<void>) => {
    assertContinuing()
    let resolveRecord!: (record: JournalRecord) => void
    const observed = new Promise<JournalRecord>((resolve) => { resolveRecord = resolve })
    const dispose = application.context.on('journal/record', (record) => {
      if (record.label === label) resolveRecord(record)
    })
    disposers.add(dispose)
    try {
      if (operation) await execute(operation)
      const record = await Promise.race([observed, cancelled])
      assertContinuing()
      return record
    } finally {
      disposers.delete(dispose)
      await dispose()
    }
  }

  try {
    await execute(() => application.start())
    await nextRecord(config.job.label)
    const next = {
      label: `${config.job.label} (updated)`,
      intervalMs: Math.max(1, Math.floor(config.job.intervalMs / 2)),
    }
    await nextRecord(next.label, () => application.updateJob(next))
    await execute(() => application.setEnabled('job', false))
    application.context.logger.info('demo: job disabled')
    await nextRecord(next.label, () => application.setEnabled('job', true))
    application.context.logger.info('demo: job restored')
    await execute(() => application.setEnabled('storage', false))
    application.context.logger.info('demo: storage disabled; job waits for its dependency')
    await nextRecord(next.label, () => application.setEnabled('storage', true))
    application.context.logger.info('demo: storage restored')
  } finally {
    finished = true
    signal?.removeEventListener('abort', abort)
    await Promise.all([...disposers].map(dispose => dispose()))
  }
}
