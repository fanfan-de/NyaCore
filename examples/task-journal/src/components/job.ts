/** 任务组件在每次持久化完成后再调度下一次运行，卸载会等待在途任务。 */

import type { Component, Disposer } from '@nya/core'
import type {} from '@nya/timer'
import { validateJobConfig } from '../config.js'
import type { JobConfig } from '../types.js'

export const jobComponent: Component.Object<JobConfig> = {
  name: 'journal-job',
  inject: ['journalStore', 'timer'],
  apply(context, input) {
    const config = validateJobConfig(input)
    let stopped = false
    let timer: Disposer | undefined
    let running: Promise<void> = Promise.resolve()

    const schedule = () => {
      if (stopped) return
      timer = context.timer.timeout(() => {
        timer = undefined
        if (stopped) return
        running = (async () => {
          const record = await context.journalStore.append(config.label)
          context.logger.info('journal record written', record)
          context.emit('journal/record', record)
        })()
        void running.then(schedule, (error: unknown) => {
          stopped = true
          context.logger.error('journal task failed', error)
          try {
            context.emit('journal/failure', error)
          } catch (observerError) {
            context.logger.error('journal failure observer failed', observerError)
          }
        })
      }, config.intervalMs)
    }

    context.effect(() => {
      schedule()
      return async () => {
        stopped = true
        if (timer !== undefined) await timer()
        await running
        context.logger.info('journal job stopped', { label: config.label })
      }
    }, 'journal schedule')
    context.logger.info('journal job started', config)
  },
}
