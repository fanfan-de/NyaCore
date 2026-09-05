/** 示例应用的配置、业务事件与嵌入接口；不扩展框架的运行时协议。 */

import type { Context, LogLevel } from '@nya/core'

export interface JobConfig {
  readonly intervalMs: number
  readonly label: string
}

export interface ApplicationConfig {
  readonly storage: { readonly file: string }
  readonly job: JobConfig
  readonly logLevel: LogLevel
  readonly startupTimeoutMs: number
  readonly shutdownTimeoutMs: number
}

export interface JournalRecord {
  readonly sequence: number
  readonly recordedAt: string
  readonly label: string
}

export interface JournalStore {
  append(label: string): Promise<JournalRecord>
}

export interface Application {
  readonly context: Context
  /** 完成值是首次运行失败的原错误；此 Promise 本身不拒绝。 */
  readonly failure: Promise<unknown>
  start(): Promise<void>
  updateJob(config: JobConfig): Promise<void>
  setEnabled(id: 'job' | 'storage', enabled: boolean): Promise<void>
  close(): Promise<void>
}

export class ApplicationClosedError extends Error {
  constructor() {
    super('application is closing or closed')
    this.name = 'ApplicationClosedError'
  }
}

declare module '@nya/core' {
  interface Context {
    journalStore: JournalStore
  }

  interface Events {
    'journal/record'(record: JournalRecord): void
    'journal/failure'(error: unknown): void
  }
}
