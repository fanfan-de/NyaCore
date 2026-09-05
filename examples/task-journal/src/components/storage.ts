/** JSONL 存储组件负责校验已有记录、串行追加和等待写入完成后关闭文件。 */

import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Component } from '@nya/core'
import type { ApplicationConfig, JournalRecord, JournalStore } from '../types.js'

/** 仅封装本例需要的文件操作，测试可用显式 gate 验证写入和关闭顺序。 */
export interface JournalFile {
  read(): Promise<string>
  append(line: string): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

export type OpenJournal = (file: string) => Promise<JournalFile>

const openJournal: OpenJournal = async (file) => {
  await mkdir(dirname(file), { recursive: true })
  const handle = await open(file, 'a+')
  return {
    read: () => handle.readFile({ encoding: 'utf8' }),
    append: line => handle.appendFile(line, { encoding: 'utf8' }),
    flush: () => handle.sync(),
    close: () => handle.close(),
  }
}

function readSequence(contents: string): number {
  if (!contents) return 0
  if (!contents.endsWith('\n')) throw new Error('journal ends with an incomplete JSONL record')
  let sequence = 0
  for (const line of contents.slice(0, -1).split('\n')) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      throw new Error(`journal record ${sequence + 1} is not valid JSON`, { cause: error })
    }
    if (!value || typeof value !== 'object') {
      throw new TypeError(`invalid journal record ${sequence + 1}`)
    }
    const record = value as Partial<JournalRecord>
    if (
      record.sequence !== sequence + 1
      || typeof record.recordedAt !== 'string'
      || !Number.isFinite(Date.parse(record.recordedAt))
      || typeof record.label !== 'string'
      || !record.label.trim()
    ) throw new TypeError(`invalid journal record ${sequence + 1}`)
    sequence++
  }
  return sequence
}

export function createStorageComponent(
  acquire: OpenJournal = openJournal,
): Component.Object<ApplicationConfig['storage']> {
  return {
    name: 'journal-storage',
    async apply(context, config) {
      if (!config || typeof config.file !== 'string' || !config.file.trim()) {
        throw new TypeError('storage.file must be a non-empty string')
      }
      const file = await acquire(config.file)
      let accepting = true
      let tail: Promise<void> = Promise.resolve()
      let sequence = 0
      let closing: Promise<void> | undefined

      // 文件一旦打开就登记清理，读取或解析失败也会经 Core 回滚关闭它。
      const closeFile = () => {
        if (closing) return closing
        accepting = false
        closing = Promise.resolve().then(async () => {
          const errors: unknown[] = []
          for (const operation of [() => tail, () => file.flush(), () => file.close()]) {
            try { await operation() } catch (error) {
              if (!errors.some(current => Object.is(current, error))) errors.push(error)
            }
          }
          if (errors.length === 1) throw errors[0]
          if (errors.length > 1) throw new AggregateError(errors, 'journal write, flush or close failed')
          context.logger.info('journal closed', { file: config.file, sequence })
        })
        return closing
      }
      try {
        context.effect(() => closeFile, 'journal file')
      } catch (error) {
        // 如果异步打开期间所有者已关闭，资源尚未成功交给 Effect，仍须主动关闭。
        try { await closeFile() } catch (cleanupError) {
          if (!Object.is(error, cleanupError)) {
            throw new AggregateError([error, cleanupError], 'journal ownership and close failed')
          }
        }
        throw error
      }

      sequence = readSequence(await file.read())
      const store: JournalStore = {
        append(label) {
          if (!accepting) return Promise.reject(new Error('journal is closing'))
          if (typeof label !== 'string' || !label.trim()) {
            return Promise.reject(new TypeError('journal label must be a non-empty string'))
          }
          const operation = tail.then(async () => {
            const record: JournalRecord = Object.freeze({
              sequence: sequence + 1,
              recordedAt: new Date().toISOString(),
              label,
            })
            await file.append(`${JSON.stringify(record)}\n`)
            sequence = record.sequence
            return record
          })
          tail = operation.then(() => undefined)
          // 只标记拒绝已观察；tail 仍然拒绝，让后续写入与关闭保留原失败。
          void tail.catch(() => {})
          return operation
        },
      }
      context.provide('journalStore', store)
      context.logger.info('journal opened', { file: config.file, sequence })
    },
  }
}

export const storageComponent = createStorageComponent()
